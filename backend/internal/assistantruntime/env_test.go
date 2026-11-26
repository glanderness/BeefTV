package assistantruntime

import (
	"runtime"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/outbound"
)

func (h *Host) buildEnv(provider assistant.Provider, pin childPin) []string {
	env, _ := h.buildEnvWithProxyFingerprint(provider, pin)
	return env
}

// envValue 按系统规则读环境变量。Windows 的变量名不分大小写，启动子进程时
// NO_PROXY 和 no_proxy 会合成一条，只留后写的那个写法；按名字精确匹配会读不到。
// 同名多条时取最后一条，和系统一致。
func envValue(env []string, key string) string {
	got := ""
	for _, entry := range env {
		if name, value, ok := strings.Cut(entry, "="); ok && sameEnvName(name, key) {
			got = value
		}
	}
	return got
}

func envHasKey(env []string, key string) bool {
	for _, entry := range env {
		if name, _, ok := strings.Cut(entry, "="); ok && sameEnvName(name, key) {
			return true
		}
	}
	return false
}

func sameEnvName(name, key string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(name, key)
	}
	return name == key
}

func TestHostEnvGeminiProtocolMapping(t *testing.T) {
	if got := hostAPI("gemini-generate-content"); got != "google-generative-ai" {
		t.Fatalf("hostAPI(gemini-generate-content) = %q, want google-generative-ai", got)
	}
	if got := hostAPI("google-gemini-generate-content"); got != "google-generative-ai" {
		t.Fatalf("hostAPI(google-gemini-generate-content) = %q, want google-generative-ai", got)
	}
	cases := []struct {
		raw  string
		want string
	}{
		{"https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"},
		{"https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta"},
		{"https://gateway.example.com/v1", "https://gateway.example.com/v1beta"},
		{"https://gateway.example.com#", "https://gateway.example.com"},
	}
	for _, tc := range cases {
		for _, proto := range []string{"gemini-generate-content", "google-gemini-generate-content"} {
			if got := hostBaseURL(tc.raw, proto); got != tc.want {
				t.Fatalf("hostBaseURL(%q, %q) = %q, want %q", tc.raw, proto, got, tc.want)
			}
		}
	}
}

func TestHostEnvBYOKProtocolAliasesAndHeaders(t *testing.T) {
	aliasExpectations := map[string]string{
		"claude-api":                     "anthropic-messages",
		"anthropic-messages":             "anthropic-messages",
		"claude-messages":                "anthropic-messages",
		"responses":                      "openai-responses",
		"openai-response":                "openai-responses",
		"openai-responses":               "openai-responses",
		"gemini-generate-content":        "google-generative-ai",
		"google-gemini-generate-content": "google-generative-ai",
		"chat-completion":                "openai-completions",
	}
	for proto, want := range aliasExpectations {
		if got := hostAPI(proto); got != want {
			t.Fatalf("hostAPI(%q) = %q, want %q", proto, got, want)
		}
	}
	if got := hostBaseURL("https://relay.example.com/v1", "anthropic-messages"); got != "https://relay.example.com" {
		t.Fatalf("anthropic-messages baseURL = %q, want stripped /v1", got)
	}
	if got := hostBaseURL("https://relay.example.com/custom#", "anthropic-messages"); got != "https://relay.example.com/custom#" {
		t.Fatalf("anthropic-messages raw baseURL = %q, want preserved #", got)
	}
	if got := hostBaseURL("https://generativelanguage.googleapis.com/v1beta/models", "gemini-generate-content"); got != "https://generativelanguage.googleapis.com/v1beta" {
		t.Fatalf("gemini /v1beta/models baseURL = %q, want /v1beta", got)
	}
	for _, proto := range []string{"responses", "openai-response", "openai-responses"} {
		if got := hostBaseURL("https://relay.example.com/v1/responses", proto); got != "https://relay.example.com/v1" {
			t.Fatalf("hostBaseURL(responses, %q) = %q, want https://relay.example.com/v1", proto, got)
		}
	}

	h := New(Options{
		DataDir: t.TempDir(),
		Environ: func() []string {
			return []string{"BEEFTV_AGENT_HEADERS=[{\"name\":\"X-Injected\",\"value\":\"bad\"}]"}
		},
	})
	baseProvider := assistant.Provider{
		ChannelID: "byok-claude",
		Model:     "claude-sonnet-4-6",
		Protocol:  "claude-api",
		BaseURL:   "https://relay.example.com",
		APIKey:    "sk-test",
	}
	withHeaders := baseProvider
	withHeaders.Headers = []outbound.OutboundHeader{{Name: "X-Tenant", Value: "studio-a"}}
	if baseProvider.Fingerprint() == withHeaders.Fingerprint() {
		t.Fatalf("Provider.Fingerprint must change when custom headers change")
	}

	envWithout := h.buildEnv(baseProvider, childPin{Port: 18099})
	if got := envValue(envWithout, "BEEFTV_AGENT_HEADERS"); got != "" {
		t.Fatalf("inherited BEEFTV_AGENT_HEADERS must be cleared, got %q", got)
	}
	envWith := h.buildEnv(withHeaders, childPin{Port: 18099})
	if got := envValue(envWith, "BEEFTV_AGENT_HEADERS"); !strings.Contains(got, `"X-Tenant"`) || !strings.Contains(got, `"studio-a"`) {
		t.Fatalf("expected BEEFTV_AGENT_HEADERS to carry normalized header, got %q", got)
	}
}
