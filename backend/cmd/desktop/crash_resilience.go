package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	rendererWatchdogInterval   = 5 * time.Second
	rendererHeartbeatTimeout   = 25 * time.Second
	rendererReloadBreakerLimit = 3
	rendererReloadBreakerSpan  = 60 * time.Second
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
			a.mu.Unlock()
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

// ReloadWindow reloads the WebView window. When safeMode is true, it navigates
// to the root route with thumbnail-only safe-mode query parameters.
func (a *DesktopApp) ReloadWindow(safeMode bool) error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	if ctx.Value("frontend") == nil {
		return nil
	}
	if safeMode {
		wailsruntime.WindowExecJS(ctx, `window.location.href = "/?safeMode=1&memoryMode=thumbnail-only";`)
		return nil
	}
	wailsruntime.WindowReload(ctx)
	return nil
}

// RecordRendererReload evaluates the sliding-window circuit breaker (max 3
// automatic reloads in 60s). Returns true if auto-reload is allowed.
func (a *DesktopApp) allowAutomaticRendererReload(now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	cutoff := now.Add(-rendererReloadBreakerSpan)
	kept := a.reloadHistory[:0]
	for _, stamp := range a.reloadHistory {
		if stamp.After(cutoff) {
			kept = append(kept, stamp)
		}
	}
	if len(kept) >= rendererReloadBreakerLimit {
		a.reloadHistory = kept
		return false
	}
	a.reloadHistory = append(kept, now)
	return true
}

func (a *DesktopApp) startRendererWatchdog(rt *bootstrap.Runtime) {
	a.stopRendererWatchdog()
	if rt == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.watchdogStop = cancel
	a.mu.Unlock()

	go func() {
		ticker := time.NewTicker(rendererWatchdogInterval)
		defer ticker.Stop()
		breakerTripped := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				lastBeat, hidden := rt.LastClientHeartbeat()
				if lastBeat.IsZero() || hidden {
					// Renderer has not opted into heartbeats yet or window is hidden/minimized.
					continue
				}
				if time.Since(lastBeat) <= rendererHeartbeatTimeout {
					breakerTripped = false
					continue
				}
				if breakerTripped {
					continue
				}
				a.mu.RLock()
				dataDir := a.dataDir
				launchID := a.boot.launchID
				wailsCtx := a.wailsCtx
				a.mu.RUnlock()
				_ = diagnostics.AppendBootLogEntry(dataDir, diagnostics.BootLogEntry{
					ID:        newDesktopBootID("boot"),
					LaunchID:  launchID,
					Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
					State:     "ready",
					Phase:     "ready",
					Reason:    "renderer_unresponsive",
				})
				if a.allowAutomaticRendererReload(time.Now().UTC()) {
					rt.RecordClientHeartbeat(false)
					if wailsCtx != nil && wailsCtx.Value("frontend") != nil {
						log.Printf("检测到渲染进程无响应（>25s 未收到心跳），自动重新加载窗口")
						wailsruntime.WindowReload(wailsCtx)
					}
					continue
				}
				breakerTripped = true
				log.Printf("渲染进程在 60s 内连续异常 3 次，触发保护熔断")
				if wailsCtx != nil && wailsCtx.Value("frontend") != nil {
					go a.promptCrashRecoveryDialog(wailsCtx)
				}
			}
		}
	}()
}

func (a *DesktopApp) stopRendererWatchdog() {
	a.mu.Lock()
	cancel := a.watchdogStop
	a.watchdogStop = nil
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func crashRecoveryDialogAction(choice string) string {
	switch strings.TrimSpace(choice) {
	case "导出诊断包", "Yes", "Ok":
		return "export"
	case "安全模式重启", "No":
		return "safe-reload"
	default:
		return "cancel"
	}
}

func (a *DesktopApp) promptCrashRecoveryDialog(ctx context.Context) {
	message := "检测到界面在短时间内多次无响应或崩溃。是否立即直接导出后端诊断包到下载目录（不依赖页面）？"
	if runtime.GOOS == "windows" {
		message = "检测到界面在短时间内多次无响应或崩溃。\n\n点击「是」立即直接导出后端诊断包到下载目录（不依赖页面）；点击「否」以仅缩略图安全模式重新加载窗口。"
	}
	choice, err := wailsruntime.MessageDialog(ctx, wailsruntime.MessageDialogOptions{
		Type:          wailsruntime.QuestionDialog,
		Title:         "页面多次无响应",
		Message:       message,
		Buttons:       []string{"导出诊断包", "安全模式重启", "取消"},
		DefaultButton: "导出诊断包",
		CancelButton:  "取消",
	})
	if err != nil {
		return
	}
	switch crashRecoveryDialogAction(choice) {
	case "export":
		if path, exportErr := a.ExportRuntimeDiagnosticsToDownloads(""); exportErr != nil {
			log.Printf("熔断后导出诊断包失败: %v", exportErr)
		} else if path != "" {
			_, _ = wailsruntime.MessageDialog(ctx, wailsruntime.MessageDialogOptions{
				Type:    wailsruntime.InfoDialog,
				Title:   "诊断包已导出",
				Message: fmt.Sprintf("诊断包已直接保存到：\n%s", path),
			})
		}
	case "safe-reload":
		_ = a.ReloadWindow(true)
	}
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
