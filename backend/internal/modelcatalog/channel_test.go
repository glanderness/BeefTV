package modelcatalog

import (
	"strings"
	"testing"
)

func TestFixedVideoResolutionAppliedToSingleSKU(t *testing.T) {
	profile := &VideoCapabilityConfig{Resolutions: []string{"720p"}}
	input := TaskInput{Mode: "video", Config: TaskConfig{VQuality: "auto"}}
	ApplyFixedVideoResolution(&input, profile)
	if input.Config.VQuality != "720p" {
		t.Fatalf("single SKU should pin vquality, got %q", input.Config.VQuality)
	}
}

func TestCredentialAbsenceDoesNotLeakSecret(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		AssistantModel: "custom::chat-x",
		Channels: []AssistantChannel{{
			ID: "custom", Name: "自建", Enabled: true, BaseURL: "https://relay.example.com",
			ModelProfiles: []AssistantModelProfile{{Capability: "text", Model: "chat-x", Protocol: "chat-completion"}},
		}},
	}
	_, err := ResolveAssistantProvider(snapshot, nil)
	if err == nil {
		t.Fatal("missing credential should fail")
	}
	if !strings.Contains(err.Error(), "该渠道还没有可用的密钥") {
		t.Fatalf("user-facing error = %v", err)
	}
	if strings.Contains(err.Error(), "sk-") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error leaked credential material: %v", err)
	}
}

func TestAssistantUnavailableWhenChannelDisabled(t *testing.T) {
	snapshot := AssistantConfigSnapshot{
		AssistantModel: "custom::chat-x",
		TextModel:      "custom::chat-x",
		Channels: []AssistantChannel{{
			ID: "custom", Enabled: false, APIKey: "secret-key", BaseURL: "https://relay.example.com",
			ModelProfiles: []AssistantModelProfile{{Capability: "text", Model: "chat-x", Protocol: "chat-completion"}},
		}},
	}
	_, err := ResolveAssistantProvider(snapshot, nil)
	if err == nil {
		t.Fatal("disabled channel should be unconfigured")
	}
	if strings.Contains(err.Error(), "secret-key") {
		t.Fatalf("disabled-channel error leaked key: %v", err)
	}
}
