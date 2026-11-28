package app

import (
	"cmp"
	"context"
	"encoding/json"
	"strings"
	"time"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/operations"
)

func (s *operationSession) ReviewMedia(ctx context.Context, part operations.MediaPart, question string) (operations.MediaReviewObservation, error) {
	modality := modelcatalog.MediaReviewModalityForMime(part.MimeType)
	if modality == "" {
		return operations.MediaReviewObservation{}, operations.InvalidArg("media_review_requires_media", "审片工具只接受已校验的视频、音频或图片片段")
	}
	snapshot, err := s.service.assistantConfig()
	if err != nil {
		return operations.MediaReviewObservation{}, err
	}
	provider, reason := modelcatalog.ResolveMediaReviewProviderForModality(snapshot, modality, s.service.assistantManagedCredentialLookup())
	if reason != "" {
		return operations.MediaReviewObservation{}, operations.Unsupported("media_review_unavailable", "请在设置的默认模型中选择支持该媒体类型的多模态模型")
	}
	return reviewMediaWithProvider(ctx, provider, part, question)
}

func reviewMediaWithProvider(ctx context.Context, provider AssistantProvider, part operations.MediaPart, question string) (operations.MediaReviewObservation, error) {
	modality := modelcatalog.MediaReviewModalityForMime(part.MimeType)
	if modality == "" {
		return operations.MediaReviewObservation{}, operations.InvalidArg("media_review_requires_media", "审片工具只接受已校验的视频、音频或图片片段")
	}
	if len(provider.InputModalities) > 0 && !modelcatalog.ProviderSupportsMediaModality(provider, modality) {
		return operations.MediaReviewObservation{}, operations.Unsupported("media_review_unavailable", "当前配置的审片模型不支持该媒体类型")
	}
	body, ok := modelcatalog.BuildMediaReviewRequest(provider, part.MimeType, part.Data, question)
	if !ok {
		return operations.MediaReviewObservation{}, operations.InvalidArg("media_review_requires_media", "审片工具只接受已校验的视频、音频或图片片段")
	}
	ctx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	var response struct {
		ID        string          `json:"id"`
		RequestID string          `json:"request_id"`
		Model     string          `json:"model"`
		Usage     json.RawMessage `json:"usage"`
		Choices   []struct {
			Message      struct{ Content string `json:"content"` } `json:"message"`
			FinishReason string                                     `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := generation.PostJSON(ctx, generation.Config{BaseURL: provider.BaseURL, APIKey: provider.APIKey, Model: provider.Model}, "/chat/completions", body, &response); err != nil {
		return operations.MediaReviewObservation{}, operations.PreconditionFailed("media_review_failed", "审片请求未取得有效结果；保留原素材，不自动重复付费请求", nil)
	}
	if len(response.Choices) != 1 || strings.TrimSpace(response.Choices[0].Message.Content) == "" || response.Choices[0].FinishReason != "stop" || len(response.Choices[0].Message.Content) > 64000 {
		return operations.MediaReviewObservation{}, operations.PreconditionFailed("media_review_incomplete", "审片结果为空、截断或未完成，不能据此判断通过", nil)
	}
	return operations.MediaReviewObservation{Model: provider.Model, RequestID: cmp.Or(response.RequestID, response.ID), Text: response.Choices[0].Message.Content, Usage: response.Usage}, nil
}

var _ operations.MediaReviewer = (*operationSession)(nil)
