package repository

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
)

func TestRepositoryNotifiesTaskChangedOnTerminalWritesAndDelivery(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "notify.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	repo.SetSingleProcess(true)

	var mu sync.Mutex
	var notified []string
	repo.SetOnTaskChanged(func(taskID string) {
		mu.Lock()
		notified = append(notified, taskID)
		mu.Unlock()
	})

	now := time.Now().UTC()
	for _, id := range []string{"t-complete", "t-fail", "t-cancel"} {
		row := model.Task{
			ID:        id,
			UserID:    "u1",
			ProjectID: "p1",
			Type:      "canvas_image",
			Status:    model.TaskStatusRunning,
			InputJSON: `{}`,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}

	doneTask := model.Task{
		ID:          "t-complete",
		Status:      model.TaskStatusSucceeded,
		Stage:       "完成",
		Progress:    100,
		ResultJSON:  `{"text":"ok"}`,
		CompletedAt: &now,
		UpdatedAt:   now,
	}
	if err := repo.SaveTaskCompletion(&doneTask, model.TaskStatusRunning, nil); err != nil {
		t.Fatalf("SaveTaskCompletion: %v", err)
	}
	if updated, err := repo.UpdateTaskTerminalState("t-fail", "", model.TaskStatusRunning, model.TaskStatusFailed, "失败", "err", "provider_error", now); err != nil || !updated {
		t.Fatalf("UpdateTaskTerminalState: updated=%v err=%v", updated, err)
	}
	if cancelled, err := repo.CancelTaskIfStatus("u1", "t-cancel", model.TaskStatusRunning, now); err != nil || !cancelled {
		t.Fatalf("CancelTaskIfStatus: cancelled=%v err=%v", cancelled, err)
	}
	if err := repo.UpsertGenerationDelivery([]GenerationDeliveryItem{{
		Result: model.Result{
			ID:        "res-deliv-1",
			UserID:    "u1",
			TaskID:    "t-complete",
			Kind:      generationOutputResultKind,
			Payload:   `{"resourceId":"r-1"}`,
			CreatedAt: now,
		},
	}}); err != nil {
		t.Fatalf("UpsertGenerationDelivery: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	want := []string{"t-complete", "t-fail", "t-cancel", "t-complete"}
	if len(notified) != len(want) {
		t.Fatalf("notified=%v, want %v", notified, want)
	}
	for i := range want {
		if notified[i] != want[i] {
			t.Fatalf("notified[%d]=%q, want %q (all=%v)", i, notified[i], want[i], notified)
		}
	}
}
