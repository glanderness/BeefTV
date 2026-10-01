package plugins

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type crashStore struct {
	Store
	mu           sync.Mutex
	failCommit   error
	failNextLoad bool
}

func (s *crashStore) LoadPluginRegistry() ([]RegistryRecord, bool, error) {
	s.mu.Lock()
	fail := s.failNextLoad
	s.failNextLoad = false
	s.mu.Unlock()
	if fail {
		return nil, false, errStoreFailed
	}
	return s.Store.LoadPluginRegistry()
}

func (s *crashStore) CommitPluginRegistry(commit RegistryCommit) error {
	s.mu.Lock()
	fail := s.failCommit
	s.failCommit = nil
	s.mu.Unlock()
	if fail != nil {
		return fail
	}
	return s.Store.CommitPluginRegistry(commit)
}

func newSQLitePluginEnv(t *testing.T) (string, Store, *repository.Repository) {
	t.Helper()
	dataDir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dataDir, "app.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	return dataDir, NewRepositoryStore(repo), repo
}

func TestInstallCrashBeforeCommitRestartsFromOldState(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("crash-install", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "crash-install-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced pre-commit failure"))
	v2 := testPluginPackage(t, testManifest("crash-install", "2.0.0"))
	_, err = svc.InstallUploaded("admin-1", v2, "crash-install-v2.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "forced pre-commit failure") {
		t.Fatalf("pre-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-install", "1.0.0", StatusEnabled, v1)
	assertBlobExists(t, runtime, v1, true)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "crash-install", "1.0.0", StatusEnabled, v1)
}

func TestInstallCrashAfterCommitBeforePublishRestartsFromCommittedState(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("crash-publish-install", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "crash-publish-install-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.skipNextPublish()
	v2 := testPluginPackage(t, testManifest("crash-publish-install", "2.0.0"))
	_, err = svc.InstallUploaded("admin-1", v2, "crash-publish-install-v2.beeftv-plugin")
	if err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("post-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-publish-install", "1.0.0", StatusEnabled, v1)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "crash-publish-install", "2.0.0", StatusEnabled, v2)
}

func TestEnableCrashBeforeAndAfterCommit(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("crash-enable", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "crash-enable.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	admin := &model.User{ID: "admin-1"}
	runtime.failNextCommit(errors.New("forced enable pre-commit"))
	if _, _, err := svc.SetPlatformAvailability(admin, "crash-enable", false); err == nil || !strings.Contains(err.Error(), "forced enable pre-commit") {
		t.Fatalf("enable pre-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-enable", "1.0.0", StatusEnabled, pkg)
	pre, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(pre.List(), "crash-enable")
	if !ok || item.Status != StatusEnabled {
		t.Fatalf("restart after enable pre-commit = %#v", item)
	}

	runtime = pre
	svc = New(runtime, store)
	runtime.skipNextPublish()
	if _, _, err := svc.SetPlatformAvailability(admin, "crash-enable", false); err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("enable post-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-enable", "1.0.0", StatusEnabled, pkg)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	item, ok = ByID(restarted.List(), "crash-enable")
	if !ok || item.Status != StatusDisabled {
		t.Fatalf("restart after enable post-commit = %#v", item)
	}
}

func TestUninstallCrashBeforeAndAfterCommit(t *testing.T) {
	dataDir, store, repo := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("crash-uninstall", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "crash-uninstall.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserPluginState(&model.UserPluginState{ID: "user-state-crash", UserID: "user-1", PluginID: "crash-uninstall", Enabled: true, CreatedAt: time.Now(), UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced uninstall pre-commit"))
	if err := svc.UninstallUploaded("crash-uninstall"); err == nil || !strings.Contains(err.Error(), "forced uninstall pre-commit") {
		t.Fatalf("uninstall pre-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-uninstall", "1.0.0", StatusEnabled, pkg)
	pre, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(pre.List(), "crash-uninstall"); !ok {
		t.Fatal("restart after uninstall pre-commit dropped plugin")
	}
	user, err := repo.UserPluginState("user-1", "crash-uninstall")
	if err != nil || user == nil {
		t.Fatalf("user state after uninstall pre-commit = %#v err=%v", user, err)
	}

	runtime = pre
	svc = New(runtime, store)
	runtime.skipNextPublish()
	if err := svc.UninstallUploaded("crash-uninstall"); err == nil || !errors.Is(err, errPublishInterrupted) {
		t.Fatalf("uninstall post-commit error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "crash-uninstall", "1.0.0", StatusEnabled, pkg)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(restarted.List(), "crash-uninstall"); ok {
		t.Fatal("restart after uninstall post-commit still lists plugin")
	}
	user, err = repo.UserPluginState("user-1", "crash-uninstall")
	if err != nil || user != nil {
		t.Fatalf("user state after uninstall post-commit = %#v err=%v", user, err)
	}
	platform, err := repo.PluginPlatformState("crash-uninstall")
	if err != nil || platform != nil {
		t.Fatalf("platform state after uninstall post-commit = %#v err=%v", platform, err)
	}
}

func TestInstallTransactionFailureWithFSFailureKeepsReferencedBlob(t *testing.T) {
	dataDir, inner, _ := newSQLitePluginEnv(t)
	store := &crashStore{Store: inner}
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	v1 := testPluginPackage(t, testManifest("tx-fs", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v1, "tx-fs-v1.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.testFailCommit = func() error {
		store.mu.Lock()
		store.failNextLoad = true
		store.mu.Unlock()
		return errors.New("forced tx failure")
	}
	v2 := testPluginPackage(t, testManifest("tx-fs", "2.0.0"))
	_, err = svc.InstallUploaded("admin-1", v2, "tx-fs-v2.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "forced tx failure") {
		t.Fatalf("tx+fs error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "tx-fs", "1.0.0", StatusEnabled, v1)
	assertBlobExists(t, runtime, v1, true)
	assertBlobExists(t, runtime, v2, true)
	restarted, err := NewRuntimeWithStore(dataDir, inner)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "tx-fs", "1.0.0", StatusEnabled, v1)
	assertBlobExists(t, restarted, v1, true)
}

func TestSameHashReinstallFailureDoesNotDeleteLivePackage(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("same-hash", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "same-hash.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime.failNextCommit(errors.New("forced same-hash commit failure"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "same-hash.beeftv-plugin"); err == nil || !strings.Contains(err.Error(), "forced same-hash commit failure") {
		t.Fatalf("same-hash error = %v", err)
	}
	assertImmediatePlugin(t, runtime, "same-hash", "1.0.0", StatusEnabled, pkg)
	assertBlobExists(t, runtime, pkg, true)
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "same-hash", "1.0.0", StatusEnabled, pkg)
}

func TestLegacyDiskImportThenStaleFileIsIgnored(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	v1 := testPluginPackage(t, testManifest("legacy-import", "1.0.0"))
	fileRuntime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fileRuntime.Install(v1, "legacy-import.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(runtime.List(), "legacy-import"); !ok {
		t.Fatal("legacy upload was not imported")
	}
	svc := New(runtime, store)
	v2 := testPluginPackage(t, testManifest("legacy-import", "2.0.0"))
	if _, err := svc.InstallUploaded("admin-1", v2, "legacy-import-v2.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	stale, err := json.Marshal([]RegistryRecord{{ID: "stale-only", Raw: json.RawMessage(`{"apiVersion":"beeftv.plugin/v1","id":"stale-only"}`), Source: OriginUploaded}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), stale, 0o600); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	assertImmediatePlugin(t, restarted, "legacy-import", "2.0.0", StatusEnabled, v2)
	if _, ok := ByID(restarted.List(), "stale-only"); ok {
		t.Fatal("stale disk registry overwrote committed sqlite state")
	}
}

func TestMalformedLegacyImportFailsClosedAndPreservesBytes(t *testing.T) {
	dataDir, store, _ := newSQLitePluginEnv(t)
	legacyPath := filepath.Join(dataDir, "plugin_registry.json")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	garbage := []byte("{not-json")
	if err := os.WriteFile(legacyPath, garbage, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuntimeWithStore(dataDir, store); err == nil || !strings.Contains(err.Error(), "遗留插件 registry") {
		t.Fatalf("malformed import error = %v", err)
	}
	got, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(garbage) {
		t.Fatalf("malformed legacy file was rewritten")
	}
}

func TestMalformedAuthoritativeDBFailsClosedAndIgnoresDisk(t *testing.T) {
	dataDir, store, repo := newSQLitePluginEnv(t)
	runtime, err := NewRuntimeWithStore(dataDir, store)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(runtime, store)
	pkg := testPluginPackage(t, testManifest("db-corrupt", "1.0.0"))
	if _, err := svc.InstallUploaded("admin-1", pkg, "db-corrupt.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveSystemSetting(&model.SystemSetting{Key: RegistrySettingKey, ValueJSON: "{not-json"}); err != nil {
		t.Fatal(err)
	}
	validDisk, err := json.Marshal([]RegistryRecord{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), validDisk, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRuntimeWithStore(dataDir, store); err == nil || !strings.Contains(err.Error(), "读取插件 registry") {
		t.Fatalf("malformed db error = %v", err)
	}
}
