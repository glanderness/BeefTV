package agentops

import (
	"encoding/json"
	"infinite-canvas/backend/internal/skills"
	"strings"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/operations"
)

// AssistantScope 是内置助手的可信范围：当前画布 + 后端验证过归属的额外引用，
// 以及当前画布文档里真实关联的素材与任务。
//
// 这个范围只能由后端从回合记录构造；模型给的工具参数无法扩大它，
// 所以「提示词里说可以读」不会变成真实权限。
type AssistantScope struct {
	PermissionMode   string
	CanvasID         string
	AssetIDs         map[string]bool
	CanvasIDs        map[string]bool
	TaskIDs          map[string]bool
	SkillPins        map[string]skills.Pin
	ProjectReference func(kind, id string) error // Go-only DB resolver, never model supplied.
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
	case "canvas.get", "canvas.node.update", "canvas.node.configure", "canvas.node.move", "canvas.node.delete", "canvas.edge.delete", "canvas.nodes.create", "canvas.edge.create", "canvas.timeline.update",
		"canvas.timeline.render", "canvas.generation.propose", "canvas.task.bind", "asset.get", "task.get":
		return true
	case "media.overview", "media.inspect", "media.check":
		return true
	case "skill.get", "skill.file":
		return true
	case "project.media.search", "project.canvas.search", "model.catalog":
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
	if op == nil {
		return false
	}
	switch assistantturns.Mode(s.PermissionMode) {
	case assistantturns.PermissionFullAccess:
		return op.Scope != operations.ScopeConversation
	case assistantturns.PermissionReadOnly:
		return op.ReadOnly && op.ID != "canvas.generation.propose"
	default:
		return assistantVisible(op)
	}
}

func (s *AssistantScope) Allows(op *operations.Op, params json.RawMessage) error {
	if s == nil {
		return nil
	}
	if strings.TrimSpace(s.CanvasID) == "" {
		return denied("当前会话没有绑定画布")
	}
	if !s.Visible(op) {
		return denied("本轮助手权限不允许该操作")
	}
	var args struct {
		CanvasID    string `json:"canvasId"`
		NodeID      string `json:"nodeId"`
		AssetID     string `json:"assetId"`
		TaskID      string `json:"taskId"`
		SkillID     string `json:"skillId"`
		VersionID   string `json:"versionId"`
		ContentHash string `json:"contentHash"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &args)
	}
	// Broad modes rely on each shared domain handler's current ownership check.
	// Skills remain pinned rather than discovering filesystem instructions.
	if assistantturns.Mode(s.PermissionMode) != assistantturns.PermissionCanvas && op.ID != "skill.get" && op.ID != "skill.file" {
		return nil
	}
	switch op.ID {
	case "model.catalog":
		return nil
	case "project.media.search", "project.canvas.search":
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能搜索当前画布所属项目")
	case "skill.get", "skill.file":
		pin, ok := s.SkillPins[args.SkillID]
		if ok && pin.VersionID == args.VersionID && pin.ContentHash == args.ContentHash {
			return nil
		}
		return denied("只能读取本轮明确选择的技能版本")
	case "canvas.get":
		if s.canvasAllowed(args.CanvasID) || s.projectReferenceAllowed("canvas", args.CanvasID) {
			return nil
		}
		return denied("只能读取当前画布或已在界面里引用的画布")
	case "canvas.node.update", "canvas.node.configure", "canvas.node.move", "canvas.node.delete", "canvas.edge.delete", "canvas.nodes.create", "canvas.edge.create", "canvas.generation.propose", "canvas.task.bind", "canvas.timeline.update", "canvas.timeline.render":
		// 写只允许落在当前画布：跨画布写即便带上合法 canvasId 也必须拒绝。
		if args.CanvasID == s.CanvasID {
			return nil
		}
		return denied("只能修改当前画布")
	case "asset.get":
		if s.AssetIDs[strings.TrimSpace(args.AssetID)] || s.projectReferenceAllowed("asset", args.AssetID) {
			return nil
		}
		return denied("这个素材与当前画布无关，也没有被本次对话引用")
	case "media.overview", "media.inspect", "media.check":
		if args.CanvasID != s.CanvasID {
			return denied("只能检查当前画布关联的媒体")
		}
		if args.NodeID != "" && args.AssetID == "" {
			return nil
		}
		if args.AssetID != "" && args.NodeID == "" && (s.AssetIDs[args.AssetID] || s.projectReferenceAllowed("asset", args.AssetID)) {
			return nil
		}
		return denied("这个媒体未关联到当前画布或本次对话")
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

func (s *AssistantScope) projectReferenceAllowed(kind, id string) bool {
	return id != "" && s.ProjectReference != nil && s.ProjectReference(kind, id) == nil
}

func denied(message string) *Error {
	return operations.PermissionDenied("scope_denied", message)
}

var _ operations.Authorizer = (*AssistantScope)(nil)
