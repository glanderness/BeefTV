package generation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/playback"
)

const (
	beefTVSeedanceImageMaxBytes = int64(30 << 20)
	beefTVSeedanceVideoMaxBytes = int64(200 << 20)
	beefTVSeedanceAudioMaxBytes = int64(15 << 20)
)

var (
	errBeefTVSeedanceUploadUnavailable = errors.New("暂时无法接收参考素材")
	errBeefTVSeedanceUploadIncomplete  = beeftv.ErrUploadIncomplete
	errBeefTVSeedanceUploadFormat      = errors.New("无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。")
	errBeefTVSeedanceUploadEmpty       = errors.New("参考素材为空，请重新导入")
)

const (
	BeefTVSeedanceImageMaxBytes = beefTVSeedanceImageMaxBytes
	BeefTVSeedanceVideoMaxBytes = beefTVSeedanceVideoMaxBytes
)

var (
	ErrBeefTVSeedanceUploadUnavailable = errBeefTVSeedanceUploadUnavailable
	ErrBeefTVSeedanceUploadIncomplete  = errBeefTVSeedanceUploadIncomplete
)

type BeefTVSeedanceMediaReader func(kind string, media Media) (data []byte, mime string, skip bool, err error)

type BeefTVSeedanceUploadSession = beeftv.UploadSession
type BeefTVSeedanceUploadComplete = beeftv.UploadedMedia
type BeefTVSeedanceUploadRequest = beeftv.UploadRequest
type BeefTVSeedanceMultipartPlan = beeftv.UploadPlan
type BeefTVSeedanceUploadPart = beeftv.UploadPart

// PrepareBeefTVVideoReferences uploads built-in BeefTV local/inline
// references through the same generation key, then rewrites each item to the
// completed HTTPS URL. PUT uses only the returned headers and known length.
// Managed uploads must finish before dispatch. Storage failures never send the
// same large bytes back through the gateway as an inline generation request.
func PrepareBeefTVVideoReferences(ctx context.Context, config Config, input *Input, read BeefTVSeedanceMediaReader) error {
	if input == nil || (input.Mode != "" && input.Mode != "video" && input.Upscale == nil) || (!managedConnection(config) && !IsBeefTVVideoConfig(ctx, config)) {
		return nil
	}
	runtime, _ := RuntimeFromContext(ctx)
	if read == nil {
		read = ReadBeefTVSeedanceInlineMedia
	}
	for _, group := range BeefTVSeedanceMediaGroups(input) {
		for index := range group.items {
			media := &group.items[index]
			if strings.HasPrefix(media.URL, "asset://") {
				if managedConnection(config) || requiresBeefTVHTTPReferences(ctx, config) {
					return RequestPreparationError{Cause: errors.New("当前模型需要可访问的参考素材链接，请重新导入。本次尚未开始生成")}
				}
				continue
			}
			uploadCtx := withReferenceUpload(ctx, ReferenceUploadMeta{Kind: group.kind, Index: index + 1})
			client := managedMediaClient(uploadCtx, config)
			client.ReferenceUploaded = func(_ beeftv.LocalMediaReference, uploaded beeftv.UploadedMedia) {
				media.Bytes, media.MimeType = uploaded.Bytes, uploaded.Mime
			}
			client.InspectReference = func(_ context.Context, ref beeftv.LocalMediaReference, source io.ReaderAt, size int64, _ string) error {
				media.Bytes = size
				if group.kind == "image" && (media.Width <= 0 || media.Height <= 0) {
					if w, h, err := imageHeaderDimensions(io.NewSectionReader(source, 0, size)); err == nil {
						media.Width, media.Height = w, h
					}
				}
				if group.kind == "video" && (media.Width <= 0 || media.Height <= 0 || media.DurationMs <= 0) {
					w, h, duration := playback.ProbeVideoReader(source, size)
					if w > 0 && h > 0 {
						media.Width, media.Height = w, h
					}
					if duration > 0 {
						media.DurationMs = duration
					}
				}
				return validateSeedanceReferenceCapability(input, group.kind, index, *media, size)
			}
			if runtime.Resources == nil && read != nil {
				client.Open = func(_ context.Context, _ string) (io.ReadCloser, string, int64, error) {
					data, mime, skip, err := read(group.kind, *media)
					if err != nil {
						return nil, "", 0, err
					}
					if skip {
						return nil, "", 0, errors.New("参考素材未能读取")
					}
					return io.NopCloser(bytes.NewReader(data)), mime, int64(len(data)), nil
				}
			}
			ref := beeftv.LocalMediaReference{MediaReference: beeftv.MediaReference{Kind: group.kind, Role: referenceMediaLabel(group.kind, index), URL: media.URL}, StorageKey: media.StorageKey, DataURL: media.DataURL, MIME: media.MimeType, Bytes: media.Bytes}
			if runtime.Resources == nil && read != nil && !IsPublicMediaURL(ref.URL) && !strings.HasPrefix(firstNonEmpty(ref.DataURL, ref.URL), "data:") {
				ref.StorageKey = "legacy-reader"
			}
			if ref.StorageKey == "" && ref.DataURL == "" && ref.URL == "" {
				ref.StorageKey = "legacy-reader"
			}
			if input.VideoCapability != nil {
				switch group.kind {
				case "image":
					ref.MaxBytes = input.VideoCapability.References.MaxImageBytes
				case "video":
					ref.MaxBytes = input.VideoCapability.References.MaxVideoBytes
				case "audio":
					ref.MaxBytes = input.VideoCapability.References.MaxAudioBytes
				}
			}
			if ref.MaxBytes > 0 && ref.Bytes > ref.MaxBytes {
				return RequestPreparationError{Cause: fmt.Errorf("参考素材文件不能超过 %.0fMB", float64(ref.MaxBytes)/(1<<20))}
			}
			link, err := client.UploadReference(uploadCtx, ref)
			if err != nil {
				upload := referenceMediaUploadError(uploadCtx, err)
				if BeefTVSeedancePreuploadUnavailable(upload) {
					upload.Detail = "参考素材上传暂不可用，本次尚未开始生成。请稍后重试或使用可访问的图片链接"
				}
				return RequestPreparationError{Cause: upload}
			}
			media.URL = link
			media.DataURL = ""
			media.StorageKey = ""
		}
	}
	return nil
}

type BeefTVSeedanceMediaGroup struct {
	kind  string
	items []Media
}

func BeefTVSeedanceMediaGroups(input *Input) []BeefTVSeedanceMediaGroup {
	return []BeefTVSeedanceMediaGroup{
		{"image", input.ReferenceImages},
		{"video", input.ReferenceVideos},
		{"audio", input.ReferenceAudios},
	}
}

func SkipBeefTVSeedanceMedia(media Media) bool {
	value := strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "asset://") {
		return true
	}
	return IsPublicMediaURL(value)
}

func ReadBeefTVSeedanceInlineMedia(_ string, media Media) ([]byte, string, bool, error) {
	if SkipBeefTVSeedanceMedia(media) {
		return nil, "", true, nil
	}
	if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
		mimeType, data, err := DecodeProviderDataURL(raw)
		if err != nil {
			return nil, "", false, err
		}
		return data, firstNonEmpty(media.MimeType, mimeType), false, nil
	}
	if strings.HasPrefix(media.StorageKey, "resource:") {
		return nil, "", false, errors.New("参考素材未能读取，请重新提交")
	}
	return nil, "", true, nil
}

func ownedSeedanceMediaReader(ctx context.Context, userID string) BeefTVSeedanceMediaReader {
	return func(kind string, media Media) ([]byte, string, bool, error) {
		if SkipBeefTVSeedanceMedia(media) {
			return nil, "", true, nil
		}
		if raw := firstNonEmpty(media.DataURL, media.URL); strings.HasPrefix(strings.TrimSpace(raw), "data:") {
			return ReadBeefTVSeedanceInlineMedia(kind, media)
		}
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return nil, "", true, nil
		}
		if media.Bytes > 0 {
			if err := ValidateBeefTVSeedanceMediaSize(kind, media.Bytes); err != nil {
				return nil, "", false, err
			}
		}
		runtime, ok := RuntimeFromContext(ctx)
		if !ok || runtime.Resources == nil {
			return nil, "", false, errors.New("读取任务参考资源失败：资源端口未接入")
		}
		resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
		resource, body, err := runtime.Resources.Open(userID, resourceID)
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		defer body.Close()
		max := BeefTVSeedanceKindMaxBytes(kind)
		data, err := io.ReadAll(io.LimitReader(body, max+1))
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		return data, firstNonEmpty(media.MimeType, resource.MimeType), false, nil
	}
}

func validateSeedanceReferenceCapability(input *Input, kind string, index int, media Media, size int64) error {
	if input.VideoCapability == nil {
		return nil
	}
	media.Bytes = size
	refs := input.VideoCapability.References
	switch kind {
	case "image":
		return validateVideoReferenceImage(refs, index, media)
	case "video":
		return validateVideoReferenceVideo(refs, index, media)
	}
	return nil
}

func BeefTVSeedancePreuploadUnavailable(err error) bool {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	return httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusNotImplemented
}

func BeefTVSeedanceKindMaxBytes(kind string) int64 {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return beefTVSeedanceImageMaxBytes
	case "video":
		return beefTVSeedanceVideoMaxBytes
	case "audio":
		return beefTVSeedanceAudioMaxBytes
	default:
		return 0
	}
}

func ValidateBeefTVSeedanceMediaSize(kind string, size int64) error {
	if size <= 0 {
		return errBeefTVSeedanceUploadEmpty
	}
	max := BeefTVSeedanceKindMaxBytes(kind)
	if max <= 0 {
		return errBeefTVSeedanceUploadFormat
	}
	if size > max {
		switch kind {
		case "image":
			return errors.New("参考图片不能超过 30MB")
		case "video":
			return errors.New("参考视频不能超过 200MB")
		case "audio":
			return errors.New("参考音频不能超过 15MB")
		default:
			return errBeefTVSeedanceUploadFormat
		}
	}
	return nil
}
