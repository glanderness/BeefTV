package desktopnet

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http/httpproxy"
)

func resetProxyMode(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		_ = SetMode(ModeSystem)
	})
	_ = SetMode(ModeSystem)
}

func TestDirectModeBypassesSystemAndEnvProxiesAndDisablesProxyExemptions(t *testing.T) {
	resetProxyMode(t)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:7890")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
	t.Setenv("NO_PROXY", "")

	if err := SetMode(ModeDirect); err != nil {
		t.Fatal(err)
	}
	if CurrentMode() != ModeDirect {
		t.Fatalf("CurrentMode = %q, want direct", CurrentMode())
	}
	req, _ := http.NewRequest(http.MethodGet, "https://beeftv.app/v1/chat/completions", nil)
	if got, err := Proxy(req); err != nil || got != nil {
		t.Fatalf("Proxy in direct mode = %v, %v; want nil, nil", got, err)
	}
	if ExplicitProxyConfigured() {
		t.Fatal("ExplicitProxyConfigured must be false in direct mode")
	}
	if ConfiguredProxyAddress("127.0.0.1:7890") {
		t.Fatal("ConfiguredProxyAddress must be false in direct mode")
	}
	status := ConfigurationStatus()
	if status.Mode != "direct" || status.Preference != ModeDirect || status.AutoConfigOnly {
		t.Fatalf("ConfigurationStatus in direct mode = %+v", status)
	}
	httpsEnv := strings.Join(HTTPSProxyEnvironment(), "\n")
	if !strings.Contains(httpsEnv, "HTTPS_PROXY=\n") || !strings.Contains(httpsEnv, "NO_PROXY=*\n") {
		t.Fatalf("HTTPSProxyEnvironment in direct mode = %q", httpsEnv)
	}

	inherited := []string{"PATH=/fixture", "HTTP_PROXY=http://127.0.0.1:7890", "HTTPS_PROXY=http://127.0.0.1:7890", "NO_PROXY=example.com", "NODE_USE_ENV_PROXY=1"}
	nodeEnv := nodeProxyEnvironmentWithMode(inherited, "https://beeftv.app/v1", ModeDirect, func() systemProxySettings {
		t.Fatal("direct mode must not read system proxy")
		return systemProxySettings{}
	})
	values := nodeEnvMap(t, nodeEnv)
	if values["PATH"] != "/fixture" || values["HTTP_PROXY"] != "" || values["HTTPS_PROXY"] != "" || values["NO_PROXY"] != "*" || values["no_proxy"] != "*" || values["NODE_USE_ENV_PROXY"] != "0" {
		t.Fatalf("direct node env mismatch: %+v", values)
	}
}

func TestPreferencePersistenceRoundTripAndFallback(t *testing.T) {
	resetProxyMode(t)
	dir := t.TempDir()

	mode, err := LoadPreference(dir)
	if err != nil || mode != ModeSystem || CurrentMode() != ModeSystem {
		t.Fatalf("missing preference = (%q, %v), active=%q", mode, err, CurrentMode())
	}

	if err := SavePreference(dir, ModeDirect); err != nil {
		t.Fatalf("SavePreference(direct): %v", err)
	}
	if CurrentMode() != ModeDirect {
		t.Fatalf("active mode after save = %q", CurrentMode())
	}
	if err := SetMode(ModeSystem); err != nil {
		t.Fatal(err)
	}
	mode, err = LoadPreference(dir)
	if err != nil || mode != ModeDirect || CurrentMode() != ModeDirect {
		t.Fatalf("LoadPreference(direct) = (%q, %v), active=%q", mode, err, CurrentMode())
	}

	if err := SavePreference(dir, Mode("bogus")); err == nil {
		t.Fatal("invalid mode must fail")
	}
	if CurrentMode() != ModeDirect {
		t.Fatalf("failed save must not change active mode, got %q", CurrentMode())
	}

	if err := os.WriteFile(filepath.Join(dir, preferenceFileName), []byte("{corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	mode, err = LoadPreference(dir)
	if err == nil || mode != ModeSystem || CurrentMode() != ModeSystem {
		t.Fatalf("corrupt preference must fall back to system: mode=%q err=%v active=%q", mode, err, CurrentMode())
	}
}

func TestNodeProxyFingerprintTracksModeAndProxyChanges(t *testing.T) {
	resetProxyMode(t)
	envA := []string{"HTTPS_PROXY=http://127.0.0.1:7890"}
	envB := []string{"HTTPS_PROXY=http://127.0.0.1:7897"}
	fpA := NodeProxyFingerprint(envA, "https://beeftv.app/v1")
	fpB := NodeProxyFingerprint(envB, "https://beeftv.app/v1")
	if fpA == "" || fpA == fpB {
		t.Fatalf("proxy change must change fingerprint: a=%q b=%q", fpA, fpB)
	}
	if err := SetMode(ModeDirect); err != nil {
		t.Fatal(err)
	}
	fpDirectA := NodeProxyFingerprint(envA, "https://beeftv.app/v1")
	fpDirectB := NodeProxyFingerprint(envB, "https://beeftv.app/v1")
	if fpDirectA == fpA {
		t.Fatal("direct mode must change fingerprint compared to proxied mode")
	}
	if fpDirectA != fpDirectB {
		t.Fatal("direct mode fingerprint must ignore inherited proxy URL differences")
	}
}

func TestSystemProxyCacheInvalidatesOnModeChangeAndRetainsLastGoodOnFailure(t *testing.T) {
	resetProxyMode(t)
	origReader := systemProxyReader
	origNow := systemProxyNow
	t.Cleanup(func() {
		systemProxyReader = origReader
		systemProxyNow = origNow
		invalidateSystemProxyCache()
	})
	invalidateSystemProxyCache()

	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	systemProxyNow = func() time.Time { return now }

	calls := 0
	okNext := true
	active := systemProxySettings{config: httpproxy.Config{HTTPSProxy: "http://127.0.0.1:7890"}}
	systemProxyReader = func() (systemProxySettings, bool) {
		calls++
		if !okNext {
			return systemProxySettings{}, false
		}
		return active, true
	}

	first := readSystemProxy()
	second := readSystemProxy()
	if calls != 1 || first.config.HTTPSProxy != "http://127.0.0.1:7890" || second.config.HTTPSProxy != "http://127.0.0.1:7890" {
		t.Fatalf("expected TTL cache hit: calls=%d first=%+v second=%+v", calls, first, second)
	}

	// Expire TTL and simulate a transient OS reader failure: must retain last known good proxy.
	now = now.Add(systemProxyCacheTTL + time.Second)
	okNext = false
	retained := readSystemProxy()
	if calls != 2 || retained.config.HTTPSProxy != "http://127.0.0.1:7890" {
		t.Fatalf("transient reader failure must retain last known good settings: calls=%d got=%+v", calls, retained)
	}

	// Explicit mode switch invalidates cache and picks up fresh OS settings when reader recovers.
	okNext = true
	active = systemProxySettings{config: httpproxy.Config{HTTPSProxy: "http://127.0.0.1:7897"}}
	if err := SetMode(ModeDirect); err != nil {
		t.Fatal(err)
	}
	if err := SetMode(ModeSystem); err != nil {
		t.Fatal(err)
	}
	refreshed := readSystemProxy()
	if calls != 3 || refreshed.config.HTTPSProxy != "http://127.0.0.1:7897" {
		t.Fatalf("SetMode must invalidate system proxy cache: calls=%d got=%+v", calls, refreshed)
	}
}
