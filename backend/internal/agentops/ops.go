package agentops

import (
	"crypto/rand"
	"net/http"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/kernel"
)

// allowedNodeTypes 与画布领域支持的节点类型保持一致；整批校验后再写入。
var allowedNodeTypes = map[string]bool{
	"text": true, "image": true, "video": true, "audio": true, "script": true, "batch-table": true,
}

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
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"}},"required":["canvasId"]}`),
		Handler: opCanvasGet})
	r.Register(Op{ID: "canvas.search", Summary: "按关键字分页搜索工作区内的画布", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer"},"pageSize":{"type":"integer"},"query":{"type":"string"},"canvasId":{"type":"string"},"sort":{"type":"string"}}}`),
		Handler: opCanvasSearch})
	r.Register(Op{ID: "asset.list", Summary: "分页列出用户素材库中的素材", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"page":{"type":"integer"},"pageSize":{"type":"integer"},"query":{"type":"string"},"kind":{"type":"string"},"category":{"type":"string"}}}`),
		Handler: opAssetList})
	r.Register(Op{ID: "asset.get", Summary: "按 ID 读取单个素材", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"assetId":{"type":"string"}},"required":["assetId"]}`),
		Handler: opAssetGet})
	r.Register(Op{ID: "task.get", Summary: "按 ID 查询任务状态与产物引用", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}`),
		Handler: opTaskGet})
	r.Register(Op{ID: "canvas.node.update", Summary: "局部修改一个节点（只提交目标字段，其余数据保持原样，带 revision CAS）", Scope: ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeId":{"type":"string"},"expectedRevision":{"type":"integer"},"patch":{"type":"object","properties":{"title":{"type":"string"},"prompt":{"type":"string"},"content":{"type":"string"}}}},"required":["canvasId","nodeId","patch","expectedRevision"]}`),
		Handler: opCanvasNodeUpdate})
	r.Register(Op{ID: "canvas.nodes.create", Summary: "在画布上批量创建节点（整批校验，带 revision CAS）", Scope: ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"expectedRevision":{"type":"integer"},"nodes":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"type":{"type":"string"},"prompt":{"type":"string"}},"required":["title","type"]}}},"required":["canvasId","nodes","expectedRevision"]}`),
		Handler: opCanvasNodesCreate})
	r.Register(Op{ID: "canvas.edge.create", Summary: "连接两个节点（重复连接幂等返回）", Scope: ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"fromNodeId":{"type":"string"},"toNodeId":{"type":"string"},"expectedRevision":{"type":"integer"}},"required":["canvasId","fromNodeId","toNodeId","expectedRevision"]}`),
		Handler: opCanvasEdgeCreate})
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
	_ = json.Unmarshal(params, &args)
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
	_ = json.Unmarshal(params, &args)
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

// checkRevision 校验调用方观察到的版本；不一致就停写，绝不用旧观察覆盖用户新编辑。
func checkRevision(doc map[string]any, expected int64) error {
	if expected <= 0 {
		return nil
	}
	current := canvasRevision(doc)
	if current != expected {
		return PreconditionFailed("stale_revision",
			"画布在读取之后已被修改，已停止写入",
			map[string]any{"observedRevision": expected, "currentRevision": current})
	}
	return nil
}

func writeCanvasDoc(ctx *Context, canvasID string, doc map[string]any) (int64, error) {
	doc["id"] = canvasID
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
	if args.Patch.Title == nil && args.Patch.Prompt == nil && args.Patch.Content == nil {
		return nil, InvalidArg("empty_patch", "patch 至少要有一个字段")
	}
	if err := requireRevision(args.ExpectedRevision); err != nil {
		return nil, err
	}
	doc, err := readCanvasDoc(ctx, args.CanvasID)
	if err != nil {
		return nil, err
	}
	if err := checkRevision(doc, args.ExpectedRevision); err != nil {
		return nil, err
	}
	nodes := canvasNodes(doc)
	targetIdx := -1
	for i, rawNode := range nodes {
		node, ok := rawNode.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := node["id"].(string); id == args.NodeID {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		return nil, NotFound("node_not_found", "目标节点不存在: "+args.NodeID)
	}
	target, _ := nodes[targetIdx].(map[string]any)
	// 只覆盖 patch 明确给出的字段；metadata 里其他键保持原值。
	if args.Patch.Title != nil {
		target["title"] = *args.Patch.Title
	}
	if args.Patch.Prompt != nil || args.Patch.Content != nil {
		metadata, _ := target["metadata"].(map[string]any)
		if metadata == nil {
			metadata = map[string]any{}
		}
		if args.Patch.Prompt != nil {
			metadata["prompt"] = *args.Patch.Prompt
		}
		if args.Patch.Content != nil {
			metadata["content"] = *args.Patch.Content
		}
		target["metadata"] = metadata
	}
	doc["nodes"] = nodes
	revision, err := writeCanvasDoc(ctx, args.CanvasID, doc)
	if err != nil {
		return nil, err
	}
	return map[string]any{"canvasId": args.CanvasID, "nodeId": args.NodeID, "revision": revision, "node": target}, nil
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
	if err := requireRevision(args.ExpectedRevision); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, node := range args.Nodes {
		title := strings.TrimSpace(node.Title)
		if title == "" {
			return nil, InvalidArg("missing_title", "每个节点都需要标题")
		}
		if !allowedNodeTypes[strings.TrimSpace(node.Type)] {
			return nil, InvalidArg("unsupported_node_type", "不支持的节点类型: "+node.Type)
		}
		if seen[title] {
			return nil, InvalidArg("duplicate_title_in_batch", "同一批次内标题重复: "+title)
		}
		seen[title] = true
	}
	doc, err := readCanvasDoc(ctx, args.CanvasID)
	if err != nil {
		return nil, err
	}
	if err := checkRevision(doc, args.ExpectedRevision); err != nil {
		return nil, err
	}
	nodes := canvasNodes(doc)
	existing := map[string]bool{}
	for _, rawNode := range nodes {
		if node, ok := rawNode.(map[string]any); ok {
			if title, _ := node["title"].(string); title != "" {
				existing[title] = true
			}
		}
	}
	for title := range seen {
		if existing[title] {
			return nil, Conflict("title_already_exists", "标题已存在: "+title,
				map[string]any{"title": title})
		}
	}
	created := make([]map[string]any, 0, len(args.Nodes))
	for _, node := range args.Nodes {
		id := newNodeID()
		nodes = append(nodes, map[string]any{
			"id": id, "type": node.Type, "title": node.Title,
			"position": map[string]any{"x": 120 + len(nodes)*320, "y": 160},
			"width":    320, "height": 220,
			"metadata": map[string]any{"content": "", "prompt": node.Prompt, "status": "idle"},
		})
		created = append(created, map[string]any{"id": id, "title": node.Title})
	}
	doc["nodes"] = nodes
	revision, err := writeCanvasDoc(ctx, args.CanvasID, doc)
	if err != nil {
		return nil, err
	}
	return map[string]any{"canvasId": args.CanvasID, "created": created, "revision": revision}, nil
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
	if err := requireRevision(args.ExpectedRevision); err != nil {
		return nil, err
	}
	doc, err := readCanvasDoc(ctx, args.CanvasID)
	if err != nil {
		return nil, err
	}
	if err := checkRevision(doc, args.ExpectedRevision); err != nil {
		return nil, err
	}
	nodes := canvasNodes(doc)
	exists := map[string]bool{}
	for _, rawNode := range nodes {
		if node, ok := rawNode.(map[string]any); ok {
			if id, _ := node["id"].(string); id != "" {
				exists[id] = true
			}
		}
	}
	if !exists[args.FromNodeID] {
		return nil, NotFound("from_node_not_found", "起点节点不存在: "+args.FromNodeID)
	}
	if !exists[args.ToNodeID] {
		return nil, NotFound("to_node_not_found", "终点节点不存在: "+args.ToNodeID)
	}
	connections, _ := doc["connections"].([]any)
	for _, rawEdge := range connections {
		edge, ok := rawEdge.(map[string]any)
		if !ok {
			continue
		}
		from, _ := edge["fromNodeId"].(string)
		to, _ := edge["toNodeId"].(string)
		if from == args.FromNodeID && to == args.ToNodeID {
			return map[string]any{"canvasId": args.CanvasID, "duplicate": true, "revision": canvasRevision(doc)}, nil
		}
	}
	connections = append(connections, map[string]any{
		"id": "edge-" + strconv.FormatInt(time.Now().UnixNano(), 36), "fromNodeId": args.FromNodeID, "toNodeId": args.ToNodeID,
	})
	doc["connections"] = connections
	revision, err := writeCanvasDoc(ctx, args.CanvasID, doc)
	if err != nil {
		return nil, err
	}
	return map[string]any{"canvasId": args.CanvasID, "duplicate": false, "revision": revision}, nil
}

var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|authorization|password|credential|private[_-]?key)`)

// sanitizeForClient 去掉读取结果里的凭据类字段，读范围不等于可以带走密钥。
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
			return Conflict("stale_write", appErr.Message, nil)
		case http.StatusPreconditionFailed:
			return PreconditionFailed("precondition_failed", appErr.Message, nil)
		case http.StatusBadRequest:
			return InvalidArg("invalid_request", appErr.Message)
		}
	}
	var conflicter interface{ IsConflict() bool }
	if errors.As(err, &conflicter) && conflicter.IsConflict() {
		return Conflict("stale_write", "写入冲突，已停止覆盖", nil)
	}
	return AsError(err)
}
