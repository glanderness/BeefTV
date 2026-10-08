package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/modelcatalog"
)

type ModelCatalogReader interface {
	AgentModelCatalog() (*modelcatalog.CatalogResponse, error)
}

func registerModelCatalogOp(r *Registry) {
	r.Register(Op{ID: "model.catalog", Summary: "查询公开模型目录、类型和参考能力；实际可用性仍由节点配置校验；不含密钥", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct{}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			reader, ok := ctx.Domain.(ModelCatalogReader)
			if !ok {
				return nil, Unsupported("model_catalog_unavailable", "当前工作区无法读取模型目录")
			}
			catalog, err := reader.AgentModelCatalog()
			return catalog, mapDomainError(err)
		}})
}
