package operations

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/providerpreset"
)

// GenerationTarget freezes the paid inputs confirmed by the user. Delivered
// resource IDs may change as dependencies finish; their source node IDs may not.
type GenerationTarget struct {
	NodeID           string            `json:"nodeId"`
	Title            string            `json:"title"`
	Kind             string            `json:"kind"`
	ModelKey         string            `json:"modelKey"`
	Prompt           string            `json:"prompt"`
	Parameters       map[string]string `json:"parameters"`
	Metadata         map[string]any    `json:"metadata,omitempty"`
	ReferenceNodeIDs []string          `json:"referenceNodeIds"`
}

type GenerationAuthorization struct {
	SourceTurnID string             `json:"sourceTurnId"`
	ProposalID   string             `json:"proposalId"`
	Targets      []GenerationTarget `json:"targets"`
}

type AuthorizedGenerationAdmission interface {
	SubmitAuthorizedGeneration(userID, turnID, canvasID string, targets []GenerationTarget) (any, error)
}

type ProposedGenerationRecorder interface {
	RecordAssistantGenerationProposal(userID, turnID, canvasID string, proposal GenerationAuthorization) error
}

// External clients own execution approval; they still use the same task admission.
type ExternalGenerationAdmission interface {
	SubmitExternalGeneration(userID, operationID, canvasID string, targets []GenerationTarget) (any, error)
}

func registerGenerationSubmit(r *Registry) {
	r.Register(Op{ReplaySafe: true, AssistantCanvas: true, ID: "canvas.generation.submit", Summary: "提交画布素材生成，按所选渠道计费。外部 MCP/CLI 由调用方审批，必填画布与模型配置版本，不需要内置助手确认卡；内置助手仍须已确认的制作授权。返回原任务 ID，重试须复用 operationId", Scope: ScopeCanvas,
		Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"nodeIds":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8,"description":"同批必须相互独立且参考已就绪；外部提交只接受尚未关联任务的节点，已有任务用 task.get 查询或原任务恢复入口处理"},"kind":{"type":"string","enum":["image","video","audio"],"description":"可省略以按各节点实际类型提交混合批次"},"expectedRevision":{"type":"integer","minimum":1,"description":"外部调用必填，来自 canvas.get 或生成提议的 source.canvasRevision"},"expectedModelConfigRevision":{"type":"integer","minimum":0,"description":"外部调用必填，来自生成提议的 source.modelConfigRevision"}},"required":["canvasId","nodeIds"]}`), Handler: opGenerationSubmit})
}

func opGenerationSubmit(ctx *Context, raw json.RawMessage) (any, error) {
	var args struct {
		CanvasID                    string   `json:"canvasId"`
		NodeIDs                     []string `json:"nodeIds"`
		Kind                        string   `json:"kind"`
		ExpectedRevision            *int64   `json:"expectedRevision"`
		ExpectedModelConfigRevision *int64   `json:"expectedModelConfigRevision"`
	}
	if err := decodeParams(raw, &args); err != nil {
		return nil, err
	}
	external := ctx.Caller.Kind == CallerExternal && !ctx.Caller.ReadOnly
	if !external && ctx.TurnID == "" {
		return nil, PermissionDenied("production_authorization_required", "请先确认本次制作方案")
	}
	if strings.TrimSpace(args.CanvasID) == "" || len(args.NodeIDs) == 0 || len(args.NodeIDs) > 8 {
		return nil, InvalidArg("invalid_batch", "canvasId 和 1 至 8 个 nodeIds 必填")
	}
	if external && (args.ExpectedRevision == nil || *args.ExpectedRevision < 1 || args.ExpectedModelConfigRevision == nil || *args.ExpectedModelConfigRevision < 0 || ctx.OperationID == "") {
		return nil, InvalidArg("generation_snapshot_required", "请先读取生成提议，并提交画布版本、模型配置版本和稳定 operationId")
	}
	docRaw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(docRaw, &doc); err != nil {
		return nil, AsError(err)
	}
	if external && canvasRevision(doc) != *args.ExpectedRevision {
		return nil, Conflict("revision_conflict", "画布已变化，请重新读取并确认生成内容", nil)
	}
	targets, err := GenerationTargets(ctx.Domain, doc, args.NodeIDs)
	if err != nil {
		return nil, err
	}
	for _, target := range targets {
		if args.Kind != "" && target.Kind != args.Kind {
			return nil, InvalidArg("generation_kind_mismatch", "请按素材类型分批生成")
		}
		if external {
			choice, err := ctx.Domain.ResolveAssistantGenerationModel(target.Kind, target.ModelKey)
			if err != nil {
				return nil, AsError(err)
			}
			if choice.Revision != *args.ExpectedModelConfigRevision {
				return nil, Conflict("generation_config_changed", "模型配置已变化，请重新读取生成提议", nil)
			}
		}
	}
	nodes := map[string]map[string]any{}
	for _, v := range canvasNodes(doc) {
		n, _ := v.(map[string]any)
		nodes[dependencyString(n, "id")] = n
	}
	if err = validateGenerationDependencies(doc, nodes, args.NodeIDs, args.Kind); err != nil {
		return nil, err
	}
	if external {
		port, ok := ctx.Domain.(ExternalGenerationAdmission)
		if !ok {
			return nil, Unsupported("generation_unavailable", "当前工作区不能提交生成")
		}
		return port.SubmitExternalGeneration(ctx.UserID, ctx.OperationID, args.CanvasID, targets)
	}
	port, ok := ctx.Domain.(AuthorizedGenerationAdmission)
	if !ok {
		return nil, Unsupported("generation_unavailable", "当前工作区不能自动执行制作")
	}
	return port.SubmitAuthorizedGeneration(ctx.UserID, ctx.TurnID, args.CanvasID, targets)
}

// GenerationTargets is shared by proposal, UI confirmation and submission so
// the model cannot replace approved prompt/model/quantity between those steps.
func GenerationTargets(domain Domain, doc map[string]any, ids []string) ([]GenerationTarget, error) {
	if len(ids) == 0 || len(ids) > 24 {
		return nil, InvalidArg("invalid_batch", "制作素材须为1至24项")
	}
	nodes := map[string]map[string]any{}
	graph := generationDependencyGraph{nodes: nodes, incoming: map[string][]string{}, config: map[string]string{}}
	for _, v := range canvasNodes(doc) {
		n, _ := v.(map[string]any)
		nodes[dependencyString(n, "id")] = n
	}
	if edges, ok := doc["connections"].([]any); ok {
		for _, v := range edges {
			e, _ := v.(map[string]any)
			to, from := dependencyString(e, "toNodeId"), dependencyString(e, "fromNodeId")
			graph.incoming[to] = append(graph.incoming[to], from)
		}
	}
	seen := map[string]bool{}
	targets := []GenerationTarget{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		n := nodes[id]
		kind := nodeGenerationKind(n)
		if n == nil || (kind != "image" && kind != "video" && kind != "audio") {
			return nil, InvalidArg("invalid_generation_node", "请使用当前画布的图片、视频或音频节点")
		}
		meta := dependencyMetadata(n)
		choice, err := domain.ResolveAssistantGenerationModel(kind, nodeSelectedModel(n))
		if err != nil {
			return nil, AsError(err)
		}
		if choice.ModelKey == "" || choice.KindMismatch {
			return nil, PreconditionFailed("generation_model_unavailable", "素材模型暂不可用，请重新选择", nil)
		}
		prompt := dependencyString(meta, "composerContent")
		if prompt == "" {
			prompt = dependencyString(meta, "prompt")
		}
		if strings.TrimSpace(prompt) == "" {
			return nil, InvalidArg("missing_prompt", "制作素材缺少提示词或旁白文本")
		}
		parameters := map[string]string{}
		for _, key := range []string{"size", "quality", "count", "transparentBackground", "seconds", "vquality", "generateAudio", "watermark", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "videoStartFrameNodeId", "videoEndFrameNodeId", "videoMiddleFrameNodeId"} {
			if v, ok := meta[key]; ok && v != nil {
				parameters[key] = fmt.Sprint(v)
			}
		}
		if kind == "image" {
			model := choice.ModelKey
			if i := strings.LastIndex(model, "::"); i >= 0 {
				model = model[i+2:]
			}
			if family := providerpreset.SeedreamFamily(model); family != "" {
				for _, key := range []string{"seedreamMode", "seedreamMaxImages", "seedreamOutputFormat", "seedreamOptimize", "seedreamWatermark"} {
					if v, ok := meta[key]; ok && v != nil {
						parameters[key] = fmt.Sprint(v)
					}
				}
				maxImages, _ := strconv.Atoi(parameters["seedreamMaxImages"])
				if parameters["seedreamMode"] == "layers" || (family != "pro" && family != "flash" && maxImages > 1) {
					return nil, InvalidArg("production_seedream_multiple_outputs", "整片制作暂不支持 Seedream 图层拆分或组图。请先在画布生成图片，再用已有图片继续制作。")
				}
			}
			if err := validateSeedreamDraftSize(kind, choice.ModelKey, parameters); err != nil {
				return nil, err
			}
		}
		var metadata map[string]any
		for _, key := range []string{"videoEditOperation", "videoOperation", "videoMiddleFrameTime", "videoReferenceOrder", "videoH3Options", "providerOptions"} {
			if value, ok := meta[key]; ok && value != nil {
				if metadata == nil {
					metadata = map[string]any{}
				}
				metadata[key] = value
			}
		}
		if count := parameters["count"]; count != "" && count != "1" {
			return nil, InvalidArg("production_image_count", "整片制作请为每张图片建立独立节点")
		}
		refs := graph.references(id, kind)
		sort.Strings(refs)
		refs = uniqueTargetIDs(refs)
		targets = append(targets, GenerationTarget{NodeID: id, Title: dependencyString(n, "title"), Kind: kind, ModelKey: choice.ModelKey, Prompt: prompt, Parameters: parameters, Metadata: metadata, ReferenceNodeIDs: refs})
	}
	return targets, nil
}

func uniqueTargetIDs(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if len(out) == 0 || out[len(out)-1] != id {
			out = append(out, id)
		}
	}
	return out
}
