package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"infinite-canvas/backend/internal/bootstrap"
	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/diagnostics"

	"github.com/wailsapp/wails/v2/pkg/menu"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	crashSentinelFileName      = ".session-running"
	lastCrashReadyEventName    = "diagnostics:last-crash-ready"
	requestReloadEventName     = "desktop:request-reload"
	reloadAckEventName         = "desktop:reload-ack"
	rendererGracefulReloadWait = 1500 * time.Millisecond
)

type crashSentinelRecord struct {
	PID        int    `json:"pid"`
	StartedAt  string `json:"startedAt"`
	AppVersion string `json:"appVersion"`
}

func crashSentinelPath(dataDir string) string {
	clean := strings.TrimSpace(dataDir)
	if clean == "" {
		return ""
	}
	return filepath.Join(clean, crashSentinelFileName)
}

func (a *DesktopApp) checkAndArmCrashSentinel(dataDir, fallbackTemp, launchID string, rt *bootstrap.Runtime) {
	path := crashSentinelPath(dataDir)
	if path == "" {
		return
	}
	unclean := false
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		unclean = true
	}
	record := crashSentinelRecord{
		PID:        os.Getpid(),
		StartedAt:  time.Now().UTC().Format(time.RFC3339Nano),
		AppVersion: buildinfo.Current().Version,
	}
	if encoded, err := json.Marshal(record); err == nil {
		_ = os.WriteFile(path, encoded, 0o600)
	}
	if !unclean {
		return
	}
	_ = diagnostics.AppendBootLogEntry(dataDir, diagnostics.BootLogEntry{
		ID:        newDesktopBootID("boot"),
		LaunchID:  launchID,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		State:     "ready",
		Phase:     "ready",
		Reason:    "unclean_previous_session",
	})
	a.mu.Lock()
	a.uncleanPreviousSession = true
	a.mu.Unlock()

	go func() {
		req := diagnostics.ExportRequest{
			Description: "检测到上次异常退出，自动留存后端诊断摘要。",
		}
		var (
			bundle *diagnostics.Bundle
			err    error
		)
		if rt != nil {
			bundle, err = rt.ExportDiagnosticsBundle(req)
		}
		if err != nil || bundle == nil {
			return
		}
		bundle.FileName = strings.Replace(bundle.FileName, "-diagnostics-", "-last-crash-diagnostics-", 1)
		saved := writeStartupDiagnosticSnapshot(dataDir, fallbackTemp, false, bundle)
		if saved != "" {
			a.mu.Lock()
			a.lastCrashDiagnosticPath = saved
			a.lastDiagnosticPath = saved
			wailsCtx := a.wailsCtx
			a.mu.Unlock()
			if wailsCtx != nil && wailsCtx.Value("frontend") != nil {
				wailsruntime.EventsEmit(wailsCtx, lastCrashReadyEventName, saved)
			}
		}
	}()
}

func (a *DesktopApp) clearCrashSentinel() {
	a.mu.RLock()
	path := crashSentinelPath(a.dataDir)
	a.mu.RUnlock()
	if path != "" {
		_ = os.Remove(path)
	}
}

// ExportRuntimeDiagnosticsToDownloads exports a Go-side diagnostic bundle
// directly to the Downloads folder (or Save dialog / local diagnostics folder)
// without passing large ZIP blobs through HTTP or WebView renderer memory.
// It works even when the renderer is frozen or crashed.
func (a *DesktopApp) ExportRuntimeDiagnosticsToDownloads(clientPayload string) (string, error) {
	var req diagnostics.ExportRequest
	trimmed := strings.TrimSpace(clientPayload)
	if trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &req); err != nil {
			req.Description = trimmed
		}
	}
	if rt := a.runtime(); rt != nil {
		bundle, err := rt.ExportDiagnosticsBundle(req)
		if err != nil {
			return "", err
		}
		a.mu.RLock()
		dataDir := a.dataDir
		fallbackTemp := a.fallbackTempDirLocked()
		a.mu.RUnlock()
		autoPath := writeStartupDiagnosticSnapshot(dataDir, fallbackTemp, false, bundle)
		return a.saveAndRevealDiagnosticZip(bundle.FileName, bundle.Data, autoPath)
	}
	return a.ExportStartupDiagnostics(clientPayload)
}

// ReloadWindow reloads the WebView window. It arms one-shot safeMode in Go
// state, notifies a live renderer to ack via Wails event and flush workspace
// saves before reloading, and falls back to native browser-process reload
// after 1.5s ONLY if the renderer failed to ack.
func (a *DesktopApp) ReloadWindow(safeMode bool) error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	if rt := a.runtime(); rt != nil {
		rt.RequestSafeMode(safeMode)
	}
	emitFn := a.emitReloadEvent
	subAckFn := a.subscribeReloadAck
	nativeFn := a.nativeReloadFn
	if emitFn == nil {
		if ctx.Value("frontend") == nil {
			return nil
		}
		emitFn = func(c context.Context, payload map[string]any) {
			wailsruntime.EventsEmit(c, requestReloadEventName, payload)
		}
	}
	if subAckFn == nil && ctx.Value("frontend") != nil {
		subAckFn = func(c context.Context, onAck func()) func() {
			return wailsruntime.EventsOnce(c, reloadAckEventName, func(...any) {
				onAck()
			})
		}
	}
	if nativeFn == nil {
		nativeFn = func(c context.Context) {
			if c.Value("frontend") != nil {
				wailsruntime.WindowReload(c)
			}
		}
	}
	wait := a.gracefulReloadWait
	if wait <= 0 {
		wait = rendererGracefulReloadWait
	}
	acked := make(chan struct{}, 1)
	var unsub func()
	if subAckFn != nil {
		unsub = subAckFn(ctx, func() {
			select {
			case acked <- struct{}{}:
			default:
			}
		})
	}
	emitFn(ctx, map[string]any{"safeMode": safeMode})
	go func() {
		defer func() {
			if unsub != nil {
				unsub()
			}
		}()
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-acked:
			return
		case <-timer.C:
			nativeFn(ctx)
		}
	}()
	return nil
}

func desktopApplicationMenu(app *DesktopApp) *menu.Menu {
	// Keep Windows dark chrome completely clean (setting a top-level Win32 menu
	// bar adds a light system strip inside the window). macOS puts menus in the
	// global OS menu bar so we preserve standard App + Edit menus plus our
	// troubleshooting submenu.
	if runtime.GOOS != "darwin" {
		return nil
	}
	root := menu.NewMenu()
	root.Append(menu.AppMenu())
	root.Append(menu.EditMenu())
	troubleshoot := root.AddSubmenu("故障排查")
	troubleshoot.AddText("导出诊断包（不含前端日志）", nil, func(_ *menu.CallbackData) {
		go func() {
			if _, err := app.ExportRuntimeDiagnosticsToDownloads(""); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("原生菜单导出诊断包失败: %v", err)
			}
		}()
	})
	troubleshoot.AddSeparator()
	troubleshoot.AddText("重新加载窗口", nil, func(_ *menu.CallbackData) {
		_ = app.ReloadWindow(false)
	})
	troubleshoot.AddText("安全模式重新加载（仅缩略图）", nil, func(_ *menu.CallbackData) {
		_ = app.ReloadWindow(true)
	})
	troubleshoot.AddSeparator()
	troubleshoot.AddText("打开数据与日志目录", nil, func(_ *menu.CallbackData) {
		_ = app.OpenUpdateLogDirectory()
	})
	return root
}
