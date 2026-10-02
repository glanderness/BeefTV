package assistantturns

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func changeFromReceipts(record Record, receipts []model.AgentOpRecord) (*Change, error) {
	if strings.TrimSpace(record.TurnID) == "" {
		return nil, errors.New("助手操作回执不可用，已保留撤销快照")
	}
	type step struct {
		revision int64
		opID     string
		op       string
		payload  map[string]any
	}
	steps := make([]step, 0, len(receipts))
	for _, receipt := range receipts {
		var payload map[string]any
		if json.Unmarshal([]byte(receipt.ResultJSON), &payload) != nil {
			return nil, errors.New("助手操作回执损坏，已保留撤销快照")
		}
		if got, _ := payload["canvasId"].(string); got != record.CanvasID {
			return nil, errors.New("助手操作回执的画布归属不一致，已保留撤销快照")
		}
		if receipt.Op == "canvas.edge.create" && payload["created"] != true {
			continue
		}
		revision, ok := jsonWholeNumber(payload["revision"])
		if !ok || revision <= record.RevisionBefore {
			continue
		}
		steps = append(steps, step{revision: revision, opID: receipt.OpID, op: receipt.Op, payload: payload})
	}
	if len(steps) == 0 {
		return nil, nil
	}
	sort.Slice(steps, func(i, j int) bool { return steps[i].revision < steps[j].revision })
	change := &Change{RevisionBefore: record.RevisionBefore}
	for _, item := range steps {
		if item.revision <= change.RevisionAfter {
			continue
		}
		change.RevisionAfter = item.revision
		change.OperationIDs = append(change.OperationIDs, item.opID)
		switch item.op {
		case "canvas.nodes.create":
			for _, raw := range docItems(item.payload["created"]) {
				if id, _ := raw["id"].(string); id != "" && !slices.Contains(change.CreatedNodeIDs, id) {
					change.CreatedNodeIDs = append(change.CreatedNodeIDs, id)
				}
			}
		case "canvas.node.update", "canvas.task.bind":
			if id, _ := item.payload["nodeId"].(string); id != "" && !slices.Contains(change.UpdatedNodeIDs, id) {
				change.UpdatedNodeIDs = append(change.UpdatedNodeIDs, id)
			}
		case "canvas.edge.create":
			if created, _ := item.payload["created"].(bool); created {
				if id, _ := item.payload["edgeId"].(string); id != "" && !slices.Contains(change.CreatedEdgeIDs, id) {
					change.CreatedEdgeIDs = append(change.CreatedEdgeIDs, id)
				}
			}
		}
	}
	if change.RevisionAfter <= change.RevisionBefore {
		return nil, nil
	}
	return change, nil
}

// MatchesChange checks that a single-write document diff agrees with the
// change summary. It cannot prove authorship of repeated writes on one node.
func MatchesChange(before, after map[string]any, change *Change) bool {
	if change == nil {
		return false
	}
	remaining := make(map[string]any, len(after))
	for key, value := range after {
		remaining[key] = value
	}
	for _, field := range []struct {
		name             string
		created, updated []string
	}{
		{"nodes", change.CreatedNodeIDs, change.UpdatedNodeIDs},
		{"connections", change.CreatedEdgeIDs, nil},
	} {
		oldItems, oldOK := before[field.name].([]any)
		newItems, newOK := after[field.name].([]any)
		if !oldOK || !newOK {
			return false
		}
		oldByID := make(map[string]any, len(oldItems))
		for _, item := range oldItems {
			obj, ok := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !ok || id == "" || oldByID[id] != nil {
				return false
			}
			oldByID[id] = item
		}
		declared := make(map[string]bool)
		for _, id := range field.created {
			if declared[id] || id == "" || oldByID[id] != nil {
				return false
			}
			declared[id] = true
		}
		for _, id := range field.updated {
			if _, exists := declared[id]; exists || oldByID[id] == nil {
				return false
			}
			declared[id] = false
		}
		projected := make([]any, 0, len(newItems))
		seen := make(map[string]bool)
		for _, item := range newItems {
			obj, ok := item.(map[string]any)
			id, _ := obj["id"].(string)
			if !ok || id == "" || seen[id] {
				return false
			}
			seen[id] = true
			if created, exists := declared[id]; exists {
				delete(declared, id)
				if created {
					continue
				}
				item = oldByID[id]
			}
			projected = append(projected, item)
		}
		if len(declared) != 0 || !reflect.DeepEqual(oldItems, projected) {
			return false
		}
		remaining[field.name] = before[field.name]
	}
	for _, key := range []string{"revision", "updatedAt", "remoteContentHash"} {
		if value, exists := before[key]; exists {
			remaining[key] = value
		} else {
			delete(remaining, key)
		}
	}
	return reflect.DeepEqual(before, remaining)
}

// OperationsCoverSpan requires the listed succeeded receipts to cover every
// revision in (before, after] on the same canvas. A missing revision means
// an unattributed write.
func OperationsCoverSpan(records []model.AgentOpRecord, canvasID string, ids []string, before, after int64) bool {
	if after <= before || len(ids) == 0 {
		return false
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	if len(records) != len(ids) {
		return false
	}
	covered := make(map[int64]bool, len(records))
	for _, record := range records {
		if record.Status != "succeeded" {
			return false
		}
		var payload map[string]any
		if json.Unmarshal([]byte(record.ResultJSON), &payload) != nil {
			return false
		}
		gotCanvas, _ := payload["canvasId"].(string)
		revision, ok := jsonWholeNumber(payload["revision"])
		if gotCanvas != canvasID || !ok || revision <= before || revision > after || covered[revision] {
			return false
		}
		covered[revision] = true
	}
	for revision := before + 1; revision <= after; revision++ {
		if !covered[revision] {
			return false
		}
	}
	return true
}
