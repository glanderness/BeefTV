package repository

import (
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestFreeRetryAdmissionIsAtomicAndReplaysCurrentTask(t *testing.T) {
	repo, db := newAdmissionRepo(t)
	paused := model.Task{ID: "free", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded, Stage: "delivery_paused", RouteRun: 3}
	if err := db.Create(&paused).Error; err != nil {
		t.Fatal(err)
	}
	first, _, err := repo.AdmitFreeRetry(paused.UserID, "free-op", "free-hash", paused)
	if err != nil {
		t.Fatal(err)
	}
	if first.Stage != "正在取回结果" || first.RetryOperation == nil || first.RetryOperation.OriginalRouteRun != 3 || first.RetryOperation.AcceptedRouteRun != 3 {
		t.Fatalf("admission=%+v", first)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", paused.ID).Updates(map[string]any{"stage": "任务完成", "progress": 100}).Error; err != nil {
		t.Fatal(err)
	}
	replayed, found, err := repo.RetryOperationForTask(paused.UserID, "free-op", paused.ID)
	if err != nil || !found || replayed.Stage != "任务完成" || replayed.Progress != 100 {
		t.Fatalf("replay=%+v found=%v err=%v", replayed, found, err)
	}
}
