package repository

import (
	"errors"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestTaskLeaseFencesExpiredAndReclaimedWriters(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.Result{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "task", UserID: "user", Status: model.TaskStatusQueued}).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	old, err := repo.ClaimNextTask("worker:attempt-a", time.Minute)
	if err != nil || old == nil {
		t.Fatalf("claim: %v %v", old, err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", old.ID).Update("lease_expires_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.RenewTaskLease(old.ID, old.LeaseOwner, time.Minute); !errors.Is(err, ErrTaskLeaseLost) {
		t.Fatalf("expired owner resurrected or wrong error: %v", err)
	}
	if err := repo.DeferRunningTaskForProviderPoll(old.ID, old.LeaseOwner, "poll", time.Minute); !errors.Is(err, ErrTaskStateConflict) {
		t.Fatalf("expired owner deferred task: %v", err)
	}
	current, err := repo.ClaimNextTask("worker:attempt-b", time.Minute)
	if err != nil || current == nil {
		t.Fatalf("reclaim: %v %v", current, err)
	}
	for _, owner := range []string{old.LeaseOwner, ""} {
		if err := repo.UpdateTaskProgressForLease(old.ID, owner, "stale", 90); !errors.Is(err, ErrTaskStateConflict) {
			t.Fatalf("stale progress: %v", err)
		}
		updated, err := repo.UpdateTaskTerminalState(old.ID, owner, model.TaskStatusRunning, model.TaskStatusFailed, "stale", "", "", time.Now())
		if err != nil || updated {
			t.Fatalf("stale terminal: %v %v", updated, err)
		}
	}
	old.Status = model.TaskStatusSucceeded
	if err := repo.SaveTaskCompletion(old, model.TaskStatusRunning, []model.Result{{ID: "stale"}}); !errors.Is(err, ErrTaskStateConflict) {
		t.Fatalf("stale completion: %v", err)
	}
	var count int64
	for _, table := range []any{&model.Result{}} {
		if err := db.Model(table).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("stale related row persisted: %d %v", count, err)
		}
	}
	if err := repo.RenewTaskLease(current.ID, current.LeaseOwner, time.Minute); err != nil {
		t.Fatal(err)
	}
	renewed, err := repo.Task(current.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateTaskProgressForLease(current.ID, current.LeaseOwner, "current", 60); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", current.ID).Updates(map[string]any{
		"provider_request_id": "provider-receipt", "provider_cancel_attempts": 3, "route_run": 2,
	}).Error; err != nil {
		t.Fatal(err)
	}
	current.Status = model.TaskStatusSucceeded
	if err := repo.SaveTaskCompletion(current, model.TaskStatusRunning, []model.Result{{ID: "valid", TaskID: current.ID}}); err != nil {
		t.Fatal(err)
	}
	stored, err := repo.Task(current.ID)
	if err != nil || stored.Status != model.TaskStatusSucceeded || stored.LeaseOwner != current.LeaseOwner {
		t.Fatalf("current completion: %v %v", stored, err)
	}
	if stored.LeaseExpiresAt == nil || !stored.LeaseExpiresAt.Equal(*renewed.LeaseExpiresAt) {
		t.Fatal("completion overwrote the renewed lease with the original claim expiry")
	}
	if stored.ProviderRequestID != "provider-receipt" || stored.ProviderCancelAttempts != 3 || stored.RouteRun != 2 {
		t.Fatal("completion overwrote independently updated runtime fields")
	}
}

func TestReacquireTaskLeaseAndClaimExclusion(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.Result{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := db.Create(&model.Task{ID: "task-a", UserID: "user", Status: model.TaskStatusQueued, CreatedAt: now.Add(-2 * time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "task-b", UserID: "user", Status: model.TaskStatusQueued, CreatedAt: now.Add(-time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)

	claimedA, err := repo.ClaimNextTask("owner-a", time.Minute)
	if err != nil || claimedA == nil || claimedA.ID != "task-a" {
		t.Fatalf("claim task-a: %+v %v", claimedA, err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", claimedA.ID).Update("lease_expires_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}

	// Excluding active task-a must leave its owner untouched and claim task-b.
	claimedB, err := repo.ClaimNextTask("owner-b", time.Minute, claimedA.ID)
	if err != nil || claimedB == nil || claimedB.ID != "task-b" {
		t.Fatalf("claim excluding task-a: %+v %v", claimedB, err)
	}

	// Owner-fenced re-acquisition refreshes expired lease when status=running & owner matches.
	if err := repo.ReacquireTaskLease(claimedA.ID, claimedA.LeaseOwner, time.Minute); err != nil {
		t.Fatalf("reacquire expired own lease: %v", err)
	}
	storedA, err := repo.Task(claimedA.ID)
	if err != nil || storedA.LeaseExpiresAt == nil || !storedA.LeaseExpiresAt.After(time.Now()) {
		t.Fatalf("reacquired lease not extended: %+v %v", storedA, err)
	}

	// Changed owner must still fail with ErrTaskLeaseLost.
	if err := repo.ReacquireTaskLease(claimedA.ID, "other-owner", time.Minute); !errors.Is(err, ErrTaskLeaseLost) {
		t.Fatalf("wrong owner reacquire err = %v, want ErrTaskLeaseLost", err)
	}

	// Non-running status must still fail with ErrTaskLeaseLost.
	if err := db.Model(&model.Task{}).Where("id = ?", claimedA.ID).Update("status", model.TaskStatusCancelled).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.ReacquireTaskLease(claimedA.ID, claimedA.LeaseOwner, time.Minute); !errors.Is(err, ErrTaskLeaseLost) {
		t.Fatalf("cancelled task reacquire err = %v, want ErrTaskLeaseLost", err)
	}
}
