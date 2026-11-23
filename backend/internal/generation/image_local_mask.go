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
	_ "image/jpeg"
	"image/png"
	"infinite-canvas/backend/internal/model"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Local mask editing is an explicit canvas operation, not a claim that the
// provider accepts masks. Composite before task persistence so downloads and
// resumed tasks share exactly the same output, without another paid submission.
func runLocalMaskImageTask(ctx context.Context, input Input, execute func(context.Context, Input) (map[string]any, error)) (map[string]any, error) {
	if input.Mask == nil || len(input.ReferenceImages) != 1 {
		return nil, RequestPreparationError{Cause: errors.New("局部融合需要一张原图和一张蒙版")}
	}
	source, err := localMaskImage(ctx, input.ReferenceImages[0])
	if err != nil {
		return nil, RequestPreparationError{Cause: fmt.Errorf("读取局部重绘原图失败：%w", err)}
	}
	mask, err := localMaskImage(ctx, *input.Mask)
	if err != nil {
		return nil, RequestPreparationError{Cause: fmt.Errorf("读取局部重绘蒙版失败：%w", err)}
	}
	if source.Bounds().Size() != mask.Bounds().Size() {
		return nil, RequestPreparationError{Cause: errors.New("局部重绘蒙版尺寸必须与原图一致")}
	}
	marked := image.NewNRGBA(source.Bounds())
	draw.Draw(marked, marked.Bounds(), source, source.Bounds().Min, draw.Src)
	selected := false
	for y := 0; y < marked.Bounds().Dy(); y++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for x := 0; x < marked.Bounds().Dx(); x++ {
			_, _, _, alpha := mask.At(x, y).RGBA()
			if alpha == 65535 {
				continue
			}
			selected = true
			pixel := marked.NRGBAAt(x, y)
			pixel.R = uint8((int(pixel.R) + 255) / 2)
			pixel.G /= 2
			pixel.B /= 2
			marked.SetNRGBA(x, y, pixel)
		}
	}
	if !selected {
		return nil, RequestPreparationError{Cause: errors.New("请先涂抹需要重绘的区域")}
	}
	markedURL, err := localMaskPNG(marked)
	if err != nil {
		return nil, err
	}
	input.Mask = nil // Never upload the local mask as a provider mask/reference.
	input.ReferenceImages = []Media{{DataURL: markedURL, MimeType: "image/png", Name: "selected-region.png", Width: marked.Bounds().Dx(), Height: marked.Bounds().Dy()}}
	input.Prompt = "仅修改参考图中红色半透明标记的区域，并彻底移除红色标记。保持原图构图、主体位置和其他内容不变。具体修改要求：\n" + input.Prompt
	// The inner execution is a normal image edit; capability validation must not
	// mistake the intentionally removed native mask for a missing local mask.
	metadata := make(map[string]any, len(input.Metadata))
	for key, value := range input.Metadata {
		if key != "maskEditMode" {
			metadata[key] = value
		}
	}
	input.Metadata = metadata
	result, err := execute(ctx, input)
	if err != nil {
		return nil, err
	}
	return compositeLocalMaskResult(ctx, source, mask, result)
}

func compositeLocalMaskResult(ctx context.Context, source, mask image.Image, result map[string]any) (map[string]any, error) {
	images, err := localMaskResultImages(result["images"])
	if err != nil {
		return nil, err
	}
	result["images"] = images
	for _, item := range images {
		generated, err := localMaskImage(ctx, Media{DataURL: item["dataUrl"]})
		if err != nil {
			return nil, fmt.Errorf("读取局部重绘结果失败：%w", err)
		}
		resized := image.NewNRGBA(source.Bounds())
		xdraw.CatmullRom.Scale(resized, resized.Bounds(), generated, generated.Bounds(), draw.Src, nil)
		composited := image.NewNRGBA(source.Bounds())
		draw.Draw(composited, composited.Bounds(), source, source.Bounds().Min, draw.Src)
		for y := 0; y < source.Bounds().Dy(); y++ {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			for x := 0; x < source.Bounds().Dx(); x++ {
				_, _, _, alpha := mask.At(x, y).RGBA()
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
		var address string
		switch item := entry.(type) {
		case map[string]string:
			address = firstNonEmpty(item["dataUrl"], item["url"])
		case map[string]any:
			address, _ = item["dataUrl"].(string)
			if address == "" {
				address, _ = item["url"].(string)
			}
		}
		if strings.TrimSpace(address) == "" {
			return nil, errors.New("局部重绘结果缺少图片地址")
		}
		images = append(images, map[string]string{"dataUrl": address})
	}
	return images, nil
}

func localMaskImage(ctx context.Context, media Media) (image.Image, error) {
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
		data, _, err = GetExternalBinary(ctx, firstNonEmpty(media.URL, media.DataURL))
	}
	if err != nil {
		return nil, err
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return nil, errors.New("局部重绘图片像素数量超出处理范围")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	return img, err
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

// FinalizeLocalMaskImageResult also covers receipt/manual recovery, which can
// bypass Execute. It never calls a model and is idempotent for completed bytes.
func FinalizeLocalMaskImageResult(ctx context.Context, inputJSON string, resultJSON []byte) ([]byte, error) {
	if !LocalMaskCompositeRequested(inputJSON) {
		return resultJSON, nil
	}
	var input Input
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
		return nil, err
	}
	if input.Mode != "image" || metadataString(input.Metadata, "maskEditMode") != "local-composite" {
		return resultJSON, nil
	}
	var result map[string]any
	if err := json.Unmarshal(resultJSON, &result); err != nil {
		return nil, err
	}
	if done, _ := result["localMaskComposited"].(bool); done {
		return resultJSON, nil
	}
	if input.Mask == nil || len(input.ReferenceImages) != 1 {
		return nil, errors.New("局部融合需要一张原图和一张蒙版")
	}
	source, err := localMaskImage(ctx, input.ReferenceImages[0])
	if err != nil {
		return nil, err
	}
	mask, err := localMaskImage(ctx, *input.Mask)
	if err != nil {
		return nil, err
	}
	if source.Bounds().Size() != mask.Bounds().Size() {
		return nil, errors.New("局部重绘蒙版尺寸必须与原图一致")
	}
	composited, err := compositeLocalMaskResult(ctx, source, mask, result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(composited)
}

// PrepareLocalMaskTaskCompletion keeps completion/recovery wiring out of the
// application service and performs no work for unrelated generation tasks.
func PrepareLocalMaskTaskCompletion(task model.Task, result []byte, decrypt func(string) (string, error), bind func(context.Context, CallMeta) context.Context) ([]byte, error) {
	if task.Type != "canvas_image" || !LocalMaskCompositeRequested(task.InputJSON) {
		return result, nil
	}
	input, err := decrypt(task.InputJSON)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ctx = bind(ctx, CallMeta{UserID: task.UserID, TaskID: task.ID, ProjectID: task.ProjectID})
	return FinalizeLocalMaskImageResult(ctx, input, result)
}
