package desktopstorage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationCopiesAndVerifiesCompleteWorkspaceAndKeepsSource(t *testing.T) {
	source := filepath.Join(t.TempDir(), "old")
	target := filepath.Join(t.TempDir(), "new")
	for name, value := range map[string]string{"open_ai_canvas.db": "sqlite-fixture", "open_ai_canvas.db-wal": "latest-write", "resources/video.mp4": "media", "local-model-config.json": "encrypted-config", ".settings-key": "test-key", "local-model-config.json.bak": "backup"} {
		path := filepath.Join(source, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := CopyClosedWorkspace(context.Background(), source, target); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"open_ai_canvas.db", "open_ai_canvas.db-wal", "resources/video.mp4", "local-model-config.json", ".settings-key", "local-model-config.json.bak"} {
		before, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(filepath.Join(target, name))
		if err != nil || string(before) != string(after) {
			t.Fatalf("did not preserve %s", name)
		}
	}
	root := t.TempDir()
	if err := Save(root, target, source); err != nil {
		t.Fatal(err)
	}
	if got, err := Resolve(root); err != nil || got != target {
		t.Fatalf("restart selected %q: %v", got, err)
	}
	if err := os.Rename(target, target+"-disconnected"); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root); err == nil {
		t.Fatal("missing selected volume silently became a fresh workspace")
	}
}

func TestMigrationRejectsOverlapExistingDataAndCancellation(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "config"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{source, filepath.Join(source, "child"), filepath.Dir(source)} {
		if _, err := Validate(source, target); err == nil {
			t.Fatalf("accepted overlap %s", target)
		}
	}
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "foreign"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := CopyClosedWorkspace(context.Background(), source, target); err == nil {
		t.Fatal("overwrote occupied target")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	emptyTarget := filepath.Join(t.TempDir(), "cancelled")
	if err := CopyClosedWorkspace(ctx, source, emptyTarget); err == nil {
		t.Fatal("ignored cancellation")
	}
	body, err := os.ReadFile(filepath.Join(source, "config"))
	if err != nil || string(body) != "keep" {
		t.Fatal("source modified on failure")
	}
}

func TestSaveMigrationReplacesReadOnlyLocationAndVerifiesReadback(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profile")
	first := filepath.Join(t.TempDir(), "first")
	second := filepath.Join(t.TempDir(), "second")
	for _, dir := range []string{first, second} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := SaveMigration(root+string(filepath.Separator), first+string(filepath.Separator), root, map[string]string{"db": "abc"}); err != nil {
		t.Fatalf("first SaveMigration: %v", err)
	}
	if err := os.Chmod(filepath.Join(root, locationFile), 0400); err != nil {
		t.Fatalf("chmod read-only: %v", err)
	}
	if err := SaveMigration(root, second, first, map[string]string{"db": "def"}); err != nil {
		t.Fatalf("second SaveMigration over read-only pointer: %v", err)
	}
	got, err := Resolve(root + string(filepath.Separator))
	if err != nil || got != second {
		t.Fatalf("Resolve(root) = %q, err=%v; want %q", got, err, second)
	}
	// UTF-8 BOM and whitespace in storage-location.json must still resolve cleanly.
	bomBody := append([]byte("\xef\xbb\xbf"), []byte(`{"dataDir":"  `+filepath.ToSlash(second)+`  "}`)...)
	if err := os.Chmod(filepath.Join(root, locationFile), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, locationFile), bomBody, 0600); err != nil {
		t.Fatal(err)
	}
	got, err = Resolve(root)
	if err != nil || !SameLocation(got, second) {
		t.Fatalf("Resolve with BOM = %q, err=%v; want %q", got, err, second)
	}
	// Saving a non-existent DataDir must fail without overwriting the existing pointer.
	missing := filepath.Join(t.TempDir(), "missing-target")
	if err := Save(root, missing, second); err == nil {
		t.Fatal("expected Save to fail for missing directory")
	}
	gotAfterFail, err := Resolve(root)
	if err != nil || !SameLocation(gotAfterFail, second) {
		t.Fatalf("Resolve(root) after failed Save = %q, err=%v; want %q", gotAfterFail, err, second)
	}

	// Post-replace sync failure must roll back storage-location.json to previous bytes;
	// if rollback sync itself also fails, ErrLocationRollbackFailed must surface.
	third := filepath.Join(t.TempDir(), "third-target")
	if err := os.MkdirAll(third, 0700); err != nil {
		t.Fatal(err)
	}
	origSync := syncLocationDir
	t.Cleanup(func() { syncLocationDir = origSync })

	calls := 0
	syncLocationDir = func(dir string) error {
		calls++
		if calls == 1 {
			return errors.New("injected post-replace dir sync failure")
		}
		return origSync(dir)
	}
	err = Save(root, third, second)
	if err == nil || errors.Is(err, ErrLocationRollbackFailed) {
		t.Fatalf("expected post-replace error with clean rollback, got %v", err)
	}
	gotAfterRollback, err := Resolve(root)
	if err != nil || !SameLocation(gotAfterRollback, second) {
		t.Fatalf("Resolve(root) after post-replace rollback = %q, err=%v; want %q", gotAfterRollback, err, second)
	}

	syncLocationDir = func(string) error {
		return errors.New("persistent dir sync failure")
	}
	err = Save(root, third, second)
	if !errors.Is(err, ErrLocationRollbackFailed) {
		t.Fatalf("expected ErrLocationRollbackFailed when rollback sync fails, got %v", err)
	}
}
