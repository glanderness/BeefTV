package operations

import (
	"context"
	"encoding/json"
	"strings"
)

const (
	businessListDefaultLimit = 50
	businessListMaxLimit     = 100
)

// BusinessCatalogItem describes one mounted workspace business HTTP route
// available to full-access built-in assistants through business.list/call.
type BusinessCatalogItem struct {
	ID                string         `json:"id"`
	Summary           string         `json:"summary"`
	Method            string         `json:"method"`
	Path              string         `json:"path"`
	ReadOnly          bool           `json:"readOnly"`
	SubmitsGeneration bool           `json:"submitsGeneration,omitempty"`
	Params            map[string]any `json:"params,omitempty"`
}

// BusinessUploadFile carries an optional base64 file payload for business
// upload routes (e.g. POST /resources, POST /skills/install, POST /plugins).
type BusinessUploadFile struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType,omitempty"`
	Data     string `json:"data"`
}

// BusinessCallRequest is the input for business.call.
type BusinessCallRequest struct {
	Tool        string              `json:"tool"`
	Path        map[string]string   `json:"path,omitempty"`
	Query       map[string]string   `json:"query,omitempty"`
	Body        json.RawMessage     `json:"body,omitempty"`
	File        *BusinessUploadFile `json:"file,omitempty"`
	OperationID string              `json:"-"`
}

// BusinessGateway bridges the operation registry to the mounted local business
// catalog in-process without loopback hops or bypassing paid generation approval.
type BusinessGateway interface {
	ListBusinessTools(query, method string, readOnlyOnly bool, offset, limit int) (items []BusinessCatalogItem, total int)
	CallBusinessTool(ctx context.Context, userID string, req BusinessCallRequest) (any, error)
}

func registerBusinessGatewayOps(r *Registry) {
	r.Register(Op{
		ID:             "business.list",
		Summary:        "列出当前工作区可调用的底层业务接口（仅完全访问模式，支持关键词/方法筛选与分页）",
		ReadOnly:       true,
		AssistantOnly:  true,
		FullAccessOnly: true,
		Scope:          ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"query":{"type":"string","description":"按接口名、路径或说明筛选"},` +
			`"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"],"description":"按 HTTP 方法筛选"},` +
			`"readOnly":{"type":"boolean","description":"只列只读接口"},` +
			`"offset":{"type":"integer","minimum":0},` +
			`"limit":{"type":"integer","minimum":1,"maximum":100}` +
			`}}`),
		Handler: opBusinessList,
	})
	r.Register(Op{
		ID:             "business.call",
		Summary:        "调用 business_list 列出的工作区底层业务接口（仅完全访问模式；提交计费生成须走 canvas_generation_propose）",
		ReadOnly:       false,
		AssistantOnly:  true,
		FullAccessOnly: true,
		NoTurnCanvas:   true,
		Scope:          ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{` +
			`"tool":{"type":"string","description":"business_list 返回的接口 ID"},` +
			`"path":{"type":"object","additionalProperties":{"type":"string"},"description":"路径参数"},` +
			`"query":{"type":"object","additionalProperties":{"type":"string"},"description":"查询参数"},` +
			`"body":{"type":"object","additionalProperties":true,"description":"JSON 请求体"},` +
			`"file":{"type":"object","properties":{"name":{"type":"string"},"mimeType":{"type":"string"},"data":{"type":"string","description":"Base64 文件字节"}},"required":["name","data"],"additionalProperties":false}` +
			`},"required":["tool"]}`),
		Handler: opBusinessCall,
	})
}

func opBusinessList(ctx *Context, raw json.RawMessage) (any, error) {
	if ctx.BusinessGateway == nil {
		return nil, Unsupported("business_gateway_unavailable", "当前运行环境不支持底层工作区接口发现")
	}
	var args struct {
		Query    string `json:"query"`
		Method   string `json:"method"`
		ReadOnly bool   `json:"readOnly"`
		Offset   int    `json:"offset"`
		Limit    int    `json:"limit"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if args.Offset < 0 || args.Limit < 0 || len(args.Query) > 200 {
		return nil, InvalidArg("invalid_params", "底层接口查询参数无效")
	}
	limit := args.Limit
	if limit == 0 {
		limit = businessListDefaultLimit
	}
	if limit > businessListMaxLimit {
		limit = businessListMaxLimit
	}
	items, total := ctx.BusinessGateway.ListBusinessTools(strings.TrimSpace(args.Query), strings.ToUpper(strings.TrimSpace(args.Method)), args.ReadOnly, args.Offset, limit)
	if items == nil {
		items = []BusinessCatalogItem{}
	}
	return map[string]any{
		"tools":  items,
		"total":  total,
		"offset": args.Offset,
		"limit":  limit,
	}, nil
}

func opBusinessCall(ctx *Context, raw json.RawMessage) (any, error) {
	if ctx.BusinessGateway == nil {
		return nil, Unsupported("business_gateway_unavailable", "当前运行环境不支持底层工作区接口调用")
	}
	var req BusinessCallRequest
	if err := decodeParams(raw, &req); err != nil {
		return nil, err
	}
	req.Tool = strings.TrimSpace(req.Tool)
	if req.Tool == "" {
		return nil, InvalidArg("invalid_params", "tool 必填")
	}
	req.OperationID = strings.TrimSpace(ctx.OperationID)
	return ctx.BusinessGateway.CallBusinessTool(ctx.Context, ctx.UserID, req)
}
