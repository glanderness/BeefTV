package agentops

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"gorm.io/gorm"
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
	Services Services
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

// Caller 是一次调用的能力身份：只读模式，以及内置助手的受限范围。
// 外部已登记客户端与 owner 直连只受 ReadOnly 约束，保持工作区读能力不变。
type Caller struct {
	ReadOnly  bool
	Assistant *AssistantScope
}

// Request 是一次操作调用的入参。
type Request struct {
	Context  context.Context
	OpID     string
	Op       string
	UserID   string
	ReadOnly bool
	Params   json.RawMessage
	// TurnID 是写入发生时所属的助手回合；只有内置助手宿主会提供，其他入口留空。
	TurnID    string
	Assistant *AssistantScope
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
	services Services
	store    *Store
	ops      map[string]*Op
}

func NewRegistry(services Services, store *Store) *Registry {
	return &Registry{services: services, store: store, ops: map[string]*Op{}}
}

func (r *Registry) Register(op Op) {
	if r.ops == nil {
		r.ops = map[string]*Op{}
	}
	copied := op
	r.ops[op.ID] = &copied
}

// List 返回能力发现结果。
// readOnly 为真时只返回只读操作；带内置助手范围时进一步收窄到该范围真实允许的操作：
// 这两层都是真实过滤，不是提示词约束。
func (r *Registry) List(caller Caller) []Descriptor {
	out := make([]Descriptor, 0, len(r.ops))
	for _, op := range r.ops {
		if caller.ReadOnly && !op.ReadOnly {
			continue
		}
		if caller.Assistant != nil && !assistantVisible(op) {
			continue
		}
		descriptor := op.Descriptor()
		if caller.Assistant != nil {
			// 内置宿主的幂等键由宿主按「会话身份 + 工具调用 id」生成，模型不该看到也不必
			// 填写 operationId；外部 MCP/CLI 的 schema 仍然保留它作为稳定幂等键。
			descriptor.Params = op.Params
		}
		out = append(out, descriptor)
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

// Execute 执行一个操作：校验能力边界与助手范围、做持久化幂等，并把业务写入放进事务。
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
	params := req.Params
	if len(params) == 0 {
		params = json.RawMessage("{}")
	}
	// 幂等身份只有一个来源：schema 里声明的 params.operationId 在共享入口统一取出并剥离，
	// 参数里不再保留第二份身份，严格字段校验因此不会把它当成未知字段。
	// envelope 的 opId 与 params.operationId 同时给出又不同，是调用方自相矛盾，明确拒绝，
	// 不能两种 ID 悄悄任选一个。
	opID := strings.TrimSpace(req.OpID)
	if !op.ReadOnly {
		schemaParams, schemaOpID, err := splitOperationID(params)
		if err != nil {
			return Result{}, err
		}
		params = schemaParams
		if schemaOpID != "" {
			if opID != "" && opID != schemaOpID {
				return Result{}, InvalidArg("operation_id_conflict",
					"opId 与 params.operationId 不一致；一次调用只能提供一个幂等身份")
			}
			opID = schemaOpID
		}
	}
	// 写操作必须有幂等键：没有 opId 的重试无法判定是重复提交还是新请求。
	if !op.ReadOnly && opID == "" {
		return Result{}, InvalidArg("missing_op_id", "写操作必须提供 opId 作为幂等键")
	}
	// 只读操作不接受幂等键：否则会在单连接池上为读操作开启事务并自等死锁，
	// 而且读操作本来就不需要回放语义。
	if op.ReadOnly && strings.TrimSpace(req.OpID) != "" {
		return Result{}, InvalidArg("unexpected_op_id", "只读操作不支持 opId")
	}
	// 助手范围在共享入口裁决：内置助手宿主只能碰当前画布与显式授予的引用，
	// 模型自报的参数无法越过这里。
	if req.Assistant != nil {
		if err := req.Assistant.Allows(op, params); err != nil {
			return Result{}, err
		}
	}
	if op.ReadOnly {
		opID = ""
	}
	runCtx := req.Context
	if runCtx == nil {
		runCtx = context.Background()
	}
	hash := PayloadHash(op.ID, params)
	outcome, err := r.store.Run(runCtx, RunRequest{UserID: req.UserID, OpID: opID, Op: op.ID,
		PayloadHash: hash, TurnID: req.TurnID}, func(tx *gorm.DB) ([]byte, error) {
		execCtx := &Context{Context: runCtx, UserID: req.UserID, ReadOnly: req.ReadOnly, Tx: tx, Services: r.services}
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

// splitOperationID 从参数里取出（并移除）schema 声明的 operationId。
// 参数不是对象或没有该字段时原样返回；operationId 不是字符串时明确失败，
// 不把类型错误当成「没提供身份」。
func splitOperationID(params json.RawMessage) (json.RawMessage, string, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(params, &object); err != nil {
		return params, "", nil
	}
	raw, found := object["operationId"]
	if !found {
		return params, "", nil
	}
	delete(object, "operationId")
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return params, "", InvalidArg("invalid_params", "operationId 必须是字符串")
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return params, strings.TrimSpace(value), nil
	}
	return encoded, strings.TrimSpace(value), nil
}
