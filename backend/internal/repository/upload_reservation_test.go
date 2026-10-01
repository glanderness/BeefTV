package repository

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newUploadReservationRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "upload.db")+"?_busy_timeout=5000&_foreign_keys=on"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}); err != nil {
		t.Fatal(err)
	}
	return New(db)
}

func TestReserveIdentifiedDailyUploadMapsUniqueToConflict(t *testing.T) {
	repo := newUploadReservationRepo(t)
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", "same-id", 7, 1000); err != nil {
		t.Fatal(err)
	}
	err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", "same-id", 7, 1000)
	if !errors.Is(err, ErrUploadReservationConflict) {
		t.Fatalf("duplicate reserve err=%v", err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("daily=%d err=%v", usage, err)
	}
}

func TestSaveResourceReadyClearsWitnessAndKeepsDaily(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "ready-id"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-ready", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/a.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	resource.Status = model.ResourceStatusReady
	if err := repo.SaveResource(resource); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("witness leftover %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("daily=%d err=%v", usage, err)
	}
}

func TestSaveResourceFailedReleasesWitness(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "failed-id"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-failed", UserID: "user-1", Kind: "image", Status: model.ResourceStatusPending,
		Provider: "local", ObjectKey: "users/user-1/image/b.png", Size: 7, UploadKey: &identity,
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	resource.Status = model.ResourceStatusFailed
	resource.Error = "write failed"
	if err := repo.SaveResource(resource); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("witness leftover %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 0 {
		t.Fatalf("daily=%d err=%v", usage, err)
	}
}

func TestDeleteReadyResourceDoesNotRefundDaily(t *testing.T) {
	repo := newUploadReservationRepo(t)
	identity := "delete-ready"
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", identity, 7, 1000); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{
		ID: "res-delete", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: "users/user-1/image/c.png", Size: 7, UploadKey: &identity,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
	row, err := repo.UploadReservation("user-1", identity)
	if err != nil || row != nil {
		t.Fatalf("witness leftover %#v err=%v", row, err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 7 {
		t.Fatalf("delete refunded daily=%d err=%v", usage, err)
	}
}

func TestReleaseIdentifiedDailyUploadMissingRowIsNoop(t *testing.T) {
	repo := newUploadReservationRepo(t)
	if err := repo.ReserveIdentifiedDailyUpload("user-1", "2026-10-02", "held", 11, 1000); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReleaseIdentifiedDailyUpload("user-1", "2026-10-02", "missing", 11); err != nil {
		t.Fatal(err)
	}
	usage, err := repo.DailyUploadBytes("user-1", "2026-10-02")
	if err != nil || usage != 11 {
		t.Fatalf("missing identity released other daily=%d err=%v", usage, err)
	}
}
