package modelcatalog

import (
	"testing"
)

// 换默认值不能影响托管渠道目录里的旧默认值或新增文本模型：客户端不维护写死白名单。
func TestManagedAssistantDefaultAndCatalogTextModelsResolve(t *testing.T) {
	if defaultManagedAssistantModel != "deepseek-v4.1-flash" {
		t.Fatalf("assistant default = %q, want deepseek-v4.1-flash", defaultManagedAssistantModel)
	}
	models := []string{defaultManagedAssistantModel, "gpt-6-astra", "deepseek-v4-pro", "glm-5.3-flash"}
	profiles := make([]AssistantModelProfile, 0, len(models))
	for _, model := range models {
		profiles = append(profiles, AssistantModelProfile{Model: model, Capability: "text", Protocol: "chat-completion"})
	}
	channel := AssistantChannel{
		ID: managedChannelID, Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test",
		Models:        models,
		ModelProfiles: profiles,
	}
	for _, model := range models {
		snapshot := AssistantConfigSnapshot{AssistantModel: managedChannelID + "::" + model, Channels: []AssistantChannel{channel}}
		provider, err := ResolveAssistantProvider(snapshot, nil)
		if err != nil || provider.Model != model {
			t.Fatalf("managed model %q unavailable: %v %#v", model, err, provider)
		}
	}
}
