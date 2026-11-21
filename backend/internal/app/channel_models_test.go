package app

import (
	"encoding/json"
	"testing"

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
