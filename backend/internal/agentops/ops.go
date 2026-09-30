package agentops

import (
	"crypto/rand"

	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/canvas/capability"
	"net/http"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/kernel"
)

// canvasCapabilities 是画布领域的真实能力描述注册表：
// 节点尺寸/metadata/连线策略都来自它，操作层不再自建第二套规格。
var canvasCapabilities = capability.BuiltinRegistry()

func newNodeID() string {
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("agent-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("agent-%d-%s", time.Now().UnixNano(), hex.EncodeToString(buf))
}

// RegisterDefaultOps 注册首版全部操作。生成/付费入口不在本轮暴露：
// 未经参数与费用风险验收的能力明确不注册，而不是提供 stub 伪成功。
func RegisterDefaultOps(r *Registry) {
	r.Register(Op{ID: "canvas.get", Summary: "读取指定画布的完整内容（节点与连线）", ReadOnly: true, Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"}},"required":["canvasId"]}`),
		Handler: opCanvasGet})
	r.Register(Op{ID: "canvas.search", Summary: "按关键字分页搜索工作区内的画布", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer"},"pageSize":{"type":"integer"},"query":{"type":"string"},"canvasId":{"type":"string"},"sort":{"type":"string"}}}`),
		Handler: opCanvasSearch})
	r.Register(Op{ID: "asset.list", Summary: "分页列出用户素材库中的素材", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer"},"pageSize":{"type":"integer"},"query":{"type":"string"},"kind":{"type":"string"},"category":{"type":"string"}}}`),
		Handler: opAssetList})
	r.Register(Op{ID: "asset.get", Summary: "按 ID 读取单个素材", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"assetId":{"type":"string"}},"required":["assetId"]}`),
		Handler: opAssetGet})
	r.Register(Op{ID: "task.get", Summary: "按 ID 查询任务状态与产物引用", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params:  json.RawMessage(`{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}`),
		Handler: opTaskGet})
	r.Register(Op{ID: "canvas.node.update", Summary: "局部修改一个节点（只提交目标字段，其余数据保持原样，带 revision CAS）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"expectedRevision":{"type":"integer"},"patch":{"type":"object","properties":{"title":{"type":"string"},"prompt":{"type":"string"},"content":{"type":"string"}}}},"required":["canvasId","nodeId","patch","expectedRevision"]}`),
		Handler: opCanvasNodeUpdate})
	r.Register(Op{ID: "canvas.nodes.create", Summary: "在画布上批量创建节点（整批校验，带 revision CAS）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer"},"nodes":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"type":{"type":"string"},"prompt":{"type":"string"}},"required":["title","type"]}}},"required":["canvasId","nodes","expectedRevision"]}`),
		Handler: opCanvasNodesCreate})
	r.Register(Op{ID: "canvas.edge.create", Summary: "连接两个节点（重复连接幂等返回）", Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"fromNodeId":{"type":"string"},"toNodeId":{"type":"string"},"expectedRevision":{"type":"integer"}},"required":["canvasId","fromNodeId","toNodeId","expectedRevision"]}`),
		Handler: opCanvasEdgeCreate})
	// 付费生成只提议不执行：这里校验目标并给出用户要确认的模型，真正的生成由界面在用户确认后发起。
	r.Register(Op{ID: "canvas.generation.propose", Summary: "提议对选中节点做付费图片/视频生成（只登记提议，不生成、不扣费）", ReadOnly: true, Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeIds":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8},"kind":{"type":"string","enum":["image","video"]},"note":{"type":"string"}},"required":["canvasId","nodeIds","kind"]}`),
		Handler: opCanvasGenerationPropose})
}

func opCanvasGenerationPropose(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID string   `json:"canvasId"`
		NodeIDs  []string `json:"nodeIds"`
		Kind     string   `json:"kind"`
		Note     string   `json:"note"`
	}
	if err := json.Unmarshal(params, &args); err != nil {
		return nil, InvalidArg("invalid_params", err.Error())
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if args.Kind != "image" && args.Kind != "video" {
		return nil, InvalidArg("invalid_kind", "kind 只能是 image 或 video")
	}
	if len(args.NodeIDs) == 0 || len(args.NodeIDs) > 8 {
		return nil, InvalidArg("invalid_batch", "nodeIds 必须是 1..8 项的数组")
	}
	raw, err := ctx.Services.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	owned := map[string]bool{}
	for _, rawNode := range canvasNodes(doc) {
		if node, ok := rawNode.(map[string]any); ok {
			if id, _ := node["id"].(string); id != "" {
				owned[id] = true
			}
		}
	}
	seen := make(map[string]bool, len(args.NodeIDs))
	nodeIDs := make([]string, 0, len(args.NodeIDs))
	for _, id := range args.NodeIDs {
		if !owned[id] {
			return nil, InvalidArg("node_not_in_canvas", "节点不属于当前画布: "+id)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		nodeIDs = append(nodeIDs, id)
	}
	display, modelKey, configRevision, err := ctx.Services.AssistantGenerationModelSnapshot(args.Kind)
	if err != nil {
		return nil, AsError(err)
	}
	if display == "" {
		return nil, PreconditionFailed("generation_model_not_configured", "还没有设置默认的"+generationKindLabel(args.Kind)+"模型", nil)
	}
	return map[string]any{
		"proposalId": newProposalID(), "kind": args.Kind, "nodeIds": nodeIDs,
		"model": display, "modelKey": modelKey, "note": strings.TrimSpace(args.Note),
		"source": map[string]any{"canvasId": args.CanvasID, "canvasRevision": doc["revision"], "modelConfigRevision": configRevision},
	}, nil
}

func generationKindLabel(kind string) string {
	if kind == "video" {
		return "视频"
	}
	return "图片"
}

func newProposalID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("gp-%d", time.Now().UnixNano())
	}
	return "gp-" + hex.EncodeToString(buf)
}

func opCanvasGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
	}
	if err := json.Unmarshal(params, &args); err != nil || strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	raw, err := ctx.Services.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	return map[string]any{"canvasId": args.CanvasID, "canvas": sanitizeForClient(doc)}, nil
}

func opCanvasSearch(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		Page     int    `json:"page"`
		PageSize int    `json:"pageSize"`
		Query    string `json:"query"`
		CanvasID string `json:"canvasId"`
		Sort     string `json:"sort"`
	}
	if err := json.Unmarshal(params, &args); err != nil {
		return nil, InvalidArg("invalid_params", err.Error())
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	size := args.PageSize
	if size <= 0 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	result, err := ctx.Services.UserCanvasProjectsPage(ctx.UserID, page, size, args.CanvasID, args.Query, args.Sort)
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(result), nil
}

func opAssetList(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		Page     int    `json:"page"`
		PageSize int    `json:"pageSize"`
		Query    string `json:"query"`
		Kind     string `json:"kind"`
		Category string `json:"category"`
	}
	if err := json.Unmarshal(params, &args); err != nil {
		return nil, InvalidArg("invalid_params", err.Error())
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	size := args.PageSize
	if size <= 0 {
		size = 40
	}
	if size > 100 {
		size = 100
	}
	result, err := ctx.Services.UserAssetsPage(ctx.UserID, page, size, app.UserAssetPageFilter{
		Kind: args.Kind, Category: args.Category, Query: args.Query,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(result), nil
}

func opAssetGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		AssetID string `json:"assetId"`
	}
	if err := json.Unmarshal(params, &args); err != nil || strings.TrimSpace(args.AssetID) == "" {
		return nil, InvalidArg("invalid_params", "assetId 必填")
	}
	raw, err := ctx.Services.UserAssetWithTx(ctx.Tx, ctx.UserID, args.AssetID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var asset any
	if err := json.Unmarshal(raw, &asset); err != nil {
		return nil, AsError(err)
	}
	return map[string]any{"assetId": args.AssetID, "asset": sanitizeForClient(asset)}, nil
}

func opTaskGet(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(params, &args); err != nil || strings.TrimSpace(args.TaskID) == "" {
		return nil, InvalidArg("invalid_params", "taskId 必填")
	}
	task, err := ctx.Services.Task(ctx.UserID, args.TaskID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	if task == nil {
		return nil, NotFound("task_not_found", "任务不存在")
	}
	return map[string]any{
		"taskId": task.ID, "type": task.Type, "status": task.Status, "progress": task.Progress,
		"createdAt": task.CreatedAt, "updatedAt": task.UpdatedAt,
	}, nil
}

// canvasDoc 以 map 承载整份文档，保证未触碰的字段在写回时逐字保持原样。
func readCanvasDoc(ctx *Context, canvasID string) (map[string]any, error) {
	// 事务内读写共用同一条连接：避免单连接 SQLite 上自己等自己。
	raw, err := ctx.Services.UserCanvasProjectWithTx(ctx.Tx, ctx.UserID, canvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	return doc, nil
}

func canvasRevision(doc map[string]any) int64 {
	switch v := doc["revision"].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n
		}
	}
	return 0
}

func canvasNodes(doc map[string]any) []any {
	if nodes, ok := doc["nodes"].([]any); ok {
		return nodes
	}
	return []any{}
}

// requireRevision 要求写操作带上读取时的版本；没有观察前提就不允许写。
func requireRevision(expected int64) error {
	if expected <= 0 {
		return InvalidArg("missing_expected_revision",
			"写操作必须带上读取时的 expectedRevision：没有观察前提的写入会覆盖用户新编辑")
	}
	return nil
}

// writeCanvasDoc 把调用方观察到的 revision 原样放进 payload：
// 唯一裁决者是仓储的原子谓词（UPDATE ... WHERE revision = ?），
// 操作层不再自建第二套 CAS，也不把「刚读到的 revision」当作观察值（那会让 CAS 形同虚设）。
func writeCanvasDoc(ctx *Context, canvasID string, doc map[string]any, expectedRevision int64) (int64, error) {
	doc["id"] = canvasID
	doc["revision"] = expectedRevision
	encoded, err := json.Marshal(doc)
	if err != nil {
		return 0, AsError(err)
	}
	summary, err := ctx.Services.UpsertUserCanvasProjectWithTx(ctx.Tx, ctx.UserID, encoded)
	if err != nil {
		return 0, mapDomainError(err)
	}
	return summary.Revision, nil
}

func opCanvasNodeUpdate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		NodeID           string `json:"nodeId"`
		ExpectedRevision int64  `json:"expectedRevision"`
		Patch            struct {
			Title   *string `json:"title"`
			Prompt  *string `json:"prompt"`
			Content *string `json:"content"`
		} `json:"patch"`
	}
	if err := json.Unmarshal(params, &args); err != nil {
		return nil, InvalidArg("invalid_params", err.Error())
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.NodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 与 nodeId 必填")
	}
	patch := map[string]any{}
	if args.Patch.Title != nil {
		patch["title"] = *args.Patch.Title
	}
	if args.Patch.Prompt != nil {
		patch["prompt"] = *args.Patch.Prompt
	}
	if args.Patch.Content != nil {
		patch["content"] = *args.Patch.Content
	}
	if len(patch) == 0 {
		return nil, InvalidArg("empty_patch", "patch 至少要有一个字段")
	}
	// 领域实现拥有写入规则；操作层只转接，写入与操作记录同事务。
	if _, err := ctx.Services.UpdateUserCanvasNodeFieldsWithTx(ctx.Tx, ctx.UserID, args.CanvasID, args.NodeID, patch, args.ExpectedRevision); err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "node": findDocNode(doc, args.NodeID)}
	})
}
func opCanvasNodesCreate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		ExpectedRevision int64  `json:"expectedRevision"`
		Nodes            []struct {
			Title  string `json:"title"`
			Type   string `json:"type"`
			Prompt string `json:"prompt"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(params, &args); err != nil {
		return nil, InvalidArg("invalid_params", err.Error())
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if len(args.Nodes) == 0 || len(args.Nodes) > 8 {
		return nil, InvalidArg("invalid_batch", "nodes 必须是 1..8 项的数组")
	}
	drafts := make([]canvas.NodeDraft, 0, len(args.Nodes))
	titles := make([]string, 0, len(args.Nodes))
	for _, node := range args.Nodes {
		drafts = append(drafts, canvas.NodeDraft{Title: node.Title, Type: node.Type, Prompt: node.Prompt})
		titles = append(titles, strings.TrimSpace(node.Title))
	}
	if _, err := ctx.Services.CreateUserCanvasNodesWithTx(ctx.Tx, ctx.UserID, args.CanvasID, drafts, args.ExpectedRevision); err != nil {
		return nil, mapDomainError(err)
	}
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		created := make([]map[string]any, 0, len(titles))
		for _, title := range titles {
			if node := findDocNodeByTitle(doc, title); node != nil {
				created = append(created, map[string]any{"id": node["id"], "title": node["title"]})
			}
		}
		return map[string]any{"canvasId": args.CanvasID, "created": created}
	})
}
func nodeTypeOf(nodes []any, nodeID string) string {
	for _, rawNode := range nodes {
		if node, ok := rawNode.(map[string]any); ok {
			if id, _ := node["id"].(string); id == nodeID {
				kind, _ := node["type"].(string)
				kind = strings.TrimSpace(kind)
				if kind == "" {
					kind = "text"
				}
				return kind
			}
		}
	}
	return "text"
}

func opCanvasEdgeCreate(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID         string `json:"canvasId"`
		FromNodeID       string `json:"fromNodeId"`
		ToNodeID         string `json:"toNodeId"`
		ExpectedRevision int64  `json:"expectedRevision"`
	}
	if err := json.Unmarshal(params, &args); err != nil {
		return nil, InvalidArg("invalid_params", err.Error())
	}
	if strings.TrimSpace(args.CanvasID) == "" || strings.TrimSpace(args.FromNodeID) == "" || strings.TrimSpace(args.ToNodeID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId、fromNodeId、toNodeId 必填")
	}
	if args.FromNodeID == args.ToNodeID {
		return nil, InvalidArg("self_loop", "不能把节点连接到自身")
	}
	summary, err := ctx.Services.ConnectUserCanvasNodesWithTx(ctx.Tx, ctx.UserID, args.CanvasID, args.FromNodeID, args.ToNodeID, args.ExpectedRevision)
	if err != nil {
		return nil, mapDomainError(err)
	}
	// 领域层遇到已存在的连线会原样返回（revision 不变），真正新建才推进 revision。
	// 写后扫描连线永远能扫到这条边，因此必须按领域结果判定，而不是按写后状态判定。
	created := summary.Revision != args.ExpectedRevision
	return canvasWriteResult(ctx, args.CanvasID, func(doc map[string]any) map[string]any {
		// 连线 id 要回给调用方：按轮撤销与变更摘要需要知道这一轮新增了哪些连线。
		return map[string]any{"canvasId": args.CanvasID, "duplicate": !created, "revision": summary.Revision,
			"edgeId": findDocEdgeID(doc, args.FromNodeID, args.ToNodeID), "created": created}
	})
}

// canvasWriteResult 写后在同一事务连接上回读，并补齐 revision。
func canvasWriteResult(ctx *Context, canvasID string, build func(doc map[string]any) map[string]any) (any, error) {
	after, err := ctx.Services.UserCanvasProjectWithTx(ctx.Tx, ctx.UserID, canvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(after, &doc); err != nil {
		return nil, AsError(err)
	}
	payload := build(doc)
	payload["revision"] = canvasRevision(doc)
	return payload, nil
}

func findDocNode(doc map[string]any, nodeID string) map[string]any {
	if nodes, ok := doc["nodes"].([]any); ok {
		for _, rawNode := range nodes {
			if node, ok := rawNode.(map[string]any); ok {
				if id, _ := node["id"].(string); id == nodeID {
					return node
				}
			}
		}
	}
	return nil
}

func findDocEdgeID(doc map[string]any, fromNodeID, toNodeID string) string {
	connections, _ := doc["connections"].([]any)
	for _, rawEdge := range connections {
		edge, ok := rawEdge.(map[string]any)
		if !ok {
			continue
		}
		from, _ := edge["fromNodeId"].(string)
		to, _ := edge["toNodeId"].(string)
		if from == fromNodeID && to == toNodeID {
			id, _ := edge["id"].(string)
			return id
		}
	}
	return ""
}

func findDocNodeByTitle(doc map[string]any, title string) map[string]any {
	if nodes, ok := doc["nodes"].([]any); ok {
		for _, rawNode := range nodes {
			if node, ok := rawNode.(map[string]any); ok {
				if value, _ := node["title"].(string); value == title {
					return node
				}
			}
		}
	}
	return nil
}

// secretKeyPattern 命中凭据类字段名；读取结果统一脱敏后再外发。
var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|authorization|password|credential|private[_-]?key)`)

func sanitizeForClient(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if secretKeyPattern.MatchString(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = sanitizeForClient(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, sanitizeForClient(item))
		}
		return out
	case string:
		if strings.Contains(typed, "?") && secretKeyPattern.MatchString(typed) {
			if idx := strings.Index(typed, "?"); idx > 0 {
				return typed[:idx]
			}
		}
		return typed
	default:
		return value
	}
}

// mapDomainError 把领域错误映射为结构化操作错误，避免把内部细节透给客户端。
func mapDomainError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return NotFound("not_found", "资源不存在")
	}
	var appErr *kernel.AppError
	if errors.As(err, &appErr) {
		switch appErr.Status {
		case http.StatusNotFound:
			return NotFound("not_found", appErr.Message)
		case http.StatusConflict:
			return Conflict("stale_revision", appErr.Message, nil)
		case http.StatusPreconditionFailed:
			return PreconditionFailed("precondition_failed", appErr.Message, nil)
		case http.StatusBadRequest:
			// 领域层给出的稳定原因优先（例如 unsupported_field）：调用方要能区分
			// 「字段不被该节点类型支持」和普通参数错误，而不是只能解析文案。
			if appErr.Reason == kernel.ReasonUnsupportedField {
				return InvalidArg(string(kernel.ReasonUnsupportedField), appErr.Message)
			}
			return InvalidArg("invalid_request", appErr.Message)
		}
	}
	var conflicter interface{ IsConflict() bool }
	if errors.As(err, &conflicter) && conflicter.IsConflict() {
		return Conflict("stale_write", "写入冲突，已停止覆盖", nil)
	}
	return AsError(err)
}
