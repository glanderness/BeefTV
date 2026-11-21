package handler

import (
	"net/http"
	"net/url"
	"testing"
)

func TestAuthorizeCustomRelayAllowsModelsAndAgentEndpoints(t *testing.T) {
	tests := []struct {
		method      string
		target      string
		apiFormat   string
		contentType string
	}{
		{method: http.MethodGet, target: "https://api.example.com/v1/models", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://api.example.com/v1/responses", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodPost, target: "https://api.example.com/v1/chat/completions", apiFormat: "openai", contentType: "application/json; charset=utf-8"},
		{method: http.MethodPost, target: "https://api.anthropic.com/v1/messages", apiFormat: "claude", contentType: "application/json"},
		{method: http.MethodPost, target: "https://api.example.com/v1/audio/speech", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodPost, target: "https://api.example.com/v1/images/edits", apiFormat: "openai", contentType: "multipart/form-data; boundary=test"},
		{method: http.MethodPost, target: "https://api.example.com/v1/images/edits", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodPost, target: "https://api.example.com/v1/videos", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodPost, target: "https://api.example.com/v1/videos", apiFormat: "openai", contentType: "multipart/form-data; boundary=test"},
		{method: http.MethodGet, target: "https://api.example.com/v1/videos/task-1/content", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://api.example.com/v1/video/generations", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodGet, target: "https://api.example.com/v1/video/generations/task-1", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://api.x.ai/v1/videos/generations", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodGet, target: "https://api.x.ai/v1/videos/request-1", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://api.novita.ai/v3/video/create", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodGet, target: "https://api.novita.ai/v3/async/task-result?task_id=task-1", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://ark.cn-beijing.volces.com/api/v3/images/generations", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodPost, target: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodGet, target: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse", apiFormat: "gemini", contentType: "application/json"},
		{method: http.MethodPost, target: "https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-preview:predictLongRunning", apiFormat: "gemini", contentType: "application/json"},
		{method: http.MethodGet, target: "https://generativelanguage.googleapis.com/v1beta/operations/operation-1", apiFormat: "gemini"},
	}
	for _, test := range tests {
		target, err := url.Parse(test.target)
		if err != nil {
			t.Fatal(err)
		}
		if err := authorizeCustomRelay(test.method, target, test.apiFormat, test.contentType); err != nil {
			t.Fatalf("authorizeCustomRelay(%s %s) error = %v", test.method, test.target, err)
		}
	}
}

func TestAuthorizeCustomRelayAllowsOnlyOfficialAgnesPollQuery(t *testing.T) {
	target, err := url.Parse("https://apihub.agnes-ai.com/agnesapi?video_id=video-1&model_name=agnes-video-2.5")
	if err != nil {
		t.Fatal(err)
	}
	if err := authorizeCustomRelay(http.MethodGet, target, "openai", ""); err != nil {
		t.Fatalf("authorizeCustomRelay() Agnes poll error = %v", err)
	}
	for _, raw := range []string{
		"https://apihub.agnes-ai.com/agnesapi?video_id=video-1",
		"https://apihub.agnes-ai.com/agnesapi?video_id=video-1&model_name=agnes-video-2.5&extra=1",
	} {
		invalid, parseErr := url.Parse(raw)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		if err := authorizeCustomRelay(http.MethodGet, invalid, "openai", ""); err == nil {
			t.Fatalf("authorizeCustomRelay(%q) should fail", raw)
		}
	}
}

func TestAuthorizeCustomRelayRejectsArbitraryRequestsAndCredentialQueries(t *testing.T) {
	tests := []struct {
		method      string
		target      string
		apiFormat   string
		contentType string
	}{
		{method: http.MethodDelete, target: "https://api.example.com/v1/models", apiFormat: "openai"},
		{method: http.MethodGet, target: "https://api.example.com/account", apiFormat: "openai"},
		{method: http.MethodGet, target: "https://api.example.com/v1/models?api_key=secret", apiFormat: "openai"},
		{method: http.MethodPost, target: "https://api.example.com/v1/responses", apiFormat: "openai", contentType: "text/plain"},
		{method: http.MethodPost, target: "https://api.anthropic.com/v1/messages", apiFormat: "claude", contentType: "text/plain"},
		{method: http.MethodGet, target: "https://api.anthropic.com/v1/messages", apiFormat: "claude"},
		{method: http.MethodPost, target: "https://api.example.com/v1/account", apiFormat: "openai", contentType: "multipart/form-data; boundary=test"},
		{method: http.MethodPost, target: "https://api.example.com/v1/../account/chat/completions", apiFormat: "openai", contentType: "application/json"},
		{method: http.MethodPost, target: "https://api.example.com/v1/models/gemini:streamGenerateContent?alt=sse&token=secret", apiFormat: "gemini", contentType: "application/json"},
		{method: http.MethodGet, target: "https://api.novita.ai/v3/async/task-result?task_id=task-1&api_key=secret", apiFormat: "openai"},
		{method: http.MethodGet, target: "https://api.novita.ai/v3/async/task-result", apiFormat: "openai"},
	}
	for _, test := range tests {
		target, err := url.Parse(test.target)
		if err != nil {
			t.Fatal(err)
		}
		if err := authorizeCustomRelay(test.method, target, test.apiFormat, test.contentType); err == nil {
			t.Fatalf("authorizeCustomRelay(%s %s) should fail", test.method, test.target)
		}
	}
}
