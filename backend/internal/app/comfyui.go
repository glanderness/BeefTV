package app

import (
	"context"
	"errors"
	"net/http"

	"infinite-canvas/backend/internal/provider/workflow"
)

type ComfyUIInspectRequest struct {
	BaseURL      string           `json:"baseUrl"`
	APIKey       string           `json:"apiKey"`
	Headers      []OutboundHeader `json:"headers"`
	Capability   string           `json:"capability"`
	WorkflowJSON map[string]any   `json:"workflowJson"`
}

func (s *Service) InspectComfyUI(ctx context.Context, req ComfyUIInspectRequest) (map[string]any, error) {
	headers, err := NormalizeOutboundHeaders(req.Headers)
	if err != nil {
		return nil, mapOutboundError(err)
	}
	if _, err := workflow.ComfyUIRootURL(req.BaseURL); err != nil {
		return nil, WrapAppError(http.StatusBadRequest, "ComfyUI 地址不可用，请检查服务地址和后端出站网络配置", err)
	}
	config := workflow.Config{BaseURL: req.BaseURL, APIKey: req.APIKey, Headers: headers, WorkflowJSON: req.WorkflowJSON}
	result, err := s.workflowClient(nil).InspectComfyUI(ctx, config, req.Capability)
	if err == nil {
		return result, nil
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return nil, appErr
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, WrapAppError(http.StatusBadGateway, "无法读取 ComfyUI 节点与模型目录，请检查服务地址、网络和鉴权设置", err)
}
