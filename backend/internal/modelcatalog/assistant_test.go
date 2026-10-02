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
	if unknown.FromNode || unknown.KindMismatch || unknown.ModelKey != "beefapi::gpt-image-2" {
		t.Fatalf("unknown selection should fall back to default: %#v", unknown)
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
