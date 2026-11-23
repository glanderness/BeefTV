package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"regexp"
	"strings"
	"time"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/mediatools"

	_ "golang.org/x/image/webp"
)

type UpscaleOptions struct {
	Factor       int    `json:"factor"`
	OutputFormat string `json:"outputFormat,omitempty"`
}

func UpscaleMediaType(model string) string {
	switch model {
	case "topaz-standard-v2", "topaz-wonder-3.5":
		return "image"
	case "topaz-proteus", "topaz-starlight-fast-2":
		return "video"
	default:
		return ""
	}
}

func ValidateUpscaleInput(input Input) error {
	kind := input.Mode
	if (kind != "image" && kind != "video") || input.Config.Model == "" || input.Upscale == nil {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "超分模型、素材类型或参数无效", Action: "请重新选择超分模型和素材后重试"}
	}
	if input.Upscale.Factor < 1 || input.Upscale.Factor > 4 {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "放大倍数须为 1 至 4 的整数", Action: "请调整放大倍数后重试"}
	}
	if kind == "image" && (len(input.ReferenceImages) != 1 || len(input.ReferenceVideos) != 0) || kind == "video" && (len(input.ReferenceVideos) != 1 || len(input.ReferenceImages) != 0) || len(input.ReferenceAudios) != 0 || input.Mask != nil {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "每个超分任务需要一个同类型素材", Action: "请连接单个对应类型的图片或视频素材后重试"}
	}
	source := input.ReferenceImages
	if kind == "video" {
		source = input.ReferenceVideos
	}
	if !upscaleOwnedSource.MatchString(source[0].StorageKey) || source[0].URL != "" || source[0].DataURL != "" {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "超分只能使用当前素材库中的图片或视频", Action: "请先将素材导入素材库后重试"}
	}
	format := input.Upscale.OutputFormat
	if format != "" && format != "png" && format != "jpeg" {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "图片输出格式须为 PNG 或 JPEG", Action: "请调整输出格式后重试"}
	}
	return nil
}

var upscaleOwnedSource = regexp.MustCompile(`^resource:[A-Za-z0-9_-]{1,128}$`)

type UpscaleSourceFacts struct {
	Bytes      int64
	MIME       string
	Width      int
	Height     int
	DurationMs int64
	FrameRate  float64
}

// Preparation uses the existing owner-scoped media reader and gateway upload.
// Resuming an accepted task never uploads again or calls the create endpoint.
func PrepareUpscale(ctx context.Context, input Input) (Input, error) {
	input, err := prepareOwnedUpscaleSource(ctx, input)
	if err != nil {
		return input, err
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := PrepareBeefTVVideoReferences(ctx, input.Config, &input, ownedSeedanceMediaReader(ctx, runtime.Call.UserID)); err != nil {
		return input, err
	}
	return input, nil
}

func hydrateOwnedUpscaleInput(ctx context.Context, input Input) (Input, *Media, int64, error) {
	input.ReferenceImages = append([]Media(nil), input.ReferenceImages...)
	input.ReferenceVideos = append([]Media(nil), input.ReferenceVideos...)
	if err := ValidateUpscaleInput(input); err != nil {
		return input, nil, 0, err
	}
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return input, nil, 0, PreparationUserError{Category: CategoryAuth, Reason: "AI 超分需要连接官方算力账号", Action: "请先在设置中连接官方算力账号后重试"}
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := HydrateMedia(ctx, runtime.Call.UserID, &input, MediaHydrationPolicy{KeepLocal: true}); err != nil {
		return input, nil, 0, err
	}
	var media *Media
	if input.Mode == "video" {
		media = &input.ReferenceVideos[0]
	} else {
		media = &input.ReferenceImages[0]
	}
	if media.StorageKey == "" {
		return input, nil, 0, PreparationUserError{Category: CategoryInputInaccessible, Reason: "请先将素材导入素材库，再开始超分"}
	}
	deliveryLimit, err := GeneratedFileLimit(ctx)
	if err != nil {
		return input, nil, 0, err
	}
	return input, media, deliveryLimit, nil
}

// prepareUpscaleMetadata resolves and validates upscale facts for EstimateUpscale
// without uploading bytes to object storage. Whenever ResourcePort.Open yields an
// ownedLocalFile (*os.File), it runs the exact same zero-copy file/ffprobe check as submit.
func prepareUpscaleMetadata(ctx context.Context, input Input) (Input, UpscaleSourceFacts, error) {
	input, media, deliveryLimit, err := hydrateOwnedUpscaleInput(ctx, input)
	if err != nil {
		return input, UpscaleSourceFacts{}, err
	}
	kind := input.Mode
	factor := int64(input.Upscale.Factor)
	runtime, _ := RuntimeFromContext(ctx)
	var nonFileReader io.ReadCloser
	if runtime.Resources != nil {
		resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
		_, rc, openErr := runtime.Resources.Open(runtime.Call.UserID, resourceID)
		if openErr == nil {
			if file, ok := rc.(ownedLocalFile); ok {
				facts, localErr := validateLocalUpscaleFile(ctx, kind, media, rc, file, factor, deliveryLimit)
				return input, facts, localErr
			}
			nonFileReader = rc
			defer nonFileReader.Close()
		} else if runtime.Resources.LocalMode() {
			return input, UpscaleSourceFacts{}, localMediaOpenError(openErr)
		}
	}
	if err := ValidateBeefTVSeedanceMediaSize(kind, media.Bytes); err != nil {
		return input, UpscaleSourceFacts{}, err
	}
	if kind == "image" {
		mime := normalizedLowerMIME(media.MimeType)
		unknownMIME := mime == "" || mime == "application/octet-stream"
		missingDims := media.Width <= 0 || media.Height <= 0
		if (missingDims || unknownMIME) && nonFileReader != nil {
			w, h, probedMIME, cfgErr := probeImageHeader(nonFileReader)
			if cfgErr == nil && w > 0 && h > 0 {
				if missingDims {
					media.Width, media.Height = w, h
				}
				if unknownMIME && probedMIME != "" {
					mime = probedMIME
					media.MimeType = mime
					unknownMIME = false
				}
			}
		}
		if unknownMIME || media.Width <= 0 || media.Height <= 0 {
			return input, UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInvalidParams, Reason: "无法读取超分图片的尺寸或格式", Action: "请确认图片完整后重新导入重试"}
		}
		if err := validateUpscaleImagePreflight(mime, media.Width, media.Height, factor, deliveryLimit); err != nil {
			return input, UpscaleSourceFacts{}, err
		}
		return input, UpscaleSourceFacts{Bytes: media.Bytes, MIME: mime, Width: media.Width, Height: media.Height}, nil
	}
	if media.Bytes > deliveryLimit {
		return input, UpscaleSourceFacts{}, videoDeliveryLimitError(deliveryLimit)
	}
	if err := validateUpscaleVideoContainerMIME(media.MimeType); err != nil {
		return input, UpscaleSourceFacts{}, err
	}
	if media.Width <= 0 || media.Height <= 0 || media.DurationMs <= 0 {
		return input, UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInvalidParams, Reason: "无法读取超分视频的尺寸或时长", Action: "请确认视频完整后重新导入重试"}
	}
	if media.DurationMs > 300_000 {
		return input, UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInvalidParams, Reason: "超分视频须为不超过 5 分钟的 MP4 或 MOV", Action: "请裁剪时长或转码为 MP4/MOV 后重试"}
	}
	return input, UpscaleSourceFacts{
		Bytes:      media.Bytes,
		MIME:       normalizedLowerMIME(media.MimeType),
		Width:      media.Width,
		Height:     media.Height,
		DurationMs: media.DurationMs,
	}, nil
}

// prepareOwnedUpscaleSource validates an owned upscale source before upload/submission.
// Opens once and branches on ownedLocalFile regardless of workspace mode; non-file
// streams use bounded header/streaming checks without buffering 200 MiB in RAM.
func prepareOwnedUpscaleSource(ctx context.Context, input Input) (Input, error) {
	input, media, deliveryLimit, err := hydrateOwnedUpscaleInput(ctx, input)
	if err != nil {
		return input, err
	}
	kind := input.Mode
	factor := int64(input.Upscale.Factor)
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.Resources != nil && !runtime.Resources.LocalMode() && media.Bytes > 0 {
		if err := ValidateBeefTVSeedanceMediaSize(kind, media.Bytes); err != nil {
			return input, err
		}
		if kind == "video" && media.Bytes > deliveryLimit {
			return input, videoDeliveryLimitError(deliveryLimit)
		}
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	info, rc, openErr := runtime.Resources.Open(runtime.Call.UserID, resourceID)
	if openErr != nil {
		return input, localMediaOpenError(openErr)
	}
	if file, ok := rc.(ownedLocalFile); ok {
		_, localErr := validateLocalUpscaleFile(ctx, kind, media, rc, file, factor, deliveryLimit)
		return input, localErr
	}
	limit := BeefTVSeedanceKindMaxBytes(kind)
	if kind == "image" {
		defer rc.Close()
		var header bytes.Buffer
		headLen, err := io.CopyN(&header, rc, videoReferenceHeaderDecodeLimit)
		if err != nil && !errors.Is(err, io.EOF) {
			return input, localMediaOpenError(err)
		}
		restLen, err := io.Copy(io.Discard, io.LimitReader(rc, limit+1-headLen))
		if err != nil {
			return input, localMediaOpenError(err)
		}
		size := headLen + restLen
		if err := ValidateBeefTVSeedanceMediaSize("image", size); err != nil {
			return input, err
		}
		meta, cfgErr := upscaleImageConfig(header.Bytes())
		if cfgErr != nil {
			return input, cfgErr
		}
		mime := NormalizedMediaMIMEType(firstNonEmpty(media.MimeType, info.MimeType), header.Bytes())
		if err := validateUpscaleImagePreflight(mime, meta.Width, meta.Height, factor, deliveryLimit); err != nil {
			return input, err
		}
		media.Bytes, media.Width, media.Height, media.MimeType = size, meta.Width, meta.Height, mime
		return input, nil
	}
	if err := validateUpscaleVideoContainerMIME(firstNonEmpty(media.MimeType, info.MimeType)); err != nil {
		_ = rc.Close()
		return input, err
	}
	size, facts, err := streamProbeOwnedVideo(ctx, rc, limit)
	if err != nil {
		return input, err
	}
	if size > deliveryLimit {
		return input, videoDeliveryLimitError(deliveryLimit)
	}
	if err := validateUpscaleVideoFacts(facts); err != nil {
		return input, err
	}
	media.Bytes = size
	if media.Width <= 0 || media.Height <= 0 {
		if w, h := facts.DisplayDimensions(); w > 0 && h > 0 {
			media.Width, media.Height = w, h
		}
	}
	if media.DurationMs <= 0 && facts.DurationMs > 0 {
		media.DurationMs = facts.DurationMs
	}
	return input, nil
}

func validateLocalUpscaleFile(ctx context.Context, kind string, media *Media, rc io.ReadCloser, file ownedLocalFile, factor, deliveryLimit int64) (UpscaleSourceFacts, error) {
	defer rc.Close()
	info, err := file.Stat()
	if err != nil {
		return UpscaleSourceFacts{}, localMediaOpenError(err)
	}
	if !info.Mode().IsRegular() {
		return UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材文件无法读取", Action: "请重新导入素材后重试"}
	}
	if err := ValidateBeefTVSeedanceMediaSize(kind, info.Size()); err != nil {
		return UpscaleSourceFacts{}, err
	}
	media.Bytes = info.Size()
	if kind == "image" {
		w, h, mime, cfgErr := probeImageHeader(rc)
		if cfgErr != nil || w <= 0 || h <= 0 {
			return UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInvalidParams, Reason: "图片无法读取或格式不受支持", Action: "请使用 PNG、JPEG 或 WebP 图片后重试"}
		}
		media.Width, media.Height, media.MimeType = w, h, mime
		if err := validateUpscaleImagePreflight(mime, w, h, factor, deliveryLimit); err != nil {
			return UpscaleSourceFacts{}, err
		}
		return UpscaleSourceFacts{Bytes: info.Size(), MIME: mime, Width: w, Height: h}, nil
	}
	if info.Size() > deliveryLimit {
		return UpscaleSourceFacts{}, videoDeliveryLimitError(deliveryLimit)
	}
	localPath := file.Name()
	_ = rc.Close()
	facts, err := mediatools.ProbeLocal(ctx, localPath)
	if err != nil {
		return UpscaleSourceFacts{}, err
	}
	if err := validateUpscaleVideoFacts(facts); err != nil {
		return UpscaleSourceFacts{}, err
	}
	if media.Width <= 0 || media.Height <= 0 {
		if w, h := facts.DisplayDimensions(); w > 0 && h > 0 {
			media.Width, media.Height = w, h
		}
	}
	if media.DurationMs <= 0 && facts.DurationMs > 0 {
		media.DurationMs = facts.DurationMs
	}
	if media.Width <= 0 || media.Height <= 0 || media.DurationMs <= 0 {
		return UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInvalidParams, Reason: "无法读取超分视频的尺寸或时长", Action: "请确认视频完整后重新导入重试"}
	}
	return UpscaleSourceFacts{
		Bytes:      info.Size(),
		MIME:       normalizedLowerMIME(media.MimeType),
		Width:      media.Width,
		Height:     media.Height,
		DurationMs: media.DurationMs,
		FrameRate:  facts.FPS,
	}, nil
}

func normalizedLowerMIME(raw string) string {
	return strings.ToLower(strings.TrimSpace(strings.Split(raw, ";")[0]))
}

func validateUpscaleVideoContainerMIME(raw string) error {
	mime := normalizedLowerMIME(raw)
	if mime == "" || mime == "application/octet-stream" || mime == "video/mp4" || mime == "video/quicktime" {
		return nil
	}
	return PreparationUserError{Category: CategoryInvalidParams, Reason: "超分视频须为不超过 5 分钟的 MP4 或 MOV", Action: "请裁剪时长或转码为 MP4/MOV 后重试"}
}

func validateUpscaleImagePreflight(mime string, width, height int, factor, deliveryLimit int64) error {
	mime = normalizedLowerMIME(mime)
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "图片仅支持 PNG、JPEG 或 WebP", Action: "请转换图片格式后重试"}
	}
	if width <= 0 || height <= 0 {
		return nil
	}
	if int64(width)*int64(height) > 32<<20 {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "图片无法读取或超过 3200 万像素", Action: "请压缩图片分辨率后重试"}
	}
	// Estimate common 8-bit PNG/JPEG output; actual bytes remain quota checked.
	estimatedBytes := int64(width)*int64(height)*factor*factor*4 + 1<<20
	if estimatedBytes > deliveryLimit {
		return PreparationUserError{Category: CategoryInputTooLarge, Reason: fmt.Sprintf("预计超分结果可能超过本机单个生成资源上限 %s", formatStorageLimit(deliveryLimit)), Action: "请降低放大倍数或调高资源上限后重试"}
	}
	return nil
}

func upscaleImageConfig(data []byte) (image.Config, error) {
	w, h, _, err := probeImageHeader(bytes.NewReader(data))
	meta := image.Config{Width: w, Height: h}
	if err != nil || w <= 0 || h <= 0 || int64(w)*int64(h) > 32<<20 {
		return meta, PreparationUserError{Category: CategoryInvalidParams, Reason: "图片无法读取或超过 3200 万像素", Action: "请压缩或重新导出图片后重试"}
	}
	return meta, nil
}

func legacyUpscaleInput(input Input) beeftv.LegacyUpscaleInput {
	request := beeftv.LegacyUpscaleInput{Model: input.Config.Model, MediaType: input.Mode, Factor: input.Upscale.Factor, OutputFormat: input.Upscale.OutputFormat}
	if input.Mode == "image" && len(input.ReferenceImages) > 0 {
		request.SourceURL = input.ReferenceImages[0].URL
	}
	if input.Mode == "video" && len(input.ReferenceVideos) > 0 {
		request.SourceURL = input.ReferenceVideos[0].URL
	}
	return request
}

type UpscaleEstimate = beeftv.UpscaleEstimate

func EstimateUpscale(ctx context.Context, input Input) (UpscaleEstimate, UpscaleSourceFacts, error) {
	var estimate UpscaleEstimate
	prepared, facts, err := prepareUpscaleMetadata(ctx, input)
	if err != nil {
		return estimate, UpscaleSourceFacts{}, RequestPreparationError{Cause: err}
	}
	queryCtx := WithRequestKind(ctx, "estimate")
	req := legacyUpscaleInput(prepared)
	req.EstimateOnly = true
	req.Width, req.Height = facts.Width, facts.Height
	if prepared.Mode == "video" {
		if facts.DurationMs > 0 {
			req.DurationSeconds = float64(facts.DurationMs) / 1000.0
		}
		if facts.FrameRate > 0 {
			req.FrameRate = facts.FrameRate
		}
	}
	estimate, err = managedMediaClient(queryCtx, prepared.Config).EstimateLegacyUpscale(queryCtx, req)
	return estimate, facts, err
}

func upscaleTaskPath(id string) (string, error) { return beeftv.LegacyUpscaleTaskPath(id) }

func RunUpscaleTask(ctx context.Context, input Input) (map[string]any, error) {
	if err := ValidateUpscaleInput(input); err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	if !managedConnection(input.Config) && !IsBeefTVVideoConfig(ctx, input.Config) {
		return nil, RequestPreparationError{Cause: PreparationUserError{Category: CategoryAuth, Reason: "AI 超分需要连接官方算力账号", Action: "请先在设置中连接官方算力账号后重试"}}
	}
	client, unified, err := useManagedMediaEnvelope(ctx, input.Config, "upscale")
	if err != nil {
		return nil, err
	}
	if unified {
		return runManagedUpscaleTask(ctx, client, input)
	}
	id := ResumedProviderRequestID(ctx)
	if id == "" {
		prepared, err := PrepareUpscale(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
		if SubmissionKeyFromContext(ctx) == "" {
			return nil, RequestPreparationError{Cause: errors.New("超分任务缺少持久操作 ID")}
		}
		createCtx := WithRequestKind(ctx, "create")
		id, err = managedMediaClient(createCtx, prepared.Config).CreateLegacyUpscale(createCtx, SubmissionKeyFromContext(ctx), legacyUpscaleInput(prepared))
		if err != nil {
			return nil, UncertainVideoSubmission(ctx, upscaleSubmissionError(legacyMediaError(err)))
		}
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ReferenceProgress != nil {
		runtime.ReferenceProgress.ClearReference()
	}
	policy := DefaultVideoPollPolicy()
	policy.QueryStage = "正在确认超分结果"
	policy.InitialDelay, policy.Interval = 0, 5*time.Second
	return RunVideoPollLoop(ctx, id, policy, func(ctx context.Context) (VideoPollOutcome, error) {
		result, _, err := QueryUpscaleResult(ctx, input, id)
		return VideoPollOutcome{Done: result != nil, Result: result}, err
	})
}

func runManagedUpscaleTask(ctx context.Context, client *beeftv.MediaClient, input Input) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.ManagedMedia == nil {
		return nil, RequestPreparationError{Cause: errors.New("超分请求缺少持久化提交标识")}
	}
	sent, err := runtime.ManagedMedia.Sent(ctx)
	if err != nil {
		return nil, err
	}
	if !sent {
		input, err = prepareOwnedUpscaleSource(ctx, input)
		if err != nil {
			return nil, RequestPreparationError{Cause: err}
		}
	}
	media := input.ReferenceImages
	if input.Mode == "video" {
		media = input.ReferenceVideos
	}
	ref := managedReference(media[0], "source")
	ref.Kind = input.Mode
	ref.MaxBytes = BeefTVSeedanceKindMaxBytes(input.Mode)
	options := map[string]any{"upscale_factor": input.Upscale.Factor}
	if input.Mode == "image" {
		options["output_format"] = defaultString(input.Upscale.OutputFormat, "png")
		options["face_enhancement"] = false
	} else {
		options["H264_output"] = true
	}
	request := beeftv.MediaRequest{TaskRef: SubmissionKeyFromContext(ctx), MediaType: "upscale", Model: input.Config.Model, Operation: "upscale", Options: options}
	client.ExpectedOutputKind = input.Mode
	return executeManagedMedia(ctx, client, request, []beeftv.LocalMediaReference{ref})
}

// BeefTV owns provider recovery. Client recovery only queries the original task.
func RecoverUpscaleResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	return QueryUpscaleResult(ctx, input, id)
}

func upscaleSubmissionError(err error) error {
	var unknown SubmissionUnknownError
	if errors.As(err, &unknown) {
		return err
	}
	var upstream HTTPError
	if !errors.As(err, &upstream) {
		return err
	}
	var rejection struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code string `json:"code"`
		} `json:"error"`
		Code string `json:"code"`
	}
	if json.Unmarshal([]byte(upstream.Body), &rejection) != nil || rejection.TaskID != "" || rejection.ID != "" {
		return err
	}
	code := firstNonEmpty(rejection.Error.Code, rejection.Code)
	if (upstream.StatusCode == 400 || upstream.StatusCode == 422) && code != "" || upstream.StatusCode == 503 && (code == "fal_billing_unavailable" || code == "upscale_unavailable") {
		return SubmissionRejectedError{Cause: err}
	}
	return err
}

// Receipts cannot choose a download host or path. Only the authenticated
// content endpoint for this exact original task is used.
func QueryUpscaleStatus(ctx context.Context, config Config, id string) (string, error) {
	ctx = WithRequestKind(ctx, "poll")
	task, err := managedMediaClient(ctx, config).QueryLegacyUpscale(ctx, id, config.Model, "")
	return task.Status, legacyMediaError(err)
}

func QueryUpscaleResult(ctx context.Context, input Input, id string) (map[string]any, string, error) {
	queryCtx := WithRequestKind(ctx, "poll")
	receipt, err := managedMediaClient(queryCtx, input.Config).QueryLegacyUpscale(queryCtx, id, input.Config.Model, input.Mode)
	status := receipt.Status
	if err != nil {
		return nil, "", err
	}
	switch status {
	case "queued", "in_progress", "cancelling", "unknown":
		return nil, status, nil
	case "failed", "cancelled":
		return nil, status, errors.New("超分任务未完成，请查看任务详情")
	case "completed":
	default:
		return nil, status, StatePendingError{TaskID: id, Cause: fmt.Errorf("unknown upscale status")}
	}
	ctx = WithRequestKind(ctx, "download")
	data, mime, err := RunVideoDownload(ctx, id, DefaultVideoPollPolicy(), func(ctx context.Context) ([]byte, string, error) {
		limit, limitErr := GeneratedFileLimit(ctx)
		if limitErr != nil {
			return nil, "", limitErr
		}
		return managedMediaClient(ctx, input.Config).LegacyUpscaleContent(ctx, id, limit)
	})
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	mime = NormalizedMediaMIMEType(mime, data)
	if input.Mode == "image" {
		if err := ValidateImageArtifact(data, mime); err != nil {
			return nil, status, VideoDownloadError{TaskID: id, Cause: err}
		}
		return map[string]any{"mode": "image", "images": []map[string]any{{"dataUrl": DataURL(mime, data), "mimeType": mime}}}, status, nil
	}
	if !strings.HasPrefix(mime, "video/") {
		return nil, status, VideoDownloadError{TaskID: id, Cause: errors.New("超分结果不是有效视频")}
	}
	data, err = RestoreUpscaleSourceAudio(ctx, input, data)
	if err != nil {
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	return map[string]any{"mode": "video", "video": map[string]any{"dataUrl": DataURL("video/mp4", data), "mimeType": "video/mp4"}}, status, nil
}

func RestoreUpscaleSourceAudio(ctx context.Context, input Input, data []byte) ([]byte, error) {
	if input.Upscale == nil || input.Mode != "video" {
		return data, nil
	}
	if len(input.ReferenceVideos) != 1 {
		return nil, errors.New("缺少原视频，无法检查音轨")
	}
	runtime, _ := RuntimeFromContext(ctx)
	source, _, skip, err := ownedSeedanceMediaReader(ctx, runtime.Call.UserID)("video", Media{StorageKey: input.ReferenceVideos[0].StorageKey})
	if err != nil || skip {
		return nil, errors.New("原视频无法读取，暂时不能保留音轨")
	}
	return PreserveUpscaleAudio(ctx, source, data)
}

func CancelUpscale(ctx context.Context, config Config, id string) error {
	return managedMediaClient(ctx, config).CancelLegacyUpscale(ctx, id)
}
