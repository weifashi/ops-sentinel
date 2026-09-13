package monitor

import (
	"strings"
	"testing"

	"ops-sentinel/internal/store"
)

func TestValidateCustomSQLRejectsUnsafeStatements(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		want string
	}{
		{name: "write operation", sql: "UPDATE orders SET status = 1", want: "只允许"},
		{name: "sleep", sql: "SELECT SLEEP(10)", want: "SLEEP"},
		{name: "select star", sql: "SELECT * FROM orders LIMIT 1", want: "SELECT *"},
		{name: "full scan select", sql: "SELECT id, name FROM orders", want: "必须带 LIMIT"},
		{name: "outfile", sql: "SELECT id FROM orders LIMIT 1 INTO OUTFILE '/tmp/a'", want: "INTO OUTFILE"},
		{name: "for update", sql: "SELECT id FROM orders WHERE id = 1 FOR UPDATE", want: "FOR UPDATE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateCustomSQL(tt.sql)
			if err == nil {
				t.Fatalf("expected error")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("expected %q in %q", tt.want, err.Error())
			}
		})
	}
}

func TestValidateCustomSQLAllowsSafeMonitoringQueries(t *testing.T) {
	tests := []string{
		"SELECT COUNT(*) AS process_count FROM information_schema.PROCESSLIST",
		"SELECT id, name FROM orders LIMIT 1",
		"SHOW STATUS LIKE 'Threads_connected'",
		"EXPLAIN SELECT id FROM orders WHERE id = 1",
	}
	for _, sql := range tests {
		t.Run(sql, func(t *testing.T) {
			if err := ValidateCustomSQL(sql); err != nil {
				t.Fatalf("expected valid SQL, got %v", err)
			}
		})
	}
}

func TestCustomSQLAlertRuleAcceptsFrontendFieldNames(t *testing.T) {
	cfg := &store.CustomSQLCheck{
		Name: "lock waits",
		AlertRules: `[
			{
				"name": "MySQL 行锁等待次数突增",
				"result_field": "innodb_row_lock_waits",
				"alert_strategy": "increase",
				"condition": "gt",
				"expected_value": "",
				"alert_delta_value": "500"
			}
		]`,
	}

	rules := customSQLAlertRulesFromConfig(cfg)
	if len(rules) != 1 {
		t.Fatalf("expected 1 rule, got %d", len(rules))
	}
	if rules[0].Strategy != "increase" {
		t.Fatalf("expected strategy increase, got %q", rules[0].Strategy)
	}
	if rules[0].DeltaValue != "500" {
		t.Fatalf("expected delta value 500, got %q", rules[0].DeltaValue)
	}

	ruleCfg := customSQLCheckForAlertRule(cfg, rules[0])
	state := &healthMetricState{Field: ruleCfg.ResultField}

	matched, reason := EvaluateCustomSQLRule("1360602", ruleCfg, state)
	if matched {
		t.Fatalf("first sample should only seed state, got alert: %s", reason)
	}

	matched, reason = EvaluateCustomSQLRule("1361000", ruleCfg, state)
	if matched {
		t.Fatalf("delta below 500 should not alert: %s", reason)
	}
	if !strings.Contains(reason, "变化 398") {
		t.Fatalf("expected increase reason with delta, got %q", reason)
	}

	matched, reason = EvaluateCustomSQLRule("1361601", ruleCfg, state)
	if !matched {
		t.Fatalf("delta >= 500 should alert: %s", reason)
	}
	if !strings.Contains(reason, "变化量阈值 500") {
		t.Fatalf("expected delta threshold in reason, got %q", reason)
	}
}

func TestCustomSQLIncreaseSkipsEmptyValue(t *testing.T) {
	cfg := &store.CustomSQLCheck{
		ResultField:     "com_select",
		AlertStrategy:   "increase",
		Condition:       "gt",
		ExpectedValue:   "0",
		AlertDeltaValue: "100",
	}
	state := &healthMetricState{Field: "com_select", HasLast: true, LastValue: 12}

	matched, reason := EvaluateCustomSQLRule("", cfg, state)
	if matched {
		t.Fatalf("empty value should not alert: %s", reason)
	}
	if !strings.Contains(reason, "等待有效数值") {
		t.Fatalf("expected empty value reason, got %q", reason)
	}
	if state.LastValue != 12 {
		t.Fatalf("empty value should not overwrite last value, got %.4f", state.LastValue)
	}
}

func TestCustomSQLMetricSourceSignatureSeparatesSQLSources(t *testing.T) {
	first := &store.CustomSQLCheck{
		DatabaseID:  1,
		DBName:      "performance_schema",
		SQLText:     "SHOW GLOBAL STATUS LIKE 'Questions'",
		ResultField: "Value",
	}
	second := *first
	second.SQLText = "SELECT VARIABLE_VALUE AS Value FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Questions' LIMIT 1"

	if customSQLMetricSourceSignature(first, "server_id=1;hostname=db-a") == customSQLMetricSourceSignature(&second, "server_id=1;hostname=db-a") {
		t.Fatalf("different SQL sources should not share a metric baseline key")
	}

	sameWithWhitespace := *first
	sameWithWhitespace.SQLText = "  SHOW GLOBAL STATUS LIKE 'Questions';  "
	if customSQLMetricSourceSignature(first, "server_id=1;hostname=db-a") != customSQLMetricSourceSignature(&sameWithWhitespace, "server_id=1;hostname=db-a") {
		t.Fatalf("whitespace and trailing semicolon should not change metric source signature")
	}

	otherServer := *first
	if customSQLMetricSourceSignature(first, "server_id=1;hostname=db-a") == customSQLMetricSourceSignature(&otherServer, "server_id=2;hostname=db-b") {
		t.Fatalf("different MySQL backends should not share a metric baseline key")
	}
}

func TestValidateCustomSQLStringLiteralsAreNotKeywords(t *testing.T) {
	// 字符串常量里出现关键字不该被当成真的调用了那个语句。
	// MySQL 监控里 command <> 'Sleep' 是最常见的写法之一。
	ok := []string{
		"SELECT COUNT(*) AS active FROM information_schema.processlist WHERE command <> 'Sleep'",
		"SELECT COUNT(*) AS n FROM information_schema.processlist WHERE state = 'update'",
		"SELECT COUNT(*) AS replicas FROM information_schema.processlist WHERE command LIKE 'Binlog Dump%'",
		"SELECT COUNT(*) AS n FROM t WHERE note = 'it''s a drop'",
	}
	for _, s := range ok {
		if err := ValidateCustomSQL(s); err != nil {
			t.Errorf("应放行但被拒: %s\n  原因: %v", s, err)
		}
	}

	// 真正的写操作和 SLEEP() 调用仍然要拦住
	bad := []string{
		"SELECT SLEEP(5) AS x",
		"DELETE FROM orders",
		"SELECT id FROM t WHERE 1=1 FOR UPDATE LIMIT 1",
	}
	for _, s := range bad {
		if err := ValidateCustomSQL(s); err == nil {
			t.Errorf("应拦截却放行: %s", s)
		}
	}
}

// 自定义 SQL 的增长策略也要尊重 alert_consecutive：单轮尖峰不响，连续 N 轮才响，中间断一轮重新计数。
func TestCustomSQLIncreaseHonorsConsecutive(t *testing.T) {
	cfg := &store.CustomSQLCheck{AlertStrategy: "increase", AlertDeltaValue: "20", AlertConsecutive: 2, ResultField: "slow"}
	st := &healthMetricState{}
	step := func(v string) bool { m, _ := EvaluateCustomSQLRule(v, cfg, st); return m }
	step("100") // 基线
	if step("130") {
		t.Fatal("first growth round must not alert with consecutive=2")
	}
	if !step("160") {
		t.Fatal("second consecutive growth round should alert")
	}
	if step("165") { // 增量 5 < 20，归零
		t.Fatal("small increase should reset and not alert")
	}
	if step("200") {
		t.Fatal("counter must restart after a miss")
	}
	if !step("240") {
		t.Fatal("two consecutive hits after reset should alert again")
	}
}
