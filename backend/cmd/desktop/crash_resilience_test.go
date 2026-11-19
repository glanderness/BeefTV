package main

import (
	"archive/zip"
	"context"
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

func TestRendererReloadCircuitBreaker(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	base := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if !app.allowAutomaticRendererReload(base.Add(time.Duration(i*10) * time.Second)) {
			t.Fatalf("reload %d within limit should be allowed", i+1)
		}
	}
	if app.allowAutomaticRendererReload(base.Add(35 * time.Second)) {
		t.Fatalf("4th reload within 60s must trip circuit breaker")
	}
	// After the sliding window passes, reloads are allowed again.
	if !app.allowAutomaticRendererReload(base.Add(65 * time.Second)) {
		t.Fatalf("reload after 60s window should be allowed again")
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

func TestCrashRecoveryDialogActionCrossPlatform(t *testing.T) {
	cases := []struct {
		choice string
		want   string
	}{
		{"导出诊断包", "export"},
		{"Yes", "export"},
		{"Ok", "export"},
		{"安全模式重载", "safe-reload"},
		{"安全模式重启", "safe-reload"},
		{"No", "safe-reload"},
		{"继续等待", "cancel"},
		{"取消", "cancel"},
		{"Cancel", "cancel"},
		{"", "cancel"},
	}
	for _, tc := range cases {
		if got := crashRecoveryDialogAction(tc.choice); got != tc.want {
			t.Errorf("crashRecoveryDialogAction(%q) = %q, want %q", tc.choice, got, tc.want)
		}
	}
}

func TestRendererWatchdogRespectsBusyLeaseMaxCapHiddenTransitionAndCooldown(t *testing.T) {
	var state rendererWatchdogState
	base := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)

	// Fresh heartbeat: no prompt.
	if state.evaluate(base.Add(20*time.Second), base, false, false, time.Time{}) {
		t.Fatal("fresh heartbeat must not trigger prompt")
	}
	// Legitimate 60s busy task (>35s normal timeout, <180s busy ceiling): no prompt.
	if state.evaluate(base.Add(60*time.Second), base, false, true, base) {
		t.Fatal("busy lease within busy timeout must not trigger prompt")
	}
	// A leaked busy lease older than 10m falls back to normal 35s timeout.
	if !state.evaluate(base.Add(11*time.Minute), base.Add(10*time.Minute), false, true, base) {
		t.Fatal("leaked busy lease exceeding 10m cap must fall back to 35s threshold")
	}
	state = rendererWatchdogState{}
	// Hidden window does not prompt while hidden, then prompts as soon as visible with stale heartbeat.
	if state.evaluate(base.Add(50*time.Second), base, true, false, time.Time{}) {
		t.Fatal("hidden window must not prompt immediately")
	}
	if !state.evaluate(base.Add(55*time.Second), base, false, false, time.Time{}) {
		t.Fatal("expected stale visible window after hidden period to trigger prompt")
	}
	// Cooldown prevents dialog spam on subsequent 5s ticks.
	if state.evaluate(base.Add(60*time.Second), base, false, false, time.Time{}) {
		t.Fatal("watchdog must respect cooldown after prompting")
	}
	// After cooldown expires and heartbeat is still stale, prompt can fire again.
	if !state.evaluate(base.Add(95*time.Second), base, false, false, time.Time{}) {
		t.Fatal("expected watchdog to re-evaluate after cooldown")
	}
}

func TestCrashRecoveryDialogOptionsMatchPlatformCapabilities(t *testing.T) {
	winOpts := crashRecoveryDialogOptions("windows", false)
	if strings.Contains(winOpts.Message, "点击「取消」") {
		t.Fatalf("Windows MB_YESNO copy must not promise a non-existent Cancel button: %q", winOpts.Message)
	}
	if winOpts.DefaultButton != "yes" {
		t.Fatalf("Windows DefaultButton = %q, want yes (non-destructive export)", winOpts.DefaultButton)
	}
	macOpts := crashRecoveryDialogOptions("darwin", false)
	if len(macOpts.Buttons) != 3 || macOpts.DefaultButton != "继续等待" {
		t.Fatalf("macOS dialog options mismatch: %+v", macOpts)
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

	// Case 1: Live renderer acks requestId -> slow flush/boot must NEVER trigger native fallback double-reload.
	nativeCalls := 0
	var emittedReqID uint64
	app.gracefulReloadWait = 40 * time.Millisecond
	app.emitReloadEvent = func(_ context.Context, payload map[string]any) {
		if id, ok := payload["requestId"].(uint64); ok {
			emittedReqID = id
			rt.AckReloadRequest(id)
		}
	}
	app.nativeReloadFn = func(context.Context) {
		nativeCalls++
	}
	if err := app.ReloadWindow(true); err != nil {
		t.Fatalf("ReloadWindow(true) failed: %v", err)
	}
	if emittedReqID == 0 {
		t.Fatal("expected non-zero reload requestId in emitted event")
	}
	time.Sleep(90 * time.Millisecond)
	if nativeCalls != 0 {
		t.Fatalf("expected 0 native fallback reloads after renderer ack, got %d", nativeCalls)
	}
	state := app.StartupState()
	if !state.SafeModeRequested || state.SafeModeRequestID == 0 {
		t.Fatalf("expected SafeModeRequested=true with non-zero requestId, got %+v", state)
	}
	firstSafeID := state.SafeModeRequestID

	// Case 2: Stale safe-mode ack from an older request must NOT wipe a newer safe-mode request.
	secondSafeID := rt.RequestSafeMode(true)
	if secondSafeID <= firstSafeID {
		t.Fatalf("expected monotonic safeModeRequestID: %d <= %d", secondSafeID, firstSafeID)
	}
	rt.AckSafeMode(firstSafeID)
	if !rt.SafeModeRequested() {
		t.Fatal("stale AckSafeMode(firstSafeID) cleared newer safe-mode request")
	}
	rt.AckSafeMode(secondSafeID)
	if rt.SafeModeRequested() {
		t.Fatal("matching AckSafeMode(secondSafeID) failed to clear safe-mode request")
	}

	// Case 3: Unresponsive renderer never acks -> fallback native reload MUST fire once.
	fallbackDone := make(chan struct{}, 1)
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
