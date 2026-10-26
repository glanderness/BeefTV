package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/protocol"
)

type staticReferences map[string]ReferenceUsage

func (s staticReferences) ReferencedProviders() (map[string]ReferenceUsage, error) { return s, nil }

type failingReferences struct{}

func (failingReferences) ReferencedProviders() (map[string]ReferenceUsage, error) {
	return nil, errors.New("audit unavailable")
}

// retentionManifest builds a protocol plugin whose provider ID differs from the
// package ID, the shape saved configuration actually stores (`openai-videos`
// contributes `newapi`).
func retentionManifest(pluginID, providerID, version string) []byte {
	return []byte(fmt.Sprintf(`{"apiVersion":"beeftv.plugin/v1","id":%q,"version":%q,"name":%q,"author":"Test","documentation":"# %s","contributes":{"providers":[{"id":%q,"label":%q,"capabilities":["video"],"scopes":["canvas","user.custom-channel"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}]}}`, pluginID, version, pluginID, pluginID, providerID, providerID))
}

// shipPackage writes one release archive into dir and returns its manifest ID.
func shipPackage(t *testing.T, dir string, manifest []byte) (string, []byte) {
	t.Helper()
	var parsed protocol.Manifest
	if err := json.Unmarshal(manifest, &parsed); err != nil {
		t.Fatalf("decode shipped manifest: %v", err)
	}
	data := testPluginPackage(t, manifest)
	path := filepath.Join(dir, parsed.Metadata.ID+protocol.PluginPackageExtension)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write shipped package: %v", err)
	}
	return parsed.Metadata.ID, data
}

// storedOfficialRecord is the committed registry row an older release left
// behind for one official plugin.
func storedOfficialRecord(t *testing.T, manifest []byte, enabled bool) RegistryRecord {
	t.Helper()
	var parsed protocol.Manifest
	if err := json.Unmarshal(manifest, &parsed); err != nil {
		t.Fatalf("decode stored manifest: %v", err)
	}
	parsed.Metadata.Enabled = enabled
	raw, err := json.Marshal(parsed)
	if err != nil {
		t.Fatalf("encode stored manifest: %v", err)
	}
	now := time.Now().UTC()
	return RegistryRecord{
		ID: parsed.Metadata.ID, Raw: raw, Source: OriginOfficial,
		FileName:    parsed.Metadata.ID + protocol.PluginPackageExtension,
		InstalledAt: now, UpdatedAt: now,
	}
}

func retentionStore(records ...RegistryRecord) *memoryStore {
	return &memoryStore{records: records, hasRegistry: true}
}

func TestRetainsOfficialPluginReferencedBySavedConfiguration(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	stored := storedOfficialRecord(t, retentionManifest("openai-videos", "newapi", "2.0.1"), true)
	dataDir := t.TempDir()
	runtime, err := NewRuntimeWithReferences(dataDir, retentionStore(stored), staticReferences{"newapi": {Configured: 2}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "openai-videos")
	if !ok {
		t.Fatal("referenced official plugin was deleted when the release stopped shipping it")
	}
	if item.Retention == nil || !item.Retention.Retired || item.Retention.Unknown {
		t.Fatalf("retention = %#v", item.Retention)
	}
	if item.Status != StatusEnabled {
		t.Fatalf("retained plugin status = %q", item.Status)
	}
	if !strings.Contains(strings.Join(item.Retention.Reasons, ""), "已保存的连接") {
		t.Fatalf("retention reasons = %v", item.Retention.Reasons)
	}
	// Saved configuration stores the provider ID, not the package ID.
	if _, resolvable := runtime.Registry().Resolve("newapi"); !resolvable {
		t.Fatal("retained plugin is not executable by its provider ID")
	}
	catalog := New(runtime, nil).ProviderCatalog("user.custom-channel", "video", false)
	if len(catalog) != 1 || !catalog[0].Retired || catalog[0].RetiredReason == "" {
		t.Fatalf("retired plugin still offered for a new selection: %#v", catalog)
	}
}

func TestRetainsOfficialPluginForUnretrievedTaskOnly(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("xai-video", "xai-video", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"xai-video": {PendingTasks: 3}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "xai-video")
	if !ok {
		t.Fatal("plugin needed to retrieve an unfinished task was deleted")
	}
	if item.Retention == nil || !strings.Contains(strings.Join(item.Retention.Reasons, ""), "未完成或待取回结果的任务") {
		t.Fatalf("retention = %#v", item.Retention)
	}
}

func TestDropsOfficialPluginNobodyReferences(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("retired-unused", "retired-unused", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"other-protocol": {Configured: 5}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(runtime.List(), "retired-unused"); ok {
		t.Fatal("unreferenced retired official plugin survived bootstrap")
	}
	persisted, _, err := runtime.store.LoadPluginRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range persisted {
		if record.ID == "retired-unused" {
			t.Fatal("dropped official plugin was left in the committed registry")
		}
	}
}

func TestRetainsOfficialPluginWhenAuditFails(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("audit-blocked", "audit-blocked", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), failingReferences{})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "audit-blocked")
	if !ok {
		t.Fatal("plugin was deleted because the reference audit failed")
	}
	if item.Retention == nil || !item.Retention.Unknown || !item.Retention.Retired {
		t.Fatalf("retention = %#v", item.Retention)
	}
}

func TestRetainsDisabledOfficialPluginWithoutReenablingIt(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("disabled-official", "disabled-official", "1.0.0"), false)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"disabled-official": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "disabled-official")
	if !ok {
		t.Fatal("disabled official plugin was deleted instead of retained")
	}
	if item.Status != StatusDisabled {
		t.Fatalf("user-disabled plugin was re-enabled: %q", item.Status)
	}
	if runtime.Registry().IsCapability("disabled-official", protocol.CapabilityVideo) {
		t.Fatal("user-disabled plugin became selectable again")
	}
	if item.Retention == nil || !item.Retention.Retired {
		t.Fatalf("retention = %#v", item.Retention)
	}
}

func TestRetainsOfficialPluginWhosePackageFileIsMissing(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("pkg-gone", "pkg-gone", "1.0.0"), true)
	stored.PackagePath = blobFileName(pluginHash([]byte("never-written")))
	stored.PackageSHA256 = pluginHash([]byte("never-written"))
	dataDir := t.TempDir()
	runtime, err := NewRuntimeWithReferences(dataDir, retentionStore(stored), staticReferences{"pkg-gone": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(runtime.List(), "pkg-gone"); !ok {
		t.Fatal("plugin was dropped because its archive is missing")
	}
	// Execution is materialized from the committed manifest, so the missing
	// archive only affects re-download, which reports its own error.
	if _, resolvable := runtime.Registry().Resolve("pkg-gone"); !resolvable {
		t.Fatal("plugin without an archive is not executable")
	}
	if _, _, err := runtime.Package("pkg-gone"); err == nil {
		t.Fatal("missing archive was reported as downloadable")
	}
}

func TestUpgradeKeepsUserDisabledStateAndRetiresNothing(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	shipPackage(t, release, retentionManifest("upgraded-official", "upgraded-official", "2.0.0"))
	stored := storedOfficialRecord(t, retentionManifest("upgraded-official", "upgraded-official", "1.0.0"), false)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"upgraded-official": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "upgraded-official")
	if !ok {
		t.Fatal("shipped plugin missing after upgrade")
	}
	if item.Manifest.Version != "2.0.0" {
		t.Fatalf("upgraded version = %q", item.Manifest.Version)
	}
	if item.Status != StatusDisabled {
		t.Fatalf("upgrade overwrote the user's disabled state: %q", item.Status)
	}
	if item.Retention != nil {
		t.Fatalf("shipped plugin was marked retired: %#v", item.Retention)
	}
}

func TestRollbackShipsPackageAgainAndClearsRetirement(t *testing.T) {
	dataDir := t.TempDir()
	stored := storedOfficialRecord(t, retentionManifest("rollback-official", "rollback-official", "1.0.0"), false)
	store := retentionStore(stored)
	removed := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", removed)
	first, err := NewRuntimeWithReferences(dataDir, store, staticReferences{"rollback-official": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(first.List(), "rollback-official")
	if !ok || item.Retention == nil {
		t.Fatalf("retained before rollback = %#v", item.Retention)
	}
	// Rolling the release back to a version that ships the package again must
	// restore normal handling instead of keeping the retirement marker.
	shipPackage(t, removed, retentionManifest("rollback-official", "rollback-official", "1.0.0"))
	second, err := NewRuntimeWithReferences(dataDir, store, staticReferences{"rollback-official": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok = ByID(second.List(), "rollback-official")
	if !ok {
		t.Fatal("plugin missing after rollback")
	}
	if item.Retention != nil {
		t.Fatalf("retirement survived a release that ships the package: %#v", item.Retention)
	}
	if item.Status != StatusDisabled {
		t.Fatalf("rollback overwrote the user's disabled state: %q", item.Status)
	}
}

func TestRetentionIsDerivedAndNeverPersisted(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("derived-official", "derived-official", "1.0.0"), true)
	store := retentionStore(stored)
	if _, err := NewRuntimeWithReferences(t.TempDir(), store, staticReferences{"derived-official": {Configured: 1}}); err != nil {
		t.Fatal(err)
	}
	persisted, _, err := store.LoadPluginRegistry()
	if err != nil {
		t.Fatal(err)
	}
	var committed RegistryRecord
	for _, record := range persisted {
		if record.ID == stored.ID {
			committed = record
		}
	}
	if committed.ID == "" {
		t.Fatal("retained record missing from the committed registry")
	}
	if string(committed.Raw) != string(stored.Raw) {
		t.Fatal("retention rewrote the committed manifest")
	}
	if strings.Contains(string(committed.Raw), "retired") {
		t.Fatalf("retention leaked into the registry: %s", committed.Raw)
	}
}

func TestRuntimeWithoutAuditStillDropsRemovedOfficialPlugin(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("no-audit", "no-audit", "1.0.0"), true)
	runtime, err := NewRuntimeWithStore(t.TempDir(), retentionStore(stored))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ByID(runtime.List(), "no-audit"); ok {
		t.Fatal("runtime without a reference audit kept a removed official plugin")
	}
}
