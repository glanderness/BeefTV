package operations

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/modelcatalog"
)

// ModelCostPricingReader 是费用估算的窄端口：返回模型档案里保存的目录单价。
// 组合根没有实现它时只报「暂无价格」，不阻断提议、确认和生成。
type ModelCostPricingReader interface {
	ModelCostPricing(modelKey string) (map[string]any, bool)
}

func registerCanvasCostEstimate(r *Registry) {
	r.Register(Op{AssistantCanvas: true, ID: "canvas.cost.estimate", Summary: "按画布当前参数估算生成费用（图片、视频、配音的目录单价单项与合计，含参考图和参考视频；只读、不联网、不建任务；算不出的项标为暂无价格，超分按先扣金额另行结算、不计入合计）", ReadOnly: true, Scope: ScopeCanvas,
		Params:  json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeIds":{"type":"array","items":{"type":"string"},"maxItems":24,"description":"只估算这些节点；省略则估算画布上全部已配好模型、还没有成品的生成节点"},"batch":{"type":"object","description":"还没建节点的一次性批量（例如分镜批量生成）：按同一模型估算 items 项，items 省略时按 count 项默认参数估算","properties":{"kind":{"type":"string","enum":["image","video","audio"]},"model":{"type":"string"},"count":{"type":"integer","minimum":1,"maximum":200},"items":{"type":"array","maxItems":200,"items":{"type":"object","properties":{"parameters":{"type":"object","additionalProperties":{"type":"string"}},"text":{"type":"string"},"referenceNodeIds":{"type":"array","items":{"type":"string"},"maxItems":24,"description":"这一项用到的参考节点；参考图和参考视频按目录单价一并计入"}}}}},"required":["kind","model"]}},"required":["canvasId"]}`),
		Handler: opCanvasCostEstimate})
}

func opCanvasCostEstimate(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID string          `json:"canvasId"`
		NodeIDs  []string        `json:"nodeIds"`
		Batch    *costBatchProbe `json:"batch"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.CanvasID) == "" {
		return nil, InvalidArg("invalid_params", "canvasId 必填")
	}
	if args.Batch != nil && args.Batch.Kind != "image" && args.Batch.Kind != "video" && args.Batch.Kind != "audio" {
		return nil, InvalidArg("invalid_kind", "batch.kind 只能是 image、video 或 audio")
	}
	docRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(docRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	summary := costSummary(ctx, doc, args.NodeIDs, args.Batch)
	result := map[string]any{"canvasId": args.CanvasID, "revision": doc["revision"]}
	if summary == nil {
		result["estimate"] = nil
		result["unavailable"] = "当前工作区没有可用的目录单价"
		return result, nil
	}
	result["estimate"] = summary
	return result, nil
}

type costBatchItem struct {
	Parameters       map[string]string `json:"parameters"`
	Text             string            `json:"text"`
	ReferenceNodeIDs []string          `json:"referenceNodeIds"`
}

type costBatchProbe struct {
	Kind  string          `json:"kind"`
	Model string          `json:"model"`
	Count int             `json:"count"`
	Items []costBatchItem `json:"items"`
}

// costSummary 返回一次费用估算；没有目录单价端口时返回 nil。
func costSummary(ctx *Context, doc map[string]any, nodeIDs []string, batch *costBatchProbe) *modelcatalog.CostSummary {
	graph := costDependencyGraph(doc)
	if batch != nil {
		return costBatchSummary(ctx, graph, *batch)
	}
	return costTargetSummary(ctx, graph, costTargets(ctx.Domain, graph, nodeIDs, len(nodeIDs) == 0, nil))
}

// costTargetSummary 给一组生成目标算目录单价合计，单项顺序与目标一致。
func costTargetSummary(ctx *Context, canvas costCanvasGraph, targets []GenerationTarget) *modelcatalog.CostSummary {
	reader, ok := ctx.Domain.(ModelCostPricingReader)
	if !ok {
		return nil
	}
	items := make([]modelcatalog.CostLine, 0, len(targets))
	for _, target := range targets {
		references := costReferences(canvas.graph, target.ReferenceNodeIDs)
		items = append(items, costLine(reader, target.Kind, target.ModelKey, target.Parameters, references, target.Prompt, target.NodeID, target.Title))
	}
	summary := modelcatalog.SumCostLines(items)
	return &summary
}

func costBatchSummary(ctx *Context, canvas costCanvasGraph, probe costBatchProbe) *modelcatalog.CostSummary {
	reader, ok := ctx.Domain.(ModelCostPricingReader)
	if !ok {
		return nil
	}
	items := make([]modelcatalog.CostLine, 0, len(probe.Items))
	if len(probe.Items) > 0 {
		for _, item := range probe.Items {
			items = append(items, costLine(reader, probe.Kind, probe.Model, item.Parameters, costReferences(canvas.graph, item.ReferenceNodeIDs), item.Text, "", ""))
		}
	} else {
		count := probe.Count
		if count < 1 {
			count = 1
		}
		parameters := map[string]string{"count": strconv.Itoa(count)}
		items = append(items, costLine(reader, probe.Kind, probe.Model, parameters, costReferenceSummary{}, "", "", ""))
	}
	summary := modelcatalog.SumCostLines(items)
	return &summary
}

func costLine(reader ModelCostPricingReader, kind, modelKey string, parameters map[string]string, references costReferenceSummary, text, nodeID, title string) modelcatalog.CostLine {
	pricing, _ := reader.ModelCostPricing(modelKey)
	_, modelID := modelcatalog.SplitModelKey(modelKey)
	line := modelcatalog.EstimateCost(modelcatalog.CostRequest{
		Kind: kind, Model: modelID, Pricing: pricing, Parameters: parameters, Text: text,
		ReferenceCount: references.images, ReferenceVideoCount: references.videos, ReferenceVideoSeconds: references.videoSeconds,
	})
	line.NodeID, line.Title = nodeID, title
	return line
}

// costReferenceSummary 是参考节点按计费方式的分类：参考图按张、参考视频按秒，
// 参考音频不参与图片和视频单价计算。
type costReferenceSummary struct {
	images       int
	videos       int
	videoSeconds float64
}

// costReferences 数出要计费的参考图和参考视频。参考视频的秒数读不到时只记数量，
// 让估算器说明「算不出来」，不能当成 0 秒。
func costReferences(graph generationDependencyGraph, ids []string) costReferenceSummary {
	summary := costReferenceSummary{}
	for _, id := range ids {
		switch graph.label(id) {
		case "视频":
			summary.videos++
			if seconds, ok := referenceVideoSeconds(dependencyMetadata(graph.nodes[id])); ok {
				summary.videoSeconds += seconds
			}
		case "音频":
		default:
			summary.images++
		}
	}
	return summary
}

// referenceVideoSeconds 取参考视频的媒体时长：先看节点自己记的实际时长，其次看生成时
// 请求的秒数；都没有就返回 false。
func referenceVideoSeconds(meta map[string]any) (float64, bool) {
	if milliseconds, ok := costNumber(meta["durationMs"]); ok && milliseconds > 0 {
		return milliseconds / 1000, true
	}
	if seconds, ok := costNumber(meta["seconds"]); ok && seconds > 0 {
		return seconds, true
	}
	return 0, false
}

func costNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed)
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// costDependencyGraph 把画布节点和连线读成依赖图，供参考节点分类和时长统计使用。
// nodes 保持文档顺序：费用明细的排列与画布上的顺序一致。
func costDependencyGraph(doc map[string]any) costCanvasGraph {
	nodes := map[string]map[string]any{}
	ordered := make([]map[string]any, 0, len(canvasNodes(doc)))
	for _, v := range canvasNodes(doc) {
		n, _ := v.(map[string]any)
		ordered = append(ordered, n)
		nodes[dependencyString(n, "id")] = n
	}
	graph := generationDependencyGraph{nodes: nodes, incoming: map[string][]string{}, config: map[string]string{}}
	if edges, ok := doc["connections"].([]any); ok {
		for _, v := range edges {
			e, _ := v.(map[string]any)
			to, from := dependencyString(e, "toNodeId"), dependencyString(e, "fromNodeId")
			graph.incoming[to] = append(graph.incoming[to], from)
		}
	}
	return costCanvasGraph{graph: graph, nodes: ordered}
}

type costCanvasGraph struct {
	graph generationDependencyGraph
	nodes []map[string]any
}

// costResolution 是调用方已经解析好的模型：生成提议按整批解析过一次，估算时直接
// 复用，不再逐节点读取模型配置。
type costResolution struct {
	Kind  string
	Model AssistantGenerationModel
}

// costTargets 列出要估算费用的生成目标：已选模型、还没有成品的图片/视频/音频节点。
// onlyUnfinished 只在扫描整张画布时为真；显式点名节点时按调用方的选择估算。
func costTargets(domain Domain, canvas costCanvasGraph, ids []string, onlyUnfinished bool, forced *costResolution) []GenerationTarget {
	graph := canvas.graph
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	// 同一 (类型, 节点所选模型) 只解析一次，避免按节点重复读取模型配置。
	resolved := map[string]AssistantGenerationModel{}
	targets := []GenerationTarget{}
	seen := map[string]bool{}
	for _, n := range canvas.nodes {
		id := dependencyString(n, "id")
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if len(wanted) > 0 && !wanted[id] {
			continue
		}
		kind := nodeGenerationKind(n)
		var choice AssistantGenerationModel
		if forced != nil {
			kind = forced.Kind
			choice = forced.Model
		} else {
			if kind != "image" && kind != "video" && kind != "audio" {
				continue
			}
			selected := nodeSelectedModel(n)
			cacheKey := kind + "\x00" + selected
			cached, ok := resolved[cacheKey]
			if !ok {
				var err error
				cached, err = domain.ResolveAssistantGenerationModel(kind, selected)
				if err != nil {
					continue
				}
				resolved[cacheKey] = cached
			}
			choice = cached
		}
		meta := dependencyMetadata(n)
		if onlyUnfinished && nodeHasGenerationOutput(meta) {
			continue
		}
		if choice.ModelKey == "" || choice.KindMismatch {
			continue
		}
		prompt := dependencyString(meta, "composerContent")
		if prompt == "" {
			prompt = dependencyString(meta, "prompt")
		}
		refs := graph.references(id, kind)
		sort.Strings(refs)
		targets = append(targets, GenerationTarget{
			NodeID: id, Title: dependencyString(n, "title"), Kind: kind, ModelKey: choice.ModelKey,
			Prompt: prompt, Parameters: generationTargetParameters(meta), ReferenceNodeIDs: uniqueTargetIDs(refs),
		})
	}
	return targets
}

// nodeHasGenerationOutput 判断节点是否已经有成品；有成品就不再估算，避免把已完成
// 的素材重复算进预算。
func nodeHasGenerationOutput(meta map[string]any) bool {
	if strings.TrimSpace(dependencyString(meta, "content")) != "" {
		return true
	}
	return strings.TrimSpace(dependencyString(meta, "storageKey")) != ""
}
