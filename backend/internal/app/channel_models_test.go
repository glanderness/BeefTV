package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newChannelModelTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelVariant{}, &model.LogicalModel{}, &model.LogicalModelRevision{}, &model.LogicalModelRoute{}, &model.Task{}, &model.IDSequence{}); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db
}

func mustEncodeModelCapabilityConfig(t *testing.T, config *ModelCapabilityConfig) string {
	t.Helper()
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestSanitizeChannelModelRejectsCorruptCapabilityConfig(t *testing.T) {
	svc := &Service{}
	_, err := svc.sanitizeChannelModel(&model.ChannelModel{
		ID:                   "broken-image-model",
		Capability:           "image",
		CapabilityConfigJSON: `{`,
	})
	if err == nil {
		t.Fatal("sanitizeChannelModel() should reject corrupt capability JSON")
	}
}

func TestSanitizeChannelModelAvailabilityIsIndependentOfVariants(t *testing.T) {
	svc := &Service{}
	channelModel := &model.ChannelModel{
		ID:                   "image-model",
		ModelKey:             "image-model",
		Capability:           "image",
		Protocol:             model.ChannelInterfaceOpenAIImage,
		CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "image-model")),
		Enabled:              true,
	}

	public, err := svc.sanitizeChannelModel(channelModel)
	if err != nil {
		t.Fatal(err)
	}
	if !public.Available {
		t.Fatal("an enabled local model must remain available without a model variant")
	}

	channelModel.Variants = []model.ChannelModelVariant{{
		ID:      "tier-1",
		Enabled: true,
	}}
	public, err = svc.sanitizeChannelModel(channelModel)
	if err != nil {
		t.Fatal(err)
	}
	if !public.Available {
		t.Fatalf("model variants changed local availability: %#v", public)
	}
}

func TestChannelModelMatchesIntentUsesPersistedCapabilityContract(t *testing.T) {
	svc := &Service{}
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "image-model")
	profile.Image.References.MaxImages = 1
	channelModel := &model.ChannelModel{
		ID:                   "image-model",
		ModelKey:             "image-model",
		Capability:           "image",
		Protocol:             model.ChannelInterfaceOpenAIImage,
		CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile),
	}

	matched, err := svc.channelModelMatchesIntent(channelModel, &ModelRequestIntent{
		Capability: "image",
		Inputs:     map[string]int{"image": 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if matched {
		t.Fatal("request exceeding the persisted reference-image limit should not match")
	}

	channelModel.CapabilityConfigJSON = `{`
	if _, err := svc.channelModelMatchesIntent(channelModel, &ModelRequestIntent{Capability: "image"}); err == nil {
		t.Fatal("corrupt persisted capability config should fail closed")
	}
}

func TestPublicSystemChannelCatalogIsolatesCorruptModel(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := model.ModelChannel{ID: "system-channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "系统渠道"}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	validConfig := mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "valid-model"))
	models := []model.ChannelModel{
		{ID: "valid-model", ChannelID: channel.ID, ModelKey: "valid-model", Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage, CapabilityConfigJSON: validConfig, Enabled: true},
		{ID: "broken-model", ChannelID: channel.ID, ModelKey: "broken-model", Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage, CapabilityConfigJSON: `{`, Enabled: true},
	}
	for index := range models {
		if err := db.Create(&models[index]).Error; err != nil {
			t.Fatal(err)
		}
	}

	catalog, err := svc.publicSystemChannelCatalog(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 1 || len(catalog[0].Models) != 1 || catalog[0].Models[0].ID != "valid-model" {
		t.Fatalf("catalog should retain only the valid model: %#v", catalog)
	}
}

func TestRuntimeConcurrencyUsesEnvironmentFallback(t *testing.T) {
	t.Setenv("CANVAS_CHANNEL_CONCURRENCY", "7")
	t.Setenv("CANVAS_WORKER_CONCURRENCY", "9")
	setting := defaultRuntimePolicy().Task
	if setting.ChannelConcurrency != 7 || setting.WorkerConcurrency != 9 {
		t.Fatalf("defaultRuntimePolicy().Task = %#v", setting)
	}
}

func TestResolveProviderConfigMapsSKUToProviderModel(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	svc.dataDir = t.TempDir()
	encryptedKey, err := svc.encryptSettingSecret("test-key")
	if err != nil {
		t.Fatal(err)
	}
	channel := model.ModelChannel{
		ID: "channel-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "Seedance",
		BaseURL: "https://ark.cn-beijing.volces.com/api/v3", APIKey: encryptedKey, APIFormat: "openai", ModelsJSON: `["seedance-2-5-480p"]`,
	}
	item := model.ChannelModel{
		ID: "model-1", ChannelID: channel.ID, ModelKey: "seedance-2-5-480p", ProviderModelKey: "doubao-seedance-2-5",
		Capability: "video", Protocol: model.ChannelInterfaceVolcengineArkVideo, Enabled: true,
	}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}

	config, err := svc.resolveProviderConfig(providerConfig{ChannelID: channel.ID, Model: item.ModelKey})
	if err != nil {
		t.Fatal(err)
	}
	if config.ChannelModelKey != item.ModelKey || config.Model != item.ProviderModelKey {
		t.Fatalf("resolved config = %#v", config)
	}
	again, err := svc.resolveProviderConfig(config)
	if err != nil {
		t.Fatalf("resolved SKU must be idempotent: %v", err)
	}
	if again.ChannelModelKey != item.ModelKey || again.Model != item.ProviderModelKey {
		t.Fatalf("second resolve = %#v", again)
	}
}

func TestResolveProviderConfigRejectsHostileUpstreamKey(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	svc.dataDir = t.TempDir()
	encryptedKey, err := svc.encryptSettingSecret("test-key")
	if err != nil {
		t.Fatal(err)
	}
	channel := model.ModelChannel{
		ID: "channel-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "Seedance",
		BaseURL: "https://ark.cn-beijing.volces.com/api/v3", APIKey: encryptedKey, APIFormat: "openai",
	}
	item := model.ChannelModel{
		ID: "model-1", ChannelID: channel.ID, ModelKey: "seedance-2-5-480p", ProviderModelKey: "doubao-seedance-2-5",
		Capability: "video", Protocol: model.ChannelInterfaceVolcengineArkVideo, Enabled: true,
	}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	_, err = svc.resolveProviderConfig(providerConfig{ChannelID: channel.ID, ChannelModelKey: item.ModelKey, Model: "gpt-4"})
	if err == nil || !strings.Contains(err.Error(), "系统渠道模型标识不一致") {
		t.Fatalf("hostile model error = %v", err)
	}
	_, err = svc.resolveProviderConfig(providerConfig{ChannelID: channel.ID, ChannelModelKey: item.ModelKey, Model: item.ModelKey, ProviderModelKey: "other-upstream"})
	if err == nil || !strings.Contains(err.Error(), "系统渠道模型标识不一致") {
		t.Fatalf("hostile provider key error = %v", err)
	}
}

func TestValidateTaskCapabilityFixesSingleResolutionSKU(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	video := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceVolcengineArkVideo), "doubao-seedance-2-5").Video
	video.References.MaxVideos = 0
	video.Resolutions = []string{"480p"}
	video.DefaultResolution = "480p"
	encoded, err := json.Marshal(&ModelCapabilityConfig{Version: 1, Video: video})
	if err != nil {
		t.Fatal(err)
	}
	channelModel := model.ChannelModel{
		ID: "model-480p", ChannelID: "channel-1", ModelKey: "doubao-seedance-2-5-480p", ProviderModelKey: "doubao-seedance-2-5",
		Capability: "video", Protocol: model.ChannelInterfaceVolcengineArkVideo, Enabled: true, CapabilityConfigJSON: string(encoded),
	}
	if err := db.Create(&channelModel).Error; err != nil {
		t.Fatal(err)
	}
	input := map[string]any{
		"mode": "video",
		"config": map[string]any{
			"channelId": "channel-1", "model": channelModel.ModelKey, "vquality": "auto", "videoSeconds": "6", "size": "16:9",
			"videoGenerateAudio": "true", "videoWatermark": "false",
		},
	}
	if err := svc.ValidateTaskCapability(input); err != nil {
		t.Fatal(err)
	}
	config := input["config"].(map[string]any)
	if got := config["vquality"]; got != "480p" {
		t.Fatalf("vquality = %#v, want 480p", got)
	}
}

func TestPublicChannelCatalogUsesAliasOrderAndHidesInternalName(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channels := []model.ModelChannel{
		{ID: "first", Name: "内部first", SortOrder: 20, Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: "https://dead.invalid/v1", ModelsJSON: `[]`, CreatedAt: time.Unix(1, 0)},
		{ID: "second", Name: "内部second", PublicAlias: "创作精选", SortOrder: 5, Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: "https://dead.invalid/v1", ModelsJSON: `[]`, CreatedAt: time.Unix(2, 0)},
	}
	for index := range channels {
		if err := db.Create(&channels[index]).Error; err != nil {
			t.Fatal(err)
		}
		cm := model.ChannelModel{
			ID: channels[index].ID + "-model", ChannelID: channels[index].ID, ModelKey: channels[index].ID, Enabled: true, Capability: "image",
			CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel("", channels[index].ID)),
		}
		if err := db.Create(&cm).Error; err != nil {
			t.Fatal(err)
		}
	}

	catalog, err := svc.publicSystemChannelCatalog(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 2 || catalog[0].ID != "second" || catalog[0].Name != "创作精选" || catalog[0].DisplayName != "创作精选" {
		t.Fatalf("public catalog = %#v", catalog)
	}
	legacy, err := svc.PublicSystemChannels()
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy) != 2 || legacy[0].ID != "second" || legacy[0].Name != "创作精选" {
		t.Fatalf("public channels = %#v", legacy)
	}
	encoded, _ := json.Marshal([]any{catalog[0], legacy[0]})
	if strings.Contains(string(encoded), "内部second") {
		t.Fatal("internal channel name leaked into public payload")
	}

	if err := db.Model(&model.ModelChannel{}).Where("id = ?", "second").Update("public_alias", "").Error; err != nil {
		t.Fatal(err)
	}
	catalog, err = svc.publicSystemChannelCatalog(nil)
	if err != nil || catalog[0].Name != "内部second" {
		t.Fatalf("empty alias fallback = %#v, err = %v", catalog, err)
	}
}
