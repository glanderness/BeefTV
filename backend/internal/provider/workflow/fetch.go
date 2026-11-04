package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// FetchSettingsWorkflow loads settings-page workflow JSON. Empty prompt is a
// valid empty schema. Settings metadata is validated by schema, including gateways with nonzero codes.
func (c *Client) FetchSettingsWorkflow(ctx context.Context, config Config, req FetchRequest) (map[string]any, error) {
	exec := c.prepared()
	if exec.Requests == nil {
		return nil, errors.New("工作流缺少受保护的请求执行端口")
	}
	workflowID := strings.TrimSpace(req.WorkflowID)
	if workflowID == "" {
		return nil, errors.New("workflowId 不能为空")
	}
	root := runningHubRootURL(config.BaseURL)
	response, err := exec.PostJSON(ctx, config, root+"/api/openapi/getJsonApiFormat", "", map[string]any{
		"apiKey":     runningHubAPIKey(config),
		"workflowId": workflowID,
	})
	if err != nil {
		return nil, fmt.Errorf("拉取 RunningHub 工作流参数失败：%w", err)
	}
	data, _ := response["data"].(map[string]any)
	if data == nil {
		return nil, errors.New("RunningHub 工作流参数响应缺少 data")
	}
	if _, exists := data["prompt"]; !exists {
		return nil, errors.New("RunningHub 工作流参数响应缺少 prompt")
	}
	workflowJSON, err := parseWorkflowPrompt(data["prompt"], false)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"workflowId":   workflowID,
		"kind":         "workflow",
		"title":        firstNonEmpty(req.Title, workflowID),
		"fields":       CollectFields(workflowJSON, req.Capability),
		"workflowJson": workflowJSON,
	}, nil
}

func parseWorkflowPrompt(raw any, required bool) (map[string]any, error) {
	if required {
		if raw == nil {
			return nil, errors.New("RunningHub 工作流参数响应缺少 prompt")
		}
		if text, ok := raw.(string); ok {
			var parsed map[string]interface{}
			if err := json.Unmarshal([]byte(text), &parsed); err != nil {
				return nil, err
			}
			return parsed, nil
		}
		parsed, ok := raw.(map[string]interface{})
		if !ok {
			return nil, errors.New("RunningHub 工作流参数格式无效")
		}
		return parsed, nil
	}
	workflowJSON := map[string]any{}
	if prompt, ok := raw.(string); ok && strings.TrimSpace(prompt) != "" {
		if err := json.Unmarshal([]byte(prompt), &workflowJSON); err != nil {
			return nil, fmt.Errorf("RunningHub 工作流 JSON 解析失败：%w", err)
		}
	} else if prompt, ok := raw.(map[string]any); ok {
		workflowJSON = prompt
	} else if _, ok := raw.(string); !ok {
		return nil, errors.New("RunningHub 工作流参数格式无效")
	}
	if workflowJSON == nil {
		return nil, errors.New("RunningHub 工作流参数格式无效")
	}
	return workflowJSON, nil
}

func (c *Client) FetchSettingsApp(ctx context.Context, config Config, req FetchRequest) (map[string]any, error) {
	webappID := strings.TrimSpace(req.WebappID)
	root := runningHubRootURL(config.BaseURL)
	var response map[string]any
	if err := c.PostJSONTarget(ctx, config, root+"/api/webapp/apiCallDemo", map[string]any{
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
	return map[string]any{"kind": "app", "webappId": webappID, "workflowId": webappID, "title": firstNonEmpty(req.Title, webappID), "fields": CollectAppFields(nodes, req.Capability)}, nil
}
