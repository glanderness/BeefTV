package app

import (
	"context"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCancelTaskCancelsRunningTask(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	startedAt := time.Now()
	task := model.Task{
		ID:        "running-task",
		UserID:    "user-1",
		Status:    model.TaskStatusRunning,
		Stage:     "调用生成模型",
		StartedAt: &startedAt,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	svc := &Service{repo: repository.New(db)}
	cancelled, err := svc.CancelTask(context.Background(), task.UserID, task.ID)
	if err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
	if cancelled.Status != model.TaskStatusCancelled {
		t.Fatalf("CancelTask() status = %s, want cancelled", cancelled.Status)
	}

	stored, err := svc.repo.TaskForUser(task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusCancelled || stored.CompletedAt == nil {
		t.Fatalf("running task was not cancelled: status=%s completedAt=%v", stored.Status, stored.CompletedAt)
	}
}

func TestCancelTaskCancelsQueuedTask(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "queued-task", UserID: "user-1", Status: model.TaskStatusQueued, Stage: "等待队列调度"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	svc := &Service{repo: repository.New(db)}
	cancelled, err := svc.CancelTask(context.Background(), task.UserID, task.ID)
	if err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
	if cancelled.Status != model.TaskStatusCancelled {
		t.Fatalf("CancelTask() status = %s, want cancelled", cancelled.Status)
	}

	storedTask, err := svc.repo.TaskForUser(task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if storedTask.Status != model.TaskStatusCancelled || storedTask.CompletedAt == nil {
		t.Fatalf("queued task was not cancelled: status=%s completedAt=%v", storedTask.Status, storedTask.CompletedAt)
	}
}

func TestCancelTaskLocalModeCancelsQueuedTask(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "local-queued-task", UserID: "local-user", Status: model.TaskStatusQueued}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}

	svc := &Service{
		repo: repository.New(db),
	}
	if _, err := svc.CancelTask(context.Background(), task.UserID, task.ID); err != nil {
		t.Fatalf("CancelTask() error = %v", err)
	}
}

func TestCancelTaskStopsRetrievableFailedTaskAndRejectsNonRetrievable(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.Result{}, &model.RouteAttempt{}, &model.ImageSubmission{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	svc := &Service{repo: repo}

	// 1. Failed video task with ProviderRequestID (provider_result_pending) -> recovery_stopped, stays retrievable, skipped by background recovery, resumed by manual ResetTaskRecoveryBackoff
	videoTask := model.Task{
		ID:                "submitted-video-task",
		UserID:            "user-1",
		Type:              "canvas_video",
		Status:            model.TaskStatusFailed,
		Stage:             "轮询视频结果",
		ProviderRequestID: "provider-request-1",
	}
	if err := db.Create(&videoTask).Error; err != nil {
		t.Fatal(err)
	}
	stoppedVideo, err := svc.CancelTask(context.Background(), videoTask.UserID, videoTask.ID)
	if err != nil {
		t.Fatalf("CancelTask(retrievable video) error = %v", err)
	}
	if stoppedVideo.Status != model.TaskStatusFailed || stoppedVideo.Stage != model.TaskStageRecoveryStopped {
		t.Fatalf("stopped video = status=%s stage=%s, want failed/recovery_stopped", stoppedVideo.Status, stoppedVideo.Stage)
	}
	if stoppedVideo.Outcome == nil || stoppedVideo.Outcome.Phase != "retrievable" {
		t.Fatalf("stopped video outcome = %+v, want retrievable", stoppedVideo.Outcome)
	}
	if candidates, err := repo.FailedVideosForRecovery("", 10); err != nil || len(candidates) != 0 {
		t.Fatalf("background video recovery must skip recovery_stopped, got %d err=%v", len(candidates), err)
	}

	// 2. Failed image task with submission_unknown (image_recovery_pending) -> recovery_stopped, stays retrievable, skipped by background recovery, resumed by manual backoff reset
	imageTask := model.Task{
		ID:     "submitted-image-task",
		UserID: "user-1",
		Type:   "canvas_image",
		Status: model.TaskStatusFailed,
		Stage:  "submission_unknown",
	}
	if err := db.Create(&imageTask).Error; err != nil {
		t.Fatal(err)
	}
	stoppedImage, err := svc.CancelTask(context.Background(), imageTask.UserID, imageTask.ID)
	if err != nil {
		t.Fatalf("CancelTask(retrievable image) error = %v", err)
	}
	if stoppedImage.Status != model.TaskStatusFailed || stoppedImage.Stage != model.TaskStageRecoveryStopped {
		t.Fatalf("stopped image = status=%s stage=%s, want failed/recovery_stopped", stoppedImage.Status, stoppedImage.Stage)
	}
	if stoppedImage.Outcome == nil || stoppedImage.Outcome.Phase != "retrievable" || stoppedImage.Outcome.Reason != "image_recovery_pending" {
		t.Fatalf("stopped image outcome = %+v, want retrievable/image_recovery_pending", stoppedImage.Outcome)
	}
	if candidates, err := repo.FailedImagesForRecovery("", 10); err != nil || len(candidates) != 0 {
		t.Fatalf("background image recovery must skip recovery_stopped, got %d err=%v", len(candidates), err)
	}

	// Manual resume (ResetTaskRecoveryBackoff invoked by RecoverTask) clears recovery_stopped and re-enables polling.
	if err := repo.ResetTaskRecoveryBackoff(videoTask.UserID, videoTask.ID); err != nil {
		t.Fatalf("ResetTaskRecoveryBackoff(video) error = %v", err)
	}
	if err := repo.ResetTaskRecoveryBackoff(imageTask.UserID, imageTask.ID); err != nil {
		t.Fatalf("ResetTaskRecoveryBackoff(image) error = %v", err)
	}
	if candidates, err := repo.FailedVideosForRecovery("", 10); err != nil || len(candidates) != 1 || candidates[0].ID != videoTask.ID {
		t.Fatalf("manual resume should re-enable video recovery, got %+v err=%v", candidates, err)
	}
	if candidates, err := repo.FailedImagesForRecovery("", 10); err != nil || len(candidates) != 1 || candidates[0].ID != imageTask.ID {
		t.Fatalf("manual resume should re-enable image recovery, got %+v err=%v", candidates, err)
	}

	// 3. Non-retrievable failed task is still rejected.
	noResult := "no_result"
	terminalTask := model.Task{
		ID:              "terminal-failed-task",
		UserID:          "user-1",
		Type:            "canvas_video",
		Status:          model.TaskStatusFailed,
		Stage:           "任务失败",
		RecoveryOutcome: &noResult,
	}
	if err := db.Create(&terminalTask).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CancelTask(context.Background(), terminalTask.UserID, terminalTask.ID); err == nil || err.Error() != "任务当前状态为 failed，无法取消" {
		t.Fatalf("CancelTask(terminal failed) error = %v", err)
	}
	stored, err := svc.repo.TaskForUser(videoTask.UserID, videoTask.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusFailed || stored.ProviderRequestID != videoTask.ProviderRequestID {
		t.Fatalf("submitted task changed after stop/resume: status=%s providerRequestId=%q", stored.Status, stored.ProviderRequestID)
	}
}
