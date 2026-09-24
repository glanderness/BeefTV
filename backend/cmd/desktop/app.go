package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/bootstrap"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type DesktopRuntimeConfig struct {
	BaseURL     string `json:"baseURL"`
	LaunchToken string `json:"launchToken"`
}

type DesktopApp struct {
	mu                    sync.RWMutex
	dataDir               string
	wailsContext          context.Context
	chooseExportDirectory func(context.Context) (string, error)
}

type DesktopExportResult struct {
	Canceled bool   `json:"canceled"`
	Path     string `json:"path"`
}

// Wails reflects every field type reachable from a bound object. Keeping the
// backend Runtime inside DesktopApp caused reflection to retain the legacy
// Service's entire exported compatibility surface. The registry keeps that runtime
// private to the host process while the bound object exposes only its tiny API.
var (
	desktopRuntimeRegistryMu sync.RWMutex
	desktopRuntimeRegistry   = make(map[*DesktopApp]*bootstrap.Runtime)
)

func (a *DesktopApp) runtime() *bootstrap.Runtime {
	desktopRuntimeRegistryMu.RLock()
	defer desktopRuntimeRegistryMu.RUnlock()
	return desktopRuntimeRegistry[a]
}

type desktopAssetHandler struct {
	app *DesktopApp
}

func newDesktopApp(dataDir string) *DesktopApp {
	return &DesktopApp{
		dataDir: dataDir,
		chooseExportDirectory: func(ctx context.Context) (string, error) {
			return wailsruntime.OpenDirectoryDialog(ctx, wailsruntime.OpenDialogOptions{
				Title:                "选择导出文件夹",
				CanCreateDirectories: true,
			})
		},
	}
}

func (a *DesktopApp) start(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.runtime() != nil {
		return nil
	}
	listenAddr := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_BACKEND_ADDR"))
	if listenAddr == "" {
		listenAddr = "127.0.0.1:0"
	}
	runtime, err := bootstrap.Open(ctx, bootstrap.Config{
		Profile:         bootstrap.ProfileDesktop,
		DataDir:         a.dataDir,
		DatabaseDriver:  "sqlite",
		ListenAddr:      listenAddr,
		LaunchToken:     strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_LAUNCH_TOKEN")),
		AutoMigrate:     true,
		ShutdownTimeout: 10 * time.Minute,
	})
	if err != nil {
		return err
	}
	if err := runtime.Start(); err != nil {
		_ = runtime.Close(context.Background())
		return err
	}
	desktopRuntimeRegistryMu.Lock()
	desktopRuntimeRegistry[a] = runtime
	desktopRuntimeRegistryMu.Unlock()
	return nil
}

func (a *DesktopApp) stop(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	runtime := a.runtime()
	if runtime == nil {
		return nil
	}
	err := runtime.Close(ctx)
	desktopRuntimeRegistryMu.Lock()
	delete(desktopRuntimeRegistry, a)
	desktopRuntimeRegistryMu.Unlock()
	return err
}

func (a *DesktopApp) RuntimeConfig() DesktopRuntimeConfig {
	a.mu.RLock()
	defer a.mu.RUnlock()
	runtime := a.runtime()
	if runtime == nil {
		return DesktopRuntimeConfig{}
	}
	return DesktopRuntimeConfig{BaseURL: runtime.BaseURL(), LaunchToken: runtime.LaunchToken()}
}

func (a *DesktopApp) ExportResource(resourceID string, fileName string) (DesktopExportResult, error) {
	a.mu.RLock()
	ctx := a.wailsContext
	chooseDirectory := a.chooseExportDirectory
	a.mu.RUnlock()
	if ctx == nil {
		ctx = context.Background()
	}
	directory, err := chooseDirectory(ctx)
	if err != nil {
		return DesktopExportResult{}, fmt.Errorf("选择导出文件夹：%w", err)
	}
	if strings.TrimSpace(directory) == "" {
		return DesktopExportResult{Canceled: true}, nil
	}
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return DesktopExportResult{}, fmt.Errorf("导出资源 ID 不能为空")
	}
	fileName, err = safeExportFileName(fileName)
	if err != nil {
		return DesktopExportResult{}, err
	}
	if err := a.start(ctx); err != nil {
		return DesktopExportResult{}, fmt.Errorf("启动本地后端：%w", err)
	}
	config := a.RuntimeConfig()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, config.BaseURL+"/resources/"+url.PathEscape(resourceID)+"/file?proxy=1", nil)
	if err != nil {
		return DesktopExportResult{}, err
	}
	request.Header.Set("X-Desktop-Token", config.LaunchToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return DesktopExportResult{}, fmt.Errorf("读取本地资源：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return DesktopExportResult{}, fmt.Errorf("读取本地资源失败：HTTP %d", response.StatusCode)
	}
	path, file, err := createExportFile(directory, fileName)
	if err != nil {
		return DesktopExportResult{}, err
	}
	complete := false
	defer func() {
		_ = file.Close()
		if !complete {
			_ = os.Remove(path)
		}
	}()
	if _, err := io.Copy(file, response.Body); err != nil {
		return DesktopExportResult{}, fmt.Errorf("写入导出文件：%w", err)
	}
	if err := file.Sync(); err != nil {
		return DesktopExportResult{}, fmt.Errorf("保存导出文件：%w", err)
	}
	if err := file.Close(); err != nil {
		return DesktopExportResult{}, fmt.Errorf("关闭导出文件：%w", err)
	}
	complete = true
	return DesktopExportResult{Path: path}, nil
}

func safeExportFileName(fileName string) (string, error) {
	fileName = strings.TrimSpace(fileName)
	if fileName == "" || fileName == "." || fileName == ".." || filepath.Base(fileName) != fileName {
		return "", fmt.Errorf("导出文件名无效")
	}
	return fileName, nil
}

func createExportFile(directory string, fileName string) (string, *os.File, error) {
	extension := filepath.Ext(fileName)
	base := strings.TrimSuffix(fileName, extension)
	for index := 0; index < 10_000; index++ {
		candidate := fileName
		if index > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", base, index, extension)
		}
		path := filepath.Join(directory, candidate)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return path, file, nil
		}
		if !os.IsExist(err) {
			return "", nil, fmt.Errorf("创建导出文件：%w", err)
		}
	}
	return "", nil, fmt.Errorf("导出目录中同名文件过多")
}

func (a *DesktopApp) startup(ctx context.Context) {
	a.mu.Lock()
	a.wailsContext = ctx
	a.mu.Unlock()
	if err := a.start(ctx); err != nil {
		log.Printf("启动本地后端失败: %v", err)
		wailsruntime.LogErrorf(ctx, "启动本地后端失败: %v", err)
		wailsruntime.Quit(ctx)
	}
}

func (a *DesktopApp) shutdown(_ context.Context) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := a.stop(ctx); err != nil {
		log.Printf("关闭本地后端失败: %v", err)
	}
}

// ServeHTTP is only attached to Wails' in-process AssetServer. It gives the
// WebView a binding-independent bootstrap path without exposing the token on
// the loopback HTTP listener. Keeping it separate from DesktopApp prevents
// Wails from trying to expose net/http internals as frontend bindings.
func (h desktopAssetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Canvas snapshots created before the desktop API prefix was introduced may
	// still point media elements at `/resources/...`. Keep those snapshots
	// playable by routing the legacy path through the authenticated local API.
	if strings.HasPrefix(r.URL.Path, "/resources/") {
		request := r.Clone(r.Context())
		request.URL.Path = "/api" + r.URL.Path
		r = request
	}
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		if err := h.app.start(r.Context()); err != nil {
			http.Error(w, "desktop backend failed to start: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		h.app.mu.RLock()
		runtime := h.app.runtime()
		h.app.mu.RUnlock()
		request := r.Clone(r.Context())
		request.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		runtime.Handler().ServeHTTP(w, request)
		return
	}
	if r.Method != http.MethodGet || r.URL.Path != "/__desktop/runtime-config" {
		http.NotFound(w, r)
		return
	}
	if err := h.app.start(r.Context()); err != nil {
		http.Error(w, "desktop backend failed to start: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(h.app.RuntimeConfig())
}
