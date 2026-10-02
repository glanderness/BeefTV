package modelcatalog

import "testing"

func TestResolveAssistantGenerationModelPrefersNodeOverride(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		VideoModel: "beefapi::wan3.0-video",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "gpt-image-2.5-flare", Capability: "image"},
				{Model: "wan3.0-video", Capability: "video"},
			},
		}},
	}

	choice := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::gpt-image-2.5-flare")
	if choice.KindMismatch || !choice.FromNode || choice.ModelKey != "beefapi::gpt-image-2.5-flare" || choice.Display != "gpt-image-2.5-flare" {
		t.Fatalf("node override: %#v", choice)
	}

	fallback := ResolveAssistantGenerationModel(snapshot, "image", "")
	if fallback.FromNode || fallback.KindMismatch || fallback.ModelKey != "beefapi::gpt-image-2" || fallback.Display != "gpt-image-2" {
		t.Fatalf("global default: %#v", fallback)
	}

	unknown := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::missing-image")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unknown explicit selection must not use a paid default: %#v", unknown)
	}
}

func TestResolveAssistantGenerationModelRejectsKindMismatch(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		VideoModel: "beefapi::wan3.0-video",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "wan3.0-video", Capability: "video"},
			},
		}},
	}

	fromCatalog := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::wan3.0-video")
	if !fromCatalog.KindMismatch || fromCatalog.ModelKey != "" {
		t.Fatalf("catalog video model on image propose: %#v", fromCatalog)
	}

	fromDefault := ResolveAssistantGenerationModel(snapshot, "image", snapshot.VideoModel)
	if !fromDefault.KindMismatch {
		t.Fatalf("other-kind default should conflict: %#v", fromDefault)
	}

	okVideo := ResolveAssistantGenerationModel(snapshot, "video", "beefapi::wan3.0-video")
	if okVideo.KindMismatch || okVideo.ModelKey != "beefapi::wan3.0-video" {
		t.Fatalf("matching video selection: %#v", okVideo)
	}
}

func TestResolveAssistantGenerationModelNormalizesUnqualifiedKey(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			Models:       []string{"gpt-image-2", "gpt-image-2.5-flare"},
			ModelAliases: map[string]string{"legacy-flare": "gpt-image-2.5-flare"},
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "gpt-image-2.5-flare", Capability: "image"},
			},
		}},
	}

	unqualified := ResolveAssistantGenerationModel(snapshot, "image", "gpt-image-2.5-flare")
	if unqualified.KindMismatch || !unqualified.FromNode || unqualified.ModelKey != "beefapi::gpt-image-2.5-flare" || unqualified.Display != "gpt-image-2.5-flare" {
		t.Fatalf("unqualified stored model should canonicalize: %#v", unqualified)
	}

	aliased := ResolveAssistantGenerationModel(snapshot, "image", "legacy-flare")
	if aliased.KindMismatch || !aliased.FromNode || aliased.ModelKey != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("alias should canonicalize like frontend: %#v", aliased)
	}

	unknown := ResolveAssistantGenerationModel(snapshot, "image", "not-in-channel-models")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unknown unqualified model must be rejected: %#v", unknown)
	}
}

func TestResolveAssistantGenerationModelInfersCapabilityFromProtocol(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		ImageModel: "beefapi::gpt-image-2",
		Channels: []AssistantChannel{{
			ID: "beefapi", Enabled: true,
			Models: []string{"gpt-image-2", "gpt-image-2.5-flare", "mystery"},
			ModelProfiles: []AssistantModelProfile{
				{Model: "gpt-image-2", Capability: "image"},
				{Model: "gpt-image-2.5-flare", Protocol: "openai-image"},
				{Model: "mystery"},
			},
		}},
	}

	inferred := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::gpt-image-2.5-flare")
	if inferred.KindMismatch || !inferred.FromNode || inferred.ModelKey != "beefapi::gpt-image-2.5-flare" {
		t.Fatalf("empty capability with openai-image protocol should match image: %#v", inferred)
	}

	unknown := ResolveAssistantGenerationModel(snapshot, "image", "beefapi::mystery")
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "" {
		t.Fatalf("unresolved capability must not select another model: %#v", unknown)
	}
}
