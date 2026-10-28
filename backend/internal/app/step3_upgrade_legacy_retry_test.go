package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// P2b: on an upgraded v26 database, legacy /retry (no operation id) of an
// ordinary failed image task without any receipt. Baseline requeues it.
func TestReviewUpgradedDatabaseLegacyImageRetry(t *testing.T) {
	source := os.Getenv("REVIEW_V26_DB")
	if source == "" {
		t.Skip("REVIEW_V26_DB not set")
	}
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "upgraded.db")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), dir)
	defer svc.Close()
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "upgraded-image", UserID: owner.ID, Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "任务失败", Error: "请求过于频繁",
		InputJSON: `{"mode":"image","prompt":"p","config":{"channelId":"channel","model":"img"}}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, handled, recoverErr := svc.recoverAcceptedImage(task)
	t.Logf("recoverAcceptedImage handled=%v err=%v", handled, recoverErr)
	retried, err := svc.RetryTask(owner.ID, task.ID)
	t.Logf("legacy RetryTask: task=%v err=%v", retried != nil, err)
	if handled && recoverErr != nil {
		t.Errorf("failed image without receipt is captured by job lookup error on upgraded database: %v", recoverErr)
	}
}
