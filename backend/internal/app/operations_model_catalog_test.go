package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
)

func TestAgentModelCatalogDesktopUsesActualSnapshotWithoutCredentials(t *testing.T) {
	svc, _ := newModelCatalogTestService(t)
	svc.mode = serviceModeLocal
	body := []byte(`{"channels":[{"id":"beefapi","name":"BeefTV","credentialRef":"beefapi-enterprise","apiKey":"private-key","baseUrl":"https://private-provider.test/v1","headers":[{"name":"Authorization","value":"private-header"}],"enabled":true,"models":["gemini-native","image-model"],"modelProfiles":[{"model":"gemini-native","displayName":"Native Gemini","capability":"text","protocol":"chat-completion"},{"model":"image-model","displayName":"Reference Image","capability":"image","protocol":"openai-image"}]},{"id":"disabled","enabled":false,"models":["hidden"]}]}`)
	if err := svc.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	catalog, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Source != modelcatalog.CatalogSourceSystem || len(catalog.Models) != 0 || len(catalog.Channels) != 1 {
		t.Fatalf("catalog=%#v", catalog)
	}
	ch := catalog.Channels[0]
	if ch.ID != "beefapi" || ch.Name != "BeefTV" || len(ch.Models) != 2 || ch.Models[0].ModelKey != "gemini-native" || !ch.Models[0].Available || ch.Models[1].Capability != "image" {
		t.Fatalf("channel=%#v", ch)
	}
	registry := operations.NewRegistry(svc, operations.NewStore(svc.repo.DB()))
	operations.RegisterDefaultOps(registry)
	result, err := registry.Execute(operations.Request{Op: "model.catalog", UserID: "desktop-owner", Caller: operations.ManualCaller(true), Params: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	var operationCatalog modelcatalog.CatalogResponse
	wire, err := json.Marshal(result.Result)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wire, &operationCatalog); err != nil {
		t.Fatal(err)
	}
	if len(operationCatalog.Channels) != 1 || len(operationCatalog.Channels[0].Models) != 2 {
		t.Fatalf("shared operation result: %#v", result.Result)
	}
	encoded, _ := json.Marshal(catalog)
	for _, secret := range []string{"private-key", "private-header", "private-provider", "baseUrl", "credentialRef", "apiKey"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("leaked %s: %s", secret, encoded)
		}
	}
	if err := svc.SaveLocalModelConfig([]byte(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}
	refreshed, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil || len(refreshed.Channels) != 0 {
		t.Fatalf("refresh=%#v %v", refreshed, err)
	}
}
func TestAgentModelCatalogHostedIgnoresDesktopSnapshot(t *testing.T) {
	svc, db := newModelCatalogTestService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"channels":[{"id":"private","models":["private-model"]}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: featureAvailabilitySettingKey, ValueJSON: `{"frontendModelsEnabled":true}`}).Error; err != nil {
		t.Fatal(err)
	}
	catalog, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Source != modelcatalog.CatalogSourceFrontend || len(catalog.Channels) != 0 || len(catalog.Models) != 0 {
		t.Fatalf("hosted=%#v", catalog)
	}
}

// Profiles here are the desktop persisted contract, including gateway capability
// overrides; catalog projection must preserve them rather than substitute defaults.
func TestAgentModelCatalogPreservesDesktopGenerationProfiles(t *testing.T) {
	svc, _ := newModelCatalogTestService(t)
	svc.mode = serviceModeLocal
	video := modelcatalog.DefaultModelCapabilityConfigForModel("new-api-channel-2", "seedance-2.0-fast")
	video.Video.Resolutions = []string{"480p", "720p"}
	video.Video.DefaultResolution = "480p"
	video.Video.Duration = modelcatalog.VideoDurationConfig{Selection: "enum", Values: []int{5, 10}, Default: 5}
	video.Video.References.MaxImages = 9
	video.Video.References.MaxVideos = 3
	image := modelcatalog.DefaultModelCapabilityConfigForModel("openai-image", "gpt-image-2.5")
	image.Image.References.MaxImages = 7
	profile := func(name, kind, protocol string, config any) map[string]any {
		return map[string]any{"model": name, "displayName": name, "capability": kind, "protocol": protocol, "capabilityConfig": config}
	}
	body, err := json.Marshal(map[string]any{"channels": []any{map[string]any{"id": "beefapi", "name": "BeefTV", "enabled": true, "models": []string{"seedance-2.0-fast", "gpt-image-2.5"}, "modelProfiles": []any{profile("seedance-2.0-fast", "video", "new-api-channel-2", video), profile("gpt-image-2.5", "image", "openai-image", image)}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SaveLocalModelConfig(body); err != nil {
		t.Fatal(err)
	}
	catalog, err := (&operationSession{service: svc}).AgentModelCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Channels) != 1 || len(catalog.Channels[0].Models) != 2 {
		t.Fatalf("catalog=%#v", catalog)
	}
	var gotVideo, gotImage modelcatalog.ModelCapabilityConfig
	raw, _ := json.Marshal(catalog.Channels[0].Models[0].CapabilityConfig)
	if err := json.Unmarshal(raw, &gotVideo); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(catalog.Channels[0].Models[1].CapabilityConfig)
	if err := json.Unmarshal(raw, &gotImage); err != nil {
		t.Fatal(err)
	}
	if gotVideo.Video == nil || gotVideo.Video.DefaultResolution != "480p" || gotVideo.Video.Duration.Default != 5 || gotVideo.Video.References.MaxImages != 9 || gotVideo.Video.References.MaxVideos != 3 {
		t.Fatalf("lost desktop video contract: %#v", gotVideo.Video)
	}
	if gotImage.Image == nil || gotImage.Image.References.MaxImages != 7 || gotImage.Image.Size.Default != image.Image.Size.Default {
		t.Fatalf("lost desktop image contract: %#v", gotImage.Image)
	}
}
