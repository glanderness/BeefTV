package modelcatalog

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestNormalizeCustomImageModelWithoutGuessedLimits(t *testing.T) {
	input := &ModelCapabilityConfig{Version: 1, Image: DefaultImageCapabilityConfig("openai-image", "my-custom-doodle")}
	normalized, err := NormalizeModelCapabilityConfigForModel("image", "openai-image", "my-custom-doodle", input)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Image == nil || normalized.Image.References.MaxImages != 16 {
		t.Fatalf("custom image model should keep stored defaults, got %#v", normalized.Image)
	}
}

func TestDisabledAndUnavailableModelsAreNotPublic(t *testing.T) {
	channels := []model.ModelChannel{
		{ID: "sys", Name: "系统", Enabled: true, SortOrder: 1},
		{ID: "off", Name: "停用", Enabled: false},
	}
	models := map[string][]model.ChannelModel{
		"sys": {
			{ID: "ok", ChannelID: "sys", ModelKey: "ok", DisplayName: "可用", Capability: "audio", Protocol: "openai-audio", Enabled: true},
			{ID: "disabled", ChannelID: "sys", ModelKey: "disabled", DisplayName: "停用模型", Capability: "audio", Protocol: "openai-audio", Enabled: false},
		},
		"off": {
			{ID: "hidden", ChannelID: "off", ModelKey: "hidden", DisplayName: "渠道停用", Capability: "audio", Protocol: "openai-audio", Enabled: true},
		},
	}
	catalog, err := PublicSystemChannelCatalog(channels, func(channelID string) ([]model.ChannelModel, error) {
		return models[channelID], nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 1 || catalog[0].ID != "sys" || len(catalog[0].Models) != 1 || catalog[0].Models[0].ModelKey != "ok" {
		t.Fatalf("catalog should publish only enabled models on enabled channels: %#v", catalog)
	}
	if catalog[0].Models[0].CapabilityConfig != nil {
		t.Fatal("audio models must not leak a capability JSON object")
	}
}

func TestSanitizeChannelModelOmitsSecrets(t *testing.T) {
	cfg := DefaultModelCapabilityConfigForModel("newapi-channel-2", "seedance-2.0")
	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	public, err := SanitizeChannelModel(&model.ChannelModel{
		ID: "m1", ChannelID: "sys", ModelKey: "seed", DisplayName: "Seed",
		Capability: "video", Protocol: "newapi-channel-2", Enabled: true,
		CapabilityConfigJSON: string(encoded),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(string(body))
	if strings.Contains(lower, "apikey") || strings.Contains(lower, "secret") || strings.Contains(lower, "baseurl") {
		t.Fatalf("public model leaked credential-shaped fields: %s", body)
	}
}

func TestCorruptCapabilityJSONFailsClosedOnSanitize(t *testing.T) {
	_, err := SanitizeChannelModel(&model.ChannelModel{
		ID: "bad", ModelKey: "bad", Capability: "video", Protocol: "newapi", Enabled: true,
		CapabilityConfigJSON: "{not-json",
	})
	if err == nil {
		t.Fatal("corrupt capability JSON must fail closed")
	}
}
