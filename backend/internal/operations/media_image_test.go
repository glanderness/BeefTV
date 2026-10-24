package operations

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand"
	"strings"
	"testing"
)

func imageDomain(data []byte) *mediaDomain {
	return &mediaDomain{owner: "owner", data: data, mimeType: "image/png"}
}

func imageBytes(t *testing.T, result MediaResult) []byte {
	t.Helper()
	if len(result.Content) != 1 || result.Content[0].Type != "image" {
		t.Fatal("missing actual image content")
	}
	data, err := base64.StdEncoding.DecodeString(result.Content[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestImageReadsKeepOriginalPixelsAndBytes(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 3072, 2048))
	picture.SetNRGBA(2701, 1703, color.NRGBA{R: 231, G: 73, B: 19, A: 255})
	for _, format := range []string{"png", "jpeg"} {
		t.Run(format, func(t *testing.T) {
			var encoded bytes.Buffer
			var err error
			if format == "png" {
				err = png.Encode(&encoded, picture)
			} else {
				err = jpeg.Encode(&encoded, picture, &jpeg.Options{Quality: 95})
			}
			if err != nil {
				t.Fatal(err)
			}
			d := imageDomain(encoded.Bytes())
			args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
			overview, err := mediaTestCall(t, d, "media.overview", args)
			if err != nil {
				t.Fatal(err)
			}
			args.ExpectedVersion, args.Mode = overview.Source.Version, "frames"
			inspected, err := mediaTestCall(t, d, "media.inspect", args)
			if err != nil {
				t.Fatal(err)
			}
			for _, result := range []MediaResult{overview, inspected} {
				if result.Image == nil || result.Image.View != "original" || result.Image.Width != 3072 || result.Image.Height != 2048 || !bytes.Equal(imageBytes(t, result), encoded.Bytes()) {
					t.Fatal("original image was resized or recompressed")
				}
			}
		})
	}
}

func TestImageCropKeepsOriginalPixelDetail(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 2048, 3072))
	for y := 0; y < 3072; y++ {
		for x := 0; x < 2048; x++ {
			picture.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: uint8(x ^ y), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	d := imageDomain(encoded.Bytes())
	overview, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node"})
	if err != nil {
		t.Fatal(err)
	}
	crop := &MediaImageCrop{X: 0.25, Y: 0.5, Width: 0.125, Height: 0.125}
	result, err := mediaTestCall(t, d, "media.inspect", mediaArgs{CanvasID: "canvas", NodeID: "node", ExpectedVersion: overview.Source.Version, Mode: "frames", ImageCrop: crop})
	if err != nil {
		t.Fatal(err)
	}
	actual, err := png.Decode(bytes.NewReader(imageBytes(t, result)))
	if err != nil {
		t.Fatal(err)
	}
	if actual.Bounds().Dx() != 256 || actual.Bounds().Dy() != 384 || result.Image.View != "crop" || *result.Image.Crop != *crop || result.Source.Version != overview.Source.Version {
		t.Fatal("crop changed source version or pixel dimensions")
	}
	for y := 0; y < 384; y++ {
		for x := 0; x < 256; x++ {
			if actual.At(x, y) != picture.At(x+512, y+1536) {
				// Decoders can return different Color implementations for equal pixels.
				ar, ag, ab, aa := actual.At(x, y).RGBA()
				er, eg, eb, ea := picture.At(x+512, y+1536).RGBA()
				if ar != er || ag != eg || ab != eb || aa != ea {
					t.Fatalf("detail changed at %d,%d", x, y)
				}
			}
		}
	}
}

func TestOversizeImageOverviewLabelsPreviewAndInspectionCanCrop(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 2300, 600))
	random := rand.New(rand.NewSource(17))
	for i := 0; i < len(picture.Pix); i += 4 {
		picture.Pix[i], picture.Pix[i+1], picture.Pix[i+2], picture.Pix[i+3] = uint8(random.Intn(256)), uint8(random.Intn(256)), uint8(random.Intn(256)), 255
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	if int64(encoded.Len()) <= maxInlineImageBytes || int64(encoded.Len()) > maxMediaPartBytes {
		t.Fatal("fixture must exceed the request byte budget")
	}
	d := imageDomain(encoded.Bytes())
	args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
	preview, err := mediaTestCall(t, d, "media.overview", args)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Image.View != "preview" || preview.Image.Width != 2048 || preview.Image.OriginalWidth != 2300 || !strings.Contains(preview.Note, "imageCrop") {
		t.Fatal("overview silently lost detail")
	}
	args.ExpectedVersion, args.Mode = preview.Source.Version, "frames"
	if _, err := mediaTestCall(t, d, "media.inspect", args); err == nil || AsError(err).Reason != "media_part_too_large" {
		t.Fatalf("inspection silently resized an oversized image: %v", err)
	}
	args.ImageCrop = &MediaImageCrop{Width: 0.25, Height: 0.25}
	detail, err := mediaTestCall(t, d, "media.inspect", args)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Image.View != "crop" || detail.Image.Width != 575 || detail.Image.Height != 150 || detail.Source.Version != preview.Source.Version {
		t.Fatal("oversized image could not be inspected at original pixel resolution")
	}
}

func TestInvalidImageCropsNeverOpenResources(t *testing.T) {
	d := imageDomain(nil)
	for _, args := range []mediaArgs{
		{ImageCrop: &MediaImageCrop{X: -0.1, Width: 0.5, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{X: 1, Width: 0.1, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{X: 0.8, Width: 0.5, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{Width: 0, Height: 0.5}},
		{ImageCrop: &MediaImageCrop{Width: 0.5, Height: 0.5}, Mode: "video"},
		{ImageCrop: &MediaImageCrop{Width: 0.5, Height: 0.5}, EndMs: 1},
	} {
		args.CanvasID, args.NodeID, args.ExpectedVersion = "canvas", "node", strings.Repeat("a", 64)
		if _, err := mediaTestCall(t, d, "media.inspect", args); err == nil || AsError(err).Reason != "invalid_image_crop" {
			t.Fatalf("invalid crop accepted: %+v %v", args, err)
		}
	}
	d.mimeType = "video/mp4"
	if _, err := mediaTestCall(t, d, "media.inspect", mediaArgs{CanvasID: "canvas", NodeID: "node", ImageCrop: &MediaImageCrop{Width: 0.5, Height: 0.5}}); err == nil || AsError(err).Reason != "invalid_image_crop" {
		t.Fatalf("video accepted image crop: %v", err)
	}
	if d.opens != 0 {
		t.Fatal("invalid crop opened source bytes")
	}
}
