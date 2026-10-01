package asset

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func putAllChunks(t *testing.T, svc *Service, userID, uploadID string, body []byte, chunkSize int) {
	t.Helper()
	for index, start := 0, 0; start < len(body); index++ {
		end := start + chunkSize
		if end > len(body) {
			end = len(body)
		}
		if err := svc.PutChunkedUpload(userID, uploadID, index, bytes.NewReader(body[start:end])); err != nil {
			t.Fatalf("put chunk %d: %v", index, err)
		}
		start = end
	}
}

func TestChunkedUploadStartEnforcesPerUserLimit(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	var started int
	var busy int
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(chunkUploadMaxPerUser + 1)
	for i := 0; i < chunkUploadMaxPerUser+1; i++ {
		go func() {
			defer wg.Done()
			_, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.bin", Kind: "file", Size: 1})
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				started++
				return
			}
			if !errors.Is(err, UploadSessionBusy()) && err.Error() != UploadSessionBusy().Error() {
				t.Errorf("start error = %v", err)
				return
			}
			busy++
		}()
	}
	wg.Wait()
	if started != chunkUploadMaxPerUser || busy != 1 {
		t.Fatalf("started=%d busy=%d", started, busy)
	}
}

func TestChunkedUploadIncompleteDoesNotReturnReady(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	resource, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err == nil || resource != nil {
		t.Fatalf("incomplete complete resource=%#v err=%v", resource, err)
	}
	listed, listErr := repo.Resources("user-1", 10)
	if listErr != nil || len(listed) != 0 {
		t.Fatalf("incomplete complete persisted %#v err=%v", listed, listErr)
	}
}

func TestChunkedUploadCompleteReplayAndCrossUser(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PutChunkedUpload("user-2", session.UploadID, 0, bytes.NewReader(body)); err == nil {
		t.Fatal("cross-user put succeeded")
	}
	if _, err := svc.CompleteChunkedUpload("user-2", session.UploadID); err == nil {
		t.Fatal("cross-user complete succeeded")
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	first, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("complete = %#v err=%v", first, err)
	}
	second, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || second == nil || second.ID != first.ID || second.Status != model.ResourceStatusReady {
		t.Fatalf("replay = %#v err=%v", second, err)
	}
}

func TestChunkedUploadReadySaveFailureDoesNotReturnReadyOrRefund(t *testing.T) {
	base, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	failing := &readySaveFailRepo{Repository: base.repo, remaining: 1}
	svc := NewService(Dependencies{
		Repository: failing,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	body := []byte("payload")
	session, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	if quota.pendingTotal() != int64(len(body)) || quota.daily != int64(len(body)) {
		t.Fatalf("start quota pending=%d daily=%d", quota.pendingTotal(), quota.daily)
	}
	putAllChunks(t, svc, "user-1", session.UploadID, body, session.ChunkSize)
	first, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err == nil || first != nil && first.Status == model.ResourceStatusReady {
		t.Fatalf("complete after ready-save fail resource=%#v err=%v", first, err)
	}
	listed, listErr := repo.Resources("user-1", 10)
	if listErr != nil || len(listed) != 1 || listed[0].Status == model.ResourceStatusReady {
		t.Fatalf("persisted after failed complete = %#v err=%v", listed, listErr)
	}
	if quota.daily != int64(len(body)) || quota.releases != 0 || quota.pendingTotal() != int64(len(body)) {
		t.Fatalf("ready-save fail refunded daily=%d pending=%d releases=%d", quota.daily, quota.pendingTotal(), quota.releases)
	}
	second, err := svc.CompleteChunkedUpload("user-1", session.UploadID)
	if err != nil || second == nil || second.Status != model.ResourceStatusReady {
		t.Fatalf("complete replay after ready-save fail = %#v err=%v", second, err)
	}
	if quota.daily != int64(len(body)) || quota.releases != 0 || quota.pendingTotal() != 0 || quota.commits != 1 {
		t.Fatalf("after successful replay daily=%d pending=%d commits=%d releases=%d", quota.daily, quota.pendingTotal(), quota.commits, quota.releases)
	}
}

func TestChunkedUploadRestartExpiresAndReleasesAbandoned(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	first := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	session, err := first.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7})
	if err != nil {
		t.Fatal(err)
	}
	if quota.daily != 7 || quota.pendingTotal() != 7 {
		t.Fatalf("start daily=%d pending=%d", quota.daily, quota.pendingTotal())
	}
	restarted := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if quota.daily != 0 || quota.pendingTotal() != 0 || quota.releases != 1 {
		t.Fatalf("restart leftover daily=%d pending=%d releases=%d", quota.daily, quota.pendingTotal(), quota.releases)
	}
	if _, err := restarted.CompleteChunkedUpload("user-1", session.UploadID); err == nil {
		t.Fatal("restart complete resumed expired session")
	}
	entries, _ := os.ReadDir(filepath.Join(dataDir, chunkSessionDirName))
	if len(entries) != 0 {
		t.Fatalf("temp session files remain: %v", entries)
	}
}

func TestChunkedUploadStartReservesAgainstGeneratedPending(t *testing.T) {
	base, _, dataDir := newTestDomain(t)
	quota := &ledgerQuota{}
	svc := NewService(Dependencies{
		Repository: base.repo,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	if _, err := quota.ReserveGenerated("user-1", 11, "generated-one"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.StartChunkedUpload("user-1", ChunkedUploadStart{FileName: "a.png", Kind: "image", Size: 7}); err != nil {
		t.Fatal(err)
	}
	if quota.pendingOf("generated-one") != 11 || quota.pendingTotal() != 18 {
		t.Fatalf("session stole generated pending %#v", quota.pending)
	}
}
