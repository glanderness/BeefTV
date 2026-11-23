package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
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
	file, err := os.CreateTemp(tempDir, "beeftv-clipboard-"+strings.TrimSuffix(name, ext)+"-*"+ext)
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
	// Keep the current file after shutdown so pasting still works after quitting.
	// It lives in the existing OS temporary location, not in a second media cache.
	return nil
}

func writeFileToSystemClipboard(parent context.Context, path string) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		// Arguments are passed separately; node names never become script source.
		const script = `ObjC.import('AppKit');
function run(args) {
    const file = $.NSURL.fileURLWithPath($(args[0]));
    const board = $.NSPasteboard.generalPasteboard;
    board.clearContents;
    if (!board.writeObjects($([file]))) throw new Error('clipboard write failed');
}`
		cmd = exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", script, path)
	case "windows":
		const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($env:BEEFTV_CLIPBOARD_FILE); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`
		cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
		cmd.Env = append(os.Environ(), "BEEFTV_CLIPBOARD_FILE="+path)
	default:
		return errors.New("当前系统暂不支持复制视频文件，请使用下载")
	}
	if err := cmd.Run(); err != nil {
		return errors.New("视频复制失败，请检查系统剪贴板权限后重试")
	}
	return nil
}
