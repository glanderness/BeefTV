package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
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

func TestCopyOwnedMediaToClipboardCleansStaleTempFilesAcrossRestarts(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.tempDir = t.TempDir()
	stale := filepath.Join(app.tempDir, mediaClipboardFilePrefix+"old-123.mp4")
	fresh := filepath.Join(app.tempDir, mediaClipboardFilePrefix+"recent-456.mp4")
	unrelated := filepath.Join(app.tempDir, "other-temp-file.mp4")
	for _, file := range []string{stale, fresh, unrelated} {
		if err := os.WriteFile(file, []byte("bytes"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	oldTime := time.Now().Add(-mediaClipboardStaleMaxAge - time.Minute)
	if err := os.Chtimes(stale, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(unrelated, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	app.copyOwnedMedia = func(_, dest string) error { return os.WriteFile(dest, []byte("new"), 0600) }
	var current string
	app.writeMediaClipboard = func(_ context.Context, path string) error { current = path; return nil }
	if err := app.CopyOwnedMediaToClipboard("clip.mp4", "owned-video"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale clipboard temp file from previous session was not removed")
	}
	for _, kept := range []string{fresh, unrelated, current} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("expected file to remain: %s (%v)", kept, err)
		}
	}
}

func TestBuildClipboardWriteCommandCoversPlatforms(t *testing.T) {
	darwinCmd, err := buildClipboardWriteCommand(context.Background(), "darwin", "/tmp/clip.mp4")
	if err != nil || !strings.HasSuffix(darwinCmd.Path, "osascript") {
		t.Fatalf("darwin command = %+v, err = %v", darwinCmd, err)
	}
	winCmd, err := buildClipboardWriteCommand(context.Background(), "windows", `C:\tmp\clip.mp4`)
	if err != nil || !strings.Contains(strings.ToLower(winCmd.Path), "powershell") {
		t.Fatalf("windows command = %+v, err = %v", winCmd, err)
	}
	if _, err := buildClipboardWriteCommand(context.Background(), "freebsd", "/tmp/clip.mp4"); err == nil {
		t.Fatal("unsupported OS should report error")
	}
}

func TestBuildLinuxClipboardWriteCommandBackends(t *testing.T) {
	const videoPath = "/tmp/beeftv-clipboard-场景 1.mp4"
	const expectedURI = "file:///tmp/beeftv-clipboard-%E5%9C%BA%E6%99%AF%201.mp4\r\n"

	readStdin := func(t *testing.T, cmd *exec.Cmd) string {
		t.Helper()
		if cmd.Stdin == nil {
			t.Fatal("expected stdin URI list")
		}
		data, err := io.ReadAll(cmd.Stdin)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}

	t.Run("wayland prefers wl-copy", func(t *testing.T) {
		cmd, err := buildClipboardWriteCommandWithEnv(
			context.Background(),
			"linux",
			videoPath,
			func(key string) string { return map[string]string{"WAYLAND_DISPLAY": "wayland-0"}[key] },
			func(name string) (string, error) {
				if name == "wl-copy" {
					return "/usr/bin/wl-copy", nil
				}
				return "", exec.ErrNotFound
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if cmd.Path != "/usr/bin/wl-copy" || strings.Join(cmd.Args[1:], " ") != "--type text/uri-list" {
			t.Fatalf("unexpected wl-copy command: %+v", cmd.Args)
		}
		if got := readStdin(t, cmd); got != expectedURI {
			t.Fatalf("uri list = %q, want %q", got, expectedURI)
		}
	})

	t.Run("wayland falls back to xclip on xwayland", func(t *testing.T) {
		cmd, err := buildClipboardWriteCommandWithEnv(
			context.Background(),
			"linux",
			videoPath,
			func(key string) string {
				return map[string]string{"WAYLAND_DISPLAY": "wayland-0", "DISPLAY": ":0"}[key]
			},
			func(name string) (string, error) {
				if name == "xclip" {
					return "/usr/bin/xclip", nil
				}
				return "", exec.ErrNotFound
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if cmd.Path != "/usr/bin/xclip" || strings.Join(cmd.Args[1:], " ") != "-selection clipboard -t text/uri-list" {
			t.Fatalf("unexpected xclip command: %+v", cmd.Args)
		}
		if got := readStdin(t, cmd); got != expectedURI {
			t.Fatalf("uri list = %q, want %q", got, expectedURI)
		}
	})

	t.Run("x11 uses xclip", func(t *testing.T) {
		cmd, err := buildClipboardWriteCommandWithEnv(
			context.Background(),
			"linux",
			videoPath,
			func(key string) string { return map[string]string{"DISPLAY": ":0"}[key] },
			func(name string) (string, error) {
				if name == "xclip" {
					return "/usr/bin/xclip", nil
				}
				return "", exec.ErrNotFound
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		if cmd.Path != "/usr/bin/xclip" {
			t.Fatalf("unexpected x11 command: %+v", cmd.Args)
		}
		if got := readStdin(t, cmd); got != expectedURI {
			t.Fatalf("uri list = %q, want %q", got, expectedURI)
		}
	})

	t.Run("missing tools and headless session return actionable errors", func(t *testing.T) {
		if _, err := buildClipboardWriteCommandWithEnv(
			context.Background(),
			"linux",
			videoPath,
			func(key string) string { return map[string]string{"WAYLAND_DISPLAY": "wayland-0"}[key] },
			func(string) (string, error) { return "", exec.ErrNotFound },
		); err == nil || !strings.Contains(err.Error(), "wl-copy") {
			t.Fatalf("expected actionable wl-copy error, got %v", err)
		}
		if _, err := buildClipboardWriteCommandWithEnv(
			context.Background(),
			"linux",
			videoPath,
			func(string) string { return "" },
			func(string) (string, error) { return "/usr/bin/xclip", nil },
		); err == nil || !strings.Contains(err.Error(), "桌面剪贴板会话") {
			t.Fatalf("expected headless session error, got %v", err)
		}
	})
}
