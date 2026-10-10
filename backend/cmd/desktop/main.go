package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/desktopupdate"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

func main() {
	// The updater helper must run before defaultDataDir/prepareDesktopApp so a
	// replacement never opens the user database or data directory.
	if done, err := desktopupdate.HandleHelperCommand(os.Args); done {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := validateDesktopArgs(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	dataDir, err := defaultDataDir()
	if err != nil {
		log.Fatal(err)
	}
	app := newDesktopApp(dataDir)
	if err := configureDesktopTemp(dataDir); err != nil {
		log.Fatal(err)
	}
	startupErrorPath := filepath.Join(dataDir, "startup-error.log")
	if err := prepareDesktopApp(app); err != nil {
		_ = os.MkdirAll(dataDir, 0o755)
		_ = os.WriteFile(startupErrorPath, []byte(err.Error()+"\n"), 0o600)
		log.Fatalf("启动本地后端失败: %v", err)
	}
	_ = os.Remove(startupErrorPath)

	err = wails.Run(&options.App{
		Title:  "BeefTV",
		Width:  1440,
		Height: 960,
		Mac:    &mac.Options{},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: desktopAssetHandler{app: app},
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}

func prepareDesktopApp(app *DesktopApp) error {
	return app.start(context.Background())
}

func defaultDataDir() (string, error) {
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "--data-dir=") {
			dir := strings.TrimSpace(strings.TrimPrefix(arg, "--data-dir="))
			clean := filepath.Clean(dir)
			if !filepath.IsAbs(dir) || filepath.Dir(clean) == clean {
				return "", fmt.Errorf("--data-dir 需要明确的绝对目录")
			}
			return clean, nil
		}
	}
	if override := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_DATA_DIR")); override != "" {
		return override, nil
	}
	root, err := desktopstorage.DefaultRoot()
	if err != nil {
		return "", fmt.Errorf("定位用户应用数据目录: %w", err)
	}
	return desktopstorage.Resolve(root)
}

func configureDesktopTemp(dataDir string) error {
	path := filepath.Join(dataDir, "cache", "tmp")
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	for _, name := range []string{"TMPDIR", "TEMP", "TMP"} {
		if err := os.Setenv(name, path); err != nil {
			return err
		}
	}
	return nil
}
