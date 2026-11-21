package mediatools

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestScaleImagePreviewEXIFOrientationAndPNG(t *testing.T) {
	if _, err := ResolveFFmpeg(); err != nil {
		t.Skipf("ffmpeg unavailable in test environment: %v", err)
	}
	dir := t.TempDir()

	// Build a real 320x160 landscape JPEG with EXIF orientation=6 (rotate 90 CW -> 160x320).
	// Top half is bright red, bottom half is bright blue; after 90 CW rotation the
	// right half must be red and the left half must be blue.
	srcImg := image.NewRGBA(image.Rect(0, 0, 320, 160))
	for y := 0; y < 160; y++ {
		for x := 0; x < 320; x++ {
			if y < 80 {
				srcImg.Set(x, y, color.RGBA{R: 230, G: 30, B: 30, A: 255})
			} else {
				srcImg.Set(x, y, color.RGBA{R: 30, G: 60, B: 230, A: 255})
			}
		}
	}
	var jpgBuf bytes.Buffer
	if err := jpeg.Encode(&jpgBuf, srcImg, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	raw := jpgBuf.Bytes()
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
	var withExif bytes.Buffer
	withExif.Write(raw[:2])
	withExif.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&withExif, binary.BigEndian, uint16(exif.Len()+2))
	withExif.Write(exif.Bytes())
	withExif.Write(raw[2:])

	srcJPEG := filepath.Join(dir, "orient6.jpg")
	dstJPEG := filepath.Join(dir, "out-orient6.jpg")
	if err := os.WriteFile(srcJPEG, withExif.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ScaleImagePreview(context.Background(), srcJPEG, dstJPEG, 128, 6, false); err != nil {
		t.Fatalf("ScaleImagePreview JPEG failed: %v", err)
	}
	outBytes, err := os.ReadFile(dstJPEG)
	if err != nil {
		t.Fatal(err)
	}
	decoded, format, err := image.Decode(bytes.NewReader(outBytes))
	if err != nil {
		t.Fatalf("decode scaled JPEG: %v", err)
	}
	if format != "jpeg" {
		t.Fatalf("expected jpeg output, got %q", format)
	}
	b := decoded.Bounds()
	if b.Dx() != 64 || b.Dy() != 128 {
		t.Fatalf("expected rotated portrait 64x128, got %dx%d", b.Dx(), b.Dy())
	}
	// Verify orientation=6 rotated top(red)->right and bottom(blue)->left.
	rLeft, _, bLeft, _ := decoded.At(b.Min.X+10, b.Min.Y+64).RGBA()
	rRight, _, bRight, _ := decoded.At(b.Max.X-10, b.Min.Y+64).RGBA()
	if bLeft <= rLeft || rRight <= bRight {
		t.Fatalf("EXIF orientation 6 pixels wrong: left(R=%d,B=%d) right(R=%d,B=%d)", rLeft>>8, bLeft>>8, rRight>>8, bRight>>8)
	}

	// Verify transparent PNG scaling preserves PNG format and alpha channel.
	alphaImg := image.NewNRGBA(image.Rect(0, 0, 240, 120))
	for y := 0; y < 120; y++ {
		for x := 0; x < 240; x++ {
			a := uint8(255)
			if x < 120 {
				a = 64
			}
			alphaImg.SetNRGBA(x, y, color.NRGBA{R: 40, G: 200, B: 100, A: a})
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, alphaImg); err != nil {
		t.Fatal(err)
	}
	srcPNG := filepath.Join(dir, "alpha.png")
	dstPNG := filepath.Join(dir, "out-alpha.png")
	if err := os.WriteFile(srcPNG, pngBuf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ScaleImagePreview(context.Background(), srcPNG, dstPNG, 128, 1, true); err != nil {
		t.Fatalf("ScaleImagePreview PNG failed: %v", err)
	}
	outPNGBytes, err := os.ReadFile(dstPNG)
	if err != nil {
		t.Fatal(err)
	}
	decodedPNG, pngFmt, err := image.Decode(bytes.NewReader(outPNGBytes))
	if err != nil {
		t.Fatalf("decode scaled PNG: %v", err)
	}
	if pngFmt != "png" {
		t.Fatalf("expected png output, got %q", pngFmt)
	}
	_, _, _, aLeft := decodedPNG.At(10, 32).RGBA()
	if aLeft >= 0xF000 {
		t.Fatalf("expected preserved semi-transparent alpha on scaled PNG, got alpha=%d", aLeft>>8)
	}
}

func makePosterTestClip(t *testing.T, ffmpegBin, outPath, filterComplex string) {
	t.Helper()
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}
	args = append(args, "-f", "lavfi", "-i", filterComplex)
	args = append(args, PreferredH264VideoArgs(ffmpegBin, "ultrafast", "28", "800k", "1200k")...)
	args = append(args, "-an", outPath)
	cmd := exec.Command(ffmpegBin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate test clip %s: %v\n%s", filepath.Base(outPath), err, string(out))
	}
}

func TestExtractVideoPosterFrameZeroAndBlackFallback(t *testing.T) {
	ffmpegBin, err := ResolveFFmpeg()
	if err != nil {
		t.Skipf("ffmpeg unavailable in test environment: %v", err)
	}
	if !SupportsH264Encode(ffmpegBin) {
		t.Skipf("ffmpeg %s has no h264 encoder for fixture generation", ffmpegBin)
	}
	dir := t.TempDir()

	// 1. Non-black opening frame (red 0.0-0.15s, then blue 0.15-0.6s):
	//    ExtractVideoPoster must preserve frame 0 (red) instead of skipping to 0.2s.
	redThenBlue := filepath.Join(dir, "red-then-blue.mp4")
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=0.15",
		"-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=0.45",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
		"-map", "[v]",
	}
	args = append(args, PreferredH264VideoArgs(ffmpegBin, "ultrafast", "28", "800k", "1200k")...)
	args = append(args, "-an", redThenBlue)
	if out, err := exec.Command(ffmpegBin, args...).CombinedOutput(); err != nil {
		t.Fatalf("generate red-then-blue clip: %v\n%s", err, string(out))
	}
	poster1 := filepath.Join(dir, "poster1.jpg")
	if err := ExtractVideoPoster(context.Background(), redThenBlue, poster1, 1024); err != nil {
		t.Fatalf("ExtractVideoPoster (non-black frame 0): %v", err)
	}
	img1, fmt1, err := decodePosterFile(poster1)
	if err != nil || fmt1 != "jpeg" {
		t.Fatalf("decode poster1: format=%q err=%v", fmt1, err)
	}
	r1, _, b1, _ := img1.At(80, 45).RGBA()
	if r1>>8 <= (b1>>8)+60 {
		t.Fatalf("expected frame 0 (red) to be preserved, got R=%d B=%d", r1>>8, b1>>8)
	}

	// 2. Pure-black lead-in (black 0.0-0.15s, then blue 0.15-0.6s):
	//    ExtractVideoPoster detects black frame 0 and falls forward to 0.2s (blue).
	blackThenBlue := filepath.Join(dir, "black-then-blue.mp4")
	args2 := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-f", "lavfi", "-i", "color=c=black:s=160x90:r=20:d=0.15",
		"-f", "lavfi", "-i", "color=c=blue:s=160x90:r=20:d=0.45",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
		"-map", "[v]",
	}
	args2 = append(args2, PreferredH264VideoArgs(ffmpegBin, "ultrafast", "28", "800k", "1200k")...)
	args2 = append(args2, "-an", blackThenBlue)
	if out, err := exec.Command(ffmpegBin, args2...).CombinedOutput(); err != nil {
		t.Fatalf("generate black-then-blue clip: %v\n%s", err, string(out))
	}
	poster2 := filepath.Join(dir, "poster2.jpg")
	if err := ExtractVideoPoster(context.Background(), blackThenBlue, poster2, 1024); err != nil {
		t.Fatalf("ExtractVideoPoster (black lead-in): %v", err)
	}
	img2, fmt2, err := decodePosterFile(poster2)
	if err != nil || fmt2 != "jpeg" {
		t.Fatalf("decode poster2: format=%q err=%v", fmt2, err)
	}
	r2, _, b2, _ := img2.At(80, 45).RGBA()
	if b2>>8 <= (r2>>8)+60 {
		t.Fatalf("expected black lead-in to advance to 0.2s (blue), got R=%d B=%d", r2>>8, b2>>8)
	}

	// 3. Ultra-short all-black clip (< 0.2s): 0.2s fallback fails past EOF, frame 0 is retained.
	shortBlack := filepath.Join(dir, "short-black.mp4")
	makePosterTestClip(t, ffmpegBin, shortBlack, "color=c=black:s=160x90:r=20:d=0.1")
	poster3 := filepath.Join(dir, "poster3.jpg")
	if err := ExtractVideoPoster(context.Background(), shortBlack, poster3, 1024); err != nil {
		t.Fatalf("ExtractVideoPoster (ultra-short black clip): %v", err)
	}
	if _, fmt3, err := decodePosterFile(poster3); err != nil || fmt3 != "jpeg" {
		t.Fatalf("decode poster3: format=%q err=%v", fmt3, err)
	}
}

func decodePosterFile(path string) (image.Image, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	return image.Decode(bytes.NewReader(raw))
}
