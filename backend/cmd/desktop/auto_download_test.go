package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestAutoDownloadSettingsDefaultsAndCustomLifecycle(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()
	customDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir

	initial, err := app.AutoDownloadSettings()
	if err != nil {
		t.Fatalf("AutoDownloadSettings err = %v", err)
	}
	wantDefault := filepath.Join(downloadsDir, defaultAutoDownloadSubdirName)
	if initial.Directory != wantDefault || initial.DefaultDirectory != wantDefault || initial.CustomDirectory != "" || !initial.Available {
		t.Fatalf("initial settings = %+v, want default=%s available=true", initial, wantDefault)
	}

	// Cancelling directory picker leaves config untouched and sets Cancelled=true.
	app.chooseAutoDownloadDir = func(context.Context) (string, error) { return "", nil }
	cancelled, err := app.ChooseAutoDownloadDirectory()
	if err != nil || !cancelled.Cancelled || cancelled.CustomDirectory != "" || cancelled.Directory != wantDefault {
		t.Fatalf("cancelled choose = (%+v, %v)", cancelled, err)
	}

	// Choosing a valid custom directory persists to disk and survives reloads.
	app.chooseAutoDownloadDir = func(context.Context) (string, error) { return customDir, nil }
	chosen, err := app.ChooseAutoDownloadDirectory()
	if err != nil {
		t.Fatalf("ChooseAutoDownloadDirectory err = %v", err)
	}
	if chosen.Cancelled || chosen.CustomDirectory != customDir || chosen.Directory != customDir || !chosen.Available {
		t.Fatalf("chosen settings = %+v, want custom=%s", chosen, customDir)
	}

	reloadedApp := newDesktopApp(dataDir)
	reloadedApp.downloadsDir = downloadsDir
	reloaded, err := reloadedApp.AutoDownloadSettings()
	if err != nil {
		t.Fatalf("reloaded AutoDownloadSettings err = %v", err)
	}
	if reloaded.CustomDirectory != customDir || reloaded.Directory != customDir || !reloaded.Available {
		t.Fatalf("reloaded settings = %+v, want custom=%s", reloaded, customDir)
	}

	// Resetting returns to default Downloads/BeefTV and removes the config file.
	reset, err := app.ResetAutoDownloadDirectory()
	if err != nil {
		t.Fatalf("ResetAutoDownloadDirectory err = %v", err)
	}
	if reset.CustomDirectory != "" || reset.Directory != wantDefault || !reset.Available {
		t.Fatalf("reset settings = %+v, want default=%s", reset, wantDefault)
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, autoDownloadConfigFileName)); !os.IsNotExist(statErr) {
		t.Fatalf("config file should be removed after reset, statErr=%v", statErr)
	}
}

func TestChooseAutoDownloadDirectoryRejectsWorkspaceOverlap(t *testing.T) {
	dataDir := t.TempDir()
	nestedInsideWorkspace := filepath.Join(dataDir, "exports")
	if err := os.MkdirAll(nestedInsideWorkspace, 0o755); err != nil {
		t.Fatal(err)
	}

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = t.TempDir()

	for _, candidate := range []string{dataDir, nestedInsideWorkspace} {
		app.chooseAutoDownloadDir = func(context.Context) (string, error) { return candidate, nil }
		if _, err := app.ChooseAutoDownloadDirectory(); err == nil {
			t.Fatalf("expected error for overlapping dir %s", candidate)
		}
	}
}

func TestSaveAutoDownloadedMediaOrganizesByProjectAndDeduplicates(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		return os.WriteFile(destPath, []byte("payload:"+resourceID), 0o600)
	}

	first, err := app.SaveAutoDownloadedMedia("第一镜：雨夜/街角.mp4", "res-1", "我的短剧/第一集:雨夜")
	if err != nil {
		t.Fatalf("first SaveAutoDownloadedMedia err = %v", err)
	}
	wantDir := filepath.Join(downloadsDir, "BeefTV", "我的短剧_第一集_雨夜")
	if first.Directory != wantDir {
		t.Fatalf("first.Directory = %q, want %q", first.Directory, wantDir)
	}
	if filepath.Dir(first.SavedPath) != wantDir {
		t.Fatalf("first.SavedPath = %q not inside %q", first.SavedPath, wantDir)
	}
	body1, err := os.ReadFile(first.SavedPath)
	if err != nil || string(body1) != "payload:res-1" {
		t.Fatalf("first body = %q, err=%v", string(body1), err)
	}

	// Second save with identical filename must not overwrite and must get a unique suffix.
	second, err := app.SaveAutoDownloadedMedia("第一镜：雨夜/街角.mp4", "res-2", "我的短剧/第一集:雨夜")
	if err != nil {
		t.Fatalf("second SaveAutoDownloadedMedia err = %v", err)
	}
	if second.SavedPath == first.SavedPath {
		t.Fatalf("second save overwrote first path %q", first.SavedPath)
	}
	body1After, _ := os.ReadFile(first.SavedPath)
	body2, _ := os.ReadFile(second.SavedPath)
	if string(body1After) != "payload:res-1" || string(body2) != "payload:res-2" {
		t.Fatalf("deduped bodies = (%q, %q)", string(body1After), string(body2))
	}
}

func TestSaveAutoDownloadedMediaSanitizesTraversalAndReservedProjectNames(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		return os.WriteFile(destPath, []byte(resourceID), 0o600)
	}

	rootDir := filepath.Join(downloadsDir, "BeefTV")
	cases := []struct {
		name        string
		projectName string
		wantFolder  string
	}{
		{name: "empty falls back", projectName: "   ", wantFolder: "未命名项目"},
		{name: "dotdot traversal flattened", projectName: "..", wantFolder: "未命名项目"},
		{name: "windows reserved CON", projectName: "CON", wantFolder: "未命名项目"},
		{name: "windows reserved nul.txt", projectName: "nul.txt", wantFolder: "未命名项目.txt"},
		{name: "slash traversal sanitized", projectName: "../../escape", wantFolder: "_.._escape"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := app.SaveAutoDownloadedMedia("shot.png", "res-ok", tc.projectName)
			if err != nil {
				t.Fatalf("SaveAutoDownloadedMedia(%q) err = %v", tc.projectName, err)
			}
			if filepath.Dir(res.Directory) != rootDir {
				t.Fatalf("project dir %q escaped root %q", res.Directory, rootDir)
			}
			if filepath.Base(res.Directory) != tc.wantFolder {
				t.Fatalf("folder = %q, want %q", filepath.Base(res.Directory), tc.wantFolder)
			}
		})
	}
}

func TestSaveAutoDownloadedMediaRejectsSymlinkSubdirAndMissingCustomDisk(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()
	outsideDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		return os.WriteFile(destPath, []byte(resourceID), 0o600)
	}

	// Pre-plant a symlink project directory inside Downloads/BeefTV -> outsideDir.
	rootDir := filepath.Join(downloadsDir, "BeefTV")
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(rootDir, "symlinked-proj")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if _, err := app.SaveAutoDownloadedMedia("clip.mp4", "res-1", "symlinked-proj"); err == nil {
		t.Fatal("expected symlink project subdirectory to be rejected")
	}

	// Missing custom directory (e.g. unplugged external SSD) must fail without recreating it.
	missingCustom := filepath.Join(t.TempDir(), "unplugged-drive", "BeefTVExports")
	if err := app.writeAutoDownloadConfig(autoDownloadStoredConfig{CustomDirectory: missingCustom}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SaveAutoDownloadedMedia("clip.mp4", "res-1", "项目A"); err == nil {
		t.Fatal("expected missing custom directory to fail")
	} else if !strings.Contains(err.Error(), "不可用") || strings.Contains(err.Error(), "重叠") {
		t.Fatalf("missing custom directory error = %q, want unavailable error rather than overlap", err.Error())
	}
	if _, statErr := os.Stat(missingCustom); !os.IsNotExist(statErr) {
		t.Fatalf("missing custom directory must not be silently recreated, statErr=%v", statErr)
	}
	settings, err := app.AutoDownloadSettings()
	if err != nil {
		t.Fatalf("AutoDownloadSettings err = %v", err)
	}
	if settings.Available {
		t.Fatalf("settings.Available = true for missing custom dir, want false")
	}
}

func TestAutoDownloadCorruptConfigCanRecoverByChooseOrReset(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()
	replacementDir := t.TempDir()

	if err := os.WriteFile(filepath.Join(dataDir, autoDownloadConfigFileName), []byte("{corrupt-json"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir

	if _, err := app.AutoDownloadSettings(); err == nil {
		t.Fatal("expected corrupt config to fail initial read")
	}

	// Cancelling while corrupt preserves the corrupt-config error instead of pretending success.
	app.chooseAutoDownloadDir = func(context.Context) (string, error) { return "", nil }
	if _, err := app.ChooseAutoDownloadDirectory(); err == nil {
		t.Fatal("expected cancelled choose on corrupt config to still report corrupt config error")
	}

	// Choosing a valid directory recovers by overwriting the corrupt config file.
	app.chooseAutoDownloadDir = func(context.Context) (string, error) { return replacementDir, nil }
	recovered, err := app.ChooseAutoDownloadDirectory()
	if err != nil {
		t.Fatalf("ChooseAutoDownloadDirectory failed to recover corrupt config: %v", err)
	}
	if recovered.CustomDirectory != replacementDir || !recovered.Available {
		t.Fatalf("recovered settings = %+v", recovered)
	}

	// Corrupt again and verify ResetAutoDownloadDirectory also recovers cleanly.
	if err := os.WriteFile(filepath.Join(dataDir, autoDownloadConfigFileName), []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	reset, err := app.ResetAutoDownloadDirectory()
	if err != nil {
		t.Fatalf("ResetAutoDownloadDirectory failed to recover corrupt config: %v", err)
	}
	wantDefault := filepath.Join(downloadsDir, defaultAutoDownloadSubdirName)
	if reset.CustomDirectory != "" || reset.Directory != wantDefault || !reset.Available {
		t.Fatalf("reset settings = %+v", reset)
	}
}

func TestAutoDownloadSettingsMarksDefaultSubdirFileConflictUnavailable(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(downloadsDir, defaultAutoDownloadSubdirName), []byte("blocking-file"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := newDesktopApp(dataDir)
	app.downloadsDir = downloadsDir
	settings, err := app.AutoDownloadSettings()
	if err != nil {
		t.Fatalf("AutoDownloadSettings err = %v", err)
	}
	if settings.Available {
		t.Fatalf("expected Available=false when Downloads/BeefTV is occupied by a regular file: %+v", settings)
	}
}

func TestOpenAutoDownloadDirectoryCreatesDefaultSubdirAndOpens(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir

	opened := ""
	app.openDirectory = func(path string) error {
		opened = path
		return nil
	}

	if err := app.OpenAutoDownloadDirectory(); err != nil {
		t.Fatalf("OpenAutoDownloadDirectory err = %v", err)
	}
	wantDir := filepath.Join(downloadsDir, "BeefTV")
	if opened != wantDir {
		t.Fatalf("opened = %q, want %q", opened, wantDir)
	}
	if info, err := os.Stat(wantDir); err != nil || !info.IsDir() {
		t.Fatalf("default subdir %q was not created: %v", wantDir, err)
	}
}

func TestSaveAutoDownloadedMediaConcurrentSavesDoNotOverwrite(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.wailsCtx = context.Background()
	app.downloadsDir = downloadsDir
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		return os.WriteFile(destPath, []byte(resourceID), 0o600)
	}

	const workers = 8
	var wg sync.WaitGroup
	paths := make(chan string, workers)
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			res, err := app.SaveAutoDownloadedMedia("镜头.png", "res-"+string(rune('a'+idx)), "并发项目")
			if err != nil {
				errs <- err
				return
			}
			paths <- res.SavedPath
		}(i)
	}
	wg.Wait()
	close(paths)
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent SaveAutoDownloadedMedia error: %v", err)
	}
	seen := make(map[string]struct{})
	for p := range paths {
		if _, dup := seen[p]; dup {
			t.Fatalf("duplicate saved path %q", p)
		}
		seen[p] = struct{}{}
	}
	if len(seen) != workers {
		t.Fatalf("saved %d distinct files, want %d", len(seen), workers)
	}
}

func TestSaveAutoDownloadedMediaStreamsRealWorkspaceResource(t *testing.T) {
	dataDir := t.TempDir()
	downloadsDir := t.TempDir()

	app := newDesktopApp(dataDir)
	app.downloadsDir = downloadsDir
	app.startup(context.Background())
	defer app.shutdown(context.Background())

	resourceID := uploadDesktopResource(t, app, []byte("real-png-bytes"))
	res, err := app.SaveAutoDownloadedMedia("女主特写_12345678.png", resourceID, "赛博短剧")
	if err != nil {
		t.Fatalf("SaveAutoDownloadedMedia err = %v", err)
	}
	if !strings.HasPrefix(res.SavedPath, filepath.Join(downloadsDir, "BeefTV", "赛博短剧")) {
		t.Fatalf("unexpected SavedPath = %q", res.SavedPath)
	}
	got, err := os.ReadFile(res.SavedPath)
	if err != nil || string(got) != "real-png-bytes" {
		t.Fatalf("saved content = %q, err=%v", string(got), err)
	}
	if _, err := app.SaveAutoDownloadedMedia("bad.png", "../not-owned", "赛博短剧"); err == nil {
		t.Fatal("expected unowned resource id to be rejected")
	}
}
