package modelcatalog

import "testing"

func TestModelsOnlyDefaultTextSelectionBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name     string
		change   func(*AssistantConfigSnapshot)
		protocol string
		reason   string
	}{
		{name: "openai", protocol: "chat-completion"},
		{name: "claude", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIFormat = "claude" }, protocol: "claude-api"},
		{name: "gemini format", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIFormat = "gemini" }, protocol: "gemini-generate-content"},
		{name: "channel protocol", change: func(s *AssistantConfigSnapshot) { s.Channels[0].InterfaceType = "openai-response" }, protocol: "responses"},
		{name: "gemini interface type", change: func(s *AssistantConfigSnapshot) { s.Channels[0].InterfaceType = "gemini-generate-content" }, protocol: "gemini-generate-content"},
		{name: "explicit google gemini alias profile", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text", Protocol: "google-gemini-generate-content"}}
		}, protocol: "gemini-generate-content"},
		{name: "gemini format profile without explicit protocol", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].APIFormat = "gemini"
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text"}}
		}, protocol: "gemini-generate-content"},
		{name: "unsupported format profile without explicit protocol", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].APIFormat = "vertex"
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text"}}
		}, reason: AssistantReasonProtocolUnsupported},
		{name: "unsupported format", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIFormat = "vertex" }, reason: AssistantReasonProtocolUnsupported},
		{name: "unsupported channel protocol", change: func(s *AssistantConfigSnapshot) { s.Channels[0].InterfaceType = "openai-image" }, reason: AssistantReasonProtocolUnsupported},
		{name: "disabled", change: func(s *AssistantConfigSnapshot) { s.Channels[0].Enabled = false }, reason: AssistantReasonModelNotConfigured},
		{name: "missing key", change: func(s *AssistantConfigSnapshot) { s.Channels[0].APIKey = "" }, reason: AssistantReasonCredentialMissing},
		{name: "unlisted model", change: func(s *AssistantConfigSnapshot) { s.Channels[0].Models = []string{"other"} }, reason: AssistantReasonModelNotConfigured},
		{name: "system channel", change: func(s *AssistantConfigSnapshot) { s.Channels[0].Scope = "system" }, reason: AssistantReasonModelNotConfigured},
		{name: "managed credential", change: func(s *AssistantConfigSnapshot) { s.Channels[0].CredentialRef = "managed" }, reason: AssistantReasonModelNotConfigured},
		{name: "explicit unclassified selection", change: func(s *AssistantConfigSnapshot) { s.AssistantModel = "custom::other" }, reason: AssistantReasonModelNotConfigured},
		{name: "explicit image capability", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "image", Protocol: "openai-image"}}
		}, reason: AssistantReasonModelNotConfigured},
		{name: "explicit unsupported protocol", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text", Protocol: "unsupported"}}
		}, reason: AssistantReasonProtocolUnsupported},
		{name: "explicit supported profile wins", change: func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "local-text", Capability: "text", Protocol: "claude-api"}}
		}, protocol: "claude-api"},
		{name: "other channel default", change: func(s *AssistantConfigSnapshot) {
			s.TextModel = "other::local-text"
			s.Channels = append(s.Channels, AssistantChannel{ID: "other", Enabled: true, Models: []string{"local-text"}})
		}, reason: AssistantReasonModelNotConfigured},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := AssistantConfigSnapshot{TextModel: "custom::local-text", AssistantModel: "custom::local-text", Channels: []AssistantChannel{{ID: "custom", Enabled: true, APIFormat: "openai", APIKey: "synthetic", BaseURL: "http://127.0.0.1:3000/v1", Models: []string{"local-text", "other"}}}}
			if tc.change != nil {
				tc.change(&s)
			}
			provider, reason := ResolveAssistantChannelModel(s, s.AssistantModel, nil)
			if reason != tc.reason || provider.Protocol != tc.protocol {
				t.Fatalf("got reason=%q protocol=%q; want reason=%q protocol=%q", reason, provider.Protocol, tc.reason, tc.protocol)
			}
			if reason != "" && (provider.APIKey != "" || provider.BaseURL != "") {
				t.Fatal("rejected provider leaked connection information")
			}
		})
	}
}

func TestManagedGeminiAssistantUsesCatalogAndPreservesExplicitSelection(t *testing.T) {
	c := AssistantChannel{ID: "beeftv", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"gemini-3.8-flash", "claude-opus-5-5"}, ModelProfiles: []AssistantModelProfile{{Model: "gemini-3.8-flash", Capability: "text", Protocol: "chat-completion"}, {Model: "claude-opus-5-5", Capability: "text"}}}
	s := AssistantConfigSnapshot{TextModel: "beeftv::gemini-3.8-flash", Channels: []AssistantChannel{c}}
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "gemini-3.8-flash" || got.Protocol != "chat-completion" {
		t.Fatalf("Gemini default unavailable: %v %#v", err, got)
	}
	s.AssistantModel = "beeftv::claude-opus-5-5"
	got, err = ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "claude-opus-5-5" {
		t.Fatalf("explicit selection replaced: %v %#v", err, got)
	}
	s.AssistantModel = ""
	s.Channels[0].Models = []string{"claude-opus-5-5"}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("removed Gemini silently used another model")
	}
}

func TestManagedAssistantUsesCatalogTextModelsWithoutWhitelist(t *testing.T) {
	c := AssistantChannel{
		ID: "beeftv", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test",
		Models: []string{"deepseek-v4-pro", "glm-5.3-flash", "seedream-5", "bad-proto", "hy-asr-3.0-preview"},
		ModelProfiles: []AssistantModelProfile{
			{Model: "deepseek-v4-pro", Capability: "text"},
			{Model: "glm-5.3-flash", Capability: "text", Protocol: "chat-completion"},
			{Model: "seedream-5", Capability: "image", Protocol: "openai-image"},
			{Model: "bad-proto", Capability: "text", Protocol: "unsupported"},
			{Model: "hy-asr-3.0-preview", Capability: "", Protocol: ""},
		},
	}
	s := AssistantConfigSnapshot{TextModel: "beeftv::deepseek-v4-pro", Channels: []AssistantChannel{c}}
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "deepseek-v4-pro" {
		t.Fatalf("catalog text fallback unavailable: %v %#v", err, got)
	}
	s.AssistantModel = "beeftv::glm-5.3-flash"
	got, err = ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "glm-5.3-flash" {
		t.Fatalf("catalog text selection unavailable: %v %#v", err, got)
	}
	lookups := 0
	lookup := func(id, ref, url string) (string, string, bool) {
		lookups++
		return "synthetic", url, true
	}
	for _, rejected := range []string{"beeftv::missing", "beeftv::seedream-5", "beeftv::bad-proto", "beeftv::hy-asr-3.0-preview"} {
		s.AssistantModel = rejected
		if _, err := ResolveAssistantProvider(s, lookup); err == nil {
			t.Fatalf("model %q should not be accepted", rejected)
		}
	}
	if lookups != 0 {
		t.Fatalf("rejected models must not trigger credential lookup, got %d", lookups)
	}
	s.Channels[0].ID = "custom"
	s.AssistantModel = "custom::glm-5.3-flash"
	if _, err := ResolveAssistantProvider(s, nil); err != nil {
		t.Fatal("custom channel was restricted", err)
	}
}

func TestManagedAssistantResolvesOnlyDeclaredAvailableAliases(t *testing.T) {
	c := AssistantChannel{ID: "beeftv", Pinned: true, Enabled: true, APIKey: "synthetic", BaseURL: "https://example.test", Models: []string{"opus-live"}, ModelAliases: map[string]string{"claude-opus-5-5": "opus-live"}, ModelProfiles: []AssistantModelProfile{{Model: "opus-live", Capability: "text", Protocol: "claude-api"}}}
	s := AssistantConfigSnapshot{AssistantModel: "beeftv::claude-opus-5-5", Channels: []AssistantChannel{c}}
	got, err := ResolveAssistantProvider(s, nil)
	if err != nil || got.Model != "opus-live" {
		t.Fatalf("alias not resolved: %v %#v", err, got)
	}
	s.Channels[0].Models = []string{"other"}
	if _, err := ResolveAssistantProvider(s, nil); err == nil {
		t.Fatal("unavailable alias accepted")
	}
}
