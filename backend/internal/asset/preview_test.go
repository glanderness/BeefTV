package asset

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func buildTestJPEGWithEXIFAndICC(t *testing.T, w, h, orientation int, icc []byte) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x < w/2 {
				img.Set(x, y, color.RGBA{R: 220, G: 40, B: 40, A: 255})
			} else {
				img.Set(x, y, color.RGBA{R: 40, G: 80, B: 220, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 92}); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()

	// Build minimal APP1 Exif block with Orientation tag (0x0112) in big-endian TIFF.
	var exif bytes.Buffer
	exif.WriteString("Exif\x00\x00")
	exif.WriteString("MM")
	_ = binary.Write(&exif, binary.BigEndian, uint16(42))
	_ = binary.Write(&exif, binary.BigEndian, uint32(8))
	_ = binary.Write(&exif, binary.BigEndian, uint16(1)) // 1 IFD entry
	_ = binary.Write(&exif, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&exif, binary.BigEndian, uint16(3)) // SHORT
	_ = binary.Write(&exif, binary.BigEndian, uint32(1))
	_ = binary.Write(&exif, binary.BigEndian, uint16(orientation))
	_ = binary.Write(&exif, binary.BigEndian, uint16(0))
	_ = binary.Write(&exif, binary.BigEndian, uint32(0))

	var withExif bytes.Buffer
	withExif.Write(raw[:2])
	withExif.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&withExif, binary.BigEndian, uint16(exif.Len()+2))
	withExif.Write(exif.Bytes())
	withExif.Write(raw[2:])
	out := withExif.Bytes()
	if len(icc) > 0 {
		out = injectJPEGICC(out, icc)
	}
	return out
}

func buildTestPNG(t *testing.T, w, h int, withAlpha bool, icc []byte) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if withAlpha && x < w/4 {
				a = 64
			}
			img.SetNRGBA(x, y, color.NRGBA{R: 30, G: 180, B: 120, A: a})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	out := buf.Bytes()
	if len(icc) > 0 {
		out = injectPNGICC(out, icc)
	}
	return out
}

func TestPreviewEXIFOrientationAndICCPreservation(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	fakeP3 := []byte("fake-display-p3-icc-profile-payload-0123456789")

	// Landscape 1200x600 with EXIF orientation=6 (rotate 90 CW -> portrait 600x1200).
	jpegBytes := buildTestJPEGWithEXIFAndICC(t, 1200, 600, 6, fakeP3)
	res, _, err := svc.Store("user-1", "image", "portrait.jpg", "image/jpeg", int64(len(jpegBytes)), 1200, 600, 0, bytes.NewReader(jpegBytes), nil)
	if err != nil {
		t.Fatalf("store jpeg: %v", err)
	}

	preview, err := svc.OpenImagePreview(context.Background(), "user-1", res.ID, 512, PreviewColorPreserve)
	if err != nil {
		t.Fatalf("OpenImagePreview: %v", err)
	}
	if preview.IsOriginal || preview.MimeType != "image/jpeg" {
		t.Fatalf("unexpected preview meta: %+v", preview)
	}
	outBytes, err := os.ReadFile(preview.Path)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(outBytes))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != 256 || cfg.Height != 512 {
		t.Fatalf("expected rotated portrait 256x512, got %dx%d", cfg.Width, cfg.Height)
	}
	if gotICC := extractJPEGICC(outBytes); !bytes.Equal(gotICC, fakeP3) {
		t.Fatalf("expected preserved ICC profile %q, got %q", fakeP3, gotICC)
	}

	// sRGB mode strips ICC profile.
	srgbPreview, err := svc.OpenImagePreview(context.Background(), "user-1", res.ID, 512, PreviewColorSRGB)
	if err != nil {
		t.Fatalf("OpenImagePreview srgb: %v", err)
	}
	srgbBytes, err := os.ReadFile(srgbPreview.Path)
	if err != nil {
		t.Fatal(err)
	}
	if gotICC := extractJPEGICC(srgbBytes); len(gotICC) != 0 {
		t.Fatalf("expected stripped ICC in srgb mode, got %d bytes", len(gotICC))
	}

	// Delete removes preview cache directory cleanly.
	svc.RemovePreviewCache("user-1", res.ID)
	if _, statErr := os.Stat(preview.Path); !os.IsNotExist(statErr) {
		t.Fatalf("expected preview cache removed, statErr=%v", statErr)
	}
}

func TestPreviewAlphaAndOpaquePNGICC(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	fakeP3 := []byte("display-p3-png-icc-data-abcdef")

	// Opaque PNG -> compressed JPEG with ICC preserved.
	opaquePNG := buildTestPNG(t, 1200, 800, false, fakeP3)
	opaqueRes, _, err := svc.Store("user-1", "image", "opaque.png", "image/png", int64(len(opaquePNG)), 1200, 800, 0, bytes.NewReader(opaquePNG), nil)
	if err != nil {
		t.Fatal(err)
	}
	opaquePrev, err := svc.OpenImagePreview(context.Background(), "user-1", opaqueRes.ID, 512, PreviewColorPreserve)
	if err != nil {
		t.Fatal(err)
	}
	if opaquePrev.MimeType != "image/jpeg" {
		t.Fatalf("expected opaque PNG preview encoded as JPEG, got %q", opaquePrev.MimeType)
	}
	opaqueBytes, err := os.ReadFile(opaquePrev.Path)
	if err != nil {
		t.Fatal(err)
	}
	if got := extractJPEGICC(opaqueBytes); !bytes.Equal(got, fakeP3) {
		t.Fatalf("expected ICC transferred from PNG iCCP to JPEG APP2, got %q", got)
	}

	// Transparent PNG -> stays PNG with alpha & ICC preserved.
	alphaPNG := buildTestPNG(t, 1200, 800, true, fakeP3)
	alphaRes, _, err := svc.Store("user-1", "image", "alpha.png", "image/png", int64(len(alphaPNG)), 1200, 800, 0, bytes.NewReader(alphaPNG), nil)
	if err != nil {
		t.Fatal(err)
	}
	alphaPrev, err := svc.OpenImagePreview(context.Background(), "user-1", alphaRes.ID, 512, PreviewColorPreserve)
	if err != nil {
		t.Fatal(err)
	}
	if alphaPrev.MimeType != "image/png" {
		t.Fatalf("expected alpha PNG preview kept as PNG, got %q", alphaPrev.MimeType)
	}
	alphaBytes, err := os.ReadFile(alphaPrev.Path)
	if err != nil {
		t.Fatal(err)
	}
	if got := extractPNGICC(alphaBytes); !bytes.Equal(got, fakeP3) {
		t.Fatalf("expected ICC kept on alpha PNG, got %q", got)
	}
}

func TestPreviewSkipsAnimatedGIF(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	palette := color.Palette{color.Black, color.White}
	f1 := image.NewPaletted(image.Rect(0, 0, 800, 600), palette)
	f2 := image.NewPaletted(image.Rect(0, 0, 800, 600), palette)
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, &gif.GIF{
		Image: []*image.Paletted{f1, f2},
		Delay: []int{10, 10},
	}); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	res, _, err := svc.Store("user-1", "image", "anim.gif", "image/gif", int64(len(raw)), 800, 600, 0, bytes.NewReader(raw), nil)
	if err != nil {
		t.Fatal(err)
	}
	prev, err := svc.OpenImagePreview(context.Background(), "user-1", res.ID, 256, PreviewColorPreserve)
	if err != nil {
		t.Fatal(err)
	}
	if !prev.IsOriginal || prev.MimeType != "image/gif" {
		t.Fatalf("expected animated GIF to bypass static transform, got %+v", prev)
	}
}

func TestClampByteRangeAndMediaTickets(t *testing.T) {
	// Safari 2-byte probe preserved.
	if got := ClampByteRange("bytes=0-1", 50<<20, 4<<20); got != "bytes=0-1" {
		t.Fatalf("bytes=0-1 probe got %q", got)
	}
	// Open-ended range clamped to 4 MiB.
	if got := ClampByteRange("bytes=0-", 50<<20, 4<<20); got != "bytes=0-4194303" {
		t.Fatalf("open-ended clamp got %q", got)
	}
	// Mid-file open range clamped to EOF when near end.
	if got := ClampByteRange("bytes=900-", 1000, 4<<20); got != "bytes=900-999" {
		t.Fatalf("tail clamp got %q", got)
	}

	// Ticket issuance and TTL expiry.
	store := NewMediaTicketStore()
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	token, exp, err := store.Issue("user-1", "res-1", "original", "res-1.mp4", "video/mp4")
	if err != nil || len(token) != 64 || !exp.After(now) {
		t.Fatalf("unexpected issue result: token=%q exp=%v err=%v", token, exp, err)
	}
	entry, ok := store.Lookup(token)
	if !ok || entry.ResourceID != "res-1" || entry.FileName != "res-1.mp4" {
		t.Fatalf("lookup failed: ok=%v entry=%+v", ok, entry)
	}
	now = exp.Add(time.Second)
	if _, stillOK := store.Lookup(token); stillOK {
		t.Fatal("expected expired ticket to fail lookup")
	}
}

// Compile guard for model reference used in helper checks.
var _ = model.ResourceStatusReady
