package app

import (
	"testing"

	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantProductionSeedreamSingleImageConfig(t *testing.T) {
	svc, _, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::seedream-5-0-260128","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["seedream-5-0-260128"],"modelProfiles":[{"model":"seedream-5-0-260128","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	options := map[string]string{"seedreamMode": "image", "seedreamMaxImages": "1", "seedreamOutputFormat": "jpeg", "seedreamOptimize": "fast", "seedreamWatermark": "true"}
	config, err := svc.assistantGenerationConfig(operations.GenerationTarget{Kind: "image", ModelKey: "custom::seedream-5-0-260128", Parameters: options})
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range options {
		if config[k] != v {
			t.Fatalf("confirmed setting %s lost before generation: %+v", k, config)
		}
	}
	if config["model"] != "seedream-5-0-260128" || config["count"] != "1" {
		t.Fatalf("single-image model/count changed: %+v", config)
	}
}

func TestAssistantProductionPreservesBYOKChannelAuthAndHeaders(t *testing.T) {
	svc, _, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{
		"imageModel":"portable-aipai-3::custom-image",
		"channels":[{
			"id":"portable-aipai-3",
			"enabled":true,
			"baseUrl":"https://byok.example.invalid/v1",
			"apiKey":"sk-byok-key",
			"secretKey":"sk-byok-secret",
			"referenceAssetOrigin":"https://assets.example.invalid",
			"headers":[{"name":"X-Auth","value":"custom-token"}],
			"models":["custom-image"],
			"modelProfiles":[{"model":"custom-image","capability":"image","protocol":"openai-image"}]
		}]
	}`)); err != nil {
		t.Fatal(err)
	}
	config, err := svc.assistantGenerationConfig(operations.GenerationTarget{
		Kind:     "image",
		ModelKey: "portable-aipai-3::custom-image",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, hasChannelID := config["channelId"]; hasChannelID {
		t.Fatalf("custom BYOK channel must not set system channelId, got %#v", config["channelId"])
	}
	if !modelcatalog.TaskInputUsesCustomChannel(map[string]any{"config": config}) {
		t.Fatalf("expected custom BYOK channel config to be admitted as custom channel, got %+v", config)
	}
	if config["secretKey"] != "sk-byok-secret" {
		t.Fatalf("secretKey = %#v, want sk-byok-secret", config["secretKey"])
	}
	if config["referenceAssetOrigin"] != "https://assets.example.invalid" {
		t.Fatalf("referenceAssetOrigin = %#v, want https://assets.example.invalid", config["referenceAssetOrigin"])
	}
	rawHeaders, ok := config["headers"]
	if !ok || rawHeaders == nil {
		t.Fatalf("expected BYOK headers to be preserved in config, got %+v", config)
	}
}
