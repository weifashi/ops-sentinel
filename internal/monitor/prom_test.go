package monitor

import (
	"strings"
	"math"
	"testing"
	"time"

	"ops-sentinel/internal/store"
)

func TestParsePromText(t *testing.T) {
	body := `# HELP node_memory_SwapFree_bytes Memory information.
# TYPE node_memory_SwapFree_bytes gauge
node_memory_SwapFree_bytes 1.2247424e+07
node_memory_SwapTotal_bytes 1.7716736e+07
node_filesystem_avail_bytes{device="/dev/sda2",mountpoint="/"} 3.3e+10
node_filesystem_avail_bytes{device="/dev/sdb",mountpoint="/mnt/data"} 1.9e+11
http_requests_total{method="GET",path="/api/v1",status="200"} 1234
http_requests_total{method="GET",path="/api/v1",status="500"} 7
# 带时间戳的样本，时间戳应被忽略
process_open_fds 512 1717171717000
`

	families := parsePromText(body)

	if len(families) != 5 {
		t.Fatalf("expected 5 metric families, got %d", len(families))
	}

	// 无标签指标
	if got := families["node_memory_SwapFree_bytes"]; len(got) != 1 || got[0].Value != 1.2247424e+07 {
		t.Errorf("swap free parsed wrong: %+v", got)
	}

	// 多样本 + 标签
	fs := families["node_filesystem_avail_bytes"]
	if len(fs) != 2 {
		t.Fatalf("expected 2 filesystem samples, got %d", len(fs))
	}
	if fs[0].Labels["mountpoint"] != "/" || fs[1].Labels["device"] != "/dev/sdb" {
		t.Errorf("filesystem labels parsed wrong: %+v", fs)
	}

	// 时间戳应被忽略，取第一段作为值
	if got := families["process_open_fds"]; len(got) != 1 || got[0].Value != 512 {
		t.Errorf("timestamp should be ignored: %+v", got)
	}
}

func TestParsePromTextEdgeCases(t *testing.T) {
	body := `metric_with_comma{msg="a,b",other="c"} 1
metric_inf +Inf
metric_nan NaN
`
	families := parsePromText(body)

	// 引号内的逗号不能被当成标签分隔符
	s := families["metric_with_comma"]
	if len(s) != 1 {
		t.Fatalf("expected 1 sample, got %d", len(s))
	}
	if s[0].Labels["msg"] != "a,b" || s[0].Labels["other"] != "c" {
		t.Errorf("quoted comma mishandled: %+v", s[0].Labels)
	}

	if v := families["metric_inf"]; len(v) != 1 || !math.IsInf(v[0].Value, 1) {
		t.Errorf("+Inf not parsed: %+v", v)
	}
	if v := families["metric_nan"]; len(v) != 1 || !math.IsNaN(v[0].Value) {
		t.Errorf("NaN not parsed: %+v", v)
	}
}

func TestAggregateMetric(t *testing.T) {
	families := map[string][]promSample{
		"m": {
			{Labels: map[string]string{"d": "a"}, Value: 10},
			{Labels: map[string]string{"d": "b"}, Value: 30},
			{Labels: map[string]string{"d": "c"}, Value: 20},
		},
	}

	cases := []struct {
		aggregate string
		want      float64
	}{
		{"sum", 60},
		{"avg", 20},
		{"max", 30},
		{"min", 10},
		{"count", 3},
		{"last", 20},
		{"", 20}, // 默认 last
	}

	for _, c := range cases {
		got, _, err := aggregateMetric("m", "", c.aggregate, families)
		if err != nil {
			t.Fatalf("aggregate %q failed: %v", c.aggregate, err)
		}
		if got != c.want {
			t.Errorf("aggregate %q = %v, want %v", c.aggregate, got, c.want)
		}
	}

	// 标签过滤
	got, _, err := aggregateMetric("m", `d="b"`, "sum", families)
	if err != nil || got != 30 {
		t.Errorf("label filter failed: got %v err %v", got, err)
	}

	// 前缀匹配，容器名带随机后缀时用
	got, _, err = aggregateMetric("m", `d="a*"`, "sum", families)
	if err != nil || got != 10 {
		t.Errorf("prefix filter failed: got %v err %v", got, err)
	}

	// 指标不存在应报错而不是返回 0，否则会被误判成"低于阈值"
	if _, _, err := aggregateMetric("nonexistent", "", "sum", families); err == nil {
		t.Error("missing metric should return error, not zero")
	}

	// 过滤后无样本同样应报错
	if _, _, err := aggregateMetric("m", `d="zzz"`, "sum", families); err == nil {
		t.Error("no matching sample should return error")
	}
}

func TestComputePromValueRatio(t *testing.T) {
	families := map[string][]promSample{
		"used":  {{Labels: map[string]string{}, Value: 25}},
		"total": {{Labels: map[string]string{}, Value: 100}},
		"free":  {{Labels: map[string]string{}, Value: 25}},
	}

	// ratio：used/total 以百分比返回
	v, _, err := computePromValue(&store.PromCheck{
		Metric: "used", ExprKind: "ratio", ExprDenominator: "total",
	}, families)
	if err != nil || v != 25 {
		t.Errorf("ratio = %v (err %v), want 25", v, err)
	}

	// available_ratio：free/total 翻转成使用率
	v, _, err = computePromValue(&store.PromCheck{
		Metric: "free", ExprKind: "available_ratio", ExprDenominator: "total",
	}, families)
	if err != nil || v != 75 {
		t.Errorf("available_ratio = %v (err %v), want 75", v, err)
	}

	// raw
	v, _, err = computePromValue(&store.PromCheck{Metric: "used", ExprKind: "raw"}, families)
	if err != nil || v != 25 {
		t.Errorf("raw = %v (err %v), want 25", v, err)
	}

	// 分母为 0 必须报错，不能产生 Inf 后被阈值误判
	zero := map[string][]promSample{
		"a": {{Labels: map[string]string{}, Value: 1}},
		"b": {{Labels: map[string]string{}, Value: 0}},
	}
	if _, _, err := computePromValue(&store.PromCheck{
		Metric: "a", ExprKind: "ratio", ExprDenominator: "b",
	}, zero); err == nil {
		t.Error("zero denominator should return error")
	}
}

func TestEvaluatePromCondition(t *testing.T) {
	cases := []struct {
		value     float64
		condition string
		threshold string
		want      bool
	}{
		{10, "gt", "5", true},
		{10, "gt", "10", false},
		{10, "gte", "10", true},
		{10, "lt", "20", true},
		{10, "lte", "10", true},
		{10, "eq", "10", true},
		{10, "ne", "5", true},
		{10, "", "5", true}, // 默认 gt
	}

	for _, c := range cases {
		got, _ := evaluatePromCondition(c.value, c.condition, c.threshold)
		if got != c.want {
			t.Errorf("%v %s %s = %v, want %v", c.value, c.condition, c.threshold, got, c.want)
		}
	}

	// 阈值缺失或非数字时不应命中，否则会误报
	if got, _ := evaluatePromCondition(10, "gt", ""); got {
		t.Error("empty threshold should not match")
	}
	if got, _ := evaluatePromCondition(10, "gt", "abc"); got {
		t.Error("non-numeric threshold should not match")
	}
}

func TestEvaluatePromRuleSustained(t *testing.T) {
	check := &store.PromCheck{
		AlertStrategy: "sustained", AlertCondition: "gt",
		AlertValue: "5", AlertConsecutive: 3,
	}
	st := &promMetricState{}

	// 前两次越界但未达连续次数，不应告警 —— 这是过滤抖动的关键
	for i := 1; i <= 2; i++ {
		if matched, _ := evaluatePromRule(10, check, st); matched {
			t.Fatalf("should not alert at attempt %d", i)
		}
	}
	if matched, _ := evaluatePromRule(10, check, st); !matched {
		t.Error("should alert at 3rd consecutive breach")
	}

	// 一次回落即清零，重新计数
	if matched, _ := evaluatePromRule(1, check, st); matched {
		t.Error("should not alert when value recovers")
	}
	if st.ConsecutiveMatched != 0 {
		t.Errorf("counter should reset, got %d", st.ConsecutiveMatched)
	}
}

func TestEvaluatePromRuleIncrease(t *testing.T) {
	check := &store.PromCheck{
		AlertStrategy: "increase", AlertDeltaValue: "100",
	}
	st := &promMetricState{}

	// 首次采集只建立基线，不能告警
	if matched, _ := evaluatePromRule(1000, check, st); matched {
		t.Error("first sample should not alert")
	}
	st.LastValue = 1000
	st.HasLast = true

	if matched, _ := evaluatePromRule(1050, check, st); matched {
		t.Error("delta 50 should not alert with threshold 100")
	}
	if matched, _ := evaluatePromRule(1200, check, st); !matched {
		t.Error("delta 200 should alert with threshold 100")
	}

	// 变化率
	pct := &store.PromCheck{AlertStrategy: "increase", AlertDeltaPercent: "50"}
	st2 := &promMetricState{LastValue: 100, HasLast: true}
	if matched, _ := evaluatePromRule(200, pct, st2); !matched {
		t.Error("100% increase should alert with 50% threshold")
	}
}

func TestEvaluatePromRuleIncreaseZeroDelta(t *testing.T) {
	// 阈值填 0 是"任何增长都报"的直觉写法。此时 delta==0 不能命中，
	// 否则像 node_vmstat_oom_kill 这种长期不变的计数器会每个周期都告警。
	zero := &store.PromCheck{AlertStrategy: "increase", AlertDeltaValue: "0"}
	st := &promMetricState{LastValue: 0, HasLast: true}
	if matched, _ := evaluatePromRule(0, zero, st); matched {
		t.Error("zero delta must not alert even when threshold is 0")
	}
	if matched, _ := evaluatePromRule(1, zero, st); !matched {
		t.Error("a real increase should alert when threshold is 0")
	}

	// 计数器重置（进程重启）会让 delta 变负，同样不该报增长
	neg := &store.PromCheck{AlertStrategy: "increase", AlertDeltaValue: "100"}
	st2 := &promMetricState{LastValue: 5000, HasLast: true}
	if matched, _ := evaluatePromRule(10, neg, st2); matched {
		t.Error("counter reset (negative delta) must not alert")
	}
}

func TestNormalizeCertEndpoint(t *testing.T) {
	cases := map[string]string{
		"example.com":                    "example.com:443",
		"example.com:8443":               "example.com:8443",
		"https://example.com":            "example.com:443",
		"https://example.com/path?a=b":   "example.com:443",
		"http://example.com:8080/health": "example.com:8080",
	}
	for in, want := range cases {
		if got := normalizeCertEndpoint(in); got != want {
			t.Errorf("normalizeCertEndpoint(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseJSONStringMap(t *testing.T) {
	if got := parseJSONStringMap(`{"Authorization":"Bearer x"}`); got["Authorization"] != "Bearer x" {
		t.Errorf("valid json parsed wrong: %+v", got)
	}
	// 非法配置不应让采集失败，返回空即可
	if got := parseJSONStringMap("not json"); got != nil {
		t.Errorf("invalid json should return nil, got %+v", got)
	}
	if got := parseJSONStringMap("{}"); got != nil {
		t.Errorf("empty object should return nil, got %+v", got)
	}
}

func TestShouldLogPromResult(t *testing.T) {
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

	// 状态变化必须写：告警和恢复都不能漏
	st := &promMetricState{LastLoggedStatus: "ok", LastLoggedAt: base}
	if !shouldLogPromResult(st, "alert", base.Add(time.Second)) {
		t.Error("ok -> alert 必须落库")
	}
	if !shouldLogPromResult(st, "error", base.Add(time.Second)) {
		t.Error("ok -> error 必须落库")
	}

	// 状态没变时按心跳间隔限流，否则每轮一行会把库撑爆
	if shouldLogPromResult(st, "ok", base.Add(5*time.Minute)) {
		t.Error("状态未变且未到心跳间隔，不该写库")
	}
	if !shouldLogPromResult(st, "ok", base.Add(promLogHeartbeat)) {
		t.Error("到了心跳间隔就该写一行，用来证明规则还在跑")
	}

	// 没有状态时保守处理：写
	if !shouldLogPromResult(nil, "ok", base) {
		t.Error("状态缺失时应落库")
	}
}

func TestSustainedWarmupIsNotRecovery(t *testing.T) {
	// 重启后 sustained 计数从零热身：阈值仍超标但 matched=false。
	// 这段时间不能被当成"恢复"，否则每次重启都会群发一轮恢复通知、
	// 把 firing 事件错误关闭再重开。
	check := &store.PromCheck{
		AlertStrategy: "sustained", AlertCondition: "gt",
		AlertValue: "90", AlertConsecutive: 3,
	}
	st := &promMetricState{}
	matched, _ := evaluatePromRule(96, check, st)
	if matched {
		t.Fatal("第 1 轮不该 matched")
	}
	// 热身中：ConsecutiveMatched 已 >0，evaluate 里的 warmingUp 守卫依赖这一点
	if st.ConsecutiveMatched != 1 {
		t.Fatalf("热身计数应为 1，得到 %d", st.ConsecutiveMatched)
	}
	// 真恢复：值回落后计数清零，此时才允许 resolve
	evaluatePromRule(50, check, st)
	if st.ConsecutiveMatched != 0 {
		t.Fatal("回落后计数应清零")
	}
}

func TestAggregateMetricDetail(t *testing.T) {
	families := map[string][]promSample{
		"m": {
			{Labels: map[string]string{"container": "a"}, Value: 10},
			{Labels: map[string]string{"container": "mariadb-x"}, Value: 86},
			{Labels: map[string]string{"container": "c"}, Value: 20},
		},
		"single": {{Labels: map[string]string{"container": "only"}, Value: 5}},
	}
	// max 要带出极值样本的标签——这就是"85.91% 到底是哪个容器"的答案
	v, detail, err := aggregateMetric("m", "", "max", families)
	if err != nil || v != 86 {
		t.Fatalf("max = %v err %v", v, err)
	}
	if detail != `container=mariadb-x` {
		t.Errorf("max 来源应为极值样本，得到 %q", detail)
	}
	// sum 带最大贡献者
	_, detail, _ = aggregateMetric("m", "", "sum", families)
	if detail != `container=mariadb-x` {
		t.Errorf("sum 来源应为最大贡献者，得到 %q", detail)
	}
	// 单样本：没有标签过滤时来源仍要显示（"有容器内存>85%"这类规则得说清是哪个容器）；
	// 带标签过滤时过滤条件已指明对象，来源置空少一行噪音
	_, detail, _ = aggregateMetric("single", "", "max", families)
	if detail != "container=only" {
		t.Errorf("无过滤的单样本来源应显示标签，得到 %q", detail)
	}
	_, detail, _ = aggregateMetric("single", `container="only"`, "max", families)
	if detail != "" {
		t.Errorf("带过滤的单样本来源应为空，得到 %q", detail)
	}
}

// 掉线检测的关键路径：容器停止→序列值 0；容器被删→序列消失。
// absent_as_zero 开启时后者按 0 评估，lt 1 的规则两种情况都触发。
func TestAbsentAsZero(t *testing.T) {
	families := parsePromText(`ttpos_container_up{vm="p3",container="other"} 1`)

	check := &store.PromCheck{
		Metric: "ttpos_container_up", LabelFilter: `container="rocketmq-broker*"`,
		Aggregate: "min", ExprKind: "raw",
		AlertStrategy: "threshold", AlertCondition: "lt", AlertValue: "1",
	}

	// 开关关闭：无匹配样本走 error 路径
	if _, _, err := computePromValue(check, families); err == nil {
		t.Fatal("无匹配样本应报错")
	}

	// 开关开启：evaluate 的 absent 分支把值置 0，lt 1 命中
	check.AbsentAsZero = true
	value, _, err := computePromValue(check, families)
	if err != nil && check.AbsentAsZero {
		value, err = 0, nil
	}
	if err != nil {
		t.Fatalf("absent_as_zero 后不应报错: %v", err)
	}
	matched, _ := evaluatePromRule(value, check, &promMetricState{})
	if !matched {
		t.Fatal("值 0 对 lt 1 应命中")
	}

	// 序列存在但值为 0（容器停止）：不依赖开关也应命中
	families2 := parsePromText(`ttpos_container_up{vm="p3",container="rocketmq-broker-abc"} 0`)
	v2, _, err := computePromValue(check, families2)
	if err != nil {
		t.Fatalf("有样本不应报错: %v", err)
	}
	if m2, _ := evaluatePromRule(v2, check, &promMetricState{}); !m2 {
		t.Fatal("up=0 对 lt 1 应命中")
	}
}

// delta 表达式：第一轮只建基线；之后给增量；计数器归零按当前值算。
func TestCounterDelta(t *testing.T) {
	st := &promMetricState{}
	if _, ok := counterDelta(st, 100); ok {
		t.Fatal("first sample should only establish baseline")
	}
	if d, ok := counterDelta(st, 130); !ok || d != 30 {
		t.Fatalf("delta = %v ok=%v, want 30", d, ok)
	}
	if d, ok := counterDelta(st, 130); !ok || d != 0 {
		t.Fatalf("no growth delta = %v, want 0", d)
	}
	if d, ok := counterDelta(st, 7); !ok || d != 7 {
		t.Fatalf("counter reset delta = %v, want 7", d)
	}
	if !isDeltaKind(&store.PromCheck{ExprKind: " Delta "}) || isDeltaKind(&store.PromCheck{ExprKind: "raw"}) {
		t.Fatal("isDeltaKind")
	}
	// delta 在 computePromValue 阶段与 raw 等价（换算在 evaluate 里做）
	families := map[string][]promSample{"c": {{Value: 5}}}
	if v, _, err := computePromValue(&store.PromCheck{Metric: "c", ExprKind: "delta"}, families); err != nil || v != 5 {
		t.Fatalf("delta compute = %v err %v", v, err)
	}
}

// 增长类规则的来源应指向本轮增量最大的序列，而不是累计值最大的序列。
func TestGrowthDetail(t *testing.T) {
	check := &store.PromCheck{Metric: "errs", LabelFilter: `kind="error"`, AlertStrategy: "increase"}
	mk := func(nginx, app float64) map[string][]promSample {
		return map[string][]promSample{"errs": {
			{Labels: map[string]string{"container": "nginx", "kind": "error"}, Value: nginx},
			{Labels: map[string]string{"container": "main:app", "kind": "error"}, Value: app},
		}}
	}
	st := &promMetricState{}
	if d := growthDetail(check, mk(22, 0), st, "fb"); d != "fb" {
		t.Fatalf("first round should fall back, got %q", d)
	}
	if d := growthDetail(check, mk(22, 1), st, "fb"); !strings.Contains(d, "main:app") {
		t.Fatalf("second round should point to the grown series, got %q", d)
	}
	if d := growthDetail(check, mk(22, 1), st, "fb"); d != "fb" {
		t.Fatalf("no growth should fall back, got %q", d)
	}
	if d := growthDetail(check, mk(25, 1), st, "fb"); !strings.Contains(d, "nginx") {
		t.Fatalf("nginx grew by 3, got %q", d)
	}
}
