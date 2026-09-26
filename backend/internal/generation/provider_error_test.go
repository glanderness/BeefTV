package generation_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
)

func TestClassifyHTTPUsesStructuredCodeBeforeStatus(t *testing.T) {
	failure := generation.ClassifyHTTP(http.StatusPaymentRequired, "402 Payment Required", `{"error":{"message":"Your prompt or reference image was blocked by the content safety policy. Please adjust your prompt or reference image and try again.","code":"content_policy_violation"}}`)
	if failure.Category != generation.CategoryModerationInput && failure.Category != generation.CategoryModerationReference {
		t.Fatalf("402 with safety body category = %s", failure.Category)
	}
	if !strings.Contains(failure.UserMessage(), "内容安全审核") {
		t.Fatalf("user message = %q", failure.UserMessage())
	}
}

func TestClassifyHTTP402WithoutBodyIsUnknownBilling(t *testing.T) {
	failure := generation.ClassifyHTTP(http.StatusPaymentRequired, "402 Payment Required", "")
	if failure.Category != generation.CategoryQuotaUnknown {
		t.Fatalf("category = %s", failure.Category)
	}
	message := failure.UserMessage()
	if strings.Contains(message, "余额") || strings.Contains(message, "退还") || strings.Contains(message, "积分") {
		t.Fatalf("402 assumed user balance: %q", message)
	}
	if !strings.Contains(message, "计费或额度") {
		t.Fatalf("user message = %q", message)
	}
}

func TestClassifyHTTP451AloneIsNotSafety(t *testing.T) {
	failure := generation.ClassifyHTTP(451, "451 Unavailable For Legal Reasons", "")
	if failure.IsModeration() {
		t.Fatalf("bare 451 classified as moderation: %+v", failure)
	}
}

func TestClassifyHTTP451SafetyBody(t *testing.T) {
	body := "Your prompt or reference image was blocked by the content safety policy. Please adjust your prompt or reference image and try again."
	failure := generation.ClassifyHTTP(451, "451 Unavailable For Legal Reasons", body)
	if !failure.IsModeration() {
		t.Fatalf("451 safety body category = %s", failure.Category)
	}
	if !strings.Contains(failure.UserMessage(), "请修改提示词或参考图") && !strings.Contains(failure.UserMessage(), "请更换参考图") {
		t.Fatalf("user message = %q", failure.UserMessage())
	}
}

func TestClassifyHTTP429QuotaVersusRate(t *testing.T) {
	quota := generation.ClassifyHTTP(429, "429 Too Many Requests", `{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}`)
	if quota.Category != generation.CategoryQuotaUnknown {
		t.Fatalf("quota 429 category = %s", quota.Category)
	}
	rate := generation.ClassifyHTTP(429, "429 Too Many Requests", `{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached"}}`)
	if rate.Category != generation.CategoryThrottled {
		t.Fatalf("rate 429 category = %s", rate.Category)
	}
	bare := generation.ClassifyHTTP(429, "429 Too Many Requests", "")
	if bare.Category != generation.CategoryThrottled {
		t.Fatalf("bare 429 category = %s", bare.Category)
	}
}

func TestClassifyProviderJSONShapes(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		body     string
		category generation.FailureCategory
		contains string
	}{
		{name: "openai", status: 400, body: `{"error":{"message":"Invalid size","type":"invalid_request_error","param":"size","code":"invalid_request"},"request_id":"req_abc123"}`, category: generation.CategoryInvalidParams, contains: "参数"},
		{name: "gemini", status: 400, body: `{"error":{"code":400,"message":"API key not valid","status":"UNAUTHENTICATED"}}`, category: generation.CategoryAuth, contains: "鉴权"},
		{name: "dashscope", status: 400, body: `{"code":"InvalidParameter","message":"url error, please check url！","request_id":"req-dash-1"}`, category: generation.CategoryInputInaccessible, contains: "参考素材无法读取"},
		{name: "newapi", status: 200, body: `{"code":"RequestParameterIsWrong","data":null,"msg":"参数: prompt 的长度: 23142 大于最大长度 10000"}`, category: generation.CategoryContextTooLong, contains: "长度限制"},
		{name: "gemini-feedback", status: 200, body: `{"promptFeedback":{"blockReason":"SAFETY"}}`, category: generation.CategoryModerationInput, contains: "内容安全审核"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			failure := generation.ClassifyHTTP(tt.status, "", tt.body)
			if failure.Category != tt.category {
				t.Fatalf("category = %s want %s message=%q", failure.Category, tt.category, failure.UserMessage())
			}
			if !strings.Contains(failure.UserMessage(), tt.contains) {
				t.Fatalf("message = %q want %q", failure.UserMessage(), tt.contains)
			}
		})
	}
}

func TestClassifyDoesNotLeakSecretsOrRawPayload(t *testing.T) {
	body := `{"error":{"message":"blocked by content policy prompt=secret-words api-key=sk-live-secret https://cdn.example.com/file?signature=abc","code":"content_policy_violation"},"request_id":"secret-trace"}`
	message := generation.ClassifyHTTP(400, "", body).UserMessage()
	for _, leaked := range []string{"sk-live-secret", "api-key", "secret-words", "https://cdn.example.com", "signature=", "secret-trace", `{"error"`} {
		if strings.Contains(message, leaked) {
			t.Fatalf("leaked %q in %q", leaked, message)
		}
	}
}

func TestClassifyDoesNotTreatRequestIDNumbersAsHTTP(t *testing.T) {
	failure := generation.ClassifyText(`{"error":{"message":"task 402 failed internally","code":"internal_error"},"request_id":"402"}`)
	if failure.Category == generation.CategoryQuotaUnknown {
		t.Fatalf("request id 402 became billing: %+v", failure)
	}
}

func TestClassifyUnknownFieldsStayUnknown(t *testing.T) {
	failure := generation.ClassifyHTTP(400, "", `{"error":{"mystery":true,"trace":"private"}}`)
	if failure.Category != generation.CategoryInvalidParams {
		t.Fatalf("400 unknown json category = %s", failure.Category)
	}
	if strings.Contains(failure.UserMessage(), "private") || strings.Contains(failure.UserMessage(), "mystery") {
		t.Fatalf("unknown fields leaked: %q", failure.UserMessage())
	}
}

func TestClassifyNonJSONAndHTML(t *testing.T) {
	htmlFailure := generation.ClassifyHTTP(502, "502 Bad Gateway", "<!DOCTYPE html><html><body>nginx 502</body></html>")
	if htmlFailure.Category != generation.CategoryProviderUnavailable {
		t.Fatalf("html 502 category = %s", htmlFailure.Category)
	}
	if strings.Contains(htmlFailure.UserMessage(), "nginx") || strings.Contains(htmlFailure.UserMessage(), "<html") {
		t.Fatalf("html leaked: %q", htmlFailure.UserMessage())
	}
	malformed := generation.ClassifyText("接口返回非 JSON 内容：text/html")
	if malformed.Category != generation.CategoryMalformedResponse {
		t.Fatalf("malformed category = %s", malformed.Category)
	}
}

func TestClassifyWrappedAndDownloadErrors(t *testing.T) {
	httpErr := generation.HTTPError{StatusCode: 502, Status: "502 Bad Gateway", Body: "Bad Gateway"}
	wrapped := generation.ClassifyError(wrapError("视频任务创建失败", httpErr))
	if wrapped.Category != generation.CategoryProviderUnavailable {
		t.Fatalf("wrapped 502 category = %s message=%q", wrapped.Category, wrapped.UserMessage())
	}
	download := generation.WithDownloadFailure(generation.ClassifyHTTP(502, "", ""), "provider-task-1")
	if download.Category != generation.CategoryDownloadFailed {
		t.Fatalf("download category = %s", download.Category)
	}
	if !download.BlocksAutomaticRetry() {
		t.Fatal("download should block automatic retry")
	}
}

type wrappedError struct {
	prefix string
	err    error
}

func wrapError(prefix string, err error) error {
	return wrappedError{prefix: prefix, err: err}
}

func (e wrappedError) Error() string { return e.prefix + "：" + e.err.Error() }
func (e wrappedError) Unwrap() error { return e.err }

func TestClassifyPendingAndCancel(t *testing.T) {
	pending := generation.ClassifyError(generation.StatePendingError{TaskID: "task-safe-1", Cause: generation.HTTPError{StatusCode: 400, Body: `{"code":"task_not_exist"}`}})
	if pending.Category != generation.CategorySubmissionUncertain {
		t.Fatalf("pending category = %s", pending.Category)
	}
	if !pending.BlocksAutomaticRetry() {
		t.Fatal("pending should block automatic retry")
	}
	if errors.Is(context.Canceled, context.Canceled) {
		canceled := generation.ClassifyError(context.Canceled)
		if canceled.Category != generation.CategoryCancelled {
			t.Fatalf("cancel category = %s", canceled.Category)
		}
	}
}

func TestClassify2xxBusinessError(t *testing.T) {
	failure := generation.ClassifyText(`{"code":"sensitive_words_detected","message":"prompt rejected"}`)
	if failure.Category != generation.CategoryModerationInput {
		t.Fatalf("2xx moderation category = %s", failure.Category)
	}
}

func TestHTTPErrorErrorUsesBody(t *testing.T) {
	message := (generation.HTTPError{StatusCode: 451, Body: "Your prompt or reference image was blocked by the content safety policy."}).Error()
	if !strings.Contains(message, "内容安全审核") {
		t.Fatalf("HTTPError.Error() = %q", message)
	}
	generic := (generation.HTTPError{StatusCode: http.StatusPaymentRequired, Body: ""}).Error()
	if !strings.Contains(generic, "计费或额度") {
		t.Fatalf("402 HTTPError.Error() = %q", generic)
	}
}

func TestLikenessCodeNotPromptWording(t *testing.T) {
	echoed := generation.ClassifyText(`{"error":{"message":"invalid parameter: prompt=生成油画肖像"}}`)
	if echoed.Category != generation.CategoryInvalidParams {
		t.Fatalf("echoed portrait category = %s", echoed.Category)
	}
	if strings.Contains(echoed.UserMessage(), "真人形象") {
		t.Fatalf("echoed portrait became likeness: %q", echoed.UserMessage())
	}
	coded := generation.ClassifyText(`{"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"blocked by content policy"}}`)
	if !strings.Contains(coded.UserMessage(), "真人形象") {
		t.Fatalf("privacy code message = %q", coded.UserMessage())
	}
}

func TestThinkingModeToolChoice(t *testing.T) {
	failure := generation.ClassifyHTTP(400, "", `{"error":{"message":"Thinking mode does not support this tool_choice","request_id":"req_think1"}}`)
	if !strings.Contains(failure.UserMessage(), "不支持强制工具调用") {
		t.Fatalf("message = %q", failure.UserMessage())
	}
}
