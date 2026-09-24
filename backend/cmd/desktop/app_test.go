package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// This catches desktop-shell regressions where Wails opens before the local
// backend has a usable loopback URL and ephemeral launch token.
func TestDesktopAppStartsRuntimeOnLoopback(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	config := app.RuntimeConfig()
	if !regexp.MustCompile(`^http://127\.0\.0\.1:\d+/api$`).MatchString(config.BaseURL) {
		t.Fatalf("baseURL = %q, want loopback API", config.BaseURL)
	}
	if config.LaunchToken == "" {
		t.Fatal("launch token must be available before the frontend loads")
	}
	if err := app.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopRuntimeConfigEndpointIsAvailableInsideAssetServer(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())
	response := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/__desktop/runtime-config", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	var config DesktopRuntimeConfig
	if err := json.Unmarshal(response.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config.BaseURL == "" || config.LaunchToken == "" {
		t.Fatalf("runtime config endpoint returned %#v", config)
	}
}

func TestDesktopAssetServerFallsBackToInProcessAPI(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())

	response := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 {
		t.Fatalf("code = %d, want 0", envelope.Code)
	}
}

func TestDesktopAssetServerRoutesLegacyResourcePath(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())

	response := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/resources/missing-resource/file", nil))
	if response.Code == http.StatusNotFound && response.Body.String() == "404 page not found\n" {
		t.Fatal("legacy resource path was handled by the Wails asset server instead of the local API")
	}
}

func TestDesktopAssetServerStartsRuntimeWhenStartupHookHasNotRun(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	defer app.stop(context.Background())

	response := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	if config := app.RuntimeConfig(); config.BaseURL == "" || config.LaunchToken == "" {
		t.Fatalf("asset request did not lazily start runtime: %#v", config)
	}
}

func TestDefaultDataDirHonorsExplicitDesktopOverride(t *testing.T) {
	want := filepath.Join(t.TempDir(), "workspace")
	t.Setenv("CANVAS_DESKTOP_DATA_DIR", want)
	got, err := defaultDataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("defaultDataDir() = %q, want %q", got, want)
	}
}

func TestDesktopStartupHookStartsRuntimeBeforeFrontendBootstrap(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.startup(context.Background())
	config := app.RuntimeConfig()
	if config.BaseURL == "" || config.LaunchToken == "" {
		t.Fatalf("startup hook did not prepare runtime config: %#v", config)
	}
	app.shutdown(context.Background())
}

func TestPrepareDesktopAppStartsRuntimeBeforeWailsMainLoop(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := prepareDesktopApp(app); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())
	config := app.RuntimeConfig()
	if config.BaseURL == "" || config.LaunchToken == "" {
		t.Fatalf("desktop app was not ready before Wails main loop: %#v", config)
	}
}

func TestDesktopExportResourceWritesStoredBytesToSelectedDirectory(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())

	resourceID := uploadDesktopTestResource(t, app, "video.mp4", "video", []byte("desktop-export"))
	exportDir := t.TempDir()
	app.chooseExportDirectory = func(context.Context) (string, error) { return exportDir, nil }

	result, err := app.ExportResource(resourceID, "水牛视频.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if result.Canceled {
		t.Fatal("export was unexpectedly canceled")
	}
	wantPath := filepath.Join(exportDir, "水牛视频.mp4")
	if result.Path != wantPath {
		t.Fatalf("export path = %q, want %q", result.Path, wantPath)
	}
	content, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "desktop-export" {
		t.Fatalf("exported content = %q", content)
	}
}

func TestDesktopExportResourceCancelLeavesDirectoryUntouched(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.chooseExportDirectory = func(context.Context) (string, error) { return "", nil }

	result, err := app.ExportResource("resource-id", "video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Canceled || result.Path != "" {
		t.Fatalf("cancel result = %#v", result)
	}
}

func TestDesktopExportResourceDoesNotOverwriteExistingFile(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())

	resourceID := uploadDesktopTestResource(t, app, "image.png", "image", []byte("new-image"))
	exportDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(exportDir, "画面.png"), []byte("existing-image"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.chooseExportDirectory = func(context.Context) (string, error) { return exportDir, nil }

	result, err := app.ExportResource(resourceID, "画面.png")
	if err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(exportDir, "画面 (1).png")
	if result.Path != wantPath {
		t.Fatalf("export path = %q, want %q", result.Path, wantPath)
	}
	original, err := os.ReadFile(filepath.Join(exportDir, "画面.png"))
	if err != nil {
		t.Fatal(err)
	}
	if string(original) != "existing-image" {
		t.Fatalf("existing file was overwritten: %q", original)
	}
}

func uploadDesktopTestResource(t *testing.T, app *DesktopApp, fileName string, kind string, content []byte) string {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("kind", kind); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	config := app.RuntimeConfig()
	request, err := http.NewRequest(http.MethodPost, config.BaseURL+"/resources", &body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-Desktop-Token", config.LaunchToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(response.Body)
		t.Fatalf("upload status = %d, body=%s", response.StatusCode, payload)
	}
	var envelope struct {
		Data struct {
			Resource struct {
				ID string `json:"id"`
			} `json:"resource"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Resource.ID == "" {
		t.Fatal("upload returned an empty resource id")
	}
	return envelope.Data.Resource.ID
}
