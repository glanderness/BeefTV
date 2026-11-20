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

func TestPatchUserCanvasDocument_ServerDeleteUpsertConnectionsChatsAndStaleSettledUpload(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	owner := "owner"

	nodeA := map[string]any{
		"id": "a1", "type": "text", "title": "节点A",
		"position": map[string]any{"x": float64(0), "y": float64(0)},
		"width":    float64(200), "height": float64(120),
		"metadata": map[string]any{"content": "a0", "status": "success"},
	}
	nodeB := map[string]any{
		"id": "b1", "type": "image", "title": "带旧上传标记的已结算图",
		"position": map[string]any{"x": float64(300), "y": float64(0)},
		"width":    float64(300), "height": float64(300),
		// Stale fileUpload:"uploading" left on an already-settled upload (mirrors hasStaleSettledFileUploadFlag).
		"metadata": map[string]any{
			"status":              "success",
			"content":             "https://example.com/settled-stale.png",
			"fileUpload":          "uploading",
			"fileUploadAttemptId": "up-stale-1",
			"resultOrigin":        "upload",
		},
	}
	edge1 := map[string]any{"id": "edge-1", "fromNodeId": "a1", "toNodeId": "b1", "label": "old"}
	chat1 := map[string]any{"id": "chat-1", "title": "会话1", "messages": []any{map[string]any{"id": "m1", "content": "hi"}}}

	initial := map[string]any{
		"id":           "patch-c2",
		"revision":     0,
		"title":        "边界测试",
		"nodes":        []any{nodeA, nodeB},
		"connections":  []any{edge1},
		"chatSessions": []any{chat1},
	}
	raw, _ := json.Marshal(initial)
	created, err := svc.UpsertUserCanvasProject(owner, raw)
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}

	// 1. Stale settled upload (status=success + media + stale fileUpload:"uploading") MUST be protected against an older empty uploading overlay.
	resStale, err := svc.PatchUserCanvasDocument(owner, "patch-c2", DocumentPatch{
		BaseRevision: created.Revision,
		UpsertNodes: []map[string]any{
			{
				"id": "b1", "type": "image", "title": "改了标题",
				"position": map[string]any{"x": float64(320), "y": float64(10)},
				"width":    float64(300), "height": float64(300),
				"metadata": map[string]any{"fileUpload": "uploading", "fileUploadAttemptId": "up-stale-1", "fileUploadProgress": 20},
			},
		},
	})
	if err != nil {
		t.Fatalf("stale settled upload patch failed: %v", err)
	}
	if !resStale.MediaPreserved {
		t.Fatalf("expected MediaPreserved=true for settled upload with stale fileUpload flag")
	}
	var docAfterStale map[string]any
	_ = json.Unmarshal(resStale.Document, &docAfterStale)
	gotB := findCanvasNode(docAfterStale, "b1")
	gotBMeta := nodeMetadata(gotB)
	if nodeString(gotB, "title") != "改了标题" ||
		nodeString(gotBMeta, "content") != "https://example.com/settled-stale.png" ||
		gotBMeta["fileUpload"] != nil {
		t.Fatalf("stale settled upload not preserved/cleaned: %+v", gotB)
	}

	// 2. Server deletes a1; client upserts a1 with ExpectedNodes["a1"] -> MUST capture before_merge snapshot!
	curRaw, _ := svc.UserCanvasProject(owner, "patch-c2")
	var curDoc map[string]any
	_ = json.Unmarshal(curRaw, &curDoc)
	curDoc["nodes"] = []any{gotB}
	curDoc["revision"] = resStale.Summary.Revision
	delRaw, _ := json.Marshal(curDoc)
	afterServerDel, _, err := svc.CommitUserCanvasDocument(owner, "patch-c2", resStale.Summary.Revision, delRaw)
	if err != nil {
		t.Fatalf("server delete a1: %v", err)
	}
	resRevive, err := svc.PatchUserCanvasDocument(owner, "patch-c2", DocumentPatch{
		BaseRevision: created.Revision,
		UpsertNodes: []map[string]any{
			{
				"id": "a1", "type": "text", "title": "本地改了A",
				"position": map[string]any{"x": float64(50), "y": float64(50)},
				"width":    float64(200), "height": float64(120),
				"metadata": map[string]any{"content": "a1-local", "status": "success"},
			},
		},
		ExpectedNodes: map[string]map[string]any{"a1": nodeA},
	})
	if err != nil {
		t.Fatalf("revive patch failed: %v", err)
	}
	if !resRevive.SnapshotCaptured {
		t.Fatalf("expected before_merge snapshot when upserting server-deleted node with ExpectedNodes")
	}
	histRevive, _ := svc.CanvasHistory(owner, "patch-c2")
	if len(histRevive.Snapshots) == 0 || histRevive.Snapshots[0].Reason != "before_merge" || histRevive.Snapshots[0].Revision != afterServerDel.Revision {
		t.Fatalf("expected before_merge snapshot at rev %d, got %+v", afterServerDel.Revision, histRevive.Snapshots)
	}

	// 3. Server edits edge-1 and chat-1; client concurrently updates them with ExpectedConnections/ExpectedChatSessions -> MUST capture before_merge!
	curRaw2, _ := svc.UserCanvasProject(owner, "patch-c2")
	var curDoc2 map[string]any
	_ = json.Unmarshal(curRaw2, &curDoc2)
	curDoc2["connections"] = []any{map[string]any{"id": "edge-1", "fromNodeId": "a1", "toNodeId": "b1", "label": "server-label"}}
	curDoc2["chatSessions"] = []any{map[string]any{"id": "chat-1", "title": "服务端会话", "messages": []any{map[string]any{"id": "m1", "content": "server"}}}}
	curDoc2["revision"] = resRevive.Summary.Revision
	mutRaw, _ := json.Marshal(curDoc2)
	afterServerMut, _, err := svc.CommitUserCanvasDocument(owner, "patch-c2", resRevive.Summary.Revision, mutRaw)
	if err != nil {
		t.Fatalf("server mutate edge/chat: %v", err)
	}
	resEdgeChat, err := svc.PatchUserCanvasDocument(owner, "patch-c2", DocumentPatch{
		BaseRevision:         created.Revision,
		UpsertConnections:    []map[string]any{{"id": "edge-1", "fromNodeId": "a1", "toNodeId": "b1", "label": "local-label"}},
		ExpectedConnections:  map[string]map[string]any{"edge-1": edge1},
		UpsertChatSessions:   []map[string]any{{"id": "chat-1", "title": "本地会话", "messages": []any{map[string]any{"id": "m1", "content": "local"}}}},
		ExpectedChatSessions: map[string]map[string]any{"chat-1": chat1},
	})
	if err != nil {
		t.Fatalf("edge/chat overlap patch failed: %v", err)
	}
	if !resEdgeChat.SnapshotCaptured {
		t.Fatalf("expected before_merge snapshot on overlapping connection/chatSession edit")
	}
	histEC, _ := svc.CanvasHistory(owner, "patch-c2")
	if len(histEC.Snapshots) == 0 || histEC.Snapshots[0].Reason != "before_merge" || histEC.Snapshots[0].Revision != afterServerMut.Revision {
		t.Fatalf("expected before_merge snapshot at rev %d, got %+v", afterServerMut.Revision, histEC.Snapshots)
	}
	fullECSnap, _ := svc.CanvasHistorySnapshot(owner, "patch-c2", histEC.Snapshots[0].ID)
	var ecSnapDoc map[string]any
	_ = json.Unmarshal([]byte(fullECSnap.PayloadJSON), &ecSnapDoc)
	snapChats, _ := ecSnapDoc["chatSessions"].([]any)
	if len(snapChats) != 1 || nodeString(snapChats[0].(map[string]any), "title") != "服务端会话" {
		t.Fatalf("before_merge snapshot lost server chat session, got %+v", snapChats)
	}

	// 4. Server adds a new dangling edge attached to b1; client deletes b1 knowing exact current b1 & edge-1 -> ONLY the unseen dangling edge triggers before_merge!
	curRaw3, _ := svc.UserCanvasProject(owner, "patch-c2")
	var curDoc3 map[string]any
	_ = json.Unmarshal(curRaw3, &curDoc3)
	exactB1 := cloneNode(findCanvasNode(curDoc3, "b1"))
	curDoc3["connections"] = []any{
		map[string]any{"id": "edge-1", "fromNodeId": "a1", "toNodeId": "b1", "label": "local-label"},
		map[string]any{"id": "edge-server-new", "fromNodeId": "b1", "toNodeId": "a1", "label": "agent-edge"},
	}
	curDoc3["revision"] = resEdgeChat.Summary.Revision
	edgeRaw3, _ := json.Marshal(curDoc3)
	afterAgentEdge, _, err := svc.CommitUserCanvasDocument(owner, "patch-c2", resEdgeChat.Summary.Revision, edgeRaw3)
	if err != nil {
		t.Fatalf("server add dangling edge: %v", err)
	}
	resDangling, err := svc.PatchUserCanvasDocument(owner, "patch-c2", DocumentPatch{
		BaseRevision:        resEdgeChat.Summary.Revision,
		DeleteNodeIDs:       []string{"b1"},
		DeleteConnectionIDs: []string{"edge-1"},
		ExpectedNodes:       map[string]map[string]any{"b1": exactB1},
		ExpectedConnections: map[string]map[string]any{"edge-1": {"id": "edge-1", "fromNodeId": "a1", "toNodeId": "b1", "label": "local-label"}},
	})
	if err != nil {
		t.Fatalf("dangling edge delete patch failed: %v", err)
	}
	if !resDangling.SnapshotCaptured {
		t.Fatalf("expected before_merge snapshot when node deletion drops a server-added dangling edge")
	}
	histDangling, _ := svc.CanvasHistory(owner, "patch-c2")
	if len(histDangling.Snapshots) == 0 || histDangling.Snapshots[0].Reason != "before_merge" || histDangling.Snapshots[0].Revision != afterAgentEdge.Revision {
		t.Fatalf("expected before_merge snapshot at rev %d, got %+v", afterAgentEdge.Revision, histDangling.Snapshots)
	}
	fullDanglingSnap, _ := svc.CanvasHistorySnapshot(owner, "patch-c2", histDangling.Snapshots[0].ID)
	var danglingSnapDoc map[string]any
	_ = json.Unmarshal([]byte(fullDanglingSnap.PayloadJSON), &danglingSnapDoc)
	snapConns, _ := danglingSnapDoc["connections"].([]any)
	foundAgentEdge := false
	for _, rawConn := range snapConns {
		if conn, ok := rawConn.(map[string]any); ok && nodeString(conn, "id") == "edge-server-new" {
			foundAgentEdge = true
			break
		}
	}
	if !foundAgentEdge {
		t.Fatalf("before_merge snapshot missing server-added dangling edge-server-new: %+v", snapConns)
	}
}

func TestPatchUserCanvasDocumentProtectsSettledMediaAgainstReplacementUploadPlaceholder(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	owner := "owner"

	initial := map[string]any{
		"id":       "patch-replace-upload",
		"revision": 0,
		"title":    "替换上传保护",
		"nodes": []any{
			map[string]any{
				"id":       "n-up",
				"type":     "image",
				"title":    "原图",
				"position": map[string]any{"x": 10, "y": 20},
				"metadata": map[string]any{
					"content":             "https://example.com/newer-settled.png",
					"storageKey":          "res-newer-settled",
					"status":              "success",
					"resultOrigin":        "upload",
					"fileUploadAttemptId": "up-1",
				},
			},
		},
		"connections":  []any{},
		"chatSessions": []any{},
	}
	raw, _ := json.Marshal(initial)
	created, err := svc.UpsertUserCanvasProject(owner, raw)
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}

	// Production applyInitialReplacementUploadPlaceholder shape:
	// keeps OLD content/storageKey, omits status (undefined), sets fileUpload="uploading" and a NEW attemptId.
	resPlaceholder, err := svc.PatchUserCanvasDocument(owner, "patch-replace-upload", DocumentPatch{
		BaseRevision: created.Revision,
		UpsertNodes: []map[string]any{
			{
				"id":       "n-up",
				"type":     "image",
				"title":    "用户改名",
				"position": map[string]any{"x": 220, "y": 330},
				"metadata": map[string]any{
					"content":             "https://example.com/old-stale.png",
					"storageKey":          "res-old-stale",
					"fileUpload":          "uploading",
					"fileUploadAttemptId": "up-replace-2",
					"resultOrigin":        "upload",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("replacement placeholder patch failed: %v", err)
	}
	if !resPlaceholder.MediaPreserved || !resPlaceholder.SnapshotCaptured {
		t.Fatalf("expected MediaPreserved=true & SnapshotCaptured=true, got %+v", resPlaceholder)
	}
	var gotDoc map[string]any
	if err := json.Unmarshal(resPlaceholder.Document, &gotDoc); err != nil {
		t.Fatalf("unmarshal placeholder doc: %v", err)
	}
	gotNode := findCanvasNode(gotDoc, "n-up")
	meta := nodeMetadata(gotNode)
	if nodeString(gotNode, "title") != "用户改名" {
		t.Fatalf("expected incoming title to apply, got %q", nodeString(gotNode, "title"))
	}
	pos, _ := gotNode["position"].(map[string]any)
	if pos["x"] != float64(220) || pos["y"] != float64(330) {
		t.Fatalf("expected incoming position to apply, got %+v", pos)
	}
	if nodeString(meta, "content") != "https://example.com/newer-settled.png" || nodeString(meta, "storageKey") != "res-newer-settled" {
		t.Fatalf("settled server media was overwritten by replacement placeholder: %+v", meta)
	}
	if _, hasFlag := meta["fileUpload"]; hasFlag {
		t.Fatalf("expected active fileUpload overlay to be stripped when preserving settled media: %+v", meta)
	}

	// An interrupted replacement upload overlay (fileUpload="error" + interruptedFileUploadMessage)
	// MUST also preserve settled server media rather than clobbering it with stale error overlay.
	resInterrupted, err := svc.PatchUserCanvasDocument(owner, "patch-replace-upload", DocumentPatch{
		BaseRevision: resPlaceholder.Summary.Revision,
		UpsertNodes: []map[string]any{
			{
				"id":       "n-up",
				"type":     "image",
				"title":    "中断后改名",
				"position": map[string]any{"x": 260, "y": 350},
				"metadata": map[string]any{
					"content":             "https://example.com/old-stale.png",
					"storageKey":          "res-old-stale",
					"fileUpload":          "error",
					"errorDetails":        interruptedFileUploadMessage,
					"fileUploadAttemptId": "up-replace-interrupted",
					"resultOrigin":        "upload",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("interrupted replacement placeholder patch failed: %v", err)
	}
	if !resInterrupted.MediaPreserved {
		t.Fatalf("expected MediaPreserved=true for interrupted replacement overlay, got %+v", resInterrupted)
	}
	var interruptedDoc map[string]any
	if err := json.Unmarshal(resInterrupted.Document, &interruptedDoc); err != nil {
		t.Fatalf("unmarshal interrupted doc: %v", err)
	}
	interruptedNode := findCanvasNode(interruptedDoc, "n-up")
	interruptedMeta := nodeMetadata(interruptedNode)
	if nodeString(interruptedNode, "title") != "中断后改名" ||
		nodeString(interruptedMeta, "content") != "https://example.com/newer-settled.png" ||
		interruptedMeta["fileUpload"] != nil ||
		interruptedMeta["errorDetails"] != nil {
		t.Fatalf("interrupted replacement overlay corrupted settled media: %+v", interruptedNode)
	}

	// Once the replacement upload settles (drops fileUpload, sets status="success" and new media), it commits cleanly.
	resSettled, err := svc.PatchUserCanvasDocument(owner, "patch-replace-upload", DocumentPatch{
		BaseRevision: resInterrupted.Summary.Revision,
		UpsertNodes: []map[string]any{
			{
				"id":       "n-up",
				"type":     "image",
				"title":    "用户改名",
				"position": map[string]any{"x": 220, "y": 330},
				"metadata": map[string]any{
					"content":             "https://example.com/final-replaced.png",
					"storageKey":          "res-final-replaced",
					"status":              "success",
					"fileUploadAttemptId": "up-replace-2",
					"resultOrigin":        "upload",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("settled replacement patch failed: %v", err)
	}
	if resSettled.MediaPreserved {
		t.Fatalf("settled replacement upload should commit cleanly without MediaPreserved")
	}
	finalRaw, _ := svc.UserCanvasProject(owner, "patch-replace-upload")
	var finalDoc map[string]any
	if err := json.Unmarshal(finalRaw, &finalDoc); err != nil {
		t.Fatalf("unmarshal final doc: %v", err)
	}
	finalMeta := nodeMetadata(findCanvasNode(finalDoc, "n-up"))
	if nodeString(finalMeta, "content") != "https://example.com/final-replaced.png" || nodeString(finalMeta, "fileUploadAttemptId") != "up-replace-2" {
		t.Fatalf("expected final settled replacement media, got %+v", finalMeta)
	}
}
