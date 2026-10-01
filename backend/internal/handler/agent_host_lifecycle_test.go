package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

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

func useLifecycleProvider(t *testing.T) {
	t.Helper()
	t.Setenv("BEEFTV_AGENT_API_KEY", "k")
	t.Setenv("BEEFTV_AGENT_BASE_URL", "https://example.invalid/v1")
	t.Setenv("BEEFTV_AGENT_MODEL", "m")
	t.Setenv("BEEFTV_AGENT_PROTOCOL", "chat-completion")
}

func sleepHostConfig(t *testing.T, dir string) (assistantruntime.HostConfig, string) {
	t.Helper()
	marker := filepath.Join(dir, "spawned.marker")
	t.Cleanup(func() { killMarkerProcess(marker) })
	if runtime.GOOS == "windows" {
		command := filepath.Join(dir, "host.cmd")
		body := "@echo off\r\necho spawned>\"" + marker + "\"\r\nping -n 120 127.0.0.1 >nul\r\n"
		if err := os.WriteFile(command, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		return assistantruntime.HostConfig{HostCommand: "cmd.exe", HostArgs: []string{"/c", command}}, marker
	}
	command := filepath.Join(dir, "host.sh")
	body := "#!/bin/sh\necho $$ > \"" + marker + "\"\nexec sleep 120\n"
	if err := os.WriteFile(command, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return assistantruntime.HostConfig{HostCommand: command}, marker
}

func killMarkerProcess(marker string) {
	raw, err := os.ReadFile(marker)
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = process.Kill()
}

func decodeLifecyclePID(t *testing.T, recorder *httptest.ResponseRecorder) int {
	t.Helper()
	var envelope struct {
		Data struct {
			PID string `json:"pid"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode pid: %v body=%s", err, recorder.Body.String())
	}
	pid, err := strconv.Atoi(envelope.Data.PID)
	if err != nil || pid <= 0 {
		t.Fatalf("pid %q body=%s", envelope.Data.PID, recorder.Body.String())
	}
	return pid
}

func TestRepeatedStatusStartStopShareHostOwnership(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	svc := app.NewLocal(nil, dataDir)
	owner, err := agentops.EnsureOwnerToken(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	useLifecycleProvider(t)
	config, _ := sleepHostConfig(t, dataDir)
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}

	host := assistantruntime.New(assistantruntime.OptionsFromService(svc))
	t.Cleanup(func() { _ = host.Stop() })
	router := gin.New()
	api := router.Group("/api")
	RegisterAgentHostLifecycleRoutes(api, svc, host)
	RegisterAgentProxyRoutes(api, svc, agentops.NewClientRegistry(dataDir), newUISessionStore(), host)

	write := lifecycleRequest(router, http.MethodPut, "/api/assistant/host/config", owner, string(encoded))
	if write.Code != http.StatusOK {
		t.Fatalf("write status = %d body=%s", write.Code, write.Body.String())
	}

	start := lifecycleRequest(router, http.MethodPost, "/api/assistant/host/start", owner, "{}")
	if start.Code != http.StatusOK {
		t.Fatalf("start status = %d body=%s", start.Code, start.Body.String())
	}
	first := decodeLifecyclePID(t, start)
	if host.PID() != first {
		t.Fatalf("启动后 Host.PID=%d，响应 pid=%d", host.PID(), first)
	}

	status := lifecycleRequest(router, http.MethodGet, "/api/assistant/status", "", "")
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", status.Code, status.Body.String())
	}
	if host.PID() != first {
		t.Fatalf("状态查询必须复用同一 Host，pid %d -> %d", first, host.PID())
	}

	stop := lifecycleRequest(router, http.MethodPost, "/api/assistant/host/stop", owner, "{}")
	if stop.Code != http.StatusOK {
		t.Fatalf("stop status = %d body=%s", stop.Code, stop.Body.String())
	}
	if host.Running() {
		t.Fatal("停止后注入的 Host 必须不再持有子进程")
	}

	relaunched := lifecycleRequest(router, http.MethodGet, "/api/assistant/status", "", "")
	if relaunched.Code != http.StatusOK {
		t.Fatalf("relaunched status = %d body=%s", relaunched.Code, relaunched.Body.String())
	}
	if !waitUntil(3*time.Second, func() bool { return host.PID() > 0 && host.PID() != first }) {
		t.Fatalf("停止后的状态查询必须把子进程挂回同一 Host，pid=%d first=%d running=%v", host.PID(), first, host.Running())
	}
	second := host.PID()

	again := lifecycleRequest(router, http.MethodPost, "/api/assistant/host/start", owner, "{}")
	if again.Code != http.StatusOK {
		t.Fatalf("second start = %d body=%s", again.Code, again.Body.String())
	}
	if host.PID() != second {
		t.Fatalf("已在跑时 start 必须仍是同一子进程，pid %d -> %d", second, host.PID())
	}

	inspect := lifecycleRequest(router, http.MethodGet, "/api/assistant/host/config", owner, "")
	if inspect.Code != http.StatusOK {
		t.Fatalf("config status = %d body=%s", inspect.Code, inspect.Body.String())
	}
	if !strings.Contains(inspect.Body.String(), `"supervisorRunning":true`) {
		t.Fatalf("共享 Host 应报告运行中: %s", inspect.Body.String())
	}
}

func TestMissingHostFailsWithoutSpawning(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dataDir := t.TempDir()
	svc := app.NewLocal(nil, dataDir)
	owner, err := agentops.EnsureOwnerToken(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	useLifecycleProvider(t)
	config, marker := sleepHostConfig(t, dataDir)
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "agent_config.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	// Exercise the public standalone registration too: it must not invent a
	// supervisor that no composition root can close.
	RegisterCanvasAPI(router.Group("/api"), svc)

	status := lifecycleRequest(router, http.MethodGet, "/api/assistant/status", "", "")
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", status.Code, status.Body.String())
	}
	if !strings.Contains(status.Body.String(), `"reason":"host_unreachable"`) {
		t.Fatalf("缺失 Host 的状态查询应返回 host_unreachable: %s", status.Body.String())
	}

	for _, item := range []struct{ method, path string }{
		{http.MethodPost, "/api/assistant/host/start"},
		{http.MethodPost, "/api/assistant/host/stop"},
		{http.MethodGet, "/api/assistant/host/config"},
	} {
		recorder := lifecycleRequest(router, item.method, item.path, owner, "{}")
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s status = %d body=%s", item.method, item.path, recorder.Code, recorder.Body.String())
		}
		if !strings.Contains(recorder.Body.String(), `"reason":"host_unreachable"`) {
			t.Fatalf("%s %s 应返回 host_unreachable: %s", item.method, item.path, recorder.Body.String())
		}
	}

	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("缺失 Host 时不得拉起子进程")
	}
}

func waitUntil(timeout time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ok()
}
