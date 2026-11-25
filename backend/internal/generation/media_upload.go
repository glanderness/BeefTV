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
	beefTVSeedanceImageMaxBytes  = int64(30 << 20)
	beefTVSeedanceVideoMaxBytes  = int64(200 << 20)
	beefTVMediaToolVideoMaxBytes = int64(1 << 30)
	beefTVSeedanceAudioMaxBytes  = int64(15 << 20)
)

var (
	errBeefTVSeedanceUploadUnavailable = errors.New("暂时无法接收参考素材")
	errBeefTVSeedanceUploadIncomplete  = beeftv.ErrUploadIncomplete
	errBeefTVSeedanceUploadFormat      = errors.New("无法识别文件。图片用 PNG、JPEG、WebP、GIF、BMP 或 TIFF。视频用 MP4 或 MOV。音频用 MP3 或 WAV。")
	errBeefTVSeedanceUploadEmpty       = errors.New("参考素材为空，请重新导入")
)

const (
	BeefTVSeedanceImageMaxBytes  = beefTVSeedanceImageMaxBytes
	BeefTVSeedanceVideoMaxBytes  = beefTVSeedanceVideoMaxBytes
	BeefTVMediaToolVideoMaxBytes = beefTVMediaToolVideoMaxBytes
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
					return RequestPreparationError{Cause: PreparationUserError{
						Category: CategoryInputInaccessible,
						Reason:   "当前模型需要可访问的参考素材链接，本次尚未开始生成",
						Action:   "请重新导入参考素材后重试",
					}}
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
			} else if group.kind == "video" {
				if toolMax := mediaToolVideoMaxBytes(ctx, input); toolMax > 0 {
					ref.MaxBytes = toolMax
					ref.Purpose = beeftv.UploadPurposeMediaTool
				}
			}
			if ref.MaxBytes > 0 && ref.Bytes > ref.MaxBytes {
				return RequestPreparationError{Cause: PreparationUserError{
					Category: CategoryInputTooLarge,
					Reason:   fmt.Sprintf("参考素材文件不能超过 %s", formatStorageLimit(ref.MaxBytes)),
					Action:   "请压缩或更换更小的参考素材后重试",
				}}
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

// NormalizeToolVideoLimit is the single source of truth for video-tool
// (upscale / smart-erase) upload byte ceilings: defaults safely to 200 MiB
// whenever upstream capabilities omit or fail to advertise max_video_bytes,
// and clamps to the 1 GiB hard ceiling. Local delivery budget (GeneratedFileLimit)
// is enforced separately with its own copy.
func NormalizeToolVideoLimit(declared int64) int64 {
	if declared <= 0 {
		return beefTVSeedanceVideoMaxBytes
	}
	if declared > beefTVMediaToolVideoMaxBytes {
		return beefTVMediaToolVideoMaxBytes
	}
	return declared
}

func mediaToolVideoMaxBytes(_ context.Context, input *Input) int64 {
	if input == nil {
		return 0
	}
	if input.Upscale != nil {
		return NormalizeToolVideoLimit(input.Upscale.MaxVideoBytes)
	}
	if input.SubtitleErase != nil {
		return NormalizeToolVideoLimit(input.SubtitleErase.MaxVideoBytes)
	}
	return 0
}

func ValidateBeefTVMediaToolSize(kind string, size, maxVideoBytes int64) error {
	if strings.EqualFold(strings.TrimSpace(kind), "video") {
		if size <= 0 {
			return PreparationUserError{Category: CategoryInvalidParams, Reason: "参考素材为空", Action: "请重新导入后重试", Cause: errBeefTVSeedanceUploadEmpty}
		}
		limit := NormalizeToolVideoLimit(maxVideoBytes)
		if size > limit {
			return PreparationUserError{
				Category: CategoryInputTooLarge,
				Reason:   fmt.Sprintf("参考视频不能超过 %s", formatStorageLimit(limit)),
				Action:   "请压缩或裁剪后重试",
			}
		}
		return nil
	}
	return ValidateBeefTVSeedanceMediaSize(kind, size)
}

func ValidateBeefTVSeedanceMediaSize(kind string, size int64) error {
	if size <= 0 {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "参考素材为空", Action: "请重新导入后重试", Cause: errBeefTVSeedanceUploadEmpty}
	}
	max := BeefTVSeedanceKindMaxBytes(kind)
	if max <= 0 {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: errBeefTVSeedanceUploadFormat.Error(), Cause: errBeefTVSeedanceUploadFormat}
	}
	if size > max {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "image":
			return PreparationUserError{Category: CategoryInputTooLarge, Reason: "参考图片不能超过 30MB", Action: "请压缩或裁剪后重试"}
		case "video":
			return PreparationUserError{Category: CategoryInputTooLarge, Reason: "参考视频不能超过 200MB", Action: "请压缩或裁剪后重试"}
		case "audio":
			return PreparationUserError{Category: CategoryInputTooLarge, Reason: "参考音频不能超过 15MB", Action: "请压缩或裁剪后重试"}
		default:
			return PreparationUserError{Category: CategoryInvalidParams, Reason: errBeefTVSeedanceUploadFormat.Error(), Cause: errBeefTVSeedanceUploadFormat}
		}
	}
	return nil
}
