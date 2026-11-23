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
	resWhitespace := model.Resource{ID: "res-space", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/3.png", CreatedAt: now, UpdatedAt: now}
	resBare := model.Resource{ID: "res-bare", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/4.png", CreatedAt: now, UpdatedAt: now}
	resNoSlash := model.Resource{ID: "res-noslash", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/5.png", CreatedAt: now, UpdatedAt: now}
	resCreationRun := model.Resource{ID: "res-run", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/6.png", CreatedAt: now, UpdatedAt: now}
	for _, res := range []model.Resource{resUnicode, resSlash, resWhitespace, resBare, resNoSlash, resCreationRun} {
		if err := db.Create(&res).Error; err != nil {
			t.Fatal(err)
		}
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
	if err := db.Create(&model.Asset{ID: "a-space", UserID: "u1", Title: "space", PayloadJSON: `{"storageKey":"  resource:  res-space  "}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Asset{ID: "a-bare", UserID: "u1", Title: "bare", PayloadJSON: `{"referenceResourceIds":["other","res-bare"]}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasProject{ID: "c-noslash", UserID: "u1", Title: "noslash", PayloadJSON: `{"nodes":[{"url":"/api/resources/res-noslash"}]}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CreationRun{ID: "run-1", UserID: "u1", StateJSON: `{"storageKey":"resource:res-run"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		res  model.Resource
	}{
		{"unicode-escaped task_log", resUnicode},
		{"slash-escaped result", resSlash},
		{"whitespace-padded asset locator", resWhitespace},
		{"bare referenceResourceIds asset", resBare},
		{"no-trailing-slash canvas url", resNoSlash},
		{"creation_run state_json", resCreationRun},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := repo.DeleteDetachedResources([]model.Resource{tc.res}, nil); err != ErrResourceCleanupStillReferenced {
				t.Fatalf("DeleteDetachedResources(%s) = %v, want ErrResourceCleanupStillReferenced", tc.name, err)
			}
		})
	}
	snapshot, err := repo.ResourceReferenceSnapshot("u1", "", []string{resUnicode.ID, resSlash.ID, resWhitespace.ID, resBare.ID, resNoSlash.ID, resCreationRun.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Documents) < 6 {
		t.Fatalf("expected snapshot to include all 6 semantic reference documents, got %d", len(snapshot.Documents))
	}
}

func TestDeleteDetachedResourcesWatermarkInvalidatesOnConcurrentWrite(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "wm.db")+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })

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
		&model.UserUploadReservation{},
	); err != nil {
		t.Fatal(err)
	}

	repo := New(db)
	repo.SetSingleProcess(true)
	now := time.Now().Add(-48 * time.Hour)
	resA := model.Resource{ID: "res-wm-a", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/a.png", CreatedAt: now, UpdatedAt: now}
	resB := model.Resource{ID: "res-wm-b", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/b.png", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resA).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&resB).Error; err != nil {
		t.Fatal(err)
	}

	// Snapshot before any canvas references resA or resB: watermark must be valid.
	snap1, err := repo.ResourceReferenceSnapshot("u1", "", []string{resA.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !snap1.Watermark.Valid {
		t.Fatalf("expected valid SQLite snapshot watermark, got %+v", snap1.Watermark)
	}

	// Simulate a concurrent write attaching resA AFTER the snapshot was taken.
	if err := db.Create(&model.CanvasProject{
		ID: "canvas-race", UserID: "u1", Title: "race",
		PayloadJSON: `{"nodes":[{"storageKey":"resource:res-wm-a"}]}`,
		CreatedAt:   now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Passing the stale watermark MUST detect the write and refuse to delete resA.
	if err := repo.DeleteDetachedResources([]model.Resource{resA}, nil, snap1.Watermark); err != ErrResourceCleanupStillReferenced {
		t.Fatalf("DeleteDetachedResources with stale watermark = %v, want ErrResourceCleanupStillReferenced", err)
	}

	// Now take a fresh snapshot for resB with no intervening writes; watermark
	// matches inside BEGIN IMMEDIATE and resB is cleanly deleted.
	snap2, err := repo.ResourceReferenceSnapshot("u1", "", []string{resB.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resB}, nil, snap2.Watermark); err != nil {
		t.Fatalf("DeleteDetachedResources with fresh watermark failed: %v", err)
	}
	var countA, countB int64
	_ = db.Model(&model.Resource{}).Where("id = ?", resA.ID).Count(&countA).Error
	_ = db.Model(&model.Resource{}).Where("id = ?", resB.ID).Count(&countB).Error
	if countA != 1 || countB != 0 {
		t.Fatalf("resource counts after watermark tests: resA=%d resB=%d, want 1 and 0", countA, countB)
	}
}
