package app

// ComfyUI 的 /object_info 是 969 个节点的完整定义（本机实测约 1.9 MB），
// 既不适合整包回传浏览器，也超出配置界面真正需要的范围。这里只按工作流实际
// 引用的 class_type 裁剪出可配置输入，并标记连线输入供前端排除。

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ComfyUIObjectInfoRequest 请求指定节点的输入定义。
type ComfyUIObjectInfoRequest struct {
	BaseURL    string   `json:"baseUrl"`
	ClassTypes []string `json:"classTypes"`
}

// ComfyUIObjectInput 是裁剪后的单个输入定义。
type ComfyUIObjectInput struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Required  bool   `json:"required"`
	Multiline bool   `json:"multiline,omitempty"`
	// Link 为 true 表示该输入只能由上游节点连线提供（如 CLIP/MODEL/LATENT），
	// 字段映射必须把它排除在外，否则会把工作流拓扑拆坏。
	Link    bool          `json:"link,omitempty"`
	Options []interface{} `json:"options,omitempty"`
	Min     interface{}   `json:"min,omitempty"`
	Max     interface{}   `json:"max,omitempty"`
	Step    interface{}   `json:"step,omitempty"`
	Default interface{}   `json:"default,omitempty"`
}

// ComfyUIObjectNode 是裁剪后的节点定义。
type ComfyUIObjectNode struct {
	ClassType   string               `json:"classType"`
	DisplayName string               `json:"displayName,omitempty"`
	Category    string               `json:"category,omitempty"`
	Inputs      []ComfyUIObjectInput `json:"inputs"`
}

// FetchComfyUIObjectInfo 读取并裁剪 ComfyUI 的节点定义。
func (s *Service) FetchComfyUIObjectInfo(ctx context.Context, request ComfyUIObjectInfoRequest) (map[string]any, error) {
	root := comfyUIRootURL(request.BaseURL)
	if _, err := ValidateOutboundURL(root); err != nil {
		return nil, err
	}
	wanted := make(map[string]struct{}, len(request.ClassTypes))
	for _, classType := range request.ClassTypes {
		if trimmed := strings.TrimSpace(classType); trimmed != "" {
			wanted[trimmed] = struct{}{}
		}
	}
	if len(wanted) == 0 {
		return nil, errors.New("ComfyUI 节点定义查询缺少 classTypes")
	}
	var payload map[string]any
	if err := comfyUIGetJSON(withProviderRequestKind(ctx, "object-info"), root+"/object_info", &payload); err != nil {
		return nil, fmt.Errorf("读取 ComfyUI 节点定义失败：%w", err)
	}
	classTypes := make([]string, 0, len(wanted))
	for classType := range wanted {
		classTypes = append(classTypes, classType)
	}
	sort.Strings(classTypes)
	nodes := make([]ComfyUIObjectNode, 0, len(classTypes))
	for _, classType := range classTypes {
		raw, ok := payload[classType].(map[string]interface{})
		if !ok {
			// 自定义节点未安装时上游没有该定义；跳过而不是整体失败，
			// 让前端仍能展示其余节点的枚举与范围。
			continue
		}
		nodes = append(nodes, comfyUIObjectNode(classType, raw))
	}
	return map[string]any{"baseUrl": root, "nodes": nodes}, nil
}

func comfyUIObjectNode(classType string, raw map[string]interface{}) ComfyUIObjectNode {
	node := ComfyUIObjectNode{
		ClassType:   classType,
		DisplayName: strings.TrimSpace(stringValue(raw["display_name"])),
		Category:    strings.TrimSpace(stringValue(raw["category"])),
		Inputs:      []ComfyUIObjectInput{},
	}
	input, _ := raw["input"].(map[string]interface{})
	for _, group := range []string{"required", "optional"} {
		spec, _ := input[group].(map[string]interface{})
		if len(spec) == 0 {
			continue
		}
		for _, name := range comfyUIInputOrder(raw, group, spec) {
			value, ok := spec[name]
			if !ok {
				continue
			}
			node.Inputs = append(node.Inputs, comfyUIObjectInput(name, value, group == "required"))
		}
	}
	return node
}

// comfyUIInputOrder 优先使用 ComfyUI 给出的 input_order，保持界面上的字段顺序
// 与节点源码一致；缺失时回退到稳定的字典序。input_order 与 input 同级，都在
// 节点对象上。
func comfyUIInputOrder(node map[string]interface{}, group string, spec map[string]interface{}) []string {
	fallback := make([]string, 0, len(spec))
	for name := range spec {
		fallback = append(fallback, name)
	}
	sort.Strings(fallback)
	order, _ := node["input_order"].(map[string]interface{})
	names, _ := order[group].([]interface{})
	if len(names) == 0 {
		return fallback
	}
	result := make([]string, 0, len(names))
	for _, name := range names {
		if value := strings.TrimSpace(stringValue(name)); value != "" {
			result = append(result, value)
		}
	}
	if len(result) == 0 {
		return fallback
	}
	return result
}

func comfyUIObjectInput(name string, raw interface{}, required bool) ComfyUIObjectInput {
	input := ComfyUIObjectInput{Name: name, Required: required}
	items, ok := raw.([]interface{})
	if !ok || len(items) == 0 {
		return input
	}
	switch first := items[0].(type) {
	case []interface{}:
		// 首元素是数组即枚举，枚举值可能不是字符串。
		input.Type = "COMBO"
		input.Options = first
	default:
		input.Type = strings.ToUpper(strings.TrimSpace(stringValue(first)))
	}
	if input.Type != "" && input.Type != "COMBO" && !isComfyUILiteralInputType(input.Type) {
		input.Link = true
	}
	if len(items) > 1 {
		if spec, ok := items[1].(map[string]interface{}); ok {
			input.Min = spec["min"]
			input.Max = spec["max"]
			input.Step = spec["step"]
			input.Default = spec["default"]
			if multiline, ok := spec["multiline"].(bool); ok && multiline {
				input.Multiline = true
			}
		}
	}
	return input
}

// isComfyUILiteralInputType 判断输入是否由用户直接填写字面量。
// CLIP/MODEL/VAE/LATENT/IMAGE 等类型只能由上游节点连线提供。
func isComfyUILiteralInputType(value string) bool {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "STRING", "INT", "FLOAT", "BOOLEAN", "COMBO", "NUMBER", "SLIDER":
		return true
	default:
		return false
	}
}
