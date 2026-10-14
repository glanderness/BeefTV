package app

import (
	"context"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/provider/workflow"
)

func (s *Service) FetchRunningHubWorkflowInfo(ctx context.Context, req RunningHubWorkflowFetchRequest) (map[string]any, error) {
	workflowID := strings.TrimSpace(req.WorkflowID)
	if workflowID == "" {
		return nil, BadAuthRequest("workflowId 不能为空")
	}
	config, err := runningHubManagementConfig(req)
	if err != nil {
		return nil, err
	}
	return s.workflowClient(nil).FetchSettingsWorkflow(ctx, workflowConfigFromProvider(config), req)
}

func (s *Service) FetchRunningHubAppInfo(ctx context.Context, req RunningHubWorkflowFetchRequest) (map[string]any, error) {
	webappID := strings.TrimSpace(req.WebappID)
	if webappID == "" {
		return nil, BadAuthRequest("webappId 不能为空")
	}
	config, err := runningHubManagementConfig(req)
	if err != nil {
		return nil, err
	}
	root := runningHubRootURL(config.BaseURL)
	var response map[string]any
	if err := s.runningHubJSON(ctx, config, root+"/api/webapp/apiCallDemo", map[string]any{
		"apiKey":   runningHubAPIKey(config),
		"webappId": webappID,
	}, &response); err != nil {
		return nil, fmt.Errorf("拉取 RunningHub App 参数失败：%w", err)
	}
	if code, valid := runningHubPayloadCode(response); valid && code != 0 {
		return nil, fmt.Errorf("拉取 RunningHub App 参数失败：%s", runningHubFailureMessage(response))
	}
	rawData, _ := response["data"].(map[string]any)
	if rawData == nil {
		return nil, fmt.Errorf("RunningHub App 参数响应缺少 data")
	}
	nodes, valid := rawData["nodeInfoList"].([]any)
	if !valid {
		return nil, fmt.Errorf("RunningHub App 参数响应缺少有效的 nodeInfoList")
	}
	return map[string]any{"kind": "app", "webappId": webappID, "workflowId": webappID, "title": firstNonEmptyString(req.Title, webappID), "fields": workflow.CollectAppFields(nodes, req.Capability)}, nil
}

func runningHubManagementConfig(req RunningHubWorkflowFetchRequest) (providerConfig, error) {
	config := providerConfig{BaseURL: strings.TrimSpace(req.BaseURL), APIKey: strings.TrimSpace(req.APIKey), RunningHubWalletKey: strings.TrimSpace(req.WalletAPIKey), RunningHubUseWallet: req.UseWallet}
	if config.BaseURL == "" {
		config.BaseURL = "https://www.runninghub.cn"
	}
	if _, err := ValidateOutboundURL(runningHubRootURL(config.BaseURL)); err != nil {
		return config, err
	}
	if runningHubAPIKey(config) == "" {
		return config, BadAuthRequest("请先填写 RunningHub 消费级 API Key")
	}
	return config, nil
}
