package generation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/playback"

	_ "golang.org/x/image/webp"
)

type UpscaleOptions struct {
	Factor          float64 `json:"factor"`
	TargetShortEdge int     `json:"targetShortEdge,omitempty"`
	OutputFormat    string  `json:"outputFormat,omitempty"`
	MaxVideoBytes   int64   `json:"maxVideoBytes,omitempty"`
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
	factor := input.Upscale.Factor
	if math.IsNaN(factor) || factor < 1 || factor > 4 {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "放大倍数须为 1 至 4", Action: "请调整放大倍数后重试"}
	}
	if kind == "image" && (factor != math.Trunc(factor) || input.Upscale.TargetShortEdge != 0) {
		return PreparationUserError{Category: CategoryInvalidParams, Reason: "图片放大倍数须为 1 至 4 的整数", Action: "请调整放大倍数后重试"}
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
	Bytes           int64
	MIME            string
	Width           int
	Height          int
	DurationMs      int64
	FrameRate       float64
	EffectiveFactor float64
}

// Preparation uses the existing owner-scoped media reader and gateway upload.
// Resuming an accepted task never uploads again or calls the create endpoint.
func PrepareUpscale(ctx context.Context, input Input) (Input, error) {
	input, err := prepareOwnedUpscaleSource(ctx, input)
	if err != nil {
		return input, err
	}
	if err := PrepareBeefTVVideoReferences(ctx, input.Config, &input, nil); err != nil {
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

// prepareUpscaleMetadata resolves and validates local upscale source facts
// directly on disk via ownedLocalFile (*os.File), shared by EstimateUpscale
// and submit preflight without buffering media into RAM or uploading to storage.
func prepareUpscaleMetadata(ctx context.Context, input Input) (Input, UpscaleSourceFacts, error) {
	input, media, deliveryLimit, err := hydrateOwnedUpscaleInput(ctx, input)
	if err != nil {
		return input, UpscaleSourceFacts{}, err
	}
	runtime, _ := RuntimeFromContext(ctx)
	if runtime.Resources == nil {
		return input, UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材服务暂不可用", Action: "请稍后重试"}
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	_, rc, openErr := runtime.Resources.Open(runtime.Call.UserID, resourceID)
	if openErr != nil {
		return input, UpscaleSourceFacts{}, localMediaOpenError(openErr)
	}
	file, ok := rc.(ownedLocalFile)
	if !ok {
		_ = rc.Close()
		return input, UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材文件无法读取", Action: "请重新导入素材后重试"}
	}
	facts, err := validateLocalUpscaleFile(ctx, input.Mode, media, rc, file, int64(input.Upscale.Factor), mediaToolVideoMaxBytes(ctx, &input), deliveryLimit)
	if err != nil {
		return input, UpscaleSourceFacts{}, err
	}
	if input.Upscale.TargetShortEdge != 0 {
		factor, err := upscaleFactorForTarget(min(facts.Width, facts.Height), input.Upscale.TargetShortEdge)
		if err != nil {
			return input, UpscaleSourceFacts{}, err
		}
		options := *input.Upscale
		options.Factor = factor
		input.Upscale = &options
	}
	facts.EffectiveFactor = input.Upscale.Factor
	return input, facts, nil
}

func prepareOwnedUpscaleSource(ctx context.Context, input Input) (Input, error) {
	prepared, _, err := prepareUpscaleMetadata(ctx, input)
	return prepared, err
}

func validateLocalUpscaleFile(ctx context.Context, kind string, media *Media, rc io.ReadCloser, file ownedLocalFile, factor, videoLimit, deliveryLimit int64) (UpscaleSourceFacts, error) {
	defer rc.Close()
	info, err := file.Stat()
	if err != nil {
		return UpscaleSourceFacts{}, localMediaOpenError(err)
	}
	if !info.Mode().IsRegular() {
		return UpscaleSourceFacts{}, PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地素材文件无法读取", Action: "请重新导入素材后重试"}
	}
	if err := ValidateBeefTVMediaToolSize(kind, info.Size(), videoLimit); err != nil {
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
	if w, h := facts.DisplayDimensions(); w > 0 && h > 0 {
		media.Width, media.Height = w, h
	}
	media.DurationMs = facts.DurationMs
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
	if input.Mode == "video" {
		ref.MaxBytes = mediaToolVideoMaxBytes(ctx, &input)
		ref.Purpose = beeftv.UploadPurposeMediaTool
	} else {
		ref.MaxBytes = BeefTVSeedanceKindMaxBytes(input.Mode)
	}
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
	if input.Mode == "image" {
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
		if err := ValidateImageArtifact(data, mime); err != nil {
			return nil, status, VideoDownloadError{TaskID: id, Cause: err}
		}
		return map[string]any{"mode": "image", "images": []map[string]any{{"dataUrl": DataURL(mime, data), "mimeType": mime}}}, status, nil
	}
	out, err := downloadAndFinalizeLegacyToolVideo(ctx, input, id, "超分", func(dlCtx context.Context, destDir string, limit int64) (string, string, error) {
		path, mime, _, dlErr := managedMediaClient(dlCtx, input.Config).LegacyUpscaleContentToFile(dlCtx, id, destDir, limit)
		return path, mime, dlErr
	}, RestoreUpscaleSourceAudioFile)
	if err != nil {
		var persistErr VideoPersistError
		if errors.As(err, &persistErr) {
			return nil, status, err
		}
		return nil, status, VideoDownloadError{TaskID: id, Cause: err}
	}
	return out, status, nil
}

// downloadAndFinalizeLegacyToolVideo streams a legacy/recovery tool video
// directly to disk, validates its header, remuxes original source audio on
// disk, probes dimensions/duration with bounded Range reads, and persists the
// finalized file directly into workspace resources via GeneratedVideoFileStore
// so 1-2 GiB videos never enter RAM or ResultJSON base64 data URLs.
func downloadAndFinalizeLegacyToolVideo(
	ctx context.Context,
	input Input,
	id, label string,
	fetchToFile func(ctx context.Context, destDir string, limit int64) (string, string, error),
	restoreAudioFile func(ctx context.Context, input Input, outputPath string) (string, func(), error),
) (map[string]any, error) {
	runtime, _ := RuntimeFromContext(ctx)
	destDir := ""
	if runtime.DownloadCache != nil {
		if partial := strings.TrimSpace(runtime.DownloadCache.PartialPath()); partial != "" {
			destDir = filepath.Dir(partial)
		}
	}
	downloadedPath, mime, err := RunVideoDownloadFile(ctx, id, DefaultVideoPollPolicy(), func(attemptCtx context.Context) (string, string, error) {
		limit, limitErr := GeneratedFileLimit(attemptCtx)
		if limitErr != nil {
			return "", "", limitErr
		}
		return fetchToFile(attemptCtx, destDir, limit)
	})
	if err != nil {
		return nil, err
	}
	defer os.Remove(downloadedPath)

	head, err := outbound.ReadFilePrefix(downloadedPath, 4<<10)
	if err != nil {
		return nil, err
	}
	mime = NormalizedMediaMIMEType(mime, head)
	if !strings.HasPrefix(mime, "video/") {
		return nil, fmt.Errorf("%s结果不是有效视频", label)
	}
	finalPath, cleanup, err := restoreAudioFile(ctx, input, downloadedPath)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return nil, err
	}
	outHead := head
	if finalPath != downloadedPath {
		if sniff, sniffErr := outbound.ReadFilePrefix(finalPath, 4<<10); sniffErr == nil {
			outHead = sniff
		}
	}
	outMime := NormalizedMediaMIMEType("", outHead)
	if !strings.HasPrefix(outMime, "video/") {
		outMime = mime
	}
	videoMap, err := persistDownloadedVideoFile(ctx, finalPath, outMime, "video")
	if err != nil {
		return nil, err
	}
	return map[string]any{"mode": "video", "video": videoMap}, nil
}

// persistDownloadedVideoFile probes dimensions/duration with bounded Range reads
// and streams finalPath directly into workspace resources via GeneratedVideoFileStore
// (zero RAM buffering, zero base64 DataURL in ResultJSON). Falls back to bounded
// DataURL only for standalone unit tests without GeneratedVideoFileStore.
func persistDownloadedVideoFile(ctx context.Context, finalPath, outMime, identitySuffix string) (map[string]any, error) {
	head, err := outbound.ReadFilePrefix(finalPath, 4<<10)
	if err != nil {
		return nil, err
	}
	outMime = NormalizedMediaMIMEType(outMime, head)
	f, err := os.Open(finalPath)
	if err != nil {
		return nil, err
	}
	info, statErr := f.Stat()
	if statErr != nil {
		_ = f.Close()
		return nil, statErr
	}
	if info.Size() <= 0 {
		_ = f.Close()
		return nil, errors.New("视频结果内容为空")
	}
	width, height, durationMs := playback.ProbeVideoReader(f, info.Size())
	_ = f.Close()

	runtime, _ := RuntimeFromContext(ctx)
	if store, ok := runtime.Resources.(GeneratedVideoFileStore); ok && strings.TrimSpace(runtime.Call.UserID) != "" && strings.TrimSpace(runtime.Call.TaskID) != "" {
		identity := runtime.Call.TaskID + ":" + identitySuffix
		saved, saveErr := store.PersistGeneratedVideoFile(runtime.Call.UserID, identity, outMime, finalPath, width, height, durationMs)
		if saveErr != nil {
			return nil, VideoPersistError{TaskID: runtime.Call.TaskID, Cause: saveErr}
		}
		videoMap := map[string]any{
			"url":        assets.FileURL(saved.ID),
			"storageKey": "resource:" + saved.ID,
			"resourceId": saved.ID,
			"bytes":      saved.Size,
			"mimeType":   saved.MimeType,
			"width":      saved.Width,
			"height":     saved.Height,
		}
		if saved.DurationMs > 0 {
			videoMap["durationMs"] = saved.DurationMs
		}
		return videoMap, nil
	}
	if info.Size() > assets.MaxInlineMediaBytes {
		return nil, errors.New("视频结果过大，缺少本地资源写入端口")
	}
	data, err := os.ReadFile(finalPath)
	if err != nil {
		return nil, err
	}
	return map[string]any{"dataUrl": DataURL(outMime, data), "mimeType": outMime}, nil
}

// RestoreUpscaleSourceAudioFile preserves the original upscale source video's
// audio track onto outputPath entirely on disk without loading either video
// into memory.
func RestoreUpscaleSourceAudioFile(ctx context.Context, input Input, outputPath string) (string, func(), error) {
	noop := func() {}
	if input.Upscale == nil || input.Mode != "video" {
		return outputPath, noop, nil
	}
	return restoreMediaSourceAudioFile(ctx, input, outputPath)
}

func restoreMediaSourceAudioFile(ctx context.Context, input Input, outputPath string) (string, func(), error) {
	noop := func() {}
	if len(input.ReferenceVideos) != 1 || !strings.HasPrefix(input.ReferenceVideos[0].StorageKey, "resource:") {
		return "", noop, errors.New("缺少原视频，无法检查音轨")
	}
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Resources == nil {
		return "", noop, errors.New("原视频无法读取，暂时不能保留音轨")
	}
	resourceID := strings.TrimPrefix(input.ReferenceVideos[0].StorageKey, "resource:")
	_, rc, err := runtime.Resources.Open(runtime.Call.UserID, resourceID)
	if err != nil {
		return "", noop, errors.New("原视频无法读取，暂时不能保留音轨")
	}
	file, isLocal := rc.(ownedLocalFile)
	if !isLocal {
		_ = rc.Close()
		return "", noop, errors.New("原视频无法读取，暂时不能保留音轨")
	}
	localPath := file.Name()
	_ = rc.Close()
	return PreserveUpscaleAudioFile(ctx, localPath, outputPath)
}

func CancelUpscale(ctx context.Context, config Config, id string) error {
	return managedMediaClient(ctx, config).CancelLegacyUpscale(ctx, id)
}

// The MPS API selects the smallest output tier covering the requested short
// edge. Send an in-range factor that lands in the selected tier.
func upscaleFactorForTarget(source, target int) (float64, error) {
	var lower int
	switch target {
	case 720:
	case 1080:
		lower = 720
	case 1440:
		lower = 1080
	case 2160:
		lower = 1440
	default:
		return 0, PreparationUserError{Category: CategoryInvalidParams, Reason: "不支持该视频输出清晰度", Action: "请选择可用的输出档位后重试"}
	}
	if source <= 0 || source > target || float64(source)*4 <= float64(lower) {
		return 0, PreparationUserError{Category: CategoryInvalidParams, Reason: "所选清晰度不适用于原片", Action: "请更换输出档位后重试"}
	}
	return min(4, float64(target)/float64(source)), nil
}
