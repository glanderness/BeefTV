package asset

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func testArtifact(body string) RecoveredArtifact {
	return RecoveredArtifact{
		Kind: "image", FileName: "generated.png", MimeType: "image/png",
		Size: int64(len(body)), Body: bytes.NewReader([]byte(body)),
	}
}

func TestRecoverOwnedReadyReplaySkipsRestore(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	first, err := svc.RecoverOwned("user-1", "task-ready:0", func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first = %#v err=%v", first, err)
	}
	replay, err := svc.RecoverOwned("user-1", "task-ready:0", func() (RecoveredArtifact, error) {
		t.Fatal("READY+bytes replay called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || replay.ID != first.ID || replay.Status != model.ResourceStatusReady {
		t.Fatalf("replay = %#v err=%v", replay, err)
	}
}

func TestRecoverOwnedPendingBytesFinalizesWithoutRestore(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	identity := "task-pending:0"
	uploadKey := NormalizedUploadKey([]string{identity})
	pending := &model.Resource{
		ID: "resource-pending-bytes", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending-bytes.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(pending); err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Write(pending.ObjectKey, bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	quota := &recordingQuota{}
	restarted := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
	})
	got, err := restarted.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		t.Fatal("PENDING+bytes called restore")
		return RecoveredArtifact{}, nil
	})
	if err != nil || got.ID != pending.ID || got.Status != model.ResourceStatusReady {
		t.Fatalf("pending promote = %#v err=%v", got, err)
	}
	if quota.reserved != 0 {
		t.Fatalf("pending promote reserved quota = %d", quota.reserved)
	}
}

func TestRecoverOwnedFailedReadySaveThenPromoteWithoutRestore(t *testing.T) {
	base, repo, dataDir := newTestDomain(t)
	failing := &readySaveFailRepo{Repository: base.repo, remaining: 1}
	svc := NewService(Dependencies{
		Repository: failing,
		Blobs:      base.blobs,
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
	})
	var restores atomic.Int64
	restore := func() (RecoveredArtifact, error) {
		restores.Add(1)
		return testArtifact("payload"), nil
	}
	first, err := svc.RecoverOwned("user-1", "task-finalize:0", restore)
	if err == nil || first == nil || first.Status == model.ResourceStatusReady {
		t.Fatalf("first recover resource=%#v err=%v", first, err)
	}
	latest, lookupErr := repo.ResourceByUploadKey("user-1", *NormalizedUploadKey([]string{"task-finalize:0"}))
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if latest.Status == model.ResourceStatusReady {
		t.Fatal("database READY after failed finalize")
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(latest.ObjectKey))); statErr != nil {
		t.Fatalf("bytes missing after finalize failure: %v", statErr)
	}
	second, err := svc.RecoverOwned("user-1", "task-finalize:0", restore)
	if err != nil || second.ID != latest.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("second recover = %#v err=%v", second, err)
	}
	if restores.Load() != 1 {
		t.Fatalf("restore count = %d, want 1", restores.Load())
	}
}

func TestRecoverOwnedReadyMissingFileRestoresOnce(t *testing.T) {
	svc, _, dataDir := newTestDomain(t)
	first, err := svc.RecoverOwned("user-1", "task-missing:0", func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := NewFileStore(dataDir).Delete(first.ObjectKey); err != nil {
		t.Fatal(err)
	}
	var restores atomic.Int64
	second, err := svc.RecoverOwned("user-1", "task-missing:0", func() (RecoveredArtifact, error) {
		restores.Add(1)
		return testArtifact("payload"), nil
	})
	if err != nil || second.ID != first.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("missing restore = %#v err=%v", second, err)
	}
	if restores.Load() != 1 {
		t.Fatalf("restore count = %d, want 1", restores.Load())
	}
	if err := NewFileStore(dataDir).Exists(second.ObjectKey); err != nil {
		t.Fatalf("restored bytes missing: %v", err)
	}
}

func TestRecoverOwnedIsolatesForeignCaller(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	first, err := svc.RecoverOwned("user-1", "task-shared:0", func() (RecoveredArtifact, error) {
		return testArtifact("owner-1"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.RecoverOwned("user-2", "task-shared:0", func() (RecoveredArtifact, error) {
		return testArtifact("owner-2"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID || first.UserID != "user-1" || second.UserID != "user-2" {
		t.Fatalf("owners shared identity: %#v %#v", first, second)
	}
	owned, err := repo.Resource(first.ID)
	if err != nil || owned.UserID != "user-1" {
		t.Fatalf("foreign recover mutated owner row: %#v err=%v", owned, err)
	}
}

func TestRecoverOwnedConcurrentCallersShareOneRestore(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	var restores atomic.Int64
	announced := make(chan struct{})
	hold := make(chan struct{})
	restore := func() (RecoveredArtifact, error) {
		if restores.Add(1) == 1 {
			close(announced)
			<-hold
		}
		return testArtifact("payload"), nil
	}
	var first, second *model.Resource
	var err1, err2 error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		first, err1 = svc.RecoverOwned("user-1", "task-concurrent:0", restore)
	}()
	<-announced
	wg.Add(1)
	go func() {
		defer wg.Done()
		second, err2 = svc.RecoverOwned("user-1", "task-concurrent:0", restore)
	}()
	close(hold)
	wg.Wait()
	if err1 != nil || err2 != nil {
		t.Fatalf("concurrent recover: %v %v", err1, err2)
	}
	if first == nil || second == nil || first.ID != second.ID {
		t.Fatalf("concurrent ids first=%v second=%v", first, second)
	}
	if restores.Load() != 1 {
		t.Fatalf("restore count = %d, want 1", restores.Load())
	}
	resources, err := repo.Resources("user-1", 10)
	if err != nil || len(resources) != 1 || resources[0].Status != model.ResourceStatusReady {
		t.Fatalf("resources = %#v err=%v", resources, err)
	}
}

func TestRecoverOwnedStableIdentityUsesNormalizedUploadKey(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	identity := "task-stable:3"
	got, err := svc.RecoverOwned("user-1", identity, func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := NormalizedUploadKey([]string{identity})
	if got.UploadKey == nil || *got.UploadKey != *want {
		t.Fatalf("upload key = %v want %v", got.UploadKey, want)
	}
	listed, err := repo.ResourceByUploadKey("user-1", *want)
	if err != nil || listed.ID != got.ID {
		t.Fatalf("lookup = %#v err=%v", listed, err)
	}
}

func TestRecoverOwnedCreateReservesQuotaReplayDoesNot(t *testing.T) {
	base, _, _ := newTestDomain(t)
	quota := &recordingQuota{}
	svc := NewService(Dependencies{
		Repository: base.repo,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
	})
	first, err := svc.RecoverOwned("user-1", "task-quota:0", func() (RecoveredArtifact, error) {
		return testArtifact("payload"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if quota.reserved != first.Size {
		t.Fatalf("create reserved = %d want %d", quota.reserved, first.Size)
	}
	if _, err := svc.RecoverOwned("user-1", "task-quota:0", func() (RecoveredArtifact, error) {
		t.Fatal("replay restore")
		return RecoveredArtifact{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if quota.reserved != first.Size {
		t.Fatalf("replay changed quota reserved = %d", quota.reserved)
	}
}
