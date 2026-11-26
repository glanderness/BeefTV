package operations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"testing"

	"infinite-canvas/backend/internal/model"
)

type scannedPDFDomain struct {
	Domain
	pdfBytes []byte
}

func (d *scannedPDFDomain) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	return &model.Resource{
		ID:        resourceID,
		UserID:    userID,
		MimeType:  "application/pdf",
		Size:      int64(len(d.pdfBytes)),
		ObjectKey: "scanned.pdf",
		Status:    model.ResourceStatusReady,
	}, nil
}

func (d *scannedPDFDomain) OpenMediaResource(_ context.Context, _, _ string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(d.pdfBytes)), nil
}

func buildSyntheticScannedPDF(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8((x * 3) % 255), G: uint8((y * 5) % 255), B: 180, A: 255})
		}
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length ")
	pdf.WriteString(fmt.Sprintf("%d >>\nstream\n", jpg.Len()))
	pdf.Write(jpg.Bytes())
	pdf.WriteString("\nendstream\nendobj\n%%EOF\n")
	return pdf.Bytes()
}

func TestFileReadExtractsImagesFromScannedPDF(t *testing.T) {
	pdfBytes := buildSyntheticScannedPDF(t, 240, 160)
	dom := &scannedPDFDomain{pdfBytes: pdfBytes}
	ctx := &Context{
		Context: context.Background(),
		UserID:  "owner",
		Domain:  dom,
	}
	raw, _ := json.Marshal(map[string]any{"resourceId": "res-scan-pdf", "name": "storyboard-scan.pdf"})
	out, err := opFileRead(ctx, raw)
	if err != nil {
		t.Fatalf("opFileRead failed: %v", err)
	}
	res, ok := out.(fileReadResult)
	if !ok {
		t.Fatalf("unexpected result type: %T", out)
	}
	if !res.Readable || res.Format != "pdf-images" {
		t.Fatalf("expected readable pdf-images, got readable=%v format=%q note=%q", res.Readable, res.Format, res.Note)
	}
	if len(res.Images) != 1 {
		t.Fatalf("expected 1 extracted image, got %d", len(res.Images))
	}
	decoded, err := base64.StdEncoding.DecodeString(res.Images[0].Data)
	if err != nil {
		t.Fatalf("invalid base64 image: %v", err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(decoded))
	if err != nil || cfg.Width != 240 || cfg.Height != 160 {
		t.Fatalf("unexpected extracted image config: %+v err=%v", cfg, err)
	}
}
