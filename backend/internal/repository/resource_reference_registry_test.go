package repository

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func openFullSingleConnSQLiteRepo(t *testing.T, dbPath string) (*gorm.DB, *Repository) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(dbPath+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
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
		&model.ProjectAssetLink{},
		&model.ProjectAssetCandidate{},
		&model.CharacterVoiceBinding{},
		&model.ShotAssetReference{},
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
	return db, repo
}

func TestSQLiteReferenceFilterPreservesEscapedTaskLogAndResultReferences(t *testing.T) {
	db, repo := openFullSingleConnSQLiteRepo(t, filepath.Join(t.TempDir(), "refs.db"))
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
			if err := repo.DeleteDetachedResources([]model.Resource{tc.res}, nil); !errors.Is(err, ErrResourceCleanupStillReferenced) {
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
	dbPath := filepath.Join(t.TempDir(), "wm.db")
	db, repo := openFullSingleConnSQLiteRepo(t, dbPath)
	now := time.Now().Add(-48 * time.Hour)
	resA := model.Resource{ID: "res-wm-a", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/a.png", CreatedAt: now, UpdatedAt: now}
	resB := model.Resource{ID: "res-wm-b", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/b.png", CreatedAt: now, UpdatedAt: now}
	resRef := model.Resource{ID: "res-wm-ref", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/ref.png", CreatedAt: now, UpdatedAt: now}
	resExt := model.Resource{ID: "res-wm-ext", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/ext.png", CreatedAt: now, UpdatedAt: now}
	resIdle := model.Resource{ID: "res-wm-idle", UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/idle.png", CreatedAt: now, UpdatedAt: now}
	for _, res := range []model.Resource{resA, resB, resRef, resExt, resIdle} {
		if err := db.Create(&res).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&model.Asset{
		ID: "asset-owner", UserID: "u1", Title: "owner",
		PayloadJSON: `{"storageKey":"resource:res-wm-ref"}`,
		CreatedAt:   now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// 1. Cross-resource watermark rejection: snapA covers ONLY resA, while resRef
	// is already referenced by asset-owner. Passing snapA.Watermark to delete
	// resRef MUST NOT bypass atomic guards even when no writes intervened.
	snapA, err := repo.ResourceReferenceSnapshot("u1", "", []string{resA.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !snapA.Watermark.valid {
		t.Fatalf("expected valid SQLite snapshot watermark, got %+v", snapA.Watermark)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resRef}, nil, snapA.Watermark); !errors.Is(err, ErrResourceCleanupStillReferenced) {
		t.Fatalf("cross-resource watermark delete = %v, want ErrResourceCleanupStillReferenced", err)
	}

	// 2. Excluding-asset snapshot (single or multiple excluded IDs) MUST NOT
	// produce a valid watermark for detached cleanup.
	snapExcl, err := repo.ResourceReferenceSnapshot("u1", "asset-owner", []string{resRef.ID})
	if err != nil {
		t.Fatal(err)
	}
	if snapExcl.Watermark.valid || snapExcl.Watermark.covers([]model.Resource{resRef}) {
		t.Fatalf("expected invalid watermark when excludingAssetID is set, got %+v", snapExcl.Watermark)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resRef}, nil, snapExcl.Watermark); !errors.Is(err, ErrResourceCleanupStillReferenced) {
		t.Fatalf("excluding-asset watermark delete = %v, want ErrResourceCleanupStillReferenced", err)
	}
	snapMultiExcl, err := repo.ResourceReferenceSnapshotExcluding("u1", []string{"asset-owner", "asset-twin"}, []string{resRef.ID})
	if err != nil {
		t.Fatal(err)
	}
	if snapMultiExcl.Watermark.valid || snapMultiExcl.Watermark.covers([]model.Resource{resRef}) {
		t.Fatalf("expected invalid watermark when multiple excludingAssetIDs are set, got %+v", snapMultiExcl.Watermark)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resRef}, nil, snapMultiExcl.Watermark); !errors.Is(err, ErrResourceCleanupStillReferenced) {
		t.Fatalf("multi-excluding-asset watermark delete = %v, want ErrResourceCleanupStillReferenced", err)
	}

	// 3. Same-connection concurrent write after snapshot MUST return
	// ErrResourceCleanupSnapshotStale immediately without deleting resA.
	if err := db.Create(&model.CanvasProject{
		ID: "canvas-race", UserID: "u1", Title: "race",
		PayloadJSON: `{"nodes":[{"storageKey":"resource:res-wm-a"}]}`,
		CreatedAt:   now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resA}, nil, snapA.Watermark); !errors.Is(err, ErrResourceCleanupSnapshotStale) {
		t.Fatalf("DeleteDetachedResources with stale watermark = %v, want ErrResourceCleanupSnapshotStale", err)
	}

	// 4. External-connection write (another SQLite handle) MUST also be detected
	// via PRAGMA data_version and return ErrResourceCleanupSnapshotStale.
	snapExt, err := repo.ResourceReferenceSnapshot("u1", "", []string{resExt.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !snapExt.Watermark.valid {
		t.Fatalf("expected valid watermark before external write")
	}
	extDB, err := gorm.Open(sqlite.Open(dbPath+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	extSQLDB, _ := extDB.DB()
	t.Cleanup(func() { _ = extSQLDB.Close() })
	if err := extDB.Create(&model.CanvasProject{
		ID: "canvas-ext-race", UserID: "u1", Title: "ext",
		PayloadJSON: `{"nodes":[{"storageKey":"resource:res-wm-ext"}]}`,
		CreatedAt:   now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resExt}, nil, snapExt.Watermark); !errors.Is(err, ErrResourceCleanupSnapshotStale) {
		t.Fatalf("DeleteDetachedResources after external write = %v, want ErrResourceCleanupSnapshotStale", err)
	}

	// 5. Fresh watermark with no intervening writes cleanly deletes resB.
	snapB, err := repo.ResourceReferenceSnapshot("u1", "", []string{resB.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteDetachedResources([]model.Resource{resB}, nil, snapB.Watermark); err != nil {
		t.Fatalf("DeleteDetachedResources with fresh watermark failed: %v", err)
	}

	// 6. Idle connection with total_changes() == 0 (freshly opened desktop DB
	// before any writes) MUST still capture a valid watermark and fast-path delete.
	idleDB, err := gorm.Open(sqlite.Open(dbPath+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	idleSQLDB, err := idleDB.DB()
	if err != nil {
		t.Fatal(err)
	}
	idleSQLDB.SetMaxOpenConns(1)
	idleSQLDB.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = idleSQLDB.Close() })
	idleRepo := New(idleDB)
	idleRepo.SetSingleProcess(true)

	snapIdle, err := idleRepo.ResourceReferenceSnapshot("u1", "", []string{resIdle.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !snapIdle.Watermark.valid || snapIdle.Watermark.totalChanges != 0 {
		t.Fatalf("expected valid idle watermark with totalChanges=0, got %+v", snapIdle.Watermark)
	}
	if err := idleRepo.DeleteDetachedResources([]model.Resource{resIdle}, nil, snapIdle.Watermark); err != nil {
		t.Fatalf("DeleteDetachedResources with idle watermark failed: %v", err)
	}

	for id, want := range map[string]int64{
		resA.ID:    1,
		resRef.ID:  1,
		resExt.ID:  1,
		resB.ID:    0,
		resIdle.ID: 0,
	} {
		var count int64
		if err := db.Model(&model.Resource{}).Where("id = ?", id).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != want {
			t.Fatalf("resource %s count = %d, want %d", id, count, want)
		}
	}
}

// TestReferenceRegistryParityAcrossSnapshotWatermarkAndGuards enforces 100%
// coverage of every registered JSON document source in referenceDocumentSources
// plus all direct FK tables (including orphaned FK rows without parent records),
// verifying that ResourceReferenceSnapshot and transactional guards agree.
func TestReferenceRegistryParityAcrossSnapshotWatermarkAndGuards(t *testing.T) {
	now := time.Now().Add(-48 * time.Hour)

	documentSeeders := map[string]func(t *testing.T, db *gorm.DB, resID string){
		"assets": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Asset{ID: "a-1", UserID: "u1", Title: "a", PayloadJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"canvas_projects": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CanvasProject{ID: "c-1", UserID: "u1", Title: "c", PayloadJSON: `{"nodes":[{"url":"/api/resources/` + resID + `/file"}]}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"creation_runs": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CreationRun{ID: "cr-1", UserID: "u1", ClientKey: "ck-1", ApprovedOperationsJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"creation_submissions": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CreationSubmission{ID: "cs-1", UserID: "u1", RunID: "cr-s", ItemKey: "k-1", RequestJSON: `{"referenceResourceIds":["` + resID + `"]}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"projects_style": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-sty", UserID: "u1", Name: "sty", StyleProfileJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"style_profiles": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.StyleProfile{ID: "sp-1", UserID: "u1", Name: "sp", CoverURL: "/api/resources/" + resID + "/file", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"asset_versions": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Asset{ID: "a-ver", UserID: "u1", Title: "ver", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.AssetVersion{ID: "av-1", AssetID: "a-ver", Version: 1, DefinitionJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"project_asset_candidates": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-cand", UserID: "u1", Name: "cand", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.ProjectAssetCandidate{ID: "pac-1", ProjectID: "p-cand", Name: "c", DetailsJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"workflow_step_instances": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-wf", UserID: "u1", Name: "wf", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.WorkflowInstance{ID: "wi-1", ProjectID: "p-wf", TemplateVersionID: "tv-1", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.WorkflowStepInstance{ID: "wsi-1", WorkflowInstanceID: "wi-1", StepKey: "step-1", OutputJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"shot_artifacts_metadata": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-2", UserID: "u1", Name: "p2", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Shot{ID: "s-2", ProjectID: "p-2", Title: "s2", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.ShotArtifact{ID: "sa-2", ProjectID: "p-2", ShotID: "s-2", Type: "image", Version: 1, MetadataJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"tasks": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Task{ID: "t-1", UserID: "u1", Type: "image", Status: model.TaskStatusRunning, InputJSON: `{"resourceId":"` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"task_logs": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Task{ID: "t-log", UserID: "u1", Type: "image", Status: model.TaskStatusRunning, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.TaskLog{ID: "tl-1", UserID: "u1", TaskID: "t-log", Payload: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
		"results": func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Task{ID: "t-res", UserID: "u1", Type: "image", Status: model.TaskStatusSucceeded, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Result{ID: "r-1", UserID: "u1", TaskID: "t-res", Kind: "image", URL: "/api/resources/" + resID + "/file", CreatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		},
	}

	// Enforce that every registered document source has an active parity test case.
	if len(documentSeeders) != len(referenceDocumentSources) {
		t.Fatalf("documentSeeders count = %d, referenceDocumentSources count = %d; update parity test when adding/removing sources", len(documentSeeders), len(referenceDocumentSources))
	}
	for _, src := range referenceDocumentSources {
		seed, ok := documentSeeders[src.name]
		if !ok {
			t.Fatalf("missing parity seeder for registered document source %q", src.name)
		}
		t.Run("doc_"+src.name, func(t *testing.T) {
			db, repo := openFullSingleConnSQLiteRepo(t, filepath.Join(t.TempDir(), src.name+".db"))
			resID := "res-" + src.name
			res := model.Resource{ID: resID, UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/" + src.name + ".png", CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&res).Error; err != nil {
				t.Fatal(err)
			}
			seed(t, db, resID)

			snap, err := repo.ResourceReferenceSnapshot("u1", "", []string{resID})
			if err != nil {
				t.Fatal(err)
			}
			if !snap.Watermark.valid {
				t.Fatalf("expected valid watermark for %s", src.name)
			}
			candidateSet := map[string]struct{}{resID: {}}
			found := false
			for _, doc := range snap.Documents {
				if assets.DocumentReferences(doc.PrimaryJSON, candidateSet) || assets.DocumentReferences(doc.SecondaryJSON, candidateSet) {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("ResourceReferenceSnapshot missed document source %s", src.name)
			}
			if err := repo.DeleteDetachedResources([]model.Resource{res}, nil); !errors.Is(err, ErrResourceCleanupStillReferenced) {
				t.Fatalf("DeleteDetachedResources(%s) = %v, want ErrResourceCleanupStillReferenced", src.name, err)
			}
		})
	}

	directCases := []struct {
		name string
		seed func(t *testing.T, db *gorm.DB, resID string)
	}{
		{"asset_representation", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Asset{ID: "a-rep", UserID: "u1", Title: "rep", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.AssetVersion{ID: "av-rep", AssetID: "a-rep", Version: 1, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.AssetRepresentation{ID: "ar-1", AssetVersionID: "av-rep", ResourceID: resID, Role: "primary", CreatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"asset_representation_orphaned_parent", func(t *testing.T, db *gorm.DB, resID string) {
			// Representation whose parent AssetVersion/Asset rows are missing must still protect its resource.
			if err := db.Create(&model.AssetRepresentation{ID: "ar-orphan", AssetVersionID: "missing-version", ResourceID: resID, Role: "primary", CreatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"voice_profile", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.VoiceProfile{ID: "vp-1", UserID: "u1", Name: "v", Provider: "p", VoiceKey: "k", SampleResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"shot_artifact_direct", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-1", UserID: "u1", Name: "p", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Shot{ID: "s-1", ProjectID: "p-1", Title: "s", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.ShotArtifact{ID: "sa-1", ProjectID: "p-1", ShotID: "s-1", Type: "image", Version: 1, ResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"shot_artifact_orphaned_parent", func(t *testing.T, db *gorm.DB, resID string) {
			// ShotArtifact whose parent Shot/Project rows are missing must still protect its resource.
			if err := db.Create(&model.ShotArtifact{ID: "sa-orphan", ProjectID: "missing-proj", ShotID: "missing-shot", Type: "image", Version: 1, ResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"canvas_snapshot_resource", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CanvasSnapshot{ID: "snap-1", CanvasID: "c-h", UserID: "u1", Revision: 1, PayloadJSON: `{}`, ContentUpdatedAt: now, CreatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.CanvasSnapshotResource{SnapshotID: "snap-1", ResourceID: resID}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"canvas_drawing_preview", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CanvasDrawing{UserID: "u1", CanvasID: "c-d", DrawingID: "d-1", Engine: "tldraw", PreviewResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"canvas_drawing_render", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CanvasDrawing{UserID: "u1", CanvasID: "c-d2", DrawingID: "d-2", Engine: "tldraw", RenderResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"canvas_library_folder", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CanvasLibraryFolder{ID: "f-1", UserID: "u1", Name: "f", CoverResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"canvas_workflow_resource", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CanvasWorkflowResource{OwnerID: "wf-1", ResourceID: resID, UserID: "u1"}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"agent_op_project_export", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.AgentOpRecord{UserID: "u1", OpID: "op-1", Op: "canvas.project.export", Status: "succeeded", ResultJSON: `{"resourceId":"` + resID + `","storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"agent_op_file_export", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.AgentOpRecord{UserID: "u1", OpID: "op-file-1", Op: "file.export", Status: "succeeded", ResultJSON: `{"resourceId":"` + resID + `","storageKey":"resource:` + resID + `","fileName":"分镜表.csv"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"agent_op_skill_script_output", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.AgentOpRecord{UserID: "u1", OpID: "script-proposal:sp-1", Op: "skill.script.proposal", Status: "script:succeeded", ResultJSON: `{"proposalId":"sp-1","result":{"outputFiles":[{"path":"subtitles.srt","resourceId":"` + resID + `"}]}}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"project_cover", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-cov", UserID: "u1", Name: "cov", CoverResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
	}

	for _, tc := range directCases {
		t.Run("direct_"+tc.name, func(t *testing.T) {
			db, repo := openFullSingleConnSQLiteRepo(t, filepath.Join(t.TempDir(), tc.name+".db"))
			resID := "res-" + tc.name
			res := model.Resource{ID: resID, UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/" + tc.name + ".png", CreatedAt: now, UpdatedAt: now}
			if err := db.Create(&res).Error; err != nil {
				t.Fatal(err)
			}
			tc.seed(t, db, resID)

			snap, err := repo.ResourceReferenceSnapshot("u1", "", []string{resID})
			if err != nil {
				t.Fatal(err)
			}
			if !snap.Watermark.valid {
				t.Fatalf("expected valid watermark for %s", tc.name)
			}
			found := false
			for _, ref := range snap.Direct {
				if ref.ResourceID == resID {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("ResourceReferenceSnapshot missed direct reference %s", tc.name)
			}
			// BOTH the non-watermark guard AND the watermark fast path (which keeps
			// cheap direct FK checks always-on) MUST reject deletion.
			if err := repo.DeleteDetachedResources([]model.Resource{res}, nil); !errors.Is(err, ErrResourceCleanupStillReferenced) {
				t.Fatalf("DeleteDetachedResources(%s, no watermark) = %v, want ErrResourceCleanupStillReferenced", tc.name, err)
			}
			if err := repo.DeleteDetachedResources([]model.Resource{res}, nil, snap.Watermark); !errors.Is(err, ErrResourceCleanupStillReferenced) {
				t.Fatalf("DeleteDetachedResources(%s, with watermark) = %v, want ErrResourceCleanupStillReferenced", tc.name, err)
			}
		})
	}
}

func TestDeleteAssetAndResourcesGuardsProjectExportAndAdditionalTables(t *testing.T) {
	now := time.Now().Add(-48 * time.Hour)
	cases := []struct {
		name string
		seed func(t *testing.T, db *gorm.DB, resID string)
	}{
		{"project_export", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.AgentOpRecord{UserID: "u1", OpID: "exp-1", Op: "canvas.project.export", Status: "succeeded", ResultJSON: `{"resourceId":"` + resID + `","storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"creation_run", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CreationRun{ID: "run-1", UserID: "u1", ClientKey: "ck-1", StateJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"creation_submission", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.CreationSubmission{ID: "sub-1", UserID: "u1", RunID: "run-s", ItemKey: "k-1", RequestJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"project_cover", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Project{ID: "p-1", UserID: "u1", Name: "p", CoverResourceID: resID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"style_profile", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.StyleProfile{ID: "st-1", UserID: "u1", Name: "st", ProfileJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"other_asset_version", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.Asset{ID: "asset-other", UserID: "u1", Title: "other", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.AssetVersion{ID: "av-other", AssetID: "asset-other", Version: 1, DefinitionJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
		{"orphaned_asset_representation", func(t *testing.T, db *gorm.DB, resID string) {
			if err := db.Create(&model.AssetRepresentation{ID: "ar-orphan-del", AssetVersionID: "missing-version", ResourceID: resID, Role: "primary", CreatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, repo := openFullSingleConnSQLiteRepo(t, filepath.Join(t.TempDir(), tc.name+".db"))
			resID := "res-del-" + tc.name
			if err := db.Create(&model.Resource{ID: resID, UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/" + tc.name + ".png", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Asset{ID: "asset-target", UserID: "u1", Title: "target", PayloadJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			tc.seed(t, db, resID)

			if err := repo.DeleteAssetAndResources("u1", "asset-target", []string{resID}, nil); !errors.Is(err, ErrResourceCleanupStillReferenced) {
				t.Fatalf("DeleteAssetAndResources(%s) = %v, want ErrResourceCleanupStillReferenced", tc.name, err)
			}
		})
	}

	t.Run("own_asset_version_does_not_block_self_delete", func(t *testing.T) {
		db, repo := openFullSingleConnSQLiteRepo(t, filepath.Join(t.TempDir(), "self.db"))
		resID := "res-self"
		if err := db.Create(&model.Resource{ID: resID, UserID: "u1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "u1/self.png", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.Asset{ID: "asset-self", UserID: "u1", Title: "self", PayloadJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.AssetVersion{ID: "av-self", AssetID: "asset-self", Version: 1, DefinitionJSON: `{"storageKey":"resource:` + resID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
			t.Fatal(err)
		}
		if err := repo.DeleteAssetAndResources("u1", "asset-self", []string{resID}, nil); err != nil {
			t.Fatalf("DeleteAssetAndResources blocked by asset's own version: %v", err)
		}
	})
}
