package protocol

import (
	"context"
	"encoding/json"
	"testing"
)

func TestVLLMOmniVideosMultipartContract(t *testing.T) {
	adapter := officialPackageAdapter(t, "vllm-omni-videos.beeftv-plugin", "vllm-omni-videos")

	t.Run("text to video matches issue 386 multipart payload", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability:  CapabilityVideo,
			Model:       "minimax-h3-fl2va",
			Prompt:      "A cinematic shot of waves crashing at sunset",
			Duration:    5,
			AspectRatio: "16:9",
			Resolution:  "480p",
			ProviderOptions: map[string]map[string]any{
				"vllm-omni-videos": {
					"fps":                 24,
					"num_inference_steps": 10,
					"flow_shift":          12,
					"seed":                1101,
					"audio_flow_shift":    3.0,
				},
			},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		if create.Method != "POST" || create.Path != "/v1/videos" || create.ContentType != "multipart/form-data" {
			t.Fatalf("create spec = %#v", create)
		}
		body := manifestTestBody(t, create)
		if body["model"] != "minimax-h3-fl2va" || body["width"] != float64(1024) || body["height"] != float64(576) || body["aspect_ratio"] != "16:9" {
			t.Fatalf("basic fields = %#v", body)
		}
		if body["fps"] != float64(24) || body["num_inference_steps"] != float64(10) || body["flow_shift"] != float64(12) || body["seed"] != float64(1101) {
			t.Fatalf("sampler fields = %#v", body)
		}
		for _, forbidden := range []string{"size", "resolution_name", "generate_audio"} {
			if _, exists := body[forbidden]; exists {
				t.Fatalf("must not send incompatible field %q: %#v", forbidden, body)
			}
		}
		rawExtra, ok := body["extra_params"].(string)
		if !ok {
			t.Fatalf("extra_params = %#v, want JSON string", body["extra_params"])
		}
		var extra map[string]any
		if err := json.Unmarshal([]byte(rawExtra), &extra); err != nil {
			t.Fatalf("decode extra_params %q: %v", rawExtra, err)
		}
		if extra["task"] != "t2va" || extra["duration"] != float64(5) || extra["audio_flow_shift"] != float64(3) {
			t.Fatalf("extra_params = %#v", extra)
		}
	})

	t.Run("first and last frame uses repeated input_references and fl2va task", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability:  CapabilityVideo,
			Model:       "minimax-h3-fl2va",
			Prompt:      "Smooth camera transition",
			Duration:    6,
			AspectRatio: "16:9",
			Resolution:  "768p",
			Images: []MediaReference{
				{DataURL: "data:image/png;base64,bGFzdA==", Role: "last_frame", Order: 2},
				{DataURL: "data:image/png;base64,Zmlyc3Q=", Role: "first_frame", Order: 1},
			},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, create)
		if body["width"] != float64(1344) || body["height"] != float64(768) {
			t.Fatalf("768p 16:9 size = %#v x %#v, want 1344x768", body["width"], body["height"])
		}
		var extra map[string]any
		if err := json.Unmarshal([]byte(body["extra_params"].(string)), &extra); err != nil {
			t.Fatal(err)
		}
		if extra["task"] != "fl2va" || extra["duration"] != float64(6) {
			t.Fatalf("fl2va extra_params = %#v", extra)
		}
		if len(create.Files) != 2 || create.Files[0].Name != "input_references" || create.Files[1].Name != "input_references" {
			t.Fatalf("files = %#v, want 2 ordered input_references parts", create.Files)
		}
		if create.Files[0].Reference.DataURL != "data:image/png;base64,Zmlyc3Q=" || create.Files[1].Reference.DataURL != "data:image/png;base64,bGFzdA==" {
			t.Fatalf("files order wrong: %#v", create.Files)
		}
	})

	t.Run("reference video and audio switches to ref2va", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability: CapabilityVideo,
			Model:      "MiniMaxAI/MiniMax-H3",
			Prompt:     "Keep subject and voice",
			Operation:  "reference_to_video",
			Duration:   5,
			Images:     []MediaReference{{DataURL: "data:image/png;base64,aW1n", Role: "reference_image", Order: 1}},
			Audios:     []MediaReference{{URL: "https://cdn.example/voice.mp3", Role: "reference_audio", Order: 1}},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, create)
		var extra map[string]any
		if err := json.Unmarshal([]byte(body["extra_params"].(string)), &extra); err != nil {
			t.Fatal(err)
		}
		if extra["task"] != "ref2va" {
			t.Fatalf("ref2va extra_params = %#v", extra)
		}
		if len(create.Files) != 1 || create.Files[0].Name != "input_references" {
			t.Fatalf("ref2va files = %#v", create.Files)
		}
		audioRef, ok := body["audio_reference"].(string)
		if !ok {
			t.Fatalf("audio_reference = %#v, want JSON string", body["audio_reference"])
		}
		var parsedAudio map[string]any
		if err := json.Unmarshal([]byte(audioRef), &parsedAudio); err != nil || parsedAudio["audio_url"] != "https://cdn.example/voice.mp3" {
			t.Fatalf("audio_reference = %q, err = %v", audioRef, err)
		}
	})

	t.Run("lifecycle poll cancel and content download", func(t *testing.T) {
		created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"video-123","status":"queued","created_at":1701234567}`))
		if err != nil || created.TaskID != "video-123" || created.Status != StatusPending {
			t.Fatalf("ParseCreate = %#v, err = %v", created, err)
		}
		poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "video-123"})
		if err != nil || poll.Method != "GET" || poll.Path != "/v1/videos/video-123" {
			t.Fatalf("BuildPoll = %#v, err = %v", poll, err)
		}
		done, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video-123"}, []byte(`{"id":"video-123","status":"completed"}`))
		if err != nil || done.Status != StatusSucceeded {
			t.Fatalf("ParsePoll = %#v, err = %v", done, err)
		}
		cancelSpec, err := adapter.BuildCancel(context.Background(), PollContext{TaskID: "video-123"})
		if err != nil || cancelSpec.Method != "DELETE" || cancelSpec.Path != "/v1/videos/video-123" {
			t.Fatalf("BuildCancel = %#v, err = %v", cancelSpec, err)
		}
		resultAdapter, ok := adapter.(ResultAdapter)
		if !ok {
			t.Fatal("vllm-omni-videos must implement ResultAdapter for /v1/videos/{id}/content")
		}
		resultSpec, err := resultAdapter.BuildResult(context.Background(), PollContext{TaskID: "video-123"})
		if err != nil || resultSpec.Method != "GET" || resultSpec.Path != "/v1/videos/video-123/content" || resultSpec.Headers["Accept"] != "video/mp4" {
			t.Fatalf("BuildResult = %#v, err = %v", resultSpec, err)
		}
	})
}
