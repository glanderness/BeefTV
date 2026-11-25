package protocol

import (
	"context"
	"encoding/json"
	"math"
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
		if body["width"] != float64(1376) || body["height"] != float64(768) {
			t.Fatalf("768p 16:9 size = %#v x %#v, want 1376x768", body["width"], body["height"])
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

	t.Run("resolution and aspect ratio matrix produces 32-aligned dimensions", func(t *testing.T) {
		ratioTargets := map[string]float64{
			"16:9": 16.0 / 9.0,
			"9:16": 9.0 / 16.0,
			"1:1":  1.0,
			"4:3":  4.0 / 3.0,
			"3:4":  3.0 / 4.0,
			"21:9": 21.0 / 9.0,
		}
		cases := []struct {
			resolution string
			ratio      string
			wantW      float64
			wantH      float64
			wantRatio  string
			minShort   float64
		}{
			{"480p", "16:9", 1024, 576, "16:9", 480},
			{"576p", "landscape", 1024, 576, "16:9", 576},
			{"480p", "9:16", 576, 1024, "9:16", 480},
			{"480p", "portrait", 576, 1024, "9:16", 480},
			{"480p", "1:1", 576, 576, "1:1", 480},
			{"480p", "square", 576, 576, "1:1", 480},
			{"480p", "4:3", 768, 576, "4:3", 480},
			{"480p", "3:4", 576, 768, "3:4", 480},
			{"480p", "21:9", 1344, 576, "21:9", 480},
			{"720p", "16:9", 1376, 768, "16:9", 720},
			{"768p", "16:9", 1376, 768, "16:9", 768},
			{"768p", "9:16", 768, 1376, "9:16", 768},
			{"768p", "1:1", 768, 768, "1:1", 768},
			{"768p", "4:3", 1024, 768, "4:3", 768},
			{"768p", "3:4", 768, 1024, "3:4", 768},
			{"768p", "21:9", 1792, 768, "21:9", 768},
			{"1080p", "16:9", 1920, 1088, "16:9", 1080},
			{"1080p", "9:16", 1088, 1920, "9:16", 1080},
			{"1080p", "1:1", 1088, 1088, "1:1", 1080},
			{"1080p", "4:3", 1440, 1088, "4:3", 1080},
			{"1080p", "3:4", 1088, 1440, "3:4", 1080},
			{"1080p", "21:9", 2528, 1088, "21:9", 1080},
			{"1440p", "16:9", 2560, 1440, "16:9", 1440},
			{"2k", "9:16", 1440, 2560, "9:16", 1440},
			{"1440p", "1:1", 1440, 1440, "1:1", 1440},
			{"1440p", "4:3", 1920, 1440, "4:3", 1440},
			{"1440p", "3:4", 1440, 1920, "3:4", 1440},
			{"1440p", "21:9", 3360, 1440, "21:9", 1440},
			{"", "1280x720", 1280, 720, "", 0},
		}
		for _, tc := range cases {
			create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Capability:  CapabilityVideo,
				Model:       "minimax-h3-fl2va",
				Prompt:      "matrix check",
				Resolution:  tc.resolution,
				AspectRatio: tc.ratio,
			}})
			if err != nil {
				t.Fatalf("%s/%s BuildCreate() error = %v", tc.resolution, tc.ratio, err)
			}
			body := manifestTestBody(t, create)
			if body["width"] != tc.wantW || body["height"] != tc.wantH {
				t.Fatalf("%s/%s got %v x %v, want %v x %v", tc.resolution, tc.ratio, body["width"], body["height"], tc.wantW, tc.wantH)
			}
			if tc.wantRatio == "" {
				if _, exists := body["aspect_ratio"]; exists {
					t.Fatalf("%s/%s unexpected aspect_ratio=%v", tc.resolution, tc.ratio, body["aspect_ratio"])
				}
			} else {
				if body["aspect_ratio"] != tc.wantRatio {
					t.Fatalf("%s/%s aspect_ratio = %v, want %q", tc.resolution, tc.ratio, body["aspect_ratio"], tc.wantRatio)
				}
				if int(tc.wantW)%32 != 0 || int(tc.wantH)%32 != 0 {
					t.Fatalf("%s/%s dimensions %vx%v not 32-aligned", tc.resolution, tc.ratio, tc.wantW, tc.wantH)
				}
				shortSide := math.Min(tc.wantW, tc.wantH)
				if shortSide < tc.minShort {
					t.Fatalf("%s/%s short side %v shrunk below tier %v", tc.resolution, tc.ratio, shortSide, tc.minShort)
				}
				targetAspect := ratioTargets[tc.wantRatio]
				actualAspect := tc.wantW / tc.wantH
				if relErr := math.Abs(actualAspect-targetAspect) / targetAspect; relErr > 0.01 {
					t.Fatalf("%s/%s aspect ratio %.4f deviates %.2f%% from target %.4f (>1%%)", tc.resolution, tc.ratio, actualAspect, relErr*100, targetAspect)
				}
			}
		}

		// Empty aspectRatio omits width/height/aspect_ratio cleanly.
		emptyCreate, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability: CapabilityVideo,
			Model:      "minimax-h3-fl2va",
			Prompt:     "no ratio",
			Resolution: "768p",
		}})
		if err != nil {
			t.Fatalf("empty ratio BuildCreate() error = %v", err)
		}
		emptyBody := manifestTestBody(t, emptyCreate)
		for _, omitted := range []string{"width", "height", "aspect_ratio"} {
			if _, exists := emptyBody[omitted]; exists {
				t.Fatalf("empty ratio must omit %q, got %#v", omitted, emptyBody)
			}
		}
	})
}
