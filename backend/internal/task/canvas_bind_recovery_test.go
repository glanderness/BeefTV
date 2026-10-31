package task

import (
	"encoding/json"
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestNewCanvasBindRefusalKeepsTheRefusingRevision(t *testing.T) {
	details := func(revision any) map[string]any {
		return map[string]any{"canvasBinding": map[string]any{"revision": revision}}
	}
	for _, revision := range []any{int64(7), float64(7), json.Number("7")} {
		marker, ok := NewCanvasBindRefusal("node-1", 2, "node_task_mismatch", details(revision))
		if !ok || marker.Revision != 7 || marker.NodeID != "node-1" || marker.OutputIndex != 2 {
			t.Fatalf("revision %T: ok=%v marker=%+v", revision, ok, marker)
		}
	}
	if _, ok := NewCanvasBindRefusal("node-1", 0, "node_deleted", map[string]any{}); ok {
		t.Fatal("node refusal without revision must not be recorded")
	}
	if marker, ok := NewCanvasBindRefusal("node-1", 0, "canvas_mismatch", nil); !ok || marker.Revision != 0 {
		t.Fatalf("task-decided refusal needs no revision: ok=%v marker=%+v", ok, marker)
	}
	if _, ok := NewCanvasBindRefusal("node-1", 0, "delivery_unreadable", nil); ok {
		t.Fatal("non-terminal reasons must not be recorded")
	}
}

func TestCanvasBindRefusalStillRefusedOnlyWhileCanvasUnchanged(t *testing.T) {
	revision := func(value int64, err error) func() (int64, error) {
		return func() (int64, error) { return value, err }
	}
	node := CanvasBindRecoveryTarget{NodeID: "n", Reason: "node_task_mismatch", Revision: 5}
	if !node.StillRefused(revision(5, nil)) {
		t.Fatal("same revision must skip")
	}
	if node.StillRefused(revision(6, nil)) {
		t.Fatal("any canvas write must retry")
	}
	if node.StillRefused(revision(5, errors.New("db down"))) {
		t.Fatal("unknown revision must retry")
	}
	if (CanvasBindRecoveryTarget{NodeID: "n", Reason: "node_deleted"}).StillRefused(revision(5, nil)) {
		t.Fatal("node marker without revision must retry")
	}
	if !(CanvasBindRecoveryTarget{NodeID: "n", Reason: "canvas_mismatch"}).StillRefused(func() (int64, error) {
		t.Fatal("task-decided refusal must not read the canvas")
		return 0, nil
	}) {
		t.Fatal("task-decided refusal must skip")
	}
}

func TestCanvasBindRecoveryOutcomeClearsWhenEmpty(t *testing.T) {
	var state CanvasBindRecovery
	if outcome, err := state.Outcome(); err != nil || outcome != nil {
		t.Fatalf("empty markers must clear the column: %v %v", outcome, err)
	}
	state.Upsert(CanvasBindRecoveryTarget{NodeID: "n", Reason: "canvas_mismatch"})
	outcome, err := state.Outcome()
	if err != nil || outcome == nil {
		t.Fatalf("markers must encode: %v %v", outcome, err)
	}
	if decoded, ok := DecodeCanvasBindRecovery(outcome); !ok || len(decoded.Targets) != 1 {
		t.Fatalf("round trip failed: %+v %v", decoded, ok)
	}
}

func TestCanvasBindPassClearsLegacyAndUnlistedMarkers(t *testing.T) {
	legacy := `canvas_bind:{"version":2,"targets":[{"nodeId":"n","outputIndex":0,"reason":"node_task_mismatch"}]}`
	pass := NewCanvasBindPass(&legacy)
	if pass.Skip("n", 0, func() (int64, error) { return 1, nil }) {
		t.Fatal("legacy marker must not skip")
	}
	if marker, changed, err := pass.Finish(); err != nil || !changed || marker != nil {
		t.Fatalf("legacy marker must be cleared: %v %v %v", marker, changed, err)
	}

	state := CanvasBindRecovery{}
	state.Upsert(CanvasBindRecoveryTarget{NodeID: "gone", Reason: "canvas_mismatch"})
	state.Upsert(CanvasBindRecoveryTarget{NodeID: "kept", Reason: "canvas_mismatch"})
	raw, _ := EncodeCanvasBindRecovery(state)
	pass = NewCanvasBindPass(raw)
	if !pass.Skip("kept", 0, nil) {
		t.Fatal("task-decided refusal must skip")
	}
	marker, changed, err := pass.Finish()
	decoded, _ := DecodeCanvasBindRecovery(marker)
	if err != nil || !changed || len(decoded.Targets) != 1 || decoded.Targets[0].NodeID != "kept" {
		t.Fatalf("unlisted target must be dropped: %+v %v %v", decoded, changed, err)
	}

	quiet := NewCanvasBindPass(nil)
	quiet.Skip("n", 0, nil)
	quiet.Bound("n", 0)
	if _, changed, _ := quiet.Finish(); changed {
		t.Fatal("a pass with nothing to record must not write")
	}
}

func TestCanvasBindNodeIDUsesFrozenOutputDestinations(t *testing.T) {
	multi := model.Task{ID: "t", Type: "canvas_image", Model: "gpt-image-2", InputJSON: `{"metadata":{"nodeId":"root","outputNodeIds":["root"," child-1 ",""]}}`}
	for index, want := range []string{"root", "child-1", "", ""} {
		if got := CanvasBindNodeID(multi, index, "root"); got != want {
			t.Fatalf("output %d -> %q, want %q", index, got, want)
		}
	}
	single := model.Task{ID: "t", Type: "canvas_text", InputJSON: `{"metadata":{"nodeId":"text-node"}}`}
	if got := CanvasBindNodeID(single, 0, "text-node"); got != "text-node" {
		t.Fatalf("tasks without frozen outputs keep the fallback: %q", got)
	}
}
