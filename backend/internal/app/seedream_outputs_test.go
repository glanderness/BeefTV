package app

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
)

func TestSeedreamDeliveryRecoversAllOutputsWithoutResubmitting(t *testing.T) {
	svc, canvasID, revision := newAssistantTurnService(t)
	db := svc.repo.DB()
	task := model.Task{ID: "seedream-paid", UserID: "local", ProjectID: canvasID, Type: "canvas_image", Model: "channel::dola-seedream-5-0-pro-260628", Status: model.TaskStatusSucceeded,
		InputJSON: `{"metadata":{"nodeId":"root"}}`, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	images := []map[string]any{}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("seedream-resource-%d", i)
		if err := db.Create(&model.Resource{ID: id, UserID: "local", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady, Width: 512, Height: 512, Size: 100}).Error; err != nil {
			t.Fatal(err)
		}
		images = append(images, map[string]any{"resourceId": id, "storageKey": "resource:" + id})
	}
	result, _ := json.Marshal(map[string]any{"images": images, "imageLayers": []any{map[string]any{"imageIndex": 1, "name": "Plant", "z_index": 1, "bounding_box": map[string]any{"absolute": []int{1, 2, 3, 4}}}}})
	task.ResultJSON = string(result)
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"id": canvasID, "title": "Seedream", "revision": revision,
		"nodes": []any{
			map[string]any{"id": "source", "type": "image", "position": map[string]any{"x": 0, "y": 0}},
			map[string]any{"id": "root", "type": "image", "position": map[string]any{"x": 440, "y": 0},
				"metadata": map[string]any{"taskId": task.ID, "seedreamMode": "layers", "content": "previous-last-output"}},
		},
		"connections": []any{map[string]any{"id": "source-link", "fromNodeId": "source", "toNodeId": "root"}},
	})
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	read := func(s *Service) map[string]any {
		t.Helper()
		raw, err := s.UserCanvasProject("local", canvasID)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		return doc
	}
	doc := read(svc)
	nodes := doc["nodes"].([]any)
	if len(nodes) != 4 {
		t.Fatalf("got %d nodes, want source and all three outputs", len(nodes))
	}
	edges := doc["connections"].([]any)
	if len(edges) != 3 {
		t.Fatalf("got %d edges, want one per layer output", len(edges))
	}
	for i, rawNode := range nodes[1:] {
		node := rawNode.(map[string]any)
		meta := node["metadata"].(map[string]any)
		if node["id"] != localtask.SeedreamOutputNodeID(task, i) || meta["storageKey"] != fmt.Sprintf("resource:seedream-resource-%d", i) || meta["taskOutputIndex"] != float64(i) {
			t.Fatalf("output %d bound incorrectly: %#v", i, node)
		}
		if i == 1 && (node["title"] != "Plant" || meta["imageLayer"] == nil) {
			t.Fatal("layer metadata lost")
		}
		edge := edges[i].(map[string]any)
		if edge["fromNodeId"] != "source" || edge["toNodeId"] != node["id"] {
			t.Fatalf("output %d not connected to original image: %v", i, edge)
		}
	}
	// A new service has no in-memory effect registry. Recovery must rely on the
	// persisted identities and never need an upstream HTTP client.
	restarted := NewLocal(repository.New(db), svc.dataDir)
	if err := restarted.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	if got := read(restarted); got["revision"] != doc["revision"] || len(got["nodes"].([]any)) != 4 {
		t.Fatal("restart duplicated or rewrote delivered outputs")
	}
	doc["nodes"] = []any{nodes[0], nodes[1], nodes[3]}
	doc["connections"] = []any{edges[0], edges[2]}
	deleted, _ := json.Marshal(doc)
	if _, err := restarted.UpsertUserCanvasProject("local", deleted); err != nil {
		t.Fatal(err)
	}
	if err := restarted.recoverCanvasTaskBindings(task); err != nil {
		t.Fatal(err)
	}
	if got := read(restarted); len(got["nodes"].([]any)) != 3 || len(got["connections"].([]any)) != 2 {
		t.Fatal("deleted output or edge resurrected")
	}
}
