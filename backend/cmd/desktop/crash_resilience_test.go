package main

import (
	"archive/zip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCrashSentinelAndDirectRuntimeDiagnosticExport(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()

	// Simulate an unclean previous session leaving .session-running behind.
	sentinel := crashSentinelPath(dataDir)
	if err := os.WriteFile(sentinel, []byte(`{"pid":99999,"startedAt":"2026-01-01T00:00:00Z"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	app := newDesktopApp(dataDir)
	app.downloadsDir = downloadsDir
	app.revealFile = func(string) error { return nil }
	if err := app.start(context.Background()); err != nil {
		t.Fatalf("desktop app start failed: %v", err)
	}

	state := app.StartupState()
	if !state.UncleanPreviousShutdown {
		t.Fatalf("expected UncleanPreviousShutdown=true when .session-running pre-existed, got %+v", state)
	}

	// Direct-to-disk export must work without any WebView/HTTP roundtrip.
	savedPath, err := app.ExportRuntimeDiagnosticsToDownloads(`{"description":"renderer crashed"}`)
	if err != nil {
		t.Fatalf("ExportRuntimeDiagnosticsToDownloads failed: %v", err)
	}
	if !strings.HasPrefix(savedPath, downloadsDir) {
		t.Fatalf("savedPath = %q, expected inside %q", savedPath, downloadsDir)
	}
	zr, err := zip.OpenReader(savedPath)
	if err != nil {
		t.Fatalf("saved diagnostic archive unreadable: %v", err)
	}
	hasManifest := false
	for _, f := range zr.File {
		if f.Name == "manifest.json" {
			hasManifest = true
		}
	}
	_ = zr.Close()
	if !hasManifest {
		t.Fatalf("expected manifest.json in directly exported runtime diagnostic archive")
	}

	// Clean stop must remove .session-running.
	if err := app.stop(context.Background()); err != nil {
		t.Fatalf("desktop app stop failed: %v", err)
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("expected clean stop to remove %s, stat err=%v", sentinel, err)
	}
}

func TestCollectCrashpadMetadataNeverReadsDumpBytes(t *testing.T) {
	dataDir := t.TempDir()
	reportsDir := filepath.Join(dataDir, "webview-profile", "EBWebView", "Crashpad", "reports")
	if err := os.MkdirAll(reportsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	dumpPath := filepath.Join(reportsDir, "sample-crash.dmp")
	if err := os.WriteFile(dumpPath, []byte("SECRET_MEMORY_DUMP_DO_NOT_EXPORT"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newDesktopApp(dataDir)
	app.downloadsDir = t.TempDir()
	app.revealFile = func(string) error { return nil }
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = app.stop(context.Background()) }()

	savedPath, err := app.ExportRuntimeDiagnosticsToDownloads("")
	if err != nil {
		t.Fatal(err)
	}
	rawZip, err := os.ReadFile(savedPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawZip), "SECRET_MEMORY_DUMP_DO_NOT_EXPORT") {
		t.Fatal("raw crash dump bytes leaked into diagnostic zip")
	}
	zr, err := zip.OpenReader(savedPath)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	foundMeta := false
	for _, f := range zr.File {
		if f.Name == "desktop/crashpad-reports.json" {
			foundMeta = true
		}
	}
	if !foundMeta {
		t.Fatal("expected desktop/crashpad-reports.json metadata in diagnostic zip")
	}
}

func TestPruneStartupDiagnosticSnapshotsBoundsLastCrashZips(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)
	for i := 0; i < 8; i++ {
		name := filepath.Join(dir, "beeftv-last-crash-diagnostics-"+string(rune('a'+i))+".zip")
		if err := os.WriteFile(name, []byte("zip"), 0o600); err != nil {
			t.Fatal(err)
		}
		stamp := base.Add(time.Duration(i) * time.Minute)
		_ = os.Chtimes(name, stamp, stamp)
	}
	pruneStartupDiagnosticSnapshots(dir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != maxAutoStartupBundles {
		t.Fatalf("expected %d retained last-crash zips, got %d", maxAutoStartupBundles, len(entries))
	}
	for _, kept := range entries {
		if kept.Name() < "beeftv-last-crash-diagnostics-d.zip" {
			t.Fatalf("oldest last-crash zip was not pruned: %s", kept.Name())
		}
	}
}

func TestReloadWindowAckPreventsDoubleReloadAndUnresponsiveFallsBack(t *testing.T) {
	dataDir := t.TempDir()
	app := newDesktopApp(dataDir)
	app.downloadsDir = t.TempDir()
	app.revealFile = func(string) error { return nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app.wailsCtx = ctx
	if err := app.start(ctx); err != nil {
		t.Fatalf("desktop app start failed: %v", err)
	}
	defer func() { _ = app.stop(context.Background()) }()

	rt := app.runtime()
	if rt == nil {
		t.Fatal("expected active runtime")
	}

	// Case 1: Live renderer acks via Wails event -> slow flush must NEVER trigger native fallback double-reload.
	nativeCalls := 0
	app.gracefulReloadWait = 40 * time.Millisecond
	var triggerAck func()
	app.subscribeReloadAck = func(_ context.Context, onAck func()) func() {
		triggerAck = onAck
		return func() {}
	}
	app.emitReloadEvent = func(_ context.Context, payload map[string]any) {
		if safe, _ := payload["safeMode"].(bool); !safe {
			t.Fatalf("expected safeMode=true in reload payload, got %+v", payload)
		}
		if triggerAck != nil {
			triggerAck()
		}
	}
	app.nativeReloadFn = func(context.Context) {
		nativeCalls++
	}
	if err := app.ReloadWindow(true); err != nil {
		t.Fatalf("ReloadWindow(true) failed: %v", err)
	}
	time.Sleep(90 * time.Millisecond)
	if nativeCalls != 0 {
		t.Fatalf("expected 0 native fallback reloads after renderer ack, got %d", nativeCalls)
	}
	// Non-boot reads (RuntimeConfig / desktopAssetHandler /api proxy) must NOT consume safeMode.
	_ = app.RuntimeConfig()
	req := httptest.NewRequest(http.MethodGet, "http://wails.localhost/api/health/live", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	rec := httptest.NewRecorder()
	(&desktopAssetHandler{app: app}).ServeHTTP(rec, req)

	// StartupState consumes safeMode once so subsequent reloads return to normal mode.
	state := app.StartupState()
	if !state.SafeModeRequested {
		t.Fatalf("expected SafeModeRequested=true on first StartupState(), got %+v", state)
	}
	if next := app.StartupState(); next.SafeModeRequested {
		t.Fatalf("expected SafeModeRequested=false after one-shot consume, got %+v", next)
	}

	// Case 2: Unresponsive renderer never acks -> fallback native reload MUST fire once.
	fallbackDone := make(chan struct{}, 1)
	app.subscribeReloadAck = func(_ context.Context, _ func()) func() {
		return func() {}
	}
	app.emitReloadEvent = func(context.Context, map[string]any) {
		// Intentionally do NOT ack.
	}
	app.nativeReloadFn = func(context.Context) {
		nativeCalls++
		select {
		case fallbackDone <- struct{}{}:
		default:
		}
	}
	if err := app.ReloadWindow(true); err != nil {
		t.Fatalf("ReloadWindow(true) unresponsive case failed: %v", err)
	}
	select {
	case <-fallbackDone:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected native fallback reload for unresponsive renderer")
	}
	if nativeCalls != 1 {
		t.Fatalf("expected exactly 1 native fallback reload, got %d", nativeCalls)
	}
	if !rt.SafeModeRequested() {
		t.Fatal("expected SafeModeRequested=true to remain armed for browser-level fallback reload")
	}
}
