package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNativeMediaFileClipboard(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("BEEFTV_TEST_NATIVE_FILE_CLIPBOARD") != "1" {
		t.Skip("explicit opt-in required: this test changes the system clipboard")
	}
	path := filepath.Join(t.TempDir(), "片段 '中文'.mp4")
	if err := os.WriteFile(path, []byte("original media payload"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeFileToSystemClipboard(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	const read = `ObjC.import('AppKit'); const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey:true})); if (!urls || Number(urls.count) !== 1) throw new Error('no copied file'); ObjC.unwrap(urls.objectAtIndex(0).path);`
	output, err := exec.Command("/usr/bin/osascript", "-l", "JavaScript", "-e", read).CombinedOutput()
	if err != nil {
		t.Fatalf("reading native file clipboard: %s, %v", output, err)
	}
	if strings.TrimSpace(string(output)) != path {
		t.Fatalf("clipboard file mismatch: %s", output)
	}
}

func TestCopyOwnedMediaToClipboardStagesIndependentFile(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.tempDir = t.TempDir()
	app.copyOwnedMedia = func(id, dest string) error {
		if id != "owned-video" {
			t.Fatalf("unexpected resource %q", id)
		}
		return os.WriteFile(dest, []byte("original video bytes"), 0600)
	}
	var previous string
	app.writeMediaClipboard = func(_ context.Context, path string) error {
		body, err := os.ReadFile(path)
		if err != nil || string(body) != "original video bytes" {
			t.Fatalf("clipboard source: %q, %v", body, err)
		}
		if filepath.Dir(path) != app.tempDir || filepath.Ext(path) != ".mp4" || !strings.Contains(filepath.Base(path), "场景1") {
			t.Fatalf("unsafe staging path: %s", path)
		}
		previous = path
		return nil
	}
	if err := app.CopyOwnedMediaToClipboard("../../场景1.mp4", "owned-video"); err != nil {
		t.Fatal(err)
	}
	first := previous
	if err := app.CopyOwnedMediaToClipboard("场景1.mp4", "owned-video"); err != nil {
		t.Fatal(err)
	}
	if first == previous {
		t.Fatal("clipboard copy reused a file still exposed externally")
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatal("superseded clipboard copy was not cleaned")
	}
	if _, err := os.Stat(previous); err != nil {
		t.Fatal("current clipboard copy must remain available", err)
	}
}

func TestCopyOwnedMediaToClipboardFailuresDoNotPublishOrLeavePartialFiles(t *testing.T) {
	for _, failCopy := range []bool{true, false} {
		t.Run(map[bool]string{true: "resource rejected", false: "clipboard rejected"}[failCopy], func(t *testing.T) {
			app := newDesktopApp(t.TempDir())
			app.wailsCtx = context.Background()
			app.tempDir = t.TempDir()
			writes := 0
			app.copyOwnedMedia = func(_, dest string) error {
				if failCopy {
					return errors.New("unowned resource")
				}
				return os.WriteFile(dest, []byte("video"), 0600)
			}
			app.writeMediaClipboard = func(context.Context, string) error { writes++; return errors.New("clipboard denied") }
			if err := app.CopyOwnedMediaToClipboard("video.mp4", "resource"); err == nil {
				t.Fatal("failure was swallowed")
			}
			if failCopy && writes != 0 {
				t.Fatal("unowned resource reached clipboard")
			}
			files, err := os.ReadDir(app.tempDir)
			if err != nil || len(files) != 0 {
				t.Fatal("partial clipboard files remain", files, err)
			}
		})
	}
}

func TestCopyOwnedMediaToClipboardRequiresLiveApp(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.CopyOwnedMediaToClipboard("video.mp4", "resource"); err == nil {
		t.Fatal("unstarted app accepted copy")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	app.wailsCtx = ctx
	if err := app.CopyOwnedMediaToClipboard("video.mp4", "resource"); err == nil {
		t.Fatal("closed app accepted copy")
	}
}

func TestCopyOwnedMediaToClipboardChecksOwnershipAndProtectsOriginal(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.startup(context.Background())
	defer app.shutdown(context.Background())
	app.tempDir = t.TempDir()
	resourceID := uploadDesktopResource(t, app, []byte("original video"))
	var received string
	app.writeMediaClipboard = func(_ context.Context, path string) error { received = path; return nil }
	for _, rejected := range []string{"../secret", "missing-resource"} {
		if err := app.CopyOwnedMediaToClipboard("video.mp4", rejected); err == nil {
			t.Fatal("unowned resource was accepted")
		}
		if received != "" {
			t.Fatal("unowned resource reached system clipboard")
		}
	}
	if err := app.CopyOwnedMediaToClipboard("video.mp4", resourceID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(received, []byte("external editor changed the copied file"), 0600); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(desktopResourcePath(t, app, resourceID))
	if err != nil || string(original) != "original video" {
		t.Fatal("clipboard recipient altered the workspace original", err)
	}
}
