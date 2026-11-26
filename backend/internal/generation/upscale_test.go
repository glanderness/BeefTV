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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/protocol"
	"infinite-canvas/backend/internal/topaz"
)

func newLocalUpscaleResources(t *testing.T, kind string, data []byte) fileUpscaleResources {
	t.Helper()
	ext := ".png"
	if kind == "video" {
		ext = ".mp4"
	}
	path := filepath.Join(t.TempDir(), "source"+ext)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return fileUpscaleResources{path: path, kind: kind, size: int64(len(data)), width: 64, height: 48, durationMs: 1000}
}

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
				r.Resources = newLocalUpscaleResources(t, kind, source)
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
	for _, factor := range []float64{0, 1.5, 5} {
		changed := input
		changed.Upscale = &UpscaleOptions{Factor: factor}
		if ValidateUpscaleInput(changed) == nil {
			t.Fatal("invalid factor accepted")
		}
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "foreign"
		r.Resources = newLocalUpscaleResources(t, "image", upscalePNG(t, 64, 48))
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
	if _, err := beeftv.LegacyUpscaleTaskPath("../escape"); err == nil {
		t.Fatal("unsafe id accepted")
	}
}

func upscaleTempFile(dir, name string, data []byte) (string, error) {
	path := filepath.Join(dir, name)
	return path, os.WriteFile(path, data, 0600)
}

func preserveUpscaleAudioForTest(ctx context.Context, source, output []byte) ([]byte, error) {
	dir, err := os.MkdirTemp("", "beeftv-upscale-audio-test-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	sourceName, outputName := "source.mp4", "upscaled.mp4"
	if NormalizedMediaMIMEType("", source) == "video/quicktime" {
		sourceName = "source.mov"
	}
	if NormalizedMediaMIMEType("", output) == "video/quicktime" {
		outputName = "upscaled.mov"
	}
	sourcePath, err := upscaleTempFile(dir, sourceName, source)
	if err != nil {
		return nil, err
	}
	outputPath, err := upscaleTempFile(dir, outputName, output)
	if err != nil {
		return nil, err
	}
	resultPath, cleanup, err := PreserveUpscaleAudioFile(ctx, sourcePath, outputPath)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	if resultPath == outputPath {
		return output, nil
	}
	return os.ReadFile(resultPath)
}

func TestUpscalePreservesExistingAudioBytes(t *testing.T) {
	data := upscaleClip(t, 64, 48, true)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := preserveUpscaleAudioForTest(ctx, data, data)
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
	result, err := preserveUpscaleAudioForTest(context.Background(), source, output)
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
		r.Resources = newLocalUpscaleResources(t, "image", upscalePNG(t, 64, 48))
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
	if w, h, mime, err := probeImageHeader(bytes.NewReader(data)); err != nil || w != 1 || h != 1 || mime != "image/webp" {
		t.Fatalf("valid WebP rejected: %dx%d %q %v", w, h, mime, err)
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
	w, h, mime, err := probeImageHeader(bytes.NewReader(header))
	if err == nil && validateUpscaleImagePreflight(mime, w, h, 2, 1<<40) == nil {
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
	facts, err := mediatools.ProbeLocal(context.Background(), path)
	if err != nil {
		t.Fatalf("ProbeLocal failed: %v", err)
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

func (b configurableBudget) GeneratedFileBytes(context.Context) (int64, error)  { return b.limit, nil }
func (b configurableBudget) ResourceUploadBytes(context.Context) (int64, error) { return b.limit, nil }
func (configurableBudget) CircuitOpen(context.Context, string) (bool, error)    { return false, nil }
func (configurableBudget) AcquireChannelSlot(context.Context, string, string, time.Duration) (func(), int, error) {
	return func() {}, 4, nil
}
func (configurableBudget) RecordChannelResult(context.Context, string, bool) error { return nil }

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
		r.Resources = newLocalUpscaleResources(t, "video", clip)
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

	// 2. Unreadable local image fails cleanly without silently uploading to COS.
	corruptImage := filepath.Join(missingDir, "corrupt.png")
	if err := os.WriteFile(corruptImage, []byte("not-a-valid-image"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime.Resources = fileUpscaleResources{path: corruptImage, kind: "image", size: 17, width: 64, height: 48}
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-standard-v2", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source"}},
	}
	_, _, err = EstimateUpscale(WithRuntime(context.Background(), runtime), imgInput)
	classified = ClassifyError(err)
	if err == nil || classified.Category != CategoryInvalidParams || !bytes.Contains([]byte(classified.UserMessage()), []byte("图片无法读取或格式不受支持")) {
		t.Fatalf("unreadable image must fail cleanly without COS upload: err=%v classified=%#v", err, classified)
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

type lookupOnlyResources struct {
	ResourcePort
	info ResourceInfo
}

func (p lookupOnlyResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != p.info.UserID || id != p.info.ID {
		return ResourceInfo{}, errors.New("resource not owned")
	}
	return p.info, nil
}
func (p lookupOnlyResources) LocalMode() bool { return true }

func TestEstimateAndSubmitParityAndHydrateVideoRefErrors(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var estimateCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		estimateCalls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	dir := t.TempDir()
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	vidInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: server.URL, APIKey: "synthetic-key", Model: "topaz-proteus", InterfaceType: "newapi"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}

	// 1. Estimate and submit both reject 0-byte local files with 0 upstream requests.
	zeroPath := writeSparseTestFile(t, dir, "empty.mp4", 0)
	runtime.Resources = fileUpscaleResources{path: zeroPath, kind: "video", width: 1280, height: 720, durationMs: 5000}
	if _, _, err := EstimateUpscale(WithRuntime(context.Background(), runtime), vidInput); err == nil || !bytes.Contains([]byte(ClassifyError(err).UserMessage()), []byte("参考素材为空")) {
		t.Fatalf("estimate must reject 0-byte record: %v", err)
	}
	if _, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), vidInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("参考素材为空")) {
		t.Fatalf("submit must reject 0-byte record: %v", err)
	}
	if estimateCalls.Load() != 0 {
		t.Fatalf("rejected estimates made %d upstream requests", estimateCalls.Load())
	}

	// 2. HydrateVideoReferenceMetadata emits typed errors that survive ClassifyError.
	runtime.Resources = lookupOnlyResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "uploading", Kind: "video", MimeType: "video/mp4"},
	}
	refInput := Input{ReferenceVideos: []Media{{StorageKey: "resource:source"}}}
	if err := HydrateVideoReferenceMetadata(WithRuntime(context.Background(), runtime), "user-1", &refInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("尚未上传完成")) {
		t.Fatalf("HydrateVideoReferenceMetadata not-ready error became generic: %v", err)
	}
	runtime.Resources = lookupOnlyResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4"},
	}
	if err := HydrateVideoReferenceMetadata(WithRuntime(context.Background(), runtime), "user-1", &refInput); err == nil || !bytes.Contains([]byte(ClassifyError(RequestPreparationError{Cause: err}).UserMessage()), []byte("缺少时长或尺寸")) {
		t.Fatalf("HydrateVideoReferenceMetadata missing-metadata error became generic: %v", err)
	}
}

func TestEstimateUpscaleClassifiesUpstreamMediaHTTPErrorAndPreservesRequestID(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req-upscale-est-1")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"code":"invalid_upscale_source","message":"video input must be a readable public MP4/MOV of at most five minutes and 200 MiB"}}`)
	}))
	defer server.Close()
	clip := upscaleClip(t, 64, 48, false)
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = newLocalUpscaleResources(t, "video", clip)
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
	var capsPayload string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, capsPayload)
	}))
	defer server.Close()
	var seen CallMeta
	ctx := WithCallMeta(context.Background(), CallMeta{UserID: "user-cap-1"})
	lookup := func() (string, string, string, string, error) {
		return "synthetic-key", server.URL, "", "", nil
	}
	bind := func(ctx context.Context, meta CallMeta) context.Context {
		seen = meta
		return WithRuntime(ctx, taskRuntime(func(r *Runtime) { r.Call = meta }))
	}

	// Legacy upstream without max_video_bytes advertises 200 MiB fallback so client fails fast before uploading >200 MiB.
	capsPayload = `{"supported_models":[{"id":"topaz-proteus","label":"Topaz Proteus","media_type":"video","mode":"precision"}],"max_video_seconds":300}`
	legacyCaps := LiveUpscaleCapabilities(ctx, lookup, bind)
	if seen.UserID != "user-cap-1" || seen.RequestKind != "capabilities" {
		t.Fatalf("capabilities lost user identity in CallMeta: %#v", seen)
	}
	if legacyCaps["maxVideoBytes"] != BeefTVSeedanceVideoMaxBytes {
		t.Fatalf("legacy maxVideoBytes = %#v, want %d", legacyCaps["maxVideoBytes"], BeefTVSeedanceVideoMaxBytes)
	}

	// Upgraded upstream advertises 1 GiB max_video_bytes.
	capsPayload = `{"supported_models":[{"id":"topaz-proteus","label":"Topaz Proteus","media_type":"video","mode":"precision"}],"max_video_seconds":300,"max_video_bytes":1073741824}`
	newCaps := LiveUpscaleCapabilities(ctx, lookup, bind)
	if newCaps["maxVideoBytes"] != BeefTVMediaToolVideoMaxBytes {
		t.Fatalf("upgraded maxVideoBytes = %#v, want %d", newCaps["maxVideoBytes"], BeefTVMediaToolVideoMaxBytes)
	}

	// When capabilities endpoint is unavailable, safely fall back to 200 MiB rather than assuming 1 GiB.
	unavailCaps := LiveUpscaleCapabilities(ctx, nil, bind)
	if unavailCaps["maxVideoBytes"] != BeefTVSeedanceVideoMaxBytes {
		t.Fatalf("unavailable maxVideoBytes = %#v, want safe fallback %d", unavailCaps["maxVideoBytes"], BeefTVSeedanceVideoMaxBytes)
	}
}

func TestUpscaleCreateAndHydrateTypedErrorsAndCaseInsensitiveMIME(t *testing.T) {
	dir := t.TempDir()
	// 1. Oversized video (>1 GiB) on create path yields typed CategoryInputTooLarge instead of generic copy.
	over1GiBPath := writeSparseTestFile(t, dir, "over1g.mp4", BeefTVMediaToolVideoMaxBytes+1)
	oversizeRes := fileUpscaleResources{path: over1GiBPath, kind: "video", size: BeefTVMediaToolVideoMaxBytes + 1, width: 1920, height: 1080, durationMs: 10000}
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = oversizeRes
		r.Limits = configurableBudget{limit: 2048 << 20}
	})
	input := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-proteus"},
		Upscale:         &UpscaleOptions{Factor: 2, MaxVideoBytes: BeefTVMediaToolVideoMaxBytes},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), input)
	classified := ClassifyError(RequestPreparationError{Cause: err})
	if classified.Category != CategoryInputTooLarge || !bytes.Contains([]byte(classified.UserMessage()), []byte("1GB")) {
		t.Fatalf("oversized create video lost typed size error: %#v", classified)
	}
	// Legacy/unverified server cap (MaxVideoBytes == 0 -> safe 200 MiB fallback) rejects >200 MiB with typed 200MB error.
	over200MiBPath := writeSparseTestFile(t, dir, "over200m.mp4", BeefTVSeedanceVideoMaxBytes+1)
	runtime.Resources = fileUpscaleResources{path: over200MiBPath, kind: "video", size: BeefTVSeedanceVideoMaxBytes + 1, width: 1920, height: 1080, durationMs: 10000}
	legacyInput := input
	legacyInput.Upscale = &UpscaleOptions{Factor: 2}
	_, err = prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), legacyInput)
	classified = ClassifyError(RequestPreparationError{Cause: err})
	if classified.Category != CategoryInputTooLarge || !bytes.Contains([]byte(classified.UserMessage()), []byte("200MB")) {
		t.Fatalf("legacy/unverified 200 MiB create video lost typed size error: %#v", classified)
	}
	// Same for subtitle erase create path (>1 GiB when server advertised 1 GiB).
	runtime.Resources = oversizeRes
	eraseInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard", MaxVideoBytes: BeefTVMediaToolVideoMaxBytes},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_, eraseErr := prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	eraseClassified := ClassifyError(RequestPreparationError{Cause: eraseErr})
	if eraseClassified.Category != CategoryInputTooLarge || !bytes.Contains([]byte(eraseClassified.UserMessage()), []byte("1GB")) {
		t.Fatalf("oversized subtitle erase video lost typed size error: %#v", eraseClassified)
	}

	// 2. HydrateMedia authored not-ready error survives through ClassifyError.
	runtime.Resources = lookupOnlyResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "uploading", Kind: "video", MimeType: "video/mp4"},
	}
	_, err = prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), input)
	classified = ClassifyError(RequestPreparationError{Cause: err})
	if classified.Category != CategoryInputInaccessible || !bytes.Contains([]byte(classified.UserMessage()), []byte("尚未上传完成")) {
		t.Fatalf("HydrateMedia not-ready error became generic: %#v", classified)
	}

	// 3. Uppercase declared MIME ("IMAGE/PNG") passes local image preflight cleanly.
	runtime.Resources = newLocalUpscaleResources(t, "image", upscalePNG(t, 64, 48))
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-standard-v2"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source", MimeType: "IMAGE/PNG"}},
	}
	if _, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), runtime), imgInput); err != nil {
		t.Fatalf("uppercase IMAGE/PNG rejected on local preflight: %v", err)
	}
}

type noopManagedMediaState struct{}

func (noopManagedMediaState) Sent(context.Context) (bool, error) { return false, nil }
func (noopManagedMediaState) Begin(*http.Request) (bool, error)  { return false, nil }

type recordingVideoFileStore struct {
	fileUpscaleResources
	savedDir  string
	savedID   string
	savedPath string
	savedInfo ResourceInfo
	calls     int
}

func (s *recordingVideoFileStore) PersistGeneratedVideoFile(userID, identity, mimeType, filePath string, width, height int, durationMs int64) (ResourceInfo, error) {
	s.calls++
	data, err := os.ReadFile(filePath)
	if err != nil {
		return ResourceInfo{}, err
	}
	dest := filepath.Join(s.savedDir, "persisted-"+s.savedID+".mp4")
	if err := os.WriteFile(dest, data, 0o600); err != nil {
		return ResourceInfo{}, err
	}
	s.savedPath = dest
	s.savedInfo = ResourceInfo{
		UserID:     userID,
		ID:         s.savedID,
		Status:     "ready",
		Kind:       "video",
		MimeType:   mimeType,
		Size:       int64(len(data)),
		Width:      width,
		Height:     height,
		DurationMs: durationMs,
	}
	return s.savedInfo, nil
}

func TestManagedUpscaleAndSubtitleEraseSendMediaToolPurposeAndAllowOver200MiB(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	// Build a sparse 205 MiB local MP4 (valid 1s MP4 extended via Truncate) so
	// ffprobe succeeds and UploadReference hashes & submits >200 MiB end-to-end.
	validMP4 := upscaleClip(t, 64, 48, true)
	bigPath := filepath.Join(t.TempDir(), "over200mb.mp4")
	if err := os.WriteFile(bigPath, validMP4, 0o600); err != nil {
		t.Fatal(err)
	}
	const over200Size = int64(205 << 20)
	if err := os.Truncate(bigPath, over200Size); err != nil {
		t.Fatal(err)
	}

	var seenMu sync.Mutex
	var seenReqs []beeftv.UploadRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set(beeftv.MediaProtocolHeader, beeftv.MediaProtocolVersion)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"media_protocol": map[string]any{
					"version":                 beeftv.MediaProtocolVersion,
					"supported_media_types":   []string{"upscale", "video"},
					"task_submit_url":         "/v1/media/tasks",
					"task_query_url_template": "/v1/media/tasks/{task_ref}",
					"uploads_url":             "/v1/media/uploads",
				},
				"data": []map[string]any{
					{
						"id":                         "topaz-proteus",
						"media_capabilities_version": "v1",
						"media_capabilities": map[string]any{
							"upscale": map[string]any{
								"operations":      []string{"upscale"},
								"reference_kinds": []string{"video"},
								"options":         []string{"upscale_factor", "H264_output"},
								"max_outputs":     1,
							},
						},
					},
					{
						"id":                         SubtitleEraseModelName,
						"media_capabilities_version": "v1",
						"media_capabilities": map[string]any{
							"video": map[string]any{
								"operations":      []string{"subtitle_erase"},
								"reference_kinds": []string{"video"},
								"max_outputs":     1,
							},
						},
					},
				},
			})
		case "/v1/media/uploads":
			var req beeftv.UploadRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				seenMu.Lock()
				seenReqs = append(seenReqs, req)
				seenMu.Unlock()
			}
			// Return a terminal sentinel after recording CreateUpload so the test
			// proves preflight + UploadReference passed >200 MiB and sent purpose.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"code":"test_sentinel","message":"upload_reached"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = srv.URL
		r.Call.UserID = "user-1"
		r.ManagedMedia = noopManagedMediaState{}
		r.Limits = configurableBudget{limit: 2048 << 20}
		r.Resources = fileUpscaleResources{path: bigPath, kind: "video", size: over200Size, width: 64, height: 48, durationMs: 1000}
	})
	ctx := WithSubmissionKey(WithRuntime(context.Background(), runtime), "sub-over200-1")

	// 1. Managed upscale with MaxVideoBytes=1 GiB passes >200 MiB to /v1/media/uploads with purpose="media_tool".
	upscaleInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: srv.URL, APIKey: "synthetic", Model: "topaz-proteus", CredentialRef: beeftv.CredentialRef},
		Upscale:         &UpscaleOptions{Factor: 2, MaxVideoBytes: BeefTVMediaToolVideoMaxBytes},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	upscaleClient := managedMediaClient(ctx, upscaleInput.Config)
	_, err := runManagedUpscaleTask(ctx, upscaleClient, upscaleInput)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("upload_reached")) {
		t.Fatalf("managed upscale >200 MiB did not reach CreateUpload: err=%v", err)
	}

	// 2. Managed subtitle erase with MaxVideoBytes=1 GiB also passes >200 MiB with purpose="media_tool".
	eraseInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: srv.URL, APIKey: "synthetic", Model: SubtitleEraseModelName, CredentialRef: beeftv.CredentialRef},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard", MaxVideoBytes: BeefTVMediaToolVideoMaxBytes},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	eraseClient := managedMediaClient(ctx, eraseInput.Config)
	_, err = runManagedSubtitleEraseTask(ctx, eraseClient, eraseInput, "subtitle_erase")
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("upload_reached")) {
		t.Fatalf("managed subtitle erase >200 MiB did not reach CreateUpload: err=%v", err)
	}

	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seenReqs) != 2 {
		t.Fatalf("expected 2 CreateUpload requests, got %d", len(seenReqs))
	}
	for i, req := range seenReqs {
		if req.Kind != "video" || req.Purpose != beeftv.UploadPurposeMediaTool || req.Bytes != over200Size {
			t.Fatalf("request[%d] = %+v, want kind=video purpose=%q bytes=%d", i, req, beeftv.UploadPurposeMediaTool, over200Size)
		}
	}

	// 3. SubtitleEraseCapabilities unavailable & ValidateSmartEraseRequestCapabilities unloaded both fall back safely to 200 MiB.
	unavailEraseCaps := SubtitleEraseCapabilities(context.Background(), nil, nil)
	if unavailEraseCaps["maxVideoBytes"] != BeefTVSeedanceVideoMaxBytes {
		t.Fatalf("unavailable erase maxVideoBytes = %#v, want %d", unavailEraseCaps["maxVideoBytes"], BeefTVSeedanceVideoMaxBytes)
	}
	reqUnloaded := SubtitleEraseRequest{EraseType: "subtitle"}
	if err := ValidateSmartEraseRequestCapabilities(&reqUnloaded, unavailEraseCaps); err != nil {
		t.Fatalf("ValidateSmartEraseRequestCapabilities(unloaded) err=%v", err)
	}
	if reqUnloaded.MaxVideoBytes != BeefTVSeedanceVideoMaxBytes {
		t.Fatalf("unloaded req.MaxVideoBytes = %d, want safe fallback %d", reqUnloaded.MaxVideoBytes, BeefTVSeedanceVideoMaxBytes)
	}
}

func TestLegacyToolVideoResultPersistsToFileStoreWithoutBase64(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	sourceWithAudio := upscaleClip(t, 64, 48, true)
	mutedOutput := upscaleClip(t, 64, 48, false)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/media-upscale/tasks/up_file_1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "up_file_1", "status": "completed", "model": "topaz-proteus", "media_type": "video"})
		case "/v1/media-upscale/tasks/up_file_1/content":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(mutedOutput)
		case "/v1/video-subtitle-erase/tasks/er_file_1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"task_id": "er_file_1", "status": "completed", "model": SubtitleEraseModelName, "media_type": "video"})
		case "/v1/video-subtitle-erase/tasks/er_file_1/content":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(mutedOutput)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	store := &recordingVideoFileStore{
		fileUpscaleResources: newLocalUpscaleResources(t, "video", sourceWithAudio),
		savedDir:             t.TempDir(),
		savedID:              "res-up-1",
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = srv.URL
		r.Call.UserID = "user-1"
		r.Call.TaskID = "local-task-1"
		r.Resources = store
	})
	ctx := WithRuntime(context.Background(), runtime)

	upRes, status, err := QueryUpscaleResult(ctx, Input{
		Mode:            "video",
		Config:          Config{BaseURL: srv.URL, APIKey: "synthetic", Model: "topaz-proteus"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}, "up_file_1")
	if err != nil || status != "completed" {
		t.Fatalf("QueryUpscaleResult err=%v status=%q", err, status)
	}
	encodedUp, err := json.Marshal(upRes)
	if err != nil || len(encodedUp) > 1024 || bytes.Contains(encodedUp, []byte("data:video/")) {
		t.Fatalf("legacy upscale ResultJSON should be compact resource metadata without base64, got %d bytes: %s", len(encodedUp), encodedUp)
	}
	if store.calls != 1 {
		t.Fatalf("expected 1 PersistGeneratedVideoFile call, got %d", store.calls)
	}
	facts, err := mediatools.ProbeLocal(context.Background(), store.savedPath)
	if err != nil || !facts.HasVideo || !facts.HasAudio {
		t.Fatalf("persisted upscale video missing restored audio: facts=%+v err=%v", facts, err)
	}

	store.savedID = "res-er-1"
	erRes, status, err := QuerySubtitleEraseResult(ctx, Input{
		Mode:            "video",
		Config:          Config{BaseURL: srv.URL, APIKey: "synthetic", Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}, "er_file_1")
	if err != nil || status != "completed" {
		t.Fatalf("QuerySubtitleEraseResult err=%v status=%q", err, status)
	}
	encodedEr, err := json.Marshal(erRes)
	if err != nil || len(encodedEr) > 1024 || bytes.Contains(encodedEr, []byte("data:video/")) {
		t.Fatalf("legacy subtitle-erase ResultJSON should be compact resource metadata without base64, got %d bytes: %s", len(encodedEr), encodedEr)
	}
	if store.calls != 2 {
		t.Fatalf("expected 2 PersistGeneratedVideoFile calls, got %d", store.calls)
	}
}

func TestSmartEraseCapabilitiesPropagationAndLegacyUploadPurpose(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")

	// 1. Loaded smart-erase capabilities propagate 1 GiB, omitted->200 MiB, and unavailable->200 MiB cleanly.
	for _, tc := range []struct {
		name     string
		status   int
		payload  map[string]any
		wantMax  int64
		wantLoad bool
	}{
		{
			name:   "1GiB advertised",
			status: http.StatusOK,
			payload: map[string]any{
				"enabled":           true,
				"available":         true,
				"max_video_seconds": 600,
				"max_video_bytes":   BeefTVMediaToolVideoMaxBytes,
				"available_models":  []string{SubtitleEraseModelName},
				"erase_types":       []string{"subtitle"},
				"erase_methods":     []string{"auto"},
				"subtitle_models":   []string{"standard"},
			},
			wantMax:  BeefTVMediaToolVideoMaxBytes,
			wantLoad: true,
		},
		{
			name:   "legacy omitted max_video_bytes falls back to 200MiB",
			status: http.StatusOK,
			payload: map[string]any{
				"enabled":           true,
				"available":         true,
				"max_video_seconds": 600,
				"available_models":  []string{SubtitleEraseModelName},
				"erase_types":       []string{"subtitle"},
				"erase_methods":     []string{"auto"},
				"subtitle_models":   []string{"standard"},
			},
			wantMax:  BeefTVSeedanceVideoMaxBytes,
			wantLoad: true,
		},
		{
			name:     "server unavailable falls back to 200MiB",
			status:   http.StatusServiceUnavailable,
			wantMax:  BeefTVSeedanceVideoMaxBytes,
			wantLoad: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/video-smart-erase/capabilities" {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(tc.status)
					if tc.payload != nil {
						_ = json.NewEncoder(w).Encode(tc.payload)
					}
					return
				}
				http.NotFound(w, r)
			}))
			defer srv.Close()

			lookup := func() (string, string, string, string, error) { return "synthetic", srv.URL, "newapi", "", nil }
			caps := SubtitleEraseCapabilities(context.Background(), lookup, nil)
			if gotLoaded, _ := caps["capabilitiesLoaded"].(bool); gotLoaded != tc.wantLoad {
				t.Fatalf("capabilitiesLoaded = %v, want %v", gotLoaded, tc.wantLoad)
			}
			if gotMax, _ := caps["maxVideoBytes"].(int64); gotMax != tc.wantMax {
				t.Fatalf("caps[maxVideoBytes] = %#v, want %d", caps["maxVideoBytes"], tc.wantMax)
			}
			req := SubtitleEraseRequest{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard"}
			if err := ValidateSmartEraseRequestCapabilities(&req, caps); err != nil {
				t.Fatalf("ValidateSmartEraseRequestCapabilities err=%v", err)
			}
			if req.MaxVideoBytes != tc.wantMax {
				t.Fatalf("mutated req.MaxVideoBytes = %d, want %d", req.MaxVideoBytes, tc.wantMax)
			}
		})
	}

	// 2. Legacy PrepareBeefTVVideoReferences sends purpose="media_tool" for tool videos
	//    and omits purpose for ordinary generative reference videos.
	var seenMu sync.Mutex
	var seenReqs []beeftv.UploadRequest
	uploadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && (r.URL.Path == "/v1/video-references/uploads" || r.URL.Path == "/v1/media/uploads") {
			var req beeftv.UploadRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			seenMu.Lock()
			seenReqs = append(seenReqs, req)
			seenMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"code":"test_sentinel","message":"legacy_upload_reached"}}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer uploadSrv.Close()

	clip := upscaleClip(t, 64, 48, false)
	clipPath := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(clipPath, clip, 0o600); err != nil {
		t.Fatal(err)
	}
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = uploadSrv.URL
		r.Call.UserID = "user-1"
		r.Limits = configurableBudget{limit: 2048 << 20}
		r.Resources = fileUpscaleResources{path: clipPath, kind: "video", size: int64(len(clip)), width: 64, height: 48, durationMs: 1000}
	})
	ctx := WithRuntime(context.Background(), runtime)

	toolInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: uploadSrv.URL, APIKey: "synthetic", Model: "topaz-proteus", CredentialRef: beeftv.CredentialRef},
		Upscale:         &UpscaleOptions{Factor: 2, MaxVideoBytes: BeefTVMediaToolVideoMaxBytes},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_ = PrepareBeefTVVideoReferences(ctx, toolInput.Config, &toolInput, nil)

	ordinaryInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: uploadSrv.URL, APIKey: "synthetic", Model: "seedance-2.0", CredentialRef: beeftv.CredentialRef},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}
	_ = PrepareBeefTVVideoReferences(ctx, ordinaryInput.Config, &ordinaryInput, nil)

	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seenReqs) != 2 {
		t.Fatalf("expected 2 legacy UploadRequests, got %d", len(seenReqs))
	}
	if seenReqs[0].Purpose != beeftv.UploadPurposeMediaTool {
		t.Fatalf("tool video legacy upload purpose = %q, want %q", seenReqs[0].Purpose, beeftv.UploadPurposeMediaTool)
	}
	if seenReqs[1].Purpose != "" {
		t.Fatalf("ordinary video reference upload purpose = %q, want empty", seenReqs[1].Purpose)
	}

	// 3. NormalizeToolVideoLimit enforces the single 200 MiB default / 1 GiB clamp contract.
	if got := NormalizeToolVideoLimit(0); got != BeefTVSeedanceVideoMaxBytes {
		t.Fatalf("NormalizeToolVideoLimit(0) = %d, want %d", got, BeefTVSeedanceVideoMaxBytes)
	}
	if got := NormalizeToolVideoLimit(5 * BeefTVMediaToolVideoMaxBytes); got != BeefTVMediaToolVideoMaxBytes {
		t.Fatalf("NormalizeToolVideoLimit(5GiB) = %d, want %d", got, BeefTVMediaToolVideoMaxBytes)
	}
}

type stubVideoResultAdapter struct {
	resultPath string
}

func (a stubVideoResultAdapter) Metadata() protocol.Metadata {
	return protocol.Metadata{ID: "stub-video"}
}
func (a stubVideoResultAdapter) BuildCreate(context.Context, protocol.RequestContext) (protocol.RequestSpec, error) {
	return protocol.RequestSpec{}, nil
}
func (a stubVideoResultAdapter) ParseCreate(context.Context, []byte) (protocol.CreateResult, error) {
	return protocol.CreateResult{}, nil
}
func (a stubVideoResultAdapter) BuildPoll(context.Context, protocol.PollContext) (protocol.RequestSpec, error) {
	return protocol.RequestSpec{}, nil
}
func (a stubVideoResultAdapter) ParsePoll(context.Context, protocol.PollContext, []byte) (protocol.PollResult, error) {
	return protocol.PollResult{}, nil
}
func (a stubVideoResultAdapter) BuildCancel(context.Context, protocol.PollContext) (protocol.RequestSpec, error) {
	return protocol.RequestSpec{}, nil
}
func (a stubVideoResultAdapter) ResultAvailable() bool { return true }
func (a stubVideoResultAdapter) BuildResult(_ context.Context, _ protocol.PollContext) (protocol.RequestSpec, error) {
	return protocol.RequestSpec{Method: http.MethodGet, Path: a.resultPath}, nil
}

type stubPersistVideoResources struct {
	ResourcePort
	persistErr error
	savedPath  string
	savedSize  int64
}

func (s *stubPersistVideoResources) PersistGeneratedVideoFile(_, _, mimeType, filePath string, width, height int, durationMs int64) (ResourceInfo, error) {
	if s.persistErr != nil {
		return ResourceInfo{}, s.persistErr
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return ResourceInfo{}, err
	}
	s.savedPath = filePath
	s.savedSize = info.Size()
	return ResourceInfo{
		ID:         "res-streamed-video",
		Kind:       "video",
		MimeType:   mimeType,
		Size:       info.Size(),
		Width:      width,
		Height:     height,
		DurationMs: durationMs,
	}, nil
}

func TestProtocolResultAdapterStreamsToFileAndPersistErrorIsNotDownloadError(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	clip := upscaleClip(t, 64, 48, false)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/result/vid-1":
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("ETag", `"proto-res-1"`)
			_, _ = w.Write(clip)
		case "/v1/media-upscale/tasks/up-persist-err":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"task_id":"up-persist-err","status":"completed","model":"topaz-proteus","media_type":"video"}`)
		case "/v1/media-upscale/tasks/up-persist-err/content":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(clip)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// 1. Declarative ResultAdapter video streams directly to file and persists without DataURL.
	okStore := &stubPersistVideoResources{}
	rt := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Call.TaskID = "task-proto-1"
		r.Resources = okStore
		r.Limits = configurableBudget{limit: 2048 << 20}
	})
	out, err := FinishProtocolAdapterResult(
		WithRuntime(context.Background(), rt),
		Input{Mode: "video", Config: Config{BaseURL: srv.URL + "/v1", APIKey: "k", Model: "full-video"}},
		stubVideoResultAdapter{resultPath: "/result/vid-1"},
		protocol.GenerationRequest{Model: "full-video"},
		"vid-1",
		&protocol.Result{},
		VideoPollPolicy{MaxDownloadTries: 1, Sleep: func(context.Context, time.Duration) error { return nil }},
	)
	if err != nil {
		t.Fatalf("FinishProtocolAdapterResult failed: %v", err)
	}
	videoMap, _ := out["video"].(map[string]any)
	if videoMap["storageKey"] != "resource:res-streamed-video" || videoMap["url"] != "/api/resources/res-streamed-video/file" {
		t.Fatalf("expected resource-backed streamed video map, got %#v", videoMap)
	}
	if _, hasDataURL := videoMap["dataUrl"]; hasDataURL {
		t.Fatalf("streamed ResultAdapter video must not include dataUrl: %#v", videoMap)
	}
	if okStore.savedSize != int64(len(clip)) {
		t.Fatalf("savedSize = %d, want %d", okStore.savedSize, len(clip))
	}

	// 2. Local persistence failure returns VideoPersistError (never VideoDownloadError) and local_storage diagnostics.
	failStore := &stubPersistVideoResources{persistErr: errors.New("no space left on device")}
	failRT := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Call.TaskID = "task-upscale-persist-fail"
		r.Endpoints.BeefTVVideoBaseURL = srv.URL
		r.Resources = failStore
		r.Limits = configurableBudget{limit: 2048 << 20}
	})
	_, status, err := QueryUpscaleResult(
		WithRuntime(context.Background(), failRT),
		Input{Mode: "video", Config: Config{BaseURL: srv.URL + "/v1", APIKey: "k", Model: "topaz-proteus"}},
		"up-persist-err",
	)
	if status != "completed" || err == nil {
		t.Fatalf("expected completed status + persist error, got status=%q err=%v", status, err)
	}
	var persistErr VideoPersistError
	if !errors.As(err, &persistErr) {
		t.Fatalf("expected VideoPersistError, got %T: %v", err, err)
	}
	var dlErr VideoDownloadError
	if errors.As(err, &dlErr) {
		t.Fatalf("local persistence error must not be wrapped in VideoDownloadError: %v", err)
	}
	if retry, _ := RetryableVideoPollError(context.Background(), err); retry {
		t.Fatal("VideoPersistError must not spin RetryableVideoPollError")
	}
	task := model.Task{ID: "task-upscale-persist-fail", ProviderRequestID: "up-persist-err"}
	CaptureTaskFailureDiagnostics(&task, err, "local_result")
	if task.FailureDiagnostics == nil || task.FailureDiagnostics.Source != "local_result" || task.FailureDiagnostics.Stage != "保存视频结果" {
		t.Fatalf("unexpected diagnostics for VideoPersistError: %+v", task.FailureDiagnostics)
	}
}

func TestVideoUpscaleTierUsesProbedDimensionsForEstimateAndSubmit(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	source := newLocalUpscaleResources(t, "video", upscaleClip(t, 880, 496, false))
	source.width, source.height, source.durationMs = 320, 180, 15000

	const modelName = "topaz-starlight-fast-2"
	var estimateBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/media-upscale/capabilities":
			_, _ = io.WriteString(w, `{"supported_models":[{"id":"topaz-starlight-fast-2","label":"Starlight Fast 2","media_type":"video","mode":"generative","billing_mode":"mps_video_seconds"}]}`)
		case "/v1/media-upscale/estimate":
			if err := json.NewDecoder(r.Body).Decode(&estimateBody); err != nil {
				t.Errorf("decode estimate body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(UpscaleEstimate{Model: modelName, Currency: "CNY", Reservation: 2.5})
		default:
			t.Errorf("unexpected request during estimate: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = source
	})
	bind := func(ctx context.Context, meta CallMeta) context.Context {
		r := runtime
		r.Call = meta
		return WithRuntime(ctx, r)
	}
	metadata := func(context.Context, string, string) (*model.Resource, error) {
		return &model.Resource{
			ID: "source", Status: model.ResourceStatusReady, Kind: "video", MimeType: "video/mp4",
			Width: source.width, Height: source.height, DurationMs: source.durationMs,
		}, nil
	}
	credentials := func() (string, string, string, string, error) {
		return "synthetic-key", server.URL, "", "", nil
	}
	request := topaz.Request{
		ResourceID: "source", ChannelID: "beeftv", Model: modelName, Mode: "generative",
		Scale: 2, TargetShortEdge: 1080, ClientOperationID: "video-upscale-tier",
	}
	quote, err := EstimateMediaUpscale(context.Background(), "user-1", request, metadata, credentials, bind)
	if err != nil {
		t.Fatal(err)
	}
	src := quote["source"].(map[string]any)
	output := quote["output"].(map[string]any)
	if src["width"] != 880 || src["height"] != 496 || src["durationMs"] != int64(1000) ||
		output["width"] != 1916 || output["height"] != 1080 {
		t.Fatalf("estimate dimensions or duration do not match the local file and selected tier: %#v", quote)
	}
	wantFactor := 1080.0 / 496
	if estimateBody["upscale_factor"] != wantFactor || estimateBody["width"] != float64(880) ||
		estimateBody["height"] != float64(496) || estimateBody["duration_seconds"] != float64(1) {
		t.Fatalf("estimate provider payload did not use the probed source and selected tier: %#v", estimateBody)
	}
	if _, hasURL := estimateBody["video_url"]; hasURL {
		t.Fatalf("estimate sent a source URL: %#v", estimateBody)
	}

	_, payload, err := BuildMediaUpscaleTaskPayload(context.Background(), "user-1", request, metadata, credentials, bind)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var stored Input
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	prepared, err := prepareOwnedUpscaleSource(bind(context.Background(), CallMeta{UserID: "user-1"}), stored)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Upscale.Factor != wantFactor || stored.Upscale.Factor != request.Scale {
		t.Fatalf("submit preflight factor=%v, original factor=%v", prepared.Upscale.Factor, stored.Upscale.Factor)
	}

	// Verify 4x cap consistency between EstimateMediaUpscale output dimensions and submitted factor (300px -> 1440p caps at 4x = 1200px).
	smallSource := newLocalUpscaleResources(t, "video", upscaleClip(t, 400, 300, false))
	smallRuntime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = smallSource
	})
	smallBind := func(ctx context.Context, meta CallMeta) context.Context {
		r := smallRuntime
		r.Call = meta
		return WithRuntime(ctx, r)
	}
	cappedReq := request
	cappedReq.TargetShortEdge = 1440
	cappedQuote, err := EstimateMediaUpscale(context.Background(), "user-1", cappedReq, metadata, credentials, smallBind)
	if err != nil {
		t.Fatal(err)
	}
	cappedOut := cappedQuote["output"].(map[string]any)
	if cappedOut["width"] != 1600 || cappedOut["height"] != 1200 {
		t.Fatalf("capped estimate output dimensions should match 4x factor (1600x1200), got %#v", cappedOut)
	}
}

func TestUpscaleFactorForTargetSelectsRequestedMPSTier(t *testing.T) {
	for _, tt := range []struct {
		source, target int
		want           float64
	}{
		{496, 1080, 1080.0 / 496},
		{1080, 1440, 1440.0 / 1080},
		{300, 1440, 4},
		{240, 720, 3},
		{200, 1080, 4},
		{1080, 720, 0},
		{180, 1080, 0},
		{496, 1000, 0},
		{0, 1080, 0},
	} {
		got, err := upscaleFactorForTarget(tt.source, tt.target)
		if got != tt.want || (err != nil) != (tt.want == 0) {
			t.Errorf("source %d, target %d: factor %v, error %v; want %v", tt.source, tt.target, got, err, tt.want)
		}
	}
}
