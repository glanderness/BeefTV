package plugins

import (
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/canvas/capability"
)

func writeFakeBundledMarketPlugin(t *testing.T, officialDir, version, clientCode string) {
	t.Helper()
	marketDir := filepath.Join(officialDir, "beeftv-plugin-market")
	if err := os.MkdirAll(filepath.Join(marketDir, "client"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(marketDir, "client", "index.js"), []byte(clientCode), 0o644); err != nil {
		t.Fatal(err)
	}
	pkgJSON := `{
		"name": "beeftv-plugin-market",
		"version": "` + version + `",
		"description": "BeefTV 官方插件市场",
		"beeftv": {
			"name": "插件市场",
			"client": "./client/index.js"
		}
	}`
	if err := os.WriteFile(filepath.Join(marketDir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBundledPluginRecoversFromTransientShutdownFetchAndVersionUpgrade(t *testing.T) {
	officialDir := t.TempDir()
	writeFakeBundledMarketPlugin(t, officialDir, "2.2.5", "export function activate() { return 1; }\n")
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", officialDir)

	prevExec, prevGOOS := runtimeExecutable, runtimeGOOS
	runtimeExecutable = func() (string, error) { return filepath.Join(t.TempDir(), "BeefTV"), nil }
	runtimeGOOS = "linux"
	t.Cleanup(func() {
		runtimeExecutable = prevExec
		runtimeGOOS = prevGOOS
	})

	dataDir := t.TempDir()
	defer capability.BuiltinRegistry().ResetPluginDescriptors()

	for _, transientErr := range []string{
		"TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:58426/api/plugins/beeftv-plugin-market/files/client/index.js?v=2cd17c",
		"TypeError: error loading dynamically imported module",
		"TypeError: Importing a module script failed.",
		"TypeError: Load failed",
		"NetworkError when attempting to fetch resource.",
	} {
		rt, err := NewRuntime(dataDir)
		if err != nil {
			t.Fatalf("NewRuntime: %v", err)
		}
		svc := New(rt, nil)
		invalid, err := svc.SetLoadError("beeftv-plugin-market", transientErr, "import")
		if err != nil || invalid.Status != StatusInvalid {
			t.Fatalf("SetLoadError(%q) = %+v, err=%v", transientErr, invalid, err)
		}

		// Restarting on the same version clears transient loopback/fetch failures.
		restarted, err := NewRuntime(dataDir)
		if err != nil {
			t.Fatalf("restart NewRuntime: %v", err)
		}
		view, found := ByID(New(restarted, nil).List(), "beeftv-plugin-market")
		if !found || view.Status != StatusEnabled || view.Error != "" {
			t.Fatalf("transient error %q was not cleared on startup: %+v", transientErr, view)
		}
	}

	// Legacy pre-upgrade records without LoadErrorStage also auto-clear Safari/Chromium fetch failures.
	rtLegacy, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(rtLegacy, nil).SetLoadError("beeftv-plugin-market", "TypeError: Load failed"); err != nil {
		t.Fatal(err)
	}
	afterLegacyRestart, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	legacyView, found := ByID(New(afterLegacyRestart, nil).List(), "beeftv-plugin-market")
	if !found || legacyView.Status != StatusEnabled || legacyView.Error != "" {
		t.Fatalf("legacy stage-less transient error should clear on startup, got %+v", legacyView)
	}

	// An activate() runtime error with network-like text on unchanged SHA must NOT be auto-cleared.
	rtActivate, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(rtActivate, nil).SetLoadError("beeftv-plugin-market", "TypeError: Failed to fetch", "activate"); err != nil {
		t.Fatal(err)
	}
	afterActivateErr, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	activateView, found := ByID(New(afterActivateErr, nil).List(), "beeftv-plugin-market")
	if !found || activateView.Status != StatusInvalid || activateView.Error == "" {
		t.Fatalf("activate-stage error should remain invalid on unchanged SHA, got %+v", activateView)
	}

	// A genuine syntax error on the exact same SHA remains invalid across restart...
	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	if _, err := svc.SetLoadError("beeftv-plugin-market", "SyntaxError: Unexpected token '}'"); err != nil {
		t.Fatal(err)
	}
	sameVersionRestart, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	stillInvalid, found := ByID(New(sameVersionRestart, nil).List(), "beeftv-plugin-market")
	if !found || stillInvalid.Status != StatusInvalid || stillInvalid.Error == "" {
		t.Fatalf("genuine syntax error on unchanged SHA should stay invalid, got %+v", stillInvalid)
	}

	// ...until BeefTV upgrades to a new bundled package SHA (e.g. v2.3.0).
	writeFakeBundledMarketPlugin(t, officialDir, "2.3.0", "export function activate() { return 2; }\n")
	upgradedRestart, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	recovered, found := ByID(New(upgradedRestart, nil).List(), "beeftv-plugin-market")
	if !found || recovered.Status != StatusEnabled || recovered.Error != "" || recovered.Manifest.Version != "2.3.0" {
		t.Fatalf("bundled upgrade did not clear stale LoadError: %+v", recovered)
	}
}

func TestInstalledPackagePluginRecoversFromTransientFetchAndOnDiskUpdate(t *testing.T) {
	officialDir := t.TempDir()
	writeFakeBundledMarketPlugin(t, officialDir, "2.3.0", "export function activate() {}\n")
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", officialDir)

	prevExec, prevGOOS := runtimeExecutable, runtimeGOOS
	runtimeExecutable = func() (string, error) { return filepath.Join(t.TempDir(), "BeefTV"), nil }
	runtimeGOOS = "linux"
	t.Cleanup(func() {
		runtimeExecutable = prevExec
		runtimeGOOS = prevGOOS
	})

	dataDir := t.TempDir()
	defer capability.BuiltinRegistry().ResetPluginDescriptors()

	rt, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(rt, nil)
	svc.SetPackageFetcher(copyPackageFetcher)
	installed, err := svc.InstallPackage(writeSamplePluginDir(t, "1.0.0"), "")
	if err != nil || installed.Status != StatusEnabled {
		t.Fatalf("InstallPackage: %+v err=%v", installed, err)
	}

	// Transient dynamic-import fetch failure clears on startup.
	if _, err := svc.SetLoadError("storyboard-grid-test", "TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:60123/api/plugins/storyboard-grid-test/files/dist/client.js"); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	restartedSvc := New(restarted, nil)
	view, found := ByID(restartedSvc.List(), "storyboard-grid-test")
	if !found || view.Status != StatusEnabled || view.Error != "" {
		t.Fatalf("package plugin did not clear transient fetch LoadError: %+v", view)
	}

	// Genuine syntax error stays invalid on same SHA, then clears when package files change on disk.
	if _, err := restartedSvc.SetLoadError("storyboard-grid-test", "ReferenceError: brokenSymbol is not defined"); err != nil {
		t.Fatal(err)
	}
	sameSHA, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	invalidView, _ := ByID(New(sameSHA, nil).List(), "storyboard-grid-test")
	if invalidView.Status != StatusInvalid {
		t.Fatalf("expected unchanged package to keep ReferenceError, got %+v", invalidView)
	}

	var pkgRoot string
	sameSHA.mu.RLock()
	pkgRoot = sameSHA.plugins["storyboard-grid-test"].PackageDir
	sameSHA.mu.RUnlock()
	if err := os.WriteFile(filepath.Join(pkgRoot, "dist", "client.js"), []byte("export function activate() { return 'fixed'; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	afterFix, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	fixedView, _ := ByID(New(afterFix, nil).List(), "storyboard-grid-test")
	if fixedView.Status != StatusEnabled || fixedView.Error != "" {
		t.Fatalf("expected updated package SHA on disk to clear LoadError, got %+v", fixedView)
	}
}
