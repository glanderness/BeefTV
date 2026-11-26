package operations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	xdraw "golang.org/x/image/draw"
)

const (
	pdfScannedMaxPages      = 6
	pdfScannedMaxTotalBytes = 3 << 20 // 3 MiB aggregate raw image budget across extracted pages
	pdfScannedMaxEdgePx     = 1280
	pdfScannedMinEdgePx     = 64
	pdfScannedMaxPixels     = 64_000_000 // guard against decompression-bomb JPEG dimensions
)

// extractScannedPDFImages extracts page images from image-only / scanned PDFs.
// It first inspects embedded JPEG streams directly in pure Go (zero external
// binaries, works identically on Windows/macOS/Linux), and falls back to
// `pdftoppm` when installed for Flate/JBIG2/CCITT-encoded scans.
func extractScannedPDFImages(ctx context.Context, data []byte, maxPages, maxTotalBytes int) ([]fileReadImage, bool) {
	if maxPages <= 0 {
		maxPages = pdfScannedMaxPages
	}
	if maxTotalBytes <= 0 {
		maxTotalBytes = pdfScannedMaxTotalBytes
	}
	if imgs, more := extractEmbeddedPDFJPEGs(ctx, data, maxPages, maxTotalBytes); len(imgs) > 0 {
		return imgs, more
	}
	return extractPDFImagesViaPdftoppm(ctx, data, maxPages, maxTotalBytes)
}

func extractEmbeddedPDFJPEGs(ctx context.Context, data []byte, maxPages, maxTotalBytes int) ([]fileReadImage, bool) {
	var out []fileReadImage
	seen := make(map[[32]byte]struct{})
	totalBytes := 0
	morePages := false
	search := data
	for len(search) > 0 {
		if ctx != nil && ctx.Err() != nil {
			break
		}
		idx := bytes.Index(search, []byte("stream"))
		if idx < 0 {
			break
		}
		rest := search[idx+6:]
		if bytes.HasPrefix(rest, []byte("\r\n")) {
			rest = rest[2:]
		} else if bytes.HasPrefix(rest, []byte("\n")) {
			rest = rest[1:]
		} else {
			search = rest
			continue
		}
		endIdx := bytes.Index(rest, []byte("endstream"))
		if endIdx < 0 {
			break
		}
		rawStream := bytes.TrimSpace(rest[:endIdx])
		search = rest[endIdx+9:]
		if len(rawStream) < 128 || rawStream[0] != 0xFF || rawStream[1] != 0xD8 || rawStream[2] != 0xFF {
			continue
		}
		eoi := bytes.LastIndex(rawStream, []byte{0xFF, 0xD9})
		if eoi < 0 {
			continue
		}
		jpegBytes := rawStream[:eoi+2]
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(jpegBytes))
		if err != nil || cfg.Width < pdfScannedMinEdgePx || cfg.Height < pdfScannedMinEdgePx || int64(cfg.Width)*int64(cfg.Height) > pdfScannedMaxPixels {
			continue
		}
		sum := sha256.Sum256(jpegBytes)
		if _, dup := seen[sum]; dup {
			continue
		}
		seen[sum] = struct{}{}
		if len(out) >= maxPages {
			morePages = true
			break
		}
		normalized, w, h, ok := normalizeScannedJPEG(jpegBytes, cfg.Width, cfg.Height)
		if !ok {
			continue
		}
		if totalBytes+len(normalized) > maxTotalBytes {
			morePages = true
			break
		}
		totalBytes += len(normalized)
		out = append(out, fileReadImage{
			Page:     len(out) + 1,
			MimeType: "image/jpeg",
			Data:     base64.StdEncoding.EncodeToString(normalized),
			Width:    w,
			Height:   h,
		})
	}
	return out, morePages
}

func normalizeScannedJPEG(raw []byte, width, height int) ([]byte, int, int, bool) {
	if width <= 0 || height <= 0 || int64(width)*int64(height) > pdfScannedMaxPixels {
		return nil, 0, 0, false
	}
	if width <= pdfScannedMaxEdgePx && height <= pdfScannedMaxEdgePx && len(raw) <= 600*1024 {
		return raw, width, height, true
	}
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, false
	}
	bounds := img.Bounds()
	bw, bh := bounds.Dx(), bounds.Dy()
	if bw <= 0 || bh <= 0 {
		return nil, 0, 0, false
	}
	target := img
	tw, th := bw, bh
	if bw > pdfScannedMaxEdgePx || bh > pdfScannedMaxEdgePx {
		if bw >= bh {
			tw = pdfScannedMaxEdgePx
			th = max(1, bh*pdfScannedMaxEdgePx/bw)
		} else {
			th = pdfScannedMaxEdgePx
			tw = max(1, bw*pdfScannedMaxEdgePx/bh)
		}
		target = resizeBiLinearRGBA(img, tw, th)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, target, &jpeg.Options{Quality: 78}); err != nil {
		return nil, 0, 0, false
	}
	return buf.Bytes(), tw, th, true
}

func resizeBiLinearRGBA(src image.Image, dstW, dstH int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	xdraw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	return dst
}

func extractPDFImagesViaPdftoppm(ctx context.Context, data []byte, maxPages, maxTotalBytes int) ([]fileReadImage, bool) {
	bin, err := exec.LookPath("pdftoppm")
	if err != nil || bin == "" {
		return nil, false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	tmpDir, err := os.MkdirTemp("", "beeftv-pdf-pages-*")
	if err != nil {
		return nil, false
	}
	defer os.RemoveAll(tmpDir)
	inPath := filepath.Join(tmpDir, "input.pdf")
	if err := os.WriteFile(inPath, data, 0o600); err != nil {
		return nil, false
	}
	outPrefix := filepath.Join(tmpDir, "page")
	runCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, bin, "-jpeg", "-r", "120", "-f", "1", "-l", strconv.Itoa(maxPages+1), inPath, outPrefix)
	if err := cmd.Run(); err != nil {
		return nil, false
	}
	matches, err := filepath.Glob(outPrefix + "-*.jpg")
	if err != nil || len(matches) == 0 {
		return nil, false
	}
	sort.Strings(matches)
	var out []fileReadImage
	totalBytes := 0
	morePages := len(matches) > maxPages
	for _, match := range matches {
		if len(out) >= maxPages {
			morePages = true
			break
		}
		raw, err := os.ReadFile(match)
		if err != nil || len(raw) == 0 {
			continue
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(raw))
		if err != nil {
			continue
		}
		normalized, w, h, ok := normalizeScannedJPEG(raw, cfg.Width, cfg.Height)
		if !ok {
			continue
		}
		if totalBytes+len(normalized) > maxTotalBytes {
			morePages = true
			break
		}
		totalBytes += len(normalized)
		out = append(out, fileReadImage{
			Page:     len(out) + 1,
			MimeType: "image/jpeg",
			Data:     base64.StdEncoding.EncodeToString(normalized),
			Width:    w,
			Height:   h,
		})
	}
	return out, morePages
}
