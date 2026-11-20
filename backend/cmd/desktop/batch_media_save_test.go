package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
)

func TestSaveOwnedMediaBatchCancelReturnsNoErrorAndWritesNothing(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSaveDir = func(context.Context) (string, error) { return "", nil }
	copied := false
	app.copyOwnedMedia = func(string, string) error {
		copied = true
		return nil
	}

	result, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{
		{FileName: "01_shot.mp4", ResourceID: "res-1"},
	}, "")
	if err != nil {
		t.Fatalf("cancelled batch save err = %v", err)
	}
	if !result.Cancelled || result.Saved != 0 || result.Failed != 0 || copied {
		t.Fatalf("cancelled batch save = %+v copied=%v", result, copied)
	}
}

func TestSaveOwnedMediaBatchSavesDeduplicatedFilesAndReportsItemFailures(t *testing.T) {
	targetDir := t.TempDir()
	// Pre-populate an existing file to ensure batch export never overwrites user files.
	existingPath := filepath.Join(targetDir, "01_shot.mp4")
	if err := os.WriteFile(existingPath, []byte("keep-existing"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSaveDir = func(context.Context) (string, error) { return targetDir, nil }
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		if resourceID == "res-missing" {
			return errors.New("没有可导出的本机文件")
		}
		return os.WriteFile(destPath, []byte("payload:"+resourceID), 0o600)
	}

	result, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{
		{FileName: "01_shot.mp4", ResourceID: "res-1"},
		{FileName: "01_SHOT.mp4", ResourceID: "res-2"},
		{FileName: "../evil:name?.png", Data: []byte("inline-png")},
		{FileName: "04_missing.mp4", ResourceID: "res-missing"},
		{FileName: "CON.mp4", ResourceID: "res-reserved"},
		{FileName: "06_empty.mp4"},
	}, "")
	if err != nil {
		t.Fatalf("SaveOwnedMediaBatch err = %v", err)
	}
	if result.Cancelled || result.Saved != 4 || result.Failed != 2 || result.Directory != targetDir {
		t.Fatalf("SaveOwnedMediaBatch result = %+v, want saved=4 failed=2 dir=%s", result, targetDir)
	}
	if len(result.Failures) != 2 || result.Failures[0].FileName != "04_missing.mp4" || result.Failures[1].FileName != "06_empty.mp4" {
		t.Fatalf("SaveOwnedMediaBatch failures = %+v", result.Failures)
	}

	assertContent := func(name, want string) {
		t.Helper()
		raw, readErr := os.ReadFile(filepath.Join(targetDir, name))
		if readErr != nil {
			t.Fatalf("read %s: %v", name, readErr)
		}
		if string(raw) != want {
			t.Fatalf("%s content = %q, want %q", name, string(raw), want)
		}
	}
	assertContent("01_shot.mp4", "keep-existing")
	assertContent("01_shot (1).mp4", "payload:res-1")
	assertContent("01_SHOT (2).mp4", "payload:res-2")
	assertContent("evil_name_.png", "inline-png")
	assertContent("未命名媒体.mp4", "payload:res-reserved")
}

func TestChooseOwnedMediaBatchDirectoryTokenIsSingleUseAndRejectsForgedTokens(t *testing.T) {
	targetDir := t.TempDir()
	promptCalls := 0
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSaveDir = func(context.Context) (string, error) {
		promptCalls++
		return targetDir, nil
	}

	token, err := app.ChooseOwnedMediaBatchDirectory()
	if err != nil || token == "" || promptCalls != 1 {
		t.Fatalf("ChooseOwnedMediaBatchDirectory = (%q, %v) prompts=%d", token, err, promptCalls)
	}

	if _, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{{FileName: "a.png", Data: []byte("x")}}, "forged-token"); err == nil {
		t.Fatal("expected forged directory token to be rejected")
	}

	result, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{{FileName: "a.png", Data: []byte("ok")}}, token)
	if err != nil || result.Saved != 1 || promptCalls != 1 {
		t.Fatalf("tokenized SaveOwnedMediaBatch = (%+v, %v) prompts=%d", result, err, promptCalls)
	}

	// Token must be consumed after one use.
	if _, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{{FileName: "b.png", Data: []byte("ok")}}, token); err == nil {
		t.Fatal("expected replayed directory token to be rejected")
	}

	// Expired token must also be rejected and cleared.
	expiredToken, err := app.ChooseOwnedMediaBatchDirectory()
	if err != nil || expiredToken == "" {
		t.Fatalf("second ChooseOwnedMediaBatchDirectory = (%q, %v)", expiredToken, err)
	}
	app.mu.Lock()
	app.batchDirExpiresAt = time.Now().Add(-time.Second)
	app.mu.Unlock()
	if _, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{{FileName: "c.png", Data: []byte("ok")}}, expiredToken); err == nil {
		t.Fatal("expected expired directory token to be rejected")
	}
}

func TestSaveOwnedMediaBatchConcurrentCallsNeverOverwriteEachOther(t *testing.T) {
	targetDir := t.TempDir()
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSaveDir = func(context.Context) (string, error) { return targetDir, nil }
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		return os.WriteFile(destPath, []byte("res:"+resourceID), 0o600)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for _, payload := range []string{"batch-A", "batch-B"} {
		wg.Add(2)
		go func(body string) {
			defer wg.Done()
			res, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{
				{FileName: "same.mp4", Data: []byte(body)},
			}, "")
			if err != nil {
				errs <- err
				return
			}
			if res.Saved != 1 || res.Failed != 0 {
				errs <- errors.New("unexpected concurrent inline batch save result")
			}
		}(payload)
		go func(rid string) {
			defer wg.Done()
			res, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{
				{FileName: "same.mp4", ResourceID: rid},
			}, "")
			if err != nil {
				errs <- err
				return
			}
			if res.Saved != 1 || res.Failed != 0 {
				errs <- errors.New("unexpected concurrent resource batch save result")
			}
		}(payload)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(targetDir)
	if err != nil || len(entries) != 4 {
		t.Fatalf("entries = %d err=%v, want 4 distinct files", len(entries), err)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		raw, readErr := os.ReadFile(filepath.Join(targetDir, entry.Name()))
		if readErr != nil {
			t.Fatal(readErr)
		}
		seen[string(raw)] = true
	}
	for _, want := range []string{"batch-A", "batch-B", "res:batch-A", "res:batch-B"} {
		if !seen[want] {
			t.Fatalf("concurrent batch saves lost %q: %+v", want, seen)
		}
	}
}

func TestSaveOwnedMediaBatchRejectsInvalidInputsAndOverCapInlineBytes(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSaveDir = func(context.Context) (string, error) { return t.TempDir(), nil }

	if _, err := app.SaveOwnedMediaBatch(nil, ""); err == nil {
		t.Fatal("expected error for empty batch")
	}

	oversized := make([]byte, bootstrap.MaxOwnedArtifactBytes/2+1)
	if _, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{
		{FileName: "a.bin", Data: oversized},
		{FileName: "b.bin", Data: oversized},
	}, ""); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("expected inline size cap error, got %v", err)
	}
}

func TestSaveOwnedMediaBatchRespectsLongNamesWithUniqueSuffix(t *testing.T) {
	targetDir := t.TempDir()
	longBase := strings.Repeat("镜", 80) + ".mp4"

	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSaveDir = func(context.Context) (string, error) { return targetDir, nil }
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		return os.WriteFile(destPath, []byte(resourceID), 0o600)
	}

	result, err := app.SaveOwnedMediaBatch([]OwnedMediaBatchItem{
		{FileName: longBase, ResourceID: "r1"},
		{FileName: longBase, ResourceID: "r2"},
	}, "")
	if err != nil || result.Saved != 2 || result.Failed != 0 {
		t.Fatalf("long name batch = %+v err=%v", result, err)
	}
	entries, err := os.ReadDir(targetDir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("entries = %d err=%v, want 2 distinct files", len(entries), err)
	}
	for _, entry := range entries {
		if len(entry.Name()) > bootstrap.MaxSaveFileNameBytes {
			t.Fatalf("filename %q exceeded byte cap (%d > %d)", entry.Name(), len(entry.Name()), bootstrap.MaxSaveFileNameBytes)
		}
	}
}
