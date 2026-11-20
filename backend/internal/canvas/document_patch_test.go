package canvas

import (
	"encoding/json"
	"testing"
)

func TestPatchUserCanvasDocument_DisjointOverlapUploadAndHistory(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	owner := "owner"

	initial := map[string]any{
		"id":       "patch-c1",
		"revision": 0,
		"title":    "测试画布",
		"nodes": []any{
			map[string]any{"id": "n1", "type": "image", "title": "镜头1", "position": map[string]any{"x": 0, "y": 0}, "width": 300, "height": 300,
				"metadata": map[string]any{"status": "loading", "taskId": "task-1", "prompt": "cat"}},
			map[string]any{"id": "n2", "type": "text", "title": "文案2", "position": map[string]any{"x": 400, "y": 0}, "width": 280, "height": 180,
				"metadata": map[string]any{"status": "loading", "taskId": "task-2", "prompt": "story"}},
			map[string]any{"id": "n3", "type": "text", "title": "备注", "position": map[string]any{"x": 0, "y": 400}, "width": 240, "height": 120,
				"metadata": map[string]any{"content": "旧备注", "status": "success"}},
			map[string]any{"id": "n4", "type": "image", "title": "上传图", "position": map[string]any{"x": 400, "y": 400}, "width": 300, "height": 300,
				"metadata": map[string]any{"status": "loading", "fileUploadAttemptId": "up-1", "fileUpload": map[string]any{"status": "uploading", "progress": 30}}},
		},
		"connections": []any{
			map[string]any{"id": "e1", "fromNodeId": "n1", "toNodeId": "n2"},
		},
	}
	raw, _ := json.Marshal(initial)
	created, err := svc.UpsertUserCanvasProject(owner, raw)
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}

	bumpDoc := func(expected int64, mutate func(doc map[string]any)) int64 {
		cur, err := svc.UserCanvasProject(owner, "patch-c1")
		if err != nil {
			t.Fatalf("read canvas: %v", err)
		}
		var doc map[string]any
		_ = json.Unmarshal(cur, &doc)
		mutate(doc)
		doc["revision"] = expected
		enc, _ := json.Marshal(doc)
		sum, _, err := svc.CommitUserCanvasDocument(owner, "patch-c1", expected, enc)
		if err != nil {
			t.Fatalf("commit rev %d: %v", expected, err)
		}
		return sum.Revision
	}

	// Parallel backend completions advance rev 1 -> 2 -> 3 -> 4.
	rev2 := bumpDoc(created.Revision, func(doc map[string]any) {
		n := findCanvasNode(doc, "n1")
		m := nodeMetadata(n)
		m["status"] = "success"
		m["content"] = "https://example.com/img1.png"
		m["taskStatus"] = "succeeded"
		m["taskProgress"] = 100
		n["metadata"] = m
	})
	rev3 := bumpDoc(rev2, func(doc map[string]any) {
		n := findCanvasNode(doc, "n2")
		m := nodeMetadata(n)
		m["status"] = "success"
		m["content"] = "生成好的分镜正文"
		m["taskStatus"] = "succeeded"
		m["taskProgress"] = 100
		n["metadata"] = m
	})
	rev4 := bumpDoc(rev3, func(doc map[string]any) {
		n := findCanvasNode(doc, "n4")
		m := nodeMetadata(n)
		m["status"] = "success"
		m["content"] = "https://example.com/upload4.png"
		delete(m, "fileUpload")
		n["metadata"] = m
	})
	if rev4 != 4 {
		t.Fatalf("expected rev 4, got %d", rev4)
	}

	// 1. Disjoint edit on n3 from stale baseRevision=1 succeeds immediately and returns merged doc.
	res1, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: 1,
		UpsertNodes: []map[string]any{
			{"id": "n3", "type": "text", "title": "备注", "position": map[string]any{"x": 222, "y": 555}, "width": 240, "height": 120,
				"metadata": map[string]any{"content": "新备注", "status": "success"}},
		},
	})
	if err != nil {
		t.Fatalf("disjoint patch failed: %v", err)
	}
	if res1.Summary.Revision != 5 || !res1.ServerAdvanced || len(res1.Document) == 0 {
		t.Fatalf("unexpected res1: %+v", res1)
	}
	var doc5 map[string]any
	_ = json.Unmarshal(res1.Document, &doc5)
	if nodeString(nodeMetadata(findCanvasNode(doc5, "n1")), "content") != "https://example.com/img1.png" {
		t.Fatalf("n1 bound image lost")
	}
	if nodeString(nodeMetadata(findCanvasNode(doc5, "n2")), "content") != "生成好的分镜正文" {
		t.Fatalf("n2 bound text lost")
	}
	if nodeString(nodeMetadata(findCanvasNode(doc5, "n3")), "content") != "新备注" {
		t.Fatalf("n3 user edit lost")
	}

	// 2. Stale loading overlay on n1 (image), n2 (text), and n4 (upload) still preserves server outputs while applying user moves/renames.
	res2, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: 1,
		UpsertNodes: []map[string]any{
			{"id": "n1", "type": "image", "title": "镜头1-新名", "position": map[string]any{"x": 99, "y": 88}, "width": 300, "height": 300,
				"metadata": map[string]any{"status": "loading", "taskId": "task-1", "prompt": "cat"}},
			{"id": "n2", "type": "text", "title": "文案2-新名", "position": map[string]any{"x": 450, "y": 88}, "width": 280, "height": 180,
				"metadata": map[string]any{"status": "loading", "taskId": "task-2", "prompt": "story"}},
			{"id": "n4", "type": "image", "title": "上传图-新名", "position": map[string]any{"x": 450, "y": 450}, "width": 300, "height": 300,
				"metadata": map[string]any{"status": "loading", "fileUploadAttemptId": "up-1", "fileUpload": map[string]any{"status": "uploading", "progress": 60}}},
		},
	})
	if err != nil {
		t.Fatalf("overlay-protected patch failed: %v", err)
	}
	if !res2.MediaPreserved {
		t.Fatalf("expected MediaPreserved=true")
	}
	var doc6 map[string]any
	_ = json.Unmarshal(res2.Document, &doc6)
	for id, want := range map[string]struct{ title, content string }{
		"n1": {"镜头1-新名", "https://example.com/img1.png"},
		"n2": {"文案2-新名", "生成好的分镜正文"},
		"n4": {"上传图-新名", "https://example.com/upload4.png"},
	} {
		got := findCanvasNode(doc6, id)
		if nodeString(got, "title") != want.title || nodeString(nodeMetadata(got), "content") != want.content || nodeString(nodeMetadata(got), "status") != "success" {
			t.Fatalf("node %s mismatch: %+v", id, got)
		}
	}

	// 3. Explicit deletion of n2 after server bound it removes node + dangling edge AND captures a recoverable before_merge history snapshot.
	res3, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision:  1,
		DeleteNodeIDs: []string{"n2"},
	})
	if err != nil {
		t.Fatalf("delete patch failed: %v", err)
	}
	if !res3.SnapshotCaptured {
		t.Fatalf("expected before_merge snapshot captured")
	}
	history, err := svc.CanvasHistory(owner, "patch-c1")
	if err != nil || len(history.Snapshots) == 0 {
		t.Fatalf("expected canvas history snapshot, got %d err=%v", len(history.Snapshots), err)
	}
	var doc7 map[string]any
	_ = json.Unmarshal(res3.Document, &doc7)
	if findCanvasNode(doc7, "n2") != nil {
		t.Fatalf("expected n2 deleted")
	}
	if edges, _ := doc7["connections"].([]any); len(edges) != 0 {
		t.Fatalf("expected dangling edge e1 deleted, got %+v", edges)
	}
}
