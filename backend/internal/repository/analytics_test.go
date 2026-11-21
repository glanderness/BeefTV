package repository

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestLatestProviderRequestIDForTaskIgnoresFailedCreateTraceIDs(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:api-log-provider-request-id?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	entries := []model.ApiCallLog{
		{
			ID:                "failed-create-1",
			TaskID:            "task-rejected",
			RequestKind:       "create",
			Status:            model.ApiCallStatusFailed,
			ProviderRequestID: "req-trace-rejected-1",
			CreatedAt:         now,
		},
		{
			ID:                "failed-empty-kind-1",
			TaskID:            "task-rejected",
			RequestKind:       "",
			Status:            model.ApiCallStatusFailed,
			ProviderRequestID: "req-trace-rejected-2",
			CreatedAt:         now.Add(time.Second),
		},
		{
			ID:                "accepted-create-1",
			TaskID:            "task-accepted",
			RequestKind:       "create",
			Status:            model.ApiCallStatusSucceeded,
			ProviderRequestID: "job-accepted-1",
			CreatedAt:         now.Add(2 * time.Second),
		},
		{
			ID:                "failed-poll-1",
			TaskID:            "task-poll-only",
			RequestKind:       "poll",
			Status:            model.ApiCallStatusFailed,
			ProviderRequestID: "job-polled-1",
			CreatedAt:         now.Add(3 * time.Second),
		},
	}
	if err := db.Create(&entries).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	if got, _ := repo.LatestProviderRequestIDForTask("task-rejected"); got != "" {
		t.Fatalf("LatestProviderRequestIDForTask(task-rejected) = %q, want empty", got)
	}
	if got, err := repo.LatestProviderRequestIDForTask("task-accepted"); err != nil || got != "job-accepted-1" {
		t.Fatalf("LatestProviderRequestIDForTask(task-accepted) = (%q, %v), want job-accepted-1", got, err)
	}
	if got, err := repo.LatestProviderRequestIDForTask("task-poll-only"); err != nil || got != "job-polled-1" {
		t.Fatalf("LatestProviderRequestIDForTask(task-poll-only) = (%q, %v), want job-polled-1", got, err)
	}
}
