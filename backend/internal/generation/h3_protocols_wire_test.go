package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVLLMOmniVideosEndToEndMultipartPollAndContentDownload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	adapter := loadOfficialProtocolAdapterForTest(t, "vllm-omni-videos.beeftv-plugin", "vllm-omni-videos")

	var gotForm map[string]string
	var gotFiles []string
	var gotAuth string
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
			gotAuth = r.Header.Get("Authorization")
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data;") {
				t.Errorf("Content-Type = %q, want multipart/form-data", r.Header.Get("Content-Type"))
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			reader, err := r.MultipartReader()
			if err != nil {
				t.Errorf("MultipartReader() error = %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			gotForm = map[string]string{}
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Errorf("NextPart() error = %v", err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				data, _ := io.ReadAll(part)
				if part.FileName() != "" {
					gotFiles = append(gotFiles, part.FormName()+":"+string(data))
				} else {
					gotForm[part.FormName()] = string(data)
				}
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"video-h3-1","status":"queued"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/video-h3-1":
			polls++
			w.Header().Set("Content-Type", "application/json")
			if polls == 1 {
				fmt.Fprint(w, `{"id":"video-h3-1","status":"in_progress"}`)
				return
			}
			fmt.Fprint(w, `{"id":"video-h3-1","status":"completed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/video-h3-1/content":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("\x00\x00\x00\x18ftypmp42fake-video"))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	policy := fastDeclarativePollPolicy()
	policy.InitialDelay = 0
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{
		Mode:   "video",
		Prompt: "Waves crashing at sunset",
		Config: Config{
			BaseURL:       server.URL,
			APIKey:        "local-secret",
			Model:         "minimax-h3-fl2va",
			InterfaceType: "vllm-omni-videos",
			Size:          "16:9",
			VQuality:      "480p",
			VideoSeconds:  "5",
		},
		Metadata: map[string]any{
			"providerOptions": map[string]any{
				"vllm-omni-videos": map[string]any{
					"fps":                 24,
					"num_inference_steps": 10,
					"flow_shift":          12,
					"seed":                1101,
					"audio_flow_shift":    3.0,
				},
			},
		},
	}, adapter, policy)
	if err != nil {
		t.Fatalf("RunProtocolAdapterTaskWithPolicy() error = %v", err)
	}
	if gotAuth != "Bearer local-secret" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if gotForm["model"] != "minimax-h3-fl2va" || gotForm["width"] != "1024" || gotForm["height"] != "576" || gotForm["aspect_ratio"] != "16:9" || gotForm["fps"] != "24" || gotForm["num_inference_steps"] != "10" || gotForm["flow_shift"] != "12" || gotForm["seed"] != "1101" {
		t.Fatalf("multipart form = %#v", gotForm)
	}
	var extra map[string]any
	if err := json.Unmarshal([]byte(gotForm["extra_params"]), &extra); err != nil {
		t.Fatalf("extra_params = %q, err = %v", gotForm["extra_params"], err)
	}
	if extra["task"] != "t2va" || extra["duration"] != float64(5) || extra["audio_flow_shift"] != float64(3) {
		t.Fatalf("extra_params decoded = %#v", extra)
	}
	if len(gotFiles) != 0 {
		t.Fatalf("unexpected files on T2VA: %#v", gotFiles)
	}
	videoMap, _ := result["video"].(map[string]interface{})
	if result["mode"] != "video" || !strings.HasPrefix(fmt.Sprint(videoMap["dataUrl"]), "data:video/mp4;base64,") {
		t.Fatalf("result = %#v", result)
	}
}

func TestOpenAIVideosMediaJSONEndToEndDirectURLAndContentFallback(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	adapter := loadOfficialProtocolAdapterForTest(t, "openai-videos-media-json.beeftv-plugin", "openai-videos-media-json")

	for _, withDirectURL := range []bool{true, false} {
		name := "content_fallback"
		if withDirectURL {
			name = "direct_video_url"
		}
		t.Run(name, func(t *testing.T) {
			var gotBody map[string]any
			contentHits := 0
			directHits := 0
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
					if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
						t.Errorf("Content-Type = %q, want application/json", r.Header.Get("Content-Type"))
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					raw, _ := io.ReadAll(r.Body)
					_ = json.NewDecoder(bytes.NewReader(raw)).Decode(&gotBody)
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"id":"video_gp_1","status":"queued"}`)
				case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/video_gp_1":
					w.Header().Set("Content-Type", "application/json")
					if withDirectURL {
						fmt.Fprintf(w, `{"id":"video_gp_1","status":"completed","video_url":"%s/cdn/out.mp4","video_url_expires_at":null}`, server.URL)
					} else {
						fmt.Fprint(w, `{"id":"video_gp_1","status":"completed","video_url":null}`)
					}
				case r.Method == http.MethodGet && r.URL.Path == "/cdn/out.mp4":
					directHits++
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("\x00\x00\x00\x18ftypmp42direct"))
				case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/video_gp_1/content":
					contentHits++
					w.Header().Set("Content-Type", "video/mp4")
					_, _ = w.Write([]byte("\x00\x00\x00\x18ftypmp42content"))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()

			policy := fastDeclarativePollPolicy()
			policy.InitialDelay = 0
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			result, err := RunProtocolAdapterTaskWithPolicy(ctx, Input{
				Mode:   "video",
				Prompt: "雨夜霓虹街道",
				Config: Config{
					BaseURL:       server.URL + "/v1",
					APIKey:        "gp-key",
					Model:         "minimax/h3",
					InterfaceType: "openai-videos-media-json",
					Size:          "16:9",
					VQuality:      "720p",
					VideoSeconds:  "6",
				},
				ReferenceImages: []Media{
					{ID: "f1", URL: "https://cdn.example/first.png"},
					{ID: "f2", URL: "https://cdn.example/last.png"},
				},
				Metadata: map[string]any{
					"videoStartFrameNodeId": "f1",
					"videoEndFrameNodeId":   "f2",
				},
			}, adapter, policy)
			if err != nil {
				t.Fatalf("RunProtocolAdapterTaskWithPolicy() error = %v", err)
			}
			if gotBody["model"] != "minimax/h3" || gotBody["size"] != "1344x768" || gotBody["seconds"] != float64(6) {
				t.Fatalf("request body = %#v", gotBody)
			}
			media, _ := gotBody["media"].([]any)
			if len(media) != 2 {
				t.Fatalf("request media = %#v", gotBody["media"])
			}
			if withDirectURL && (directHits != 1 || contentHits != 0) {
				t.Fatalf("directHits=%d contentHits=%d", directHits, contentHits)
			}
			if !withDirectURL && (directHits != 0 || contentHits != 1) {
				t.Fatalf("directHits=%d contentHits=%d", directHits, contentHits)
			}
			if result["mode"] != "video" {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}
