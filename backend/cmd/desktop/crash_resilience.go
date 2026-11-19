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
	crashSentinelFileName        = ".session-running"
	lastCrashReadyEventName      = "diagnostics:last-crash-ready"
	rendererWatchdogInterval     = 5 * time.Second
	rendererHeartbeatTimeout     = 35 * time.Second
	rendererBusyHeartbeatTimeout = 180 * time.Second
	rendererReloadBreakerLimit   = 3
	rendererReloadBreakerSpan    = 60 * time.Second
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

// ReloadWindow reloads the WebView window. Before reloading it best-effort
// invokes any registered frontend flush hook, and when safeMode is true it
// preserves the active pathname/hash/query while adding safeMode=1 and
// memoryMode=thumbnail-only.
func (a *DesktopApp) ReloadWindow(safeMode bool) error {
	ctx, err := a.dialogContext()
	if err != nil {
		return err
	}
	if ctx.Value("frontend") == nil {
		return nil
	}
	if safeMode {
		wailsruntime.WindowExecJS(ctx, `(function(){
			try { if (typeof window.__BEEFTV_FLUSH_BEFORE_RELOAD__ === "function") { window.__BEEFTV_FLUSH_BEFORE_RELOAD__(); } } catch (_) {}
			try {
				var u = new URL(window.location.href);
				u.searchParams.set("safeMode", "1");
				u.searchParams.set("memoryMode", "thumbnail-only");
				window.location.href = u.toString();
			} catch (_) {
				window.location.href = "/?safeMode=1&memoryMode=thumbnail-only";
			}
		})();`)
		return nil
	}
	wailsruntime.WindowExecJS(ctx, `(function(){ try { if (typeof window.__BEEFTV_FLUSH_BEFORE_RELOAD__ === "function") { window.__BEEFTV_FLUSH_BEFORE_RELOAD__(); } } catch (_) {} })();`)
	wailsruntime.WindowReload(ctx)
	return nil
}

// allowAutomaticRendererReload evaluates the sliding-window circuit breaker
// (max 3 recovery reloads in 60s). Returns false once the limit is reached.
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

type rendererWatchdogState struct {
	stalledWhileHidden bool
	promptCooldownTill time.Time
}

// evaluateRendererWatchdog decides whether the host should prompt the user for
// unresponsive-renderer recovery. It never silently reloads an active session:
// legitimate long tasks (busy lease) get an extended ceiling, and stalls that
// begin while hidden are retained until the window becomes visible again.
func (s *rendererWatchdogState) evaluate(now, lastBeat time.Time, hidden, busy bool) bool {
	if lastBeat.IsZero() {
		return false
	}
	timeout := rendererHeartbeatTimeout
	if busy {
		timeout = rendererBusyHeartbeatTimeout
	}
	stale := now.Sub(lastBeat) > timeout
	if hidden {
		if stale {
			s.stalledWhileHidden = true
		}
		return false
	}
	if !stale {
		s.stalledWhileHidden = false
		return false
	}
	if !s.promptCooldownTill.IsZero() && now.Before(s.promptCooldownTill) {
		return false
	}
	// Either stalled while visible or returned visible after stalling hidden.
	s.stalledWhileHidden = false
	s.promptCooldownTill = now.Add(timeout)
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
		var state rendererWatchdogState
		promptCh := make(chan struct{}, 1)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				lastBeat, hidden, busy := rt.LastClientHeartbeat()
				now := time.Now().UTC()
				if !state.evaluate(now, lastBeat, hidden, busy) {
					continue
				}
				select {
				case promptCh <- struct{}{}:
				default:
					// A recovery dialog is already open.
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
					Timestamp: now.Format(time.RFC3339Nano),
					State:     "ready",
					Phase:     "ready",
					Reason:    "renderer_unresponsive",
				})
				repeated := !a.allowAutomaticRendererReload(now)
				if repeated {
					log.Printf("渲染进程在 60s 内连续无响应达到保护阈值，提示用户选择导出或安全模式")
				} else {
					log.Printf("检测到渲染进程超过 %s 未响应，提示用户选择继续等待、导出诊断包或安全模式重载", rendererHeartbeatTimeout)
				}
				if wailsCtx != nil && wailsCtx.Value("frontend") != nil {
					go func(isRepeated bool) {
						defer func() { <-promptCh }()
						a.promptCrashRecoveryDialog(wailsCtx, isRepeated)
					}(repeated)
				} else {
					<-promptCh
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
	case "安全模式重载", "安全模式重启", "No":
		return "safe-reload"
	default:
		return "cancel"
	}
}

func (a *DesktopApp) promptCrashRecoveryDialog(ctx context.Context, repeated bool) {
	title := "页面暂时无响应"
	message := "检测到界面长时间未响应。您可以继续等待当前操作完成，或直接由后台导出诊断包、以仅缩略图安全模式重载当前页面。"
	if repeated {
		title = "页面多次无响应"
		message = "检测到界面在短时间内多次无响应或崩溃。建议先直接导出后端诊断包，或以仅缩略图安全模式重新加载。"
	}
	if runtime.GOOS == "windows" {
		if repeated {
			message = "检测到界面在短时间内多次无响应或崩溃。\n\n点击「是」立即直接导出后端诊断包到下载目录（不依赖页面）；点击「否」以仅缩略图安全模式重新加载当前页面；点击「取消」继续等待。"
		} else {
			message = "检测到界面长时间未响应。\n\n点击「是」立即直接导出后端诊断包到下载目录（不依赖页面）；点击「否」以仅缩略图安全模式重新加载当前页面；点击「取消」继续等待当前操作完成。"
		}
	}
	choice, err := wailsruntime.MessageDialog(ctx, wailsruntime.MessageDialogOptions{
		Type:          wailsruntime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"导出诊断包", "安全模式重载", "继续等待"},
		DefaultButton: "继续等待",
		CancelButton:  "继续等待",
	})
	if err != nil {
		return
	}
	switch crashRecoveryDialogAction(choice) {
	case "export":
		if path, exportErr := a.ExportRuntimeDiagnosticsToDownloads(""); exportErr != nil {
			log.Printf("导出诊断包失败: %v", exportErr)
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
