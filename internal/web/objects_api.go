package web

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ops-sentinel/internal/monitor"
	"ops-sentinel/internal/store"
)

// 本文件是「总览 / 告警中心 / 监控对象」三个新页面的聚合接口。
// 数据来源刻意分成两层：
//   - 触发中/已恢复 → alert_events 表（事件生命周期，权威）
//   - 当前值/容量风险 → PromManager 的内存快照（最新鲜，零查询成本）

// objCheck 是对象详情里的一条规则视图。
type objCheck struct {
	ID        int64   `json:"id"`
	Name      string  `json:"name"`
	Metric    string  `json:"metric"`
	Dimension string  `json:"dimension"`
	Severity  string  `json:"severity"`
	Condition string  `json:"condition"`
	Threshold string  `json:"threshold"`
	Strategy  string  `json:"strategy"`
	ExprKind  string  `json:"expr_kind,omitempty"` // raw/delta/ratio/available_ratio，前端据此把原始值换算成人能读的单位
	HasValue  bool    `json:"has_value"`
	Value     float64 `json:"value"`
	Detail    string  `json:"detail,omitempty"`
	Matched   bool    `json:"matched"`
	Err       string  `json:"err,omitempty"`
	Risk      bool    `json:"risk"`
}

// promRisk 判断"没触发但已接近阈值"。只对阈值型数值条件有意义。
func promRisk(value float64, condition, threshold string, matched bool) bool {
	if matched {
		return false
	}
	thr, err := strconv.ParseFloat(strings.TrimSpace(threshold), 64)
	if err != nil || thr == 0 {
		return false
	}
	// 布尔型指标（0/1 开关，如 node_timex_sync_status、各种漂移标志）没有
	// "逐渐逼近阈值"的过程：健康值恰好落在阈值边界上，接近度公式会把
	// 完全健康的状态算成 100% 风险。跳过。
	if (value == 0 || value == 1) && (thr == 0 || thr == 1) {
		return false
	}
	// 计数型状态指标同理（活跃 broker 数、在线成员数这类 lt 小整数规则）：
	// 健康值恰好等于阈值是常态，会永远显示 100% 风险；而它们是跳变不是渐变，
	// 真跌落时规则本体立即告警，这张表给不了预警窗口。恰好等于阈值的整数
	// lt 规则一律不算风险。
	if condition == "lt" && value == thr && value == math.Trunc(value) {
		return false
	}
	switch condition {
	case "lt", "lte":
		// 越小越危险：进入阈值 15% 以内算风险（如证书剩余天数、可见库数）
		return value > 0 && value <= thr*1.15
	default:
		// 越大越危险：达到阈值 85% 算风险
		return value >= thr*0.85
	}
}

func buildObjChecks(checks []store.PromCheck, snap map[int64]monitor.PromSnap) []objCheck {
	out := make([]objCheck, 0, len(checks))
	for _, c := range checks {
		if !c.Enabled {
			continue
		}
		oc := objCheck{
			ID: c.ID, Name: c.Name, Metric: c.Metric, Dimension: c.Dimension,
			Severity: c.Severity, Condition: c.AlertCondition, Threshold: c.AlertValue,
			Strategy: c.AlertStrategy, ExprKind: c.ExprKind,
		}
		if sn, ok := snap[c.ID]; ok {
			oc.HasValue = sn.Err == ""
			oc.Value = sn.Value
			oc.Detail = sn.Detail
			oc.Matched = sn.Matched
			oc.Err = sn.Err
			if oc.HasValue && c.AlertStrategy != "increase" {
				oc.Risk = promRisk(sn.Value, c.AlertCondition, c.AlertValue, sn.Matched)
			}
		}
		out = append(out, oc)
	}
	return out
}

type objectView struct {
	ID       int64             `json:"id"`
	Name     string            `json:"name"`
	Kind     string            `json:"kind"`
	Labels   map[string]string `json:"labels"`
	Running  bool              `json:"running"`
	Status   string            `json:"status"` // firing / risk / ok / stale
	Firing   int               `json:"firing"`
	Risks    int               `json:"risks"`
	Checks   []objCheck        `json:"checks"`
	Interval int               `json:"interval_sec"`
	MemTotal float64           `json:"mem_total,omitempty"` // 总内存字节（来自最新主机采样），列表悬停换算 GB
	FSTotal  float64           `json:"fs_total,omitempty"`  // 根分区总字节（最新主机采样）
	FSAvail  float64           `json:"fs_avail,omitempty"`  // 根分区可用字节
}

func (s *Server) buildObjects() ([]objectView, error) {
	targets, err := s.store.ListPromTargets()
	if err != nil {
		return nil, err
	}
	checks, err := s.store.ListPromChecks(nil)
	if err != nil {
		return nil, err
	}
	snap := s.promMgr.Snapshot()
	latest, _ := s.store.LatestHostSamples()

	byTarget := map[int64][]store.PromCheck{}
	for _, c := range checks {
		byTarget[c.TargetID] = append(byTarget[c.TargetID], c)
	}

	out := make([]objectView, 0, len(targets))
	for _, t := range targets {
		if !t.Enabled {
			continue
		}
		labels := map[string]string{}
		json.Unmarshal([]byte(t.LabelsJSON), &labels)

		ov := objectView{
			ID: t.ID, Name: t.Name, Kind: t.Kind, Labels: labels,
			Running: s.promMgr.IsRunning(t.ID), Interval: t.IntervalSec,
			Checks: buildObjChecks(byTarget[t.ID], snap),
		}
		if hs, ok := latest[t.ID]; ok {
			ov.MemTotal = hs.MemTotal
			ov.FSTotal = hs.FSTotal
			ov.FSAvail = hs.FSAvail
		}
		for _, c := range ov.Checks {
			if c.Matched {
				ov.Firing++
			}
			if c.Risk {
				ov.Risks++
			}
		}
		switch {
		case ov.Firing > 0:
			ov.Status = "firing"
		case ov.Risks > 0:
			ov.Status = "risk"
		case !ov.Running:
			ov.Status = "stale"
		default:
			ov.Status = "ok"
		}
		out = append(out, ov)
	}
	return out, nil
}

// GET /api/objects
func (s *Server) apiObjectsList(w http.ResponseWriter, r *http.Request) {
	objs, err := s.buildObjects()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, objs)
}

// GET /api/objects/{id} —— 对象详情：规则 + 事件历史 + 子对象（按 host 标签）
func (s *Server) apiObjectDetail(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "无效的 ID")
		return
	}
	objs, err := s.buildObjects()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var self *objectView
	for i := range objs {
		if objs[i].ID == id {
			self = &objs[i]
			break
		}
	}
	if self == nil {
		jsonError(w, http.StatusNotFound, "对象不存在")
		return
	}

	// 子对象：labels.host == 本对象的 labels.vm（物理机 → 它承载的 VM）
	children := []objectView{}
	if vm := self.Labels["vm"]; vm != "" {
		for _, o := range objs {
			if o.ID != self.ID && o.Labels["host"] == vm {
				children = append(children, o)
			}
		}
	}

	jsonOK(w, map[string]any{
		"object":   self,
		"children": children,
	})
}

// GET /api/objects/{id}/sparklines?hours=6 —— 对象详情页：全部规则的 6h 迷你时序
func (s *Server) apiObjectSparklines(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "无效的 ID")
		return
	}
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 72 {
		hours = 6
	}
	checks, err := s.store.ListPromChecks(&id)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ids := make([]int64, 0, len(checks))
	for _, c := range checks {
		ids = append(ids, c.ID)
	}
	bucket := 300
	if hours > 12 {
		bucket = 900
	}
	series, err := s.store.ListMetricSamplesByChecks(ids, time.Now().Add(-time.Duration(hours)*time.Hour), bucket)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, series)
}

// GET /api/prom-checks/{id}/samples?hours=24 —— 单规则大图
func (s *Server) apiPromCheckSamples(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "无效的 ID")
		return
	}
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 72 {
		hours = 24
	}
	bucket := 60
	if hours > 6 {
		bucket = 300
	}
	if hours > 24 {
		bucket = 900
	}
	points, err := s.store.ListMetricSamples(id, time.Now().Add(-time.Duration(hours)*time.Hour), bucket)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, points)
}

// GET /api/alert-events?status=firing|resolved
func (s *Server) apiAlertEvents(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status != "" && status != "firing" && status != "resolved" {
		jsonError(w, http.StatusBadRequest, "status 只能是 firing / resolved")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, err := s.store.ListAlertEvents(status, limit)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, events)
}

// GET /api/overview —— 总览页一次拉全
func (s *Server) apiOverview(w http.ResponseWriter, r *http.Request) {
	firing, _ := s.store.ListAlertEvents("firing", 100)
	critical, warning := s.store.CountFiringBySeverity()

	objs, err := s.buildObjects()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 容量风险：全部对象里 risk=true 的规则，按"离阈值多近"排序取前 8
	type riskItem struct {
		Target    string  `json:"target"`
		Check     string  `json:"check"`
		Metric    string  `json:"metric"`
		Value     float64 `json:"value"`
		Detail    string  `json:"detail,omitempty"`
		Threshold string  `json:"threshold"`
		Closeness float64 `json:"closeness"` // 1.0 = 已到阈值
	}
	risks := []riskItem{}
	okRules := 0
	dims := map[string][2]int{} // dimension -> [firing, total]
	for _, o := range objs {
		for _, c := range o.Checks {
			d := dims[c.Dimension]
			d[1]++
			if c.Matched {
				d[0]++
			} else if c.HasValue {
				okRules++
			}
			dims[c.Dimension] = d
			if !c.Risk {
				continue
			}
			thr, _ := strconv.ParseFloat(strings.TrimSpace(c.Threshold), 64)
			closeness := 0.0
			if thr != 0 {
				if c.Condition == "lt" || c.Condition == "lte" {
					closeness = thr / c.Value
				} else {
					closeness = c.Value / thr
				}
			}
			risks = append(risks, riskItem{
				Target: o.Name, Check: c.Name, Metric: c.Metric,
				Value: c.Value, Detail: c.Detail, Threshold: c.Threshold, Closeness: closeness,
			})
		}
	}
	// 简单选择排序取前 8（规模 <300，无需引依赖）
	for i := 0; i < len(risks) && i < 8; i++ {
		max := i
		for j := i + 1; j < len(risks); j++ {
			if risks[j].Closeness > risks[max].Closeness {
				max = j
			}
		}
		risks[i], risks[max] = risks[max], risks[i]
	}
	if len(risks) > 8 {
		risks = risks[:8]
	}

	notifyCount, _ := s.store.CountEnabledNotifications()

	jsonOK(w, map[string]any{
		"summary": map[string]any{
			"firing_critical": critical,
			"firing_warning":  warning,
			"risk":            len(risks),
			"ok_rules":        okRules,
		},
		"firing":  firing,
		"risks":   risks,
		"dims":    dims,
		"objects": len(objs),
		"self": map[string]any{
			"notify_channels": notifyCount,
			"targets_running": s.promMgr.RunningCount(),
			"cert_running":    s.certMgr.RunningCount(),
			"health_running":  s.healthCheckMgr.RunningCount(),
		},
	})
}

// GET /api/alert-summary —— 顶栏状态条轮询用，够轻才敢 30 秒一拉
func (s *Server) apiAlertSummary(w http.ResponseWriter, r *http.Request) {
	critical, warning := s.store.CountFiringBySeverity()
	jsonOK(w, map[string]int{
		"critical": critical,
		"warning":  warning,
	})
}

// GET /api/objects/{id}/resources?from=<unix>&to=<unix> —— 主机资源趋势
// （CPU / 内存 / 磁盘 IO / 网络 IO）。分桶按范围长度自适应：≤6h 原始 1 分钟，
// ≤48h 5 分钟，再长 15 分钟，7 天也只有 ~670 个点。
func (s *Server) apiObjectResources(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "无效的 ID")
		return
	}
	now := time.Now()
	to := now
	from := now.Add(-24 * time.Hour)
	if v, err := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64); err == nil && v > 0 {
		to = time.Unix(v, 0)
	}
	if v, err := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64); err == nil && v > 0 {
		from = time.Unix(v, 0)
	}
	if !to.After(from) {
		jsonError(w, http.StatusBadRequest, "时间范围无效")
		return
	}
	if from.Before(now.Add(-8 * 24 * time.Hour)) {
		from = now.Add(-8 * 24 * time.Hour)
	}
	span := to.Sub(from)
	bucket := 60
	switch {
	case span > 48*time.Hour:
		bucket = 900
	case span > 6*time.Hour:
		bucket = 300
	}
	points, err := s.store.ListHostSamples(id, from, to, bucket)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, map[string]any{"bucket_sec": bucket, "points": points})
}

// GET /api/objects/{id}/events?page=1&page_size=20 —— 对象的告警事件（分页）
func (s *Server) apiObjectEvents(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "无效的 ID")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	items, total, err := s.store.ListAlertEventsByTargetPaged("prom", id, page, size)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jsonOK(w, map[string]any{"items": items, "total": total})
}
