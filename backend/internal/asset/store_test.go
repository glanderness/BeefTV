package asset

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"

	"infinite-canvas/backend/internal/model"
)

type holdFirstRead struct {
	once      sync.Once
	announced chan struct{}
	hold      <-chan struct{}
	rest      io.Reader
}

func (h *holdFirstRead) Read(p []byte) (int, error) {
	h.once.Do(func() {
		close(h.announced)
		<-h.hold
	})
	return h.rest.Read(p)
}

var errReadySave = errors.New("injected ready save failure")

func TestStoreReusesReadyUploadKey(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"image:user-1:logical-upload"})
	first, stored, err := svc.Store("user-1", "image", "first.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey)
	if err != nil || !stored {
		t.Fatalf("first store: stored=%v err=%v", stored, err)
	}
	second, stored, err := svc.Store("user-1", "image", "second.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("other")), uploadKey)
	if err != nil || stored || second.ID != first.ID || second.ObjectKey != first.ObjectKey {
		t.Fatalf("idempotent store = %#v stored=%v first=%#v err=%v", second, stored, first, err)
	}
	resources, err := repo.Resources("user-1", 10)
	if err != nil || len(resources) != 1 {
		t.Fatalf("resource count = %d err=%v", len(resources), err)
	}
}

func TestStoreIsolatesOwners(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"shared-client-key"})
	first, _, err := svc.Store("user-1", "image", "a.png", "image/png", 4, 1, 1, 0, bytes.NewReader([]byte("one1")), uploadKey)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := svc.Store("user-2", "image", "b.png", "image/png", 4, 1, 1, 0, bytes.NewReader([]byte("two2")), uploadKey)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatal("owners shared a resource identity")
	}
	if _, err := svc.Resource("user-2", first.ID); err == nil {
		t.Fatal("user-2 read user-1 resource")
	}
	owned, err := svc.Resource("user-1", first.ID)
	if err != nil || owned.ID != first.ID {
		t.Fatalf("owner lookup: %#v %v", owned, err)
	}
}

func TestStoreFailedWriteLeavesFailedNotReady(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"fail-write"})
	_, _, err := svc.Store("user-1", "image", "a.png", "image/png", 7, 1, 1, 0, iotest.ErrReader(errors.New("write failed")), uploadKey)
	if err == nil {
		t.Fatal("expected write failure")
	}
	resource, lookupErr := repo.ResourceByUploadKey("user-1", *uploadKey)
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if resource.Status != model.ResourceStatusFailed {
		t.Fatalf("status = %s, want failed", resource.Status)
	}
	if resource.Status == model.ResourceStatusReady {
		t.Fatal("ready recorded after failed write")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey))); !os.IsNotExist(err) {
		t.Fatalf("partial object published: %v", err)
	}
}

func TestRetryFailedUploadKeepsObjectKey(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"retry"})
	failed := &model.Resource{
		ID: "resource-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/fixed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	retried, err := svc.Retry("user-1", failed, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}
	if retried.ObjectKey != "users/user-1/image/fixed.png" || retried.Status != model.ResourceStatusReady {
		t.Fatalf("retried = %#v", retried)
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(retried.ObjectKey)))
	if err != nil || string(body) != "payload" {
		t.Fatalf("body = %q err=%v", body, err)
	}
}

func TestConcurrentUploadKeyReplay(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	const workers = 8
	var wg sync.WaitGroup
	results := make([]*model.Resource, workers)
	errs := make([]error, workers)
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(index int) {
			defer wg.Done()
			resource, err := svc.UploadFile("user-1", "same.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "concurrent-key")
			results[index] = resource
			errs[index] = err
		}(i)
	}
	wg.Wait()
	var id string
	for index, err := range errs {
		if err != nil {
			t.Fatalf("worker %d: %v", index, err)
		}
		if results[index] == nil {
			t.Fatalf("worker %d returned nil resource", index)
		}
		if id == "" {
			id = results[index].ID
		}
		if results[index].ID != id {
			t.Fatalf("worker %d id=%s want %s", index, results[index].ID, id)
		}
	}
	resources, err := repo.Resources("user-1", 10)
	if err != nil || len(resources) != 1 {
		t.Fatalf("resource count = %d err=%v", len(resources), err)
	}
}

func TestUploadFileReplayReadyIdentity(t *testing.T) {
	svc, _, _ := newTestDomain(t)
	first, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "replay-key")
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.UploadFile("user-1", "b.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "replay-key")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("replay created %s then %s", first.ID, second.ID)
	}
}

func TestReadySaveFailureLeavesRecoverableFailedState(t *testing.T) {
	base, repo, dataDir := newTestDomain(t)
	failing := &readySaveFailRepo{Repository: base.repo, remaining: 1}
	svc := NewService(Dependencies{
		Repository: failing,
		Blobs:      base.blobs,
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
	})
	uploadKey := NormalizedUploadKey([]string{"finalize-fail"})
	resource, stored, err := svc.Store("user-1", "image", "a.png", "image/png", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey)
	if err == nil || !stored || resource == nil {
		t.Fatalf("store resource=%v stored=%v err=%v", resource, stored, err)
	}
	if resource.Status == model.ResourceStatusReady {
		t.Fatal("READY recorded after metadata save failure")
	}
	latest, lookupErr := repo.ResourceByUploadKey("user-1", *uploadKey)
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if latest.Status == model.ResourceStatusReady {
		t.Fatal("database READY after failed finalize")
	}
	if _, statErr := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(latest.ObjectKey))); statErr != nil {
		t.Fatalf("bytes missing after finalize failure: %v", statErr)
	}
	recovered, retryErr := svc.Retry("user-1", latest, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if retryErr != nil {
		t.Fatal(retryErr)
	}
	if recovered.Status != model.ResourceStatusReady {
		t.Fatalf("recovered status = %s", recovered.Status)
	}
}

func TestPendingRestartReplayCompletes(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"restart"})
	pending := &model.Resource{
		ID: "resource-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending.png", MimeType: "text/plain", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(pending); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "resources", "users", "user-1", "image"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "resources", filepath.FromSlash(pending.ObjectKey)), []byte("stale"), 0o640); err != nil {
		t.Fatal(err)
	}
	recovered, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "restart")
	if err != nil {
		t.Fatal(err)
	}
	if recovered.ID != pending.ID || recovered.Status != model.ResourceStatusReady {
		t.Fatalf("recovered = %#v", recovered)
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(pending.ObjectKey)))
	if err != nil || string(body) != "payload" {
		t.Fatalf("body = %q err=%v", body, err)
	}
}

func TestWriteObjectIsAtomicWhenReaderFails(t *testing.T) {
	svc, _, dataDir := newTestDomain(t)
	resource := &model.Resource{
		ID: "resource-atomic", UserID: "local", Kind: "image", MimeType: "image/png",
		ObjectKey: "workspaces/local/image/resource-atomic.png",
	}
	if _, err := svc.WriteObject(resource, "asset.png", bytes.NewReader([]byte("original"))); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.WriteObject(resource, "asset.png", iotest.ErrReader(errors.New("injected resource read failure"))); err == nil {
		t.Fatal("WriteObject() error = nil for failing reader")
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))
	if err != nil || string(body) != "original" {
		t.Fatalf("body = %q err=%v", body, err)
	}
}

func TestRetryReleasesQuotaAfterFailure(t *testing.T) {
	quota := &recordingQuota{}
	base, repo, _ := newTestDomain(t)
	svc := NewService(Dependencies{
		Repository: base.repo,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
	})
	uploadKey := NormalizedUploadKey([]string{"quota-retry"})
	failed := &model.Resource{
		ID: "resource-failed-retry", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Retry("user-1", failed, "image", "image/png", 7, iotest.ErrReader(errors.New("write failed")))
	if err == nil {
		t.Fatal("expected retry failure")
	}
	if quota.reserved != 0 {
		t.Fatalf("quota reserved = %d, want 0", quota.reserved)
	}
}

func TestRetryRejectsForeignOwnerForgedReady(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"owner-check"})
	failed := &model.Resource{
		ID: "resource-owned", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/owned.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	forged := *failed
	forged.UserID = "user-2"
	forged.Status = model.ResourceStatusReady
	forged.ObjectKey = "users/user-2/image/forged.png"
	if _, err := svc.Retry("user-2", &forged, "image", "image/png", 7, bytes.NewReader([]byte("payload"))); err == nil {
		t.Fatal("foreign retry succeeded")
	}
	latest, err := repo.Resource("resource-owned")
	if err != nil {
		t.Fatal(err)
	}
	if latest.Status != model.ResourceStatusFailed || latest.UserID != "user-1" {
		t.Fatalf("persisted = %#v", latest)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "resources", filepath.FromSlash(failed.ObjectKey))); !os.IsNotExist(err) {
		t.Fatalf("foreign retry published bytes: %v", err)
	}
}

func TestRetryMismatchLeavesFailedUnchanged(t *testing.T) {
	quota := &recordingQuota{}
	base, repo, _ := newTestDomain(t)
	svc := NewService(Dependencies{
		Repository: base.repo,
		Blobs:      base.blobs,
		Quota:      quota,
		Lifecycle:  nopLifecycle{},
	})
	uploadKey := NormalizedUploadKey([]string{"mismatch"})
	failed := &model.Resource{
		ID: "resource-mismatch", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/mismatch.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "previous write failed",
	}
	if err := repo.CreateResource(failed); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Retry("user-1", failed, "image", "image/png", 8, bytes.NewReader([]byte("payload!")))
	if err == nil || !strings.Contains(err.Error(), "上传幂等标识已用于其他文件") {
		t.Fatalf("mismatch error = %v", err)
	}
	latest, lookupErr := repo.Resource("resource-mismatch")
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if latest.Status != model.ResourceStatusFailed {
		t.Fatalf("status = %s, want failed", latest.Status)
	}
	if latest.Error != "previous write failed" {
		t.Fatalf("error rewritten: %q", latest.Error)
	}
	if quota.reserved != 0 {
		t.Fatalf("quota reserved = %d, want 0", quota.reserved)
	}
	recovered, retryErr := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if retryErr != nil {
		t.Fatal(retryErr)
	}
	if recovered.Status != model.ResourceStatusReady || recovered.ID != failed.ID {
		t.Fatalf("recovered = %#v", recovered)
	}
}

func TestRetryOwnedReclaimsStalePendingAfterNewService(t *testing.T) {
	first, repo, dataDir := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"stale-pending"})
	pending := &model.Resource{
		ID: "resource-stale", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/stale.png", MimeType: "text/plain", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(pending); err != nil {
		t.Fatal(err)
	}
	restarted := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
	})
	if restarted.writeSpace() != first.writeSpace() {
		t.Fatalf("restart lock space diverged: %q vs %q", restarted.writeSpace(), first.writeSpace())
	}
	_, stored, storeErr := restarted.Store("user-1", "image", "a.png", "text/plain", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey)
	if stored || storeErr == nil || !strings.Contains(storeErr.Error(), "相同素材正在上传") {
		t.Fatalf("restart Store reclaimed leftover pending: stored=%v err=%v", stored, storeErr)
	}
	recovered, err := restarted.RetryOwned("user-1", pending.ID, "image", "text/plain", 7, bytes.NewReader([]byte("payload")))
	if err != nil {
		t.Fatal(err)
	}
	if recovered.ID != pending.ID || recovered.Status != model.ResourceStatusReady {
		t.Fatalf("recovered = %#v", recovered)
	}
}

func TestStoreDoesNotReclaimPending(t *testing.T) {
	svc, repo, _ := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"store-pending"})
	pending := &model.Resource{
		ID: "resource-store-pending", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/store-pending.png", MimeType: "text/plain", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(pending); err != nil {
		t.Fatal(err)
	}
	_, stored, err := svc.Store("user-1", "image", "a.png", "text/plain", 7, 1, 1, 0, bytes.NewReader([]byte("payload")), uploadKey)
	if err == nil || stored {
		t.Fatalf("store reclaimed pending: stored=%v err=%v", stored, err)
	}
	if !strings.Contains(err.Error(), "相同素材正在上传") {
		t.Fatalf("store error = %v", err)
	}
	latest, lookupErr := repo.Resource(pending.ID)
	if lookupErr != nil {
		t.Fatal(lookupErr)
	}
	if latest.Status != model.ResourceStatusPending {
		t.Fatalf("status = %s, want pending", latest.Status)
	}
}

func TestConcurrentStoreAndRetryDoesNotOverwriteInFlightWrite(t *testing.T) {
	svc, repo, dataDir := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"in-flight"})
	announced := make(chan struct{})
	hold := make(chan struct{})
	var stored *model.Resource
	var storeErr error
	var storeWG sync.WaitGroup
	storeWG.Add(1)
	go func() {
		defer storeWG.Done()
		stored, _, storeErr = svc.Store("user-1", "image", "a.png", "text/plain", 12, 1, 1, 0, &holdFirstRead{
			announced: announced,
			hold:      hold,
			rest:      bytes.NewReader([]byte("first-writer")),
		}, uploadKey)
	}()
	<-announced
	var retried *model.Resource
	var retryErr error
	var retryWG sync.WaitGroup
	retryWG.Add(1)
	go func() {
		defer retryWG.Done()
		pending, err := repo.ResourceByUploadKey("user-1", *uploadKey)
		if err != nil {
			retryErr = err
			return
		}
		retried, retryErr = svc.RetryOwned("user-1", pending.ID, "image", "text/plain", 12, bytes.NewReader([]byte("retry-payload")))
	}()
	close(hold)
	storeWG.Wait()
	retryWG.Wait()
	if storeErr != nil {
		t.Fatalf("store: %v", storeErr)
	}
	if retryErr != nil {
		t.Fatalf("retry: %v", retryErr)
	}
	if stored == nil || retried == nil || stored.ID != retried.ID {
		t.Fatalf("store=%v retry=%v", stored, retried)
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(stored.ObjectKey)))
	if err != nil || string(body) != "first-writer" {
		t.Fatalf("body = %q err=%v", body, err)
	}
	resources, err := repo.Resources("user-1", 10)
	if err != nil || len(resources) != 1 {
		t.Fatalf("resource count = %d err=%v", len(resources), err)
	}
}

func TestTwoHandlesCannotReclaimInFlightPending(t *testing.T) {
	first, repo, dataDir := newTestDomain(t)
	second := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      nopQuota{},
		Lifecycle:  nopLifecycle{},
	})
	if first.writeSpace() != second.writeSpace() {
		t.Fatalf("lock spaces diverged: %q vs %q", first.writeSpace(), second.writeSpace())
	}
	uploadKey := NormalizedUploadKey([]string{"two-handles"})
	announced := make(chan struct{})
	hold := make(chan struct{})
	var stored *model.Resource
	var storeErr error
	var storeWG sync.WaitGroup
	storeWG.Add(1)
	go func() {
		defer storeWG.Done()
		stored, _, storeErr = first.Store("user-1", "image", "a.png", "text/plain", 12, 1, 1, 0, &holdFirstRead{
			announced: announced,
			hold:      hold,
			rest:      bytes.NewReader([]byte("first-writer")),
		}, uploadKey)
	}()
	<-announced
	var retried *model.Resource
	var retryErr error
	var retryWG sync.WaitGroup
	retryWG.Add(1)
	go func() {
		defer retryWG.Done()
		pending, err := repo.ResourceByUploadKey("user-1", *uploadKey)
		if err != nil {
			retryErr = err
			return
		}
		retried, retryErr = second.RetryOwned("user-1", pending.ID, "image", "text/plain", 12, bytes.NewReader([]byte("second-handle")))
	}()
	close(hold)
	storeWG.Wait()
	retryWG.Wait()
	if storeErr != nil {
		t.Fatalf("store: %v", storeErr)
	}
	if retryErr != nil {
		t.Fatalf("retry: %v", retryErr)
	}
	if stored == nil || retried == nil || stored.ID != retried.ID {
		t.Fatalf("store=%v retry=%v", stored, retried)
	}
	body, err := os.ReadFile(filepath.Join(dataDir, "resources", filepath.FromSlash(stored.ObjectKey)))
	if err != nil || string(body) != "first-writer" {
		t.Fatalf("body = %q err=%v", body, err)
	}
	resources, err := repo.Resources("user-1", 10)
	if err != nil || len(resources) != 1 {
		t.Fatalf("resource count = %d err=%v", len(resources), err)
	}
}

func TestFileExtensionMapsWaveMIMEAliasesToWav(t *testing.T) {
	for _, mimeType := range []string{"audio/wave", "audio/wav", "audio/x-wav", "audio/vnd.wave"} {
		if got := FileExtension("", mimeType, "audio"); got != ".wav" {
			t.Fatalf("FileExtension(%q) = %q, want .wav", mimeType, got)
		}
	}
}

func TestNormalizeSingleByteRange(t *testing.T) {
	tests := map[string]string{
		"bytes=0-1023":       "bytes=0-1023",
		"bytes=1024-":        "bytes=1024-",
		"bytes=-2048":        "bytes=-2048",
		"bytes=0-1,10-20":    "",
		"items=0-10":         "",
		"bytes=invalid-1024": "",
	}
	for input, expected := range tests {
		if actual := NormalizeSingleByteRange(input); actual != expected {
			t.Fatalf("NormalizeSingleByteRange(%q) = %q, want %q", input, actual, expected)
		}
	}
}
