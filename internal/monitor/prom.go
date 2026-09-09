package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"ops-sentinel/internal/notify"
	"ops-sentinel/internal/store"
)

// PromManager 采集 Prometheus 文本格式端点，按规则求值并告警。
//
// 一个采集器覆盖五个维度，靠的是"端点即数据源"这个共性：
//
//	node_exporter   -> 主机 USE（CPU / 内存 / swap / 磁盘 / 网络 / fd）
//	cAdvisor        -> 容器状态与资源
//	应用 /metrics    -> RED（QPS / 错误率 / 耗时）+ 连接池 + 业务指标
//	redis_exporter  -> 中间件
//	任意自定义端点   -> 其它
//
// 不引入 PromQL：这里只做"选指标 + 聚合 + 阈值/变化率"，
// 复杂查询交给时序库，本工具的定位是告警而不是指标仓库。
type PromManager struct {
	store      *store.Store
	dispatcher *notify.Dispatcher
	eventBus   *EventBus

	mu       sync.Mutex
	monitors map[int64]context.CancelFunc

	stateMu sync.Mutex
	// targetHealth 跟踪每个采集目标的连续抓取失败：整机/VM 宕机时所有
	// 规则只会静默进 error，这里把「目标不可达」升级成正式告警。
	thMu          sync.Mutex
	targetHealths map[int64]*targetHealth
	states  map[int64]*promMetricState

	// 每条规则最近一次求值的实时快照，供"监控对象/容量风险"接口用。
	// 从内存读而不是查流水表：更新鲜（流水写入已限流到 10 分钟心跳）、零查询成本。
	snapMu   sync.Mutex
	snapshot map[int64]PromSnap

	// 主机资源差分采样的上一轮累计值（见 hostres.go）
	hrMu     sync.Mutex
	hostPrev map[int64]*hostPrev

	client *http.Client
}

// PromSnap 是单条规则的最近求值结果。
type PromSnap struct {
	Value   float64   `json:"value"`
	Matched bool      `json:"matched"`
	Detail  string    `json:"detail,omitempty"` // 聚合来源（如 container="mariadb-…"）
	Err     string    `json:"err,omitempty"`
	At      time.Time `json:"at"`
}

// Snapshot 返回全部规则的最近求值快照（拷贝）。
func (m *PromManager) Snapshot() map[int64]PromSnap {
	m.snapMu.Lock()
	defer m.snapMu.Unlock()
	out := make(map[int64]PromSnap, len(m.snapshot))
	for k, v := range m.snapshot {
		out[k] = v
	}
	return out
}

func (m *PromManager) setSnap(id int64, v PromSnap) {
	v.At = time.Now()
	m.snapMu.Lock()
	m.snapshot[id] = v
	m.snapMu.Unlock()
}

// promEventTitle 把规则名里的对象前缀去掉，让同一条规则在不同对象上
// 触发时能聚合成一件事（"ph01 内存使用率>90%" 与 "ph02 …" → "内存使用率>90%"）。
func promEventTitle(target *store.PromTarget, checkName string) string {
	labels := parseJSONStringMap(target.LabelsJSON)
	if vm := labels["vm"]; vm != "" && strings.HasPrefix(checkName, vm+" ") {
		return strings.TrimPrefix(checkName, vm+" ")
	}
	return checkName
}

// promMetricState 保存跨轮次的状态：连续命中次数用于 sustained 策略，
// 上一次的值用于变化量/变化率策略。
type promMetricState struct {
	ConsecutiveMatched int
	LastValue          float64
	HasLast            bool

	// 下面两个只用于控制写库频率，不参与告警判定
	LastLoggedStatus string
	LastLoggedAt     time.Time
}

// promLogHeartbeat 是"状态没变"时的最小写库间隔。
//
// 原先每次判定都写一行，232 条规则按 30~60 秒一轮，实测 11761 行/小时、
// 约 28 万行/天，一天就把库撑到 59MB —— 而其中绝大多数是重复的 ok。
// 状态变化必写（告警、恢复都不会漏），没变化时每 10 分钟留一行心跳，
// 用来证明这条规则还在跑、当前值是多少。
const promLogHeartbeat = 10 * time.Minute

// shouldLogPromResult 决定这次判定要不要落库。
func shouldLogPromResult(st *promMetricState, status string, now time.Time) bool {
	if st == nil {
		return true
	}
	if st.LastLoggedStatus != status {
		return true
	}
	return now.Sub(st.LastLoggedAt) >= promLogHeartbeat
}

func NewPromManager(s *store.Store, d *notify.Dispatcher, eb *EventBus) *PromManager {
	return &PromManager{
		targetHealths: make(map[int64]*targetHealth),
		store:      s,
		dispatcher: d,
		eventBus:   eb,
		monitors:   make(map[int64]context.CancelFunc),
		states:     make(map[int64]*promMetricState),
		snapshot:   make(map[int64]PromSnap),
		hostPrev:   make(map[int64]*hostPrev),
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        20,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
	}
}

func (m *PromManager) StartAll() error {
	targets, err := m.store.ListPromTargets()
	if err != nil {
		return fmt.Errorf("list prom targets: %w", err)
	}
	for _, t := range targets {
		if t.Enabled {
			if err := m.Start(t.ID); err != nil {
				log.Printf("[prom] start target %s failed: %v", t.Name, err)
			}
		}
	}
	return nil
}

func (m *PromManager) Start(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.monitors[id]; ok {
		return nil
	}

	target, err := m.store.GetPromTarget(id)
	if err != nil {
		return fmt.Errorf("get prom target %d: %w", id, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.monitors[id] = cancel

	go m.runTarget(ctx, target)
	log.Printf("[prom] started target %s (%s)", target.Name, target.URL)
	return nil
}

func (m *PromManager) Stop(id int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cancel, ok := m.monitors[id]; ok {
		cancel()
		delete(m.monitors, id)
	}
}

func (m *PromManager) Restart(id int64) error {
	m.Stop(id)
	return m.Start(id)
}

func (m *PromManager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, cancel := range m.monitors {
		cancel()
		delete(m.monitors, id)
	}
}

func (m *PromManager) IsRunning(id int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.monitors[id]
	return ok
}

func (m *PromManager) RunningCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.monitors)
}

func (m *PromManager) emit(typ string, targetID int64, name, message string, data interface{}) {
	if m.eventBus == nil {
		return
	}
	m.eventBus.Publish(MonitorEvent{
		Type:       typ,
		DatabaseID: targetID,
		DBName:     name,
		Message:    message,
		Timestamp:  time.Now(),
		Data:       data,
	})
}

func (m *PromManager) runTarget(ctx context.Context, target *store.PromTarget) {
	interval := time.Duration(target.IntervalSec) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	m.scrapeOnce(ctx, target.ID)
	for {
		select {
		case <-ctx.Done():
			log.Printf("[prom] stopped target %d", target.ID)
			return
		case <-ticker.C:
			m.scrapeOnce(ctx, target.ID)
		}
	}
}

// scrapeOnce 抓一次端点，然后把该端点下所有启用的规则跑一遍。
// 一次抓取服务多条规则，避免每条规则各发一次 HTTP。
func (m *PromManager) scrapeOnce(ctx context.Context, targetID int64) {
	start := time.Now()

	target, err := m.store.GetPromTarget(targetID)
	if err != nil {
		log.Printf("[prom] reload target %d failed: %v", targetID, err)
		return
	}
	if !target.Enabled {
		return
	}

	checks, err := m.store.ListPromChecks(&targetID)
	if err != nil {
		log.Printf("[prom] list checks for target %d failed: %v", targetID, err)
		return
	}

	families, scrapeErr := m.scrape(ctx, target)
	elapsed := time.Since(start).Milliseconds()
	m.onScrapeResult(target, scrapeErr)

	if scrapeErr != nil {
		m.emit("prom_scrape_error", target.ID, target.Name, scrapeErr.Error(), nil)
		// 抓取失败对每条启用的规则都记一条错误，便于在日志页定位（同样限流）
		for _, c := range checks {
			if !c.Enabled {
				continue
			}
			st := m.metricState(c.ID)
			if now := time.Now(); shouldLogPromResult(st, "error", now) {
				m.store.InsertPromAlertLog(&store.PromAlertLog{
					CheckID: c.ID, CheckName: c.Name,
					TargetID: target.ID, TargetName: target.Name,
					Dimension: c.Dimension, Severity: c.Severity,
					Status: "error", Metric: c.Metric,
					Error: scrapeErr.Error(), DurationMs: elapsed,
				})
				st.LastLoggedStatus, st.LastLoggedAt = "error", now
			}
			m.setSnap(c.ID, PromSnap{Err: scrapeErr.Error()})
		}
		return
	}

	m.sampleHostResources(target, families)

	for i := range checks {
		if !checks[i].Enabled {
			continue
		}
		m.evaluate(target, &checks[i], families, elapsed)
	}
}

func (m *PromManager) scrape(ctx context.Context, target *store.PromTarget) (map[string][]promSample, error) {
	timeout := time.Duration(target.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, target.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "text/plain;version=0.0.4")
	for k, v := range parseJSONStringMap(target.HeadersJSON) {
		req.Header.Set(k, v)
	}

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("scrape %s: %w", target.URL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("scrape %s: HTTP %d", target.URL, resp.StatusCode)
	}

	// 限制读取体积，避免异常端点拖垮内存
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	return parsePromText(string(body)), nil
}

// fetchDiagnostic 拉取诊断 URL 的内容，限时限量，失败静默——
// 诊断是告警的附属品，不能因为它拖住或搞坏通知本身。
func (m *PromManager) fetchDiagnostic(diagURL string) string {
	diagURL = strings.TrimSpace(diagURL)
	if diagURL == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, diagURL, nil)
	if err != nil {
		return ""
	}
	resp, err := m.client.Do(req)
	if err != nil {
		log.Printf("[prom] diag fetch %s: %v", diagURL, err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	out := strings.TrimSpace(string(body))
	// 飞书文本消息别撑爆：截到约 2000 字符，保尾部（最新的错误在后面）
	const cap = 2000
	if len(out) > cap {
		out = "…" + out[len(out)-cap:]
	}
	return out
}

// evaluate 对单条规则求值并按需告警。
func (m *PromManager) evaluate(target *store.PromTarget, check *store.PromCheck, families map[string][]promSample, elapsed int64) {
	value, detail, err := computePromValue(check, families)
	if err != nil && check.AbsentAsZero {
		// 序列缺失按 0 评估：容器停止/被删后它的指标序列直接消失，
		// 掉线规则（up 类指标 lt 1）靠这里才能触发而不是静默进 error。
		value, detail, err = 0, "指标序列缺失，按 0 评估", nil
	}
	if err != nil {
		st := m.metricState(check.ID)
		if now := time.Now(); shouldLogPromResult(st, "error", now) {
			m.store.InsertPromAlertLog(&store.PromAlertLog{
				CheckID: check.ID, CheckName: check.Name,
				TargetID: target.ID, TargetName: target.Name,
				Dimension: check.Dimension, Severity: check.Severity,
				Status: "error", Metric: check.Metric,
				Error: err.Error(), DurationMs: elapsed,
			})
			st.LastLoggedStatus, st.LastLoggedAt = "error", now
		}
		m.setSnap(check.ID, PromSnap{Err: err.Error()})
		m.emit("prom_check_error", target.ID, target.Name,
			fmt.Sprintf("%s: %v", check.Name, err), nil)
		return
	}

	state := m.metricState(check.ID)

	// 仅观测：存快照供趋势图采样，跳过告警判定与事件/通知
	if check.ObserveOnly {
		state.LastValue, state.HasLast = value, true
		m.setSnap(check.ID, PromSnap{Value: value, Matched: false, Detail: detail})
		if now := time.Now(); shouldLogPromResult(state, "ok", now) {
			m.store.InsertPromAlertLog(&store.PromAlertLog{
				CheckID: check.ID, CheckName: check.Name,
				TargetID: target.ID, TargetName: target.Name,
				Dimension: check.Dimension, Severity: check.Severity,
				Status: "ok", Metric: check.Metric, Value: formatPromValue(value),
				DurationMs: elapsed,
			})
			state.LastLoggedStatus, state.LastLoggedAt = "ok", now
		}
		return
	}

	matched, reason := evaluatePromRule(value, check, state)
	state.LastValue = value
	state.HasLast = true
	m.setSnap(check.ID, PromSnap{Value: value, Matched: matched, Detail: detail})

	valueStr := formatPromValue(value)
	prevStatus, hasPrev, _ := m.store.LastPromAlertStatus(check.ID)

	if matched {
		message := renderPromMessage(target, check, valueStr, reason)
		if detail != "" {
			message += "\n来源：" + detail
		}
		now := time.Now()
		willLog := shouldLogPromResult(state, "alert", now)
		willNotify := check.NotifyEnabled && !(hasPrev && prevStatus == "alert")
		// 诊断内容（如各 VM 的错误样本端口）拉一次，流水/事件/通知卡三处共用：
		// 在流水和告警中心也能直接看到具体错误，不用等飞书或登机 docker logs。
		diag := ""
		if willLog || willNotify {
			diag = m.fetchDiagnostic(check.DiagURL)
		}
		logMessage := message
		if diag != "" {
			logMessage += "\n\n错误样本：\n" + diag
		}
		// 事件 message 只在拉过诊断的轮次更新（空 = store 保留上一轮），
		// 避免静默轮用不带样本的消息把样本冲掉。
		eventMessage := ""
		if willLog || willNotify {
			eventMessage = logMessage
		}
		if willLog {
			m.store.InsertPromAlertLog(&store.PromAlertLog{
				CheckID: check.ID, CheckName: check.Name,
				TargetID: target.ID, TargetName: target.Name,
				Dimension: check.Dimension, Severity: check.Severity,
				Status: "alert", Metric: check.Metric, Value: valueStr,
				Threshold: check.AlertValue, Message: logMessage, DurationMs: elapsed,
			})
			state.LastLoggedStatus, state.LastLoggedAt = "alert", now
		}
		m.emit("prom_alert", target.ID, target.Name, message, map[string]interface{}{
			"check":     check.Name,
			"dimension": check.Dimension,
			"severity":  check.Severity,
			"value":     valueStr,
		})

		// 持续告警时不重复推送，只在状态由非 alert 变为 alert 时通知一次
		notified := false
		if willNotify {
			card := &notify.AlertCard{
				Title: check.Name, Level: check.Severity,
				Fields: [][2]string{
					{"实例", target.Name},
					{"指标", check.Metric},
					{"当前值", valueStr},
					{"触发条件", reason},
					{"开始", time.Now().Format("2006-01-02 15:04:05")},
				},
				Note:       messageNote(check, message, detail),
				DetailPath: fmt.Sprintf("/#/objects/%d", target.ID),
			}
			card.Code = diag
			if err := m.dispatcher.SendGlobalAlertCard(card); err != nil {
				log.Printf("[prom] notify failed for check %s: %v", check.Name, err)
			} else {
				notified = true
			}
		}
		m.store.UpsertFiringEvent(&store.AlertEvent{
			Source: "prom", CheckID: check.ID, CheckName: check.Name,
			Title:    promEventTitle(target, check.Name),
			TargetID: target.ID, TargetName: target.Name,
			Dimension: check.Dimension, Severity: check.Severity,
			Value: valueStr, Threshold: check.AlertValue, Message: eventMessage,
			Detail: detail,
		}, notified)
		return
	}

	nowOK := time.Now()
	if shouldLogPromResult(state, "ok", nowOK) {
		m.store.InsertPromAlertLog(&store.PromAlertLog{
			CheckID: check.ID, CheckName: check.Name,
			TargetID: target.ID, TargetName: target.Name,
			Dimension: check.Dimension, Severity: check.Severity,
			Status: "ok", Metric: check.Metric, Value: valueStr,
			Threshold: check.AlertValue, DurationMs: elapsed,
		})
		state.LastLoggedStatus, state.LastLoggedAt = "ok", nowOK
	}

	// sustained 规则的连续计数在内存里，重启后从零热身。热身期内阈值其实
	// 仍然超标（ConsecutiveMatched > 0），这不是恢复——不能关事件、更不能发
	// 恢复通知，否则每次重启都会先"全恢复"再在 2~3 轮后"全触发"一遍。
	warmingUp := strings.ToLower(strings.TrimSpace(check.AlertStrategy)) == "sustained" &&
		state.ConsecutiveMatched > 0
	// 事件关闭不依赖流水的 prevStatus：那只有"恰好翻转的那一轮"才成立，
	// 如果翻转轮撞上热身守卫被跳过（实测发生过：口径修复分发的时间差），
	// 之后 prevStatus 永远是 ok，事件就卡死在 firing。ResolveEvent 幂等，
	// 没有 firing 行时是空操作，每轮尝试关闭没有代价。
	if !warmingUp {
		m.store.ResolveEvent("prom", check.ID, valueStr)
	}
	if hasPrev && prevStatus == "alert" && !warmingUp && check.RecoveryNotify && check.NotifyEnabled {
		card := &notify.AlertCard{
			Title: check.Name, Level: "recovery",
			Fields: [][2]string{
				{"实例", target.Name},
				{"指标", check.Metric},
				{"当前值", valueStr},
				{"恢复时间", time.Now().Format("2006-01-02 15:04:05")},
			},
			DetailPath: fmt.Sprintf("/#/objects/%d", target.ID),
		}
		if err := m.dispatcher.SendGlobalAlertCard(card); err != nil {
			log.Printf("[prom] recovery notify failed for check %s: %v", check.Name, err)
		}
		m.emit("prom_recovered", target.ID, target.Name,
			fmt.Sprintf("[恢复] %s / %s 当前值 %s", target.Name, check.Name, valueStr), nil)
	}
}

type targetHealth struct {
	ConsecFails int
	Alerting    bool
}

// targetScrapeFailThreshold 连续失败这么多轮才告警，过滤单次网络抖动。
const targetScrapeFailThreshold = 3

// onScrapeResult 维护目标可达性状态机：连续失败 N 次开告警事件并通知，
// 恢复后自动 resolve + 恢复通知。事件用独立的 source=prom_target 命名空间。
func (m *PromManager) onScrapeResult(target *store.PromTarget, scrapeErr error) {
	m.thMu.Lock()
	th, ok := m.targetHealths[target.ID]
	if !ok {
		th = &targetHealth{}
		m.targetHealths[target.ID] = th
	}
	m.thMu.Unlock()

	if scrapeErr != nil {
		th.ConsecFails++
		if th.ConsecFails == targetScrapeFailThreshold && !th.Alerting {
			th.Alerting = true
			card := &notify.AlertCard{
				Title: target.Name + " 采集目标不可达", Level: "critical",
				Fields: [][2]string{
					{"目标", target.URL},
					{"连续失败", fmt.Sprintf("%d 次", th.ConsecFails)},
					{"错误", scrapeErr.Error()},
					{"开始", time.Now().Format("2006-01-02 15:04:05")},
				},
				Note:       "该目标下所有规则此刻都采不到数（整机宕机 / node_exporter 停了 / 网络不通）。它恢复前这台机器等于没有监控",
				DetailPath: fmt.Sprintf("/#/objects/%d", target.ID),
			}
			notified := false
			if err := m.dispatcher.SendGlobalAlertCard(card); err != nil {
				log.Printf("[prom] target-down notify failed for %s: %v", target.Name, err)
			} else {
				notified = true
			}
			m.store.UpsertFiringEvent(&store.AlertEvent{
				Source: "prom_target", CheckID: target.ID,
				CheckName: target.Name + " 采集目标不可达",
				Title:    target.Name + " 采集目标不可达",
				TargetID: target.ID, TargetName: target.Name,
				Dimension: "target", Severity: "critical",
				Value: scrapeErr.Error(), Threshold: "", Message: card.PlainText(""),
			}, notified)
		}
		return
	}

	if th.Alerting {
		th.Alerting = false
		m.store.ResolveEvent("prom_target", target.ID, "恢复")
		card := &notify.AlertCard{
			Title: target.Name + " 采集目标不可达", Level: "recovery",
			Fields: [][2]string{
				{"目标", target.URL},
				{"恢复时间", time.Now().Format("2006-01-02 15:04:05")},
			},
			DetailPath: fmt.Sprintf("/#/objects/%d", target.ID),
		}
		if err := m.dispatcher.SendGlobalAlertCard(card); err != nil {
			log.Printf("[prom] target-down recovery notify failed for %s: %v", target.Name, err)
		}
	}
	th.ConsecFails = 0
}

func (m *PromManager) metricState(checkID int64) *promMetricState {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	st, ok := m.states[checkID]
	if !ok {
		st = &promMetricState{}
		m.states[checkID] = st
	}
	return st
}

// DeleteState 在规则被删除或修改时清理状态，避免旧的连续计数影响新配置。
func (m *PromManager) DeleteState(checkID int64) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	delete(m.states, checkID)
}

// TestTarget 供 UI 的"测试连接"用：抓一次并返回指标条数与样例。
func (m *PromManager) TestTarget(target *store.PromTarget) (int, []string, error) {
	families, err := m.scrape(context.Background(), target)
	if err != nil {
		return 0, nil, err
	}
	names := make([]string, 0, len(families))
	for name := range families {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > 50 {
		names = names[:50]
	}
	return len(families), names, nil
}

// TestCheck 供 UI 的"测试规则"用：抓一次并按规则求值，返回当前值与是否命中。
func (m *PromManager) TestCheck(target *store.PromTarget, check *store.PromCheck) (string, bool, string, error) {
	families, err := m.scrape(context.Background(), target)
	if err != nil {
		return "", false, "", err
	}
	value, _, err := computePromValue(check, families)
	if err != nil && check.AbsentAsZero {
		value, err = 0, nil
	}
	if err != nil {
		return "", false, "", err
	}
	// 测试不写入状态，用临时 state 保证幂等
	matched, reason := evaluatePromRule(value, check, &promMetricState{})
	return formatPromValue(value), matched, reason, nil
}

// ---------------------------------------------------------------------------
// Prometheus 文本格式解析
// ---------------------------------------------------------------------------

type promSample struct {
	Labels map[string]string
	Value  float64
}

// parsePromText 解析 Prometheus 文本曝露格式。
// 只取指标名、标签与值，忽略 # HELP / # TYPE 与时间戳 —— 告警场景用不到。
func parsePromText(body string) map[string][]promSample {
	out := make(map[string][]promSample)

	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		name, labels, valuePart, ok := splitPromLine(line)
		if !ok {
			continue
		}

		// 值之后可能还跟着时间戳，取第一段即可
		fields := strings.Fields(valuePart)
		if len(fields) == 0 {
			continue
		}
		value, err := parsePromFloat(fields[0])
		if err != nil {
			continue
		}

		out[name] = append(out[name], promSample{Labels: labels, Value: value})
	}

	return out
}

// splitPromLine 把一行拆成 指标名 / 标签 / 值。
// 形如：metric_name{label="v",label2="v2"} 12.34
func splitPromLine(line string) (string, map[string]string, string, bool) {
	brace := strings.IndexByte(line, '{')
	if brace < 0 {
		// 无标签：metric_name value
		sp := strings.IndexFunc(line, func(r rune) bool { return r == ' ' || r == '\t' })
		if sp < 0 {
			return "", nil, "", false
		}
		return line[:sp], map[string]string{}, strings.TrimSpace(line[sp+1:]), true
	}

	name := line[:brace]
	closing := strings.LastIndexByte(line, '}')
	if closing < brace {
		return "", nil, "", false
	}

	labels := parsePromLabels(line[brace+1 : closing])
	return name, labels, strings.TrimSpace(line[closing+1:]), true
}

// parsePromLabels 解析标签串，处理引号内的逗号与转义。
func parsePromLabels(s string) map[string]string {
	out := map[string]string{}
	var key, val strings.Builder
	inKey, inQuote, escaped := true, false, false

	flush := func() {
		k := strings.TrimSpace(key.String())
		if k != "" {
			out[k] = val.String()
		}
		key.Reset()
		val.Reset()
		inKey = true
	}

	for _, r := range s {
		switch {
		case escaped:
			// 还原常见转义，其余原样保留
			switch r {
			case 'n':
				val.WriteRune('\n')
			case 't':
				val.WriteRune('\t')
			default:
				val.WriteRune(r)
			}
			escaped = false
		case inQuote && r == '\\':
			escaped = true
		case r == '"':
			inQuote = !inQuote
		case inQuote:
			val.WriteRune(r)
		case r == '=' && inKey:
			inKey = false
		case r == ',' && !inQuote:
			flush()
		case inKey:
			key.WriteRune(r)
		default:
			// 引号外的值部分（非标准格式），忽略空白
			if r != ' ' && r != '\t' {
				val.WriteRune(r)
			}
		}
	}
	flush()
	return out
}

func parsePromFloat(s string) (float64, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "+inf":
		return math.Inf(1), nil
	case "-inf":
		return math.Inf(-1), nil
	case "nan":
		return math.NaN(), nil
	}
	return strconv.ParseFloat(strings.TrimSpace(s), 64)
}

// ---------------------------------------------------------------------------
// 取值与求值
// ---------------------------------------------------------------------------

// computePromValue 按规则从样本里算出一个标量。
// 支持三种表达式：
//
//	raw             直接聚合 metric
//	ratio           metric / denominator
//	available_ratio 1 - metric/denominator，用于"剩余率"到"使用率"的翻转
func computePromValue(check *store.PromCheck, families map[string][]promSample) (float64, string, error) {
	numerator, detail, err := aggregateMetric(check.Metric, check.LabelFilter, check.Aggregate, families)
	if err != nil {
		return 0, "", err
	}

	kind := strings.ToLower(strings.TrimSpace(check.ExprKind))
	if kind == "" || kind == "raw" {
		return numerator, detail, nil
	}

	denomName := strings.TrimSpace(check.ExprDenominator)
	if denomName == "" {
		return 0, "", fmt.Errorf("表达式 %s 需要配置分母指标", kind)
	}
	denominator, _, err := aggregateMetric(denomName, check.LabelFilter, check.Aggregate, families)
	if err != nil {
		return 0, "", fmt.Errorf("分母指标 %s: %w", denomName, err)
	}
	if denominator == 0 {
		return 0, "", fmt.Errorf("分母指标 %s 为 0，无法计算比率", denomName)
	}

	ratio := numerator / denominator
	if kind == "available_ratio" {
		ratio = 1 - ratio
	}
	return ratio * 100, detail, nil // 比率统一以百分比呈现，阈值也按百分比填
}

// aggregateMetric 聚合样本并给出"来源"：max/min/last 是极值/末位样本的标签，
// sum/avg/count 是贡献最大的样本的标签（多样本时才有意义）。
//
// 没有来源之前，告警只能说"erp-01 上有容器到了 85%"，具体哪个容器要人
// 再去翻 —— 聚合把标签丢了。引擎明明知道极值是谁贡献的，带出来即可。
func aggregateMetric(metric, labelFilter, aggregate string, families map[string][]promSample) (float64, string, error) {
	metric = strings.TrimSpace(metric)
	samples, ok := families[metric]
	if !ok || len(samples) == 0 {
		return 0, "", fmt.Errorf("端点中没有指标 %s", metric)
	}

	filters := parseLabelFilter(labelFilter)
	matched := make([]promSample, 0, len(samples))
	for _, s := range samples {
		if matchLabels(s.Labels, filters) {
			matched = append(matched, s)
		}
	}
	if len(matched) == 0 {
		return 0, "", fmt.Errorf("指标 %s 没有匹配 %s 的样本", metric, labelFilter)
	}

	// 单样本且规则带标签过滤时，来源没有信息量（过滤条件已经指明了对象），置空少一行噪音；
	// 没有过滤条件的规则（如"有容器内存 > 85%"盯全部容器）哪怕只有一个容器也要说清是哪个。
	detailOf := func(sm promSample) string {
		if len(matched) < 2 && strings.TrimSpace(labelFilter) != "" {
			return ""
		}
		return formatSampleLabels(sm.Labels)
	}

	switch strings.ToLower(strings.TrimSpace(aggregate)) {
	case "", "last":
		last := matched[len(matched)-1]
		return last.Value, detailOf(last), nil
	case "sum", "avg", "count":
		sum := 0.0
		top := matched[0]
		for _, sm := range matched {
			sum += sm.Value
			if sm.Value > top.Value {
				top = sm
			}
		}
		switch strings.ToLower(strings.TrimSpace(aggregate)) {
		case "sum":
			return sum, detailOf(top), nil
		case "avg":
			return sum / float64(len(matched)), detailOf(top), nil
		default:
			return float64(len(matched)), "", nil
		}
	case "max":
		top := matched[0]
		for _, sm := range matched {
			if sm.Value > top.Value {
				top = sm
			}
		}
		return top.Value, detailOf(top), nil
	case "min":
		low := matched[0]
		for _, sm := range matched {
			if sm.Value < low.Value {
				low = sm
			}
		}
		return low.Value, detailOf(low), nil
	default:
		return 0, "", fmt.Errorf("不支持的聚合方式 %s", aggregate)
	}
}

// formatSampleLabels 把样本标签压成一行，优先展示能定位对象的那几个。
func formatSampleLabels(labels map[string]string) string {
	// container/mountpoint/device 这类标签才是"是哪一个"的答案，排前面
	priority := []string{"container", "mountpoint", "device", "db_name", "route", "status"}
	parts := []string{}
	used := map[string]bool{}
	for _, k := range priority {
		if v := labels[k]; v != "" {
			parts = append(parts, k+"="+v)
			used[k] = true
		}
	}
	rest := []string{}
	for k, v := range labels {
		if !used[k] && v != "" {
			rest = append(rest, k+"="+v)
		}
	}
	sort.Strings(rest)
	parts = append(parts, rest...)
	out := strings.Join(parts, " ")
	if len(out) > 120 {
		out = out[:120] + "…"
	}
	return out
}

// parseLabelFilter 解析 device="sda2",mountpoint="/" 形式的过滤条件。
func parseLabelFilter(s string) map[string]string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return parsePromLabels(s)
}

func matchLabels(labels, filters map[string]string) bool {
	for k, want := range filters {
		got, ok := labels[k]
		if !ok {
			return false
		}
		// 末尾 * 支持前缀匹配，容器名带随机后缀时很有用
		if strings.HasSuffix(want, "*") {
			if !strings.HasPrefix(got, strings.TrimSuffix(want, "*")) {
				return false
			}
			continue
		}
		if got != want {
			return false
		}
	}
	return true
}

// evaluatePromRule 复用 health_checks 的告警语义：
//
//	threshold  单次越界即命中
//	sustained  连续 N 次越界才命中，用于过滤抖动
//	increase   相对上次的变化量或变化率超标才命中
func evaluatePromRule(value float64, check *store.PromCheck, st *promMetricState) (bool, string) {
	strategy := strings.ToLower(strings.TrimSpace(check.AlertStrategy))
	if strategy == "" {
		strategy = "threshold"
	}

	consecutive := check.AlertConsecutive
	if consecutive <= 0 {
		consecutive = 1
	}

	thresholdMatched, thresholdMsg := evaluatePromCondition(value, check.AlertCondition, check.AlertValue)

	switch strategy {
	case "sustained":
		if thresholdMatched {
			st.ConsecutiveMatched++
		} else {
			st.ConsecutiveMatched = 0
		}
		matched := st.ConsecutiveMatched >= consecutive
		return matched, fmt.Sprintf("%s（连续 %d/%d 次）", thresholdMsg, st.ConsecutiveMatched, consecutive)

	case "increase":
		if !st.HasLast {
			return false, "首次采集，建立基线"
		}
		delta := value - st.LastValue

		// 增长策略必须真的增长了才算命中。否则把阈值填 0（"任何增长都报"的直觉写法）
		// 会让 delta==0 满足 delta >= 0，计数器每个采集周期都告警一次。
		if delta <= 0 {
			return false, fmt.Sprintf("无增长（增量 %s）", formatPromValue(delta))
		}

		if dv := strings.TrimSpace(check.AlertDeltaValue); dv != "" {
			limit, err := strconv.ParseFloat(dv, 64)
			if err == nil && delta >= limit {
				return true, fmt.Sprintf("增量 %s 达到阈值 %s（上次 %s，当前 %s）",
					formatPromValue(delta), dv, formatPromValue(st.LastValue), formatPromValue(value))
			}
		}
		if dp := strings.TrimSpace(check.AlertDeltaPercent); dp != "" {
			limit, err := strconv.ParseFloat(dp, 64)
			if err == nil && st.LastValue != 0 {
				pct := delta / math.Abs(st.LastValue) * 100
				if pct >= limit {
					return true, fmt.Sprintf("增幅 %.2f%% 达到阈值 %s%%（上次 %s，当前 %s）",
						pct, dp, formatPromValue(st.LastValue), formatPromValue(value))
				}
			}
		}
		return false, fmt.Sprintf("增量 %s 未达阈值", formatPromValue(delta))

	default: // threshold
		return thresholdMatched, thresholdMsg
	}
}

func evaluatePromCondition(value float64, condition, threshold string) (bool, string) {
	condition = strings.ToLower(strings.TrimSpace(condition))
	if condition == "" {
		condition = "gt"
	}

	raw := strings.TrimSpace(threshold)
	if raw == "" {
		return false, "未配置阈值"
	}
	limit, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return false, fmt.Sprintf("阈值 %s 不是数字", raw)
	}

	var matched bool
	var symbol string
	switch condition {
	case "gt":
		matched, symbol = value > limit, ">"
	case "gte":
		matched, symbol = value >= limit, ">="
	case "lt":
		matched, symbol = value < limit, "<"
	case "lte":
		matched, symbol = value <= limit, "<="
	case "eq":
		matched, symbol = value == limit, "=="
	case "ne":
		matched, symbol = value != limit, "!="
	default:
		return false, fmt.Sprintf("不支持的条件 %s", condition)
	}

	return matched, fmt.Sprintf("当前值 %s %s 阈值 %s", formatPromValue(value), symbol, raw)
}

func formatPromValue(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if math.IsInf(v, 1) {
		return "+Inf"
	}
	if math.IsInf(v, -1) {
		return "-Inf"
	}
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return strconv.FormatFloat(v, 'f', 2, 64)
}

// messageNote 决定卡片备注：有自定义模板时用其渲染结果（含业务处置指引），
// 默认消息与字段行重复，只保留聚合来源。
func messageNote(check *store.PromCheck, rendered, detail string) string {
	var parts []string
	if strings.TrimSpace(check.MessageTemplate) != "" {
		parts = append(parts, strings.TrimSpace(rendered))
	}
	// message 里通常已经带了"来源："一行（evaluate 拼上的），别再加一遍
	if strings.TrimSpace(detail) != "" && !strings.Contains(rendered, "来源：") {
		parts = append(parts, "来源："+detail)
	}
	return strings.Join(parts, "\n")
}

func renderPromMessage(target *store.PromTarget, check *store.PromCheck, value, reason string) string {
	if tpl := strings.TrimSpace(check.MessageTemplate); tpl != "" {
		r := strings.NewReplacer(
			"{{target}}", target.Name,
			"{{check}}", check.Name,
			"{{metric}}", check.Metric,
			"{{value}}", value,
			"{{threshold}}", check.AlertValue,
			"{{severity}}", check.Severity,
			"{{dimension}}", check.Dimension,
			"{{reason}}", reason,
		)
		return r.Replace(tpl)
	}

	severity := strings.ToUpper(strings.TrimSpace(check.Severity))
	if severity == "" {
		severity = "WARNING"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "[%s] %s / %s\n", severity, target.Name, check.Name)
	fmt.Fprintf(&b, "维度：%s\n", promDimensionLabel(check.Dimension))
	fmt.Fprintf(&b, "指标：%s", check.Metric)
	if check.LabelFilter != "" {
		fmt.Fprintf(&b, "{%s}", check.LabelFilter)
	}
	fmt.Fprintf(&b, "\n当前值：%s\n", value)
	fmt.Fprintf(&b, "判定：%s", reason)
	return b.String()
}

func promDimensionLabel(d string) string {
	switch strings.ToLower(strings.TrimSpace(d)) {
	case "host":
		return "主机资源"
	case "container":
		return "容器"
	case "database":
		return "数据库"
	case "middleware":
		return "中间件"
	case "app":
		return "应用"
	case "business":
		return "业务"
	default:
		return "自定义"
	}
}

// parseJSONStringMap 解析 {"K":"V"} 形式的配置，失败时返回空 map 而不是报错 ——
// 请求头这类可选配置不该因为格式问题让整个采集停摆。
func parseJSONStringMap(s string) map[string]string {
	s = strings.TrimSpace(s)
	if s == "" || s == "{}" {
		return nil
	}
	var out map[string]string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil
	}
	return out
}
