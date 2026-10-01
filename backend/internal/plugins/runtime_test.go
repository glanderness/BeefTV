package plugins

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func TestRuntimeLoadsOfficialPackagesAndBundledWorkflow(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	items := runtime.List()
	if len(items) == 0 {
		t.Fatal("runtime loaded no plugins; build plugin-packages first")
	}
	foundWorkflow := false
	foundOfficial := false
	for _, item := range items {
		if item.Manifest.ID == WorkflowRunningHub {
			foundWorkflow = true
			if item.Source != OriginOfficial {
				t.Fatalf("workflow source = %q", item.Source)
			}
			if item.Status != StatusDisabled {
				t.Fatalf("bundled workflow default status = %q", item.Status)
			}
		}
		if item.Source == OriginOfficial && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			foundOfficial = true
		}
	}
	if !foundWorkflow {
		t.Fatal("bundled RunningHub workflow missing")
	}
	if !foundOfficial {
		t.Fatal("no official packaged plugin loaded; run plugin-packages/build-packages.sh")
	}
}

func TestInstallRejectsOfficialPackageCollision(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var official View
	for _, item := range runtime.List() {
		if item.Source == OriginOfficial && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			official = item
			break
		}
	}
	if official.Manifest.ID == "" {
		t.Fatal("no official protocol plugin to collide with; run plugin-packages/build-packages.sh")
	}
	manifest := testManifest(official.Manifest.ID, "1.0.0")
	_, err = runtime.Install(testPluginPackage(t, manifest), official.Manifest.ID+".beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "不能通过上传覆盖") {
		t.Fatalf("official collision error = %v", err)
	}
}

func TestInstallRejectsMalformedPackages(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Install(nil, "empty.beeftv-plugin"); err == nil {
		t.Fatal("empty package accepted")
	}
	if _, err := runtime.Install([]byte("not-a-zip"), "broken.beeftv-plugin"); err == nil {
		t.Fatal("non-zip package accepted")
	}
	if _, err := runtime.Install([]byte(`{"apiVersion":"beeftv.plugin/v1"}`), "legacy.json"); err == nil {
		t.Fatal("bare JSON manifest accepted")
	}
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("readme.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("no manifest")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Install(buffer.Bytes(), "missing-manifest.beeftv-plugin"); err == nil {
		t.Fatal("zip without manifest.json accepted")
	}
	if _, err := runtime.Install(testPluginPackage(t, []byte(`{"apiVersion":`)), "truncated.beeftv-plugin"); err == nil {
		t.Fatal("truncated manifest accepted")
	}
}

func TestInstallCustomUpdateAndDisabledRecovery(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	plugin, err := runtime.Install(testPluginPackage(t, testManifest("uploaded-runtime", "1.0.0")), "uploaded-runtime.beeftv-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.Status != StatusEnabled || plugin.Source != OriginUploaded {
		t.Fatalf("installed plugin = %#v", plugin)
	}
	if !runtime.Registry().IsCapability("uploaded-runtime", protocol.CapabilityVideo) {
		t.Fatal("installed plugin was not registered")
	}
	updated, err := runtime.Install(testPluginPackage(t, testManifest("uploaded-runtime", "2.0.0")), "uploaded-runtime-v2.beeftv-plugin")
	if err != nil || updated.Manifest.Version != "2.0.0" {
		t.Fatalf("update = %#v, err = %v", updated, err)
	}
	if _, err := runtime.SetEnabled("uploaded-runtime", false); err != nil {
		t.Fatal(err)
	}
	if runtime.Registry().IsCapability("uploaded-runtime", protocol.CapabilityVideo) {
		t.Fatal("disabled plugin remained selectable")
	}
	restarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	disabled, ok := ByID(restarted.List(), "uploaded-runtime")
	if !ok || disabled.Status != StatusDisabled {
		t.Fatalf("disabled recovery = %#v ok=%v", disabled, ok)
	}
	adapter, ok := restarted.Registry().Resolve("uploaded-runtime")
	if !ok || adapter.Metadata().Enabled {
		t.Fatal("disabled plugin bypassed registry snapshot after restart")
	}
}

func TestMutationRollsBackWhenReloadFails(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	before := ids(runtime.List())
	runtime.failNextReload(errors.New("forced reload failure"))
	_, err = runtime.Install(testPluginPackage(t, testManifest("atomic-install", "1.0.0")), "atomic-install.beeftv-plugin")
	if err == nil || !strings.Contains(err.Error(), "forced reload failure") {
		t.Fatalf("install error = %v", err)
	}
	if got := ids(runtime.List()); !sameIDs(got, before) {
		t.Fatalf("install rollback list = %#v, want %#v", got, before)
	}

	plugin, err := runtime.Install(testPluginPackage(t, testManifest("atomic-toggle", "1.0.0")), "atomic-toggle.beeftv-plugin")
	if err != nil {
		t.Fatal(err)
	}
	if plugin.Status != StatusEnabled {
		t.Fatalf("toggle fixture status = %s", plugin.Status)
	}
	runtime.failNextReload(errors.New("forced enable failure"))
	if _, err := runtime.SetEnabled("atomic-toggle", false); err == nil || !strings.Contains(err.Error(), "forced enable failure") {
		t.Fatalf("setEnabled error = %v", err)
	}
	still, ok := ByID(runtime.List(), "atomic-toggle")
	if !ok || still.Status != StatusEnabled {
		t.Fatalf("setEnabled rollback = %#v", still)
	}

	runtime.failNextReload(errors.New("forced uninstall failure"))
	if err := runtime.Uninstall("atomic-toggle"); err == nil || !strings.Contains(err.Error(), "forced uninstall failure") {
		t.Fatalf("uninstall error = %v", err)
	}
	if _, ok := ByID(runtime.List(), "atomic-toggle"); !ok {
		t.Fatal("uninstall rollback dropped the plugin")
	}
}

func TestConcurrentReloadAndMutation(t *testing.T) {
	runtime, err := NewRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var start sync.WaitGroup
	var work sync.WaitGroup
	start.Add(1)
	errorsCh := make(chan error, 12)
	for i := 0; i < 8; i++ {
		work.Add(1)
		go func() {
			defer work.Done()
			start.Wait()
			for n := 0; n < 20; n++ {
				_ = runtime.List()
				if registry := runtime.Registry(); registry != nil {
					_ = registry.List("", "", true)
				}
			}
		}()
	}
	for i := 0; i < 3; i++ {
		work.Add(1)
		id := fmt.Sprintf("concurrent-upload-%d", i)
		go func(pluginID string) {
			defer work.Done()
			start.Wait()
			_, err := runtime.Install(testPluginPackage(t, testManifest(pluginID, "1.0.0")), pluginID+".beeftv-plugin")
			if err != nil {
				errorsCh <- err
				return
			}
			if _, err := runtime.SetEnabled(pluginID, false); err != nil {
				errorsCh <- err
				return
			}
			if _, err := runtime.SetEnabled(pluginID, true); err != nil {
				errorsCh <- err
			}
		}(id)
	}
	start.Done()
	work.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("concurrent-upload-%d", i)
		item, ok := ByID(runtime.List(), id)
		if !ok || item.Status != StatusEnabled {
			t.Fatalf("concurrent plugin %s = %#v ok=%v", id, item, ok)
		}
		if !runtime.Registry().IsCapability(id, protocol.CapabilityVideo) {
			t.Fatalf("concurrent plugin %s missing from registry", id)
		}
	}
}

func TestDisabledOfficialStateSurvivesRestart(t *testing.T) {
	dataDir := t.TempDir()
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	var officialID string
	for _, item := range runtime.List() {
		if item.Source == OriginOfficial && item.Status == StatusEnabled && strings.HasSuffix(item.FileName, protocol.PluginPackageExtension) {
			officialID = item.Manifest.ID
			break
		}
	}
	if officialID == "" {
		t.Fatal("no enabled official plugin; run plugin-packages/build-packages.sh")
	}
	if _, err := runtime.SetEnabled(officialID, false); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	item, ok := ByID(restarted.List(), officialID)
	if !ok || item.Status != StatusDisabled {
		t.Fatalf("restarted official plugin = %#v", item)
	}
}

func TestRuntimeDropsRemovedOfficialProtocol(t *testing.T) {
	staleManifest := json.RawMessage(`{"apiVersion":"beeftv.plugin/v2","id":"removed-official-protocol","version":"1.0.0","name":"Removed Official Protocol","author":"Test","documentation":"# Removed\n\n## BeefTV运行时合同","contributes":{"providers":[{"id":"removed-official-protocol","label":"Removed","capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks","body":{"prompt":{"$ref":"request.prompt"}}},"response":{"status":"pending"}}]}}`)
	registryData, err := json.Marshal([]RegistryRecord{{ID: "removed-official-protocol", Raw: staleManifest, Source: OriginOfficial}})
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "plugin_registry.json"), registryData, 0o600); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuntime(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := runtime.Registry().Resolve("removed-official-protocol"); ok {
		t.Fatal("removed official protocol survived bootstrap")
	}
}

func testManifest(id, version string) []byte {
	return []byte(fmt.Sprintf(`{"apiVersion":"beeftv.plugin/v1","id":%q,"version":%q,"name":%q,"author":"Test","documentation":"# %s","contributes":{"providers":[{"id":%q,"label":%q,"capabilities":["video"],"scopes":["canvas"],"create":{"method":"POST","path":"/tasks","fields":{"prompt":"request.prompt"}},"response":{"statusPaths":["status"]}}]}}`, id, version, id, id, id, id))
}

func testPluginPackage(t *testing.T, manifest []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(manifest); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func ids(items []View) []string {
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, item.Manifest.ID)
	}
	return result
}

func sameIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	index := make(map[string]struct{}, len(want))
	for _, id := range want {
		index[id] = struct{}{}
	}
	for _, id := range got {
		if _, ok := index[id]; !ok {
			return false
		}
	}
	return true
}
