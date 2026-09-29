package agentops

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/app"
)

// Scope 声明操作触及的数据范围：读范围不等于写范围，默认不放大到全工作区批量写。
type Scope string

const (
	ScopeCanvas        Scope = "canvas"
	ScopeWorkspaceRead Scope = "workspace_read"
)

// Context 是一次操作执行时可用的上下文。
type Context struct {
	Context  context.Context
	UserID   string
	ReadOnly bool
	Tx       *gorm.DB
	Services *app.Service
}

// Handler 实现一个操作；返回值必须是可 JSON 序列化的业务结果。
type Handler func(ctx *Context, params json.RawMessage) (any, error)

// Op 是操作的唯一定义，CLI、MCP 与内置 pi 都由它派生，不各自实现一套规则。
type Op struct {
	ID       string
	Summary  string
	ReadOnly bool
	Scope    Scope
	// Params 是 JSON Schema；暴露给 MCP/CLI 的参数校验来自它。
	Params  json.RawMessage
	Handler Handler
}

// Descriptor 是给客户端做能力发现用的稳定描述。
type Descriptor struct {
	ID       string          `json:"id"`
	Summary  string          `json:"summary"`
	ReadOnly bool            `json:"readOnly"`
	Scope    Scope           `json:"scope"`
	Params   json.RawMessage `json:"params"`
}

// Request 是一次操作调用的入参。
type Request struct {
	Context  context.Context
	OpID     string
	Op       string
	UserID   string
	ReadOnly bool
	Params   json.RawMessage
}

// Result 是操作结果；Replayed 表示命中了操作 ID 去重、回读了原结果。
type Result struct {
	Op       string `json:"op"`
	OpID     string `json:"opId,omitempty"`
	Replayed bool   `json:"replayed"`
	Result   any    `json:"result"`
}

// Registry 持有全部操作定义；写操作必须在事务里执行，保证与操作记录同提交。
type Registry struct {
	services *app.Service
	store    *Store
	ops      map[string]*Op
}

func NewRegistry(services *app.Service, store *Store) *Registry {
	return &Registry{services: services, store: store, ops: map[string]*Op{}}
}

func (r *Registry) Register(op Op) {
	if r.ops == nil {
		r.ops = map[string]*Op{}
	}
	copied := op
	r.ops[op.ID] = &copied
}

// List 返回能力发现结果；readOnly 为真时只返回只读操作（真实过滤，不是提示词约束）。
func (r *Registry) List(readOnly bool) []Descriptor {
	out := make([]Descriptor, 0, len(r.ops))
	for _, op := range r.ops {
		if readOnly && !op.ReadOnly {
			continue
		}
		out = append(out, op.Descriptor())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (r *Registry) Descriptor(id string) (Descriptor, bool) {
	op, ok := r.ops[id]
	if !ok {
		return Descriptor{}, false
	}
	return op.Descriptor(), true
}

func (op *Op) Descriptor() Descriptor {
	return Descriptor{ID: op.ID, Summary: op.Summary, ReadOnly: op.ReadOnly, Scope: op.Scope, Params: op.writeAwareParams()}
}

// writeAwareParams 给写操作显式加上稳定幂等键 operationId：
// 调用方必须在重试时复用同一个值，服务端才能回读原结果而不是重复执行。
func (op *Op) writeAwareParams() json.RawMessage {
	if op.ReadOnly || len(op.Params) == 0 {
		return op.Params
	}
	var schema map[string]any
	if err := json.Unmarshal(op.Params, &schema); err != nil {
		return op.Params
	}
	properties, _ := schema["properties"].(map[string]any)
	if properties == nil {
		properties = map[string]any{}
	}
	properties["operationId"] = map[string]any{
		"type":        "string",
		"description": "调用方生成的稳定幂等键；重试同一操作必须复用同一个值，服务端据此回读原结果",
	}
	schema["properties"] = properties
	required, _ := schema["required"].([]any)
	present := false
	for _, item := range required {
		if name, ok := item.(string); ok && name == "operationId" {
			present = true
		}
	}
	if !present {
		required = append(required, "operationId")
	}
	schema["required"] = required
	encoded, err := json.Marshal(schema)
	if err != nil {
		return op.Params
	}
	return encoded
}

// Execute 执行一个操作：校验能力边界、做持久化幂等，并把业务写入放进事务。
func (r *Registry) Execute(req Request) (Result, error) {
	op, ok := r.ops[strings.TrimSpace(req.Op)]
	if !ok {
		return Result{}, NotFound("unknown_operation", "未知操作: "+req.Op)
	}
	if req.ReadOnly && !op.ReadOnly {
		return Result{}, newError(CodeReadOnly, "read_only_client", "该客户端为只读模式，不能执行写操作: "+op.ID, nil)
	}
	if strings.TrimSpace(req.UserID) == "" {
		return Result{}, InvalidArg("missing_scope", "缺少用户/工作区作用域")
	}
	// 写操作必须有幂等键：没有 opId 的重试无法判定是重复提交还是新请求。
	if !op.ReadOnly && strings.TrimSpace(req.OpID) == "" {
		return Result{}, InvalidArg("missing_op_id", "写操作必须提供 opId 作为幂等键")
	}
	// 只读操作不接受幂等键：否则会在单连接池上为读操作开启事务并自等死锁，
	// 而且读操作本来就不需要回放语义。
	if op.ReadOnly && strings.TrimSpace(req.OpID) != "" {
		return Result{}, InvalidArg("unexpected_op_id", "只读操作不支持 opId")
	}
	opID := req.OpID
	if op.ReadOnly {
		opID = ""
	}
	params := req.Params
	if len(params) == 0 {
		params = json.RawMessage("{}")
	}
	runCtx := req.Context
	if runCtx == nil {
		runCtx = context.Background()
	}
	hash := PayloadHash(op.ID, params)
	baseCtx := req.UserID
	outcome, err := r.store.Run(req.UserID, opID, op.ID, hash, func(tx *gorm.DB) ([]byte, error) {
		execCtx := &Context{Context: runCtx, UserID: baseCtx, ReadOnly: req.ReadOnly, Tx: tx, Services: r.services}
		value, runErr := op.Handler(execCtx, params)
		if runErr != nil {
			return nil, AsError(runErr)
		}
		encoded, encErr := json.Marshal(value)
		if encErr != nil {
			return nil, AsError(encErr)
		}
		return encoded, nil
	})
	if err != nil {
		return Result{}, err
	}
	var decoded any
	if len(outcome.Result) > 0 {
		if err := json.Unmarshal(outcome.Result, &decoded); err != nil {
			return Result{}, AsError(err)
		}
	}
	return Result{Op: op.ID, OpID: opID, Replayed: outcome.Replayed, Result: decoded}, nil
}
