package asset

import (
	"bytes"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type repoQuota struct {
	repo *repository.Repository
}

func (q repoQuota) ReserveUpload(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveChunked(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveRetry(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveGenerated(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) ReserveGeneratedRetry(userID string, size int64, identity string) (string, error) {
	return q.reserve(userID, size, identity)
}
func (q repoQuota) Release(userID, day string, size int64, identity string) {
	_ = q.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size)
}
func (q repoQuota) ReleaseRetry(userID, day string, size int64, identity string) {
	_ = q.repo.ReleaseIdentifiedDailyUpload(userID, day, identity, size)
}
func (q repoQuota) Commit(userID string, _ int64, identity string) {
	_ = q.repo.ClearUploadReservation(userID, identity)
}

func (q repoQuota) reserve(userID string, size int64, identity string) (string, error) {
	day := time.Now().UTC().Format("2006-01-02")
	if err := q.repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, 1<<40); err != nil {
		return "", err
	}
	return day, nil
}

func newRepoQuotaDomain(t *testing.T) (*Service, *repository.Repository, string) {
	t.Helper()
	_, repo, dataDir := newTestDomain(t)
	svc := NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
	return svc, repo, dataDir
}

func plantReservation(t *testing.T, repo *repository.Repository, userID, identity string, size int64) string {
	t.Helper()
	day := time.Now().UTC().Format("2006-01-02")
	if err := repo.ReserveIdentifiedDailyUpload(userID, day, identity, size, 1<<40); err != nil {
		t.Fatal(err)
	}
	return day
}

func restartDomain(t *testing.T, repo *repository.Repository, dataDir string) *Service {
	t.Helper()
	return NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})
}

func TestLeftoverReadyRestartDeleteKeepsDaily(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"ready-left"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	resource := model.Resource{
		ID: "res-ready-left", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/ready-left.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}

	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("after restart daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("READY leftover witness %#v err=%v", row, err)
	}

	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	restartDomain(t, repo, dataDir)
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("delete then restart refunded daily=%d err=%v", usage, err)
	}
}

func TestLeftoverReadyDeleteBeforeRestartKeepsDaily(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"ready-delete-first"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	resource := model.Resource{
		ID: "res-ready-delete-first", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/ready-delete-first.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("delete-before-restart refunded daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("delete-before-restart witness %#v err=%v", row, err)
	}
}

func TestLeftoverFailedRestartRetrySucceeds(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"failed-left"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	failed := model.Resource{
		ID: "res-failed-left", UserID: "user-1", Kind: "image", Status: model.ResourceStatusFailed,
		Provider: "local", ObjectKey: "users/user-1/image/failed-left.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey, Error: "write failed",
	}
	if err := repo.CreateResource(&failed); err != nil {
		t.Fatal(err)
	}

	svc := restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("FAILED leftover daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row != nil {
		t.Fatalf("FAILED leftover witness %#v err=%v", row, err)
	}

	got, err := svc.RetryOwned("user-1", failed.ID, "image", "image/png", 7, bytes.NewReader([]byte("payload")))
	if err != nil || got == nil || got.Status != model.ResourceStatusReady {
		t.Fatalf("retry after FAILED leftover = %#v err=%v", got, err)
	}
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("retry daily=%d err=%v", usage, err)
	}
}

func TestSameKeyReuploadAfterDelete(t *testing.T) {
	svc, repo, _ := newRepoQuotaDomain(t)
	first, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "reuse-key")
	if err != nil || first == nil {
		t.Fatalf("first = %#v err=%v", first, err)
	}
	if err := repo.DeleteResource("user-1", first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "reuse-key")
	if err != nil || second == nil || second.ID == first.ID {
		t.Fatalf("reupload after delete = %#v err=%v first=%s", second, err, first.ID)
	}
}

func TestPendingRestartRetainsWitness(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	uploadKey := NormalizedUploadKey([]string{"pending-keep"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	pending := model.Resource{
		ID: "res-pending-keep", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/pending-keep.png", MimeType: "image/png", Size: 7,
		UploadKey: uploadKey,
	}
	if err := repo.CreateResource(&pending); err != nil {
		t.Fatal(err)
	}

	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("PENDING restart daily=%d err=%v", usage, err)
	}
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil {
		t.Fatalf("PENDING witness released %#v err=%v", row, err)
	}
}

type holdCreateRepo struct {
	Repository
	announced chan struct{}
	hold      chan struct{}
	once      sync.Once
}

func (r *holdCreateRepo) CreateResource(resource *model.Resource) error {
	r.once.Do(func() {
		close(r.announced)
		<-r.hold
	})
	return r.Repository.CreateResource(resource)
}

func TestDuplicateLiveUploadFileReturnsUploadInProgress(t *testing.T) {
	_, repo, dataDir := newTestDomain(t)
	announced := make(chan struct{})
	hold := make(chan struct{})
	svc := NewService(Dependencies{
		Repository: &holdCreateRepo{Repository: NewRepository(repo), announced: announced, hold: hold},
		Blobs:      NewFileStore(dataDir),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
		DataDir:    dataDir,
	})

	var first *model.Resource
	var firstErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		first, firstErr = svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "live-dup")
	}()
	<-announced
	_, dupErr := svc.UploadFile("user-1", "a.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "live-dup")
	if !isAppError(dupErr, UploadInProgress()) {
		t.Fatalf("duplicate live err=%v", dupErr)
	}
	close(hold)
	<-done
	if firstErr != nil || first == nil || first.Status != model.ResourceStatusReady {
		t.Fatalf("first upload = %#v err=%v", first, firstErr)
	}
}

func TestEmptyDataDirSkipsReservationRecovery(t *testing.T) {
	_, repo, _ := newTestDomain(t)
	uploadKey := NormalizedUploadKey([]string{"no-datadir"})
	day := plantReservation(t, repo, "user-1", *uploadKey, 7)
	NewService(Dependencies{
		Repository: NewRepository(repo),
		Blobs:      NewFileStore(t.TempDir()),
		Quota:      repoQuota{repo: repo},
		Lifecycle:  nopLifecycle{},
	})
	row, err := repo.UploadReservation("user-1", *uploadKey)
	if err != nil || row == nil {
		t.Fatalf("empty DataDir recovered witness %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 7 {
		t.Fatalf("empty DataDir daily=%d err=%v", usage, err)
	}
}

func TestMissingResourceOrphanReleasesOnce(t *testing.T) {
	_, repo, dataDir := newRepoQuotaDomain(t)
	identity := *NormalizedUploadKey([]string{"orphan-missing"})
	day := plantReservation(t, repo, "user-1", identity, 7)
	restartDomain(t, repo, dataDir)
	usage, err := repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("missing resource daily=%d err=%v", usage, err)
	}
	restartDomain(t, repo, dataDir)
	usage, err = repo.DailyUploadBytes("user-1", day)
	if err != nil || usage != 0 {
		t.Fatalf("second restart changed daily=%d err=%v", usage, err)
	}
}
