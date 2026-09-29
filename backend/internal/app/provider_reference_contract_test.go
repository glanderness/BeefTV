package app

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestWanLocalReferencesUseVerifiedInlineContract(t *testing.T) {
	input := canvasGenerationInput{Mode: "video", Config: providerConfig{BaseURL: "https://enterprise.beefapi.com", InterfaceType: "newapi-channel-2", Model: "wan3.0-video"}, ReferenceImages: []providerMedia{{DataURL: testGeminiReferenceImageDataURL}}}
	policy := providerMediaHydrationPolicyFor(context.Background(), input)
	if policy.requireURL || !policy.preferHTTPS {
		t.Fatalf("Wan local media blocked: %#v", policy)
	}
	svc := newResourceTestService(t)
	svc.mode = serviceModeLocal
	svc.localResourceStorage = true
	png, err := base64.StdEncoding.DecodeString(strings.SplitN(testGeminiReferenceImageDataURL, ",", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	key := "users/user-1/image/wan-reference.png"
	path := filepath.Join(svc.dataDir, "resources", key)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, png, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateResource(&model.Resource{ID: "wan-reference", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: key, MimeType: "image/png", Size: int64(len(png))}); err != nil {
		t.Fatal(err)
	}
	input.ReferenceImages = []providerMedia{{StorageKey: "resource:wan-reference"}}
	if err := svc.hydrateGenerationMedia("user-1", &input, policy); err != nil {
		t.Fatal(err)
	}
	body := officialVideoCreateBody(t, input)
	if body["image_urls"].([]any)[0] != testGeminiReferenceImageDataURL {
		t.Fatal("inline image lost before wire request")
	}
	foreign := canvasGenerationInput{ReferenceImages: []providerMedia{{StorageKey: "resource:wan-reference"}}}
	if err := svc.hydrateGenerationMedia("another-user", &foreign, policy); err == nil {
		t.Fatal("foreign media accepted")
	}
	input.ReferenceVideos = []providerMedia{{URL: "https://example.com/ref.mp4"}}
	if err := svc.validateResolvedVideoCapability(&input); err == nil || !strings.Contains(err.Error(), "暂不支持参考视频") {
		t.Fatalf("unsupported media silently accepted: %v", err)
	}
	input.Config.Model = "wan4.0-video"
	if !providerMediaHydrationPolicyFor(context.Background(), input).requireURL {
		t.Fatal("unknown model inherited inline support")
	}
	input.Config.Model = "wan3.0-video"
	input.Config.BaseURL = "https://another.example/enterprise.beefapi.com"
	if !providerMediaHydrationPolicyFor(context.Background(), input).requireURL {
		t.Fatal("untrusted endpoint inherited inline support")
	}
}

func TestInstalledMediaContractOverridesLegacyGuess(t *testing.T) {
	ctx := withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry())
	for _, protocol := range []string{"grok-image", "chat-completion", "openai-response", "claude-api"} {
		policy := providerMediaHydrationPolicyFor(ctx, canvasGenerationInput{Config: providerConfig{InterfaceType: protocol}})
		if policy.requireURL || !policy.preferURL {
			t.Fatalf("%s lost optional object-storage URL transport: %#v", protocol, policy)
		}
	}
	inline := providerMediaHydrationPolicyFor(ctx, canvasGenerationInput{Config: providerConfig{InterfaceType: "newapi", Model: "future-model"}})
	if inline.requireURL {
		t.Fatal("installed multipart contract ignored")
	}
	remote := providerMediaHydrationPolicyFor(ctx, canvasGenerationInput{Config: providerConfig{InterfaceType: "newapi-channel-2", Model: "future-model"}})
	if !remote.requireURL {
		t.Fatal("URL-only contract ignored")
	}
}
