package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
)

func lifecycleRequest(router http.Handler, method, path, owner, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, "http://127.0.0.1:18090"+path, reader)
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	if owner != "" {
		request.Header.Set("X-Beeftv-Owner", owner)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestHostConfigResponseOmitsProviderSecret(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	svc := app.NewLocal(nil, dataDir)
	owner, err := agentops.EnsureOwnerToken(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_AGENT_API_KEY", "secret-key")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://example.invalid/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "MiniMax-M3")
	t.Setenv("BEEFTV_AGENT_PROTOCOL", "chat-completion")

	host := assistantruntime.New(assistantruntime.OptionsFromService(svc))
	router := gin.New()
	RegisterAgentHostLifecycleRoutes(router.Group("/api"), svc, host)

	recorder := lifecycleRequest(router, http.MethodGet, "/api/assistant/host/config", owner, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "secret-key") {
		t.Fatalf("config 响应不得包含模型密钥: %s", recorder.Body.String())
	}
	var envelope struct {
		Data struct {
			Provider struct {
				Model  string `json:"model"`
				HasKey bool   `json:"hasKey"`
			} `json:"provider"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Provider.Model != "MiniMax-M3" || !envelope.Data.Provider.HasKey {
		t.Fatalf("应公开模型与 hasKey，得到 %#v", envelope.Data.Provider)
	}
}

func TestHostStartWithoutCommandReturnsMissingReason(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	svc := app.NewLocal(nil, dataDir)
	owner, err := agentops.EnsureOwnerToken(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEEFTV_AGENT_API_KEY", "k")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://example.invalid/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "m")

	router := gin.New()
	RegisterAgentHostLifecycleRoutes(router.Group("/api"), svc, assistantruntime.New(assistantruntime.OptionsFromService(svc)))
	recorder := lifecycleRequest(router, http.MethodPost, "/api/assistant/host/start", owner, "{}")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"reason":"host_command_missing"`) {
		t.Fatalf("未配置命令时应返回 host_command_missing: %s", recorder.Body.String())
	}
}

func TestHostConfigWriteRoundTrip(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	svc := app.NewLocal(nil, dataDir)
	owner, err := agentops.EnsureOwnerToken(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	host := assistantruntime.New(assistantruntime.OptionsFromService(svc))
	router := gin.New()
	RegisterAgentHostLifecycleRoutes(router.Group("/api"), svc, host)

	recorder := lifecycleRequest(router, http.MethodPut, "/api/assistant/host/config", owner,
		`{"model":"kept-for-history","hostCommand":"/usr/bin/true"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("write status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	config, configured := host.EffectiveConfig()
	if !configured || config.HostCommand != "/usr/bin/true" {
		t.Fatalf("effective config = %#v configured=%v", config, configured)
	}
}
