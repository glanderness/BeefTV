package generation

import (
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestChannelAPIURLNormalizesConfiguredVersionPrefix(t *testing.T) {
	tests := []struct {
		base, path, want string
	}{
		{"https://api.example.com", "/chat/completions", "https://api.example.com/v1/chat/completions"},
		{"https://api.example.com/v1", "/chat/completions", "https://api.example.com/v1/chat/completions"},
		{"https://api.example.com/v1/", "/v2/videos", "https://api.example.com/v2/videos"},
		{"https://api.example.com/api/v3", "/videos", "https://api.example.com/api/v3/videos"},
	}
	for _, test := range tests {
		if got := ChannelAPIURL(test.base, test.path); got != test.want {
			t.Fatalf("ChannelAPIURL(%q, %q) = %q, want %q", test.base, test.path, got, test.want)
		}
	}
}

func TestChannelAPIURLForProtocolUsesGeminiDefault(t *testing.T) {
	got := ChannelAPIURLForProtocol("https://generativelanguage.googleapis.com", "/models/gemini:generateContent", model.ChannelInterfaceGeminiImage)
	want := "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestChannelAPIURLForProtocolUsesAgnesOriginPollPath(t *testing.T) {
	got := ChannelAPIURLForProtocol("https://apihub.agnes-ai.com/v1", "/agnesapi?video_id=video-1&model_name=agnes-video-2.5", model.ChannelInterfaceAgnesVideo)
	want := "https://apihub.agnes-ai.com/agnesapi?video_id=video-1&model_name=agnes-video-2.5"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestProviderDownloadURLNormalizesBeefAPIResultToConfiguredOrigin(t *testing.T) {
	tests := []struct {
		name, baseURL, resultURL, want string
	}{
		{name: "same origin", baseURL: "https://provider.example", resultURL: "https://provider.example/files/video.mp4", want: "https://provider.example/files/video.mp4"},
		{name: "beef enterprise uses configured origin", baseURL: "https://enterprise.beefapi.com", resultURL: "https://beefapi.com/v1/videos/task-1/content", want: "https://enterprise.beefapi.com/v1/videos/task-1/content"},
		{name: "beef subdomain uses configured origin", baseURL: "https://api.beefapi.com", resultURL: "https://cdn.beefapi.com/video.mp4?token=result", want: "https://api.beefapi.com/video.mp4?token=result"},
		{name: "lookalike host stays external", baseURL: "https://enterprise.beefapi.com", resultURL: "https://beefapi.com.attacker.example/video.mp4", want: "https://beefapi.com.attacker.example/video.mp4"},
		{name: "custom provider does not rewrite beef", baseURL: "https://provider.example", resultURL: "https://beefapi.com/video.mp4", want: "https://beefapi.com/video.mp4"},
		{name: "insecure cross origin stays external", baseURL: "https://enterprise.beefapi.com", resultURL: "http://beefapi.com/video.mp4", want: "http://beefapi.com/video.mp4"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ProviderDownloadURL(test.baseURL, test.resultURL); got != test.want {
				t.Fatalf("ProviderDownloadURL(%q, %q) = %q, want %q", test.baseURL, test.resultURL, got, test.want)
			}
		})
	}
}

func TestApplyAuth(t *testing.T) {
	newReq := func() *http.Request {
		req, err := http.NewRequest(http.MethodPost, "https://example.com/v1/x", nil)
		if err != nil {
			t.Fatal(err)
		}
		return req
	}
	req := newReq()
	ApplyAuth(req, Config{APIFormat: "claude", APIKey: "secret"})
	if req.Header.Get("x-api-key") != "secret" || req.Header.Get("anthropic-version") == "" {
		t.Fatalf("claude auth = %v", req.Header)
	}
	req = newReq()
	ApplyAuth(req, Config{APIFormat: "gemini", APIKey: "gkey"})
	if req.Header.Get("x-goog-api-key") != "gkey" {
		t.Fatalf("gemini auth = %v", req.Header)
	}
	req = newReq()
	ApplyAuth(req, Config{APIKey: "tok"})
	if req.Header.Get("Authorization") != "Bearer tok" {
		t.Fatalf("bearer auth = %v", req.Header)
	}
}
