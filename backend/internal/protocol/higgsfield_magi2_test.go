package protocol

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestHiggsfieldMAGI2Requests(t *testing.T) {
	adapter := loadHiggsfieldMAGI2(t)
	const first = "https://media.example/first.png"
	const last = "https://media.example/last.png"
	const video = "https://media.example/reference.mp4"
	const audio = "https://media.example/reference.wav"

	tests := []struct {
		mode    string
		request GenerationRequest
		fields  map[string]any
	}{
		{
			mode:    "text-to-video",
			request: GenerationRequest{Prompt: "Morning fog over the lake"},
			fields:  map[string]any{"prompt": "Morning fog over the lake"},
		},
		{
			mode:    "image-to-video",
			request: GenerationRequest{Images: []MediaReference{{URL: first}}},
			fields:  map[string]any{"image_url": first},
		},
		{
			mode: "image-to-video",
			request: GenerationRequest{Images: []MediaReference{
				{URL: last, Role: "last_frame"},
				{URL: first, Role: "first_frame"},
			}},
			fields: map[string]any{"image_url": first, "end_image_url": last},
		},
		{
			mode: "reference-to-video",
			request: GenerationRequest{
				Images: []MediaReference{{URL: first}},
				Videos: []MediaReference{{URL: video}},
				Audios: []MediaReference{{URL: audio}},
			},
			fields: map[string]any{"image_urls": []any{first}, "video_urls": []any{video}, "audio_urls": []any{audio}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.mode, func(t *testing.T) {
			tc.request.Model = "sand/magi-2/" + tc.mode
			tc.request.Output = OutputOptions{Duration: 12, AspectRatio: "9:16", GenerateAudio: true}
			spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: tc.request})
			if err != nil {
				t.Fatal(err)
			}
			if spec.Method != "POST" || spec.Path != "/"+tc.request.Model || !spec.OriginPath ||
				spec.Auth.Header != "Authorization" || spec.Auth.Prefix != "Key " || spec.Auth.Field != "apiKey" {
				t.Fatalf("unexpected request spec: %+v", spec)
			}
			tc.fields["duration"] = float64(12)
			tc.fields["aspect_ratio"] = "9:16"
			tc.fields["resolution"] = "1080p"
			tc.fields["generate_audio"] = true
			if body := manifestTestBody(t, spec); !reflect.DeepEqual(body, tc.fields) {
				t.Fatalf("body = %#v, want %#v", body, tc.fields)
			}
		})
	}

	for _, model := range []string{"another-model", "sand/magi-2/text-to-video", "sand/magi-2/reference-to-video"} {
		if _, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: model}}); err == nil {
			t.Fatalf("accepted incomplete or unsupported request for %q", model)
		}
	}
}

func TestHiggsfieldMAGI2TaskLifecycle(t *testing.T) {
	adapter := loadHiggsfieldMAGI2(t)
	ctx := context.Background()
	task, err := adapter.ParseCreate(ctx, []byte(`{"request_id":"request-1","status":"queued"}`))
	if err != nil || task.TaskID != "request-1" || task.Status != StatusPending {
		t.Fatalf("create result = %+v, error = %v", task, err)
	}
	poll := PollContext{TaskID: task.TaskID}
	spec, err := adapter.BuildPoll(ctx, poll)
	if err != nil || spec.Method != "GET" || spec.Path != "/requests/request-1/status" || !spec.OriginPath {
		t.Fatalf("poll request = %+v, error = %v", spec, err)
	}
	canceler, ok := adapter.(interface {
		BuildCancel(context.Context, PollContext) (RequestSpec, error)
	})
	if !ok {
		t.Fatal("missing cancel operation")
	}
	spec, err = canceler.BuildCancel(ctx, poll)
	if err != nil || spec.Method != "POST" || spec.Path != "/requests/request-1/cancel" || !spec.OriginPath {
		t.Fatalf("cancel request = %+v, error = %v", spec, err)
	}
	for status, want := range map[string]Status{
		"in_progress": StatusProcessing, "failed": StatusFailed, "nsfw": StatusFailed, "canceled": StatusCancelled,
	} {
		result, err := adapter.ParsePoll(ctx, poll, []byte(`{"status":"`+status+`"}`))
		if err != nil || result.Status != want || result.TaskID != task.TaskID {
			t.Fatalf("%s result = %+v, error = %v", status, result, err)
		}
	}
	const url = "https://media.example/output.mp4"
	result, err := adapter.ParsePoll(ctx, poll, []byte(`{"status":"completed","video":{"url":"`+url+`"}}`))
	if err != nil || result.Status != StatusSucceeded || result.Result == nil || len(result.Result.Videos) != 1 {
		t.Fatalf("completed result = %+v, error = %v", result, err)
	}
	if video := result.Result.Videos[0]; video.URL != url || !video.Ephemeral {
		t.Fatalf("unexpected video result: %+v", video)
	}
}

func loadHiggsfieldMAGI2(t *testing.T) Adapter {
	t.Helper()
	manifest, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "higgsfield-magi-2", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := LoadInstalledPlugin(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}
