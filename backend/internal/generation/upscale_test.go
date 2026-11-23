package generation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/outbound"
)

type upscaleResources struct {
	ResourcePort
	data []byte
	kind string
}

func (p upscaleResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != "user-1" || id != "source" {
		return ResourceInfo{}, errors.New("resource not owned")
	}
	mime := "image/png"
	if p.kind == "video" {
		mime = "video/mp4"
	}
	return ResourceInfo{ID: id, UserID: user, Status: "ready", Kind: p.kind, MimeType: mime, Size: int64(len(p.data)), Width: 64, Height: 48, DurationMs: 1000}, nil
}
func (p upscaleResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	if err != nil {
		return info, nil, err
	}
	return info, io.NopCloser(bytes.NewReader(p.data)), nil
}
func (p upscaleResources) LocalMode() bool { return true }

func upscalePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func upscaleClip(t *testing.T, width, height int, audio bool) []byte {
	t.Helper()
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("native ffmpeg unavailable")
	}
	if _, err := mediatools.ResolveFFprobe(); err != nil {
		t.Skip("native ffprobe unavailable")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=24:duration=1", width, height)}
	if audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration=1")
	}
	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p")
	if audio {
		args = append(args, "-c:a", "aac", "-shortest")
	}
	args = append(args, path)
	if out, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
		t.Fatalf("fixture ffmpeg: %s %v", out, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

type upscaleProgressPort struct {
	active atomic.Bool
	stage  atomic.Value
}

func (p *upscaleProgressPort) ReportReference(ReferenceProgress) { p.active.Store(true) }
func (p *upscaleProgressPort) ClearReference()                   { p.active.Store(false) }
func (p *upscaleProgressPort) SetStage(_ context.Context, stage string) error {
	p.stage.Store(stage)
	return nil
}

func TestUpscaleExecuteFourModelsUsesOwnedUploadAndOriginalResult(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, model := range []string{"topaz-standard-v2", "topaz-wonder-3.5", "topaz-proteus", "topaz-starlight-fast-2"} {
		t.Run(model, func(t *testing.T) {
			kind := UpscaleMediaType(model)
			source, output := upscalePNG(t, 64, 48), upscalePNG(t, 128, 96)
			mime := "image/png"
			if model == "topaz-standard-v2" {
				source, output = upscalePNG(t, 1920, 1080), upscalePNG(t, 3840, 2160)
			}
			if kind == "video" {
				source, output, mime = upscaleClip(t, 64, 48, true), upscaleClip(t, 128, 96, false), "video/mp4"
			}
			var creates, uploads, downloads, estimates, stored atomic.Int32
			progress := &upscaleProgressPort{}
			// The API answers content with 307 to the file it already saved in object
			// storage. Storage must receive no API key, cookie or custom API header.
			storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				stored.Add(1)
				for _, key := range []string{"Authorization", "Cookie", "X-Api-Key", "X-Private-Gateway", "Idempotency-Key"} {
					if r.Header.Get(key) != "" {
						t.Errorf("storage received %s", key)
					}
				}
				if r.Method != http.MethodGet || r.URL.Path != "/saved/result" {
					t.Errorf("unexpected storage request %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", mime)
				_, _ = w.Write(output)
			}))
			defer storage.Close()
			var posted map[string]any
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path != "/put" && r.Header.Get("Authorization") != "Bearer synthetic-upscale-key" {
					t.Error("missing gateway auth")
				}
				switch r.URL.Path {
				case "/v1/media/uploads":
					uploads.Add(1)
					_ = json.NewEncoder(w).Encode(BeefTVSeedanceUploadSession{Ticket: "ticket", UploadURL: server.URL + "/put", UploadMethod: "PUT", RequiredHeaders: map[string]string{"Content-Type": mime}})
				case "/put":
					data, _ := io.ReadAll(r.Body)
					if !bytes.Equal(data, source) || r.Header.Get("Authorization") != "" {
						t.Error("upload altered original bytes or leaked key")
					}
				case "/v1/media/uploads/complete":
					sum := sha256.Sum256(source)
					_ = json.NewEncoder(w).Encode(BeefTVSeedanceUploadComplete{URL: server.URL + "/source", Kind: kind, Mime: mime, Bytes: int64(len(source)), SHA256: hex.EncodeToString(sum[:])})
				case "/v1/media-upscale/estimate":
					estimates.Add(1)
					_ = json.NewEncoder(w).Encode(UpscaleEstimate{Model: model, Currency: "CNY", Reservation: 1.25})
				case "/v1/media-upscale/tasks":
					creates.Add(1)
					if r.Method != "POST" || r.Header.Get("Idempotency-Key") != "stable-operation" {
						t.Error("lost submission key")
					}
					_ = json.NewDecoder(r.Body).Decode(&posted)
					w.WriteHeader(202)
					_, _ = io.WriteString(w, `{"task_id":"original-task","status":"queued"}`)
				case "/v1/media-upscale/tasks/original-task":
					if progress.active.Load() || progress.stage.Load() != "正在确认超分结果" {
						t.Error("accepted upscale still shows reference upload progress")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "original-task", "status": "completed", "model": model, "media_type": kind, "result_url": "https://untrusted.invalid/steal"})
				case "/v1/media-upscale/tasks/original-task/content":
					downloads.Add(1)
					if r.Method != http.MethodGet {
						t.Error("content must be read with GET")
					}
					http.Redirect(w, r, storage.URL+"/saved/result?sig=short", http.StatusTemporaryRedirect)
				default:
					t.Errorf("unexpected endpoint %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			runtime := taskRuntime(func(r *Runtime) {
				r.Endpoints.BeefTVVideoBaseURL = server.URL
				r.Resources = upscaleResources{data: source, kind: kind}
				r.ReferenceProgress = progress
				r.Stages = progress
			})
			input := Input{Mode: kind, Prompt: "AI 超分", Config: Config{BaseURL: server.URL, APIKey: "synthetic-upscale-key", Model: model, InterfaceType: "newapi", Headers: []outbound.OutboundHeader{{Name: "X-Private-Gateway", Value: "private"}}}, Upscale: &UpscaleOptions{Factor: 2}}
			if kind == "image" {
				input.ReferenceImages = []Media{{StorageKey: "resource:source"}}
			} else {
				input.ReferenceVideos = []Media{{StorageKey: "resource:source"}}
			}
			ctx := WithSubmissionKey(WithRuntime(context.Background(), runtime), "stable-operation")
			quote, _, err := EstimateUpscale(ctx, input)
			if err != nil || quote.GenerationSubmitted || creates.Load() != 0 || quote.Reservation != 1.25 {
				t.Fatalf("estimate submitted generation: %#v %v", quote, err)
			}
			result, err := Execute(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"model": model, "upscale_factor": float64(2)}
			if kind == "image" {
				want["image_url"] = server.URL + "/source"
				want["face_enhancement"] = false
				want["output_format"] = "png"
			} else {
				want["video_url"] = server.URL + "/source"
				want["H264_output"] = true
			}
			if !reflect.DeepEqual(posted, want) {
				t.Fatalf("native payload = %#v want %#v", posted, want)
			}
			if creates.Load() != 1 || downloads.Load() != 1 || stored.Load() != 1 || estimates.Load() != 1 {
				t.Fatalf("creates=%d downloads=%d stored=%d estimates=%d", creates.Load(), downloads.Load(), stored.Load(), estimates.Load())
			}
			if kind == "video" {
				video := result["video"].(map[string]any)
				_, data, err := DecodeProviderDataURL(video["dataUrl"].(string))
				if err != nil {
					t.Fatal(err)
				}
				dir := t.TempDir()
				path, _ := upscaleTempFile(dir, "result.mp4", data)
				facts, err := mediatools.ProbeLocal(ctx, path)
				if err != nil || !facts.HasAudio || facts.Width != 128 || facts.Height != 96 || facts.DurationMs < 950 || facts.DurationMs > 1050 {
					t.Fatalf("output metadata=%#v %v", facts, err)
				}
				if input.ReferenceVideos[0].StorageKey != "resource:source" {
					t.Fatal("upload mutated original source needed for recovery/audio")
				}
			}
			before := uploads.Load()
			runtime.Call.ProviderRequestID = "original-task"
			if _, err := Execute(WithRuntime(context.Background(), runtime), input); err != nil {
				t.Fatal(err)
			}
			if creates.Load() != 1 || uploads.Load() != before || downloads.Load() != 2 || stored.Load() != 2 {
				t.Fatal("resume uploaded or submitted generation again")
			}
		})
	}
}

func TestUpscaleRejectsOwnerAndInvalidInputBeforePaidSubmit(t *testing.T) {
	input := Input{Mode: "image", Prompt: "AI 超分", Config: Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-standard-v2"}, Upscale: &UpscaleOptions{Factor: 2}, ReferenceImages: []Media{{StorageKey: "resource:source"}}}
	for _, factor := range []int{0, 5} {
		changed := input
		changed.Upscale = &UpscaleOptions{Factor: factor}
		if ValidateUpscaleInput(changed) == nil {
			t.Fatal("invalid factor accepted")
		}
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "foreign"
		r.Resources = upscaleResources{kind: "image", data: upscalePNG(t, 64, 48)}
	})
	_, err := PrepareUpscale(WithRuntime(context.Background(), runtime), input)
	if err == nil {
		t.Fatal("foreign owner accepted")
	}
}

func TestUpscaleOriginalStatusIdentityAndCancellation(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	status, returnedID := "unknown", "original-task"
	var creates, cancels, recovers atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/media-upscale/tasks/original-task/cancel" {
			cancels.Add(1)
			_, _ = io.WriteString(w, `{"task_id":"original-task","cancellation_requested":true,"refunded":false}`)
			return
		}
		if r.Method == "POST" {
			if r.URL.Path == "/v1/media-upscale/tasks/original-task/recover" {
				recovers.Add(1)
			} else {
				creates.Add(1)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"task_id": returnedID, "status": status, "model": "topaz-standard-v2", "media_type": "image"})
	}))
	defer server.Close()
	config := Config{BaseURL: server.URL, APIKey: "synthetic", Model: "topaz-standard-v2"}
	ctx := WithRuntime(context.Background(), taskRuntime(func(r *Runtime) { r.Endpoints.BeefTVVideoBaseURL = server.URL }))
	result, observed, err := QueryUpscaleResult(ctx, Input{Mode: "image", Config: config}, "original-task")
	if err != nil || result != nil || observed != "unknown" {
		t.Fatalf("unknown result=%v status=%s err=%v", result, observed, err)
	}
	if _, _, err := RecoverUpscaleResult(ctx, Input{Mode: "image", Config: config}, "original-task"); err != nil || recovers.Load() != 0 {
		t.Fatalf("manual recover: calls=%d err=%v", recovers.Load(), err)
	}
	if err := CancelUpscale(ctx, config, "original-task"); err != nil {
		t.Fatal(err)
	}
	status = "cancelling"
	if got, err := QueryUpscaleStatus(ctx, config, "original-task"); err != nil || got != "cancelling" {
		t.Fatal(got, err)
	}
	returnedID = "different-task"
	if _, err := QueryUpscaleStatus(ctx, config, "original-task"); err == nil {
		t.Fatal("mismatched receipt accepted")
	}
	if creates.Load() != 0 || cancels.Load() != 1 {
		t.Fatal("status/recovery submitted another generation")
	}
	if _, err := upscaleTaskPath("../escape"); err == nil {
		t.Fatal("unsafe id accepted")
	}
}

func TestUpscalePreservesExistingAudioBytes(t *testing.T) {
	data := upscaleClip(t, 64, 48, true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := PreserveUpscaleAudio(ctx, data, data)
	if err != nil || !bytes.Equal(data, output) {
		t.Fatal("existing audio was unnecessarily rewritten", err)
	}
}

func TestUpscaleShortAudioDoesNotTrimVideoOrChangeFPS(t *testing.T) {
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	probe, err := mediatools.ResolveFFprobe()
	if err != nil {
		t.Skip("ffprobe unavailable")
	}
	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.mp4")
	outputPath := filepath.Join(dir, "output.mp4")
	for _, item := range []struct {
		path  string
		audio bool
	}{{sourcePath, true}, {outputPath, false}} {
		args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24:duration=2"}
		if item.audio {
			args = append(args, "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5")
		}
		args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p")
		if item.audio {
			args = append(args, "-c:a", "aac")
		}
		args = append(args, item.path)
		if data, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
			t.Fatal(string(data), err)
		}
	}
	source, _ := os.ReadFile(sourcePath)
	output, _ := os.ReadFile(outputPath)
	result, err := PreserveUpscaleAudio(context.Background(), source, output)
	if err != nil {
		t.Fatal(err)
	}
	path, _ := upscaleTempFile(dir, "restored.mp4", result)
	facts, err := mediatools.ProbeLocal(context.Background(), path)
	if err != nil || !facts.HasAudio || facts.DurationMs < 1950 || facts.DurationMs > 2050 {
		t.Fatalf("short soundtrack trimmed video: %#v %v", facts, err)
	}
	fps, err := exec.Command(probe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path).Output()
	if err != nil || string(bytes.TrimSpace(fps)) != "24/1" {
		t.Fatal("frame rate changed", string(fps), err)
	}
}

type upscaleBudget struct{ LimitsPort }

func (upscaleBudget) GeneratedFileBytes(context.Context) (int64, error) { return 1 << 20, nil }

func TestUpscalePreflightRejectsExternalReferencesAndOversizedDelivery(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer server.Close()
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = upscaleResources{kind: "image", data: upscalePNG(t, 64, 48)}
		r.Limits = upscaleBudget{}
	})
	input := Input{Mode: "image", Prompt: "AI 超分", Config: Config{BaseURL: server.URL, Model: "topaz-standard-v2"}, Upscale: &UpscaleOptions{Factor: 2}}
	for _, source := range []Media{{StorageKey: "legacy-key", URL: "https://untrusted.invalid/source.png"}, {StorageKey: "resource:source", URL: "https://untrusted.invalid/source.png"}, {StorageKey: "resource:source", DataURL: "data:image/png;base64,AA=="}, {StorageKey: "resource:source"}} {
		input.ReferenceImages = []Media{source}
		if _, err := PrepareUpscale(WithRuntime(context.Background(), runtime), input); err == nil {
			t.Fatal("invalid source or known over-budget result accepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid input made %d upstream requests", calls.Load())
	}
}

func TestUpscaleWebPConfigAndPixelLimit(t *testing.T) {
	data, err := base64.StdEncoding.DecodeString("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQsqYVrf+BiOh/AAA=")
	if err != nil {
		t.Fatal(err)
	}
	if meta, err := upscaleImageConfig(data); err != nil || meta.Width != 1 || meta.Height != 1 {
		t.Fatalf("valid WebP rejected: %+v %v", meta, err)
	}
	// VP8X stores canvas dimensions in 24-bit little-endian fields.
	header := make([]byte, 30)
	copy(header, "RIFF")
	binary.LittleEndian.PutUint32(header[4:], 22)
	copy(header[8:], "WEBPVP8X")
	binary.LittleEndian.PutUint32(header[16:], 10)
	for _, offset := range []int{24, 27} {
		header[offset] = 0xff
		header[offset+1] = 0x1f
	}
	if _, err := upscaleImageConfig(header); err == nil {
		t.Fatal("oversized WebP header accepted")
	}
}

func TestUpscaleRejectsWebMContainer(t *testing.T) {
	bin, err := mediatools.ResolveFFmpeg()
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	path := filepath.Join(t.TempDir(), "source.webm")
	if out, err := exec.Command(bin, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:duration=0.2", "-c:v", "libvpx-vp9", path).CombinedOutput(); err != nil {
		t.Fatalf("WebM fixture %s %v", out, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, facts, err := streamProbeOwnedVideo(context.Background(), io.NopCloser(bytes.NewReader(data)), BeefTVSeedanceKindMaxBytes("video"))
	if err != nil {
		t.Fatalf("streamProbeOwnedVideo failed: %v", err)
	}
	if err := validateUpscaleVideoFacts(facts); err == nil {
		t.Fatal("WebM accepted as MP4/MOV")
	}
}

func TestUpscaleSubmissionRejectionRequiresNoTaskEvidence(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, tc := range []struct {
		status   int
		body     string
		rejected bool
	}{
		{400, `{"error":{"code":"fal_billing_unavailable"}}`, true},
		{422, `{"code":"invalid_params"}`, true},
		{400, `{"task_id":"original","error":{"code":"invalid_params"}}`, false},
		{400, `{"id":"original","error":{"code":"invalid_params"}}`, false},
		{400, `<html>bad gateway</html>`, false},
		{409, `{"error":{"code":"idempotency_conflict"}}`, false},
		{503, `{"error":{"code":"upstream_unavailable"}}`, false},
		{503, `{"code":"fal_billing_unavailable"}`, true},
		{503, `{"error":{"code":"upscale_unavailable"}}`, true},
		{503, `{"task_id":"original","code":"fal_billing_unavailable"}`, false},
		{503, `{"id":"original","code":"fal_billing_unavailable"}`, false},
		{502, `{"code":"upscale_submission_unknown"}`, false},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = io.WriteString(w, tc.body)
		}))
		var receipt map[string]any
		err := postJSONWithSubmissionKey(WithSubmissionKey(context.Background(), "stable-operation"), Config{BaseURL: server.URL}, "/media-upscale/tasks", map[string]any{}, &receipt, upscaleSubmissionError)
		server.Close()
		var rejection SubmissionRejectedError
		if errors.As(err, &rejection) != tc.rejected {
			t.Fatalf("status=%d body=%s rejection=%v", tc.status, tc.body, err)
		}
	}
	unknown := SubmissionUnknownError{Cause: HTTPError{StatusCode: 400, Body: `{"code":"invalid_params"}`}}
	var rejection SubmissionRejectedError
	if errors.As(upscaleSubmissionError(unknown), &rejection) {
		t.Fatal("earlier uncertainty became safe rejection")
	}
}

func TestUpscaleProviderErrorClassificationDistinguishesUnavailableFromInvalidSource(t *testing.T) {
	unavailable := ClassifyHTTP(503, "503 Service Unavailable", `{"error":{"code":"upscale_unavailable","message":"upscale source could not be verified in time; please retry"}}`)
	if unavailable.Category != CategoryProviderUnavailable || !unavailable.Retryable || unavailable.Uncertain {
		t.Fatalf("unexpected 503 upscale_unavailable classification: %#v", unavailable)
	}
	invalidVideo := ClassifyHTTP(400, "400 Bad Request", `{"error":{"code":"invalid_upscale_source","message":"video input must be a readable public MP4/MOV of at most five minutes and 200 MiB"}}`)
	if invalidVideo.Category != CategoryInvalidParams || invalidVideo.Reason != "超分视频素材不符合要求" {
		t.Fatalf("unexpected 400 video invalid_upscale_source classification: %#v", invalidVideo)
	}
	invalidImage := ClassifyHTTP(400, "400 Bad Request", `{"error":{"code":"invalid_upscale_source","message":"image input must be a readable public JPEG, PNG or WebP of at most 30 MiB and 32 megapixels"}}`)
	if invalidImage.Category != CategoryInvalidParams || invalidImage.Reason != "超分图片素材不符合要求" {
		t.Fatalf("unexpected 400 image invalid_upscale_source classification: %#v", invalidImage)
	}
}

type fileUpscaleResources struct {
	ResourcePort
	path       string
	kind       string
	size       int64
	width      int
	height     int
	durationMs int64
}

func (p fileUpscaleResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != "user-1" || id != "source" {
		return ResourceInfo{}, errors.New("resource not owned")
	}
	mime := "image/png"
	if p.kind == "video" {
		mime = "video/mp4"
	}
	return ResourceInfo{ID: id, UserID: user, Status: "ready", Kind: p.kind, MimeType: mime, Size: p.size, Width: p.width, Height: p.height, DurationMs: p.durationMs}, nil
}

func (p fileUpscaleResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	if err != nil {
		return info, nil, err
	}
	f, err := os.Open(p.path)
	if err != nil {
		return info, nil, err
	}
	return info, f, nil
}

func (p fileUpscaleResources) LocalMode() bool { return true }

type configurableBudget struct {
	LimitsPort
	limit int64
}

func (b configurableBudget) GeneratedFileBytes(context.Context) (int64, error) { return b.limit, nil }

func TestUpscaleEstimateUsesLocalMetadataWithoutCOSUpload(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	for _, modelName := range []string{"topaz-standard-v2", "topaz-proteus", "topaz-starlight-fast-2"} {
		t.Run(modelName, func(t *testing.T) {
			kind := UpscaleMediaType(modelName)
			dir := t.TempDir()
			var path string
			var data []byte
			if kind == "image" {
				data = upscalePNG(t, 64, 48)
				path = filepath.Join(dir, "source.png")
			} else {
				data = upscaleClip(t, 64, 48, true)
				path = filepath.Join(dir, "source.mp4")
			}
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			var uploads atomic.Int32
			var estimateBody map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/v1/media/uploads":
					uploads.Add(1)
					http.Error(w, "estimate should not upload", http.StatusInternalServerError)
				case "/v1/media-upscale/estimate":
					if err := json.NewDecoder(r.Body).Decode(&estimateBody); err != nil {
						t.Errorf("decode estimate body: %v", err)
					}
					_ = json.NewEncoder(w).Encode(UpscaleEstimate{Model: modelName, Currency: "CNY", Reservation: 2.5})
				default:
					t.Errorf("unexpected endpoint %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			runtime := taskRuntime(func(r *Runtime) {
				r.Endpoints.BeefTVVideoBaseURL = server.URL
				r.Resources = fileUpscaleResources{path: path, kind: kind, size: int64(len(data)), width: 64, height: 48, durationMs: 1000}
			})
			input := Input{Mode: kind, Prompt: "AI 超分", Config: Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: modelName, InterfaceType: "newapi"}, Upscale: &UpscaleOptions{Factor: 2}}
			if kind == "image" {
				input.ReferenceImages = []Media{{StorageKey: "resource:source"}}
			} else {
				input.ReferenceVideos = []Media{{StorageKey: "resource:source"}}
			}
			quote, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), input)
			if err != nil {
				t.Fatalf("metadata-only estimate failed: %v", err)
			}
			if uploads.Load() != 0 {
				t.Fatalf("expected 0 COS uploads during estimate, got %d", uploads.Load())
			}
			if quote.Reservation != 2.5 || quote.GenerationSubmitted {
				t.Fatalf("unexpected quote: %#v", quote)
			}
			if estimateBody["width"] != float64(64) || estimateBody["height"] != float64(48) {
				t.Fatalf("missing width/height in estimate body: %#v", estimateBody)
			}
			if kind == "image" {
				if _, hasURL := estimateBody["image_url"]; hasURL {
					t.Fatalf("metadata-only image estimate sent image_url: %#v", estimateBody)
				}
			} else {
				if _, hasURL := estimateBody["video_url"]; hasURL {
					t.Fatalf("metadata-only video estimate sent video_url: %#v", estimateBody)
				}
				if estimateBody["duration_seconds"] != float64(1) {
					t.Fatalf("missing duration_seconds: %#v", estimateBody)
				}
				fps, _ := estimateBody["frame_rate"].(float64)
				if fps <= 20 || fps >= 30 {
					t.Fatalf("expected ~24fps from local probe, got %v (%#v)", fps, estimateBody)
				}
			}
		})
	}
}

func TestUpscaleVideoPreflightDoesNotApplyFakeFactorMultiplier(t *testing.T) {
	clip := upscaleClip(t, 64, 48, false)
	// Previously len(clip)*4*4*2 + 1MiB would exceed len(clip)*2 and falsely reject.
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = upscaleResources{kind: "video", data: clip}
		r.Limits = configurableBudget{limit: int64(len(clip)) * 2}
	})
	input := Input{
		Mode:            "video",
		Prompt:          "AI 超分",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-proteus"},
		Upscale:         &UpscaleOptions{Factor: 4},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	if _, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), input); err != nil {
		t.Fatalf("video preflight rejected valid clip under factor=4: %v", err)
	}
	// A clip strictly larger than deliveryLimit is still rejected with a clear message.
	runtime.Limits = configurableBudget{limit: int64(len(clip)) - 1}
	_, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), input)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("本机单个生成资源上限")) {
		t.Fatalf("expected clear delivery-limit error, got %v", err)
	}
}

func TestEstimateUpscaleNeverUploadsOnMissingFFprobeOrUnreadableMetadata(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "estimate must not contact upstream on local failure", http.StatusInternalServerError)
	}))
	defer server.Close()

	// 1. Missing ffprobe on a real local *os.File fails fast with clear tool-missing copy and 0 uploads.
	missingDir := t.TempDir()
	t.Setenv("CANVAS_FFPROBE_PATH", filepath.Join(missingDir, "missing-ffprobe"))
	videoFile := filepath.Join(missingDir, "large-video.mp4")
	if err := os.WriteFile(videoFile, []byte("placeholder-video-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = fileUpscaleResources{
			path: videoFile, kind: "video", size: 150 << 20, width: 1920, height: 1080, durationMs: 15000,
		}
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	input := Input{
		Mode:            "video",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-proteus", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), input)
	classified := ClassifyError(err)
	if err == nil || classified.Category != CategoryInputInaccessible || !bytes.Contains([]byte(classified.UserMessage()), []byte("视频处理工具不可用")) {
		t.Fatalf("missing ffprobe should fail fast with clear tool copy: err=%v classified=%#v", err, classified)
	}

	// 2. Missing video metadata (width/height/duration = 0) fails cleanly without silently uploading to COS.
	runtime.Resources = &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4", Size: 10 << 20},
	}
	_, _, err = EstimateUpscale(WithRuntime(context.Background(), runtime), input)
	classified = ClassifyError(err)
	if err == nil || classified.Category != CategoryInvalidParams || !bytes.Contains([]byte(classified.UserMessage()), []byte("无法读取超分视频的尺寸或时长")) {
		t.Fatalf("missing video metadata must fail cleanly without COS upload: err=%v classified=%#v", err, classified)
	}

	// 3. Unreadable/unknown-MIME image fails cleanly without silently uploading to COS.
	runtime.Resources = &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "image", MimeType: "application/octet-stream", Size: 1024, Width: 64, Height: 48},
	}
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-standard-v2", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source"}},
	}
	_, _, err = EstimateUpscale(WithRuntime(context.Background(), runtime), imgInput)
	classified = ClassifyError(err)
	if err == nil || classified.Category != CategoryInvalidParams || !bytes.Contains([]byte(classified.UserMessage()), []byte("无法读取超分图片的尺寸或格式")) {
		t.Fatalf("unreadable image metadata must fail cleanly without COS upload: err=%v classified=%#v", err, classified)
	}
	if hits.Load() != 0 {
		t.Fatalf("failed local estimates made %d upstream requests", hits.Load())
	}
}

type guardedLocalFile struct {
	*os.File
	t       *testing.T
	maxRead int64
	read    int64
}

func (g *guardedLocalFile) Read(p []byte) (int, error) {
	n, err := g.File.Read(p)
	g.read += int64(n)
	if g.read > g.maxRead {
		g.t.Errorf("zero-copy preflight read %d bytes (max allowed %d)", g.read, g.maxRead)
	}
	return n, err
}

type guardedFileResources struct {
	fileUpscaleResources
	t       *testing.T
	maxRead int64
}

func (p guardedFileResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, rc, err := p.fileUpscaleResources.Open(user, id)
	if err != nil {
		return info, nil, err
	}
	return info, &guardedLocalFile{File: rc.(*os.File), t: p.t, maxRead: p.maxRead}, nil
}

func TestUpscaleSubmitUsesZeroCopyLocalFilePreflight(t *testing.T) {
	dir := t.TempDir()
	// Image: real local *os.File reads at most the header on submit preflight and rejects 0-byte empty file cleanly.
	pngPath := filepath.Join(dir, "source.png")
	pngBytes := upscalePNG(t, 64, 48)
	if err := os.WriteFile(pngPath, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = guardedFileResources{
			fileUpscaleResources: fileUpscaleResources{path: pngPath, kind: "image", size: int64(len(pngBytes))},
			t:                    t,
			maxRead:              videoReferenceHeaderDecodeLimit,
		}
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-standard-v2"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source"}},
	}
	prepared, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), imgInput)
	if err != nil || prepared.ReferenceImages[0].Width != 64 || prepared.ReferenceImages[0].Height != 48 {
		t.Fatalf("local file image submit preflight failed: prepared=%#v err=%v", prepared, err)
	}
	emptyPath := filepath.Join(dir, "empty.png")
	if err := os.WriteFile(emptyPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	runtime.Resources = fileUpscaleResources{path: emptyPath, kind: "image"}
	_, err = prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), imgInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInvalidParams || !bytes.Contains([]byte(classified.UserMessage()), []byte("参考素材为空")) {
		t.Fatalf("empty local file not rejected with clear copy: err=%v classified=%#v", err, classified)
	}
	// Video: real local *os.File passes zero-copy ProbeLocal submit preflight with 0 Go-level bytes read.
	clip := upscaleClip(t, 64, 48, true)
	clipPath := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(clipPath, clip, 0o600); err != nil {
		t.Fatal(err)
	}
	runtime.Resources = guardedFileResources{
		fileUpscaleResources: fileUpscaleResources{path: clipPath, kind: "video", size: int64(len(clip))},
		t:                    t,
		maxRead:              0,
	}
	vidInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-proteus"},
		Upscale:         &UpscaleOptions{Factor: 4},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	preparedVid, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), vidInput)
	if err != nil || preparedVid.ReferenceVideos[0].Width != 64 || preparedVid.ReferenceVideos[0].Height != 48 || preparedVid.ReferenceVideos[0].DurationMs <= 0 {
		t.Fatalf("local file video submit preflight failed: prepared=%#v err=%v", preparedVid, err)
	}
	// Subtitle erase preflight also stays strictly zero-copy (0 bytes read into RAM).
	eraseInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	if _, err := prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput); err != nil {
		t.Fatalf("subtitle erase zero-copy preflight failed: %v", err)
	}
}

func TestEstimateAndSubmitParityOnNonLocalSourcesAndHydrateVideoRefErrors(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var estimateCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		estimateCalls.Add(1)
		var reqBody map[string]any
		_ = json.NewDecoder(r.Body).Decode(&reqBody)
		modelName, _ := reqBody["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(UpscaleEstimate{Model: modelName, Currency: "CNY", Reservation: 1.5})
	}))
	defer server.Close()

	// 1. Non-local metadata-only estimate succeeds for ready video & ready image.
	nonLocalVid := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4", Size: 10 << 20, Width: 1280, Height: 720, DurationMs: 5000},
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = nonLocalVid
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	vidInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-proteus", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	if quote, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), vidInput); err != nil || quote.Reservation != 1.5 {
		t.Fatalf("non-local video metadata estimate failed: quote=%#v err=%v", quote, err)
	}
	nonLocalImg := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "image", MimeType: "image/png", Size: 2048, Width: 1024, Height: 768},
	}
	runtime.Resources = nonLocalImg
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-standard-v2", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source"}},
	}
	if quote, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), imgInput); err != nil || quote.Reservation != 1.5 {
		t.Fatalf("non-local image metadata estimate failed: quote=%#v err=%v", quote, err)
	}

	// 2. Estimate and submit both reject unsupported MKV container and 0-byte records.
	callsBefore := estimateCalls.Load()
	mkvRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/x-matroska", Size: 10 << 20, Width: 1280, Height: 720, DurationMs: 5000},
		data: []byte("mkv-bytes"),
	}
	mkvRes.opens.Store(1)
	runtime.Resources = mkvRes
	if _, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), vidInput); err == nil || !bytes.Contains([]byte(ClassifyError(err).UserMessage()), []byte("MP4 或 MOV")) {
		t.Fatalf("estimate must reject unsupported MKV container: %v", err)
	}
	if _, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), vidInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("MP4 或 MOV")) {
		t.Fatalf("submit must reject unsupported MKV container: %v", err)
	}
	zeroRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4", Size: 0, Width: 1280, Height: 720, DurationMs: 5000},
	}
	zeroRes.opens.Store(1)
	runtime.Resources = zeroRes
	if _, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), vidInput); err == nil || !bytes.Contains([]byte(ClassifyError(err).UserMessage()), []byte("参考素材为空")) {
		t.Fatalf("estimate must reject 0-byte record: %v", err)
	}
	if _, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), vidInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("参考素材为空")) {
		t.Fatalf("submit must reject 0-byte record: %v", err)
	}
	if estimateCalls.Load() != callsBefore {
		t.Fatalf("rejected estimates made %d upstream requests", estimateCalls.Load()-callsBefore)
	}

	// 3. HydrateVideoReferenceMetadata emits typed errors that survive ClassifyError.
	notReadyRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "uploading", Kind: "video", MimeType: "video/mp4"},
	}
	runtime.Resources = notReadyRes
	refInput := Input{ReferenceVideos: []Media{{StorageKey: "resource:source"}}}
	if err := HydrateVideoReferenceMetadata(WithRuntime(context.Background(), runtime), "user-1", &refInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("尚未上传完成")) {
		t.Fatalf("HydrateVideoReferenceMetadata not-ready error became generic: %v", err)
	}
	missingMetaRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4"},
	}
	runtime.Resources = missingMetaRes
	if err := HydrateVideoReferenceMetadata(WithRuntime(context.Background(), runtime), "user-1", &refInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("缺少时长或尺寸")) {
		t.Fatalf("HydrateVideoReferenceMetadata missing-metadata error became generic: %v", err)
	}
}

type failingFirstOpenImageResources struct {
	ResourcePort
	info  ResourceInfo
	data  []byte
	opens atomic.Int32
}

func (p *failingFirstOpenImageResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != p.info.UserID || id != p.info.ID {
		return ResourceInfo{}, errors.New("resource not owned")
	}
	return p.info, nil
}
func (p *failingFirstOpenImageResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	if err != nil {
		return info, nil, err
	}
	if p.opens.Add(1) == 1 {
		return info, nil, errors.New("temporary open failure")
	}
	return info, io.NopCloser(bytes.NewReader(p.data)), nil
}
func (p *failingFirstOpenImageResources) LocalMode() bool { return false }

func TestEstimateUpscaleClassifiesUpstreamMediaHTTPErrorAndPreservesRequestID(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req-upscale-est-1")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"code":"invalid_upscale_source","message":"video input must be a readable public MP4/MOV of at most five minutes and 200 MiB"}}`)
	}))
	defer server.Close()
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = upscaleResources{kind: "video", data: []byte("meta-only")}
	})
	input := Input{
		Mode:            "video",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-proteus", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), input)
	if err == nil {
		t.Fatal("expected HTTP 400 error from estimate")
	}
	classified := ClassifyError(err)
	if classified.Category != CategoryInvalidParams || classified.Reason != "超分视频素材不符合要求" || classified.RequestID != "req-upscale-est-1" {
		t.Fatalf("upstream estimate error misclassified or lost request ID: %#v", classified)
	}
}

func TestLiveUpscaleCapabilitiesPropagatesUserIDToRuntime(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"supported_models":[{"id":"topaz-proteus","label":"Topaz Proteus","media_type":"video","mode":"precision"}],"max_video_seconds":300}`)
	}))
	defer server.Close()
	var seen CallMeta
	ctx := WithCallMeta(context.Background(), CallMeta{UserID: "user-cap-1"})
	_ = LiveUpscaleCapabilities(ctx, func() (string, string, string, string, error) {
		return "synthetic-key", server.URL, "", "", nil
	}, func(ctx context.Context, meta CallMeta) context.Context {
		seen = meta
		return WithRuntime(ctx, taskRuntime(func(r *Runtime) { r.Call = meta }))
	})
	if seen.UserID != "user-cap-1" || seen.RequestKind != "capabilities" {
		t.Fatalf("capabilities lost user identity in CallMeta: %#v", seen)
	}
}

func TestUpscaleCreateAndHydrateTypedErrorsAndCaseInsensitiveMIME(t *testing.T) {
	// 1. Known oversized video on create path yields typed CategoryInputTooLarge instead of generic copy.
	oversizeRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4", Size: (200 << 20) + 1, Width: 1920, Height: 1080, DurationMs: 10000},
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = oversizeRes
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	input := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-proteus"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), input)
	classified := ClassifyError(RequestPreparationError{Cause: err})
	if classified.Category != CategoryInputTooLarge || !bytes.Contains([]byte(classified.UserMessage()), []byte("200MB")) {
		t.Fatalf("oversized create video lost typed size error: %#v", classified)
	}
	// Same for subtitle erase create path.
	eraseInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_, eraseErr := prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	eraseClassified := ClassifyError(RequestPreparationError{Cause: eraseErr})
	if eraseClassified.Category != CategoryInputTooLarge || !bytes.Contains([]byte(eraseClassified.UserMessage()), []byte("200MB")) {
		t.Fatalf("oversized subtitle erase video lost typed size error: %#v", eraseClassified)
	}

	// 2. HydrateMedia authored not-ready error survives through ClassifyError.
	notReadyRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "uploading", Kind: "video", MimeType: "video/mp4"},
	}
	runtime.Resources = notReadyRes
	_, err = prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), input)
	classified = ClassifyError(RequestPreparationError{Cause: err})
	if classified.Category != CategoryInputInaccessible || !bytes.Contains([]byte(classified.UserMessage()), []byte("尚未上传完成")) {
		t.Fatalf("HydrateMedia not-ready error became generic: %#v", classified)
	}

	// 3. Uppercase declared MIME ("IMAGE/PNG") passes full-byte image preflight cleanly.
	pngBytes := upscalePNG(t, 64, 48)
	upperRes := &failingFirstOpenImageResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "image", MimeType: "IMAGE/PNG", Size: int64(len(pngBytes)), Width: 64, Height: 48},
		data: pngBytes,
	}
	upperRes.opens.Store(1) // skip the synthetic first-open failure
	runtime.Resources = upperRes
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-standard-v2"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source"}},
	}
	if _, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), imgInput); err != nil {
		t.Fatalf("uppercase IMAGE/PNG rejected on full-byte preflight: %v", err)
	}
}
