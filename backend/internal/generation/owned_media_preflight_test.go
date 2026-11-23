package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/topaz"
)

type zeroReader struct {
	remaining int64
}

func (z *zeroReader) Read(p []byte) (int, error) {
	if z.remaining <= 0 {
		return 0, io.EOF
	}
	n := int(min(int64(len(p)), z.remaining))
	clear(p[:n])
	z.remaining -= int64(n)
	return n, nil
}

type streamVideoResources struct {
	ResourcePort
	info        ResourceInfo
	streamBytes int64
	localMode   bool
}

func (p streamVideoResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != p.info.UserID || id != p.info.ID {
		return ResourceInfo{}, errors.New("resource not owned")
	}
	return p.info, nil
}

func (p streamVideoResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	if err != nil {
		return info, nil, err
	}
	return info, io.NopCloser(&zeroReader{remaining: p.streamBytes}), nil
}

func (p streamVideoResources) LocalMode() bool { return p.localMode }

type serverModeLocalFileResources struct {
	fileUpscaleResources
}

func (p serverModeLocalFileResources) LocalMode() bool { return false }

func TestPreflightOwnedVideoDeliveryStreamingFallbackAndLimits(t *testing.T) {
	eraseInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}

	// 1. Valid non-file stream passes bounded streaming preflight and records measured size.
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = streamVideoResources{
			info:        ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4"},
			streamBytes: 128 << 10,
		}
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	prepared, err := prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if err != nil || prepared.ReferenceVideos[0].Bytes != 128<<10 {
		t.Fatalf("valid non-file stream failed: prepared=%#v err=%v", prepared, err)
	}

	// 2. Empty non-file stream rejected with typed empty error.
	runtime.Resources = streamVideoResources{
		info:        ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4"},
		streamBytes: 0,
	}
	_, err = prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInvalidParams || !strings.Contains(classified.UserMessage(), "参考素材为空") {
		t.Fatalf("empty non-file stream misclassified: err=%v classified=%#v", err, classified)
	}

	// 3. >200 MiB non-file stream rejected via bounded io.Copy(io.Discard, ...) without buffering 200 MiB in RAM.
	runtime.Resources = streamVideoResources{
		info:        ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4"},
		streamBytes: (200 << 20) + 1024,
	}
	_, err = prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInputTooLarge || !strings.Contains(classified.UserMessage(), "200MB") {
		t.Fatalf("oversized non-file stream misclassified: err=%v classified=%#v", err, classified)
	}
}

func TestEstimateMediaUpscalePlumbsProbedDimensionsAndUsesStatOverStaleSize(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "source.png")
	pngBytes := upscalePNG(t, 80, 60)
	if err := os.WriteFile(pngPath, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/media-upscale/capabilities":
			_, _ = io.WriteString(w, `{"supported_models":[{"id":"topaz-standard-v2","label":"Standard V2","media_type":"image","mode":"precision"}]}`)
		case "/v1/media-upscale/estimate":
			_ = json.NewEncoder(w).Encode(UpscaleEstimate{Model: "topaz-standard-v2", Currency: "CNY", Reservation: 1.25})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	// Even with stale DB dimensions (0x0) and stale oversized DB Size (>30MB),
	// local file stat/header probe is authoritative and populates source/output dimensions.
	runtime := taskRuntime(func(r *Runtime) {
		r.Endpoints.BeefTVVideoBaseURL = server.URL
		r.Resources = guardedFileResources{
			fileUpscaleResources: fileUpscaleResources{
				path: pngPath, kind: "image", size: (50 << 20), width: 0, height: 0,
			},
			t:       t,
			maxRead: videoReferenceHeaderDecodeLimit,
		}
		r.Limits = configurableBudget{limit: 999 << 20}
	})

	resp, err := EstimateMediaUpscale(
		context.Background(),
		"user-1",
		topaz.Request{ResourceID: "source", ChannelID: "beeftv", Model: "topaz-standard-v2", Mode: "precision", Scale: 2},
		func(context.Context, string, string) (*model.Resource, error) {
			return &model.Resource{ID: "source", UserID: "user-1", Status: model.ResourceStatusReady, Kind: "image", MimeType: "image/png", Size: 50 << 20, Width: 0, Height: 0}, nil
		},
		func() (string, string, string, string, error) {
			return "synthetic-key", server.URL, "", "", nil
		},
		func(ctx context.Context, meta CallMeta) context.Context {
			r := runtime
			r.Call = meta
			return WithRuntime(ctx, r)
		},
	)
	if err != nil {
		t.Fatalf("EstimateMediaUpscale failed: %v", err)
	}
	source := resp["source"].(map[string]any)
	output := resp["output"].(map[string]any)
	if source["width"] != 80 || source["height"] != 60 || output["width"] != 160 || output["height"] != 120 {
		t.Fatalf("estimate response lost probed image dimensions: source=%#v output=%#v", source, output)
	}

	// Server mode (LocalMode=false) still takes the zero-copy ownedLocalFile fast path on *os.File.
	serverRuntime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = serverModeLocalFileResources{
			fileUpscaleResources: fileUpscaleResources{path: pngPath, kind: "image", size: int64(len(pngBytes))},
		}
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	imgInput := Input{
		Mode:            "image",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: "topaz-standard-v2"},
		Upscale:         &UpscaleOptions{Factor: 2},
		ReferenceImages: []Media{{StorageKey: "resource:source"}},
	}
	prepared, err := prepareOwnedUpscaleSource(WithRuntime(context.Background(), serverRuntime), imgInput)
	if err != nil || prepared.ReferenceImages[0].Width != 80 || prepared.ReferenceImages[0].Height != 60 || bytes.Equal(nil, pngBytes) {
		t.Fatalf("server-mode local *os.File fast path failed: prepared=%#v err=%v", prepared, err)
	}
}
