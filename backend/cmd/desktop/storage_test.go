package main

import (
	"bytes"
	"context"
	"encoding/json"
	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/workspace"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func migrateStorageWhenIdle(t *testing.T, app *DesktopApp, target string) (desktopstorage.Usage, error) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		usage, err := app.MigrateStorage(target)
		if err == nil || !strings.Contains(err.Error(), "个后台任务正在运行") || time.Now().After(deadline) {
			return usage, err
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestNativeMigrationPreservesSQLiteProjectMediaAndEncryptedModelAfterRestart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "profile")
	target := filepath.Join(t.TempDir(), "selected")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		t.Fatal(err)
	}
	target = filepath.Join(parent, "selected")
	app := newDesktopApp(root)
	app.storageRoot = root
	if err := app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer app.stop(context.Background())
	request := func(method, path string, body io.Reader, contentType string) []byte {
		t.Helper()
		runtime := app.runtime()
		req, err := http.NewRequest(method, runtime.BaseURL()+path, body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-Desktop-Token", runtime.LaunchToken())
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("%s %s status %d: %s", method, path, res.StatusCode, data)
		}
		return data
	}
	project := request("POST", "/projects", bytes.NewBufferString(`{"name":"migration-project"}`), "application/json")
	request("PUT", "/canvas-projects/migration-canvas", bytes.NewBufferString(`{"project":{"id":"migration-canvas","revision":0,"title":"migration-canvas-title","nodes":[],"connections":[],"chatSessions":[],"createdAt":"2026-10-10T00:00:00Z","updatedAt":"2026-10-10T00:00:00Z"}}`), "application/json")
	var envelope struct {
		Data struct {
			Project struct {
				ID string `json:"id"`
			} `json:"project"`
		} `json:"data"`
	}
	if err := json.Unmarshal(project, &envelope); err != nil || envelope.Data.Project.ID == "" {
		t.Fatal("project not created")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "fixture.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("migrated-resource"))
	_ = writer.WriteField("kind", "document")
	_ = writer.Close()
	resource := request("POST", "/resources", &body, writer.FormDataContentType())
	var resourceEnvelope struct {
		Data struct {
			Resource struct {
				ID string `json:"id"`
			} `json:"resource"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resource, &resourceEnvelope); err != nil || resourceEnvelope.Data.Resource.ID == "" {
		t.Fatal("resource not created")
	}
	config, err := workspace.NewProviderConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = config.SaveLocalModelConfig([]byte(`{"channels":[{"id":"personal","enabled":true,"apiKey":"migration-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "occupied")
	_ = os.MkdirAll(foreign, 0700)
	_ = os.WriteFile(filepath.Join(foreign, "foreign"), []byte("keep"), 0600)
	if _, err = migrateStorageWhenIdle(t, app, foreign); err == nil {
		t.Fatal("accepted occupied target")
	}
	if app.dataDir != root || app.runtime() == nil {
		t.Fatal("invalid destination closed original workspace")
	}
	if _, err = migrateStorageWhenIdle(t, app, target); err != nil {
		t.Fatal(err)
	}
	if got, err := desktopstorage.Resolve(root); err != nil || got != target {
		t.Fatalf("saved selection %q %v", got, err)
	}
	if err = app.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened, err := desktopstorage.Resolve(root)
	if err != nil {
		t.Fatal(err)
	}
	app.dataDir = reopened
	if err = app.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	data := request("GET", "/projects/"+envelope.Data.Project.ID, nil, "")
	if !bytes.Contains(data, []byte("migration-project")) {
		t.Fatal("SQLite project lost")
	}
	canvas := request("GET", "/canvas-projects/migration-canvas", nil, "")
	if !bytes.Contains(canvas, []byte("migration-canvas-title")) {
		t.Fatal("canvas project lost")
	}
	data = request("GET", "/resources/"+resourceEnvelope.Data.Resource.ID+"/file", nil, "")
	if string(data) != "migrated-resource" {
		t.Fatal("media lost")
	}
	config, err = workspace.NewProviderConfig(target)
	if err != nil {
		t.Fatal(err)
	}
	effective, _, err := config.LoadEffectiveModelConfig()
	encoded, _ := json.Marshal(effective)
	if err != nil || !bytes.Contains(encoded, []byte("migration-secret")) {
		t.Fatalf("encrypted config/key lost: %v", err)
	}
	if _, err = app.CleanupPreviousStorage(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(root, "open_ai_canvas.db")); !os.IsNotExist(err) {
		t.Fatal("old database retained")
	}
	data = request("GET", "/projects/"+envelope.Data.Project.ID, nil, "")
	if !bytes.Contains(data, []byte("migration-project")) {
		t.Fatal("cleanup damaged project")
	}
	if got, err := desktopstorage.Resolve(root); err != nil || got != target {
		t.Fatal("cleanup lost directory selection")
	}
}

func TestMultiHopMigrationPersistsAcrossDefaultDataDirRestarts(t *testing.T) {
	originalArgs := os.Args
	t.Cleanup(func() { os.Args = originalArgs })

	tempBase, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	homeDir := filepath.Join(tempBase, "home")
	xdgConfig := filepath.Join(tempBase, "xdg")
	appData := filepath.Join(tempBase, "AppData", "Roaming")
	for _, dir := range []string{
		filepath.Join(homeDir, "Library", "Application Support"),
		xdgConfig,
		appData,
	} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", homeDir)
	t.Setenv("XDG_CONFIG_HOME", xdgConfig)
	t.Setenv("AppData", appData)
	t.Setenv("APPDATA", appData)
	t.Setenv("CANVAS_DESKTOP_DATA_DIR", "")
	os.Args = []string{"BeefTV"}

	expectedRoot, err := desktopstorage.DefaultRoot()
	if err != nil {
		t.Fatal(err)
	}
	hop1 := filepath.Join(tempBase, "disk-d", "BeefTV1")
	hop2 := filepath.Join(tempBase, "disk-e", "BeefTV2")
	for _, parent := range []string{filepath.Dir(hop1), filepath.Dir(hop2)} {
		if err := os.MkdirAll(parent, 0700); err != nil {
			t.Fatal(err)
		}
	}

	// Launch 1: default profile -> migrate to hop1
	bootDir1, bootRoot1, err := resolveDesktopStorage()
	if err != nil {
		t.Fatalf("launch 1 resolveDesktopStorage: %v", err)
	}
	if bootDir1 != expectedRoot || bootRoot1 != expectedRoot {
		t.Fatalf("launch 1 got (%q, %q), want (%q, %q)", bootDir1, bootRoot1, expectedRoot, expectedRoot)
	}
	app1 := newDesktopApp(bootDir1)
	app1.storageRoot = bootRoot1
	if err := app1.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(bootDir1, "resources", "hop-marker.txt")
	if err := os.MkdirAll(filepath.Dir(markerPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(markerPath, []byte("persisted-across-hops"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := migrateStorageWhenIdle(t, app1, hop1); err != nil {
		t.Fatalf("hop 1 MigrateStorage: %v", err)
	}
	if err := app1.stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Launch 2 (restart): defaultDataDir() resolves hop1 while keeping storageRoot = expectedRoot
	restartedDir1, err := defaultDataDir()
	if err != nil || restartedDir1 != hop1 {
		t.Fatalf("restart 1 defaultDataDir() = %q, err=%v; want %q", restartedDir1, err, hop1)
	}
	bootDir2, bootRoot2, err := resolveDesktopStorage()
	if err != nil || bootDir2 != hop1 || bootRoot2 != expectedRoot {
		t.Fatalf("restart 1 resolveDesktopStorage = (%q, %q, %v); want (%q, %q, nil)", bootDir2, bootRoot2, err, hop1, expectedRoot)
	}

	// Post-update relaunch passing --data-dir=<resolved hop1> must still preserve storageRoot
	os.Args = []string{"BeefTV", "--data-dir=" + hop1}
	relaunchDir, relaunchRoot, err := resolveDesktopStorage()
	if err != nil || relaunchDir != hop1 || relaunchRoot != expectedRoot {
		t.Fatalf("updater relaunch resolveDesktopStorage = (%q, %q, %v); want (%q, %q, nil)", relaunchDir, relaunchRoot, err, hop1, expectedRoot)
	}
	os.Args = []string{"BeefTV"}

	// Migrate second hop: hop1 -> hop2
	app2 := newDesktopApp(bootDir2)
	app2.storageRoot = bootRoot2
	if err := app2.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := migrateStorageWhenIdle(t, app2, hop2); err != nil {
		t.Fatalf("hop 2 MigrateStorage: %v", err)
	}
	settings, err := app2.StorageSettings()
	if err != nil || settings.DataDir != hop2 || settings.PreviousDir != hop1 {
		t.Fatalf("hop 2 StorageSettings = %+v, err=%v", settings, err)
	}
	if err := app2.stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Launch 3 (restart): defaultDataDir() resolves hop2 and preserves user data
	restartedDir2, err := defaultDataDir()
	if err != nil || restartedDir2 != hop2 {
		t.Fatalf("restart 2 defaultDataDir() = %q, err=%v; want %q", restartedDir2, err, hop2)
	}
	gotMarker, err := os.ReadFile(filepath.Join(restartedDir2, "resources", "hop-marker.txt"))
	if err != nil || string(gotMarker) != "persisted-across-hops" {
		t.Fatalf("marker after 2 hops = %q, err=%v", gotMarker, err)
	}

	// Isolated --data-dir launch must leave storageRoot empty and refuse MigrateStorage
	isolated := filepath.Join(tempBase, "isolated-workspace")
	os.Args = []string{"BeefTV", "--data-dir=" + isolated}
	isoDir, isoRoot, err := resolveDesktopStorage()
	if err != nil || isoDir != isolated || isoRoot != "" {
		t.Fatalf("isolated resolveDesktopStorage = (%q, %q, %v)", isoDir, isoRoot, err)
	}
	appIso := newDesktopApp(isoDir)
	appIso.storageRoot = isoRoot
	if _, err := appIso.MigrateStorage(filepath.Join(tempBase, "blocked-target")); err == nil {
		t.Fatal("expected isolated --data-dir launch to refuse MigrateStorage")
	}
}
