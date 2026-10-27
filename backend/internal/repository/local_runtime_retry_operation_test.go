package repository

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestRetryOperationReceiptIsIdempotentAndAbortable(t *testing.T) {
	repo, _ := newAdmissionRepo(t)
	if err := repo.BeginRetryOperation("user-1", "op-1", "hash-1"); err != nil {
		t.Fatal(err)
	}
	if err := repo.BeginRetryOperation("user-1", "op-1", "hash-1"); !errors.Is(err, ErrRetryOperationInProgress) {
		t.Fatalf("second begin = %v", err)
	}
	if err := repo.BeginRetryOperation("user-1", "op-1", "hash-other"); !errors.Is(err, ErrRetryOperationConflict) {
		t.Fatalf("conflicting begin = %v", err)
	}

	accepted := &model.Task{ID: "task-1", UserID: "user-1", RouteRun: 2, Status: model.TaskStatusQueued, Type: "canvas_image"}
	if err := repo.CompleteRetryOperation("user-1", "op-1", "hash-1", "free_recovery", accepted); err != nil {
		t.Fatal(err)
	}
	replayed, found, err := repo.RetryOperationResult("user-1", "op-1", "hash-1")
	if err != nil || !found || replayed.ID != accepted.ID || replayed.RouteRun != accepted.RouteRun {
		t.Fatalf("replay = %+v found=%v err=%v", replayed, found, err)
	}
	if _, _, err := repo.RetryOperationResult("user-1", "op-1", "hash-other"); !errors.Is(err, ErrRetryOperationConflict) {
		t.Fatalf("conflicting replay = %v", err)
	}

	if err := repo.BeginRetryOperation("user-1", "op-2", "hash-2"); err != nil {
		t.Fatal(err)
	}
	if err := repo.AbortRetryOperation("user-1", "op-2", "hash-2"); err != nil {
		t.Fatal(err)
	}
	if err := repo.BeginRetryOperation("user-1", "op-2", "hash-2"); err != nil {
		t.Fatalf("begin after abort = %v", err)
	}
}
