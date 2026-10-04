package generation

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/kernel"
)

// ValidateMediaTransport uses the same installed contract as execution, without
// reading file bytes, uploading anything, or creating a provider task.
func ValidateMediaTransport(ctx context.Context, input Input) error {
	policy := MediaHydrationPolicyFor(ctx, input)
	if !policy.RequireURL || policy.KeepLocal {
		return nil
	}
	runtime, _ := RuntimeFromContext(ctx)
	var blocked []string
	groups := []struct {
		label string
		items []Media
	}{
		{"参考图片", input.ReferenceImages}, {"参考视频", input.ReferenceVideos}, {"参考音频", input.ReferenceAudios},
	}
	if input.Mask != nil {
		groups = append(groups, struct {
			label string
			items []Media
		}{"遮罩", []Media{*input.Mask}})
	}
	for _, group := range groups {
		for i, media := range group.items {
			if strings.HasPrefix(media.StorageKey, "resource:") {
				if runtime.Resources != nil && !runtime.Resources.LocalMode() {
					continue // Hosted resources are resolved by the owned resource port.
				}
			} else if address, err := url.Parse(strings.TrimSpace(media.URL)); err == nil && address.Scheme == "https" && address.Hostname() != "" && address.User == nil {
				continue
			}
			blocked = append(blocked, fmt.Sprintf("%s %d", group.label, i+1))
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	return &kernel.AppError{Status: 400, Code: 400, Reason: "reference_media_requires_url", Message: "当前渠道需要在线素材链接：" + strings.Join(blocked, "、") + "无法直接读取。请替换为可访问的 HTTPS 链接，或切换支持本地素材的渠道"}
}
