package protocol

import (
	"context"
	"strings"
	"testing"
)

func TestDashscopeWan30VideoUsesMediaArrayResolutionAndRatio(t *testing.T) {
	adapter := officialPackageAdapter(t, "dashscope-wan-video.beeftv-plugin", "dashscope-wan-video")

	t.Run("first and last frame", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model:       "wan3.0-video",
			Prompt:      "海边镜头平稳推进",
			Duration:    8,
			AspectRatio: "16:9",
			Resolution:  "480p",
			Images: []MediaReference{
				{URL: "https://cdn.example/last.png", Role: "last_frame", Order: 2},
				{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
			},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		if !create.OriginPath {
			t.Fatal("dashscope-wan-video create must set originPath=true so /compatible-mode/v1 base URLs resolve to root /api/v1/...")
		}
		body := manifestTestBody(t, create)
		input, _ := body["input"].(map[string]any)
		media, ok := input["media"].([]any)
		if !ok || len(media) != 2 {
			t.Fatalf("wan3.0-video input.media = %#v, want 2 items (first_frame + last_frame); full input = %#v", input["media"], input)
		}
		first, _ := media[0].(map[string]any)
		last, _ := media[1].(map[string]any)
		if first["type"] != "first_frame" || first["url"] != "https://cdn.example/first.png" {
			t.Fatalf("first media = %#v", first)
		}
		if last["type"] != "last_frame" || last["url"] != "https://cdn.example/last.png" {
			t.Fatalf("last media = %#v", last)
		}
		for _, legacy := range []string{"img_url", "first_frame_url", "last_frame_url", "reference_images", "video_url", "audio_url"} {
			if _, exists := input[legacy]; exists {
				t.Fatalf("wan3.0-video must not emit legacy input.%s: %#v", legacy, input)
			}
		}
		params, _ := body["parameters"].(map[string]any)
		if params["resolution"] != "480P" || params["ratio"] != "16:9" || params["duration"] != float64(8) {
			t.Fatalf("wan3.0-video parameters = %#v, want resolution=480P ratio=16:9 duration=8", params)
		}
		if _, exists := params["size"]; exists {
			t.Fatalf("wan3.0-video must not emit legacy parameters.size: %#v", params)
		}
	})

	t.Run("multimodal references", func(t *testing.T) {
		create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model:       "wan3.0-video",
			Prompt:      "角色保持一致并跟随动作参考",
			Operation:   "reference_to_video",
			Duration:    8,
			AspectRatio: "16:9",
			Resolution:  "480P",
			Images: []MediaReference{
				{URL: "https://cdn.example/char-2.png", Role: "reference_image", Order: 2},
				{URL: "https://cdn.example/char-1.png", Role: "reference_image", Order: 1},
			},
			Videos: []MediaReference{
				{URL: "https://cdn.example/motion.mp4", Role: "reference_video", Order: 1},
			},
			Audios: []MediaReference{
				{URL: "https://cdn.example/voice.mp3", Role: "reference_audio", Order: 1},
			},
		}})
		if err != nil {
			t.Fatalf("BuildCreate() error = %v", err)
		}
		body := manifestTestBody(t, create)
		input, _ := body["input"].(map[string]any)
		media, ok := input["media"].([]any)
		if !ok || len(media) != 4 {
			t.Fatalf("wan3.0-video reference input.media = %#v, want 4 items", input["media"])
		}
		want := [][2]string{
			{"reference_image", "https://cdn.example/char-1.png"},
			{"reference_image", "https://cdn.example/char-2.png"},
			{"reference_video", "https://cdn.example/motion.mp4"},
			{"reference_audio", "https://cdn.example/voice.mp3"},
		}
		for i, expected := range want {
			entry, _ := media[i].(map[string]any)
			if entry["type"] != expected[0] || entry["url"] != expected[1] {
				t.Fatalf("media[%d] = %#v, want type=%q url=%q", i, entry, expected[0], expected[1])
			}
		}
	})

	t.Run("wan3.0 rejects mixing keyframes with references", func(t *testing.T) {
		_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model:  "wan3.0-video",
			Prompt: "混用校验",
			Images: []MediaReference{
				{URL: "https://cdn.example/first.png", Role: "first_frame", Order: 1},
				{URL: "https://cdn.example/ref.png", Role: "reference_image", Order: 2},
			},
		}})
		if err == nil || !strings.Contains(err.Error(), "首尾帧") {
			t.Fatalf("expected keyframe/reference mutual exclusion error, got %v", err)
		}
	})

	t.Run("wan2.7 uses media array while wan2.2 stays legacy", func(t *testing.T) {
		wan27, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
			Model:      "wan2.7-i2v",
			Prompt:     "镜头推进",
			Resolution: "720p",
			Images:     []MediaReference{{URL: "https://cdn.example/first.png", Role: "first_frame"}},
		}})
		if err != nil {
			t.Fatalf("wan2.7-i2v BuildCreate() error = %v", err)
		}
		wan27Input, _ := manifestTestBody(t, wan27)["input"].(map[string]any)
		wan27Media, _ := wan27Input["media"].([]any)
		if len(wan27Media) != 1 {
			t.Fatalf("wan2.7-i2v input.media = %#v, want 1 item", wan27Input["media"])
		}

		poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "wan-task-1"})
		if err != nil {
			t.Fatalf("BuildPoll() error = %v", err)
		}
		if !poll.OriginPath || poll.Path != "/api/v1/tasks/wan-task-1" {
			t.Fatalf("poll = %#v, want originPath=true path=/api/v1/tasks/wan-task-1", poll)
		}
	})
}
