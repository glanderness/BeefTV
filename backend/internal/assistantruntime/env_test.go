package assistantruntime

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/chatgptauth"
)

func TestHostAPIMapsSubscriptionToResponses(t *testing.T) {
	if got := hostAPI(chatgptauth.CredentialRef); got != "openai-responses" {
		t.Fatalf("订阅协议必须走 pi 的 openai-responses 回路，got %q", got)
	}
}

func TestHostBaseURLKeepsCodexPathWithoutV1(t *testing.T) {
	// Codex 端点是 {base}/responses，追加 /v1 会打到不存在的路径。
	if got := hostBaseURL("https://chatgpt.com/backend-api/codex", chatgptauth.CredentialRef); got != "https://chatgpt.com/backend-api/codex" {
		t.Fatalf("订阅基址不应追加 /v1，got %q", got)
	}
	// 普通 OpenAI 兼容渠道的既有约定不变。
	if got := hostBaseURL("https://api.example.com", "responses"); got != "https://api.example.com/v1" {
		t.Fatalf("普通 Responses 渠道仍应补 /v1，got %q", got)
	}
}

func TestBuildEnvCarriesSubscriptionHeaders(t *testing.T) {
	host := New(Options{DataDir: t.TempDir()})
	env := host.buildEnv(assistant.Provider{
		Model: "gpt-6-sol", Protocol: chatgptauth.CredentialRef,
		BaseURL: "https://chatgpt.com/backend-api/codex", APIKey: "synthetic",
		Headers: map[string]string{"chatgpt-account-id": "acct-1", "originator": "codex_cli_rs"},
	}, childPin{})
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "BEEFTV_AGENT_API=openai-responses") {
		t.Fatalf("api env 未映射：%s", joined)
	}
	if !strings.Contains(joined, "BEEFTV_AGENT_BASE_URL=https://chatgpt.com/backend-api/codex") {
		t.Fatalf("base url env 被改写：%s", joined)
	}
	if !strings.Contains(joined, "BEEFTV_AGENT_HEADERS=") || !strings.Contains(joined, "acct-1") {
		t.Fatalf("账号头未传给 agent-host：%s", joined)
	}
}

func TestBuildEnvSkipsHeaderEnvWithoutHeaders(t *testing.T) {
	host := New(Options{DataDir: t.TempDir()})
	joined := strings.Join(host.buildEnv(assistant.Provider{
		Model: "deepseek-flash", Protocol: "chat-completion",
		BaseURL: "https://api.deepseek.com", APIKey: "synthetic",
	}, childPin{}), "\n")
	if !strings.Contains(joined, "BEEFTV_AGENT_HEADERS=\n") && !strings.HasSuffix(joined, "BEEFTV_AGENT_HEADERS=") {
		t.Fatalf("无额外请求头时必须下发空值：%s", joined)
	}
}
