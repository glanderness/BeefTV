package beefapi

import (
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestUnknownImageCatalogRefreshChangesCapabilitiesWithoutModelTable(t *testing.T) {
	const id = "opaque-future-2030"
	capability := map[string]any{
		"references":            map[string]any{"promptMaxChars": 0, "maxImages": 2, "maxImageBytes": 0, "maskSupported": true},
		"size":                  map[string]any{"parameter": "size", "values": []string{"1024x1024"}, "default": "1024x1024", "allowCustom": true},
		"quality":               map[string]any{"supported": true, "values": []string{"ultra"}, "default": "ultra"},
		"transparentBackground": map[string]any{"supported": true, "default": false}, "responseFormat": map[string]any{"supported": false}, "outputFormat": map[string]any{"supported": true}, "maxOutputs": 4, "fixedOutputs": 4,
	}
	fake := &fakeEnterprise{models: []map[string]any{{"id": id, "supported_endpoint_types": []string{"image-generation"}, "image_capabilities": capability, "image_capabilities_version": "v1"}}}
	svc, _, dir := testService(t, fake)
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	assertStored := func(version string, refs float64) {
		t.Helper()
		store, err := workspace.NewProviderConfig(dir)
		if err != nil {
			t.Fatal(err)
		}
		current, _, err := store.LoadEffectiveModelConfig()
		if err != nil {
			t.Fatal(err)
		}
		profile := refreshTestProfile(findChannel(current.Config["channels"].([]any), ChannelID), id)
		if profile == nil || profile["protocol"] != "openai-image" || profile["imageCapabilitiesVersion"] != version {
			t.Fatalf("missing server profile: %#v", profile)
		}
		image := profile["capabilityConfig"].(map[string]any)["image"].(map[string]any)
		if image["references"].(map[string]any)["maxImages"] != refs || image["references"].(map[string]any)["maxImageBytes"] != float64(0) || image["quality"].(map[string]any)["default"] != "ultra" || image["fixedOutputs"] != float64(4) {
			t.Fatalf("server capabilities replaced by defaults: %#v", image)
		}
	}
	assertStored("v1", 2)
	fake.mu.Lock()
	capability["references"].(map[string]any)["maxImages"] = 7
	fake.models[0]["image_capabilities_version"] = "v2"
	fake.mu.Unlock()
	models, err := svc.RefreshCatalog(context.Background())
	if err != nil || len(models) != 1 {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(models)
	if len(raw) == 0 {
		t.Fatal("empty catalog projection")
	}
	assertStored("v2", 7)
}
