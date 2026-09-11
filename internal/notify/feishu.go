package notify

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"ops-sentinel/internal/store"
)

var feishuBlockedSleepPattern = regexp.MustCompile(`(?i)\bsleep\s*\(`)

func SendFeishu(cfg store.FeishuConfig, message string, level string) error {
	type textContent struct {
		Text string `json:"text"`
	}
	type fsBody struct {
		Timestamp string       `json:"timestamp,omitempty"`
		Sign      string       `json:"sign,omitempty"`
		MsgType   string       `json:"msg_type"`
		Content   *textContent `json:"content,omitempty"`
		Card      any          `json:"card,omitempty"`
	}

	body := fsBody{
		MsgType: "interactive",
		Card:    buildFeishuCard(message, level),
	}

	if strings.TrimSpace(cfg.Secret) != "" {
		sec := time.Now().Unix()
		body.Timestamp = fmt.Sprintf("%d", sec)
		body.Sign = feishuSign(sec, cfg.Secret)
	}

	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("json marshal: %w", err)
	}
	return postFeishu(cfg.Webhook, data)
}

func postFeishu(webhook string, data []byte) error {
	resp, err := http.Post(webhook, "application/json", bytes.NewBuffer(data))
	if err != nil {
		return fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http status: %d, body: %s", resp.StatusCode, string(respBody))
	}

	var fr struct {
		Code          int    `json:"code"`
		StatusCode    int    `json:"StatusCode"`
		Msg           string `json:"msg"`
		StatusMessage string `json:"StatusMessage"`
	}
	if err := json.Unmarshal(respBody, &fr); err != nil {
		if len(bytes.TrimSpace(respBody)) == 0 {
			return nil
		}
		return fmt.Errorf("parse feishu response: %w, body: %s", err, string(respBody))
	}
	apiCode := fr.Code
	if apiCode == 0 {
		apiCode = fr.StatusCode
	}
	if apiCode != 0 {
		errMsg := fr.Msg
		if errMsg == "" {
			errMsg = fr.StatusMessage
		}
		return fmt.Errorf("feishu api code=%d: %s", apiCode, errMsg)
	}
	return nil
}

// SendFeishuCard 发送结构化告警卡片：彩色头 + 字段行 + 可选备注/代码块 + 查看详情。
func SendFeishuCard(cfg store.FeishuConfig, card *AlertCard, baseURL string) error {
	template := feishuLevelTemplate(card.Level)
	if template == "" {
		template = "wathet"
	}

	elements := []map[string]any{}
	if len(card.Fields) > 0 {
		var lines []string
		for _, kv := range card.Fields {
			lines = append(lines, "**"+escapeLarkMarkdown(kv[0])+"**: "+escapeLarkMarkdown(sanitizeFeishuBlockedText(kv[1])))
		}
		elements = append(elements, map[string]any{
			"tag":  "div",
			"text": map[string]string{"tag": "lark_md", "content": strings.Join(lines, "\n")},
		})
	}
	if note := strings.TrimSpace(card.Note); note != "" {
		elements = append(elements, map[string]any{
			"tag":  "div",
			"text": map[string]string{"tag": "lark_md", "content": escapeLarkMarkdown(sanitizeFeishuBlockedText(note))},
		})
	}
	if code := strings.TrimSpace(card.Code); code != "" {
		elements = append(elements,
			map[string]any{"tag": "hr"},
			feishuCodeElement(truncateFeishuCodeBlock(code, 2600)))
	}
	if url := card.detailURL(baseURL); url != "" {
		elements = append(elements, map[string]any{
			"tag":  "div",
			"text": map[string]string{"tag": "lark_md", "content": "[查看详情](" + url + ")"},
		})
	}
	if len(elements) == 0 {
		elements = append(elements, map[string]any{
			"tag":  "div",
			"text": map[string]string{"tag": "lark_md", "content": escapeLarkMarkdown(card.Title)},
		})
	}

	body := map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"config": map[string]any{"wide_screen_mode": true},
			"header": map[string]any{
				"template": template,
				"title":    map[string]string{"tag": "plain_text", "content": card.titlePrefix() + card.Title},
			},
			"elements": elements,
		},
	}
	if strings.TrimSpace(cfg.Secret) != "" {
		sec := time.Now().Unix()
		body["timestamp"] = fmt.Sprintf("%d", sec)
		body["sign"] = feishuSign(sec, cfg.Secret)
	}
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("json marshal: %w", err)
	}
	return postFeishu(cfg.Webhook, data)
}

func buildFeishuCard(message string, level string) map[string]any {
	title, body, codeTitle, codeText := splitFeishuMessage(message)
	title = feishuSafeTitle(title)
	// 调用方显式给了级别就用它（与页面告警色条一致），没给才靠关键词猜——
	// 自定义消息模板里往往没有"告警/异常"这类词，猜不中会落到默认蓝色。
	template := feishuLevelTemplate(level)
	if template == "" {
		template = feishuTemplate(title, body)
	}
	elements := []map[string]any{}

	if strings.TrimSpace(body) != "" {
		elements = append(elements, map[string]any{
			"tag": "div",
			"text": map[string]string{
				"tag":     "lark_md",
				"content": formatFeishuBody(body),
			},
		})
	}
	if strings.TrimSpace(codeText) != "" {
		if codeTitle == "" {
			codeTitle = "诊断输出"
		}
		elements = append(elements,
			map[string]any{"tag": "hr"},
			map[string]any{
				"tag":  "div",
				"text": map[string]string{"tag": "lark_md", "content": "**" + escapeLarkMarkdown(codeTitle) + "**"},
			},
			feishuCodeElement(codeText),
		)
	}
	if len(elements) == 0 {
		elements = append(elements, map[string]any{
			"tag": "div",
			"text": map[string]string{
				"tag":     "lark_md",
				"content": escapeLarkMarkdown(message),
			},
		})
	}

	return map[string]any{
		"config": map[string]any{
			"wide_screen_mode": true,
		},
		"header": map[string]any{
			"template": template,
			"title": map[string]string{
				"tag":     "plain_text",
				"content": title,
			},
		},
		"elements": elements,
	}
}

func feishuSafeTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return "Ops Sentinel 通知"
	}
	if strings.Contains(strings.ToLower(title), "ops sentinel") {
		return title
	}
	return "Ops Sentinel " + title
}

func splitFeishuMessage(message string) (title, body, codeTitle, codeText string) {
	lines := strings.Split(strings.TrimSpace(message), "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[0]) == "" {
		lines = lines[1:]
	}
	if len(lines) == 0 {
		return "Ops Sentinel 通知", "", "", ""
	}
	title = strings.TrimSpace(lines[0])
	rest := strings.Join(lines[1:], "\n")
	markers := []struct {
		label  string
		marker string
	}{
		{label: "诊断输出", marker: "\n诊断输出:\n"},
		{label: "SQL", marker: "\nSQL:\n"},
	}
	for _, item := range markers {
		if parts := strings.SplitN(rest, item.marker, 2); len(parts) == 2 {
			body = strings.TrimSpace(parts[0])
			codeTitle = item.label
			codeText = truncateFeishuCodeBlock(strings.TrimSpace(parts[1]), 2600)
			if title == "" {
				title = "Ops Sentinel 通知"
			}
			return title, body, codeTitle, codeText
		}
	}
	body = strings.TrimSpace(rest)
	if title == "" {
		title = "Ops Sentinel 通知"
	}
	return title, body, "", ""
}

// feishuLevelTemplate 显式级别 → 卡片头色：critical 红 / warning 橙 /
// recovery 绿 / info、test 蓝。对齐页面告警卡的色条语义。
func feishuLevelTemplate(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "critical", "error":
		return "red"
	case "warning", "warn":
		return "orange"
	case "recovery", "recovered", "ok":
		return "green"
	case "info", "test":
		return "blue"
	default:
		return ""
	}
}

func feishuTemplate(title, body string) string {
	titleText := strings.ToLower(title)
	bodyText := strings.ToLower(body)
	switch {
	case strings.Contains(titleText, "恢复"):
		return "green"
	case strings.Contains(titleText, "告警") || strings.Contains(titleText, "异常") || strings.Contains(titleText, "error") || strings.Contains(titleText, "down"):
		return "red"
	case strings.Contains(titleText, "测试"):
		return "blue"
	case strings.Contains(bodyText, "恢复通知") || strings.Contains(bodyText, "已恢复") || strings.Contains(bodyText, "恢复正常"):
		return "green"
	case strings.Contains(bodyText, "告警") || strings.Contains(bodyText, "异常") || strings.Contains(bodyText, "error") || strings.Contains(bodyText, "down"):
		return "red"
	case strings.Contains(bodyText, "测试"):
		return "blue"
	default:
		return "wathet"
	}
}

func formatFeishuBody(body string) string {
	var out []string
	for _, raw := range strings.Split(strings.TrimSpace(body), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			out = append(out, "")
			continue
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			key := strings.TrimSpace(k)
			value := strings.TrimSpace(v)
			if key != "" {
				value = sanitizeFeishuBlockedText(value)
				out = append(out, fmt.Sprintf("**%s**: %s", escapeLarkMarkdown(key), escapeLarkMarkdown(value)))
				continue
			}
		}
		out = append(out, escapeLarkMarkdown(sanitizeFeishuBlockedText(line)))
	}
	return strings.Join(out, "\n")
}

func sanitizeFeishuBlockedText(s string) string {
	return feishuBlockedSleepPattern.ReplaceAllStringFunc(s, func(match string) string {
		idx := strings.LastIndex(match, "(")
		if idx < 0 {
			return match
		}
		return strings.TrimRight(match[:idx], " \t\r\n") + " ("
	})
}

func escapeLarkMarkdown(s string) string {
	replacer := strings.NewReplacer(
		"\\", "\\\\",
		"`", "\\`",
		"*", "\\*",
		"_", "\\_",
		"~", "\\~",
	)
	return replacer.Replace(s)
}

// feishuCodeElement 把日志/SQL/诊断这类原文放进卡片。
// 用 plain_text 而不是 lark_md 的 ``` 围栏：飞书卡片的 lark_md 不渲染围栏代码块，
// 三个反引号会原样显示成 "```text"，而原文里的 * _ ` 又会被当成 markdown，
// 堆栈里的 (*processor) 变成斜体、下划线字段名被吞掉。plain_text 原样呈现并保留换行。
func feishuCodeElement(code string) map[string]any {
	return map[string]any{
		"tag":  "div",
		"text": map[string]string{"tag": "plain_text", "content": strings.TrimSpace(code)},
	}
}

func truncateFeishuCodeBlock(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	return s
}

func feishuSign(timestampSec int64, secret string) string {
	str := fmt.Sprintf("%d\n%s", timestampSec, secret)
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(str))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
