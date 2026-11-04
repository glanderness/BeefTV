package canvas

import (
	"encoding/json"
	"fmt"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestWorkflowExpandedOutputsAndPrimaryChangesCanBeSavedAndReloaded(t *testing.T) {
	s := newCanvasHistoryTestService(t)
	media := []struct{ id, kind string }{{"video-a", "video"}, {"image", "image"}, {"video-b", "video"}, {"audio", "audio"}}
	for _, item := range media {
		resource := model.Resource{ID: item.id, UserID: "owner", Status: model.ResourceStatusReady, Kind: item.kind, Provider: "local", ObjectKey: "users/owner/" + item.kind + "/" + item.id}
		if err := s.repo.CreateResource(&resource); err != nil {
			t.Fatal(err)
		}
		payload := json.RawMessage(fmt.Sprintf(`{"id":"asset-%s","kind":"%s","title":"生成结果","coverUrl":"","tags":[],"status":"confirmed","source":"生成任务","data":{"storageKey":"resource:%s","width":320,"height":180,"bytes":3,"mimeType":"%s/test","durationMs":5000}}`, item.id, item.kind, item.id, item.kind))
		if _, err := s.UpsertUserAsset("owner", payload); err != nil {
			t.Fatal(err)
		}
	}
	nodes := []any{}
	for index, item := range media {
		metadata := map[string]any{"assetId": "asset-" + item.id, "storageKey": "resource:" + item.id, "content": "/api/resources/" + item.id + "/file", "status": "success"}
		if index == 0 {
			metadata["taskId"] = "original-task"
			metadata["generationOutputTaskId"] = "original-task"
		} else {
			metadata["generatedFromNodeId"] = "source"
		}
		nodes = append(nodes, map[string]any{"id": fmt.Sprintf("output-%d", index), "type": item.kind, "metadata": metadata})
	}
	broken := nodes[1].(map[string]any)["metadata"].(map[string]any)
	delete(broken, "assetId")
	raw, _ := json.Marshal(map[string]any{"id": "workflow-canvas", "revision": 0, "title": "结果画布", "nodes": nodes, "connections": []any{}})
	if _, err := s.UpsertUserCanvasProject("owner", raw); err == nil {
		t.Fatal("resource-only output node bypassed the canvas asset guard")
	}
	broken["assetId"] = "asset-image"
	var revision int64
	// 普通 document commit 必须保留每个输出的素材配对，也允许重复切换主输出。
	for _, id := range []string{"video-a", "video-b", "video-a"} {
		primary := nodes[0].(map[string]any)["metadata"].(map[string]any)
		primary["assetId"], primary["storageKey"], primary["content"] = "asset-"+id, "resource:"+id, "/api/resources/"+id+"/file"
		raw, _ := json.Marshal(map[string]any{"id": "workflow-canvas", "revision": revision, "title": "结果画布", "nodes": nodes, "connections": []any{}})
		saved, err := s.UpsertUserCanvasProject("owner", raw)
		if err != nil {
			t.Fatal(err)
		}
		revision = saved.Revision
		stored, err := s.UserCanvasProject("owner", "workflow-canvas")
		if err != nil {
			t.Fatal(err)
		}
		if err := s.ValidateCanvasMediaAssets("owner", stored); err != nil {
			t.Fatalf("saved canvas lost materialized output binding: %v", err)
		}
		var document struct {
			Nodes []struct{ Metadata map[string]any }
		}
		if err := json.Unmarshal(stored, &document); err != nil || len(document.Nodes) != 4 || document.Nodes[0].Metadata["assetId"] != "asset-"+id {
			t.Fatalf("reload = %s, err=%v", stored, err)
		}
	}
}
