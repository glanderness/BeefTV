package operations

import (
	"context"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"os"
	"path/filepath"
)

// Coordinates refer to the displayed image, after the decoder applies orientation.
type MediaImageCrop struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func (c MediaImageCrop) valid() bool {
	for _, value := range []float64{c.X, c.Y, c.Width, c.Height} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return c.X >= 0 && c.Y >= 0 && c.X < 1 && c.Y < 1 && c.Width > 0 && c.Height > 0 && c.X+c.Width <= 1 && c.Y+c.Height <= 1
}

type MediaImageRead struct {
	View           string          `json:"view"`
	Width          int             `json:"width"`
	Height         int             `json:"height"`
	OriginalWidth  int             `json:"originalWidth"`
	OriginalHeight int             `json:"originalHeight"`
	Crop           *MediaImageCrop `json:"crop,omitempty"`
}

const mediaImageCropSchema = `{"type":"object","description":"仅用于图片 frames 检查。按原始像素读取局部，不缩小分辨率；坐标相对显示方向，从左上角起，x/y/width/height 均为0到1的比例，范围必须完整位于图内。用于小字、纹理及长图分区。","properties":{"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1},"width":{"type":"number","exclusiveMinimum":0,"maximum":1},"height":{"type":"number","exclusiveMinimum":0,"maximum":1}},"required":["x","y","width","height"],"additionalProperties":false}`

// 3 MiB becomes 4 MiB of base64, below the SDK's default 4.5 MiB inline budget.
// This bounds payload bytes without imposing a pixel limit on detail inspection.
const maxInlineImageBytes int64 = 3 << 20

func inlineImagePart(path, mime string, source MediaSource) (MediaPart, error) {
	if stat, err := os.Stat(path); err == nil && stat.Size() > maxInlineImageBytes {
		return MediaPart{}, PreconditionFailed("media_part_too_large", "图片超过单次读取大小，请分区查看图片细节", nil)
	}
	return mediaFilePart(path, "image", mime, source)
}

func imageConfig(path string) (image.Config, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return image.Config{}, "", err
	}
	defer file.Close()
	return image.DecodeConfig(file)
}

func (p preparedMedia) readImage(ctx context.Context, bin, operation string, args mediaArgs, result MediaResult) (MediaResult, error) {
	input := p.input
	config, format, err := imageConfig(input)
	if err != nil || (format != "jpeg" && format != "png") {
		// Convert unsupported inline formats without changing their pixel size.
		input = filepath.Join(p.directory, "image-original.png")
		if _, err := mediaCommand(ctx, bin, "-nostdin", "-v", "error", "-i", p.input, "-frames:v", "1", "-y", input); err != nil {
			return MediaResult{}, err
		}
		config, format, err = imageConfig(input)
		if err != nil {
			return MediaResult{}, PreconditionFailed("media_processing_failed", "图片无法解码", nil)
		}
	}
	info := &MediaImageRead{View: "original", Width: config.Width, Height: config.Height, OriginalWidth: config.Width, OriginalHeight: config.Height}
	mime := "image/" + format
	if args.ImageCrop != nil {
		crop := args.ImageCrop
		input = filepath.Join(p.directory, "image-crop.png")
		filter := fmt.Sprintf("format=rgba,crop=w='max(1,ceil(iw*%.17g)-floor(iw*%.17g))':h='max(1,ceil(ih*%.17g)-floor(ih*%.17g))':x='floor(iw*%.17g)':y='floor(ih*%.17g)':exact=1", crop.X+crop.Width, crop.X, crop.Y+crop.Height, crop.Y, crop.X, crop.Y)
		if _, err := mediaCommand(ctx, bin, "-nostdin", "-v", "error", "-i", p.input, "-frames:v", "1", "-vf", filter, "-y", input); err != nil {
			return MediaResult{}, err
		}
		info.View, info.Crop, mime = "crop", crop, "image/png"
	}
	part, err := inlineImagePart(input, mime, result.Source)
	if err != nil && AsError(err).Reason == "media_part_too_large" && operation == "media.overview" {
		// Only a labeled overview may shrink. Inspection always keeps original pixels.
		input = filepath.Join(p.directory, "image-preview.jpg")
		if _, err := mediaCommand(ctx, bin, "-nostdin", "-v", "error", "-i", p.input, "-frames:v", "1", "-vf", "scale=w='min(iw,2048)':h='min(ih,2048)':force_original_aspect_ratio=decrease", "-q:v", "8", "-pix_fmt", "yuvj420p", "-y", input); err != nil {
			return MediaResult{}, err
		}
		info.View = "preview"
		result.Note = "这张图片超过单次读取大小，当前仅为概览。小字和纹理等细节请用 media.inspect 的 imageCrop 分区查看原始像素；不要根据概览猜测细节。"
		part, err = inlineImagePart(input, "image/jpeg", result.Source)
	}
	if err != nil {
		if AsError(err).Reason == "media_part_too_large" {
			return MediaResult{}, PreconditionFailed("media_part_too_large", "图片超过单次读取大小，请分区查看图片细节", nil)
		}
		return MediaResult{}, err
	}
	if info.View != "original" {
		output, _, err := imageConfig(input)
		if err != nil {
			return MediaResult{}, PreconditionFailed("media_processing_failed", "图片处理未产生有效内容", nil)
		}
		info.Width, info.Height = output.Width, output.Height
	}
	result.Image, result.Content = info, []MediaPart{part}
	return result, nil
}
