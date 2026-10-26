package repository

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newProviderReferenceRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:provider-references-"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.ChannelModel{}); err != nil {
		t.Fatal(err)
	}
	return New(db)
}

// TestTaskProviderReferencesKeepsOnlyRetrievableWork pins which tasks still need
// the protocol they were submitted with. Anything else must not keep a retired
// plugin alive.
func TestTaskProviderReferencesKeepsOnlyRetrievableWork(t *testing.T) {
	repo := newProviderReferenceRepo(t)
	now := time.Now().UTC()
	tasks := []model.Task{
		{ID: "queued", UserID: "u", Provider: "queued-protocol", Status: model.TaskStatusQueued, CreatedAt: now, UpdatedAt: now},
		{ID: "running", UserID: "u", Provider: "queued-protocol", Status: model.TaskStatusRunning, CreatedAt: now, UpdatedAt: now},
		{ID: "succeeded", UserID: "u", Provider: "finished-protocol", Status: model.TaskStatusSucceeded, ProviderRequestID: "up-1", CreatedAt: now, UpdatedAt: now},
		{ID: "failed-unsent", UserID: "u", Provider: "unsent-protocol", Status: model.TaskStatusFailed, CreatedAt: now, UpdatedAt: now},
		{ID: "failed-upstream", UserID: "u", Provider: "recoverable-protocol", Status: model.TaskStatusFailed, ProviderRequestID: "up-2", CreatedAt: now, UpdatedAt: now},
		{ID: "cancelled-open", UserID: "u", Provider: "cancelling-protocol", Status: model.TaskStatusCancelled, ProviderRequestID: "up-3", ProviderCancelStatus: model.ProviderCancelStatusRequested, CreatedAt: now, UpdatedAt: now},
		{ID: "cancelled-done", UserID: "u", Provider: "cancelled-protocol", Status: model.TaskStatusCancelled, ProviderRequestID: "up-4", ProviderCancelStatus: model.ProviderCancelStatusConfirmed, CreatedAt: now, UpdatedAt: now},
		{ID: "text-replay", UserID: "u", Provider: "text-protocol", Status: model.TaskStatusTextReplay, CreatedAt: now, UpdatedAt: now},
	}
	for index := range tasks {
		if err := repo.Create(&tasks[index]); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := repo.TaskProviderReferences()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{
		"queued-protocol":      2,
		"recoverable-protocol": 1,
		"cancelling-protocol":  1,
	}
	if len(counts) != len(want) {
		t.Fatalf("task references = %#v want %#v", counts, want)
	}
	for id, total := range want {
		if counts[id] != total {
			t.Fatalf("task reference %q = %d want %d (all: %#v)", id, counts[id], total, counts)
		}
	}
}

// TestChannelModelProtocolReferencesIgnoresRemovedRows keeps the audit on the
// channel models that still exist.
func TestChannelModelProtocolReferencesIgnoresRemovedRows(t *testing.T) {
	repo := newProviderReferenceRepo(t)
	now := time.Now().UTC()
	rows := []model.ChannelModel{
		{ID: "m1", ChannelID: "c1", ModelKey: "a", Protocol: model.ChannelInterfaceNewAPIVideo, CreatedAt: now, UpdatedAt: now},
		{ID: "m2", ChannelID: "c1", ModelKey: "b", Protocol: model.ChannelInterfaceNewAPIVideo, CreatedAt: now, UpdatedAt: now},
		{ID: "m3", ChannelID: "c2", ModelKey: "c", Protocol: model.ChannelInterfaceXAIVideo, CreatedAt: now, UpdatedAt: now},
		{ID: "m4", ChannelID: "c2", ModelKey: "d", Protocol: "", CreatedAt: now, UpdatedAt: now},
		{ID: "m5", ChannelID: "c3", ModelKey: "e", Protocol: model.ChannelInterfaceXAIVideo, CreatedAt: now, UpdatedAt: now, DeletedAt: gorm.DeletedAt{Time: now, Valid: true}},
	}
	for index := range rows {
		if err := repo.Create(&rows[index]); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := repo.ChannelModelProtocolReferences()
	if err != nil {
		t.Fatal(err)
	}
	if counts[string(model.ChannelInterfaceNewAPIVideo)] != 2 || counts[string(model.ChannelInterfaceXAIVideo)] != 1 || len(counts) != 2 {
		t.Fatalf("channel model references = %#v", counts)
	}
}
