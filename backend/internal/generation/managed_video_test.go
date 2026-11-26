package generation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/modelcatalog"
)

func TestManagedUnknownVideoSendsCatalogResolutionAndExplicitBusinessSwitches(t *testing.T) {
	for index, tc := range []struct {
		quality, want string
		profile       *VideoCapabilityConfig
	}{
		{quality: "480", want: "480p"},
		{quality: "720", want: "720p"},
		{quality: "1080", want: "1080p"},
		{quality: "720", want: "720p", profile: &VideoCapabilityConfig{Resolutions: []string{"480p", "720p", "1080p"}}},
		{quality: "2160", want: "4k", profile: &VideoCapabilityConfig{Resolutions: []string{"4k"}}},
		{quality: "server-native", want: "server-native", profile: &VideoCapabilityConfig{Resolutions: []string{"server-native"}}},
	} {
		t.Run(tc.quality+"/"+tc.want, func(t *testing.T) {
			creates := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/videos" {
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					w.WriteHeader(500)
					return
				}
				creates++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["model"] != "unseen-catalog-video" || body["resolution"] != tc.want || body["enable_safety_checker"] != true || body["seed"] != float64(0) {
					t.Errorf("wrong declared token/options: %#v", body)
				}
				if _, present := body["sync_mode"]; present {
					t.Errorf("historical result transport override leaked: %#v", body)
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"id": "same-task"})
			}))
			defer server.Close()
			input := Input{Mode: "video", Prompt: "free wire fixture", Config: Config{CredentialRef: beeftv.CredentialRef, Model: "unseen-catalog-video", BaseURL: server.URL, APIKey: "fixture", VQuality: tc.quality}, VideoCapability: tc.profile, Metadata: map[string]any{"videoH3Options": map[string]any{"seed": float64(0), "enable_safety_checker": true, "sync_mode": index%2 == 0}}}
			ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL}), "same-attempt")
			policy := DefaultVideoPollPolicy()
			policy.Sleep = func(context.Context, time.Duration) error { return context.Canceled }
			if _, err := RunVideoTaskWithPolicy(ctx, input, policy); !errors.Is(err, context.Canceled) || creates != 1 {
				t.Fatalf("creates=%d err=%v", creates, err)
			}
		})
	}
}

func TestManagedVideoCanonicalIntentHasNoModelTransportRules(t *testing.T) {
	for _, id := range []string{"opaque-future-video", "minimax-h3-max", "seedance-2.5", "grok-imagine-video-1.5", "kling-video-v3"} {
		input := Input{Prompt: "scene", Config: Config{Model: id, Size: "9:16", VideoSeconds: "0.925", VQuality: "768", VideoGenerateAudio: "false", VideoWatermark: "false"}, ReferenceImages: []Media{{ID: "first", URL: "https://example.com/first.png"}, {ID: "middle", URL: "https://example.com/middle.png"}, {ID: "last", URL: "https://example.com/last.png"}}, ReferenceVideos: []Media{{ID: "video", URL: "https://example.com/video.mp4"}}, ReferenceAudios: []Media{{ID: "audio", URL: "https://example.com/audio.wav"}}, Metadata: map[string]any{"videoEditOperation": "reference_to_video", "videoStartFrameNodeId": "first", "videoMiddleFrameNodeId": "middle", "videoEndFrameNodeId": "last", "videoMiddleFrameTime": 2.5, "videoReferenceOrder": []string{"audio", "first", "video", "middle", "last"}, "videoH3Options": map[string]any{"seed": float64(0), "prompt_expansion_mode": "quality", "damage_level": "heavy", "sync_mode": true, "enable_safety_checker": false}}}
		body, err := BeefTVVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		meta := body["metadata"].(map[string]any)
		if body["model"] != id || body["resolution"] != "768p" || body["seconds"] != "0.925" || body["aspect_ratio"] != "9:16" || meta["operation"] != "reference_to_video" || meta["generate_audio"] != false || meta["watermark"] != false || body["seed"] != float64(0) || body["middle_frame_time"] != 2.5 || body["prompt_expansion_mode"] != "quality" || body["damage_level"] != "heavy" || body["enable_safety_checker"] != false {
			t.Fatalf("lost user controls: %#v", body)
		}
		content := body["content"].([]map[string]any)
		var roles []any
		for _, item := range content {
			roles = append(roles, item["role"])
		}
		if !reflect.DeepEqual(roles, []any{"reference_audio", "first_frame", "reference_video", "middle_frame", "last_frame"}) {
			t.Fatalf("order/roles: %#v", content)
		}
		for _, key := range []string{"operation", "first_frame_url", "reference_conditions", "response_format", "sync_mode"} {
			if _, present := body[key]; present {
				t.Fatalf("supplier field %s leaked", key)
			}
		}
	}
}

func TestManagedUnknownVideoCreatesOnceAndResumesOnlyGET(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	creates, queries, contentCalls, storageCalls := 0, 0, 0, 0
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		storageCalls++
		if r.Header.Get("Authorization") != "" {
			t.Error("gateway credential leaked to object storage on redirect")
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("original video"))
	}))
	defer storage.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Error("missing API credential")
		}
		switch r.URL.Path {
		case "/v1/videos":
			creates++
			if r.Method != "POST" || r.Header.Get("Idempotency-Key") != "stable-attempt" {
				t.Error("unstable create")
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "opaque-future-video" || body["resolution"] != "768p" || body["seconds"] != "5" {
				t.Errorf("changed user values: %#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "original"})
		case "/v1/videos/original":
			queries++
			if r.Method != "GET" {
				t.Error("recovery mutated task")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "original", "status": "completed"})
		case "/v1/videos/original/content":
			contentCalls++
			if contentCalls == 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":{"message":"Video is being saved; retry later","type":"video_delivery_pending"}}`))
				return
			}
			http.Redirect(w, r, storage.URL+"/video.mp4", http.StatusFound)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL}), "stable-attempt")
	policy := DefaultVideoPollPolicy()
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	input := Input{Mode: "video", Prompt: "scene", Config: Config{CredentialRef: beeftv.CredentialRef, BaseURL: server.URL, APIKey: "fixture", Model: "opaque-future-video", InterfaceType: "stale-unknown-plugin", VQuality: "768", VideoSeconds: "5"}}
	for _, call := range []context.Context{ctx, EnrichCallMeta(ctx, CallMeta{ProviderRequestID: "original"})} {
		result, err := RunVideoTaskWithPolicy(call, input, policy)
		if err != nil || result["mode"] != "video" {
			t.Fatalf("result=%v err=%v", result, err)
		}
	}
	if creates != 1 || queries != 2 || contentCalls != 3 || storageCalls != 2 {
		t.Fatalf("calls=%d/%d/%d/%d", creates, queries, contentCalls, storageCalls)
	}
}

func TestManagedUnknownVideoKeepsSameImageFirstAndLastAndRejectsMissingSelection(t *testing.T) {
	input := Input{Config: Config{Model: "opaque-future"}, ReferenceImages: []Media{{ID: "same", URL: "https://example.com/same.png"}}, Metadata: map[string]any{"videoStartFrameNodeId": "same", "videoEndFrameNodeId": "same"}}
	for i := 0; i < 5; i++ {
		body, err := BeefTVVideoRequestBody(input)
		if err != nil {
			t.Fatal(err)
		}
		content := body["content"].([]map[string]any)
		if len(content) != 2 || content[0]["role"] != "first_frame" || content[1]["role"] != "last_frame" || !reflect.DeepEqual(content[0]["image_url"], content[1]["image_url"]) {
			t.Fatalf("same-image roles lost: %#v", content)
		}
	}
	input.Metadata["videoEndFrameNodeId"] = "missing"
	if _, err := BeefTVVideoRequestBody(input); err == nil {
		t.Fatal("missing selection ignored")
	}
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { posts++; w.WriteHeader(500) }))
	defer server.Close()
	input.Config.BaseURL, input.Config.CredentialRef = server.URL, beeftv.CredentialRef
	ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL}), "stable-invalid-frame")
	if _, err := RunVideoTaskWithPolicy(ctx, input, DefaultVideoPollPolicy()); err == nil || posts != 0 {
		t.Fatalf("invalid frame reached create: %v posts=%d", err, posts)
	}
}

func TestManagedVideoDefaultOperationAndFrameRoles(t *testing.T) {
	intPtr := func(v int) *int { return &v }
	boolPtr := func(v bool) *bool { return &v }

	frameAndAudioProfile := &modelcatalog.VideoCapabilityConfig{
		Operations: []string{"text_to_video", "image_to_video", "audio_to_video"},
		References: modelcatalog.VideoReferenceConfig{MaxImages: 2, MaxAudios: 1},
		OperationReferences: map[string]modelcatalog.VideoOperationReferences{
			"image_to_video": {MaxImages: intPtr(2), MaxVideos: intPtr(0), MaxAudios: intPtr(1)},
			"audio_to_video": {MaxImages: intPtr(0), MaxVideos: intPtr(0), MaxAudios: intPtr(1)},
		},
	}
	zeroAudioProfile := &modelcatalog.VideoCapabilityConfig{
		Operations: []string{"text_to_video", "image_to_video", "audio_to_video"},
		References: modelcatalog.VideoReferenceConfig{MaxImages: 2, MaxAudios: 1},
		OperationReferences: map[string]modelcatalog.VideoOperationReferences{
			"image_to_video": {MaxImages: intPtr(2), MaxVideos: intPtr(0), MaxAudios: intPtr(0)},
			"audio_to_video": {MaxImages: intPtr(0), MaxVideos: intPtr(0), MaxAudios: intPtr(0)},
		},
	}
	preferRefProfile := &modelcatalog.VideoCapabilityConfig{
		Operations:          []string{"text_to_video", "image_to_video", "audio_to_video", "reference_to_video"},
		PreferReferenceMode: boolPtr(true),
		References:          modelcatalog.VideoReferenceConfig{MaxImages: 9, MaxVideos: 3, MaxAudios: 3},
		OperationReferences: map[string]modelcatalog.VideoOperationReferences{
			"image_to_video": {MaxImages: intPtr(2), MaxVideos: intPtr(0), MaxAudios: intPtr(1)},
			"audio_to_video": {MaxImages: intPtr(0), MaxVideos: intPtr(0), MaxAudios: intPtr(1)},
		},
	}

	ref := func(kind, role string) beeftv.LocalMediaReference {
		return beeftv.LocalMediaReference{MediaReference: beeftv.MediaReference{Kind: kind, Role: role}}
	}

	oneImg := []beeftv.LocalMediaReference{ref("image", "reference")}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: frameAndAudioProfile}, oneImg); err != nil || got != "image_to_video" {
		t.Fatalf("one untagged image op = %q, err = %v, want image_to_video", got, err)
	}
	assignManagedVideoDefaultFrameRoles(oneImg, frameAndAudioProfile)
	if oneImg[0].Role != "first_frame" {
		t.Fatalf("one untagged image role = %q, want first_frame", oneImg[0].Role)
	}

	twoImgs := []beeftv.LocalMediaReference{ref("image", "reference"), ref("image", "reference")}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: frameAndAudioProfile}, twoImgs); err != nil || got != "image_to_video" {
		t.Fatalf("two untagged images op = %q, err = %v, want image_to_video", got, err)
	}
	assignManagedVideoDefaultFrameRoles(twoImgs, frameAndAudioProfile)
	if twoImgs[0].Role != "first_frame" || twoImgs[1].Role != "last_frame" {
		t.Fatalf("two untagged image roles = [%q, %q], want [first_frame, last_frame]", twoImgs[0].Role, twoImgs[1].Role)
	}

	imgAndAudio := []beeftv.LocalMediaReference{ref("image", "reference"), ref("audio", "reference")}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: frameAndAudioProfile}, imgAndAudio); err != nil || got != "image_to_video" {
		t.Fatalf("img+audio op = %q, err = %v, want image_to_video", got, err)
	}
	assignManagedVideoDefaultFrameRoles(imgAndAudio, frameAndAudioProfile)
	if imgAndAudio[0].Role != "first_frame" || imgAndAudio[1].Role != "reference" {
		t.Fatalf("img+audio roles = [%q, %q], want [first_frame, reference]", imgAndAudio[0].Role, imgAndAudio[1].Role)
	}

	audioOnly := []beeftv.LocalMediaReference{ref("audio", "reference")}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: frameAndAudioProfile}, audioOnly); err != nil || got != "audio_to_video" {
		t.Fatalf("audio-only op = %q, err = %v, want audio_to_video", got, err)
	}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: preferRefProfile}, audioOnly); err != nil || got != "audio_to_video" {
		t.Fatalf("preferReferenceMode audio-only op = %q, err = %v, want audio_to_video", got, err)
	}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: zeroAudioProfile}, audioOnly); err == nil {
		t.Fatalf("zero maxAudios should reject audio-only, got op=%q", got)
	}

	overAudio := []beeftv.LocalMediaReference{ref("image", "reference"), ref("audio", "reference"), ref("audio", "reference")}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: frameAndAudioProfile}, overAudio); err == nil {
		t.Fatalf("over-limit audio on no-reference profile should error instead of emitting reference_to_video, got op=%q", got)
	}

	preferRefImgs := []beeftv.LocalMediaReference{ref("image", "reference")}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: preferRefProfile}, preferRefImgs); err != nil || got != "reference_to_video" {
		t.Fatalf("preferReferenceMode op = %q, err = %v, want reference_to_video", got, err)
	}

	explicitLast := []beeftv.LocalMediaReference{ref("image", "last_frame")}
	assignManagedVideoDefaultFrameRoles(explicitLast, frameAndAudioProfile)
	if explicitLast[0].Role != "last_frame" {
		t.Fatalf("explicit last_frame overwritten to %q", explicitLast[0].Role)
	}

	opaqueUntagged := []beeftv.LocalMediaReference{ref("image", "reference")}
	if got, err := resolveManagedVideoOperation(Input{}, opaqueUntagged); err != nil || got != "reference_to_video" {
		t.Fatalf("opaque nil profile op = %q, err = %v, want reference_to_video", got, err)
	}
	assignManagedVideoDefaultFrameRoles(opaqueUntagged, nil)
	if opaqueUntagged[0].Role != "first_frame" {
		t.Fatalf("explicit i2v opaque image role = %q, want first_frame", opaqueUntagged[0].Role)
	}

	minTwoProfile := &modelcatalog.VideoCapabilityConfig{
		DefaultOperation: "text_to_video",
		Operations:       []string{"text_to_video", "image_to_video", "reference_to_video"},
		References:       modelcatalog.VideoReferenceConfig{MaxImages: 9},
		OperationReferences: map[string]modelcatalog.VideoOperationReferences{
			"image_to_video": {MinImages: intPtr(2), MaxImages: intPtr(2), MaxVideos: intPtr(0), MaxAudios: intPtr(0)},
		},
	}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: minTwoProfile}, []beeftv.LocalMediaReference{ref("image", "reference")}); err != nil || got != "reference_to_video" {
		t.Fatalf("minImages=2 with 1 image op = %q, err = %v, want reference_to_video", got, err)
	}

	i2vOnlyProfile := &modelcatalog.VideoCapabilityConfig{
		DefaultOperation: "image_to_video",
		Operations:       []string{"image_to_video"},
	}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: i2vOnlyProfile}, nil); err != nil || got != "image_to_video" {
		t.Fatalf("no-media non-t2v default op = %q, err = %v, want image_to_video", got, err)
	}
	noDefaultI2VOnly := &modelcatalog.VideoCapabilityConfig{
		Operations: []string{"image_to_video"},
	}
	if got, err := resolveManagedVideoOperation(Input{VideoCapability: noDefaultI2VOnly}, nil); err == nil {
		t.Fatalf("no-media undeclared text_to_video should fail, got op=%q", got)
	}
}

type managedVideoWireConfigPort struct {
	profile *VideoCapabilityConfig
}

func (p managedVideoWireConfigPort) Resolve(cfg Config) (Config, error) { return cfg, nil }
func (p managedVideoWireConfigPort) ApplyCapabilities(_ context.Context, input *Input) error {
	input.VideoCapability = p.profile
	if p.profile != nil {
		return validateVideoTaskParameters(p.profile, *input)
	}
	return nil
}
func (p managedVideoWireConfigPort) SyncArkPrivateAssets(context.Context, string, *Input) error {
	return nil
}

type managedVideoWireMediaPort struct {
	sent bool
}

func (p *managedVideoWireMediaPort) Sent(context.Context) (bool, error) { return p.sent, nil }
func (p *managedVideoWireMediaPort) Begin(*http.Request) (bool, error) {
	if p.sent {
		return true, nil
	}
	p.sent = true
	return false, nil
}

func TestRunManagedVideoTaskWireEnvelopeOperationAndFrameRoles(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	intPtr := func(v int) *int { return &v }
	frameAndAudioProfile := &modelcatalog.VideoCapabilityConfig{
		DefaultOperation: "text_to_video",
		Operations:       []string{"text_to_video", "image_to_video", "audio_to_video"},
		Resolutions:      []string{"768p"},
		Ratios:           []string{"16:9"},
		Duration:         modelcatalog.VideoDurationConfig{Selection: "range", Min: 1, Max: 10, Step: 1, Default: 5},
		References:       modelcatalog.VideoReferenceConfig{MaxImages: 2, MaxVideos: 0, MaxAudios: 1},
		OperationReferences: map[string]modelcatalog.VideoOperationReferences{
			"image_to_video": {MaxImages: intPtr(2), MaxVideos: intPtr(0), MaxAudios: intPtr(1)},
			"audio_to_video": {MaxImages: intPtr(0), MaxVideos: intPtr(0), MaxAudios: intPtr(1)},
		},
	}

	cases := []struct {
		name      string
		profile   *VideoCapabilityConfig
		images    []Media
		audios    []Media
		metadata  map[string]any
		wantOp    string
		wantRoles []string
		wantErr   bool
	}{
		{
			name:      "one untagged image sends image_to_video first_frame",
			profile:   frameAndAudioProfile,
			images:    []Media{{ID: "img-1", URL: "https://93.184.216.34/frame1.png"}},
			wantOp:    "image_to_video",
			wantRoles: []string{"first_frame"},
		},
		{
			name:      "two untagged images send image_to_video first_frame and last_frame",
			profile:   frameAndAudioProfile,
			images:    []Media{{ID: "img-z", URL: "https://93.184.216.34/frame1.png"}, {ID: "img-a", URL: "https://93.184.216.34/frame2.png"}},
			wantOp:    "image_to_video",
			wantRoles: []string{"first_frame", "last_frame"},
		},
		{
			name:    "one image plus over-limit audio fails before POST",
			profile: frameAndAudioProfile,
			images:  []Media{{ID: "img-1", URL: "https://93.184.216.34/frame1.png"}},
			audios:  []Media{{ID: "aud-1", URL: "https://93.184.216.34/a1.mp3"}, {ID: "aud-2", URL: "https://93.184.216.34/a2.mp3"}},
			wantErr: true,
		},
		{
			name:      "opaque nil profile keeps reference_to_video fallback",
			profile:   nil,
			images:    []Media{{ID: "img-1", URL: "https://93.184.216.34/frame1.png"}},
			wantOp:    "reference_to_video",
			wantRoles: []string{"reference"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			posts := 0
			var gotReq beeftv.MediaRequest
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set(beeftv.MediaProtocolHeader, beeftv.MediaProtocolVersion)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"media_protocol": beeftv.MediaDiscovery{
							Version:              beeftv.MediaProtocolVersion,
							SupportedMediaTypes:  []string{"video"},
							TaskSubmitURL:        "/v1/media/tasks",
							TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}",
							UploadsURL:           "/v1/media/uploads",
						},
						"data": []any{},
					})
				case r.Method == http.MethodPost && r.URL.Path == "/v1/media/tasks":
					posts++
					if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
						t.Error(err)
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{
						"task_ref":      gotReq.TaskRef,
						"media_type":    "video",
						"status":        "completed",
						"outputs":       []any{map[string]any{"kind": "video", "url": "http://" + r.Host + "/out.mp4"}},
						"billing_state": "settled",
						"usage_state":   "completed",
					})
				case r.Method == http.MethodGet && r.URL.Path == "/out.mp4":
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("mp4-bytes"))
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			input := Input{
				Mode:   "video",
				Prompt: "camera push in",
				Config: Config{
					CredentialRef:        beeftv.CredentialRef,
					MediaProtocolVersion: beeftv.MediaProtocolVersion,
					BaseURL:              server.URL,
					APIKey:               "fixture",
					Model:                "opaque-video-model",
					VQuality:             "768p",
					Size:                 "16:9",
					VideoSeconds:         "5",
				},
				ReferenceImages: tc.images,
				ReferenceAudios: tc.audios,
				Metadata:        tc.metadata,
			}
			ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL}), "wire-test-"+tc.name)
			ctx = WithRuntime(ctx, Runtime{
				Config:       managedVideoWireConfigPort{profile: tc.profile},
				ManagedMedia: &managedVideoWireMediaPort{},
			})
			client := managedMediaClient(ctx, input.Config)
			_, err := runManagedVideoTask(ctx, client, input)
			if tc.wantErr {
				if err == nil || posts != 0 {
					t.Fatalf("expected error with 0 POSTs, got err=%v posts=%d", err, posts)
				}
				return
			}
			if err != nil {
				t.Fatalf("runManagedVideoTask failed: %v", err)
			}
			if posts != 1 || gotReq.Operation != tc.wantOp {
				t.Fatalf("posts=%d operation=%q, want 1 / %q", posts, gotReq.Operation, tc.wantOp)
			}
			var gotRoles []string
			for _, item := range gotReq.Input.References {
				gotRoles = append(gotRoles, item.Role)
			}
			if !reflect.DeepEqual(gotRoles, tc.wantRoles) {
				t.Fatalf("roles=%v, want %v", gotRoles, tc.wantRoles)
			}
		})
	}
}

func TestRunManagedVideoTaskAppliesTaskTypeConstraints(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	cases := []struct {
		name           string
		operation      string
		images         []Media
		useServerVideo bool
		metadata       map[string]any
		wantOp         string
		wantRatio      any
		wantSeconds    any
		wantNoRatio    bool
		wantNoSeconds  bool
		quality        string
	}{
		{
			name:           "inpaint locks adaptive ratio and duration -1",
			operation:      "inpaint",
			useServerVideo: true,
			wantOp:         "inpaint",
			wantRatio:      "adaptive",
			wantSeconds:    float64(-1),
		},
		{
			name:           "replace_element locks adaptive ratio and duration -1",
			operation:      "replace_element",
			useServerVideo: true,
			wantOp:         "replace_element",
			wantRatio:      "adaptive",
			wantSeconds:    float64(-1),
		},
		{
			name:           "style_transfer locks adaptive ratio and duration -1",
			operation:      "style_transfer",
			useServerVideo: true,
			wantOp:         "style_transfer",
			wantRatio:      "adaptive",
			wantSeconds:    float64(-1),
		},
		{
			name:           "extend locks adaptive ratio while keeping duration",
			operation:      "extend",
			useServerVideo: true,
			wantOp:         "extend",
			wantRatio:      "adaptive",
			wantSeconds:    float64(5),
		},
		{
			name:        "image_to_video first_frame locks adaptive ratio",
			operation:   "image_to_video",
			images:      []Media{{URL: "https://93.184.216.34/first.png"}},
			wantOp:      "image_to_video",
			wantRatio:   "adaptive",
			wantSeconds: float64(5),
		},
		{
			name:        "image_to_video explicit last_frame locks adaptive ratio",
			operation:   "image_to_video",
			images:      []Media{{ID: "end-img", URL: "https://93.184.216.34/last.png"}},
			metadata:    map[string]any{"videoEditOperation": "image_to_video", "videoEndFrameNodeId": "end-img"},
			wantOp:      "image_to_video",
			wantRatio:   "adaptive",
			wantSeconds: float64(5),
		},
		{
			name:          "draft_to_final does not re-inject aspect_ratio or seconds",
			operation:     "draft_to_final",
			metadata:      map[string]any{"videoEditOperation": "draft_to_final", "videoDraftTaskId": "task_draft_1"},
			wantOp:        "draft_to_final",
			wantNoRatio:   true,
			wantNoSeconds: true,
			quality:       "1080p",
		},
	}

	profile := &modelcatalog.VideoCapabilityConfig{
		Operations:          []string{"text_to_video", "image_to_video", "reference_to_video", "inpaint", "replace_element", "style_transfer", "extend", "draft_to_final"},
		TaskTypeConstraints: true,
		Draft:               modelcatalog.VideoBooleanConfig{Supported: true},
		Duration:            modelcatalog.VideoDurationConfig{Selection: "enum", Values: []int{-1, 4, 5, 6, 7, 8}, Default: 5},
		Ratios:              []string{"16:9", "9:16", "adaptive"},
		Resolutions:         []string{"480p", "720p", "1080p"},
		References:          modelcatalog.VideoReferenceConfig{MaxImages: 4, MaxImageBytes: 30 << 20, MaxVideos: 1, MaxVideoBytes: 50 << 20},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotReq beeftv.MediaRequest
			var lastUpload beeftv.UploadRequest
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/models":
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set(beeftv.MediaProtocolHeader, beeftv.MediaProtocolVersion)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"media_protocol": beeftv.MediaDiscovery{
							Version:              beeftv.MediaProtocolVersion,
							SupportedMediaTypes:  []string{"video"},
							TaskSubmitURL:        "/v1/media/tasks",
							TaskQueryURLTemplate: "/v1/media/tasks/{task_ref}",
							UploadsURL:           "/v1/media/uploads",
						},
						"data": []any{},
					})
				case r.Method == http.MethodGet && r.URL.Path == "/src.mp4":
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("src-mp4-bytes"))
				case r.Method == http.MethodPost && r.URL.Path == "/v1/media/uploads":
					_ = json.NewDecoder(r.Body).Decode(&lastUpload)
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(beeftv.UploadSession{
						UploadURL:    "http://" + r.Host + "/put-upload",
						UploadMethod: http.MethodPut,
						Ticket:       "ticket-1",
					})
				case r.Method == http.MethodPut && r.URL.Path == "/put-upload":
					w.WriteHeader(http.StatusOK)
				case r.Method == http.MethodPost && r.URL.Path == "/v1/media/uploads/complete":
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{
						"url":    "http://" + r.Host + "/uploaded-src.mp4",
						"kind":   lastUpload.Kind,
						"mime":   lastUpload.Mime,
						"bytes":  lastUpload.Bytes,
						"sha256": lastUpload.SHA256,
					})
				case r.Method == http.MethodPost && r.URL.Path == "/v1/media/tasks":
					if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
						t.Fatalf("decode /v1/media/tasks: %v", err)
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{
						"task_ref":      gotReq.TaskRef,
						"media_type":    "video",
						"status":        "completed",
						"outputs":       []map[string]any{{"kind": "video", "url": "http://" + r.Host + "/out.mp4"}},
						"billing_state": "settled",
						"usage_state":   "completed",
					})
				case r.Method == http.MethodGet && r.URL.Path == "/out.mp4":
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("mp4-bytes"))
				default:
					t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			var videos []Media
			if tc.useServerVideo {
				videos = []Media{{URL: server.URL + "/src.mp4"}}
			}
			meta := tc.metadata
			if meta == nil {
				meta = map[string]any{"videoEditOperation": tc.operation}
			}
			quality := tc.quality
			if quality == "" {
				quality = "720p"
			}
			input := Input{
				Mode:   "video",
				Prompt: "replace background",
				Config: Config{
					CredentialRef:        beeftv.CredentialRef,
					MediaProtocolVersion: beeftv.MediaProtocolVersion,
					BaseURL:              server.URL,
					APIKey:               "fixture",
					Model:                "opaque-video-model",
					VQuality:             quality,
					Size:                 "16:9",
					VideoSeconds:         "5",
				},
				ReferenceImages: tc.images,
				ReferenceVideos: videos,
				Metadata:        meta,
			}
			ctx := WithSubmissionKey(WithEndpoints(context.Background(), Endpoints{BeefTVVideoBaseURL: server.URL}), "constraints-"+tc.operation)
			ctx = WithRuntime(ctx, Runtime{
				Config:       managedVideoWireConfigPort{profile: profile},
				ManagedMedia: &managedVideoWireMediaPort{},
				Limits:       stubLimits{},
			})
			client := managedMediaClient(ctx, input.Config)
			if _, err := runManagedVideoTask(ctx, client, input); err != nil {
				t.Fatalf("runManagedVideoTask failed: %v", err)
			}
			if gotReq.Operation != tc.wantOp {
				t.Fatalf("operation = %q, want %q", gotReq.Operation, tc.wantOp)
			}
			if tc.wantNoRatio {
				if _, exists := gotReq.Options["aspect_ratio"]; exists {
					t.Fatalf("aspect_ratio should be omitted for %s, got %#v", tc.operation, gotReq.Options)
				}
			} else if gotReq.Options["aspect_ratio"] != tc.wantRatio {
				t.Fatalf("aspect_ratio = %#v, want %#v (options=%#v)", gotReq.Options["aspect_ratio"], tc.wantRatio, gotReq.Options)
			}
			if tc.wantNoSeconds {
				if _, exists := gotReq.Options["seconds"]; exists {
					t.Fatalf("seconds should be omitted for %s, got %#v", tc.operation, gotReq.Options)
				}
			} else if gotReq.Options["seconds"] != tc.wantSeconds {
				t.Fatalf("seconds = %#v, want %#v (options=%#v)", gotReq.Options["seconds"], tc.wantSeconds, gotReq.Options)
			}
		})
	}
}
