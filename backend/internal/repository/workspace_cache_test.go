package repository

import (
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestRepositoryCachesImmutableDefaultWorkspace(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "ws.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Workspace{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := db.Create(&model.Workspace{ID: "ws-default", Name: "本地工作区", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Workspace{ID: "ws-other", Name: "Other", CreatedAt: now.Add(time.Second), UpdatedAt: now.Add(time.Second)}).Error; err != nil {
		t.Fatal(err)
	}

	var queries atomic.Int64
	if err := db.Callback().Query().After("gorm:query").Register("test:count_workspace_queries", func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "workspaces" {
			queries.Add(1)
		}
	}); err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	first, err := repo.DefaultWorkspace()
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "ws-default" {
		t.Fatalf("default workspace = %q, want ws-default", first.ID)
	}
	if got := queries.Load(); got != 1 {
		t.Fatalf("queries after first DefaultWorkspace = %d, want 1", got)
	}

	// Mutating the returned copy must not corrupt the cached workspace.
	first.Name = "mutated"

	second, err := repo.DefaultWorkspace()
	if err != nil {
		t.Fatal(err)
	}
	byID, err := repo.Workspace("ws-default")
	if err != nil {
		t.Fatal(err)
	}
	ctxByID, err := repo.WithContext(t.Context()).Workspace("ws-default")
	if err != nil {
		t.Fatal(err)
	}
	if second.Name != "本地工作区" || byID.Name != "本地工作区" || ctxByID.Name != "本地工作区" {
		t.Fatalf("cached workspace corrupted: %q / %q / %q", second.Name, byID.Name, ctxByID.Name)
	}
	if got := queries.Load(); got != 1 {
		t.Fatalf("queries after cached lookups = %d, want 1", got)
	}

	// Non-default workspace IDs still query SQLite normally.
	other, err := repo.Workspace("ws-other")
	if err != nil {
		t.Fatal(err)
	}
	if other.ID != "ws-other" || queries.Load() != 2 {
		t.Fatalf("non-default lookup = %q (queries=%d), want ws-other (queries=2)", other.ID, queries.Load())
	}
}

func TestSQLiteReferenceFilterPreservesEscapedTaskLogAndResultReferences(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "refs.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Resource{},
		&model.Asset{},
		&model.AssetVersion{},
		&model.AssetRepresentation{},
		&model.CanvasProject{},
		&model.CanvasSnapshot{},
		&model.CanvasSnapshotResource{},
		&model.CanvasWorkflowResource{},
		&model.CanvasDrawing{},
		&model.CanvasLibraryFolder{},
		&model.Project{},
		&model.ProjectAssetCandidate{},
		&model.AgentOpRecord{},
		&model.StyleProfile{},
		&model.VoiceProfile{},
		&model.Shot{},
		&model.ShotArtifact{},
		&model.WorkflowInstance{},
		&model.WorkflowStepInstance{},
		&model.CreationRun{},
		&model.CreationSubmission{},
		&model.Task{},
		&model.TaskLog{},
		&model.Result{},
		&model.ArkPrivateAssetBinding{},
		&model.ResourceDeletionJob{},
	); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	now := time.Now().Add(-48 * time.Hour)
	resUnicode := model.Resource{ID: "res-unicode", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/1.png", CreatedAt: now, UpdatedAt: now}
	resSlash := model.Resource{ID: "res-slash", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/2.png", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resUnicode).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&resSlash).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "t1", UserID: "u1", Type: "image", Status: model.TaskStatusSucceeded, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.TaskLog{ID: "l1", UserID: "u1", TaskID: "t1", Level: "info", Message: "escaped", Payload: `{"storageKey":"resource\u003ares-unicode"}`, CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Result{ID: "r1", UserID: "u1", TaskID: "t1", Kind: "image", Payload: `{"url":"\/api\/resources\/res-slash\/file"}`, CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}

	if err := repo.DeleteDetachedResources([]model.Resource{resUnicode}, nil); err != ErrResourceCleanupStillReferenced {
		t.Fatalf("unicode-escaped task_log reference error = %v, want ErrResourceCleanupStillReferenced", err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resSlash}, nil); err != ErrResourceCleanupStillReferenced {
		t.Fatalf("slash-escaped result reference error = %v, want ErrResourceCleanupStillReferenced", err)
	}
	snapshot, err := repo.ResourceReferenceSnapshot("u1", "", []string{resUnicode.ID, resSlash.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Documents) < 2 {
		t.Fatalf("expected snapshot to include escaped task_log and result documents, got %d", len(snapshot.Documents))
	}
}
