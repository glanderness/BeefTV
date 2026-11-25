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

type nonFileVideoResources struct {
	ResourcePort
	info ResourceInfo
}

func (p nonFileVideoResources) Lookup(user, id string) (ResourceInfo, error) {
	if user != p.info.UserID || id != p.info.ID {
		return ResourceInfo{}, errors.New("resource not owned")
	}
	return p.info, nil
}

func (p nonFileVideoResources) Open(user, id string) (ResourceInfo, io.ReadCloser, error) {
	info, err := p.Lookup(user, id)
	if err != nil {
		return info, nil, err
	}
	return info, io.NopCloser(bytes.NewReader([]byte("non-file"))), nil
}

func (p nonFileVideoResources) LocalMode() bool { return true }

func writeSparseTestFile(t *testing.T, dir, name string, size int64) string {
	t.Helper()
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if size > 0 {
		if err := f.Truncate(size); err != nil {
			_ = f.Close()
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPreflightOwnedVideoDeliveryLocalFileLimitsAndNonFileRejection(t *testing.T) {
	dir := t.TempDir()
	eraseInput := Input{
		Mode:            "video",
		Config:          Config{BaseURL: "https://beeftv.app/v1", Model: SubtitleEraseModelName},
		SubtitleErase:   &SubtitleEraseOptions{EraseType: "subtitle", EraseMethod: "auto", SubtitleModel: "standard"},
		ReferenceVideos: []Media{{StorageKey: "resource:source"}},
	}

	// 1. Valid local file passes zero-copy stat preflight and records file size.
	validPath := writeSparseTestFile(t, dir, "valid.mp4", 128<<10)
	runtime := taskRuntime(func(r *Runtime) {
		r.Call.UserID = "user-1"
		r.Resources = fileUpscaleResources{path: validPath, kind: "video", size: 128 << 10}
		r.Limits = configurableBudget{limit: 999 << 20}
	})
	prepared, err := prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if err != nil || prepared.ReferenceVideos[0].Bytes != 128<<10 {
		t.Fatalf("valid local file failed: prepared=%#v err=%v", prepared, err)
	}

	// 2. Empty local file rejected with typed empty error.
	emptyPath := writeSparseTestFile(t, dir, "empty.mp4", 0)
	runtime.Resources = fileUpscaleResources{path: emptyPath, kind: "video"}
	_, err = prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInvalidParams || !strings.Contains(classified.UserMessage(), "参考素材为空") {
		t.Fatalf("empty local file misclassified: err=%v classified=%#v", err, classified)
	}

	// 3. >1 GiB local file rejected via stat when server advertised 1 GiB.
	runtime.Limits = configurableBudget{limit: 2048 << 20}
	over1GiBPath := writeSparseTestFile(t, dir, "over1g.mp4", BeefTVMediaToolVideoMaxBytes+1024)
	runtime.Resources = fileUpscaleResources{path: over1GiBPath, kind: "video", size: BeefTVMediaToolVideoMaxBytes + 1024}
	largeEraseInput := eraseInput
	largeOpts := *eraseInput.SubtitleErase
	largeOpts.MaxVideoBytes = BeefTVMediaToolVideoMaxBytes
	largeEraseInput.SubtitleErase = &largeOpts
	_, err = prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), largeEraseInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInputTooLarge || !strings.Contains(classified.UserMessage(), "1GB") {
		t.Fatalf("oversized local file misclassified: err=%v classified=%#v", err, classified)
	}

	// 4. Default/legacy server cap (200 MiB when MaxVideoBytes is 0) fails fast on >200 MiB.
	over200MiBPath := writeSparseTestFile(t, dir, "over200m.mp4", BeefTVSeedanceVideoMaxBytes+1024)
	runtime.Resources = fileUpscaleResources{path: over200MiBPath, kind: "video", size: BeefTVSeedanceVideoMaxBytes + 1024}
	_, err = prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInputTooLarge || !strings.Contains(classified.UserMessage(), "200MB") {
		t.Fatalf("default 200 MiB safe fallback misclassified: err=%v classified=%#v", err, classified)
	}

	// 5. Non-local stream reader fails closed without spooling.
	runtime.Resources = nonFileVideoResources{
		info: ResourceInfo{ID: "source", UserID: "user-1", Status: "ready", Kind: "video", MimeType: "video/mp4"},
	}
	_, err = prepareOwnedSubtitleEraseSource(WithRuntime(context.Background(), runtime), eraseInput)
	if classified := ClassifyError(RequestPreparationError{Cause: err}); classified.Category != CategoryInputInaccessible {
		t.Fatalf("non-local stream should fail closed as inaccessible: err=%v classified=%#v", err, classified)
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
}
