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
		{"安全模式重启", "safe-reload"},
		{"No", "safe-reload"},
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
