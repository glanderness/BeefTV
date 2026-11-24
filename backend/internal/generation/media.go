package generation

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func prefixPreparationUserError(prefix string, err error) error {
	var userPrep PreparationUserError
	if errors.As(err, &userPrep) && strings.TrimSpace(userPrep.Reason) != "" {
		if !strings.HasPrefix(userPrep.Reason, prefix) {
			userPrep.Reason = prefix + userPrep.Reason
		}
		userPrep.Cause = err
		return RequestPreparationError{Cause: userPrep}
	}
	return fmt.Errorf("%s%w", prefix, err)
}

func HydrateMedia(ctx context.Context, userID string, input *Input, policy MediaHydrationPolicy) error {
	if input == nil {
		return nil
	}
	groups := [][]Media{input.ReferenceImages, input.ReferenceVideos, input.ReferenceAudios}
	for kind, group := range groups {
		groupPolicy := mediaPolicyForKind(ctx, *input, []string{"image", "video", "audio"}[kind], policy)
		for index := range group {
			if err := HydrateOne(ctx, userID, &group[index], groupPolicy); err != nil {
				prefix := fmt.Sprintf("%s %d：", []string{"参考图片", "参考视频", "参考音频"}[kind], index+1)
				return prefixPreparationUserError(prefix, err)
			}
		}
	}
	if input.Mask != nil {
		return HydrateOne(ctx, userID, input.Mask, mediaPolicyForKind(ctx, *input, "mask", policy))
	}
	return nil
}

func HydrateOne(ctx context.Context, userID string, media *Media, policy MediaHydrationPolicy) error {
	if media == nil {
		return nil
	}
	if !strings.HasPrefix(media.StorageKey, "resource:") {
		if policy.RequireURL && (strings.HasPrefix(strings.TrimSpace(media.DataURL), "data:") || strings.HasPrefix(strings.TrimSpace(media.URL), "data:")) {
			return RequestPreparationError{Cause: PreparationUserError{
				Category: CategoryInvalidParams,
				Reason:   "当前渠道暂不支持直接使用内嵌本地素材",
				Action:   "请使用可公开访问的 HTTPS 素材链接，或在设置 → 存储设置中开启「参考素材对象存储」后重试",
			}}
		}
		return nil
	}
	runtime, ok := RuntimeFromContext(ctx)
	if !ok || runtime.Resources == nil {
		return errors.New("读取任务参考资源失败：资源端口未接入")
	}
	resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
	resource, err := runtime.Resources.Lookup(userID, resourceID)
	if err != nil {
		return fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	if resource.Status != "ready" {
		return RequestPreparationError{Cause: resourceNotReadyError()}
	}
	if runtime.Resources.LocalMode() && resource.UsesObjectStorage() {
		return RequestPreparationError{Cause: PreparationUserError{Category: CategoryInputInaccessible, Reason: "本地工作区检测到旧的远程素材记录", Action: "请重新导入到本地资源目录后重试"}}
	}
	if policy.KeepLocal {
		media.URL = ""
		media.DataURL = ""
		applyResourceMetadata(media, resource)
		return nil
	}
	if runtime.Resources.LocalMode() && policy.RequireURL && !policy.ManualURL && runtime.ReferenceStorage != nil {
		enabled, err := runtime.ReferenceStorage.Enabled()
		if err != nil {
			return RequestPreparationError{Cause: ReferenceStoragePreparationError{Cause: err}}
		}
		if enabled {
			link, err := runtime.ReferenceStorage.Upload(ctx, userID, resourceID)
			if err != nil {
				return RequestPreparationError{Cause: ReferenceStoragePreparationError{Cause: err}}
			}
			media.URL, media.DataURL = link, ""
			applyResourceMetadata(media, resource)
			return nil
		}
	}
	if policy.PreferHTTPS {
		if httpsURL, err := runtime.Resources.HTTPSPublicURL(resource, time.Now().Add(ResourceURLTTL)); err == nil {
			media.URL = httpsURL
			media.DataURL = ""
			applyResourceMetadata(media, resource)
			return nil
		}
	}
	useObjectURL := policy.RequireURL || (policy.PreferURL && resource.UsesObjectStorage())
	if useObjectURL {
		if runtime.Resources.LocalMode() && policy.RequireURL {
			return RequestPreparationError{Cause: PreparationUserError{
				Category: CategoryInvalidParams,
				Reason:   "当前模型协议要求公网素材地址，本地工作区尚未开启对象存储自动上传",
				Action:   "请前往设置 → 存储设置开启「参考素材对象存储」，或在模型设置中切换参考素材传输方式 / 改用支持内嵌素材的模型后重试",
			}}
		}
		signedURL, err := runtime.Resources.PublicURL(resource, time.Now().Add(ResourceURLTTL))
		if err != nil {
			return fmt.Errorf("生成参考素材地址失败：%w", err)
		}
		media.URL = signedURL
		media.DataURL = ""
		applyResourceMetadata(media, resource)
		return nil
	}
	if strings.HasPrefix(strings.TrimSpace(media.DataURL), "data:") {
		return nil
	}
	resource, body, err := runtime.Resources.Open(userID, resourceID)
	if err != nil {
		return fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	defer body.Close()
	resourceLimit := MaxResponseBytes
	if runtime.Limits != nil {
		limit, limitErr := runtime.Limits.ResourceUploadBytes(ctx)
		if limitErr != nil {
			return limitErr
		}
		resourceLimit = limit
	}
	data, err := io.ReadAll(io.LimitReader(body, resourceLimit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > resourceLimit {
		return RequestPreparationError{Cause: PreparationUserError{Category: CategoryInputTooLarge, Reason: fmt.Sprintf("任务参考资源超过 %s", formatStorageLimit(resourceLimit)), Action: "请压缩素材或调高资源上限后重试"}}
	}
	mimeType := NormalizedMediaMIMEType(firstNonEmpty(media.MimeType, resource.MimeType), data)
	media.DataURL = DataURL(mimeType, data)
	media.MimeType = mimeType
	media.Bytes = int64(len(data))
	media.Width = resource.Width
	media.Height = resource.Height
	if resource.DurationMs > 0 {
		media.DurationMs = resource.DurationMs
	}
	return nil
}

func applyResourceMetadata(media *Media, resource ResourceInfo) {
	media.MimeType = firstNonEmpty(media.MimeType, resource.MimeType)
	media.Bytes = resource.Size
	if resource.Width > 0 {
		media.Width = resource.Width
	}
	if resource.Height > 0 {
		media.Height = resource.Height
	}
	if resource.DurationMs > 0 {
		media.DurationMs = resource.DurationMs
	}
}

func MediaBytes(media Media) ([]byte, string, error) {
	value := media.DataURL
	if value == "" {
		value = media.URL
	}
	if !strings.HasPrefix(value, "data:") {
		return nil, "", errors.New("后端任务队列需要 data URL 形式的本地参考素材")
	}
	header, encoded, ok := strings.Cut(value, ",")
	if !ok {
		return nil, "", errors.New("data URL 格式错误")
	}
	mimeType := strings.TrimPrefix(strings.Split(strings.TrimPrefix(header, "data:"), ";")[0], " ")
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, "", err
	}
	return raw, NormalizedMediaMIMEType(defaultString(mimeType, media.Type), raw), nil
}

func NormalizedMediaMIMEType(declared string, data []byte) string {
	declared = strings.TrimSpace(strings.Split(declared, ";")[0])
	if declared != "" && declared != "application/octet-stream" {
		return declared
	}
	detected := strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0])
	if (detected == "" || detected == "application/octet-stream") && len(data) >= 12 && string(data[4:8]) == "ftyp" {
		if string(data[8:10]) == "qt" {
			return "video/quicktime"
		}
		switch string(data[8:12]) {
		case "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "hev1", "hvc1", "dash", "M4V ", "f4v ", "MSNV":
			return "video/mp4"
		}
	}
	return defaultString(detected, "application/octet-stream")
}

func DataURL(mimeType string, data []byte) string {
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return "data:" + strings.Split(mimeType, ";")[0] + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func WithSystemPrompt(config Config, prompt string) string {
	systemPrompt := strings.TrimSpace(config.SystemPrompt)
	if systemPrompt == "" {
		return prompt
	}
	return systemPrompt + "\n\n" + prompt
}

func OpenAIImageInputURL(media Media) (string, error) {
	value := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(value, "data:image/") {
		return value, nil
	}
	if strings.HasPrefix(value, "data:") {
		return "", errors.New("参考图片 MIME 类型无效，请重新读取或上传图片")
	}
	value = strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "data:image/") || IsPublicMediaURL(value) {
		return value, nil
	}
	if strings.HasPrefix(value, "data:") {
		return "", errors.New("参考图片 MIME 类型无效，请重新读取或上传图片")
	}
	return "", errors.New("OpenAI 文本多模态参考图片需要公网 URL 或 base64 data URL")
}

func OpenAIVideoInputURL(media Media) (string, error) {
	value := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(value, "data:video/") {
		return value, nil
	}
	if strings.HasPrefix(value, "data:") {
		return "", errors.New("参考视频 MIME 类型无效，请重新读取或上传视频")
	}
	value = strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "data:video/") || IsPublicMediaURL(value) {
		return value, nil
	}
	if strings.HasPrefix(value, "data:") {
		return "", errors.New("参考视频 MIME 类型无效，请重新读取或上传视频")
	}
	return "", errors.New("文本多模态参考视频需要公网 URL 或 base64 data URL")
}

func openAIImageInputURL(media Media) (string, error) { return OpenAIImageInputURL(media) }
func openAIVideoInputURL(media Media) (string, error) { return OpenAIVideoInputURL(media) }
