package notify

import (
	"strings"
	"testing"
)

func TestFeishuTemplatePrefersAlertTitle(t *testing.T) {
	got := feishuTemplate("服务异常告警", "该告警仅发送一次，恢复后如再次异常将重新通知。")
	if got != "red" {
		t.Fatalf("expected red alert template, got %q", got)
	}
}

func TestFeishuTemplateUsesGreenForRecoveryTitle(t *testing.T) {
	got := feishuTemplate("服务恢复通知", "服务: web1\n状态: 已恢复正常")
	if got != "green" {
		t.Fatalf("expected green recovery template, got %q", got)
	}
}

func TestSanitizeFeishuBlockedSleepFunction(t *testing.T) {
	got := sanitizeFeishuBlockedText("SELECT SLEEP(13)")
	want := "SELECT SLEEP (13)"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestFeishuLevelTemplate(t *testing.T) {
	cases := map[string]string{
		"critical": "red", "error": "red",
		"warning":  "orange",
		"recovery": "green",
		"info":     "blue", "test": "blue",
		"": "", "unknown": "",
	}
	for in, want := range cases {
		if got := feishuLevelTemplate(in); got != want {
			t.Errorf("feishuLevelTemplate(%q) = %q, want %q", in, got, want)
		}
	}
}

// 日志/诊断原文必须走 plain_text：lark_md 不渲染 ``` 围栏，且会把 * _ ` 当 markdown。
func TestFeishuCodeElementIsPlainText(t *testing.T) {
	el := feishuCodeElement("  gorm.(*processor).Execute\n\t/go/pkg/mod/x.go:1\n`ttpos_lan_printer_scan` WHERE a_b = 0  ")
	text, _ := el["text"].(map[string]string)
	if text["tag"] != "plain_text" {
		t.Fatalf("tag = %q, want plain_text", text["tag"])
	}
	if strings.Contains(text["content"], "```") || strings.Contains(text["content"], "\\*") {
		t.Fatalf("content should be raw, got %q", text["content"])
	}
	if !strings.HasPrefix(text["content"], "gorm.(*processor)") || !strings.Contains(text["content"], "\n\t/go/pkg") {
		t.Fatalf("content lost newlines/raw chars: %q", text["content"])
	}
}
