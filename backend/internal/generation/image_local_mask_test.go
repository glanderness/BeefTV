package generation

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
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

func finalizeLocalMaskForTest(ctx context.Context, inputJSON string, resultJSON []byte) ([]byte, error) {
	composited, changed, err := finalizeLocalMaskMap(ctx, inputJSON, resultJSON)
	if err != nil || !changed {
		return resultJSON, err
	}
	return json.Marshal(composited)
}

func TestLocalMaskReadsOwnedResourceBytes(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 3))
	data, _, _ := MediaBytes(Media{DataURL: maskTestPNG(t, source)})
	resources := &localMaskResources{data: data}
	ctx := WithRuntime(context.Background(), Runtime{Resources: resources, Call: CallMeta{UserID: "mask-owner"}})
	img, err := localMaskImage(ctx, nil, Media{StorageKey: "resource:mask-source"})
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
			result, err := compositeLocalMaskResult(context.Background(), nil, source, mask, map[string]any{"images": images})
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
	finalized, err := finalizeLocalMaskForTest(context.Background(), string(input), receipt)
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
	again, err := finalizeLocalMaskForTest(context.Background(), string(input), finalized)
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
	_, err := localMaskImage(ctx, nil, Media{DataURL: maskTestPNG(t, source)})
	if err != context.Canceled {
		t.Fatalf("canceled image read: %v", err)
	}
}

type localMaskBytesStorage struct {
	uploaded [][]byte
	url      string
}

func (s *localMaskBytesStorage) Enabled() (bool, error)                       { return true, nil }
func (s *localMaskBytesStorage) Upload(context.Context, string, string) (string, error) {
	return s.url, nil
}
func (s *localMaskBytesStorage) UploadBytes(_ context.Context, data []byte) (string, error) {
	s.uploaded = append(s.uploaded, append([]byte(nil), data...))
	return s.url, nil
}

func TestLocalMaskUploadsMarkedReferenceForURLRequiredChannel(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	source.SetNRGBA(0, 0, color.NRGBA{R: 100, G: 100, B: 100, A: 255})
	source.SetNRGBA(1, 0, color.NRGBA{R: 100, G: 100, B: 100, A: 255})
	mask := image.NewNRGBA(source.Bounds())
	mask.SetNRGBA(0, 0, color.NRGBA{A: 255})
	mask.SetNRGBA(1, 0, color.NRGBA{A: 0})
	generated := image.NewNRGBA(source.Bounds())
	generated.SetNRGBA(1, 0, color.NRGBA{G: 200, A: 255})

	storage := &localMaskBytesStorage{url: "https://cdn.example.com/beeftv/references/marked.png"}
	ctx := WithRuntime(context.Background(), Runtime{ReferenceStorage: storage})
	var received Media
	input := Input{
		Mode:            "image",
		Prompt:          "edit right pixel",
		Config:          Config{ReferenceMediaTransport: map[string]string{"image": "url"}},
		ReferenceImages: []Media{{DataURL: maskTestPNG(t, source)}},
		Mask:            &Media{DataURL: maskTestPNG(t, mask)},
		Metadata:        map[string]any{"maskEditMode": "local-composite"},
	}
	_, err := runLocalMaskImageTask(ctx, input, func(_ context.Context, inner Input) (map[string]any, error) {
		received = inner.ReferenceImages[0]
		return map[string]any{"images": []map[string]string{{"dataUrl": maskTestPNG(t, generated)}}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(storage.uploaded) != 1 || received.URL != storage.url || received.DataURL != "" {
		t.Fatalf("expected marked image uploaded to reference storage, uploads=%d media=%+v", len(storage.uploaded), received)
	}
}

func TestLocalMaskRecoveryDownloadsProviderAuthenticatedOutput(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	source := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	source.SetNRGBA(0, 0, color.NRGBA{R: 200, A: 255})
	source.SetNRGBA(1, 0, color.NRGBA{R: 200, A: 255})
	mask := image.NewNRGBA(source.Bounds())
	mask.SetNRGBA(0, 0, color.NRGBA{A: 255})
	generated := image.NewNRGBA(source.Bounds())
	generated.SetNRGBA(0, 0, color.NRGBA{G: 180, A: 255})
	generated.SetNRGBA(1, 0, color.NRGBA{G: 180, A: 255})
	var generatedBuf bytes.Buffer
	if err := png.Encode(&generatedBuf, generated); err != nil {
		t.Fatal(err)
	}
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if gotAuth != "Bearer secret-provider-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(generatedBuf.Bytes())
	}))
	defer server.Close()

	input, _ := json.Marshal(Input{
		Mode:            "image",
		Config:          Config{BaseURL: server.URL, APIKey: "secret-provider-key"},
		ReferenceImages: []Media{{DataURL: maskTestPNG(t, source)}},
		Mask:            &Media{DataURL: maskTestPNG(t, mask)},
		Metadata:        map[string]any{"maskEditMode": "local-composite"},
	})
	receipt, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"url": server.URL + "/outputs/generated.png"}}})
	limits := &deliveryCircuitLimits{}
	ctx := WithRuntime(context.Background(), Runtime{
		Limits: limits,
		Call:   CallMeta{ChannelID: "provider-ch", RequestKind: "create"},
	})
	finalized, err := finalizeLocalMaskForTest(ctx, string(input), receipt)
	if err != nil {
		t.Fatalf("authenticated recovery composite failed: %v", err)
	}
	if gotAuth != "Bearer secret-provider-key" {
		t.Fatalf("missing provider auth header: %q", gotAuth)
	}
	if limits.checks != 0 || limits.results != 0 {
		t.Fatalf("result download should bypass generation circuit breaker: checks=%d results=%d", limits.checks, limits.results)
	}
	if !strings.Contains(string(finalized), `"localMaskComposited":true`) {
		t.Fatalf("unexpected finalized payload: %s", finalized)
	}
}

func TestLocalMaskNormalizesEXIFOrientationAndScalesFeatheredRedMark(t *testing.T) {
	// Raw 4x2 JPEG with EXIF Orientation=6 (90 CW -> 2x4 browser-oriented image).
	raw := image.NewNRGBA(image.Rect(0, 0, 4, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 4; x++ {
			raw.SetNRGBA(x, y, color.NRGBA{R: 40, G: 120, B: 180, A: 255})
		}
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, raw, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	var exif bytes.Buffer
	exif.WriteString("Exif\x00\x00MM")
	_ = binary.Write(&exif, binary.BigEndian, uint16(42))
	_ = binary.Write(&exif, binary.BigEndian, uint32(8))
	_ = binary.Write(&exif, binary.BigEndian, uint16(1))
	_ = binary.Write(&exif, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&exif, binary.BigEndian, uint16(3))
	_ = binary.Write(&exif, binary.BigEndian, uint32(1))
	_ = binary.Write(&exif, binary.BigEndian, uint16(6))
	_ = binary.Write(&exif, binary.BigEndian, uint16(0))
	_ = binary.Write(&exif, binary.BigEndian, uint32(0))
	var withEXIF bytes.Buffer
	withEXIF.Write(jpg.Bytes()[:2])
	withEXIF.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&withEXIF, binary.BigEndian, uint16(exif.Len()+2))
	withEXIF.Write(exif.Bytes())
	withEXIF.Write(jpg.Bytes()[2:])

	// Browser draws a 2x4 mask matching the EXIF-rotated image.
	mask := image.NewNRGBA(image.Rect(0, 0, 2, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 2; x++ {
			mask.SetNRGBA(x, y, color.NRGBA{A: 255})
		}
	}
	mask.SetNRGBA(0, 0, color.NRGBA{A: 0})   // full selection
	mask.SetNRGBA(1, 0, color.NRGBA{A: 250}) // faint feathered edge

	var markedRef image.Image
	_, err := runLocalMaskImageTask(context.Background(), Input{
		Mode:            "image",
		Prompt:          "edit",
		ReferenceImages: []Media{{DataURL: DataURL("image/jpeg", withEXIF.Bytes())}},
		Mask:            &Media{DataURL: maskTestPNG(t, mask)},
		Metadata:        map[string]any{"maskEditMode": "local-composite"},
	}, func(_ context.Context, inner Input) (map[string]any, error) {
		rawRef, _, err := MediaBytes(inner.ReferenceImages[0])
		if err != nil {
			return nil, err
		}
		markedRef, _, err = image.Decode(bytes.NewReader(rawRef))
		if err != nil {
			return nil, err
		}
		return map[string]any{"images": []map[string]string{{"dataUrl": maskTestPNG(t, image.NewNRGBA(image.Rect(0, 0, 2, 4)))}}}, nil
	})
	if err != nil {
		t.Fatalf("EXIF-rotated source should match browser-oriented mask: %v", err)
	}
	if markedRef.Bounds().Dx() != 2 || markedRef.Bounds().Dy() != 4 {
		t.Fatalf("marked bounds = %v, want 2x4", markedRef.Bounds())
	}
	fullMark := color.NRGBAModel.Convert(markedRef.At(0, 0)).(color.NRGBA)
	edgeMark := color.NRGBAModel.Convert(markedRef.At(1, 0)).(color.NRGBA)
	if edgeMark.R >= fullMark.R || edgeMark.G <= fullMark.G {
		t.Fatalf("feathered edge should have much softer red mark than full selection: full=%v edge=%v", fullMark, edgeMark)
	}
}
