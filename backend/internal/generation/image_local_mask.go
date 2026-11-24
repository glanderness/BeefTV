package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const localMaskPNGSizeLimit = 4 << 20

type referenceBytesUploader interface {
	UploadBytes(ctx context.Context, data []byte) (string, error)
}

// Local mask editing is an explicit canvas operation, not a claim that the
// provider accepts masks. Composite before task persistence so downloads and
// resumed tasks share exactly the same output, without another paid submission.
func runLocalMaskImageTask(ctx context.Context, input Input, execute func(context.Context, Input) (map[string]any, error)) (map[string]any, error) {
	if input.Mask == nil || len(input.ReferenceImages) != 1 {
		return nil, RequestPreparationError{Cause: PreparationUserError{
			Category: CategoryInvalidParams,
			Reason:   "局部融合需要一张原图和一张蒙版",
			Action:   "请同时提供原图和重绘蒙版后重试",
		}}
	}
	source, err := localMaskImage(ctx, &input.Config, input.ReferenceImages[0])
	if err != nil {
		return nil, RequestPreparationError{Cause: PreparationUserError{
			Category: CategoryInputInaccessible,
			Reason:   "读取局部重绘原图失败",
			Action:   "请确认原图存在且为受支持的图片格式后重试",
			Cause:    err,
		}}
	}
	mask, err := localMaskImage(ctx, &input.Config, *input.Mask)
	if err != nil {
		return nil, RequestPreparationError{Cause: PreparationUserError{
			Category: CategoryInputInaccessible,
			Reason:   "读取局部重绘蒙版失败",
			Action:   "请重新绘制蒙版后重试",
			Cause:    err,
		}}
	}
	if source.Bounds().Size() != mask.Bounds().Size() {
		return nil, RequestPreparationError{Cause: PreparationUserError{
			Category: CategoryInvalidParams,
			Reason:   "局部重绘蒙版尺寸必须与原图一致",
			Action:   "请重新进入局部重绘并绘制蒙版后重试",
		}}
	}
	srcBounds, maskBounds := source.Bounds(), mask.Bounds()
	width, height := srcBounds.Dx(), srcBounds.Dy()
	marked := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(marked, marked.Bounds(), source, srcBounds.Min, draw.Src)
	selected := false
	for y := 0; y < height; y++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for x := 0; x < width; x++ {
			_, _, _, alpha := mask.At(maskBounds.Min.X+x, maskBounds.Min.Y+y).RGBA()
			if alpha == 65535 {
				continue
			}
			selected = true
			pixel := marked.NRGBAAt(x, y)
			if alpha == 0 {
				pixel.R = uint8((int(pixel.R) + 255) / 2)
				pixel.G /= 2
				pixel.B /= 2
			} else {
				redWeight := (65535 - alpha) / 2
				keep := 65535 - redWeight
				pixel.R = uint8((uint32(pixel.R)*keep + 255*redWeight + 32767) / 65535)
				pixel.G = uint8((uint32(pixel.G)*keep + 32767) / 65535)
				pixel.B = uint8((uint32(pixel.B)*keep + 32767) / 65535)
			}
			marked.SetNRGBA(x, y, pixel)
		}
	}
	if !selected {
		return nil, RequestPreparationError{Cause: PreparationUserError{
			Category: CategoryInvalidParams,
			Reason:   "请先涂抹需要重绘的区域",
			Action:   "请使用画笔涂抹要修改的区域后再提交",
		}}
	}
	var maxRefBytes int64
	if input.ImageCapability != nil {
		maxRefBytes = input.ImageCapability.References.MaxImageBytes
	}
	markedBytes, mimeType, fileName, err := localMaskReferenceBytes(marked, maxRefBytes)
	if err != nil {
		return nil, err
	}
	markedMedia := Media{
		DataURL:  DataURL(mimeType, markedBytes),
		MimeType: mimeType,
		Name:     fileName,
		Bytes:    int64(len(markedBytes)),
		Width:    width,
		Height:   height,
	}
	input.Mask = nil // Never upload the local mask as a provider mask/reference.
	// The inner execution is a normal image edit; capability validation must not
	// mistake the intentionally removed native mask for a missing local mask.
	metadata := make(map[string]any, len(input.Metadata))
	for key, value := range input.Metadata {
		if key != "maskEditMode" {
			metadata[key] = value
		}
	}
	input.Metadata = metadata
	if ResumedProviderRequestID(ctx) == "" && !managedConnection(input.Config) {
		groupPolicy := mediaPolicyForKind(ctx, input, "image", MediaHydrationPolicyFor(ctx, input))
		if groupPolicy.RequireURL && !groupPolicy.KeepLocal && !groupPolicy.ManualURL {
			if runtime, ok := RuntimeFromContext(ctx); ok && runtime.ReferenceStorage != nil {
				enabled, err := runtime.ReferenceStorage.Enabled()
				if err != nil {
					return nil, RequestPreparationError{Cause: ReferenceStoragePreparationError{Cause: err}}
				}
				if enabled {
					if uploader, ok := runtime.ReferenceStorage.(referenceBytesUploader); ok {
						link, err := uploader.UploadBytes(ctx, markedBytes)
						if err != nil {
							return nil, RequestPreparationError{Cause: ReferenceStoragePreparationError{Cause: err}}
						}
						markedMedia.URL, markedMedia.DataURL = link, ""
					}
				}
			}
		}
	}
	input.ReferenceImages = []Media{markedMedia}
	input.Prompt = "仅修改参考图中红色半透明标记的区域，并彻底移除红色标记。保持原图构图、主体位置和其他内容不变。具体修改要求：\n" + input.Prompt
	result, err := execute(ctx, input)
	if err != nil {
		return nil, err
	}
	return compositeLocalMaskResult(ctx, &input.Config, source, mask, result)
}

func compositeLocalMaskResult(ctx context.Context, config *Config, source, mask image.Image, result map[string]any) (map[string]any, error) {
	images, err := localMaskResultImages(result["images"])
	if err != nil {
		return nil, err
	}
	result["images"] = images
	srcBounds, maskBounds := source.Bounds(), mask.Bounds()
	width, height := srcBounds.Dx(), srcBounds.Dy()
	targetRect := image.Rect(0, 0, width, height)
	for _, item := range images {
		generated, err := localMaskImage(ctx, config, Media{DataURL: item["dataUrl"], StorageKey: item["storageKey"]})
		if err != nil {
			return nil, fmt.Errorf("读取局部重绘结果失败：%w", err)
		}
		resized := image.NewNRGBA(targetRect)
		xdraw.CatmullRom.Scale(resized, resized.Bounds(), generated, generated.Bounds(), draw.Src, nil)
		composited := image.NewNRGBA(targetRect)
		draw.Draw(composited, composited.Bounds(), source, srcBounds.Min, draw.Src)
		for y := 0; y < height; y++ {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			for x := 0; x < width; x++ {
				_, _, _, alpha := mask.At(maskBounds.Min.X+x, maskBounds.Min.Y+y).RGBA()
				if alpha == 65535 {
					continue
				}
				a, b := composited.NRGBAAt(x, y), resized.NRGBAAt(x, y)
				blend := func(original, edited uint8) uint8 {
					return uint8((uint32(original)*alpha + uint32(edited)*(65535-alpha) + 32767) / 65535)
				}
				composited.SetNRGBA(x, y, color.NRGBA{R: blend(a.R, b.R), G: blend(a.G, b.G), B: blend(a.B, b.B), A: blend(a.A, b.A)})
			}
		}
		dataURL, err := localMaskPNG(composited)
		if err != nil {
			return nil, err
		}
		// Provider URLs/resource IDs describe the uncomposited image. Retain only
		// the final bytes so every task consumer materializes the local result.
		for key := range item {
			delete(item, key)
		}
		item["dataUrl"], item["mimeType"] = dataURL, "image/png"
	}
	result["localMaskComposited"] = true
	delete(result, "outputs")
	delete(result, "imageLayers")
	return result, nil
}

// Managed media and protocol plugins return different Go container types but
// share the same image contract. URL-only results must be composited too.
func localMaskResultImages(value any) ([]map[string]string, error) {
	var entries []any
	switch images := value.(type) {
	case []map[string]string:
		for _, item := range images {
			entries = append(entries, item)
		}
	case []map[string]any:
		for _, item := range images {
			entries = append(entries, item)
		}
	case []any:
		entries = images
	}
	if len(entries) == 0 {
		return nil, errors.New("局部重绘任务没有返回图片")
	}
	images := make([]map[string]string, 0, len(entries))
	for _, entry := range entries {
		var address, storageKey string
		switch item := entry.(type) {
		case map[string]string:
			address = firstNonEmpty(item["dataUrl"], item["url"])
			storageKey = strings.TrimSpace(item["storageKey"])
		case map[string]any:
			address, _ = item["dataUrl"].(string)
			if address == "" {
				address, _ = item["url"].(string)
			}
			storageKey, _ = item["storageKey"].(string)
			storageKey = strings.TrimSpace(storageKey)
		}
		if strings.TrimSpace(address) == "" && storageKey == "" {
			return nil, errors.New("局部重绘结果缺少图片地址")
		}
		next := map[string]string{"dataUrl": address}
		if storageKey != "" {
			next["storageKey"] = storageKey
		}
		images = append(images, next)
	}
	return images, nil
}

func localMaskImage(ctx context.Context, config *Config, media Media) (image.Image, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	runtime, _ := RuntimeFromContext(ctx)
	if err := HydrateOne(ctx, runtime.Call.UserID, &media, MediaHydrationPolicy{}); err != nil {
		return nil, err
	}
	var data []byte
	var err error
	if strings.HasPrefix(media.DataURL, "data:") || strings.HasPrefix(media.URL, "data:") {
		data, _, err = MediaBytes(media)
	} else {
		address := firstNonEmpty(media.URL, media.DataURL)
		downloadCtx := WithRequestKind(ctx, "download")
		if config != nil && strings.TrimSpace(config.BaseURL) != "" {
			data, _, err = GetProviderExternalBinary(downloadCtx, *config, address)
		} else {
			data, _, err = GetExternalBinary(downloadCtx, address)
		}
	}
	if err != nil {
		return nil, err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 40_000_000 {
		return nil, errors.New("局部重绘图片像素数量超出处理范围")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return localasset.NormalizeEXIFOrientation(data, img), nil
}

func localMaskReferenceBytes(img *image.NRGBA, maxBytes int64) ([]byte, string, string, error) {
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, img); err != nil {
		return nil, "", "", err
	}
	pngLimit := int64(localMaskPNGSizeLimit)
	if maxBytes > 0 && maxBytes < pngLimit {
		pngLimit = maxBytes
	}
	if int64(pngData.Len()) <= pngLimit || !isOpaqueNRGBA(img) {
		return pngData.Bytes(), "image/png", "selected-region.png", nil
	}
	for _, quality := range []int{92, 82} {
		var jpgData bytes.Buffer
		if err := jpeg.Encode(&jpgData, img, &jpeg.Options{Quality: quality}); err != nil {
			break
		}
		if jpgData.Len() < pngData.Len() && (maxBytes <= 0 || int64(jpgData.Len()) <= maxBytes || quality == 82) {
			return jpgData.Bytes(), "image/jpeg", "selected-region.jpg", nil
		}
	}
	return pngData.Bytes(), "image/png", "selected-region.png", nil
}

func isOpaqueNRGBA(img *image.NRGBA) bool {
	if img == nil {
		return false
	}
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 255 {
			return false
		}
	}
	return true
}

func localMaskPNG(img image.Image) (string, error) {
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		return "", err
	}
	return DataURL("image/png", data.Bytes()), nil
}

// LocalMaskCompositeRequested reads only the operation intent; protected config
// and media references are decrypted by the completion adapter only when needed.
func LocalMaskCompositeRequested(inputJSON string) bool {
	var operation struct {
		Mode     string         `json:"mode"`
		Metadata map[string]any `json:"metadata"`
	}
	return json.Unmarshal([]byte(inputJSON), &operation) == nil && operation.Mode == "image" && metadataString(operation.Metadata, "maskEditMode") == "local-composite"
}

func finalizeLocalMaskMap(ctx context.Context, inputJSON string, resultJSON []byte) (map[string]any, bool, error) {
	if !LocalMaskCompositeRequested(inputJSON) {
		return nil, false, nil
	}
	var input Input
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
		return nil, false, err
	}
	if input.Mode != "image" || metadataString(input.Metadata, "maskEditMode") != "local-composite" {
		return nil, false, nil
	}
	var result map[string]any
	if err := json.Unmarshal(resultJSON, &result); err != nil {
		return nil, false, err
	}
	if done, _ := result["localMaskComposited"].(bool); done {
		return nil, false, nil
	}
	if input.Mask == nil || len(input.ReferenceImages) != 1 {
		return nil, false, errors.New("局部融合需要一张原图和一张蒙版")
	}
	if runtime, ok := RuntimeFromContext(ctx); ok && runtime.Config != nil && (strings.TrimSpace(input.Config.ChannelID) != "" || strings.TrimSpace(input.Config.CredentialRef) != "") {
		if resolved, err := runtime.Config.Resolve(input.Config); err == nil {
			input.Config = resolved
		}
	}
	source, err := localMaskImage(ctx, &input.Config, input.ReferenceImages[0])
	if err != nil {
		return nil, false, err
	}
	mask, err := localMaskImage(ctx, &input.Config, *input.Mask)
	if err != nil {
		return nil, false, err
	}
	if source.Bounds().Size() != mask.Bounds().Size() {
		return nil, false, errors.New("局部重绘蒙版尺寸必须与原图一致")
	}
	composited, err := compositeLocalMaskResult(ctx, &input.Config, source, mask, result)
	if err != nil {
		return nil, false, err
	}
	return composited, true, nil
}

// PrepareLocalMaskTaskCompletion keeps completion/recovery wiring out of the
// application service and performs no work for unrelated generation tasks.
func PrepareLocalMaskTaskCompletion(task model.Task, result []byte, decrypt func(string) (string, error), bind func(context.Context, CallMeta) context.Context, persist func(model.Task, map[string]any) (map[string]any, error)) ([]byte, error) {
	if task.Type != "canvas_image" || !LocalMaskCompositeRequested(task.InputJSON) {
		return result, nil
	}
	input, err := decrypt(task.InputJSON)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	ctx = bind(ctx, CallMeta{UserID: task.UserID, TaskID: task.ID, ProjectID: task.ProjectID})
	composited, changed, err := finalizeLocalMaskMap(ctx, input, result)
	if err != nil || !changed {
		return result, err
	}
	if persist != nil {
		composited, err = persist(task, composited)
		if err != nil {
			return nil, err
		}
	}
	return json.Marshal(composited)
}
