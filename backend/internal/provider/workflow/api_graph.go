package workflow

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// BindAPIGraph preserves typed widgets and links; only explicitly enabled
// bindings can replace a scalar input. RunningHub and Comfy share field roles.
func BindAPIGraph(input Input, files map[string]string) (map[string]any, error) {
	encoded, err := json.Marshal(input.Config.WorkflowJSON)
	if err != nil {
		return nil, err
	}
	var graph map[string]any
	if err := json.Unmarshal(encoded, &graph); err != nil || len(graph) == 0 {
		return nil, fmt.Errorf("请导入 API 格式工作流")
	}
	if err := validateWorkflowMediaInputs(input.Config.WorkflowFields, input); err != nil {
		return nil, err
	}
	for _, field := range input.Config.WorkflowFields {
		if field.Enabled != nil && !*field.Enabled {
			continue
		}
		node, ok := graph[field.NodeID].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("工作流节点 %s 不存在", field.NodeID)
		}
		values, ok := node["inputs"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("节点 %s 缺少输入定义", field.NodeID)
		}
		original, exists := values[field.FieldName]
		if !exists || isWorkflowLinkValue(original) {
			return nil, fmt.Errorf("不能覆盖工作流连线或不存在的字段 %s.%s", field.NodeID, field.FieldName)
		}
		value, present, err := resolveWorkflowFieldValue(field, files, input)
		if err != nil {
			return nil, err
		}
		if !present {
			if field.Required {
				return nil, fmt.Errorf("字段 %s.%s 缺少输入", field.NodeID, field.FieldName)
			}
			continue
		}
		if err := validateRunningHubWorkflowFieldValue(field, value); err != nil {
			return nil, err
		}
		switch original.(type) {
		case float64:
			if text, ok := value.(string); ok {
				value, err = strconv.ParseFloat(strings.TrimSpace(text), 64)
			}
		case bool:
			if text, ok := value.(string); ok {
				value, err = strconv.ParseBool(strings.TrimSpace(text))
			}
		}
		if err != nil {
			return nil, fmt.Errorf("字段 %s.%s 参数类型不匹配", field.NodeID, field.FieldName)
		}
		values[field.FieldName] = value
	}
	return graph, nil
}
