package store

import (
	"database/sql"
	"fmt"
	"time"
)

// PromTarget 是一个 Prometheus 文本格式端点。
// 一个端点可以承载多个维度的指标：node_exporter 给主机 USE、cAdvisor 给容器、
// 应用自身的 /metrics 给 RED 与业务指标。因此这里只描述"从哪采"，
// "采什么、什么条件报警"交给 PromCheck。
type PromTarget struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	URL         string    `json:"url"`
	Kind        string    `json:"kind"` // node / cadvisor / app / redis / nacos / router / custom
	HeadersJSON string    `json:"headers_json"`
	TimeoutSec  int       `json:"timeout_sec"`
	IntervalSec int       `json:"interval_sec"`
	LabelsJSON  string    `json:"labels_json"` // 附加到告警上的静态标签，如 {"vm":"core-01","host":"ph01"}
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// PromCheck 是针对某个指标的一条告警规则。
// 复用 health_checks 那套告警语义：threshold / sustained / increase 三种策略，
// 条件支持 gt lt gte lte eq ne，另有变化量与变化率。
type PromCheck struct {
	ID        int64  `json:"id"`
	TargetID  int64  `json:"target_id"`
	Name      string `json:"name"`
	Dimension string `json:"dimension"` // host / container / database / middleware / app / business / custom

	Metric      string `json:"metric"`       // 指标名，如 node_memory_SwapFree_bytes
	LabelFilter string `json:"label_filter"` // 标签过滤，如 device="sda2",mountpoint="/"
	Aggregate   string `json:"aggregate"`    // last / sum / avg / max / min / count

	// 表达式：raw 直接取值；delta 为相对上轮采集的增量（累计计数器换算成每周期新增）；
	// ratio 为 metric / expr_denominator；
	// available_ratio 为 (1 - metric/denominator)，用于"可用率"类指标
	ExprKind        string `json:"expr_kind"`
	ExprDenominator string `json:"expr_denominator"`

	AlertStrategy     string `json:"alert_strategy"`
	AlertCondition    string `json:"alert_condition"`
	AlertValue        string `json:"alert_value"`
	AlertDeltaValue   string `json:"alert_delta_value"`
	AlertDeltaPercent string `json:"alert_delta_percent"`
	AlertConsecutive  int    `json:"alert_consecutive"`

	Severity        string `json:"severity"` // info / warning / critical
	NotifyEnabled   bool   `json:"notify_enabled"`
	RecoveryNotify  bool   `json:"recovery_notify"`
	MessageTemplate string `json:"message_template"`
	// DiagURL 非空时，告警通知前先 GET 它，把响应片段附进消息。
	// 用途：日志规则指向各 VM 的样本端口，"新增 error" 的通知里直接带上
	// 最近的错误内容，不用登机 docker logs。
	DiagURL string `json:"diag_url"`
	// AbsentAsZero 开启时，指标序列缺失（端点没有该指标 / 没有匹配样本）
	// 按值 0 参与评估，而不是走 error 路径静默。掉线检测（up 类指标 lt 1）
	// 依赖它：容器停止或被删后序列直接消失，不开这个就永远不会告警。
	AbsentAsZero bool `json:"absent_as_zero"`
	// ObserveOnly 仅观测：正常求值、存快照与时序（趋势图有数据），
	// 但不做告警判定——不进事件、不通知。取代"阈值设天文数字"的权宜。
	ObserveOnly bool `json:"observe_only"`
	Enabled     bool `json:"enabled"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// 只读关联字段，列表查询时带出，避免前端二次请求
	TargetName string `json:"target_name,omitempty"`
	TargetURL  string `json:"target_url,omitempty"`
}

type PromAlertLog struct {
	ID         int64     `json:"id"`
	CheckID    int64     `json:"check_id"`
	CheckName  string    `json:"check_name"`
	TargetID   int64     `json:"target_id"`
	TargetName string    `json:"target_name"`
	Dimension  string    `json:"dimension"`
	Severity   string    `json:"severity"`
	Status     string    `json:"status"` // alert / recovered / error / ok
	Metric     string    `json:"metric"`
	Value      string    `json:"value"`
	Threshold  string    `json:"threshold"`
	Message    string    `json:"message"`
	Error      string    `json:"error"`
	DurationMs int64     `json:"duration_ms"`
	DetectedAt time.Time `json:"detected_at"`
}

const promTargetColumns = `id, name, url, kind, headers_json, timeout_sec, interval_sec, labels_json, enabled, created_at, updated_at`

func scanPromTarget(sc interface{ Scan(...interface{}) error }) (PromTarget, error) {
	var t PromTarget
	err := sc.Scan(&t.ID, &t.Name, &t.URL, &t.Kind, &t.HeadersJSON, &t.TimeoutSec,
		&t.IntervalSec, &t.LabelsJSON, &t.Enabled, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func (s *Store) ListPromTargets() ([]PromTarget, error) {
	rows, err := s.db.Query(`SELECT ` + promTargetColumns + ` FROM prom_targets ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]PromTarget, 0)
	for rows.Next() {
		t, err := scanPromTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) GetPromTarget(id int64) (*PromTarget, error) {
	row := s.db.QueryRow(`SELECT `+promTargetColumns+` FROM prom_targets WHERE id = ?`, id)
	t, err := scanPromTarget(row)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) CreatePromTarget(t *PromTarget) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO prom_targets
		(name, url, kind, headers_json, timeout_sec, interval_sec, labels_json, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Name, t.URL, t.Kind, t.HeadersJSON, t.TimeoutSec, t.IntervalSec, t.LabelsJSON, t.Enabled)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdatePromTarget(t *PromTarget) error {
	_, err := s.db.Exec(`UPDATE prom_targets SET
		name = ?, url = ?, kind = ?, headers_json = ?, timeout_sec = ?,
		interval_sec = ?, labels_json = ?, enabled = ?, updated_at = datetime('now')
		WHERE id = ?`,
		t.Name, t.URL, t.Kind, t.HeadersJSON, t.TimeoutSec,
		t.IntervalSec, t.LabelsJSON, t.Enabled, t.ID)
	return err
}

func (s *Store) DeletePromTarget(id int64) error {
	_, err := s.db.Exec(`DELETE FROM prom_targets WHERE id = ?`, id)
	return err
}

func (s *Store) TogglePromTarget(id int64) error {
	_, err := s.db.Exec(`UPDATE prom_targets SET enabled = NOT enabled, updated_at = datetime('now') WHERE id = ?`, id)
	return err
}

const promCheckColumns = `c.id, c.target_id, c.name, c.dimension, c.metric, c.label_filter, c.aggregate,
	c.expr_kind, c.expr_denominator, c.alert_strategy, c.alert_condition, c.alert_value,
	c.alert_delta_value, c.alert_delta_percent, c.alert_consecutive, c.severity,
	c.notify_enabled, c.recovery_notify, c.message_template, diag_url, c.absent_as_zero, c.observe_only, c.enabled, c.created_at, c.updated_at`

func scanPromCheck(sc interface{ Scan(...interface{}) error }, withTarget bool) (PromCheck, error) {
	var c PromCheck
	var targetName, targetURL sql.NullString
	dest := []interface{}{
		&c.ID, &c.TargetID, &c.Name, &c.Dimension, &c.Metric, &c.LabelFilter, &c.Aggregate,
		&c.ExprKind, &c.ExprDenominator, &c.AlertStrategy, &c.AlertCondition, &c.AlertValue,
		&c.AlertDeltaValue, &c.AlertDeltaPercent, &c.AlertConsecutive, &c.Severity,
		&c.NotifyEnabled, &c.RecoveryNotify, &c.MessageTemplate, &c.DiagURL, &c.AbsentAsZero, &c.ObserveOnly, &c.Enabled, &c.CreatedAt, &c.UpdatedAt,
	}
	if withTarget {
		dest = append(dest, &targetName, &targetURL)
	}
	if err := sc.Scan(dest...); err != nil {
		return c, err
	}
	c.TargetName = targetName.String
	c.TargetURL = targetURL.String
	return c, nil
}

// ListPromChecks 列出规则；targetID 为 nil 时列出全部。
func (s *Store) ListPromChecks(targetID *int64) ([]PromCheck, error) {
	q := `SELECT ` + promCheckColumns + `, t.name, t.url
		FROM prom_checks c LEFT JOIN prom_targets t ON t.id = c.target_id`
	args := []interface{}{}
	if targetID != nil {
		q += ` WHERE c.target_id = ?`
		args = append(args, *targetID)
	}
	q += ` ORDER BY c.id`

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]PromCheck, 0)
	for rows.Next() {
		c, err := scanPromCheck(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetPromCheck(id int64) (*PromCheck, error) {
	row := s.db.QueryRow(`SELECT `+promCheckColumns+`, t.name, t.url
		FROM prom_checks c LEFT JOIN prom_targets t ON t.id = c.target_id
		WHERE c.id = ?`, id)
	c, err := scanPromCheck(row, true)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *Store) CreatePromCheck(c *PromCheck) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO prom_checks
		(target_id, name, dimension, metric, label_filter, aggregate, expr_kind, expr_denominator,
		 alert_strategy, alert_condition, alert_value, alert_delta_value, alert_delta_percent,
		 alert_consecutive, severity, notify_enabled, recovery_notify, message_template, diag_url, absent_as_zero, observe_only, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.TargetID, c.Name, c.Dimension, c.Metric, c.LabelFilter, c.Aggregate, c.ExprKind, c.ExprDenominator,
		c.AlertStrategy, c.AlertCondition, c.AlertValue, c.AlertDeltaValue, c.AlertDeltaPercent,
		c.AlertConsecutive, c.Severity, c.NotifyEnabled, c.RecoveryNotify, c.MessageTemplate, c.DiagURL, c.AbsentAsZero, c.ObserveOnly, c.Enabled)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdatePromCheck(c *PromCheck) error {
	_, err := s.db.Exec(`UPDATE prom_checks SET
		target_id = ?, name = ?, dimension = ?, metric = ?, label_filter = ?, aggregate = ?,
		expr_kind = ?, expr_denominator = ?, alert_strategy = ?, alert_condition = ?, alert_value = ?,
		alert_delta_value = ?, alert_delta_percent = ?, alert_consecutive = ?, severity = ?,
		notify_enabled = ?, recovery_notify = ?, message_template = ?, diag_url = ?, absent_as_zero = ?, observe_only = ?, enabled = ?,
		updated_at = datetime('now')
		WHERE id = ?`,
		c.TargetID, c.Name, c.Dimension, c.Metric, c.LabelFilter, c.Aggregate,
		c.ExprKind, c.ExprDenominator, c.AlertStrategy, c.AlertCondition, c.AlertValue,
		c.AlertDeltaValue, c.AlertDeltaPercent, c.AlertConsecutive, c.Severity,
		c.NotifyEnabled, c.RecoveryNotify, c.MessageTemplate, c.DiagURL, c.AbsentAsZero, c.ObserveOnly, c.Enabled, c.ID)
	return err
}

func (s *Store) DeletePromCheck(id int64) error {
	_, err := s.db.Exec(`DELETE FROM prom_checks WHERE id = ?`, id)
	if err == nil {
		// 不清的话该规则已 firing 的事件永远没人 resolve，僵尸卡在告警页
		s.db.Exec(`DELETE FROM alert_events WHERE source = 'prom' AND check_id = ?`, id)
		s.db.Exec(`DELETE FROM metric_samples WHERE check_id = ?`, id)
	}
	return err
}

func (s *Store) TogglePromCheck(id int64) error {
	_, err := s.db.Exec(`UPDATE prom_checks SET enabled = NOT enabled, updated_at = datetime('now') WHERE id = ?`, id)
	return err
}

func (s *Store) InsertPromAlertLog(l *PromAlertLog) {
	_, err := s.db.Exec(`INSERT INTO prom_alert_logs
		(check_id, check_name, target_id, target_name, dimension, severity, status,
		 metric, value, threshold, message, error, duration_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		l.CheckID, l.CheckName, l.TargetID, l.TargetName, l.Dimension, l.Severity, l.Status,
		l.Metric, l.Value, l.Threshold, l.Message, l.Error, l.DurationMs)
	if err != nil {
		logInsertFailure("prom_alert_logs", err)
	}
}

// LastPromAlertStatus 返回该规则最近一次的状态，用于恢复通知的去重。
func (s *Store) LastPromAlertStatus(checkID int64) (string, bool, error) {
	var status string
	err := s.db.QueryRow(`SELECT status FROM prom_alert_logs WHERE check_id = ?
		ORDER BY id DESC LIMIT 1`, checkID).Scan(&status)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return status, true, nil
}

func (s *Store) ListPromAlertLogs(checkID *int64, dimension string, page, pageSize int) ([]PromAlertLog, int, error) {
	where := ` WHERE 1 = 1`
	args := []interface{}{}
	if checkID != nil {
		where += ` AND check_id = ?`
		args = append(args, *checkID)
	}
	if dimension != "" {
		where += ` AND dimension = ?`
		args = append(args, dimension)
	}

	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM prom_alert_logs`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 500 {
		pageSize = 50
	}
	args = append(args, pageSize, (page-1)*pageSize)

	rows, err := s.db.Query(`SELECT id, check_id, check_name, target_id, target_name, dimension,
		severity, status, metric, value, threshold, message, error, duration_ms, detected_at
		FROM prom_alert_logs`+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := make([]PromAlertLog, 0)
	for rows.Next() {
		var l PromAlertLog
		if err := rows.Scan(&l.ID, &l.CheckID, &l.CheckName, &l.TargetID, &l.TargetName, &l.Dimension,
			&l.Severity, &l.Status, &l.Metric, &l.Value, &l.Threshold, &l.Message, &l.Error,
			&l.DurationMs, &l.DetectedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, l)
	}
	return out, total, rows.Err()
}

func (s *Store) PurgeOldPromAlertLogs() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM prom_alert_logs WHERE detected_at < datetime('now', '-30 days')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) CountPromChecks() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM prom_checks WHERE enabled = 1`).Scan(&n)
	return n, err
}

func (s *Store) CountPromAlertsToday() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM prom_alert_logs
		WHERE status = 'alert' AND date(detected_at) = date('now')`).Scan(&n)
	return n, err
}

// CountPromAlertsByDimension 给仪表盘用：按维度统计今日告警数。
func (s *Store) CountPromAlertsByDimension() (map[string]int, error) {
	rows, err := s.db.Query(`SELECT dimension, COUNT(*) FROM prom_alert_logs
		WHERE status = 'alert' AND date(detected_at) = date('now')
		GROUP BY dimension`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]int{}
	for rows.Next() {
		var dim string
		var n int
		if err := rows.Scan(&dim, &n); err != nil {
			return nil, err
		}
		out[dim] = n
	}
	return out, rows.Err()
}

func logInsertFailure(table string, err error) {
	if err != nil {
		fmt.Printf("[store] insert %s failed: %v\n", table, err)
	}
}
