package app

import (
	"context"
	"strings"
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
	return s.workflowClient(nil).FetchSettingsApp(ctx, workflowConfigFromProvider(config), req)
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
