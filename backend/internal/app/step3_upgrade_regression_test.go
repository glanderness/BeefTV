package app

// Independent review probes for generation-task step 3 (candidate 6d4d1373).

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

// P2: a v26 workspace database created by the baseline program, upgraded by
// the candidate. New ApiCallLog columns must exist and outcome facts must
// stay readable.
func TestReviewUpgradedV26DatabaseKeepsLogsAndOutcomeReadable(t *testing.T) {
	testStep3UpgradedDatabase(t, "REVIEW_V26_DB")
}

func TestStep3UpgradedV27KeepsLogsAndOutcomeReadable(t *testing.T) {
	testStep3UpgradedDatabase(t, "REVIEW_V27_DB")
}

func testStep3UpgradedDatabase(t *testing.T, fixture string) {
	source := os.Getenv(fixture)
	if source == "" {
		t.Skip(fixture + " not set")
	}
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "upgraded.db")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	for _, column := range []string{"route_run", "usage_state", "billing_state", "usage_state_present", "billing_state_present", "image_job_id"} {
		if !db.Migrator().HasColumn(&model.ApiCallLog{}, column) {
			t.Errorf("upgraded api_call_logs missing column %s", column)
		}
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	defer svc.Close()
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	task := model.Task{ID: "upgraded-task", UserID: owner.ID, Type: "canvas_video", Status: model.TaskStatusFailed, InputJSON: `{}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.LogAPICall(model.ApiCallLog{UserID: owner.ID, TaskID: task.ID, Source: "beefapi", Capability: "video", RequestKind: "create", Method: "POST", UsageState: "failed", UsageStatePresent: true}); err != nil {
		t.Errorf("LogAPICall on upgraded database: %v", err)
	}
	facts := svc.taskOutcomeFacts([]model.Task{task})
	if facts[task.ID].Unreadable {
		t.Errorf("outcome facts unreadable on upgraded database (every failed task projection degrades)")
	}
}
