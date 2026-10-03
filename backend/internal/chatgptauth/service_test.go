package chatgptauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testAccountID = "acc-test-1"
const testRefreshToken = "refresh-token-secret"

type mockAuthServer struct {
	mu              sync.Mutex
	devicePolls     int
	refreshCalls    int
	revokeCalls     int
	lastForm        string
	lastRefreshBody string
	accessTokenTTL  time.Duration
	rejectRefresh   bool
	server          *httptest.Server
}

func newMockAuthServer(t *testing.T) *mockAuthServer {
	t.Helper()
	mock := &mockAuthServer{accessTokenTTL: time.Hour}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/accounts/deviceauth/usercode", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]any{
			"device_auth_id": "device-auth-1", "user_code": "ABCD-1234", "interval": "1",
		})
	})
	mux.HandleFunc("/api/accounts/deviceauth/token", func(w http.ResponseWriter, r *http.Request) {
		mock.mu.Lock()
		mock.devicePolls++
		polls := mock.devicePolls
		mock.mu.Unlock()
		if polls < 2 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		writeJSON(t, w, map[string]any{
			"authorization_code": "code-1", "code_challenge": "challenge-1", "code_verifier": "verifier-1",
		})
	})
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		mock.mu.Lock()
		defer mock.mu.Unlock()
		if strings.Contains(r.Header.Get("Content-Type"), "json") {
			mock.lastRefreshBody = string(raw)
			if mock.rejectRefresh {
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(t, w, map[string]any{"error": map[string]any{"code": "refresh_token_expired"}})
				return
			}
			mock.refreshCalls++
			writeJSON(t, w, map[string]any{
				"access_token": mock.accessToken(t, time.Hour), "refresh_token": testRefreshToken,
				"id_token": mock.idToken(t),
			})
			return
		}
		mock.lastForm = string(raw)
		writeJSON(t, w, map[string]any{
			"access_token": mock.accessToken(t, mock.accessTokenTTL), "refresh_token": testRefreshToken,
			"id_token": mock.idToken(t),
		})
	})
	mux.HandleFunc("/oauth/revoke", func(w http.ResponseWriter, r *http.Request) {
		mock.mu.Lock()
		mock.revokeCalls++
		mock.mu.Unlock()
		writeJSON(t, w, map[string]any{"revoked": true})
	})
	mock.server = httptest.NewServer(mux)
	t.Cleanup(mock.server.Close)
	return mock
}

func (m *mockAuthServer) accessToken(t *testing.T, ttl time.Duration) string {
	t.Helper()
	return makeJWT(t, map[string]any{
		authClaimNamespace: map[string]any{"chatgpt_account_id": testAccountID, "chatgpt_plan_type": "plus"},
		"exp":              time.Now().Add(ttl).Unix(),
	})
}

func (m *mockAuthServer) idToken(t *testing.T) string {
	t.Helper()
	return makeJWT(t, map[string]any{
		authClaimNamespace: map[string]any{"chatgpt_account_id": testAccountID, "chatgpt_plan_type": "plus"},
		"email":            "writer@example.com",
	})
}

func makeJWT(t *testing.T, payload map[string]any) string {
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

func writeJSON(t *testing.T, w http.ResponseWriter, payload any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		t.Fatalf("write json: %v", err)
	}
}

func waitForState(t *testing.T, svc *Service, userID, want string) Summary {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		summary := svc.Status(userID)
		if summary.State == want {
			return summary
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("state %q not reached, last=%#v", want, svc.Status(userID))
	return Summary{}
}

func newTestService(t *testing.T, mock *mockAuthServer) (*Service, string) {
	t.Helper()
	dataDir := t.TempDir()
	svc, err := New(Options{DataDir: dataDir, Issuer: mock.server.URL, ClientID: "client-test"})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	return svc, dataDir
}

func TestDeviceLoginStoresEncryptedTokensAndRefreshes(t *testing.T) {
	mock := newMockAuthServer(t)
	svc, dataDir := newTestService(t, mock)

	ctx := context.Background()
	started, err := svc.Start(ctx, "user-1")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if started.State != StatePending || started.UserCode != "ABCD-1234" {
		t.Fatalf("unexpected pending summary: %#v", started)
	}
	if started.VerificationURI != mock.server.URL+"/codex/device" {
		t.Fatalf("unexpected verification uri: %q", started.VerificationURI)
	}

	connected := waitForState(t, svc, "user-1", StateConnected)
	if connected.AccountID != testAccountID || connected.PlanType != "plus" || connected.Email != "writer@example.com" {
		t.Fatalf("unexpected connected summary: %#v", connected)
	}
	if !connected.HasCredential || connected.CredentialRef != CredentialRef {
		t.Fatalf("connected summary must expose the managed credential: %#v", connected)
	}

	// 授权码换取必须使用上游下发的 PKCE verifier 和回调地址。
	mock.mu.Lock()
	form := mock.lastForm
	mock.mu.Unlock()
	parsedForm, err := url.ParseQuery(form)
	if err != nil {
		t.Fatalf("token exchange form is not url-encoded: %v", err)
	}
	if parsedForm.Get("grant_type") != "authorization_code" || parsedForm.Get("code_verifier") != "verifier-1" {
		t.Fatalf("unexpected token exchange form: %q", form)
	}
	if parsedForm.Get("redirect_uri") != mock.server.URL+"/deviceauth/callback" {
		t.Fatalf("token exchange must use the device callback redirect: %q", parsedForm.Get("redirect_uri"))
	}
	if parsedForm.Get("client_id") != "client-test" {
		t.Fatalf("token exchange must send the configured client id: %q", parsedForm.Get("client_id"))
	}

	// 令牌落盘必须是密文，不得出现明文 refresh token。
	raw, err := os.ReadFile(filepath.Join(dataDir, connectionStoreFile))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if strings.Contains(string(raw), testRefreshToken) {
		t.Fatalf("refresh token must not be stored in plaintext: %s", raw)
	}
	if !strings.Contains(string(raw), encryptedSecretPrefix) {
		t.Fatalf("store must contain encrypted secrets: %s", raw)
	}

	credential, err := svc.AccessToken(ctx, "user-1")
	if err != nil {
		t.Fatalf("access token: %v", err)
	}
	if credential.AccountID != testAccountID || credential.AccessToken == "" {
		t.Fatalf("unexpected credential: %#v", credential)
	}
	mock.mu.Lock()
	refreshCalls := mock.refreshCalls
	mock.mu.Unlock()
	if refreshCalls != 0 {
		t.Fatalf("valid access token must not trigger a refresh, calls=%d", refreshCalls)
	}

	// 凭据必须按用户隔离。
	if svc.HasCredential("user-2") {
		t.Fatal("credentials must be isolated per user")
	}
	if _, err := svc.AccessToken(ctx, "user-2"); err == nil {
		t.Fatal("unknown user must not receive a credential")
	}
}

func TestAccessTokenRefreshesNearExpiry(t *testing.T) {
	mock := newMockAuthServer(t)
	mock.accessTokenTTL = time.Minute
	svc, _ := newTestService(t, mock)

	ctx := context.Background()
	if _, err := svc.Start(ctx, "user-1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitForState(t, svc, "user-1", StateConnected)

	// access_token 只剩 1 分钟，落在 5 分钟刷新窗口内，必须触发刷新。
	if _, err := svc.AccessToken(ctx, "user-1"); err != nil {
		t.Fatalf("access token: %v", err)
	}
	mock.mu.Lock()
	refreshCalls := mock.refreshCalls
	refreshBody := mock.lastRefreshBody
	mock.mu.Unlock()
	if refreshCalls != 1 {
		t.Fatalf("expected exactly one refresh, got %d", refreshCalls)
	}
	var refreshPayload map[string]string
	if err := json.Unmarshal([]byte(refreshBody), &refreshPayload); err != nil {
		t.Fatalf("refresh body must be JSON: %v (%q)", err, refreshBody)
	}
	if refreshPayload["grant_type"] != "refresh_token" || refreshPayload["refresh_token"] != testRefreshToken {
		t.Fatalf("unexpected refresh payload: %#v", refreshPayload)
	}
	if refreshPayload["scope"] != "" || refreshPayload["redirect_uri"] != "" {
		t.Fatalf("refresh must not send scope or redirect_uri: %#v", refreshPayload)
	}
}

func TestRefreshRejectionRevokesUser(t *testing.T) {
	mock := newMockAuthServer(t)
	// 登录下发的 access_token 立即过期，确保 AccessToken 一定走刷新分支。
	mock.accessTokenTTL = -time.Hour
	svc, _ := newTestService(t, mock)

	ctx := context.Background()
	if _, err := svc.Start(ctx, "user-1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitForState(t, svc, "user-1", StateConnected)

	// 让上游用 400 + refresh_token_expired 永久拒绝刷新。
	mock.mu.Lock()
	mock.rejectRefresh = true
	mock.mu.Unlock()

	if _, err := svc.AccessToken(ctx, "user-1"); err == nil {
		t.Fatal("expected refresh rejection error")
	}
	if state := svc.Status("user-1").State; state != StateRevoked {
		t.Fatalf("expected revoked state, got %q", state)
	}
	if svc.HasCredential("user-1") {
		t.Fatal("revoked user must not keep a credential")
	}
}

func TestDisconnectRevokesAndClears(t *testing.T) {
	mock := newMockAuthServer(t)
	svc, _ := newTestService(t, mock)

	ctx := context.Background()
	if _, err := svc.Start(ctx, "user-1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitForState(t, svc, "user-1", StateConnected)

	summary, err := svc.Disconnect(ctx, "user-1")
	if err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if summary.State != StateDisconnected || summary.HasCredential {
		t.Fatalf("unexpected disconnect summary: %#v", summary)
	}
	mock.mu.Lock()
	revoked := mock.revokeCalls
	mock.mu.Unlock()
	if revoked != 1 {
		t.Fatalf("expected upstream revoke, got %d", revoked)
	}
	if _, err := svc.AccessToken(ctx, "user-1"); err == nil {
		t.Fatal("disconnected user must not receive a credential")
	}
}

func TestCanonicalIssuerRejectsArbitraryHosts(t *testing.T) {
	origin, err := CanonicalIssuer("")
	if err != nil || origin != ProductionIssuer {
		t.Fatalf("default issuer must be production, got %q err=%v", origin, err)
	}
	if _, err := CanonicalIssuer("https://evil.example.com"); err == nil {
		t.Fatal("arbitrary issuer must be rejected")
	}
	if _, err := CanonicalIssuer("http://localhost:18123"); err != nil {
		t.Fatalf("loopback test issuer must be allowed: %v", err)
	}
}
