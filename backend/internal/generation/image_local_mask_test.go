package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type localMaskResources struct {
	maskResourcesFixture
	data  []byte
	owner string
}

func (p *localMaskResources) Open(userID, id string) (ResourceInfo, io.ReadCloser, error) {
	p.owner = userID
	return ResourceInfo{ID: id, Status: "ready", MimeType: "image/png"}, io.NopCloser(bytes.NewReader(p.data)), nil
}

func TestLocalMaskReadsOwnedResourceBytes(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 3))
	data, _, _ := MediaBytes(Media{DataURL: maskTestPNG(t, source)})
	resources := &localMaskResources{data: data}
	ctx := WithRuntime(context.Background(), Runtime{Resources: resources, Call: CallMeta{UserID: "mask-owner"}})
	img, err := localMaskImage(ctx, Media{StorageKey: "resource:mask-source"})
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds() != source.Bounds() || resources.owner != "mask-owner" {
		t.Fatalf("resource hydration/ownership: %v %s", img.Bounds(), resources.owner)
	}
}

func TestLocalMaskAcceptsEveryProtocolResultShapeAndAllOutputs(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	source.SetNRGBA(0, 0, color.NRGBA{R: 200, A: 255})
	mask := image.NewNRGBA(source.Bounds())
	mask.SetNRGBA(0, 0, color.NRGBA{A: 255})
	generated := image.NewNRGBA(source.Bounds())
	generated.SetNRGBA(1, 0, color.NRGBA{G: 150, A: 255})
	url := maskTestPNG(t, generated)
	for name, images := range map[string]any{
		"managed":            []map[string]string{{"dataUrl": url}},
		"protocol-inline":    []any{map[string]any{"dataUrl": url, "mimeType": "image/png"}},
		"protocol-url":       []any{map[string]any{"url": url}},
		"typed-map":          []map[string]any{{"url": url}},
		"fixed-four-outputs": []any{map[string]any{"url": url}, map[string]any{"url": url}, map[string]any{"url": url}, map[string]any{"url": url}},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := compositeLocalMaskResult(context.Background(), source, mask, map[string]any{"images": images})
			if err != nil {
				t.Fatal(err)
			}
			outputs := result["images"].([]map[string]string)
			want := 1
			if name == "fixed-four-outputs" {
				want = 4
			}
			if len(outputs) != want {
				t.Fatalf("lost outputs: %d", len(outputs))
			}
			for _, output := range outputs {
				data, _, err := MediaBytes(Media{DataURL: output["dataUrl"]})
				if err != nil {
					t.Fatal(err)
				}
				img, err := png.Decode(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				if color.NRGBAModel.Convert(img.At(0, 0)) != source.At(0, 0) || color.NRGBAModel.Convert(img.At(1, 0)) != generated.At(1, 0) {
					t.Fatal("mask not applied to every output")
				}
			}
		})
	}
}

func maskTestPNG(t *testing.T, img image.Image) string {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return DataURL("image/png", data.Bytes())
}

func TestExecuteLocalMaskPreservesModelAndUnselectedPixels(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	source := image.NewNRGBA(image.Rect(0, 0, 4, 2))
	mask := image.NewNRGBA(source.Bounds())
	generated := image.NewNRGBA(image.Rect(0, 0, 8, 4))
	for y := 0; y < 2; y++ {
		for x := 0; x < 4; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 60, B: 150, A: 255})
			mask.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	mask.SetNRGBA(1, 0, color.NRGBA{})
	mask.SetNRGBA(2, 0, color.NRGBA{A: 128})
	for y := 0; y < 4; y++ {
		for x := 0; x < 8; x++ {
			generated.SetNRGBA(x, y, color.NRGBA{G: 220, A: 255})
		}
	}
	output := maskTestPNG(t, generated)
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts++
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
			return
		}
		if got := r.FormValue("model"); got != "selected-image-model" {
			t.Errorf("model changed: %s", got)
		}
		if len(r.MultipartForm.File["mask"]) != 0 {
			t.Error("unsupported native mask reached provider")
		}
		if !strings.Contains(r.FormValue("prompt"), "红色") {
			t.Error("provider cannot identify selection")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"url": output}}})
	}))
	defer server.Close()
	input := Input{Mode: "image", Prompt: "change the selected area", Config: Config{BaseURL: server.URL, APIKey: "fixture-key", Model: "selected-image-model", InterfaceType: "openai-image"}, ReferenceImages: []Media{{DataURL: maskTestPNG(t, source)}}, Mask: &Media{DataURL: maskTestPNG(t, mask)}, Metadata: map[string]any{"maskEditMode": "local-composite"}}
	for attempt := 0; attempt < 2; attempt++ {
		result, err := Execute(WithRuntime(context.Background(), taskRuntime()), input)
		if err != nil {
			t.Fatal(err)
		}
		images := result["images"].([]map[string]string)
		raw, _, err := MediaBytes(Media{DataURL: images[0]["dataUrl"]})
		if err != nil {
			t.Fatal(err)
		}
		composited, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if composited.Bounds() != source.Bounds() {
			t.Fatalf("output size = %v", composited.Bounds())
		}
		for y := 0; y < 2; y++ {
			for x := 0; x < 4; x++ {
				got := color.NRGBAModel.Convert(composited.At(x, y)).(color.NRGBA)
				want := source.NRGBAAt(x, y)
				if x == 1 && y == 0 {
					want = color.NRGBA{G: 220, A: 255}
				}
				if x == 2 && y == 0 {
					want = color.NRGBA{R: 30, G: 110, B: 75, A: 255}
				}
				if got != want {
					t.Errorf("pixel %d,%d = %v, want %v", x, y, got, want)
				}
			}
		}
	}
	if posts != 2 {
		t.Fatalf("unexpected submit count %d", posts)
	}
	if input.Mask == nil || input.ReferenceImages[0].DataURL != maskTestPNG(t, source) {
		t.Fatal("execution mutated durable input")
	}
}

func TestLocalMaskRecoveryCompositesOnceWithoutSubmitting(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	source.SetNRGBA(0, 0, color.NRGBA{R: 200, A: 255})
	source.SetNRGBA(1, 0, color.NRGBA{R: 200, A: 255})
	mask := image.NewNRGBA(source.Bounds())
	mask.SetNRGBA(0, 0, color.NRGBA{A: 255})
	generated := image.NewNRGBA(source.Bounds())
	generated.SetNRGBA(0, 0, color.NRGBA{G: 150, A: 255})
	generated.SetNRGBA(1, 0, color.NRGBA{G: 150, A: 255})
	input, _ := json.Marshal(Input{Mode: "image", ReferenceImages: []Media{{DataURL: maskTestPNG(t, source)}}, Mask: &Media{DataURL: maskTestPNG(t, mask)}, Metadata: map[string]any{"maskEditMode": "local-composite"}})
	receipt, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"url": maskTestPNG(t, generated)}}})
	finalized, err := FinalizeLocalMaskImageResult(context.Background(), string(input), receipt)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Images []struct {
			DataURL string `json:"dataUrl"`
		} `json:"images"`
	}
	if err := json.Unmarshal(finalized, &result); err != nil {
		t.Fatal(err)
	}
	data, _, _ := MediaBytes(Media{DataURL: result.Images[0].DataURL})
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if got := color.NRGBAModel.Convert(img.At(0, 0)); got != source.At(0, 0) {
		t.Fatalf("unselected original changed: %v", got)
	}
	if got := color.NRGBAModel.Convert(img.At(1, 0)); got != generated.At(1, 0) {
		t.Fatalf("selected pixel not replaced: %v", got)
	}
	again, err := FinalizeLocalMaskImageResult(context.Background(), string(input), finalized)
	if err != nil || !bytes.Equal(again, finalized) {
		t.Fatalf("completion was not idempotent: %v", err)
	}
}

func TestLocalMaskInvalidSelectionsNeverSubmit(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	fullMask := image.NewNRGBA(source.Bounds())
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			fullMask.SetNRGBA(x, y, color.NRGBA{A: 255})
		}
	}
	for name, mask := range map[string]*Media{"missing": nil, "empty": {DataURL: maskTestPNG(t, fullMask)}, "wrong-size": {DataURL: maskTestPNG(t, image.NewNRGBA(image.Rect(0, 0, 1, 1)))}} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			_, err := runLocalMaskImageTask(context.Background(), Input{ReferenceImages: []Media{{DataURL: maskTestPNG(t, source)}}, Mask: mask}, func(context.Context, Input) (map[string]any, error) { calls++; return nil, nil })
			if err == nil || calls != 0 {
				t.Fatalf("invalid selection submitted: err=%v calls=%d", err, calls)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := localMaskImage(ctx, Media{DataURL: maskTestPNG(t, source)})
	if err != context.Canceled {
		t.Fatalf("canceled image read: %v", err)
	}
}
