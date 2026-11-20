package operations_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/operations"
)

func TestCanvasDocumentPatchOpReplayAndDisjointMerge(t *testing.T) {
	h := newHarness(t)
	seed := map[string]any{
		"id":    h.canvasID,
		"title": "增量提交画布",
		"nodes": []any{
			map[string]any{"id": "n1", "type": "text", "title": "A", "position": map[string]any{"x": 0, "y": 0}, "width": 200, "height": 120,
				"metadata": map[string]any{"content": "a0", "status": "success"}},
			map[string]any{"id": "n2", "type": "text", "title": "B", "position": map[string]any{"x": 300, "y": 0}, "width": 200, "height": 120,
				"metadata": map[string]any{"content": "b0", "status": "success"}},
		},
		"connections": []any{},
	}
	base, err := h.execute(t, operations.ManualCaller(false), "canvas.document.commit", "seed-patch-doc", map[string]any{
		"canvasId":         h.canvasID,
		"expectedRevision": h.revisionNow(t),
		"document":         seed,
	})
	if err != nil {
		t.Fatalf("seed canvas: %v", err)
	}

	// External assistant write updates n1 and bumps revision.
	agent, err := h.execute(t, h.assistant(), "canvas.node.update", "agent-n1", map[string]any{
		"canvasId":         h.canvasID,
		"expectedRevision": base.Revision,
		"nodeId":           "n1",
		"patch":            map[string]any{"title": "A-助手修改"},
	})
	if err != nil {
		t.Fatalf("agent update n1: %v", err)
	}

	// UI patch on n2 with stale baseRevision=base.Revision succeeds with zero 409 and returns merged doc.
	params := map[string]any{
		"canvasId":     h.canvasID,
		"baseRevision": base.Revision,
		"upsertNodes": []any{
			map[string]any{"id": "n2", "type": "text", "title": "B-改", "position": map[string]any{"x": 350, "y": 50}, "width": 200, "height": 120,
				"metadata": map[string]any{"content": "b1", "status": "success"}},
		},
	}
	first, err := h.execute(t, operations.ManualCaller(false), "canvas.document.patch", "ui-patch-1", params)
	if err != nil {
		t.Fatalf("canvas.document.patch: %v", err)
	}
	if first.Replayed || first.Revision != agent.Revision+1 {
		t.Fatalf("unexpected first patch result: %+v", first)
	}
	resultMap, _ := first.Result.(map[string]any)
	if resultMap["serverAdvanced"] != true {
		t.Fatalf("expected serverAdvanced=true, got %+v", resultMap)
	}

	// Replaying the same opId is idempotent.
	replayed, err := h.execute(t, operations.ManualCaller(false), "canvas.document.patch", "ui-patch-1", params)
	if err != nil {
		t.Fatalf("replay canvas.document.patch: %v", err)
	}
	if !replayed.Replayed || replayed.Revision != first.Revision {
		t.Fatalf("expected idempotent replay at rev %d, got %+v", first.Revision, replayed)
	}

	// Built-in assistant callers (canvas and full-access) cannot invoke canvas.document.patch (ExternalOnly).
	if _, err := h.execute(t, h.assistant(), "canvas.document.patch", "assistant-patch", params); err == nil {
		t.Fatal("canvas assistant should not be allowed to invoke canvas.document.patch")
	}
	fullAccessAssistant := operations.AssistantCaller(&agentops.AssistantScope{
		PermissionMode: "full-access",
		CanvasID:       h.canvasID,
		AssetIDs:       map[string]bool{},
		CanvasIDs:      map[string]bool{},
		TaskIDs:        map[string]bool{},
	}, false)
	if _, err := h.execute(t, fullAccessAssistant, "canvas.document.patch", "assistant-full-access-patch", params); err == nil {
		t.Fatal("full-access assistant should not be allowed to invoke canvas.document.patch")
	}

	// Verify both n1 assistant edit and n2 user edit persisted in SQLite.
	raw, err := h.service.UserCanvasProject(h.userID, h.canvasID)
	if err != nil {
		t.Fatalf("read canvas: %v", err)
	}
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	nodes, _ := doc["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}
	titles := map[string]string{}
	for _, item := range nodes {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		title, _ := m["title"].(string)
		titles[id] = title
	}
	if titles["n1"] != "A-助手修改" || titles["n2"] != "B-改" {
		t.Fatalf("expected both sides preserved, got %+v", titles)
	}
}
