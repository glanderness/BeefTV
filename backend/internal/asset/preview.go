package asset

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"
	"gorm.io/gorm"
)

const (
	previewCacheVersion           = "v1"
	previewJPEGQuality            = 84
	maxSubprocessPreviewPixels    = 256_000_000 // Hard ceiling matching ffmpeg -max_pixels
	maxSubprocessPreviewDimension = 32768
	maxInProcessPreviewPixels     = 24_000_000 // >24MP scales via OS-isolated ffmpeg subprocess
	maxInProcessPreviewFileBytes  = 32 << 20   // >32MiB source files scale via ffmpeg subprocess
	maxPreviewDecodeBudgetBytes   = 256 << 20  // 256 MiB global FIFO weighted decode memory cap
	minPreviewDecodeWeightBytes   = 64 << 20   // Caps concurrent lightweight jobs to <=4
	subprocessPosterWeightBytes   = 86 << 20   // Caps concurrent video posters to <=2
	DefaultAssetMaxChunkBytes     int64 = 4 << 20 // 4 MiB cap for Wails AssetServer fallback ranges
)

var allowedPreviewWidths = [...]int{256, 512, 1024, 2048}

type PreviewColorMode string

const (
	PreviewColorPreserve PreviewColorMode = "preserve"
	PreviewColorSRGB     PreviewColorMode = "srgb"
)

type PreviewResult struct {
	Path       string
	MimeType   string
	Size       int64
	IsOriginal bool
	Immutable  bool
}

type decodeMemoryBudget struct {
	limitBytes int64
	sem        *semaphore.Weighted
}

func newDecodeMemoryBudget(limitBytes int64) *decodeMemoryBudget {
	return &decodeMemoryBudget{
		limitBytes: limitBytes,
		sem:        semaphore.NewWeighted(limitBytes),
	}
}

func (b *decodeMemoryBudget) Acquire(ctx context.Context, bytes int64) (func(), error) {
	if b == nil || b.sem == nil {
		return func() {}, nil
	}
	weight := bytes
	if weight < minPreviewDecodeWeightBytes {
		weight = minPreviewDecodeWeightBytes
	}
	if weight > b.limitBytes {
		weight = b.limitBytes
	}
	if err := b.sem.Acquire(ctx, weight); err != nil {
		return nil, err
	}
	var once sync.Once
	return func() {
		once.Do(func() { b.sem.Release(weight) })
	}, nil
}

type previewManager struct {
	dataDir    string
	flight     singleflight.Group
	budget     *decodeMemoryBudget
	scaleImage func(ctx context.Context, srcPath, dstPath string, maxSide, orientation int, outputPNG bool) error
}

func newPreviewManager(dataDir string) *previewManager {
	return &previewManager{
		dataDir:    strings.TrimSpace(dataDir),
		budget:     newDecodeMemoryBudget(maxPreviewDecodeBudgetBytes),
		scaleImage: mediatools.ScaleImagePreview,
	}
}

// NormalizePreviewWidth snaps arbitrary requested dimensions onto the discrete
// server-side catalog so disk caches stay bounded and shareable across nodes.
func NormalizePreviewWidth(requested int) int {
	if requested <= 0 {
		return 512
	}
	for _, tier := range allowedPreviewWidths {
		if requested <= tier {
			return tier
		}
	}
	return allowedPreviewWidths[len(allowedPreviewWidths)-1]
}

func NormalizePreviewColorMode(raw string) PreviewColorMode {
	if strings.EqualFold(strings.TrimSpace(raw), string(PreviewColorSRGB)) {
		return PreviewColorSRGB
	}
	return PreviewColorPreserve
}

// ClampByteRange limits single-range requests to maxBytes so custom asset
// handlers that buffer responses in memory never allocate full multi-hundred-MB
// videos on open-ended Range: bytes=N- requests, while preserving Safari's
// 2-byte Range: bytes=0-1 probe and exact small ranges.
func ClampByteRange(rangeHeader string, size int64, maxBytes int64) string {
	normalized := NormalizeSingleByteRange(rangeHeader)
	if normalized == "" || size <= 0 || maxBytes <= 0 {
		return normalized
	}
	start, end, ok := parseNormalizedByteRange(normalized, size)
	if !ok {
		return normalized
	}
	if end-start+1 > maxBytes {
		end = start + maxBytes - 1
		if end >= size {
			end = size - 1
		}
	}
	return fmt.Sprintf("bytes=%d-%d", start, end)
}

func (s *Service) MediaTickets() *MediaTicketStore {
	if s == nil {
		return nil
	}
	return s.tickets
}

// OpenClampedRange serves a local resource with an enforced byte-chunk ceiling.
// Used only for the same-origin AssetServer fallback when loopback TCP is unavailable.
func (s *Service) OpenClampedRange(userID, id, rangeHeader string, maxBytes int64) (*ResourceStream, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ResourceNotFound()
		}
		return nil, err
	}
	return s.OpenOwnedClampedRange(userID, resource, rangeHeader, maxBytes)
}

func (s *Service) OpenOwnedClampedRange(userID string, resource *model.Resource, rangeHeader string, maxBytes int64) (*ResourceStream, error) {
	if resource == nil {
		return nil, ResourceMissing()
	}
	if maxBytes <= 0 {
		maxBytes = DefaultAssetMaxChunkBytes
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, ResourceNotReady()
	}
	if resource.Provider != "local" {
		return nil, ResourceNotLocal()
	}
	if s == nil || s.blobs == nil {
		return nil, errors.New("local resource store is not initialized")
	}
	body, err := s.blobs.Open(resource.ObjectKey)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ResourceFileMissing()
		}
		return nil, err
	}
	info, err := body.Stat()
	if err != nil {
		_ = body.Close()
		return nil, err
	}
	size := info.Size()
	normalized := NormalizeSingleByteRange(rangeHeader)
	if normalized == "" {
		if size > maxBytes {
			_ = body.Close()
			return &ResourceStream{
				Resource:      resource,
				Body:          io.NopCloser(bytes.NewReader(nil)),
				StatusCode:    http.StatusRequestedRangeNotSatisfiable,
				ContentLength: 0,
				ContentRange:  fmt.Sprintf("bytes */%d", size),
				AcceptRanges:  "bytes",
			}, nil
		}
		return &ResourceStream{
			Resource:      resource,
			Body:          body,
			StatusCode:    http.StatusOK,
			ContentLength: size,
			AcceptRanges:  "bytes",
		}, nil
	}
	_ = body.Close()
	clamped := ClampByteRange(normalized, size, maxBytes)
	return s.OpenOwnedRange(userID, resource, clamped)
}

// OpenImagePreview returns a disk-cached downscaled JPEG/PNG display preview
// (preserving ICC profiles when color=preserve and rotating EXIF orientation).
// Animated GIF/APNG/WebP, SVG, or already-smaller images safely fall back to the original.
func (s *Service) OpenImagePreview(ctx context.Context, userID, resourceID string, width int, color PreviewColorMode) (*PreviewResult, error) {
	if s == nil || s.repo == nil || s.blobs == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ResourceNotFound()
		}
		return nil, err
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, ResourceNotReady()
	}
	if resource.Provider != "local" {
		return nil, ResourceNotLocal()
	}
	tier := NormalizePreviewWidth(width)
	color = NormalizePreviewColorMode(string(color))

	if s.previews != nil && s.previews.dataDir != "" {
		if hit := s.lookupCachedPreview(userID, resource.ID, tier, color); hit != nil {
			return hit, nil
		}
	}

	if !canGenerateImagePreview(resource.MimeType) {
		return s.originalPreviewResult(resource)
	}

	key := fmt.Sprintf("img:%s:%s:%d:%s", userID, resource.ID, tier, color)
	if s.previews == nil || s.previews.dataDir == "" {
		return s.originalPreviewResult(resource)
	}
	val, err, _ := s.previews.flight.Do(key, func() (any, error) {
		if hit := s.lookupCachedPreview(userID, resource.ID, tier, color); hit != nil {
			return hit, nil
		}
		return s.generateImagePreview(ctx, userID, resource, tier, color)
	})
	if err != nil {
		return nil, err
	}
	return val.(*PreviewResult), nil
}

// OpenVideoPoster returns a disk-cached JPEG poster frame generated via ffmpeg.
func (s *Service) OpenVideoPoster(ctx context.Context, userID, resourceID string) (*PreviewResult, error) {
	if s == nil || s.repo == nil || s.blobs == nil {
		return nil, ResourceMissing()
	}
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ResourceNotFound()
		}
		return nil, err
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, ResourceNotReady()
	}
	if resource.Provider != "local" {
		return nil, ResourceNotLocal()
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(resource.MimeType)), "video/") && resource.Kind != "video" {
		return nil, ResourceMissing()
	}
	if s.previews == nil || s.previews.dataDir == "" {
		return nil, errors.New("预览缓存目录未初始化")
	}
	posterPath := s.posterFilePath(userID, resource.ID)
	if info, err := os.Stat(posterPath); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		return &PreviewResult{Path: posterPath, MimeType: "image/jpeg", Size: info.Size(), Immutable: true}, nil
	}
	key := fmt.Sprintf("poster:%s:%s", userID, resource.ID)
	val, err, _ := s.previews.flight.Do(key, func() (any, error) {
		if info, statErr := os.Stat(posterPath); statErr == nil && info.Mode().IsRegular() && info.Size() > 0 {
			return &PreviewResult{Path: posterPath, MimeType: "image/jpeg", Size: info.Size(), Immutable: true}, nil
		}
		release, acquireErr := s.previews.budget.Acquire(ctx, subprocessPosterWeightBytes)
		if acquireErr != nil {
			return nil, acquireErr
		}
		defer release()
		srcFile, openErr := s.blobs.Open(resource.ObjectKey)
		if openErr != nil {
			if errors.Is(openErr, os.ErrNotExist) {
				return nil, ResourceFileMissing()
			}
			return nil, openErr
		}
		srcPath := srcFile.Name()
		_ = srcFile.Close()
		if err := mediatools.ExtractVideoPoster(ctx, srcPath, posterPath, 1024); err != nil {
			return nil, err
		}
		info, statErr := os.Stat(posterPath)
		if statErr != nil || info.Size() == 0 {
			return nil, errors.New("视频封面生成失败")
		}
		return &PreviewResult{Path: posterPath, MimeType: "image/jpeg", Size: info.Size(), Immutable: true}, nil
	})
	if err != nil {
		return nil, err
	}
	return val.(*PreviewResult), nil
}

// RemovePreviewCache deletes all derived previews/posters for a deleted resource.
func (s *Service) RemovePreviewCache(userID, resourceID string) {
	if s == nil || s.previews == nil || s.previews.dataDir == "" {
		return
	}
	dir := s.previewResourceDir(userID, resourceID)
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
}

func (s *Service) previewResourceDir(userID, resourceID string) string {
	if s == nil || s.previews == nil || s.previews.dataDir == "" {
		return ""
	}
	u := safePathSegment(userID)
	r := safePathSegment(resourceID)
	if u == "" || r == "" {
		return ""
	}
	return filepath.Join(s.previews.dataDir, "cache", "previews", u, r)
}

func (s *Service) previewFilePath(userID, resourceID string, tier int, color PreviewColorMode, ext string) string {
	return filepath.Join(s.previewResourceDir(userID, resourceID), fmt.Sprintf("preview-%d-%s-%s.%s", tier, color, previewCacheVersion, ext))
}

func (s *Service) posterFilePath(userID, resourceID string) string {
	return filepath.Join(s.previewResourceDir(userID, resourceID), fmt.Sprintf("poster-%s.jpg", previewCacheVersion))
}

func (s *Service) lookupCachedPreview(userID, resourceID string, tier int, color PreviewColorMode) *PreviewResult {
	for _, item := range []struct {
		ext  string
		mime string
	}{
		{"jpg", "image/jpeg"},
		{"png", "image/png"},
	} {
		path := s.previewFilePath(userID, resourceID, tier, color, item.ext)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			return &PreviewResult{Path: path, MimeType: item.mime, Size: info.Size(), Immutable: true}
		}
	}
	return nil
}

func (s *Service) originalPreviewResult(resource *model.Resource) (*PreviewResult, error) {
	return s.originalPreviewResultWithCache(resource, false)
}

func (s *Service) originalPreviewResultWithCache(resource *model.Resource, immutable bool) (*PreviewResult, error) {
	file, err := s.blobs.Open(resource.ObjectKey)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ResourceFileMissing()
		}
		return nil, err
	}
	path := file.Name()
	info, statErr := file.Stat()
	_ = file.Close()
	if statErr != nil {
		return nil, statErr
	}
	mimeType := strings.TrimSpace(resource.MimeType)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return &PreviewResult{Path: path, MimeType: mimeType, Size: info.Size(), IsOriginal: true, Immutable: immutable}, nil
}

func (s *Service) generateImagePreview(ctx context.Context, userID string, resource *model.Resource, tier int, color PreviewColorMode) (*PreviewResult, error) {
	srcFile, err := s.blobs.Open(resource.ObjectKey)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ResourceFileMissing()
		}
		return nil, err
	}
	srcPath := srcFile.Name()
	info, statErr := srcFile.Stat()
	if statErr != nil {
		_ = srcFile.Close()
		return nil, statErr
	}
	fileSize := info.Size()

	// Probe dimensions strictly from the stream header before allocating any
	// full-image buffer or acquiring decode budget.
	cfg, _, cfgErr := image.DecodeConfig(srcFile)
	if cfgErr != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		_ = srcFile.Close()
		if fileSize > maxInProcessPreviewFileBytes {
			return nil, PreviewUnavailable()
		}
		return s.originalPreviewResult(resource)
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	if cfg.Width > maxSubprocessPreviewDimension || cfg.Height > maxSubprocessPreviewDimension || pixels > maxSubprocessPreviewPixels {
		_ = srcFile.Close()
		// Refuse to hand an extreme (>256MP) raw original directly to WebView2.
		return nil, PreviewUnavailable()
	}

	if _, seekErr := srcFile.Seek(0, io.SeekStart); seekErr != nil {
		_ = srcFile.Close()
		return nil, seekErr
	}
	headerBytes, headerErr := readPreviewMetadataHeader(srcFile)
	_ = srcFile.Close()
	if headerErr != nil {
		return nil, headerErr
	}

	lowerMime := strings.ToLower(strings.TrimSpace(resource.MimeType))
	// Large GIFs (>5 MiB header cap) or detected multi-frame GIF/APNG/WebP are
	// served untouched so animations are never flattened.
	if (lowerMime == "image/gif" && fileSize > maxPreviewHeaderBytes) || isAnimatedImage(resource.MimeType, headerBytes) {
		return s.originalPreviewResultWithCache(resource, true)
	}

	orientation := extractJPEGEXIFOrientation(headerBytes)
	effW, effH := cfg.Width, cfg.Height
	if orientation >= 5 && orientation <= 8 {
		effW, effH = effH, effW
	}
	maxSide := max(effW, effH)
	if maxSide <= tier && orientation <= 1 && (lowerMime == "image/jpeg" || lowerMime == "image/png" || lowerMime == "image/webp") {
		return s.originalPreviewResultWithCache(resource, true)
	}

	var icc []byte
	if color == PreviewColorPreserve {
		icc = extractICCProfile(resource.MimeType, headerBytes)
	}

	// Oversized images (>24MP or >32MiB, up to 256MP) scale in an OS-isolated
	// ffmpeg subprocess so Go heap never spikes on 50–256MP photos.
	if pixels > maxInProcessPreviewPixels || fileSize > maxInProcessPreviewFileBytes {
		return s.generateImagePreviewViaSubprocess(ctx, userID, resource, srcPath, pixels, tier, color, orientation, pngHeaderMayHaveAlpha(headerBytes), icc)
	}

	// Reserve exact decoded RGBA budget before opening the pixel stream.
	// We scale BEFORE EXIF rotation so orientation only allocates a tiny tier-sized buffer.
	estimatedBytes := pixels*4 + int64(tier)*int64(tier)*4
	release, acquireErr := s.previews.budget.Acquire(ctx, estimatedBytes)
	if acquireErr != nil {
		return nil, acquireErr
	}
	defer release()

	decodeFile, openErr := s.blobs.Open(resource.ObjectKey)
	if openErr != nil {
		if errors.Is(openErr, os.ErrNotExist) {
			return nil, ResourceFileMissing()
		}
		return nil, openErr
	}
	decoded, _, decErr := image.Decode(decodeFile)
	_ = decodeFile.Close()
	if decErr != nil {
		// Transient / unsupported decode fallback must never be pinned immutable.
		return s.originalPreviewResult(resource)
	}

	bounds := decoded.Bounds()
	srcW, srcH := bounds.Dx(), bounds.Dy()
	dstW, dstH := fitPreviewBounds(srcW, srcH, tier)

	var target image.Image = decoded
	if dstW < srcW || dstH < srcH {
		dst := image.NewNRGBA(image.Rect(0, 0, dstW, dstH))
		draw.BiLinear.Scale(dst, dst.Rect, decoded, bounds, draw.Src, nil)
		target = dst
	}
	if orientation > 1 {
		target = applyOrientation(target, orientation)
	}

	hasAlpha := imageHasAlpha(target)
	var encoded bytes.Buffer
	var ext, outMime string
	if hasAlpha {
		ext = "png"
		outMime = "image/png"
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&encoded, target); err != nil {
			return nil, err
		}
		if len(icc) > 0 {
			encoded = *bytes.NewBuffer(injectPNGICC(encoded.Bytes(), icc))
		}
	} else {
		ext = "jpg"
		outMime = "image/jpeg"
		if err := jpeg.Encode(&encoded, target, &jpeg.Options{Quality: previewJPEGQuality}); err != nil {
			return nil, err
		}
		if len(icc) > 0 {
			encoded = *bytes.NewBuffer(injectJPEGICC(encoded.Bytes(), icc))
		}
	}

	dstPath := s.previewFilePath(userID, resource.ID, tier, color, ext)
	if err := writeAtomicPreviewFile(dstPath, encoded.Bytes()); err != nil {
		return nil, err
	}
	return &PreviewResult{Path: dstPath, MimeType: outMime, Size: int64(encoded.Len()), Immutable: true}, nil
}

func (s *Service) generateImagePreviewViaSubprocess(
	ctx context.Context,
	userID string,
	resource *model.Resource,
	srcPath string,
	pixels int64,
	tier int,
	color PreviewColorMode,
	orientation int,
	outputPNG bool,
	icc []byte,
) (*PreviewResult, error) {
	if s.previews == nil || s.previews.scaleImage == nil {
		return nil, PreviewUnavailable()
	}
	// Weight subprocess reservation proportionally to source pixel decode footprint
	// so huge 64MP–256MP photos serialize (1 at a time) instead of running 3 ffmpeg
	// decoders concurrently on low-RAM Windows hosts.
	weight := pixels * 4
	if weight < subprocessPosterWeightBytes {
		weight = subprocessPosterWeightBytes
	}
	release, acquireErr := s.previews.budget.Acquire(ctx, weight)
	if acquireErr != nil {
		return nil, acquireErr
	}
	defer release()

	ext, outMime := "jpg", "image/jpeg"
	if outputPNG {
		ext, outMime = "png", "image/png"
	}
	dstPath := s.previewFilePath(userID, resource.ID, tier, color, ext)
	if err := s.previews.scaleImage(ctx, srcPath, dstPath, tier, orientation, outputPNG); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Never silently dump a >24MP / >32MiB raw original into WebView2 or pin it immutable.
		return nil, PreviewUnavailable()
	}
	if len(icc) > 0 {
		if outBytes, err := os.ReadFile(dstPath); err == nil && len(outBytes) > 0 {
			var patched []byte
			if outputPNG {
				patched = injectPNGICC(outBytes, icc)
			} else {
				patched = injectJPEGICC(outBytes, icc)
			}
			_ = writeAtomicPreviewFile(dstPath, patched)
		}
	}
	info, statErr := os.Stat(dstPath)
	if statErr != nil || info.Size() == 0 {
		return nil, PreviewUnavailable()
	}
	return &PreviewResult{Path: dstPath, MimeType: outMime, Size: info.Size(), Immutable: true}, nil
}

func fitPreviewBounds(w, h, maxSide int) (int, int) {
	if w <= 0 || h <= 0 || maxSide <= 0 {
		return max(1, w), max(1, h)
	}
	longest := max(w, h)
	if longest <= maxSide {
		return w, h
	}
	if w >= h {
		return maxSide, max(1, (h*maxSide+w/2)/w)
	}
	return max(1, (w*maxSide+h/2)/h), maxSide
}

func writeAtomicPreviewFile(dstPath string, data []byte) error {
	dir := filepath.Dir(dstPath)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".preview-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o640); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, dstPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func canGenerateImagePreview(mimeType string) bool {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func safePathSegment(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "." || raw == ".." {
		return ""
	}
	for _, ch := range raw {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return ""
	}
	return raw
}
