package modelcatalog

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestMediaReviewSelectionUsesCapabilityMetadataNotModelName(t *testing.T) {
	channel := AssistantChannel{
		ID: "beeftv", Pinned: true, Enabled: true, CredentialRef: "beeftv",
		BaseURL: "https://example.test", Models: []string{"custom-vl-pro", "text-only-chat"},
		ModelProfiles: []AssistantModelProfile{
			{
				Model:                  "custom-vl-pro",
				Capability:             "text",
				Protocol:               "chat-completion",
				InputModalities:        []string{"video", "audio", "image"},
				SupportedRequestFields: []string{"thinking_enabled", "reasoning_effort"},
			},
			{
				Model:      "text-only-chat",
				Capability: "text",
				Protocol:   "chat-completion",
			},
		},
	}
	snapshot := AssistantConfigSnapshot{MediaReviewModel: "beeftv::custom-vl-pro", Channels: []AssistantChannel{channel}}
	lookups := 0
	lookup := func(id, ref, url string) (string, string, bool) {
		lookups++
		if id != channel.ID || ref != channel.CredentialRef {
			t.Fatal("wrong selected credential")
		}
		return "synthetic-key", "https://selected.example.test/v1", true
	}
	provider, reason := ResolveMediaReviewProviderForModality(snapshot, "", lookup)
	if reason != "" || provider.Model != "custom-vl-pro" || provider.APIKey != "synthetic-key" || provider.BaseURL != "https://selected.example.test/v1" || lookups != 1 {
		t.Fatalf("capable media model did not resolve: reason=%q provider=%+v lookups=%d", reason, provider, lookups)
	}
	if !ProviderSupportsMediaModality(provider, "video") || !ProviderSupportsMediaModality(provider, "audio") || !ProviderSupportsMediaModality(provider, "image") {
		t.Fatalf("missing resolved modalities: %+v", provider.InputModalities)
	}
	if !ProviderSupportsRequestField(provider, "thinking_enabled") || !ProviderSupportsRequestField(provider, "reasoning_effort") {
		t.Fatalf("missing resolved request fields: %+v", provider.SupportedRequestFields)
	}
	if _, err := ResolveAssistantProvider(snapshot, lookup); err == nil {
		t.Fatal("media review selection must not supply the main assistant model")
	}
	for _, change := range []func(*AssistantConfigSnapshot){
		func(s *AssistantConfigSnapshot) { s.MediaReviewModel = "" },
		func(s *AssistantConfigSnapshot) { s.MediaReviewModel = "missing::custom-vl-pro" },
		func(s *AssistantConfigSnapshot) { s.Channels[0].Enabled = false },
		func(s *AssistantConfigSnapshot) { s.Channels[0].Models = []string{"other"} },
		func(s *AssistantConfigSnapshot) {
			s.Channels[0].ModelProfiles = []AssistantModelProfile{{Model: "custom-vl-pro", Capability: "text", Protocol: "responses", InputModalities: []string{"video"}}}
		},
		func(s *AssistantConfigSnapshot) { s.MediaReviewModel = "beeftv::text-only-chat" },
	} {
		s := snapshot
		s.Channels = []AssistantChannel{channel}
		change(&s)
		if got, reason := ResolveMediaReviewProviderForModality(s, "", lookup); reason == "" || got.APIKey != "" {
			t.Fatalf("invalid choice accepted or credential exposed: reason=%q got=%+v", reason, got)
		}
	}
	if lookups != 1 {
		t.Fatalf("invalid choices must not look up credentials: lookups=%d", lookups)
	}

	// Alias resolution with server mediaCapabilities JSON metadata (image-only model).
	snapshot.MediaReviewModel = "beeftv::vision-alias"
	snapshot.Channels[0].ModelAliases = map[string]string{"vision-alias": "catalog-vision-2"}
	snapshot.Channels[0].Models = []string{"catalog-vision-2"}
	snapshot.Channels[0].ModelProfiles = []AssistantModelProfile{{
		Model:             "catalog-vision-2",
		Capability:        "text",
		Protocol:          "chat-completion",
		MediaCapabilities: json.RawMessage(`{"inputModalities":["image"]}`),
	}}
	provider, reason = ResolveMediaReviewProviderForModality(snapshot, "image", lookup)
	if reason != "" || provider.Model != "catalog-vision-2" || !slices.Equal(provider.InputModalities, []string{"image"}) {
		t.Fatalf("image-capable alias did not resolve: reason=%q provider=%+v", reason, provider)
	}
	if _, reason := ResolveMediaReviewProviderForModality(snapshot, "video", lookup); reason == "" {
		t.Fatal("image-only model must not satisfy video modality")
	}

	// Text CapabilityConfig.References also unlocks modalities without proprietary fields.
	snapshot.MediaReviewModel = "beeftv::cap-ref-vl"
	snapshot.Channels[0].Models = []string{"cap-ref-vl"}
	snapshot.Channels[0].ModelProfiles = []AssistantModelProfile{{
		Model:      "cap-ref-vl",
		Capability: "text",
		Protocol:   "chat-completion",
		CapabilityConfig: &ModelCapabilityConfig{
			Version: 1,
			Text: &TextCapabilityConfig{
				References: TextReferenceConfig{MaxImages: 4, MaxVideos: 1, MaxAudios: 1},
			},
		},
	}}
	provider, reason = ResolveMediaReviewProviderForModality(snapshot, "audio", lookup)
	if reason != "" || provider.Model != "cap-ref-vl" {
		t.Fatalf("capabilityConfig text references did not unlock audio review: %q", reason)
	}
	body, ok := BuildMediaReviewRequest(provider, "image/png", "AAAA", "检查构图")
	if !ok {
		t.Fatal("expected image/png review payload")
	}
	if _, hasThinking := body["thinking_enabled"]; hasThinking {
		t.Fatal("must never send thinking_enabled when provider did not declare support")
	}
	if _, hasReasoning := body["reasoning_effort"]; hasReasoning {
		t.Fatal("must never send reasoning_effort when provider did not declare support")
	}
}
