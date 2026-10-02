package modelcatalog

import "testing"

func TestManagedAssistantSelectionDoesNotBypassCuratedModels(t *testing.T) {
	c := AssistantChannel{ID: "beefapi", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"qwen", "claude-opus-5-5"}, ModelProfiles: []AssistantModelProfile{{Model: "qwen", Capability: "text"}, {Model: "claude-opus-5-5", Capability: "text"}}}
	s := AssistantConfigSnapshot{TextModel: "beefapi::qwen", Channels: []AssistantChannel{c}}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("text fallback bypassed curated models")
	}
	s.TextModel = "beefapi::claude-opus-5-5"
	s.AssistantModel = "beefapi::missing"
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("explicit unavailable model silently fell back")
	}
	s.AssistantModel = "beefapi::claude-opus-5-5"
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "claude-opus-5-5" {
		t.Fatalf("selection not effective: %v %#v", err, got)
	}
	s.Channels[0].Models = append(s.Channels[0].Models, "gpt-6.1-sol")
	s.Channels[0].ModelProfiles = append(s.Channels[0].ModelProfiles, AssistantModelProfile{Model: "gpt-6.1-sol", Capability: "text"})
	s.AssistantModel = "beefapi::gpt-6.1-sol"
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("deferred model became available merely through catalog membership")
	}
	s.Channels[0].ID = "custom"
	s.AssistantModel = "custom::qwen"
	if _, err := ResolveAssistantProvider(s, nil); err != nil {
		t.Fatal("custom channel was restricted", err)
	}
}

func TestManagedAssistantResolvesOnlyDeclaredAvailableAliases(t *testing.T) {
	c := AssistantChannel{ID: "beefapi", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"opus-live"}, ModelAliases: map[string]string{"claude-opus-5-5": "opus-live"}, ModelProfiles: []AssistantModelProfile{{Model: "opus-live", Capability: "text", Protocol: "claude-api"}}}
	s := AssistantConfigSnapshot{AssistantModel: "beefapi::claude-opus-5-5", Channels: []AssistantChannel{c}}
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "opus-live" {
		t.Fatalf("alias not resolved: %v %#v", err, got)
	}
	s.Channels[0].Models = []string{"other"}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("unavailable alias accepted")
	}
}
