package agentops

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/operations"
)

// AssistantScope 是内置助手的可信范围：当前画布 + 后端验证过归属的额外引用，
// 以及当前画布文档里真实关联的素材与任务。
//
// 这个范围只能由后端从回合记录构造；模型给的工具参数无法扩大它，
// 所以「提示词里说可以读」不会变成真实权限。
type AssistantScope struct {
	CanvasID  string
	AssetIDs  map[string]bool
	CanvasIDs map[string]bool
	TaskIDs   map[string]bool
}

// assistantVisible 是内置助手可见的能力集合：
// 当前画布读写、单个素材/任务读取与付费生成提议。
// 工作区级列举（asset.list、canvas.search）不在其中——它们没有可校验的单资源归属，
// 不能用提示词代替授权。
func assistantVisible(op *operations.Op) bool {
	if op == nil {
		return false
	}
	switch op.ID {
	case "canvas.get", "canvas.node.update", "canvas.nodes.create", "canvas.edge.create",
		"canvas.generation.propose", "canvas.task.bind", "asset.get", "task.get":
		return true
	default:
		return false
	}
}

// Allows 判断一次调用是否落在助手范围内；越界返回结构化的 scope_denied。
func (s *AssistantScope) Visible(op *operations.Op) bool {
	if s == nil {
		return true
	}
	return assistantVisible(op)
}

func (s *AssistantScope) Allows(op *operations.Op, params json.RawMessage) error {
	if s == nil {
		return nil
	}
	if strings.TrimSpace(s.CanvasID) == "" {
		return denied("当前会话没有绑定画布")
	}
	var args struct {
		CanvasID string `json:"canvasId"`
		NodeID   string `json:"nodeId"`
		AssetID  string `json:"assetId"`
		TaskID   string `json:"taskId"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &args)
	}
	switch op.ID {
	case "canvas.get":
		if s.canvasAllowed(args.CanvasID) {
			return nil
		}
		return denied("只能读取当前画布或已在界面里引用的画布")
	case "canvas.node.update", "canvas.nodes.create", "canvas.edge.create", "canvas.generation.propose", "canvas.task.bind":
		// 写只允许落在当前画布：跨画布写即便带上合法 canvasId 也必须拒绝。
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能修改当前画布")
	case "asset.get":
		if s.AssetIDs[strings.TrimSpace(args.AssetID)] {
			return nil
		}
		return denied("这个素材与当前画布无关，也没有被本次对话引用")
	case "task.get":
		if s.TaskIDs[strings.TrimSpace(args.TaskID)] {
			return nil
		}
		return denied("这个任务与当前画布无关")
	default:
		return denied("内置助手不能调用该操作")
	}
}

func (s *AssistantScope) canvasAllowed(canvasID string) bool {
	trimmed := strings.TrimSpace(canvasID)
	if trimmed == "" {
		return false
	}
	return trimmed == s.CanvasID || s.CanvasIDs[trimmed]
}

func denied(message string) *Error {
	return operations.PermissionDenied("scope_denied", message)
}

var _ operations.Authorizer = (*AssistantScope)(nil)
