package taskruntime

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func openTaskLeaseTestDB(t *testing.T, singleProcess bool) (*gorm.DB, *repository.Repository) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := db.AutoMigrate(&model.Task{}, &model.Result{}); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	repo.SetSingleProcess(singleProcess)
	return db, repo
}

// TestSingleProcessPreRenewalExpiredLeaseNoDoubleClaimAndCompletionSucceeds uses a long
// RenewInterval so NO renewal tick fires after sleep/wake:
// (a) Dispatch while lease_expires_at is genuinely expired must NOT double-claim the active task.
// (b) SaveTaskCompletion while lease_expires_at is STILL expired must succeed via single-process owner fencing.
func TestSingleProcessPreRenewalExpiredLeaseNoDoubleClaimAndCompletionSucceeds(t *testing.T) {
	db, repo := openTaskLeaseTestDB(t, true)
	if err := db.Create(&model.Task{
		ID:     "pre-renew-task",
		UserID: "user",
		Type:   "canvas_image",
		Status: model.TaskStatusQueued,
	}).Error; err != nil {
		t.Fatal(err)
	}

	coord := platform.NewLocalCoordinator()
	entered := make(chan string, 1)
	proceed := make(chan struct{})
	completed := make(chan Outcome, 1)
	var executes atomic.Int32

	exec := fnExec(func(session Session) Outcome {
		executes.Add(1)
		task := session.Task()
		select {
		case entered <- task.LeaseOwner:
		default:
		}
		select {
		case <-proceed:
		case <-session.Context().Done():
			out := Outcome{Kind: KindLeaseLost, Err: session.LostErr(), ProviderAccepted: true}
			completed <- out
			return out
		}
		if session.Lost() {
			out := Outcome{Kind: KindLeaseLost, Err: session.LostErr(), ProviderAccepted: true}
			completed <- out
			return out
		}
		task.Status = model.TaskStatusSucceeded
		task.Stage = "任务完成"
		task.Progress = 100
		now := time.Now()
		task.CompletedAt = &now
		task.UpdatedAt = now
		if err := repo.SaveTaskCompletion(task, model.TaskStatusRunning, []model.Result{
			{ID: "res-pre-renew", TaskID: task.ID, UserID: task.UserID},
		}); err != nil {
			out := Outcome{Kind: KindFailed, Err: err}
			completed <- out
			return out
		}
		out := Outcome{Kind: KindCompleted, Applied: true, ProviderAccepted: true}
		completed <- out
		return out
	})

	rt := testRuntime(t, Deps{
		Repository:  NewRepositoryAdapter(repo, true),
		Coordinator: NewSlotCoordinatorAdapter(coord, true),
		Policy:      staticPolicy{n: 2, timeout: time.Minute},
		Executor:    exec,
		Config: Config{
			SingleProcess: true,
			SlotTTL:       time.Minute,
			TaskLeaseTTL:  time.Minute,
			RenewInterval: 10 * time.Second,
		},
	})

	rt.Dispatch(context.Background())

	var owner string
	select {
	case owner = <-entered:
	case <-time.After(waitDeadline):
		t.Fatal("executor did not start")
	}

	// Simulate OS sleep/wake: lease_expires_at is genuinely expired and NO renew tick has fired.
	expiredAt := time.Now().Add(-time.Minute)
	if err := db.Model(&model.Task{}).Where("id = ?", "pre-renew-task").Update("lease_expires_at", expiredAt).Error; err != nil {
		t.Fatal(err)
	}

	// (a) Dispatch while the lease is genuinely expired must NOT double-claim the active task.
	rt.Dispatch(context.Background())
	time.Sleep(25 * time.Millisecond)
	if executes.Load() != 1 {
		t.Fatalf("executes=%d, want 1 (activeTasks/ClaimNextExcluding failed to block double-claim)", executes.Load())
	}

	// Confirm the lease is STILL genuinely expired in SQLite before SaveTaskCompletion runs.
	beforeSave, err := repo.Task("pre-renew-task")
	if err != nil {
		t.Fatal(err)
	}
	if beforeSave.LeaseOwner != owner || beforeSave.LeaseExpiresAt == nil || !beforeSave.LeaseExpiresAt.Before(time.Now()) {
		t.Fatalf("expected still-expired lease owned by %q before completion, got owner=%q expires=%v", owner, beforeSave.LeaseOwner, beforeSave.LeaseExpiresAt)
	}

	// (b) Complete the task BEFORE any renew tick runs.
	close(proceed)

	select {
	case out := <-completed:
		if out.Kind != KindCompleted || !out.Applied || out.Err != nil {
			t.Fatalf("expected clean completion on pre-renewal expired lease, got %+v", out)
		}
	case <-time.After(waitDeadline):
		t.Fatal("task did not complete")
	}

	if executes.Load() != 1 {
		t.Fatalf("executes=%d, want 1", executes.Load())
	}
	stored, err := repo.Task("pre-renew-task")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.TaskStatusSucceeded {
		t.Fatalf("stored status=%s, want succeeded", stored.Status)
	}
	var resultCount int64
	if err := db.Model(&model.Result{}).Where("task_id = ?", "pre-renew-task").Count(&resultCount).Error; err != nil || resultCount != 1 {
		t.Fatalf("resultCount=%d err=%v, want 1", resultCount, err)
	}
}

func TestSingleProcessSleepWakeRenewLoopRefreshesExpiredLease(t *testing.T) {
	db, repo := openTaskLeaseTestDB(t, true)
	if err := db.Create(&model.Task{
		ID:     "sleep-wake-renew",
		UserID: "user",
		Type:   "canvas_image",
		Status: model.TaskStatusQueued,
	}).Error; err != nil {
		t.Fatal(err)
	}

	coord := platform.NewLocalCoordinator()
	entered := make(chan string, 1)
	proceed := make(chan struct{})
	completed := make(chan Outcome, 1)

	exec := fnExec(func(session Session) Outcome {
		task := session.Task()
		entered <- task.LeaseOwner
		select {
		case <-proceed:
		case <-session.Context().Done():
			out := Outcome{Kind: KindLeaseLost, Err: session.LostErr(), ProviderAccepted: true}
			completed <- out
			return out
		}
		if session.Lost() {
			out := Outcome{Kind: KindLeaseLost, Err: session.LostErr(), ProviderAccepted: true}
			completed <- out
			return out
		}
		task.Status = model.TaskStatusSucceeded
		now := time.Now()
		task.CompletedAt = &now
		task.UpdatedAt = now
		if err := repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
			out := Outcome{Kind: KindFailed, Err: err}
			completed <- out
			return out
		}
		out := Outcome{Kind: KindCompleted, Applied: true, ProviderAccepted: true}
		completed <- out
		return out
	})

	rt := testRuntime(t, Deps{
		Repository:  NewRepositoryAdapter(repo, true),
		Coordinator: NewSlotCoordinatorAdapter(coord, true),
		Policy:      staticPolicy{n: 1, timeout: time.Minute},
		Executor:    exec,
		Config: Config{
			SingleProcess: true,
			SlotTTL:       40 * time.Millisecond,
			TaskLeaseTTL:  200 * time.Millisecond,
			RenewInterval: 15 * time.Millisecond,
		},
	})

	rt.Dispatch(context.Background())

	var owner string
	select {
	case owner = <-entered:
	case <-time.After(waitDeadline):
		t.Fatal("executor did not start")
	}

	expiredAt := time.Now().Add(-time.Minute)
	if err := db.Model(&model.Task{}).Where("id = ?", "sleep-wake-renew").Update("lease_expires_at", expiredAt).Error; err != nil {
		t.Fatal(err)
	}

	// Wait until renewLoop refreshes the expired lease in SQLite (and survives SlotTTL expiry).
	waitUntil(t, waitDeadline, func() bool {
		stored, err := repo.Task("sleep-wake-renew")
		return err == nil && stored.LeaseOwner == owner && stored.LeaseExpiresAt != nil && stored.LeaseExpiresAt.After(time.Now())
	})

	close(proceed)

	select {
	case out := <-completed:
		if out.Kind != KindCompleted || !out.Applied || out.Err != nil {
			t.Fatalf("expected clean completion after renewLoop refresh, got %+v", out)
		}
	case <-time.After(waitDeadline):
		t.Fatal("task did not complete")
	}
}

func TestSingleProcessGenuineLeaseLossAbortsWithKindLeaseLost(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(t *testing.T, db *gorm.DB, taskID string)
	}{
		{
			name: "owner_replaced",
			mutate: func(t *testing.T, db *gorm.DB, taskID string) {
				if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{
					"lease_owner":      "other-worker:attempt-2",
					"lease_expires_at": time.Now().Add(time.Minute),
				}).Error; err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "status_changed",
			mutate: func(t *testing.T, db *gorm.DB, taskID string) {
				if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{
					"status":           model.TaskStatusCancelled,
					"lease_owner":      "",
					"lease_expires_at": nil,
				}).Error; err != nil {
					t.Fatal(err)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, repo := openTaskLeaseTestDB(t, true)
			taskID := "lost-" + tc.name
			if err := db.Create(&model.Task{
				ID:     taskID,
				UserID: "user",
				Type:   "canvas_image",
				Status: model.TaskStatusQueued,
			}).Error; err != nil {
				t.Fatal(err)
			}

			entered := make(chan *model.Task, 1)
			result := make(chan Outcome, 1)
			exec := fnExec(func(session Session) Outcome {
				taskCopy := *session.Task()
				entered <- &taskCopy
				<-session.Context().Done()
				if session.Lost() {
					return Outcome{Kind: KindLeaseLost, Err: session.LostErr(), ProviderAccepted: true}
				}
				return Outcome{Kind: KindCancelled, Err: session.Context().Err()}
			})

			rt := testRuntime(t, Deps{
				Repository:  NewRepositoryAdapter(repo, true),
				Coordinator: NewSlotCoordinatorAdapter(platform.NewLocalCoordinator(), true),
				Executor:    exec,
				Config: Config{
					SingleProcess: true,
					TaskLeaseTTL:  200 * time.Millisecond,
					RenewInterval: 10 * time.Millisecond,
				},
			})

			go func() { result <- rt.ProcessOne(context.Background()) }()

			var staleTask *model.Task
			select {
			case staleTask = <-entered:
			case <-time.After(waitDeadline):
				t.Fatal("executor did not start")
			}

			tc.mutate(t, db, taskID)

			// Even in single-process mode, SaveTaskCompletion by a replaced/cancelled owner must be fenced.
			staleCopy := *staleTask
			staleCopy.Status = model.TaskStatusSucceeded
			if err := repo.SaveTaskCompletion(&staleCopy, model.TaskStatusRunning, []model.Result{{ID: "stale-" + tc.name, TaskID: taskID}}); !errors.Is(err, repository.ErrTaskStateConflict) {
				t.Fatalf("stale SaveTaskCompletion err=%v, want ErrTaskStateConflict", err)
			}

			select {
			case out := <-result:
				if out.Kind != KindLeaseLost {
					t.Fatalf("outcome kind=%s, want KindLeaseLost (err=%v)", out.Kind, out.Err)
				}
				if !errors.Is(out.Err, ErrLeaseLost) {
					t.Fatalf("outcome err=%v, want ErrLeaseLost", out.Err)
				}
				if !errors.Is(out.Err, repository.ErrTaskLeaseLost) {
					t.Fatalf("outcome err=%v, want wrapped repository.ErrTaskLeaseLost", out.Err)
				}
			case <-time.After(waitDeadline):
				t.Fatal("executor did not abort after genuine lease loss")
			}
		})
	}
}

func TestMultiWorkerExpiredLeaseStillAbortsWithKindLeaseLost(t *testing.T) {
	db, repo := openTaskLeaseTestDB(t, false)
	if err := db.Create(&model.Task{
		ID:     "server-expired",
		UserID: "user",
		Type:   "canvas_image",
		Status: model.TaskStatusQueued,
	}).Error; err != nil {
		t.Fatal(err)
	}

	entered := make(chan *model.Task, 1)
	result := make(chan Outcome, 1)
	exec := fnExec(func(session Session) Outcome {
		taskCopy := *session.Task()
		entered <- &taskCopy
		<-session.Context().Done()
		if session.Lost() {
			return Outcome{Kind: KindLeaseLost, Err: session.LostErr(), ProviderAccepted: true}
		}
		return Outcome{Kind: KindCancelled, Err: session.Context().Err()}
	})

	rt := testRuntime(t, Deps{
		Repository:  NewRepositoryAdapter(repo, false),
		Coordinator: NewSlotCoordinatorAdapter(platform.NewLocalCoordinator(), false),
		Executor:    exec,
		Config: Config{
			SingleProcess: false,
			TaskLeaseTTL:  200 * time.Millisecond,
			RenewInterval: 10 * time.Millisecond,
		},
	})

	go func() { result <- rt.ProcessOne(context.Background()) }()

	var staleTask *model.Task
	select {
	case staleTask = <-entered:
	case <-time.After(waitDeadline):
		t.Fatal("executor did not start")
	}

	if err := db.Model(&model.Task{}).Where("id = ?", "server-expired").Update("lease_expires_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}

	staleCopy := *staleTask
	staleCopy.Status = model.TaskStatusSucceeded
	if err := repo.SaveTaskCompletion(&staleCopy, model.TaskStatusRunning, nil); !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("multi-worker expired SaveTaskCompletion err=%v, want ErrTaskStateConflict", err)
	}

	select {
	case out := <-result:
		if out.Kind != KindLeaseLost {
			t.Fatalf("outcome kind=%s, want KindLeaseLost (err=%v)", out.Kind, out.Err)
		}
		if !errors.Is(out.Err, ErrLeaseLost) {
			t.Fatalf("outcome err=%v, want ErrLeaseLost", out.Err)
		}
		if !errors.Is(out.Err, repository.ErrTaskLeaseLost) {
			t.Fatalf("outcome err=%v, want wrapped repository.ErrTaskLeaseLost", out.Err)
		}
	case <-time.After(waitDeadline):
		t.Fatal("multi-worker runtime did not abort after lease expiry")
	}
}
