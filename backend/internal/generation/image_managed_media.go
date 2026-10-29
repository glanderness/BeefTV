package generation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func usesDirectImageMedia(ctx context.Context, config Config) bool {
	return managedImageConnection(config) && directImageMedia(ctx)
}

func usesDirectOpenAIImageMedia(ctx context.Context, config Config) bool {
	return usesDirectImageMedia(ctx, config) && config.InterfaceType == string(model.ChannelInterfaceOpenAIImage)
}

func prepareBeefAPIImageReferences(ctx context.Context, userID string, input *Input) error {
	if input == nil || input.Mode != "image" || !usesDirectImageMedia(ctx, input.Config) {
		return nil
	}
	if len(input.ReferenceVideos)+len(input.ReferenceAudios) > 0 {
		return RequestPreparationError{Cause: errors.New("当前图片模型不支持参考视频或音频")}
	}
	return prepareBeefAPIReferenceUploads(ctx, input.Config, input, func(kind string, media Media) ([]byte, string, bool, error) {
		if !strings.HasPrefix(media.StorageKey, "resource:") {
			return ReadBeefAPISeedanceInlineMedia(kind, media)
		}
		runtime, ok := RuntimeFromContext(ctx)
		if !ok || runtime.Resources == nil {
			return nil, "", false, errors.New("读取任务参考资源失败：资源端口未接入")
		}
		resource, body, err := runtime.Resources.Open(userID, strings.TrimPrefix(media.StorageKey, "resource:"))
		if err != nil {
			return nil, "", false, fmt.Errorf("读取任务参考资源失败：%w", err)
		}
		defer body.Close()
		if err := validateManagedImageReference(input, resource.Size); err != nil {
			return nil, "", false, err
		}
		data, err := io.ReadAll(body)
		return data, firstNonEmpty(media.MimeType, resource.MimeType), false, err
	}, true)
}

func validateManagedImageReference(input *Input, size int64) error {
	if size <= 0 {
		return errBeefAPISeedanceUploadEmpty
	}
	// These are the selected model's input constraints, not the video's upload
	// limit. In particular a valid image must not inherit Seedance's 30 MiB cap.
	if input.ImageCapability != nil && input.ImageCapability.References.MaxImageBytes > 0 && size > input.ImageCapability.References.MaxImageBytes {
		return errors.New("参考图片文件超过当前模型大小限制")
	}
	return nil
}

// The stock OpenAI plugin declares multipart edits. The managed gateway also
// accepts JSON references, so keep those references instead of downloading them
// back into multipart files and sending large bytes through the API host.
func managedImageRequestSpec(ctx context.Context, config Config, spec protocol.RequestSpec) (protocol.RequestSpec, error) {
	if !usesDirectOpenAIImageMedia(ctx, config) || strings.TrimSpace(strings.Split(spec.ContentType, ";")[0]) != "multipart/form-data" || !strings.HasSuffix(spec.Path, "/images/edits") {
		return spec, nil
	}
	body := make(map[string]any, len(ProtocolBodyObject(spec.Body))+3)
	for key, value := range ProtocolBodyObject(spec.Body) {
		body[key] = value
	}
	var images []string
	for _, file := range spec.Files {
		link := strings.TrimSpace(file.Reference.URL)
		if !directImageReferences(ctx, link) || strings.TrimSpace(file.Reference.DataURL) != "" {
			return spec, errors.New("参考图片尚未上传完成，本次尚未开始生成")
		}
		switch file.Name {
		case "image", "image[]":
			images = append(images, link)
		case "mask":
			body["mask"] = link
		default:
			return spec, fmt.Errorf("当前图片请求不支持文件字段 %s", file.Name)
		}
	}
	if len(images) == 0 {
		return spec, errors.New("图片编辑必须提供源图片，本次尚未开始生成")
	}
	body["image"] = images
	spec.Body, spec.Files, spec.ContentType = body, nil, "application/json"
	return spec, nil
}

func runManagedOpenAIImageTask(ctx context.Context, input Input, outputCount int) (map[string]interface{}, error) {
	// The plugin is the normal route. Keep the host-only fallback on the same
	// JSON contract for workspaces without that plugin installed.
	body := map[string]any{"model": input.Config.Model, "prompt": WithSystemPrompt(input.Config, input.Prompt), "n": outputCount, "output_format": "png"}
	if input.Config.TransparentBackground == "true" {
		body["background"] = "transparent"
	}
	if ImageQualitySupported(input.ImageCapability) && input.Config.Quality != "" && !strings.EqualFold(input.Config.Quality, "auto") {
		body["quality"] = NormalizeImageQuality(input.Config.Quality)
	}
	if key, value := ImageSizeParameter(input.ImageCapability, input.Config.Size); value != "" {
		body[key] = value
	}
	files := make([]protocol.RequestFilePart, 0, len(input.ReferenceImages)+1)
	for _, media := range input.ReferenceImages {
		files = append(files, protocol.RequestFilePart{Name: "image", Reference: ProtocolMediaReference(media, "image", 0)})
	}
	if input.Mask != nil {
		files = append(files, protocol.RequestFilePart{Name: "mask", Reference: ProtocolMediaReference(*input.Mask, "image", len(files))})
	}
	spec, err := managedImageRequestSpec(ctx, input.Config, protocol.RequestSpec{Path: "/images/edits", ContentType: "multipart/form-data", Body: body, Files: files})
	if err != nil {
		return nil, RequestPreparationError{Cause: err}
	}
	var payload ImageResponse
	if err := PostJSON(ctx, input.Config, spec.Path, spec.Body, &payload); err != nil {
		return nil, err
	}
	images, err := MaterializeImageDataURLs(ctx, input.Config, payload)
	result := map[string]interface{}{"mode": "image", "images": images}
	if payload.Usage != nil {
		result["usage"] = payload.Usage
	}
	return result, err
}
