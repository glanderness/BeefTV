package generation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
)

func TestMediaTransportUsesSelectedContractBeforeReadingFiles(t *testing.T) {
	ctx := WithProtocolRegistry(context.Background(), LoadOfficialFallbackRegistry())
	for _, tc := range []struct {
		name, protocol, model, host string
		media                       Media
		blocked                     bool
	}{
		{"URL only local", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{StorageKey: "resource:local"}, true},
		{"URL only inline", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{DataURL: "data:image/png;base64,YQ=="}, true},
		{"URL only blob", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{URL: "blob:local"}, true},
		{"URL only HTTPS", "newapi-channel-2", "seedance_v2.5", "https://custom.example", Media{URL: "https://cdn.example/image.png"}, false},
		{"full video upload", "full-video", "seedance-2.5", "https://custom.example", Media{StorageKey: "resource:local"}, false},
		{"inline protocol", "newapi-channel-1", "video", "https://custom.example", Media{StorageKey: "resource:local"}, false},
		{"BeefAPI upload", "newapi", "seedance-2.0-mini", "https://enterprise.beefapi.com", Media{StorageKey: "resource:local"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := Input{Mode: "video", Config: Config{InterfaceType: tc.protocol, Model: tc.model, BaseURL: tc.host}, ReferenceImages: []Media{tc.media}}
			err := ValidateMediaTransport(ctx, input)
			if (err != nil) != tc.blocked {
				t.Fatalf("error = %v", err)
			}
			if err != nil {
				var appErr *kernel.AppError
				if !errors.As(err, &appErr) || appErr.Reason != "reference_media_requires_url" || !strings.Contains(err.Error(), "参考图片 1") {
					t.Fatalf("unactionable: %v", err)
				}
				classified := ClassifyError(err)
				if classified.Category != CategoryInvalidParams || !strings.Contains(classified.UserMessage(), "参考图片 1") {
					t.Fatalf("lost detail: %#v", classified)
				}
			}
		})
	}
}

func TestMediaTransportNamesOnlyBlockedReferences(t *testing.T) {
	input := Input{Config: Config{InterfaceType: "newapi-channel-2"}, ReferenceImages: []Media{{URL: "https://cdn.example/ok.png"}, {StorageKey: "resource:private-secret"}}, ReferenceVideos: []Media{{StorageKey: "resource:video"}}, ReferenceAudios: []Media{{URL: "data:audio/mp3;base64,YQ=="}}}
	err := ValidateMediaTransport(context.Background(), input)
	if err == nil {
		t.Fatal("accepted local references")
	}
	for _, label := range []string{"参考图片 2", "参考视频 1", "参考音频 1"} {
		if !strings.Contains(err.Error(), label) {
			t.Fatal(err)
		}
	}
	if strings.Contains(err.Error(), "参考图片 1") || strings.Contains(err.Error(), "private-secret") {
		t.Fatal(err)
	}
	input.ReferenceImages = nil
	input.ReferenceVideos = nil
	input.ReferenceAudios = nil
	if err := ValidateMediaTransport(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}

func TestMaskOnlyDisablesURLTransportForImageEditing(t *testing.T) {
	input := Input{Mode: "video", Config: Config{InterfaceType: "newapi-channel-2"}, Mask: &Media{StorageKey: "resource:mask"}}
	if err := ValidateMediaTransport(context.Background(), input); err == nil || !strings.Contains(err.Error(), "遮罩") {
		t.Fatalf("video mask bypassed admission: %v", err)
	}
	input.Mode = "image"
	if MediaHydrationPolicyFor(context.Background(), input).RequireURL {
		t.Fatal("image mask must retain byte transport for multipart editing")
	}
}
