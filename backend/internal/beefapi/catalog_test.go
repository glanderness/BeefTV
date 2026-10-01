package beefapi

import (
	"encoding/json"
	"fmt"
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestCatalogCapabilityMapsBeefAPIEndpointTypes(t *testing.T) {
	cases := []struct {
		id        string
		modelType string
		endpoints []string
		wantCap   string
		wantProto string
	}{
		{endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{endpoints: []string{"openai-response"}, wantCap: "text", wantProto: "openai-response"},
		{endpoints: []string{"openai-response-compact"}, wantCap: "text", wantProto: "openai-response"},
		{endpoints: []string{"anthropic"}, wantCap: "text", wantProto: "claude-api"},
		{endpoints: []string{"gemini"}, wantCap: "text", wantProto: "google-gemini-generate-content"},
		{endpoints: []string{"image-generation"}, wantCap: "image", wantProto: "openai-image"},
		{endpoints: []string{"openai-video"}, wantCap: "video", wantProto: "openai-videos"},
		{endpoints: []string{"openai", "image-generation"}, wantCap: "image", wantProto: "openai-image"},
		{id: "gpt-5.6-sol", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{id: "minimax-speech-2.8-hd", endpoints: []string{"openai"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "minimax-speech-2.8-turbo", endpoints: []string{"openai"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "minimax-music-v3.0", endpoints: []string{"openai"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "minimax-speech-2.8-hd", endpoints: []string{"audio.speech"}, wantCap: "audio", wantProto: "openai-audio"},
		{id: "hy-asr-3.0-preview", endpoints: []string{"openai"}, wantCap: "", wantProto: ""},
		{id: "hy-asr-3.0-preview", endpoints: []string{"audio.transcriptions"}, wantCap: "", wantProto: ""},
		{id: "gpt-image-2", endpoints: []string{"image-generation"}, wantCap: "image", wantProto: "openai-image"},
		{id: "seedance-2.0", endpoints: []string{"openai-video"}, wantCap: "video", wantProto: "newapi"},
		{id: "wan3.0-video", endpoints: []string{"openai-video"}, wantCap: "video", wantProto: "newapi-channel-2"},
		{id: "explicit-image", modelType: "image", endpoints: []string{"openai"}, wantCap: "image", wantProto: "openai-image"},
		{id: "explicit-video", modelType: "video", endpoints: []string{"openai"}, wantCap: "video", wantProto: "openai-videos"},
		{id: "speech-chat", modelType: "text", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{id: "speech-image", modelType: "image", endpoints: []string{"openai"}, wantCap: "image", wantProto: "openai-image"},
		{id: "classr-model", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
		{id: "speechify-bot", endpoints: []string{"openai"}, wantCap: "text", wantProto: "chat-completion"},
	}
	for _, test := range cases {
		capability, protocol := catalogCapabilityAndProtocol(CatalogModel{ID: test.id, ModelType: test.modelType, SupportedEndpointTypes: test.endpoints})
		if capability != test.wantCap || protocol != test.wantProto {
			t.Fatalf("%s %v -> capability=%q protocol=%q, want %q %q", test.id, test.endpoints, capability, protocol, test.wantCap, test.wantProto)
		}
	}
}

func TestApplyCatalogReplacesModelsOnAccountSwitch(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := []CatalogModel{{ID: "model-a", SupportedEndpointTypes: []string{"image-generation"}}, {ID: "model-b", SupportedEndpointTypes: []string{"openai-video"}}}
	if err := applyCatalog(store, first, "", "42"); err != nil {
		t.Fatal(err)
	}
	second := []CatalogModel{{ID: "model-b", SupportedEndpointTypes: []string{"openai-video"}}, {ID: "model-c", SupportedEndpointTypes: []string{"openai"}}}
	if err := applyCatalog(store, second, "42", "99"); err != nil {
		t.Fatal(err)
	}
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channel := findChannel(effective.Config["channels"].([]any), ChannelID)
	ids := map[string]bool{}
	switch models := channel["models"].(type) {
	case []any:
		for _, item := range models {
			ids[item.(string)] = true
		}
	case []string:
		for _, item := range models {
			ids[item] = true
		}
	}
	if ids["model-a"] || !ids["model-b"] || !ids["model-c"] {
		t.Fatalf("account switch merged stale models: %#v", channel["models"])
	}
	profiles, _ := channel["modelProfiles"].([]any)
	foundProtocol := false
	for _, raw := range profiles {
		profile, _ := raw.(map[string]any)
		if profile["model"] == "model-c" && profile["capability"] == "text" && profile["protocol"] == "chat-completion" {
			foundProtocol = true
		}
	}
	if !foundProtocol {
		t.Fatalf("missing mapped protocol: %#v", profiles)
	}
}

func TestApplyCatalogStoresVideoCapabilitiesAndVersion(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, []CatalogModel{{
		ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"},
		VideoCapabilities: sampleCatalogVideo(t, 2, 1), VideoCapabilitiesVersion: "cap-v1",
	}}, "", "42"); err != nil {
		t.Fatal(err)
	}
	profile := catalogProfile(t, store, "seedance-2.0")
	if profile["videoCapabilitiesVersion"] != "cap-v1" {
		t.Fatalf("version = %#v", profile["videoCapabilitiesVersion"])
	}
	if catalogNumber(catalogVideoRefs(t, profile)["maxVideos"]) != 2 || catalogNumber(catalogVideoRefs(t, profile)["maxAudios"]) != 1 {
		t.Fatalf("stored refs = %#v", catalogVideoRefs(t, profile))
	}
}

func TestApplyCatalogRefreshUpdatesManagedCapabilities(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := []CatalogModel{{ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"}, VideoCapabilities: sampleCatalogVideo(t, 3, 3), VideoCapabilitiesVersion: "v1"}}
	if err := applyCatalog(store, first, "", "42"); err != nil {
		t.Fatal(err)
	}
	second := []CatalogModel{{ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"}, VideoCapabilities: sampleCatalogVideo(t, 1, 2), VideoCapabilitiesVersion: "v2"}}
	if err := applyCatalog(store, second, "42", "42"); err != nil {
		t.Fatal(err)
	}
	profile := catalogProfile(t, store, "seedance-2.0")
	if profile["videoCapabilitiesVersion"] != "v2" {
		t.Fatalf("version = %#v", profile["videoCapabilitiesVersion"])
	}
	if catalogNumber(catalogVideoRefs(t, profile)["maxVideos"]) != 1 || catalogNumber(catalogVideoRefs(t, profile)["maxAudios"]) != 2 {
		t.Fatalf("refresh refs = %#v", catalogVideoRefs(t, profile))
	}
}

func TestApplyCatalogPreservesExplicitZeroLimits(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := applyCatalog(store, []CatalogModel{{
		ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"},
		VideoCapabilities: sampleCatalogVideo(t, 0, 0), VideoCapabilitiesVersion: "zero",
	}}, "", "42"); err != nil {
		t.Fatal(err)
	}
	refs := catalogVideoRefs(t, catalogProfile(t, store, "seedance-2.0"))
	if catalogNumber(refs["maxVideos"]) != 0 || catalogNumber(refs["maxAudios"]) != 0 {
		t.Fatalf("explicit zeros rewritten: %#v", refs)
	}
}

func TestApplyCatalogInvalidOrMissingVideoKeepsExisting(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	good := []CatalogModel{{ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"}, VideoCapabilities: sampleCatalogVideo(t, 2, 2), VideoCapabilitiesVersion: "keep"}}
	if err := applyCatalog(store, good, "", "42"); err != nil {
		t.Fatal(err)
	}
	invalid := []CatalogModel{{ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"}, VideoCapabilities: json.RawMessage(`{"operations":[]}`), VideoCapabilitiesVersion: "bad"}}
	if err := applyCatalog(store, invalid, "42", "42"); err != nil {
		t.Fatal(err)
	}
	profile := catalogProfile(t, store, "seedance-2.0")
	if profile["videoCapabilitiesVersion"] != "keep" || catalogNumber(catalogVideoRefs(t, profile)["maxVideos"]) != 2 {
		t.Fatalf("invalid catalog cleared settings: %#v", profile)
	}
	missing := []CatalogModel{{ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"}}}
	if err := applyCatalog(store, missing, "42", "42"); err != nil {
		t.Fatal(err)
	}
	profile = catalogProfile(t, store, "seedance-2.0")
	if profile["videoCapabilitiesVersion"] != "keep" || catalogNumber(catalogVideoRefs(t, profile)["maxVideos"]) != 2 {
		t.Fatalf("legacy omit cleared settings: %#v", profile)
	}
}

func TestApplyCatalogAccountSwitchDoesNotLeakCapabilities(t *testing.T) {
	store, err := workspace.NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first := []CatalogModel{{ID: "seedance-2.0", SupportedEndpointTypes: []string{"openai-video"}, VideoCapabilities: sampleCatalogVideo(t, 3, 3), VideoCapabilitiesVersion: "acct-a"}}
	if err := applyCatalog(store, first, "", "42"); err != nil {
		t.Fatal(err)
	}
	second := []CatalogModel{{ID: "wan3.0-video", SupportedEndpointTypes: []string{"openai-video"}}}
	if err := applyCatalog(store, second, "42", "99"); err != nil {
		t.Fatal(err)
	}
	if _, ok := lookupCatalogProfile(t, store, "seedance-2.0"); ok {
		t.Fatal("previous account Seedance profile leaked")
	}
	profile := catalogProfile(t, store, "wan3.0-video")
	if _, ok := profile["videoCapabilitiesVersion"]; ok {
		t.Fatalf("new account inherited version: %#v", profile)
	}
	if _, ok := profile["capabilityConfig"]; ok {
		t.Fatalf("new account inherited capabilities: %#v", profile)
	}
}

func sampleCatalogVideo(t *testing.T, maxVideos, maxAudios int) json.RawMessage {
	t.Helper()
	body := fmt.Sprintf(`{
		"references": {"promptMaxChars": 8000, "minImages": 0, "maxImages": 9, "maxVideos": %d, "maxAudios": %d, "maxImageBytes": 1, "maxVideoBytes": 1, "maxVideoDurationSeconds": 15, "maxAudioBytes": 1, "maxAudioDurationSeconds": 15},
		"duration": {"selection": "range", "min": 1, "max": 15, "step": 1, "default": 6},
		"ratios": ["16:9"], "defaultRatio": "16:9", "resolutions": ["720p"], "defaultResolution": "720p",
		"generateAudio": {"supported": true, "default": true}, "watermark": {"supported": false, "default": false},
		"operations": ["text_to_video", "image_to_video", "reference_to_video"], "defaultOperation": "text_to_video"
	}`, maxVideos, maxAudios)
	return json.RawMessage(body)
}

func catalogProfile(t *testing.T, store *workspace.ProviderConfig, model string) map[string]any {
	t.Helper()
	profile, ok := lookupCatalogProfile(t, store, model)
	if !ok {
		t.Fatalf("missing profile %s", model)
	}
	return profile
}

func lookupCatalogProfile(t *testing.T, store *workspace.ProviderConfig, model string) (map[string]any, bool) {
	t.Helper()
	effective, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	channel := findChannel(effective.Config["channels"].([]any), ChannelID)
	profiles, _ := channel["modelProfiles"].([]any)
	for _, raw := range profiles {
		profile, _ := raw.(map[string]any)
		if profile["model"] == model {
			return profile, true
		}
	}
	return nil, false
}

func catalogVideoRefs(t *testing.T, profile map[string]any) map[string]any {
	t.Helper()
	config, _ := profile["capabilityConfig"].(map[string]any)
	video, _ := config["video"].(map[string]any)
	refs, _ := video["references"].(map[string]any)
	if refs == nil {
		t.Fatalf("missing video references: %#v", profile)
	}
	return refs
}

func catalogNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case json.Number:
		number, _ := typed.Float64()
		return number
	default:
		return -1
	}
}
