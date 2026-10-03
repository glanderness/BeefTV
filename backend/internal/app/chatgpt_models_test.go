package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/chatgptauth"
)

// catalogProbe 记录假上游收到的最后一次请求。handler 运行在服务端 goroutine，
// 因此读写都用锁保护。
type catalogProbe struct {
	mu      sync.Mutex
	path    string
	headers http.Header
}

func (p *catalogProbe) record(r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.path = r.URL.RequestURI()
	p.headers = r.Header.Clone()
}

func (p *catalogProbe) snapshot() (string, http.Header) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.path, p.headers
}

// newSubscriptionCatalogServer 返回一个 Codex catalog 形状的假上游。
func newSubscriptionCatalogServer(t *testing.T) (*httptest.Server, *catalogProbe) {
	t.Helper()
	// 允许本机测试源通过出网校验；生产默认仍然拒绝私网。
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	probe := &catalogProbe{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probe.record(r)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"models": []map[string]any{
				{"slug": "gpt-5-codex", "display_name": "GPT-5 Codex", "supported_in_api": true},
				{"slug": "internal-shadow", "display_name": "Internal Shadow", "supported_in_api": false},
			},
		})
	}))
	t.Cleanup(server.Close)
	return server, probe
}

func TestFetchChatGPTSubscriptionModelCatalogUsesCodexShape(t *testing.T) {
	server, _ := newSubscriptionCatalogServer(t)
	items, err := fetchChatGPTSubscriptionModelCatalog(context.Background(), ChannelModelsRequest{
		BaseURL: server.URL, APIKey: "access-token", ChatGPTAccountID: "acc-1",
	})
	if err != nil {
		t.Fatalf("fetch catalog: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("supported_in_api=false must be filtered out, got %#v", items)
	}
	if items[0].ID != "gpt-5-codex" || items[0].DisplayName != "GPT-5 Codex" {
		t.Fatalf("slug/display_name must map to id/displayName: %#v", items[0])
	}
	if items[0].ModelType != "text" {
		t.Fatalf("subscription models must be classified as text: %#v", items[0])
	}
}

func TestFetchChatGPTSubscriptionModelCatalogSendsCodexRequest(t *testing.T) {
	server, probe := newSubscriptionCatalogServer(t)
	if _, err := fetchChatGPTSubscriptionModelCatalog(context.Background(), ChannelModelsRequest{
		BaseURL: server.URL, APIKey: "access-token", ChatGPTAccountID: "acc-1",
	}); err != nil {
		t.Fatalf("fetch catalog: %v", err)
	}
	path, headers := probe.snapshot()
	if headers == nil {
		t.Fatal("catalog request was not captured")
	}
	if got := headers.Get("Authorization"); got != "Bearer access-token" {
		t.Fatalf("unexpected authorization: %q", got)
	}
	if got := headers.Get("chatgpt-account-id"); got != "acc-1" {
		t.Fatalf("account header must be sent: %q", got)
	}
	if got := headers.Get("originator"); got != "codex_cli_rs" {
		t.Fatalf("originator header must be sent: %q", got)
	}
	// Codex catalog 是 /models?client_version=<ver>，不是 OpenAI 的 /v1/models。
	if !strings.HasPrefix(path, "/models?client_version=") {
		t.Fatalf("catalog must be fetched from /models with client_version: %q", path)
	}
}

func TestChatGPTClientVersionIsPlainSemver(t *testing.T) {
	// 上游对 client_version 校验很严：带 "v" 前缀会返回 400 Invalid client_version format。
	got := chatGPTClientVersion()
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(got) {
		t.Fatalf("client_version must be plain major.minor.patch, got %q", got)
	}
	if strings.HasPrefix(got, "v") {
		t.Fatalf("client_version must not carry a v prefix, got %q", got)
	}
}

func TestResolveChatGPTModelsCredentialGuards(t *testing.T) {
	service := &Service{}
	plain := ChannelModelsRequest{APIKey: "sk-plain", BaseURL: "https://api.example.com/v1"}
	if err := service.resolveChatGPTModelsCredential(context.Background(), "user-1", &plain); err != nil {
		t.Fatalf("plain channel must be skipped: %v", err)
	}
	if plain.APIKey != "sk-plain" || plain.BaseURL != "https://api.example.com/v1" {
		t.Fatal("plain channel request must not be rewritten")
	}

	subscription := ChannelModelsRequest{CredentialRef: chatgptauth.CredentialRef}
	if err := service.resolveChatGPTModelsCredential(context.Background(), "user-1", &subscription); err == nil {
		t.Fatal("uninitialized subscription service must fail closed")
	}
}
