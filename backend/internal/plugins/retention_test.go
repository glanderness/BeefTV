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

// TestDeferredUpgradeKeepsTheOldQueryDefinition covers an upgrade that changes the
// query path while a task has not retrieved its result yet. Tasks are not bound to
// a plugin version, so adopting the new definition would change how that task is
// polled; the installed definition must survive this startup.
func TestDeferredUpgradeKeepsTheOldQueryDefinition(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	oldManifest := retentionManifestWithPoll("upgraded-query", "upgraded-query", "1.0.0", "/v1/videos/{{taskId}}")
	newManifest := retentionManifestWithPoll("upgraded-query", "upgraded-query", "2.0.0", "/v1/video/generations/{{taskId}}")
	shipPackage(t, release, newManifest)
	stored := storedOfficialRecord(t, oldManifest, true)
	store := retentionStore(stored)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), store, staticReferences{"upgraded-query": {PendingTasks: 1}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "upgraded-query")
	if !ok {
		t.Fatal("plugin disappeared during a deferred upgrade")
	}
	if item.Manifest.Version != "1.0.0" {
		t.Fatalf("adopted the new definition while a task still needs the old one: version %q", item.Manifest.Version)
	}
	if item.Retention == nil || item.Retention.Retired {
		t.Fatalf("deferred upgrade must stay selectable: %#v", item.Retention)
	}
	if !strings.Contains(strings.Join(item.Retention.Reasons, ""), "升级已推迟") {
		t.Fatalf("retention reasons = %v", item.Retention.Reasons)
	}
	// The old poll path is still what the registry executes with.
	if adapter, resolvable := runtime.Registry().Resolve("upgraded-query"); !resolvable || !strings.Contains(adapter.Metadata().Poll, "/v1/videos/") {
		t.Fatalf("execution definition changed under an unfinished task: %#v", adapter.Metadata().Poll)
	}
	// A deferred plugin is still shipped, so it stays offered for new selections.
	catalog := New(runtime, nil).ProviderCatalog("user.custom-channel", "video", false)
	if len(catalog) != 1 || catalog[0].Retired {
		t.Fatalf("deferred plugin was retired from the catalog: %#v", catalog)
	}
	// The stored registry keeps the old manifest, so the next startup re-decides.
	persisted, _, err := store.LoadPluginRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range persisted {
		if record.ID == "upgraded-query" && !strings.Contains(string(record.Raw), `"1.0.0"`) {
			t.Fatalf("deferred upgrade was persisted: %s", record.Raw)
		}
	}
}

// TestUpgradeAdoptsNewDefinitionOnceWorkIsDone proves the deferral is temporary:
// the same stored record follows the shipped package on the next startup.
func TestUpgradeAdoptsNewDefinitionOnceWorkIsDone(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	oldManifest := retentionManifestWithPoll("late-upgrade", "late-upgrade", "1.0.0", "/v1/videos/{{taskId}}")
	newManifest := retentionManifestWithPoll("late-upgrade", "late-upgrade", "2.0.0", "/v1/video/generations/{{taskId}}")
	shipPackage(t, release, newManifest)
	stored := storedOfficialRecord(t, oldManifest, true)
	store := retentionStore(stored)
	pending := staticReferences{"late-upgrade": {PendingTasks: 1}}
	if _, err := NewRuntimeWithReferences(t.TempDir(), store, pending); err != nil {
		t.Fatal(err)
	}
	finished := staticReferences{"late-upgrade": {Configured: 1}}
	second, err := NewRuntimeWithReferences(t.TempDir(), store, finished)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(second.List(), "late-upgrade")
	if !ok || item.Manifest.Version != "2.0.0" {
		t.Fatalf("upgrade did not resume after the task finished: %#v", item.Manifest.Version)
	}
	if item.Retention != nil {
		t.Fatalf("retention survived the completed upgrade: %#v", item.Retention)
	}
}

// TestSavedConnectionAloneNeverFreezesAnUpgrade keeps the deferral narrow: a saved
// connection without unfinished work must not pin a plugin to an old version.
func TestSavedConnectionAloneNeverFreezesAnUpgrade(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	shipPackage(t, release, retentionManifest("config-only", "config-only", "2.0.0"))
	stored := storedOfficialRecord(t, retentionManifest("config-only", "config-only", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"config-only": {Configured: 4}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "config-only")
	if !ok || item.Manifest.Version != "2.0.0" {
		t.Fatalf("saved configuration blocked an upgrade: %#v", item.Manifest.Version)
	}
}

// TestRetentionSurvivesUnrelatedPluginChanges covers every rebuild path: installing,
// enabling or disabling another plugin must not turn a retired protocol back into a
// selectable one.
func TestRetentionSurvivesUnrelatedPluginChanges(t *testing.T) {
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", t.TempDir())
	stored := storedOfficialRecord(t, retentionManifest("kept-official", "newapi", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"newapi": {PendingTasks: 1}})
	if err != nil {
		t.Fatal(err)
	}
	service := New(runtime, nil)
	assertRetired := func(stage string) {
		t.Helper()
		item, ok := ByID(runtime.List(), "kept-official")
		if !ok || item.Retention == nil || !item.Retention.Retired {
			t.Fatalf("%s: retention lost: %#v", stage, item.Retention)
		}
		catalog := service.ProviderCatalog("user.custom-channel", "video", false)
		for _, entry := range catalog {
			if entry.ID == "newapi" && !entry.Retired {
				t.Fatalf("%s: retired protocol offered again for a new selection", stage)
			}
		}
	}
	assertRetired("startup")
	if _, err := runtime.Install(testPluginPackage(t, testManifest("unrelated-app", "1.0.0")), "unrelated-app.beeftv-plugin"); err != nil {
		t.Fatal(err)
	}
	assertRetired("after install")
	if _, err := runtime.SetEnabled("unrelated-app", false); err != nil {
		t.Fatal(err)
	}
	assertRetired("after disable")
	if _, err := runtime.SetEnabled("unrelated-app", true); err != nil {
		t.Fatal(err)
	}
	assertRetired("after enable")
	if err := runtime.Uninstall("unrelated-app"); err != nil {
		t.Fatal(err)
	}
	assertRetired("after uninstall")
}

// retentionManifestWithPoll is retentionManifest with an explicit poll path, so a
// test can make an upgrade change what the runtime queries.
func retentionManifestWithPoll(pluginID, providerID, version, pollPath string) []byte {
	return []byte(fmt.Sprintf(`{"apiVersion":"beeftv.plugin/v1","id":%q,"version":%q,"name":%q,"author":"Test","documentation":"# %s","contributes":{"providers":[{"id":%q,"label":%q,"capabilities":["video"],"scopes":["canvas","user.custom-channel"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"}},"poll":{"method":"GET","path":%q},"response":{"statusPaths":["status"]}}]}}`, pluginID, version, pluginID, pluginID, providerID, providerID, pollPath))
}

// TestFailedAuditDefersUpgradeOfShippedPlugin covers "cannot tell" being treated
// like "nothing pending": a broken configuration file makes the inventory
// unreadable while tasks may still need the installed definition, so the shipped
// package must not overwrite it.
func TestFailedAuditDefersUpgradeOfShippedPlugin(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	oldManifest := retentionManifestWithPoll("audit-failed-upgrade", "audit-failed-upgrade", "1.0.0", "/v1/videos/{{taskId}}")
	newManifest := retentionManifestWithPoll("audit-failed-upgrade", "audit-failed-upgrade", "2.0.0", "/v1/video/generations/{{taskId}}")
	shipPackage(t, release, newManifest)
	stored := storedOfficialRecord(t, oldManifest, true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), failingReferences{})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "audit-failed-upgrade")
	if !ok {
		t.Fatal("plugin disappeared while the inventory was unreadable")
	}
	if item.Manifest.Version != "1.0.0" {
		t.Fatalf("overwrote the installed definition while the inventory was unreadable: version %q", item.Manifest.Version)
	}
	if adapter, resolvable := runtime.Registry().Resolve("audit-failed-upgrade"); !resolvable || !strings.Contains(adapter.Metadata().Poll, "/v1/videos/") {
		t.Fatalf("execution definition changed under an unreadable inventory: %#v", adapter.Metadata().Poll)
	}
	if item.Retention == nil || item.Retention.Retired {
		t.Fatalf("deferred upgrade must stay selectable: %#v", item.Retention)
	}
	if !strings.Contains(strings.Join(item.Retention.Reasons, ""), "盘点失败") {
		t.Fatalf("retention reasons = %v", item.Retention.Reasons)
	}
}

// TestFailedAuditStillAdoptsAnUnchangedPackage keeps the deferral about changes
// only: with an unreadable inventory a package that did not change is not
// "deferred", there is simply nothing to decide.
func TestFailedAuditStillAdoptsAnUnchangedPackage(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	manifest := retentionManifestWithPoll("audit-failed-same", "audit-failed-same", "1.0.0", "/v1/videos/{{taskId}}")
	shipPackage(t, release, manifest)
	stored := storedOfficialRecord(t, manifest, true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), failingReferences{})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "audit-failed-same")
	if !ok || item.Manifest.Version != "1.0.0" {
		t.Fatalf("unchanged package was not adopted: %#v", item.Manifest.Version)
	}
	if item.Retention != nil {
		t.Fatalf("unchanged package reported a deferral: %#v", item.Retention)
	}
}

// TestFailedAuditStillInstallsNewShippedPlugin keeps the deferral to upgrades: a
// plugin this release ships but that is not installed yet has no old definition
// to preserve, so an unreadable inventory must not make it silently absent.
func TestFailedAuditStillInstallsNewShippedPlugin(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	shipPackage(t, release, retentionManifest("brand-new-official", "brand-new-official", "1.0.0"))
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(), failingReferences{})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "brand-new-official")
	if !ok {
		t.Fatal("a newly shipped plugin was skipped because the inventory was unreadable")
	}
	if item.Manifest.Version != "1.0.0" || item.Status != StatusEnabled {
		t.Fatalf("new plugin = version %q status %q", item.Manifest.Version, item.Status)
	}
	if item.Retention != nil {
		t.Fatalf("a fresh install reported a deferral: %#v", item.Retention)
	}
	if _, resolvable := runtime.Registry().Resolve("brand-new-official"); !resolvable {
		t.Fatal("new plugin is not executable")
	}
}

// TestUpgradeThatDropsASavedProviderIDIsDeferred covers an upgrade with no
// unfinished task that removes or renames a provider ID saved configuration
// still runs with. Adopting it would leave that configuration with no definition,
// so the installed one must survive; an upgrade that keeps the ID still goes
// through (TestSavedConnectionAloneNeverFreezesAnUpgrade).
func TestUpgradeThatDropsASavedProviderIDIsDeferred(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	shipPackage(t, release, retentionManifest("renamed-provider", "renamed-v2", "2.0.0"))
	stored := storedOfficialRecord(t, retentionManifest("renamed-provider", "renamed-v1", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"renamed-v1": {Configured: 2}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "renamed-provider")
	if !ok || item.Manifest.Version != "1.0.0" {
		t.Fatalf("an upgrade dropping a saved provider ID was adopted: %#v", item.Manifest.Version)
	}
	if item.Retention == nil || !strings.Contains(strings.Join(item.Retention.Reasons, ""), "删除或改名") {
		t.Fatalf("retention = %#v", item.Retention)
	}
	if _, resolvable := runtime.Registry().Resolve("renamed-v1"); !resolvable {
		t.Fatal("saved configuration lost the provider ID it runs with")
	}
	// Once nothing saved uses the old ID, the next startup adopts the new version.
	second, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{})
	if err != nil {
		t.Fatal(err)
	}
	if item, ok := ByID(second.List(), "renamed-provider"); !ok || item.Manifest.Version != "2.0.0" {
		t.Fatalf("upgrade did not resume once the old ID was unused: %#v", item.Manifest.Version)
	}
}

// TestUpgradeRenamingAProviderNamedLikeItsPluginIsDeferred covers a plugin whose
// ID equals its old provider ID (`xai-video`). The new version keeps the plugin
// ID but renames the provider, so the old ID no longer resolves even though it
// still names the package; saved configuration using it must keep the old
// definition.
func TestUpgradeRenamingAProviderNamedLikeItsPluginIsDeferred(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	shipPackage(t, release, retentionManifest("same-name-video", "same-name-video-v2", "2.0.0"))
	stored := storedOfficialRecord(t, retentionManifest("same-name-video", "same-name-video", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"same-name-video": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(runtime.List(), "same-name-video")
	if !ok || item.Manifest.Version != "1.0.0" {
		t.Fatalf("an upgrade renaming the provider named like its plugin was adopted: %#v", item.Manifest.Version)
	}
	if _, resolvable := runtime.Registry().Resolve("same-name-video"); !resolvable {
		t.Fatal("saved configuration lost the provider ID it runs with")
	}
}

// TestUpgradeKeepingALegacyAliasIsAdopted keeps the check about resolution: an
// ID the new version still answers to through a legacy alias is not dropped.
func TestUpgradeKeepingALegacyAliasIsAdopted(t *testing.T) {
	release := t.TempDir()
	t.Setenv("CANVAS_OFFICIAL_PLUGIN_DIR", release)
	// openai-videos contributes `newapi` and keeps `openai-videos` as an alias.
	shipPackage(t, release, retentionManifest("openai-videos", "newapi", "2.0.0"))
	stored := storedOfficialRecord(t, retentionManifest("openai-videos", "newapi", "1.0.0"), true)
	runtime, err := NewRuntimeWithReferences(t.TempDir(), retentionStore(stored), staticReferences{"openai-videos": {Configured: 1}, "newapi": {Configured: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if item, ok := ByID(runtime.List(), "openai-videos"); !ok || item.Manifest.Version != "2.0.0" {
		t.Fatalf("an upgrade that still resolves every saved ID was deferred: %#v", item.Manifest.Version)
	}
}
