package canvas

import (
	"encoding/json"
	"testing"
)

func TestPatchUserCanvasDocument_DisjointOverlapUploadLifecycleAndHistory(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	owner := "owner"

	baseN3 := map[string]any{
		"id": "n3", "type": "text", "title": "备注",
		"position": map[string]any{"x": float64(0), "y": float64(400)},
		"width":    float64(240), "height": float64(120),
		"metadata": map[string]any{"content": "旧备注", "status": "success"},
	}
	baseN2 := map[string]any{
		"id": "n2", "type": "text", "title": "文案2",
		"position": map[string]any{"x": float64(400), "y": float64(0)},
		"width":    float64(280), "height": float64(180),
		"metadata": map[string]any{"status": "loading", "taskId": "task-2", "prompt": "story"},
	}
	initial := map[string]any{
		"id":       "patch-c1",
		"revision": 0,
		"title":    "测试画布",
		"nodes": []any{
			map[string]any{
				"id": "n1", "type": "image", "title": "镜头1",
				"position": map[string]any{"x": 0, "y": 0}, "width": 300, "height": 300,
				"metadata": map[string]any{"status": "loading", "taskId": "task-1", "prompt": "cat"},
			},
			baseN2,
			baseN3,
			// Production upload placeholder shape: metadata.fileUpload is the string "uploading" (not an object).
			map[string]any{
				"id": "n4", "type": "image", "title": "上传图",
				"position": map[string]any{"x": 400, "y": 400}, "width": 300, "height": 300,
				"metadata": map[string]any{"fileUploadAttemptId": "up-1", "fileUpload": "uploading", "fileUploadProgress": 30},
			},
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
		m["taskType"] = "canvas_image"
		m["taskStatus"] = "succeeded"
		m["taskProgress"] = 100
		m["retryOf"] = "task-0"
		m["attemptGroupId"] = "grp-1"
		m["taskClientOperationId"] = "op-gen-1"
		m["taskClientOperationTerminal"] = true
		m["generationSubmissionState"] = "submitted"
		m["taskProvider"] = "byteplus"
		m["taskOfficialStatus"] = "succeeded"
		m["taskReceiptRecorded"] = true
		m["taskUpdatedAt"] = "2026-11-20T00:00:00Z"
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
	// Settled upload in production removes fileUpload and may omit status:"success".
	rev4 := bumpDoc(rev3, func(doc map[string]any) {
		n := findCanvasNode(doc, "n4")
		m := nodeMetadata(n)
		m["content"] = "https://example.com/upload4.png"
		m["resultOrigin"] = "upload"
		delete(m, "fileUpload")
		delete(m, "fileUploadProgress")
		n["metadata"] = m
	})
	if rev4 != 4 {
		t.Fatalf("expected rev 4, got %d", rev4)
	}

	// 1. Disjoint edit on n3 from stale baseRevision=1 with ExpectedNodes succeeds immediately,
	// returns merged doc, and does NOT create a spurious before_merge snapshot.
	res1, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: 1,
		UpsertNodes: []map[string]any{
			{
				"id": "n3", "type": "text", "title": "备注",
				"position": map[string]any{"x": 222, "y": 555}, "width": 240, "height": 120,
				"metadata": map[string]any{"content": "新备注", "status": "success"},
			},
		},
		ExpectedNodes: map[string]map[string]any{"n3": baseN3},
	})
	if err != nil {
		t.Fatalf("disjoint patch failed: %v", err)
	}
	if res1.Summary.Revision != 5 || !res1.ServerAdvanced || len(res1.Document) == 0 {
		t.Fatalf("unexpected res1: %+v", res1)
	}
	if res1.SnapshotCaptured {
		t.Fatalf("disjoint edit with matching ExpectedNodes should not capture a spurious before_merge snapshot")
	}
	historyAfterDisjoint, err := svc.CanvasHistory(owner, "patch-c1")
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	for _, snap := range historyAfterDisjoint.Snapshots {
		if snap.Reason == "before_merge" {
			t.Fatalf("unexpected before_merge snapshot after disjoint edit: %+v", snap)
		}
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

	// 2. Stale loading/uploading overlay on n1 (image + full lifecycle), n2 (text), and n4 (real string fileUpload:"uploading")
	// protects ALL server outputs and lifecycle fields while applying user renames/moves.
	res2, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: 1,
		UpsertNodes: []map[string]any{
			{
				"id": "n1", "type": "image", "title": "镜头1-新名",
				"position": map[string]any{"x": 99, "y": 88}, "width": 300, "height": 300,
				"metadata": map[string]any{
					"status": "loading", "taskId": "task-1", "prompt": "cat",
					"taskType": "stale_type", "retryOf": "stale_retry",
					"taskClientOperationTerminal": false, "generationSubmissionState": "submitting",
					"errorDetails": "旧错误", "taskFailureDiagnostics": map[string]any{"code": "old"},
				},
			},
			{
				"id": "n2", "type": "text", "title": "文案2-新名",
				"position": map[string]any{"x": 450, "y": 88}, "width": 280, "height": 180,
				"metadata": map[string]any{"status": "loading", "taskId": "task-2", "prompt": "story"},
			},
			{
				"id": "n4", "type": "image", "title": "上传图-新名",
				"position": map[string]any{"x": 450, "y": 450}, "width": 300, "height": 300,
				"metadata": map[string]any{"fileUploadAttemptId": "up-1", "fileUpload": "uploading", "fileUploadProgress": 60},
			},
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
	n1Meta := nodeMetadata(findCanvasNode(doc6, "n1"))
	if nodeString(findCanvasNode(doc6, "n1"), "title") != "镜头1-新名" ||
		nodeString(n1Meta, "content") != "https://example.com/img1.png" ||
		nodeString(n1Meta, "taskType") != "canvas_image" ||
		nodeString(n1Meta, "retryOf") != "task-0" ||
		nodeString(n1Meta, "attemptGroupId") != "grp-1" ||
		nodeString(n1Meta, "taskClientOperationId") != "op-gen-1" ||
		n1Meta["taskClientOperationTerminal"] != true ||
		nodeString(n1Meta, "generationSubmissionState") != "submitted" ||
		nodeString(n1Meta, "taskProvider") != "byteplus" ||
		nodeString(n1Meta, "taskOfficialStatus") != "succeeded" ||
		n1Meta["taskReceiptRecorded"] != true ||
		nodeString(n1Meta, "taskUpdatedAt") != "2026-11-20T00:00:00Z" ||
		n1Meta["errorDetails"] != nil || n1Meta["taskFailureDiagnostics"] != nil {
		t.Fatalf("n1 authoritative lifecycle/output not fully preserved: %+v", n1Meta)
	}
	n4Node := findCanvasNode(doc6, "n4")
	n4Meta := nodeMetadata(n4Node)
	if nodeString(n4Node, "title") != "上传图-新名" ||
		nodeString(n4Meta, "content") != "https://example.com/upload4.png" ||
		n4Meta["fileUpload"] != nil || n4Meta["fileUploadProgress"] != nil {
		t.Fatalf("n4 settled upload not protected against string fileUpload:'uploading': %+v", n4Node)
	}

	// 3. Same-revision local-win overwrite (after frontend refresh advanced baseRevision) with ForceHistorySnapshot=true
	// MUST capture a real before_merge snapshot preserving the server's Agent text.
	revAgent := bumpDoc(res2.Summary.Revision, func(doc map[string]any) {
		n := findCanvasNode(doc, "n3")
		m := nodeMetadata(n)
		m["content"] = "Agent 刚写的权威文案"
		n["metadata"] = m
	})
	resSameRev, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: revAgent, // serverAdvanced == false!
		UpsertNodes: []map[string]any{
			{
				"id": "n3", "type": "text", "title": "备注",
				"position": map[string]any{"x": 222, "y": 555}, "width": 240, "height": 120,
				"metadata": map[string]any{"content": "用户本地胜出文案", "status": "success"},
			},
		},
		ForceHistorySnapshot: true,
	})
	if err != nil {
		t.Fatalf("same-rev forced history patch failed: %v", err)
	}
	if !resSameRev.SnapshotCaptured {
		t.Fatalf("expected real before_merge snapshot captured on same-rev local-win overlap")
	}
	historySameRev, err := svc.CanvasHistory(owner, "patch-c1")
	if err != nil || len(historySameRev.Snapshots) == 0 {
		t.Fatalf("expected snapshot list, err=%v", err)
	}
	latestSnap := historySameRev.Snapshots[0]
	if latestSnap.Reason != "before_merge" || latestSnap.Revision != revAgent {
		t.Fatalf("expected latest snapshot reason=before_merge revision=%d, got reason=%q revision=%d", revAgent, latestSnap.Reason, latestSnap.Revision)
	}
	fullSnap, err := svc.CanvasHistorySnapshot(owner, "patch-c1", latestSnap.ID)
	if err != nil {
		t.Fatalf("read full snapshot: %v", err)
	}
	var snapDoc map[string]any
	if err := json.Unmarshal([]byte(fullSnap.PayloadJSON), &snapDoc); err != nil {
		t.Fatalf("unmarshal snapshot payload: %v", err)
	}
	if got := nodeString(nodeMetadata(findCanvasNode(snapDoc, "n3")), "content"); got != "Agent 刚写的权威文案" {
		t.Fatalf("before_merge snapshot lost Agent text, got %q", got)
	}

	// 4. Deleting n2 (changed on server since ExpectedNodes) captures before_merge snapshot preserving n2 AND deletes dangling edge e1.
	revBeforeDelete := resSameRev.Summary.Revision
	resDel, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision:  1,
		DeleteNodeIDs: []string{"n2"},
		ExpectedNodes: map[string]map[string]any{"n2": baseN2},
	})
	if err != nil {
		t.Fatalf("delete patch failed: %v", err)
	}
	if !resDel.SnapshotCaptured {
		t.Fatalf("expected before_merge snapshot on overlapping delete")
	}
	historyAfterDel, err := svc.CanvasHistory(owner, "patch-c1")
	if err != nil || len(historyAfterDel.Snapshots) == 0 {
		t.Fatalf("history after delete failed: %v", err)
	}
	if historyAfterDel.Snapshots[0].Reason != "before_merge" || historyAfterDel.Snapshots[0].Revision != revBeforeDelete {
		t.Fatalf("unexpected delete snapshot: reason=%q rev=%d want rev=%d", historyAfterDel.Snapshots[0].Reason, historyAfterDel.Snapshots[0].Revision, revBeforeDelete)
	}
	fullDelSnap, err := svc.CanvasHistorySnapshot(owner, "patch-c1", historyAfterDel.Snapshots[0].ID)
	if err != nil {
		t.Fatalf("read delete snapshot: %v", err)
	}
	var delSnapDoc map[string]any
	_ = json.Unmarshal([]byte(fullDelSnap.PayloadJSON), &delSnapDoc)
	if got := nodeString(nodeMetadata(findCanvasNode(delSnapDoc, "n2")), "content"); got != "生成好的分镜正文" {
		t.Fatalf("delete before_merge snapshot lost n2 bound content, got %q", got)
	}
	var docAfterDel map[string]any
	_ = json.Unmarshal(resDel.Document, &docAfterDel)
	if findCanvasNode(docAfterDel, "n2") != nil {
		t.Fatalf("expected n2 deleted")
	}
	if edges, _ := docAfterDel["connections"].([]any); len(edges) != 0 {
		t.Fatalf("expected dangling edge e1 deleted, got %+v", edges)
	}

	// 5. No-op patches (empty or viewport-only) MUST NOT bump revision.
	revBeforeNoop := resDel.Summary.Revision
	noopEmpty, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: revBeforeNoop,
	})
	if err != nil {
		t.Fatalf("empty patch failed: %v", err)
	}
	if noopEmpty.Summary.Revision != revBeforeNoop {
		t.Fatalf("empty patch bumped revision %d -> %d", revBeforeNoop, noopEmpty.Summary.Revision)
	}
	noopViewport, err := svc.PatchUserCanvasDocument(owner, "patch-c1", DocumentPatch{
		BaseRevision: revBeforeNoop,
		Fields:       map[string]any{"viewport": map[string]any{"x": 999, "y": 999, "k": 2}},
	})
	if err != nil {
		t.Fatalf("viewport-only patch failed: %v", err)
	}
	if noopViewport.Summary.Revision != revBeforeNoop {
		t.Fatalf("viewport-only patch bumped revision %d -> %d", revBeforeNoop, noopViewport.Summary.Revision)
	}
}
