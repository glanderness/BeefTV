package protocol

import (
	"context"
	"strings"
	"testing"
)

func TestOpenAIVideosMediaJSONContract(t *testing.T) {
	adapter := officialPackageAdapter(t, "openai-videos-media-json.beeftv-plugin", "openai-videos-media-json")

	t.Run("text to video maps H3 ratios to pixel canvases without rejected fields", func(t *testing.T) {
		for ratio, wantSize := range map[string]string{
			"21:9":     "1536x672",
			"16:9":     "1344x768",
			"4:3":      "1024x768",
			"1:1":      "768x768",
			"3:4":      "768x1024",
			"9:16":     "768x1344",
			"1280x720": "1280x720",
		} {
			create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
				Capability:    CapabilityVideo,
				Model:         "minimax/h3",
				Prompt:        "霓虹街道，雨夜，第一人称视角向前行走",
				Duration:      6,
				AspectRatio:   ratio,
				Resolution:    "720p",
				GenerateAudio: true,
				Watermark:     false,
			}})
			if err != nil {
				t.Fatalf("ratio %s BuildCreate() error = %v", ratio, err)
			}
			if create.Method != "POST" || create.Path != "/v1/videos" || create.ContentType != "application/json" {
				t.Fatalf("create = %#v", create)
			}
			body := manifestTestBody(t, create)
			if body["model"] != "minimax/h3" || body["size"] != wantSize || body["seconds"] != float64(6) {
				t.Fatalf("ratio %s body = %#v, want size=%s seconds=6", ratio, body, wantSize)
			}
			if _, exists := body["media"]; exists {
				t.Fatalf("T2V must omit empty media array: %#v", body)
			}
			for _, forbidden := range []string{"watermark", "audio", "prompt_extend", "seed"} {
				if _, exists := body[forbidden]; exists {
					t.Fatalf("must not emit unsupported default %q on minimax/h3: %#v", forbidden, body)
				}
			}
		}
	})

	t.Run("first and last frame uses top-level media array", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability:  CapabilityVideo,
			Model:       "minimax/h3",
			Prompt:      "镜头缓慢推进",
			Duration:    6,
			AspectRatio: "16:9",
			Images: []MediaReference{
				{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
				{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
			},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, create)
		media, ok := body["media"].([]any)
		if !ok || len(media) != 2 {
			t.Fatalf("media = %#v, want 2 items", body["media"])
		}
		first, _ := media[0].(map[string]any)
		last, _ := media[1].(map[string]any)
		if first["type"] != "first_frame" || first["url"] != "https://cdn.example/first.png" || last["type"] != "last_frame" || last["url"] != "https://cdn.example/last.png" {
			t.Fatalf("keyframe media = %#v", media)
		}
	})

	t.Run("multimodal references map image video and audio into top-level media", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability:  CapabilityVideo,
			Model:       "minimax/h3",
			Prompt:      "角色保持一致，沿用视频镜头节奏和音频音色",
			Operation:   "reference_to_video",
			Duration:    8,
			AspectRatio: "16:9",
			Images:      []MediaReference{{DataURL: "data:image/png;base64,aW1n", Role: "reference_image", Order: 1}},
			Videos:      []MediaReference{{URL: "https://cdn.example/ref.mp4", Role: "reference_video", Order: 1}},
			Audios:      []MediaReference{{URL: "https://cdn.example/voice.mp3", Role: "reference_audio", Order: 1}},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, create)
		media, ok := body["media"].([]any)
		if !ok || len(media) != 3 {
			t.Fatalf("multimodal media = %#v, want 3 items", body["media"])
		}
		want := [][2]string{
			{"reference_image", "data:image/png;base64,aW1n"},
			{"reference_video", "https://cdn.example/ref.mp4"},
			{"reference_audio", "https://cdn.example/voice.mp3"},
		}
		for i, expected := range want {
			entry, _ := media[i].(map[string]any)
			if entry["type"] != expected[0] || entry["url"] != expected[1] {
				t.Fatalf("media[%d] = %#v, want %v", i, entry, expected)
			}
		}
	})

	t.Run("rejects mixing keyframes with references", func(t *testing.T) {
		_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability: CapabilityVideo,
			Model:      "minimax/h3",
			Prompt:     "mix",
			Images: []MediaReference{
				{URL: "https://cdn.example/first.png", Role: "first_frame"},
				{URL: "https://cdn.example/ref.png", Role: "reference_image"},
			},
		}})
		if err == nil || !strings.Contains(err.Error(), "首尾帧") {
			t.Fatalf("expected keyframe/reference mutual exclusion error, got %v", err)
		}
	})

	t.Run("poll parses video_url and exposes authenticated /content fallback", func(t *testing.T) {
		created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"video_1","status":"queued"}`))
		if err != nil || created.TaskID != "video_1" || created.Status != StatusPending {
			t.Fatalf("ParseCreate = %#v, err = %v", created, err)
		}
		withURL, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video_1"}, []byte(`{"id":"video_1","status":"completed","video_url":"https://storage.example/out.mp4","video_url_expires_at":null}`))
		if err != nil || withURL.Status != StatusSucceeded || withURL.Result == nil || len(withURL.Result.Videos) != 1 || withURL.Result.Videos[0].URL != "https://storage.example/out.mp4" {
			t.Fatalf("ParsePoll(with video_url) = %#v, err = %v", withURL, err)
		}
		withoutURL, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video_1"}, []byte(`{"id":"video_1","status":"completed","video_url":null}`))
		if err != nil || withoutURL.Status != StatusSucceeded || withoutURL.Result != nil {
			t.Fatalf("ParsePoll(null video_url) = %#v, err = %v", withoutURL, err)
		}
		resultAdapter, ok := adapter.(ResultAdapter)
		if !ok {
			t.Fatal("openai-videos-media-json must implement ResultAdapter")
		}
		resultSpec, err := resultAdapter.BuildResult(context.Background(), PollContext{TaskID: "video_1"})
		if err != nil || resultSpec.Method != "GET" || resultSpec.Path != "/v1/videos/video_1/content" || resultSpec.Headers["Accept"] != "video/mp4" {
			t.Fatalf("BuildResult = %#v, err = %v", resultSpec, err)
		}
	})

	t.Run("standard openai-videos multipart contract remains unchanged", func(t *testing.T) {
		legacy := officialPackageAdapter(t, "openai-videos.beeftv-plugin", "newapi")
		create, err := legacy.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Capability: CapabilityVideo,
			Model:      "sora-2",
			Prompt:     "standard multipart",
			Duration:   5,
		}})
		if err != nil {
			t.Fatalf("openai-videos BuildCreate() error = %v", err)
		}
		if create.ContentType != "multipart/form-data" || create.Path != "/v1/videos" {
			t.Fatalf("openai-videos create = %#v, must stay multipart /v1/videos", create)
		}
	})
}
