package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/workspace"
)

func TestMediaReviewProviderSendsRealVideoOnceAndRespectsDeclaredFields(t *testing.T) {
	for _, mode := range []string{"ok", "empty", "truncated", "http-error"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			media := base64.StdEncoding.EncodeToString([]byte("bounded-real-media-fixture"))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-key" || body["model"] != "multimodal-vl-fixture" || body["stream"] != false || body["tools"] != nil {
					t.Fatal("wrong isolated review contract")
				}
				if _, exists := body["thinking_enabled"]; exists {
					t.Fatal("proprietary thinking_enabled must not be sent unless declared")
				}
				if _, exists := body["reasoning_effort"]; exists {
					t.Fatal("proprietary reasoning_effort must not be sent unless declared")
				}
				messages := body["messages"].([]any)
				parts := messages[1].(map[string]any)["content"].([]any)
				if parts[0].(map[string]any)["video_url"].(map[string]any)["url"] != "data:video/mp4;base64,"+media {
					t.Fatal("video bytes lost")
				}
				if mode == "http-error" {
					w.WriteHeader(502)
					w.Write([]byte("sensitive upstream failure"))
					return
				}
				text, finish := "observed two objects", "stop"
				if mode == "empty" {
					text = ""
				}
				if mode == "truncated" {
					finish = "length"
				}
				json.NewEncoder(w).Encode(map[string]any{"id": "req-1", "model": "multimodal-vl-fixture", "usage": map[string]int{"prompt_tokens": 123, "completion_tokens": 24}, "choices": []any{map[string]any{"message": map[string]string{"content": text}, "finish_reason": finish}}})
			}))
			defer server.Close()
			provider := AssistantProvider{
				BaseURL: server.URL + "/v1", APIKey: "fixture-key", Model: "multimodal-vl-fixture",
				InputModalities: []string{"video", "audio", "image"},
			}
			result, err := reviewMediaWithProvider(context.Background(), provider, operations.MediaPart{MimeType: "video/mp4", Data: media}, "观察物体数量")
			if calls != 1 {
				t.Fatalf("inference retried %d times", calls)
			}
			if mode == "ok" {
				if err != nil || result.RequestID != "req-1" || result.Text != "observed two objects" || len(result.Usage) == 0 {
					t.Fatalf("missing observation %+v %v", result, err)
				}
			} else if err == nil || strings.Contains(err.Error(), "sensitive") {
				t.Fatalf("invalid completion accepted/leaked: %v", err)
			}
		})
	}
}

func TestMediaReviewSupportsImageAndRejectsIncapableModelWithUnavailable(t *testing.T) {
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 16, 16))); err != nil {
		t.Fatal(err)
	}
	imgB64 := base64.StdEncoding.EncodeToString(encoded.Bytes())
	var receivedType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if _, hasThinking := body["thinking_enabled"]; hasThinking {
			t.Error("must not emit thinking_enabled without provider declaration")
		}
		parts := body["messages"].([]any)[1].(map[string]any)["content"].([]any)
		part := parts[0].(map[string]any)
		receivedType, _ = part["type"].(string)
		if part["image_url"].(map[string]any)["url"] != "data:image/png;base64,"+imgB64 {
			t.Error("image data URL mismatch")
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "img-1", "choices": []any{map[string]any{"message": map[string]string{"content": "clean image"}, "finish_reason": "stop"}}})
	}))
	defer server.Close()

	service := NewLocal(nil, t.TempDir())
	store, err := workspace.NewProviderConfig(service.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{
		"mediaReviewModel": "vision::generic-vision-model",
		"channels": []any{map[string]any{
			"id": "vision", "enabled": true, "baseUrl": server.URL + "/v1", "apiKey": "vision-key",
			"models": []string{"generic-vision-model"},
			"modelProfiles": []any{map[string]any{
				"model": "generic-vision-model", "capability": "text", "protocol": "chat-completion",
				"inputModalities": []string{"image"},
			}},
		}},
	})
	if err := store.SaveLocalModelConfig(config); err != nil {
		t.Fatal(err)
	}
	session := &operationSession{service: service}
	obs, err := session.ReviewMedia(context.Background(), operations.MediaPart{MimeType: "image/png", Data: imgB64}, "检查构图")
	if err != nil || obs.Text != "clean image" || receivedType != "image_url" {
		t.Fatalf("image review failed: obs=%+v type=%q err=%v", obs, receivedType, err)
	}
	// Image-only model must fail with media_review_unavailable on video input.
	_, err = session.ReviewMedia(context.Background(), operations.MediaPart{MimeType: "video/mp4", Data: base64.StdEncoding.EncodeToString([]byte("vid"))}, "观察视频")
	if opErr := operations.AsError(err); opErr == nil || opErr.Reason != "media_review_unavailable" {
		t.Fatalf("expected media_review_unavailable for unsupported video modality, got %v", err)
	}
}

func TestMediaReviewReadsSavedSelectionAndNeverFallsBackToMainModel(t *testing.T) {
	calls := []string{}
	model := "any-capable-vl"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Header.Get("Authorization"))
		var request struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Model != model {
			t.Fatal("wrong selected model")
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "selection", "choices": []any{map[string]any{"message": map[string]string{"content": "observed fixture"}, "finish_reason": "stop"}}})
	}))
	defer server.Close()
	service := NewLocal(nil, t.TempDir())
	store, err := workspace.NewProviderConfig(service.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	channels := []any{}
	for _, id := range []string{"first", "second"} {
		channels = append(channels, map[string]any{"id": id, "enabled": true, "baseUrl": server.URL + "/v1", "apiKey": id,
			"models": []string{model}, "modelProfiles": []any{map[string]any{"model": model, "capability": "text", "protocol": "chat-completion", "inputModalities": []string{"video", "audio"}}}})
	}
	session := &operationSession{service: service}
	for _, selection := range []string{"first::" + model, "second::" + model, "", "missing::" + model} {
		body, _ := json.Marshal(map[string]any{"assistantModel": "first::" + model, "mediaReviewModel": selection, "channels": channels})
		if err := store.SaveLocalModelConfig(body); err != nil {
			t.Fatal(err)
		}
		_, err := session.ReviewMedia(context.Background(), operations.MediaPart{MimeType: "video/mp4", Data: base64.StdEncoding.EncodeToString([]byte("fixture"))}, "观察视频")
		if (selection == "" || strings.HasPrefix(selection, "missing::")) != (err != nil) {
			t.Fatalf("selection result %q: %v", selection, err)
		}
	}
	if strings.Join(calls, ",") != "Bearer first,Bearer second" {
		t.Fatalf("wrong call routing: %v", calls)
	}
}
