package agentops_test

import (
	"infinite-canvas/backend/internal/app"
	"reflect"
	"testing"
)

func TestStoryboardOperationsReceiptReplayAndUndo(t *testing.T) {
	for _, op := range []string{"canvas.script.rows.append", "canvas.script.row.update", "canvas.script.row.remove"} {
		t.Run(op, func(t *testing.T) {
			h := newHarness(t)
			doc := h.canvas(t)
			node := doc["nodes"].([]any)[0].(map[string]any)
			node["type"] = "script"
			node["metadata"] = map[string]any{"storyboard": map[string]any{"rows": []any{map[string]any{"id": "shot-original", "shotNumber": 1, "dialogue": "original"}}}}
			doc["nodes"] = append(doc["nodes"].([]any), map[string]any{"id": "target", "type": "image", "position": map[string]any{"x": 100, "y": 100}})
			doc["connections"] = []any{
				map[string]any{"id": "row-edge", "fromNodeId": "n1", "toNodeId": "target", "fromHandleId": "row:shot-original"},
				map[string]any{"id": "row-in", "fromNodeId": "target", "toNodeId": "n1", "toHandleId": "row:shot-original"},
				map[string]any{"id": "row-tag", "fromNodeId": "n1", "toNodeId": "target", "storyboardRowId": "shot-original"},
				map[string]any{"id": "keep-edge", "fromNodeId": "n1", "toNodeId": "target"},
			}
			if _, err := h.service.UpsertUserCanvasProject(h.userID, mustRaw(t, doc)); err != nil {
				t.Fatal(err)
			}
			before := h.canvas(t)
			const turn = "abcd9988"
			if _, err := h.service.BeginAssistantTurn(h.userID, h.canvasID, turn, app.AssistantTurnInput{}); err != nil {
				t.Fatal(err)
			}
			p := map[string]any{"canvasId": h.canvasID, "nodeId": "n1", "expectedRevision": before["revision"]}
			switch op {
			case "canvas.script.rows.append":
				p["rows"] = []any{map[string]any{"dialogue": "new"}}
			case "canvas.script.row.update":
				p["patches"] = []any{map[string]any{"rowId": "shot-original", "dialogue": "new"}}
			case "canvas.script.row.remove":
				p["rowIds"] = []string{"shot-original"}
			}
			if _, err := accessWrite(t, h, turn, "canvas", op, "story-write", p); err != nil {
				t.Fatal(err)
			}
			result, err := accessWrite(t, h, turn, "canvas", op, "story-write", p)
			if err != nil || !result.Replayed {
				t.Fatalf("replay: %+v %v", result, err)
			}
			if err := h.service.FinalizeAssistantTurn(turn); err != nil {
				t.Fatal(err)
			}
			state, err := h.service.ReadAssistantTurnHistoryState(h.userID, h.canvasID, turn)
			if err != nil || state == nil || state.Change == nil || !reflect.DeepEqual(state.Change.UpdatedNodeIDs, []string{"n1"}) {
				t.Fatalf("missing node change: %+v %v", state, err)
			}
			if op == "canvas.script.row.remove" {
				if !reflect.DeepEqual(state.Change.DeletedEdgeIDs, []string{"row-edge", "row-in", "row-tag"}) || len(h.canvas(t)["connections"].([]any)) != 1 {
					t.Fatal("removed row left dangling edges or deleted unrelated edges")
				}
			}
			if _, err := h.service.UndoAssistantTurn(h.userID, h.canvasID, turn); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before["nodes"], h.canvas(t)["nodes"]) {
				t.Fatal("storyboard not restored")
			}
			if !reflect.DeepEqual(before["connections"], h.canvas(t)["connections"]) {
				t.Fatal("undo did not restore row connections")
			}
		})
	}
}
