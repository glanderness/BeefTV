package asset

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type failOnceDeleteBlobStore struct {
	BlobStore
	mu     sync.Mutex
	failed map[string]bool
	failOn string
}

func (b *failOnceDeleteBlobStore) Delete(objectKey string) error {
	b.mu.Lock()
	if objectKey == b.failOn && !b.failed[objectKey] {
		b.failed[objectKey] = true
		b.mu.Unlock()
		return errors.New("simulated transient delete failure")
	}
	b.mu.Unlock()
	return b.BlobStore.Delete(objectKey)
}

type countingDeletionRepo struct {
	Repository
	claims atomic.Int64
}

func (r *countingDeletionRepo) ClaimNextResourceDeletionJob(owner string, leaseDuration time.Duration) (*model.ResourceDeletionJob, error) {
	r.claims.Add(1)
	return r.Repository.ClaimNextResourceDeletionJob(owner, leaseDuration)
}

func TestStartDeletionWorkerWakesOnSignalWithoutIdlePolling(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	if err := repo.DB().AutoMigrate(&model.ResourceDeletionJob{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}); err != nil {
		t.Fatal(err)
	}
	countingRepo := &countingDeletionRepo{Repository: svc.repo}
	svc.repo = countingRepo

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	svc.StartDeletionWorker(ctx, func(run func(context.Context)) bool {
		go func() {
			defer close(done)
			run(ctx)
		}()
		return true
	})

	// Wait for the single startup drain claim.
	deadline := time.Now().Add(2 * time.Second)
	for countingRepo.claims.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	startupClaims := countingRepo.claims.Load()
	if startupClaims != 1 {
		cancel()
		<-done
		t.Fatalf("startup claim count = %d, want 1", startupClaims)
	}

	// Idle period must not keep polling SQLite.
	time.Sleep(120 * time.Millisecond)
	if afterIdle := countingRepo.claims.Load(); afterIdle != startupClaims {
		cancel()
		<-done
		t.Fatalf("idle claims = %d (was %d), want zero idle polling", afterIdle, startupClaims)
	}

	// Enqueue a real physical object + deletion job and signal the worker.
	fileStore := NewFileStore(dataDir)
	objectKey := "users/owner/image/wake-delete.png"
	if err := fileStore.Write(objectKey, bytes.NewReader([]byte("img"))); err != nil {
		cancel()
		<-done
		t.Fatal(err)
	}
	job := model.ResourceDeletionJob{
		ID:            "job-wake-1",
		UserID:        "owner",
		ResourceID:    "res-wake-1",
		Provider:      "local",
		ObjectKey:     objectKey,
		Status:        model.ResourceDeletionStatusPending,
		NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := repo.DB().Create(&job).Error; err != nil {
		cancel()
		<-done
		t.Fatal(err)
	}
	svc.signalDeletionWorker()

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var remaining int64
		_ = repo.DB().Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&remaining).Error
		if remaining == 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	var remaining int64
	if err := repo.DB().Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&remaining).Error; err != nil {
		cancel()
		<-done
		t.Fatal(err)
	}
	cancel()
	<-done
	if remaining != 0 {
		t.Fatalf("deletion job remained pending after wake signal")
	}
	if err := fileStore.Exists(objectKey); err == nil {
		t.Fatalf("expected physical file %s to be deleted after wake drain", objectKey)
	}
}

func TestStartDeletionWorkerBackoffSurvivesInterleavedWake(t *testing.T) {
	prevBase := deletionRetryBase
	deletionRetryBase = 90 * time.Millisecond
	t.Cleanup(func() { deletionRetryBase = prevBase })

	svc, repo, dataDir := newTestDomain(t)
	if err := repo.DB().AutoMigrate(&model.ResourceDeletionJob{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}); err != nil {
		t.Fatal(err)
	}
	fileStore := NewFileStore(dataDir)
	keyA := "users/owner/image/retry-a.png"
	keyB := "users/owner/image/immediate-b.png"
	if err := fileStore.Write(keyA, bytes.NewReader([]byte("a"))); err != nil {
		t.Fatal(err)
	}
	if err := fileStore.Write(keyB, bytes.NewReader([]byte("b"))); err != nil {
		t.Fatal(err)
	}
	svc.blobs = &failOnceDeleteBlobStore{
		BlobStore: fileStore,
		failed:    map[string]bool{},
		failOn:    keyA,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	svc.StartDeletionWorker(ctx, func(run func(context.Context)) bool {
		go func() {
			defer close(done)
			run(ctx)
		}()
		return true
	})
	defer func() {
		cancel()
		<-done
	}()

	jobA := model.ResourceDeletionJob{
		ID:            "job-retry-a",
		UserID:        "owner",
		ResourceID:    "res-retry-a",
		Provider:      "local",
		ObjectKey:     keyA,
		Status:        model.ResourceDeletionStatusPending,
		NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := repo.DB().Create(&jobA).Error; err != nil {
		t.Fatal(err)
	}
	svc.signalDeletionWorker()

	// Wait until job A fails its first attempt and is rescheduled into future backoff.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var row model.ResourceDeletionJob
		if err := repo.DB().First(&row, "id = ?", jobA.ID).Error; err == nil && row.Attempts >= 1 && row.Status == model.ResourceDeletionStatusPending {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Interleave an unrelated wake signal for job B while job A is waiting in backoff.
	jobB := model.ResourceDeletionJob{
		ID:            "job-immediate-b",
		UserID:        "owner",
		ResourceID:    "res-immediate-b",
		Provider:      "local",
		ObjectKey:     keyB,
		Status:        model.ResourceDeletionStatusPending,
		NextAttemptAt: time.Now().Add(-time.Second),
	}
	if err := repo.DB().Create(&jobB).Error; err != nil {
		t.Fatal(err)
	}
	svc.signalDeletionWorker()

	// Both job B (immediately) and job A (after backoff) must finish without another wake.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var remaining int64
		if err := repo.DB().Model(&model.ResourceDeletionJob{}).Count(&remaining).Error; err == nil && remaining == 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	var remaining int64
	if err := repo.DB().Model(&model.ResourceDeletionJob{}).Count(&remaining).Error; err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("expected both deletion jobs to finish after interleaved wake, %d still pending", remaining)
	}
	if err := fileStore.Exists(keyA); err == nil {
		t.Fatalf("expected retried physical file %s to be deleted", keyA)
	}
	if err := fileStore.Exists(keyB); err == nil {
		t.Fatalf("expected immediate physical file %s to be deleted", keyB)
	}
}

func TestStartDeletionWorkerDrainsPersistedFutureAttemptOnStartup(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	if err := repo.DB().AutoMigrate(&model.ResourceDeletionJob{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}); err != nil {
		t.Fatal(err)
	}
	fileStore := NewFileStore(dataDir)
	objectKey := "users/owner/image/startup-future.png"
	if err := fileStore.Write(objectKey, bytes.NewReader([]byte("future"))); err != nil {
		t.Fatal(err)
	}
	job := model.ResourceDeletionJob{
		ID:            "job-startup-future",
		UserID:        "owner",
		ResourceID:    "res-startup-future",
		Provider:      "local",
		ObjectKey:     objectKey,
		Status:        model.ResourceDeletionStatusPending,
		NextAttemptAt: time.Now().Add(90 * time.Millisecond),
	}
	if err := repo.DB().Create(&job).Error; err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	svc.StartDeletionWorker(ctx, func(run func(context.Context)) bool {
		go func() {
			defer close(done)
			run(ctx)
		}()
		return true
	})
	defer func() {
		cancel()
		<-done
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var remaining int64
		if err := repo.DB().Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&remaining).Error; err == nil && remaining == 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	var remaining int64
	if err := repo.DB().Model(&model.ResourceDeletionJob{}).Where("id = ?", job.ID).Count(&remaining).Error; err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("persisted future deletion job did not drain automatically after startup")
	}
	if err := fileStore.Exists(objectKey); err == nil {
		t.Fatalf("expected persisted future file %s to be deleted", objectKey)
	}
}

type failingClaimDeletionRepo struct {
	Repository
	claims atomic.Int64
}

func (r *failingClaimDeletionRepo) ClaimNextResourceDeletionJob(string, time.Duration) (*model.ResourceDeletionJob, error) {
	r.claims.Add(1)
	return nil, errors.New("database is read-only")
}

func TestStartDeletionWorkerBacksOffOnPersistentClaimError(t *testing.T) {
	prevBase := deletionRetryBase
	deletionRetryBase = 100 * time.Millisecond
	t.Cleanup(func() { deletionRetryBase = prevBase })

	svc, repo, _ := newTestDomain(t)
	if err := repo.DB().AutoMigrate(&model.ResourceDeletionJob{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}); err != nil {
		t.Fatal(err)
	}
	job := model.ResourceDeletionJob{
		ID:            "job-claim-err",
		UserID:        "owner",
		ResourceID:    "res-claim-err",
		Provider:      "local",
		ObjectKey:     "users/owner/image/claim-err.png",
		Status:        model.ResourceDeletionStatusPending,
		NextAttemptAt: time.Now().Add(-time.Minute),
	}
	if err := repo.DB().Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	failingRepo := &failingClaimDeletionRepo{Repository: svc.repo}
	svc.repo = failingRepo

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	svc.StartDeletionWorker(ctx, func(run func(context.Context)) bool {
		go func() {
			defer close(done)
			run(ctx)
		}()
		return true
	})

	time.Sleep(240 * time.Millisecond)
	cancel()
	<-done

	got := failingRepo.claims.Load()
	if got < 2 || got > 4 {
		t.Fatalf("claim attempts during 240ms persistent error = %d, want bounded backoff [2, 4] (not 10ms spin)", got)
	}
}

func TestStartDeletionWorkerDefersDetachedCleanupPastStartup(t *testing.T) {
	prevAfter := startupCleanupAfter
	fireCleanup := make(chan time.Time, 1)
	armed := make(chan time.Duration, 1)
	startupCleanupAfter = func(delay time.Duration) (<-chan time.Time, func()) {
		select {
		case armed <- delay:
		default:
		}
		return fireCleanup, func() {}
	}
	t.Cleanup(func() { startupCleanupAfter = prevAfter })

	svc, repo, _ := newTestDomain(t)
	if err := database.MigrateLocalSchema(repo.DB()); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-48 * time.Hour)
	orphan := model.Resource{
		ID:        "res-deferred-orphan",
		UserID:    "owner",
		Kind:      "image",
		Status:    model.ResourceStatusReady,
		Provider:  "local",
		ObjectKey: "users/owner/image/deferred-orphan.png",
		CreatedAt: oldTime,
		UpdatedAt: oldTime,
	}
	if err := repo.DB().Create(&orphan).Error; err != nil {
		t.Fatal(err)
	}
	countingRepo := &countingDeletionRepo{Repository: svc.repo}
	svc.repo = countingRepo

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	svc.StartDeletionWorker(ctx, func(run func(context.Context)) bool {
		go func() {
			defer close(done)
			run(ctx)
		}()
		return true
	})
	defer func() {
		cancel()
		<-done
	}()

	// Startup outbox drain runs immediately and arms the deferred cleanup timer.
	select {
	case delay := <-armed:
		if delay != startupCleanupDelay {
			t.Fatalf("armed startup cleanup delay = %v, want %v", delay, startupCleanupDelay)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("startup cleanup timer was not armed")
	}
	if countingRepo.claims.Load() < 1 {
		t.Fatal("expected immediate startup drain claim before arming cleanup timer")
	}
	var beforeDelay int64
	if err := repo.DB().Model(&model.Resource{}).Where("id = ?", orphan.ID).Count(&beforeDelay).Error; err != nil {
		t.Fatal(err)
	}
	if beforeDelay != 1 {
		t.Fatalf("orphan resource count before deferred cleanup trigger = %d, want 1", beforeDelay)
	}

	// Trigger the deferred cleanup and verify the orphan is removed.
	fireCleanup <- time.Now()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var remaining int64
		if err := repo.DB().Model(&model.Resource{}).Where("id = ?", orphan.ID).Count(&remaining).Error; err == nil && remaining == 0 {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("expected deferred detached resource cleanup to remove orphan after timer fires")
}

type staleOnceDetachedRepo struct {
	Repository
	staleBudget atomic.Int64
	deleteCalls atomic.Int64
}

func (r *staleOnceDetachedRepo) DeleteDetachedResources(resources []model.Resource, deletionJobs []model.ResourceDeletionJob, verifiedWatermark ...repository.SQLiteSnapshotWatermark) error {
	r.deleteCalls.Add(1)
	if r.staleBudget.Add(-1) >= 0 {
		return repository.ErrResourceCleanupSnapshotStale
	}
	return r.Repository.DeleteDetachedResources(resources, deletionJobs, verifiedWatermark...)
}

func TestStartDeletionWorkerRearmsAndConvergesAfterStaleWatermark(t *testing.T) {
	prevAfter := startupCleanupAfter
	prevBusyBase := detachedBusyRetryBase
	prevBusyMax := detachedBusyRetryMax
	fireCleanup := make(chan time.Time, 1)
	startupCleanupAfter = func(delay time.Duration) (<-chan time.Time, func()) {
		return fireCleanup, func() {}
	}
	detachedBusyRetryBase = 35 * time.Millisecond
	detachedBusyRetryMax = 70 * time.Millisecond
	t.Cleanup(func() {
		startupCleanupAfter = prevAfter
		detachedBusyRetryBase = prevBusyBase
		detachedBusyRetryMax = prevBusyMax
	})

	svc, repo, _ := newTestDomain(t)
	if err := database.MigrateLocalSchema(repo.DB()); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-48 * time.Hour)
	orphan := model.Resource{
		ID:        "res-stale-retry-orphan",
		UserID:    "owner",
		Kind:      "image",
		Status:    model.ResourceStatusReady,
		Provider:  "local",
		ObjectKey: "users/owner/image/stale-retry-orphan.png",
		CreatedAt: oldTime,
		UpdatedAt: oldTime,
	}
	if err := repo.DB().Create(&orphan).Error; err != nil {
		t.Fatal(err)
	}

	staleRepo := &staleOnceDetachedRepo{Repository: svc.repo}
	// Force two consecutive stale-watermark exits so StartDeletionWorker MUST
	// re-arm cleanupRetryTimer with backoff rather than waiting for the hourly ticker.
	const staleFailures = 2
	staleRepo.staleBudget.Store(staleFailures)
	svc.repo = staleRepo

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	svc.StartDeletionWorker(ctx, func(run func(context.Context)) bool {
		go func() {
			defer close(done)
			run(ctx)
		}()
		return true
	})
	defer func() {
		cancel()
		<-done
	}()

	fireCleanup <- time.Now()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var remaining int64
		if err := repo.DB().Model(&model.Resource{}).Where("id = ?", orphan.ID).Count(&remaining).Error; err == nil && remaining == 0 {
			if got := staleRepo.deleteCalls.Load(); got != staleFailures+1 {
				t.Fatalf("delete calls = %d, want %d (%d stale + 1 converged)", got, staleFailures+1, staleFailures)
			}
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("expected busy-deferred detached cleanup to re-arm and converge (calls=%d)", staleRepo.deleteCalls.Load())
}
