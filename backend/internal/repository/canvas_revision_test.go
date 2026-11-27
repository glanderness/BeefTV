package repository

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestCanvasRevision(t *testing.T) {
	t.Run("sqlite", func(t *testing.T) {
		db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "canvas.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if err != nil {
			t.Fatal(err)
		}
		sqlDB, _ := db.DB()
		sqlDB.SetMaxOpenConns(1)
		t.Cleanup(func() { _ = sqlDB.Close() })
		testCanvasRevision(t, db)
	})
}

func testCanvasRevision(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.CanvasUnitLink{}, &model.Project{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	initial := model.CanvasProject{ID: "canvas", UserID: "owner", Title: "initial", PayloadJSON: `{"nodes":[{"id":"old"}]}`}
	if err := repo.UpsertCanvasProject(&initial); err != nil {
		t.Fatal(err)
	}
	if initial.Revision != 1 {
		t.Fatalf("initial revision = %d", initial.Revision)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, title := range []string{"editor A", "editor B"} {
		workers.Add(1)
		go func(title string) {
			defer workers.Done()
			copy := initial
			copy.Title = title
			copy.PayloadJSON = fmt.Sprintf(`{"nodes":[{"id":%q}]}`, title)
			<-start
			results <- repo.UpsertCanvasProject(&copy)
		}(title)
	}
	close(start)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrCanvasRevisionConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	winner, err := repo.CanvasProjectForUser("owner", initial.ID)
	if err != nil {
		t.Fatal(err)
	}
	if winner.Revision != 2 {
		t.Fatalf("winner revision = %d", winner.Revision)
	}
	old := initial
	old.UpdatedAt = time.Now().Add(time.Hour)
	if err := repo.UpsertCanvasProject(&old); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("stale write = %v", err)
	}
	wrongOwner := *winner
	wrongOwner.UserID = "another-user"
	if err := repo.UpsertCanvasProject(&wrongOwner); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("wrong owner = %v", err)
	}
	createCollision := initial
	createCollision.Revision = 0
	if err := repo.UpsertCanvasProject(&createCollision); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("create collision = %v", err)
	}
	stored, _ := repo.CanvasProjectForUser("owner", initial.ID)
	if stored.PayloadJSON != winner.PayloadJSON || stored.Revision != 2 {
		t.Fatal("rejected save changed the canvas")
	}

	if err := repo.AssignCanvasToProject("owner", initial.ID, "project"); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertCanvasProject(winner); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("association did not invalidate old content: %v", err)
	}
	if err := repo.UnassignCanvasFromProject("owner", "project", initial.ID, `{"nodes":[]}`, time.Now(), 2); err == nil {
		t.Fatal("stale unassignment replaced canvas content")
	}
	stored, _ = repo.CanvasProjectForUser("owner", initial.ID)
	if stored.PayloadJSON != winner.PayloadJSON || stored.Revision != 3 {
		t.Fatal("stale unassignment changed the canvas")
	}
	if err := db.Delete(&model.CanvasProject{}, "id = ?", initial.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertCanvasProject(stored); !errors.Is(err, ErrCanvasRevisionConflict) {
		t.Fatalf("deleted canvas was recreated: %v", err)
	}
	t.Run("history", func(t *testing.T) { testCanvasHistory(t, db) })
}

func TestDeleteCanvasProjectDurableTombstoneBlocksLateRevisionZeroAcrossRestart(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "tombstone.db")
	openDB := func() *gorm.DB {
		db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if err != nil {
			t.Fatal(err)
		}
		sqlDB, _ := db.DB()
		sqlDB.SetMaxOpenConns(1)
		return db
	}

	db1 := openDB()
	if err := db1.AutoMigrate(
		&model.CanvasProject{},
		&model.CanvasSnapshot{},
		&model.CanvasSnapshotResource{},
		&model.CanvasUnitLink{},
		&model.SystemSetting{},
	); err != nil {
		t.Fatal(err)
	}
	repo1 := New(db1)

	// Case 1: Existing canvas deleted -> late revision=0 create must fail before AND after restart.
	project := model.CanvasProject{ID: "canvas-zombie", UserID: "owner", Title: "draft", PayloadJSON: `{"nodes":[]}`}
	if err := repo1.UpsertCanvasProject(&project); err != nil {
		t.Fatal(err)
	}
	if err := repo1.DeleteCanvasProject("owner", "canvas-zombie"); err != nil {
		t.Fatal(err)
	}
	// Case 2: Delete arrives BEFORE initial revision=0 create (never persisted row) -> tombstone still blocks late create.
	if err := repo1.DeleteCanvasProject("owner", "canvas-raced-before-create"); err != nil {
		t.Fatal(err)
	}
	sqlDB1, _ := db1.DB()
	if err := sqlDB1.Close(); err != nil {
		t.Fatal(err)
	}

	// Simulate full backend restart by opening a brand new DB connection & Repository.
	db2 := openDB()
	sqlDB2, _ := db2.DB()
	t.Cleanup(func() { _ = sqlDB2.Close() })
	repo2 := New(db2)

	for _, id := range []string{"canvas-zombie", "canvas-raced-before-create"} {
		late := model.CanvasProject{ID: id, UserID: "owner", Title: "resurrected", PayloadJSON: `{"nodes":[]}`, Revision: 0}
		err := repo2.UpsertCanvasProject(&late)
		if !errors.Is(err, ErrCanvasProjectDeleted) || !errors.Is(err, ErrCanvasRevisionConflict) {
			t.Fatalf("late revision=0 create for deleted %q returned %v, want ErrCanvasProjectDeleted/ErrCanvasRevisionConflict", id, err)
		}
		if _, lookupErr := repo2.CanvasProjectForUser("owner", id); !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			t.Fatalf("deleted canvas %q resurrected in DB: err=%v", id, lookupErr)
		}
	}

	// Other user or other ID is unaffected.
	other := model.CanvasProject{ID: "canvas-fresh", UserID: "owner", Title: "fresh", PayloadJSON: `{"nodes":[]}`, Revision: 0}
	if err := repo2.UpsertCanvasProject(&other); err != nil || other.Revision != 1 {
		t.Fatalf("fresh canvas create failed: rev=%d err=%v", other.Revision, err)
	}

	// Explicit recycle-bin restore clears tombstone and permits recreate.
	if err := repo2.ClearDeletedCanvasProjectTombstone("owner", "canvas-zombie"); err != nil {
		t.Fatal(err)
	}
	restored := model.CanvasProject{ID: "canvas-zombie", UserID: "owner", Title: "restored", PayloadJSON: `{"nodes":[]}`, Revision: 0}
	if err := repo2.UpsertCanvasProject(&restored); err != nil || restored.Revision != 1 {
		t.Fatalf("explicit restore after clearing tombstone failed: rev=%d err=%v", restored.Revision, err)
	}
}
