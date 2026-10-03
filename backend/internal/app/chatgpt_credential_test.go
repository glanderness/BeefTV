package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infinite-canvas/backend/internal/chatgptauth"
	"infinite-canvas/backend/internal/protocol"
)

func TestApplyProviderAuthInjectsSubscriptionHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://chatgpt.com/backend-api/codex/responses", nil)
	applyProviderAuth(req, providerConfig{
		APIFormat: "openai", APIKey: "access-token-1",
		CredentialRef: chatgptauth.CredentialRef, ChatGPTAccountID: "acc-1",
	})
	if got := req.Header.Get("Authorization"); got != "Bearer access-token-1" {
		t.Fatalf("unexpected authorization header: %q", got)
	}
	if got := req.Header.Get("chatgpt-account-id"); got != "acc-1" {
		t.Fatalf("account id header must be injected: %q", got)
	}
	if got := req.Header.Get("originator"); got != "codex_cli_rs" {
		t.Fatalf("originator header must be injected: %q", got)
	}
	if req.Header.Get("X-OpenAI-Fedramp") != "" {
		t.Fatal("fedramp header must be omitted for non-fedramp accounts")
	}
}

func TestApplyProviderAuthAddsFedrampHeaderWhenRequired(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://chatgpt.com/backend-api/codex/responses", nil)
	applyProviderAuth(req, providerConfig{
		APIFormat: "openai", APIKey: "access-token-1",
		CredentialRef: chatgptauth.CredentialRef, ChatGPTAccountID: "acc-1", ChatGPTFedRAMP: true,
	})
	if req.Header.Get("X-OpenAI-Fedramp") != "true" {
		t.Fatal("fedramp accounts must send the residency header")
	}
}

func TestApplyProviderAuthLeavesPlainChannelsUntouched(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "https://api.example.com/v1/responses", nil)
	applyProviderAuth(req, providerConfig{APIFormat: "openai", APIKey: "sk-plain"})
	if req.Header.Get("chatgpt-account-id") != "" || req.Header.Get("originator") != "" {
		t.Fatal("plain channels must not receive ChatGPT subscription headers")
	}
}

func TestApplyProtocolAuthSupportsChatGPTOAuthDriver(t *testing.T) {
	auth := protocol.ManifestAuth{Type: "chatgpt-oauth", Field: "apiKey"}
	req := httptest.NewRequest(http.MethodPost, "https://chatgpt.com/backend-api/codex/responses", nil)
	if err := applyProtocolAuth(req, providerConfig{
		APIKey: "access-token-2", CredentialRef: chatgptauth.CredentialRef, ChatGPTAccountID: "acc-9",
	}, auth); err != nil {
		t.Fatalf("apply protocol auth: %v", err)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer access-token-2" {
		t.Fatalf("unexpected authorization header: %q", got)
	}
	if got := req.Header.Get("chatgpt-account-id"); got != "acc-9" {
		t.Fatalf("account id header must be injected: %q", got)
	}

	// 缺少凭据时必须失败，不能发出未鉴权请求。
	bare := httptest.NewRequest(http.MethodPost, "https://chatgpt.com/backend-api/codex/responses", nil)
	if err := applyProtocolAuth(bare, providerConfig{CredentialRef: chatgptauth.CredentialRef}, auth); err == nil {
		t.Fatal("missing subscription credential must be rejected")
	}
}

func TestResolveChatGPTSubscriptionCredentialGuards(t *testing.T) {
	service := &Service{}
	plain := providerConfig{APIKey: "sk-plain"}
	if err := service.resolveChatGPTSubscriptionCredential(context.Background(), "user-1", &plain); err != nil {
		t.Fatalf("plain channel must be skipped: %v", err)
	}
	if plain.APIKey != "sk-plain" {
		t.Fatal("plain channel credential must not be rewritten")
	}

	managed := providerConfig{CredentialRef: chatgptauth.CredentialRef}
	if err := service.resolveChatGPTSubscriptionCredential(context.Background(), "user-1", &managed); err == nil {
		t.Fatal("uninitialized subscription service must fail closed")
	}

	initialized := &Service{chatGPTAuth: newStubAuth(t)}
	if err := initialized.resolveChatGPTSubscriptionCredential(context.Background(), "", &providerConfig{CredentialRef: chatgptauth.CredentialRef}); err == nil {
		t.Fatal("missing user id must fail")
	}
	// 未连接的用户属于凭据错误，必须投影为 4xx 让用户重新连接，而不是 5xx。
	err := initialized.resolveChatGPTSubscriptionCredential(context.Background(), "missing-user", &providerConfig{CredentialRef: chatgptauth.CredentialRef})
	if err == nil {
		t.Fatal("unknown user must not receive a credential")
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusBadRequest {
		t.Fatalf("missing credential must surface as a bad-request error, got %#v", err)
	}
}

// TestResolveChatGPTSubscriptionCredentialInjectsAccessToken 验证完整链路：
// 设备码登录落盘 → 执行期解析 → access_token 与账号 id 进入内存配置。
func TestResolveChatGPTSubscriptionCredentialInjectsAccessToken(t *testing.T) {
	server := newStubAuthServer(t)
	auth, err := chatgptauth.New(chatgptauth.Options{DataDir: t.TempDir(), Issuer: server.URL, ClientID: "client-test"})
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	t.Cleanup(func() { _ = auth.Close() })

	ctx := context.Background()
	if _, err := auth.Start(ctx, "user-1"); err != nil {
		t.Fatalf("start login: %v", err)
	}
	waitForAuthState(t, auth, "user-1", chatgptauth.StateConnected)

	service := &Service{chatGPTAuth: auth}
	config := providerConfig{
		CredentialRef: chatgptauth.CredentialRef,
		InterfaceType: "chatgpt-subscription",
		BaseURL:       "https://chatgpt.com/backend-api/codex",
	}
	if err := service.resolveChatGPTSubscriptionCredential(ctx, "user-1", &config); err != nil {
		t.Fatalf("resolve credential: %v", err)
	}
	if config.APIKey == "" {
		t.Fatal("access token must be injected into the resolved config")
	}
	if config.ChatGPTAccountID != "acc-stub" {
		t.Fatalf("account id must be injected, got %q", config.ChatGPTAccountID)
	}

	// 解析结果只存在于内存配置里，凭据引用保持不变。
	if config.CredentialRef != chatgptauth.CredentialRef {
		t.Fatal("credential ref must be preserved")
	}
}

func newStubAuth(t *testing.T) *chatgptauth.Service {
	t.Helper()
	auth, err := chatgptauth.New(chatgptauth.Options{DataDir: t.TempDir(), Issuer: newStubAuthServer(t).URL, ClientID: "client-test"})
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	t.Cleanup(func() { _ = auth.Close() })
	return auth
}

func newStubAuthServer(t *testing.T) *httptest.Server {
	t.Helper()
	polls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/accounts/deviceauth/usercode", func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(t, w, map[string]any{"device_auth_id": "d-1", "user_code": "CODE-1", "interval": "1"})
	})
	mux.HandleFunc("/api/accounts/deviceauth/token", func(w http.ResponseWriter, r *http.Request) {
		polls++
		if polls < 2 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		writeStubJSON(t, w, map[string]any{"authorization_code": "c-1", "code_verifier": "v-1"})
	})
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		writeStubJSON(t, w, map[string]any{
			"access_token":  stubJWT(t, map[string]any{"exp": time.Now().Add(time.Hour).Unix()}),
			"refresh_token": "refresh-1",
			"id_token": stubJWT(t, map[string]any{
				"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acc-stub", "chatgpt_plan_type": "plus"},
			}),
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func stubJWT(t *testing.T, payload map[string]any) string {
	t.Helper()
	encode := func(value any) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal jwt segment: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	return encode(map[string]any{"alg": "none"}) + "." + encode(payload) + ".sig"
}

func writeStubJSON(t *testing.T, w http.ResponseWriter, payload any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		t.Fatalf("write json: %v", err)
	}
}

func waitForAuthState(t *testing.T, auth *chatgptauth.Service, userID, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if auth.Status(userID).State == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("auth state %q not reached, last=%#v", want, auth.Status(userID))
}
