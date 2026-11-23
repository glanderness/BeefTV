package main

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
)

const (
	mediaClipboardFilePrefix     = "beeftv-clipboard-"
	mediaClipboardStaleMaxAge    = 24 * time.Hour
	darwinMediaClipboardTimeout  = 5 * time.Second
	windowsMediaClipboardTimeout = 15 * time.Second
)

// CopyOwnedMediaToClipboard publishes a separate file, never the workspace
// original: a receiving app may edit or move files obtained from the clipboard.
func (a *DesktopApp) CopyOwnedMediaToClipboard(fileName, resourceID string) error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	a.mediaClipboardMu.Lock()
	defer a.mediaClipboardMu.Unlock()
	a.mu.RLock()
	tempDir, write := a.fallbackTempDirLocked(), a.writeMediaClipboard
	a.mu.RUnlock()
	name := bootstrap.SanitizeSaveFileName(fileName)
	ext := filepath.Ext(name)
	file, err := os.CreateTemp(tempDir, mediaClipboardFilePrefix+strings.TrimSuffix(name, ext)+"-*"+ext)
	if err != nil {
		return errors.New("无法准备待复制的视频文件")
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	published := false
	defer func() {
		if !published {
			_ = os.Remove(path)
		}
	}()
	if err := a.copyMedia(resourceID, path); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return errors.New("应用已关闭，无法复制视频")
	}
	if write == nil {
		write = writeFileToSystemClipboard
	}
	if err := write(ctx, path); err != nil {
		return err
	}
	previous := a.mediaClipboardPath
	a.mediaClipboardPath, published = path, true
	if previous != "" {
		_ = os.Remove(previous)
	}
	cleanupStaleMediaClipboardFiles(tempDir, path, time.Now(), mediaClipboardStaleMaxAge)
	// Keep the current file after shutdown so pasting still works after quitting.
	// It lives in the existing OS temporary location, not in a second media cache.
	return nil
}

func cleanupStaleMediaClipboardFiles(tempDir, keepPath string, now time.Time, maxAge time.Duration) {
	if strings.TrimSpace(tempDir) == "" || maxAge <= 0 {
		return
	}
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), mediaClipboardFilePrefix) || !entry.Type().IsRegular() {
			continue
		}
		candidate := filepath.Join(tempDir, entry.Name())
		if candidate == keepPath {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) >= maxAge {
			_ = os.Remove(candidate)
		}
	}
}

func writeFileToSystemClipboard(parent context.Context, path string) error {
	timeout := darwinMediaClipboardTimeout
	if runtime.GOOS == "windows" {
		timeout = windowsMediaClipboardTimeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd, err := buildClipboardWriteCommand(ctx, runtime.GOOS, path)
	if err != nil {
		return err
	}
	if err := cmd.Run(); err != nil {
		return errors.New("视频复制失败，请检查系统剪贴板权限后重试")
	}
	return nil
}

func buildClipboardWriteCommand(ctx context.Context, goos, path string) (*exec.Cmd, error) {
	return buildClipboardWriteCommandWithEnv(ctx, goos, path, os.Getenv, exec.LookPath)
}

func buildClipboardWriteCommandWithEnv(
	ctx context.Context,
	goos, path string,
	getenv func(string) string,
	lookPath func(string) (string, error),
) (*exec.Cmd, error) {
	switch goos {
	case "darwin":
		// Arguments are passed separately; node names never become script source.
		const script = `ObjC.import('AppKit');
function run(args) {
    const file = $.NSURL.fileURLWithPath($(args[0]));
    const board = $.NSPasteboard.generalPasteboard;
    board.clearContents;
    if (!board.writeObjects($([file]))) throw new Error('clipboard write failed');
}`
		return exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", script, path), nil
	case "windows":
		const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($env:BEEFTV_CLIPBOARD_FILE); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`
		cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
		cmd.Env = append(os.Environ(), "BEEFTV_CLIPBOARD_FILE="+path)
		hideMediaClipboardCommandWindow(cmd)
		return cmd, nil
	case "linux":
		return buildLinuxClipboardWriteCommand(ctx, path, getenv, lookPath)
	default:
		return nil, errors.New("当前系统暂不支持复制视频文件，请使用下载")
	}
}

func buildLinuxClipboardWriteCommand(
	ctx context.Context,
	path string,
	getenv func(string) string,
	lookPath func(string) (string, error),
) (*exec.Cmd, error) {
	clean := pathpkg.Clean(strings.TrimSpace(path))
	if clean == "" || !strings.HasPrefix(clean, "/") {
		return nil, errors.New("待复制的视频文件路径无效")
	}
	uriList := (&url.URL{Scheme: "file", Path: clean}).String() + "\r\n"
	hasWayland := strings.TrimSpace(getenv("WAYLAND_DISPLAY")) != "" || strings.EqualFold(strings.TrimSpace(getenv("XDG_SESSION_TYPE")), "wayland")
	hasX11 := strings.TrimSpace(getenv("DISPLAY")) != ""
	if !hasWayland && !hasX11 {
		return nil, errors.New("未检测到 Linux 桌面剪贴板会话，无法复制视频文件，请使用下载")
	}
	if hasWayland {
		if bin, err := lookPath("wl-copy"); err == nil && bin != "" {
			cmd := exec.CommandContext(ctx, bin, "--type", "text/uri-list")
			cmd.Stdin = strings.NewReader(uriList)
			return cmd, nil
		}
		if hasX11 {
			if bin, err := lookPath("xclip"); err == nil && bin != "" {
				cmd := exec.CommandContext(ctx, bin, "-selection", "clipboard", "-t", "text/uri-list")
				cmd.Stdin = strings.NewReader(uriList)
				return cmd, nil
			}
		}
		return nil, errors.New("Linux 复制视频文件需要安装 wl-copy（wl-clipboard）或 xclip，安装后重试，或直接使用下载")
	}
	if bin, err := lookPath("xclip"); err == nil && bin != "" {
		cmd := exec.CommandContext(ctx, bin, "-selection", "clipboard", "-t", "text/uri-list")
		cmd.Stdin = strings.NewReader(uriList)
		return cmd, nil
	}
	return nil, errors.New("Linux 复制视频文件需要安装 xclip，安装后重试，或直接使用下载")
}
