package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
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

func TestDesktopAppBoundMethodsStayTiny(t *testing.T) {
	typ := reflect.TypeOf((*DesktopApp)(nil))
	names := make([]string, 0, typ.NumMethod())
	for i := 0; i < typ.NumMethod(); i++ {
		names = append(names, typ.Method(i).Name)
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"CheckForUpdate", "DownloadUpdate", "InstallUpdate", "RuntimeConfig", "SaveOwnedArtifact", "SaveOwnedMedia", "UpdateStatus"}) {
		t.Fatalf("bound methods = %v", names)
	}
}

func TestSaveOwnedMediaCancelReturnsNoError(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	app.chooseSavePath = func(context.Context, string) (string, error) { return "", nil }
	copied := false
	app.copyOwnedMedia = func(string, string) error {
		copied = true
		return nil
	}
	saved, err := app.SaveOwnedMedia("clip.mp4", "owned-id")
	if err != nil || saved || copied {
		t.Fatalf("cancelled save = saved:%v err:%v copied:%v", saved, err, copied)
	}
}

func TestSaveOwnedMediaClosedContextFails(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	app.wailsCtx = ctx
	if _, err := app.SaveOwnedMedia("clip.mp4", "owned-id"); err == nil {
		t.Fatal("expected closed-app error")
	}
}

func TestSaveOwnedMediaMissingContextFails(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	if _, err := app.SaveOwnedMedia("clip.mp4", "owned-id"); err == nil {
		t.Fatal("expected not-ready error")
	}
}

func TestSaveOwnedMediaCopyFailurePropagates(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	dest := filepath.Join(t.TempDir(), "out.mp4")
	app.chooseSavePath = func(context.Context, string) (string, error) { return dest, nil }
	app.copyOwnedMedia = func(string, string) error { return errors.New("无法写出文件") }
	saved, err := app.SaveOwnedMedia("clip.mp4", "owned-id")
	if saved || err == nil || err.Error() != "无法写出文件" {
		t.Fatalf("failure = saved:%v err:%v", saved, err)
	}
}

func TestSaveOwnedMediaSuccessUsesSanitizedName(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	dest := filepath.Join(t.TempDir(), "out.mp4")
	var dialogName string
	app.chooseSavePath = func(_ context.Context, fileName string) (string, error) {
		dialogName = fileName
		return dest, nil
	}
	var copiedID, copiedDest string
	app.copyOwnedMedia = func(resourceID, destPath string) error {
		copiedID = resourceID
		copiedDest = destPath
		return nil
	}
	saved, err := app.SaveOwnedMedia(`../clip:name.mp4`, "owned-id")
	if err != nil || !saved {
		t.Fatalf("save = saved:%v err:%v", saved, err)
	}
	if strings.ContainsAny(dialogName, `\/:*?"<>|`) || strings.Contains(dialogName, "..") {
		t.Fatalf("dialog name = %q", dialogName)
	}
	if copiedID != "owned-id" || copiedDest != dest {
		t.Fatalf("copy %q -> %q", copiedID, copiedDest)
	}
}

func TestSaveOwnedMediaClearsContextOnShutdown(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.startup(context.Background())
	app.shutdown(context.Background())
	if _, err := app.SaveOwnedMedia("clip.mp4", "owned-id"); err == nil {
		t.Fatal("expected closed context after shutdown")
	}
}

func TestSaveOwnedMediaCopiesWorkspaceResource(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.startup(context.Background())
	defer app.shutdown(context.Background())
	resourceID := uploadDesktopResource(t, app, []byte("hello-media"))
	dest := filepath.Join(t.TempDir(), "saved.bin")
	app.chooseSavePath = func(context.Context, string) (string, error) { return dest, nil }
	saved, err := app.SaveOwnedMedia("saved.bin", resourceID)
	if err != nil || !saved {
		t.Fatalf("save = saved:%v err:%v", saved, err)
	}
	body, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "hello-media" {
		t.Fatalf("copied body = %q", body)
	}
}

func TestSaveOwnedMediaRejectsUnownedResourceID(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.startup(context.Background())
	defer app.shutdown(context.Background())
	dest := filepath.Join(t.TempDir(), "saved.bin")
	app.chooseSavePath = func(context.Context, string) (string, error) { return dest, nil }
	if _, err := app.SaveOwnedMedia("saved.bin", "../secret"); err == nil {
		t.Fatal("expected rejected resource id")
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("dest should not exist: %v", err)
	}
}

func TestSaveOwnedMediaKeepsExistingDestWhenCopyFails(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	dest := filepath.Join(t.TempDir(), "keep.bin")
	if err := os.WriteFile(dest, []byte("ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.chooseSavePath = func(context.Context, string) (string, error) { return dest, nil }
	app.copyOwnedMedia = func(string, string) error { return errors.New("无法写出文件") }
	saved, err := app.SaveOwnedMedia("keep.bin", "owned-id")
	if saved || err == nil {
		t.Fatalf("save = saved:%v err:%v", saved, err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ORIGINAL" {
		t.Fatalf("dest = %q", got)
	}
}

func TestSaveOwnedMediaKeepsSourceWhenDestIsSameFile(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.startup(context.Background())
	defer app.shutdown(context.Background())
	payload := []byte("store-original")
	resourceID := uploadDesktopResource(t, app, payload)
	source := desktopResourcePath(t, app, resourceID)
	app.chooseSavePath = func(context.Context, string) (string, error) { return source, nil }
	if _, err := app.SaveOwnedMedia("saved.bin", resourceID); err == nil {
		t.Fatal("expected same-file export to be rejected")
	}
	got, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("source = %q", got)
	}
}

func TestSaveOwnedArtifactWritesChosenPath(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	dest := filepath.Join(t.TempDir(), "pack.zip")
	if err := os.WriteFile(dest, []byte("OLD-ZIP"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.chooseSavePath = func(context.Context, string) (string, error) { return dest, nil }
	saved, err := app.SaveOwnedArtifact("pack.zip", []byte("PK-NEW"))
	if err != nil || !saved {
		t.Fatalf("save = saved:%v err:%v", saved, err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "PK-NEW" {
		t.Fatalf("dest = %q", got)
	}
}

func TestSaveOwnedArtifactCancelLeavesDest(t *testing.T) {
	app := newDesktopApp(t.TempDir())
	app.wailsCtx = context.Background()
	dest := filepath.Join(t.TempDir(), "pack.zip")
	if err := os.WriteFile(dest, []byte("OLD-ZIP"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.chooseSavePath = func(context.Context, string) (string, error) { return "", nil }
	saved, err := app.SaveOwnedArtifact("pack.zip", []byte("PK-NEW"))
	if err != nil || saved {
		t.Fatalf("cancel = saved:%v err:%v", saved, err)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "OLD-ZIP" {
		t.Fatalf("dest = %q", got)
	}
}

func uploadDesktopResource(t *testing.T, app *DesktopApp, payload []byte) string {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "clip.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("kind", "file"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/resources", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("upload status = %d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Resource struct {
				ID string `json:"id"`
			} `json:"resource"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 || envelope.Data.Resource.ID == "" {
		t.Fatalf("upload envelope = %#v", envelope)
	}
	return envelope.Data.Resource.ID
}

func desktopResourcePath(t *testing.T, app *DesktopApp, resourceID string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/resources/"+resourceID, nil)
	response := httptest.NewRecorder()
	desktopAssetHandler{app: app}.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("resource status = %d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Resource struct {
				ObjectKey string `json:"objectKey"`
			} `json:"resource"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 || envelope.Data.Resource.ObjectKey == "" {
		t.Fatalf("resource envelope = %#v", envelope)
	}
	return filepath.Join(app.dataDir, "resources", filepath.FromSlash(envelope.Data.Resource.ObjectKey))
}
