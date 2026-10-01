package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	root := runningHubRootURL(config.BaseURL)
	var response map[string]any
	if err := s.runningHubJSON(ctx, config, root+"/api/openapi/getJsonApiFormat", map[string]any{"apiKey": runningHubAPIKey(config), "workflowId": workflowID}, &response); err != nil {
		return nil, fmt.Errorf("拉取 RunningHub 工作流参数失败：%w", err)
	}
	data, _ := response["data"].(map[string]any)
	if data == nil {
		return nil, errors.New("RunningHub 工作流参数响应缺少 data")
	}
	workflowJSON := map[string]any{}
	if prompt, ok := data["prompt"].(string); ok && strings.TrimSpace(prompt) != "" {
		if err := json.Unmarshal([]byte(prompt), &workflowJSON); err != nil {
			return nil, fmt.Errorf("RunningHub 工作流 JSON 解析失败：%w", err)
		}
	} else if prompt, ok := data["prompt"].(map[string]any); ok {
		workflowJSON = prompt
	}
	return map[string]any{"workflowId": workflowID, "kind": "workflow", "title": firstNonEmptyString(req.Title, workflowID), "fields": collectManagementWorkflowFields(workflowJSON, req.Capability), "workflowJson": workflowJSON, "raw": response}, nil
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
	result := map[string]any{"kind": "app", "webappId": webappID, "workflowId": webappID, "title": firstNonEmptyString(req.Title, webappID), "fields": []map[string]any{}, "raw": response}
	if rawData != nil {
		result["fields"] = normalizeManagementAppFields(rawData["nodeInfoList"], req.Capability)
	}
	return result, nil
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
		return config, BadAuthRequest("请先填写 RunningHub 积分 API Key")
	}
	return config, nil
}
