package operations

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

func opCanvasTaskBind(ctx *Context, params json.RawMessage) (any, error) {
	var args struct {
		CanvasID    string `json:"canvasId"`
		TaskID      string `json:"taskId"`
		NodeID      string `json:"nodeId"`
		OutputIndex int    `json:"outputIndex"`
	}
	if err := decodeParams(params, &args); err != nil {
		return nil, err
	}
	receipt, err := taskbinding.Bind(&bindPorts{ctx: ctx}, ctx.UserID, taskbinding.Request{
		CanvasID:    args.CanvasID,
		TaskID:      args.TaskID,
		NodeID:      args.NodeID,
		OutputIndex: args.OutputIndex,
	})
	if err != nil {
		return nil, mapDomainError(err)
	}
	return sanitizeForClient(receiptMap(receipt)), nil
}

func projectCanvasTaskBindReplay(ctx *Context, params json.RawMessage, stored any) (any, error) {
	receipt, _ := stored.(map[string]any)
	if receipt == nil {
		receipt = map[string]any{}
	}
	var args struct {
		CanvasID string `json:"canvasId"`
		NodeID   string `json:"nodeId"`
	}
	if json.Unmarshal(params, &args) != nil {
		return stored, nil
	}
	raw, err := ctx.Domain.UserCanvasProject(ctx.UserID, args.CanvasID)
	if err != nil {
		return stored, nil
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return stored, nil
	}
	receipt["revision"] = canvasRevision(doc)
	if node := findDocNode(doc, args.NodeID); node != nil {
		receipt["node"] = node
	}
	return sanitizeForClient(receipt), nil
}

func receiptMap(receipt taskbinding.Receipt) map[string]any {
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return map[string]any{"applied": receipt.Applied, "canvasId": receipt.CanvasID, "nodeId": receipt.NodeID, "taskId": receipt.TaskID, "revision": receipt.Revision}
	}
	var out map[string]any
	if json.Unmarshal(encoded, &out) != nil {
		return map[string]any{"applied": receipt.Applied, "revision": receipt.Revision}
	}
	return out
}

type bindPorts struct {
	ctx *Context
}

func (p *bindPorts) Task(userID, taskID string) (*model.Task, error) {
	return p.ctx.Domain.WorkspaceTask(userID, taskID)
}

func (p *bindPorts) GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error) {
	return p.ctx.Domain.GenerationOutputs(taskID)
}

func (p *bindPorts) OwnedReadyResource(userID, resourceID string) (*model.Resource, error) {
	return p.ctx.Domain.OwnedReadyResource(userID, resourceID)
}

func (p *bindPorts) OwnedAsset(userID, assetID string) (*model.Asset, error) {
	return p.ctx.Domain.OwnedAsset(userID, assetID)
}

func (p *bindPorts) BindExistingNode(userID string, patch taskbinding.NodePatch) (taskbinding.NodeBindResult, error) {
	result, err := p.ctx.Domain.BindExistingCanvasNode(userID, canvas.TaskOutputBind{
		CanvasID:    patch.CanvasID,
		NodeID:      patch.NodeID,
		TaskID:      patch.TaskID,
		OutputIndex: patch.OutputIndex,
		EffectKey:   patch.EffectKey,
		MediaType:   patch.MediaType,
		AssetID:     patch.AssetID,
		ResourceID:  patch.ResourceID,
		StorageKey:  patch.StorageKey,
		Content:     patch.Content,
		MimeType:    patch.MimeType,
		Bytes:       patch.Bytes,
		Width:       patch.Width,
		Height:      patch.Height,
		DurationMs:  patch.DurationMs,
		Storyboard:  patch.Storyboard,
	})
	if err != nil {
		return taskbinding.NodeBindResult{}, err
	}
	return taskbinding.NodeBindResult{Revision: result.Revision, Node: result.Node}, nil
}

func bindEffectKey(params json.RawMessage) string {
	var args struct {
		TaskID      string `json:"taskId"`
		NodeID      string `json:"nodeId"`
		OutputIndex int    `json:"outputIndex"`
	}
	if json.Unmarshal(params, &args) != nil {
		return ""
	}
	taskID := strings.TrimSpace(args.TaskID)
	nodeID := strings.TrimSpace(args.NodeID)
	if taskID == "" || nodeID == "" {
		return ""
	}
	return localtask.AttachNodeEffectKey(taskID, nodeID, args.OutputIndex)
}
