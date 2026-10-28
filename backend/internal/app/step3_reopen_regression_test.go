package app

import (
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestStep3PaidRetryReplayAfterDatabaseReopenAndNewRun(t *testing.T) {
	dir := t.TempDir()
	svc, db := openDBRuntimeMatrix(t, dir)
	task := model.Task{ID: "reopen-paid", UserID: "local", Type: "canvas_text", Status: model.TaskStatusFailed, Stage: "任务失败", Error: "请求过于频繁", RouteRun: 3, InputJSON: `{"mode":"text"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	first, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "first-op")
	if err != nil {
		t.Fatal(err)
	}
	if first.RouteRun != 4 {
		t.Fatalf("first run=%d", first.RouteRun)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": "failed", "stage": "任务失败", "error": "请求过于频繁"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "next-op"); err != nil {
		t.Fatal(err)
	}
	closeDBRuntimeMatrix(t, svc, db)
	restarted, reopened := openDBRuntimeMatrix(t, dir)
	defer closeDBRuntimeMatrix(t, restarted, reopened)
	replayed, err := restarted.RetryTaskWithOperation(task.UserID, task.ID, "first-op")
	if err != nil {
		t.Fatal(err)
	}
	if replayed.RouteRun != 5 || replayed.RetryOperation == nil || replayed.RetryOperation.OriginalRouteRun != 3 || replayed.RetryOperation.AcceptedRouteRun != 4 || replayed.Outcome == nil || replayed.Outcome.Phase != "running" {
		t.Fatalf("original identity and current projection lost after reopen: %+v", replayed)
	}
}
