package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/assistant"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/desktopnet"
	"infinite-canvas/backend/internal/workspace"
)

func TestNetworkProxyRoutesRoundTripAndGuards(t *testing.T) {
	t.Cleanup(func() { _ = desktopnet.SetMode(desktopnet.ModeSystem) })
	_ = desktopnet.SetMode(desktopnet.ModeSystem)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:7890")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890")

	env := newAssistantTestEnv(t, nil)
	env.router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: env.service.DataDir()}))
	RegisterNetworkProxyRoutes(env.router.Group("/api"), env.service, env.assistantHost)

	// Default mode is system, effectiveMode reflects env proxy, never leaks proxy URL.
	rec := env.call(t, http.MethodGet, "/workspace/network-proxy", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /workspace/network-proxy status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "7890") {
		t.Fatalf("GET response must never expose proxy address: %s", rec.Body.String())
	}
	data := decodeEnvelope(t, rec)
	if data["mode"] != "system" || data["effectiveMode"] != "environment" {
		t.Fatalf("unexpected initial status: %#v", data)
	}

	// Switch to direct mode and verify persistence + effectiveMode.
	rec = env.call(t, http.MethodPut, "/workspace/network-proxy", `{"mode":"direct"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT direct status=%d body=%s", rec.Code, rec.Body.String())
	}
	data = decodeEnvelope(t, rec)
	if data["mode"] != "direct" || data["effectiveMode"] != "direct" {
		t.Fatalf("unexpected direct response: %#v", data)
	}
	if desktopnet.CurrentMode() != desktopnet.ModeDirect {
		t.Fatalf("desktopnet.CurrentMode = %q, want direct", desktopnet.CurrentMode())
	}
	savedRaw, err := os.ReadFile(filepath.Join(env.service.DataDir(), "network-proxy.json"))
	if err != nil {
		t.Fatalf("network-proxy.json not persisted: %v", err)
	}
	var saved struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(savedRaw, &saved); err != nil || saved.Mode != "direct" {
		t.Fatalf("unexpected persisted file: %s (%v)", string(savedRaw), err)
	}

	// Switch back to system mode and verify persistence + effectiveMode restored.
	rec = env.call(t, http.MethodPut, "/workspace/network-proxy", `{"mode":"system"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT system status=%d body=%s", rec.Code, rec.Body.String())
	}
	data = decodeEnvelope(t, rec)
	if data["mode"] != "system" || data["effectiveMode"] != "environment" {
		t.Fatalf("unexpected restored system response: %#v", data)
	}
	if desktopnet.CurrentMode() != desktopnet.ModeSystem {
		t.Fatalf("desktopnet.CurrentMode = %q, want system", desktopnet.CurrentMode())
	}

	// Invalid mode rejected with 400.
	rec = env.call(t, http.MethodPut, "/workspace/network-proxy", `{"mode":"invalid"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode status=%d, want 400", rec.Code)
	}

	// External client header rejected with 403.
	req := httptest.NewRequest(http.MethodPut, "/api/workspace/network-proxy", strings.NewReader(`{"mode":"system"}`))
	req.RemoteAddr = "127.0.0.1:43210"
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Beeftv-Client", "external-client")
	w := httptest.NewRecorder()
	env.router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("external client header status=%d, want 403", w.Code)
	}

	// External business principal rejected with 403.
	req = httptest.NewRequest(http.MethodPut, "/api/workspace/network-proxy", strings.NewReader(`{"mode":"system"}`))
	req.RemoteAddr = "127.0.0.1:43210"
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Content-Type", "application/json")
	req = WithExternalBusinessPrincipal(req, false)
	w = httptest.NewRecorder()
	env.router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("external business principal status=%d, want 403", w.Code)
	}

	// Non-loopback GET and PUT rejected with 403.
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		req = httptest.NewRequest(method, "/api/workspace/network-proxy", strings.NewReader(`{"mode":"system"}`))
		req.RemoteAddr = "192.168.1.50:43210"
		req.Host = "192.168.1.10:8080"
		req.Header.Set("Content-Type", "application/json")
		w = httptest.NewRecorder()
		env.router.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("non-loopback %s status=%d, want 403", method, w.Code)
		}
	}
}

func TestNetworkProxyRoutesRestartIdleAndDeferBusyHost(t *testing.T) {
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required for real-child network proxy handler test")
	}
	t.Cleanup(func() { _ = desktopnet.SetMode(desktopnet.ModeSystem) })
	_ = desktopnet.SetMode(desktopnet.ModeSystem)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
	t.Setenv("HTTP_PROXY", "")

	env := newAssistantTestEnv(t, nil)
	dataDir := env.service.DataDir()
	busyFile := filepath.Join(dataDir, "busy.flag")
	if err := os.WriteFile(busyFile, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(dataDir, "fake-host.cjs")
	script := `
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const nonce = process.env.BEEFTV_AGENT_INSTANCE_NONCE || "";
const proof = nonce ? crypto.createHash("sha256").update(nonce).digest("hex").slice(0, 16) : "";
const port = Number(process.env.BEEFTV_AGENT_PORT || 0);
const pipe = (process.env.BEEFTV_AGENT_PIPE || "").trim();
const listenFD = Number(process.env.BEEFTV_AGENT_LISTEN_FD || 0);
const busyFile = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, busy: fs.existsSync(busyFile), model: "demo", instance: proof }));
});
if (pipe) {
  server.listen(pipe);
} else if (listenFD > 0) {
  server.listen({ fd: listenFD });
} else {
  server.listen(port, "127.0.0.1");
}
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := assistant.Provider{
		ChannelID: "beeftv", ChannelName: "BeefTV", Protocol: "openai",
		BaseURL: "https://beeftv.app/v1", Model: "demo", APIKey: "sk-test",
	}
	host := assistantruntime.New(assistantruntime.Options{
		DataDir:         dataDir,
		ReadyTimeout:    8 * time.Second,
		ResolveProvider: func() (assistant.Provider, string) { return provider, "" },
		HostToken:       func() string { return "test-host-token" },
		Environ:         func() []string { return append(os.Environ(), "HTTPS_PROXY=http://127.0.0.1:7890") },
	})
	t.Cleanup(func() { _ = host.Stop() })
	if err := host.WriteConfig(assistantruntime.HostConfig{
		HostCommand: nodeBin,
		HostArgs:    []string{scriptPath, busyFile},
	}); err != nil {
		t.Fatal(err)
	}
	if err := host.Launch(provider, "http://127.0.0.1:18090/api", ""); err != nil {
		t.Fatalf("host.Launch: %v", err)
	}
	firstPID := host.PID()

	router := gin.New()
	router.Use(WorkspaceMiddleware(workspace.Context{ID: "local", DataDir: dataDir}))
	RegisterNetworkProxyRoutes(router.Group("/api"), env.service, host)

	call := func(method, body string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(method, "/api/workspace/network-proxy", strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:43210"
		req.Host = "127.0.0.1:8080"
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s /api/workspace/network-proxy status=%d body=%s", method, w.Code, w.Body.String())
		}
		return decodeEnvelope(t, w)
	}

	// While child is busy: PUT persists direct mode, does NOT restart child, and reports pending.
	putBusy := call(http.MethodPut, `{"mode":"direct"}`)
	if putBusy["assistantRestarted"] != false || putBusy["assistantRestartPending"] != true {
		t.Fatalf("busy PUT response = %#v, want restarted=false pending=true", putBusy)
	}
	if host.PID() != firstPID {
		t.Fatalf("busy host was interrupted: pid=%d want %d", host.PID(), firstPID)
	}
	// Subsequent GET truthfully continues reporting assistantRestartPending=true.
	getBusy := call(http.MethodGet, "")
	if getBusy["assistantRestartPending"] != true {
		t.Fatalf("GET while stale busy child running = %#v, want assistantRestartPending=true", getBusy)
	}

	// Once child becomes idle, PUT triggers async restart and GET clears pending once restarted.
	if err := os.Remove(busyFile); err != nil {
		t.Fatal(err)
	}
	putIdle := call(http.MethodPut, `{"mode":"direct"}`)
	if putIdle["assistantRestarted"] != true || putIdle["assistantRestartPending"] != false {
		t.Fatalf("idle PUT response = %#v, want restarted=true pending=false", putIdle)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if host.PID() != 0 && host.PID() != firstPID && !host.State().Starting && !host.NeedsRestart(provider) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if host.PID() == firstPID || host.NeedsRestart(provider) {
		t.Fatalf("host did not finish async restart: pid=%d first=%d state=%+v", host.PID(), firstPID, host.State())
	}
	getSettled := call(http.MethodGet, "")
	if getSettled["assistantRestartPending"] != false {
		t.Fatalf("GET after restart settled = %#v, want assistantRestartPending=false", getSettled)
	}
}
