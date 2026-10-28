package app

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestStep3FreeReplayReadsCurrentTask(t *testing.T) {
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	now := time.Now()
	task := model.Task{ID: "free-current", UserID: "local", Type: "canvas_image", Status: model.TaskStatusSucceeded, Stage: "delivery_paused", RouteRun: 3, ResultJSON: `{"images":[]}`, InputJSON: `{}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "op-current"); err != nil {
		t.Fatal(err)
	}
	// Simulate the existing delivery worker finishing after the admission response.
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"stage": "任务完成", "progress": 100}).Error; err != nil {
		t.Fatal(err)
	}
	replayed, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "op-current")
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Stage != "任务完成" || replayed.Progress != 100 {
		t.Fatalf("replay returned stale task: stage=%q progress=%d", replayed.Stage, replayed.Progress)
	}
}
