package taskdelivery

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type deletedVisibilityNopQuota struct{}

func (deletedVisibilityNopQuota) ReserveUpload(string, int64, string) (string, error)    { return "", nil }
func (deletedVisibilityNopQuota) ReserveChunked(string, int64, string) (string, error)   { return "", nil }
func (deletedVisibilityNopQuota) ReserveRetry(string, int64, string) (string, error)     { return "", nil }
func (deletedVisibilityNopQuota) ReserveGenerated(string, int64, string) (string, error) { return "", nil }
func (deletedVisibilityNopQuota) ReserveGeneratedRetry(string, int64, string) (string, error) {
	return "", nil
}
func (deletedVisibilityNopQuota) Release(string, string, int64, string)      {}
func (deletedVisibilityNopQuota) ReleaseRetry(string, string, int64, string) {}
func (deletedVisibilityNopQuota) Commit(string, int64, string)               {}

type deletedVisibilityNopLifecycle struct{}

func (deletedVisibilityNopLifecycle) RecordActivity(string, string, int)               {}
func (deletedVisibilityNopLifecycle) AfterResourceReady(*model.Resource)               {}
func (deletedVisibilityNopLifecycle) AppearanceReferencedIDs([]string) map[string]struct{} { return nil }
func (deletedVisibilityNopLifecycle) RecycleRetentionDays() (int, error)               { return 30, nil }
func (deletedVisibilityNopLifecycle) WorkerID() string                                 { return "test-worker" }
func (deletedVisibilityNopLifecycle) RunBackground(fn func())                          {}
func (deletedVisibilityNopLifecycle) DeleteUserAsset(string, string) error             { return nil }
func (deletedVisibilityNopLifecycle) WithStorageLock(fn func() error) error            { return fn() }

func newDeletedAssetVisibilityFixture(t *testing.T) (*gorm.DB, *repository.Repository, *localasset.Service, *Deliverer, string) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	repo := repository.New(db)
	assetSvc := localasset.NewService(localasset.Dependencies{
		Repository: localasset.NewRepository(repo),
		Blobs:      localasset.NewFileStore(dataDir),
		Quota:      deletedVisibilityNopQuota{},
		Lifecycle:  deletedVisibilityNopLifecycle{},
	})
	deliverer := New(NewRepoStore(repo, localtask.PublicTaskInputJSON), nil)
	return db, repo, assetSvc, deliverer, dataDir
}

func writeResourceBlob(t *testing.T, dataDir string, objectKey string) string {
	t.Helper()
	fullPath := filepath.Join(dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fullPath, []byte("media-bytes"), 0o640); err != nil {
		t.Fatal(err)
	}
	return fullPath
}

func TestDeletePersonalCopyRemovesTwinGeneratedHistoryAndTombstonesTaskOutput(t *testing.T) {
	db, repo, assetSvc, deliverer, dataDir := newDeletedAssetVisibilityFixture(t)
	const userID = "user-573"
	const projectID = "canvas-573"
	const resourceID = "res-image-573"
	const taskID = "task-image-573"

	now := time.Now().UTC()
	resource := model.Resource{
		ID: resourceID, UserID: userID, Kind: "image", Provider: "local",
		ObjectKey: "users/user-573/image/gen.png", MimeType: "image/png", Size: 1024,
		Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now,
	}
	taskRow := model.Task{
		ID: taskID, UserID: userID, ProjectID: projectID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "雨夜街景",
		ResultJSON: `{"mode":"image","images":[{"storageKey":"resource:res-image-573","url":"/api/resources/res-image-573/file","width":1024,"height":1024}]}`,
		CreatedAt:  now, UpdatedAt: now,
	}
	blobPath := writeResourceBlob(t, dataDir, resource.ObjectKey)
	for _, row := range []any{&resource, &taskRow} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := deliverer.Deliver(taskRow); err != nil {
		t.Fatalf("Deliver() error = %v", err)
	}

	// Simulate the duplicate personal Canvas asset created by canvas sync pointing to the exact same resource.
	personalPayload, _ := json.Marshal(map[string]any{
		"id":     "canvas-copy-573",
		"kind":   "image",
		"title":  "雨夜街景",
		"source": "Canvas",
		"status": "confirmed",
		"data": map[string]any{
			"dataUrl":    "",
			"storageKey": "resource:" + resourceID,
			"width":      1024,
			"height":     1024,
		},
		"metadata": map[string]any{
			"source":      "canvas-generation",
			"canvasId":    projectID,
			"taskId":      taskID,
			"resourceKey": "resource:" + resourceID,
		},
	})
	personalAsset := model.Asset{
		ID: "canvas-copy-573", UserID: userID, Kind: "image", Category: model.AssetCategoryMaterial,
		Status: model.AssetVersionStatusConfirmed, Title: "雨夜街景", PayloadJSON: string(personalPayload),
		CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&personalAsset).Error; err != nil {
		t.Fatal(err)
	}

	// Delete the personal asset from main Assets menu.
	if err := assetSvc.DeleteUserAssetWithResources(userID, personalAsset.ID); err != nil {
		t.Fatalf("DeleteUserAssetWithResources() error = %v", err)
	}

	// Sole task's unreferenced resource and physical file must be cleaned up normally.
	var resCount, jobCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resourceID).Count(&resCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Where("resource_id = ?", resourceID).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if resCount != 0 || jobCount != 1 {
		t.Fatalf("sole task resource cleanup failed: resource=%d deletionJobs=%d", resCount, jobCount)
	}
	assetSvc.DrainDeletionJobs(10)
	if _, err := os.Stat(blobPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected sole task physical file to be removed, stat err = %v", err)
	}

	personalRows, personalTotal, err := repo.UserAssetsPage(userID, 1, 20, repository.UserAssetPageFilter{Status: "active", Personal: true})
	if err != nil {
		t.Fatal(err)
	}
	if personalTotal != 0 || len(personalRows) != 0 {
		t.Fatalf("personal assets still contain deleted image: total=%d rows=%+v", personalTotal, personalRows)
	}

	generatedRows, generatedTotal, err := repo.UserAssetsPage(userID, 1, 20, repository.UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if generatedTotal != 0 || len(generatedRows) != 0 {
		t.Fatalf("generated history still contains twin of deleted asset: total=%d rows=%+v", generatedTotal, generatedRows)
	}

	summaries := localtask.SummariesForOutput([]model.Task{taskRow})
	AttachTaskSummaryDeliveries(
		deliverer,
		[]model.Task{taskRow},
		summaries,
		func([]model.Task) map[string]localtask.OutcomeFacts { return map[string]localtask.OutcomeFacts{} },
		generation.PersistedFailureBlocksRetry,
		nil,
		nil,
	)
	wantDeletedOutcome := localtask.Outcome{Phase: "failed", Regenerate: "confirm", Reason: "result_unrecoverable"}
	if summaries[0].PreviewURL != "" {
		t.Fatalf("deleted asset still exposed PreviewURL in generation history summary: %q", summaries[0].PreviewURL)
	}
	if summaries[0].ResultState != localtask.ResultStateFailedPermanent {
		t.Fatalf("deleted asset summary ResultState = %q, want %q", summaries[0].ResultState, localtask.ResultStateFailedPermanent)
	}
	if summaries[0].Outcome == nil || *summaries[0].Outcome != wantDeletedOutcome {
		t.Fatalf("deleted asset summary Outcome = %+v, want %+v", summaries[0].Outcome, wantDeletedOutcome)
	}
	if len(summaries[0].Outputs) != 1 || summaries[0].Outputs[0].MaterializationErrorCode != "asset_deleted" || summaries[0].Outputs[0].MaterializedAssetID != "" || summaries[0].Outputs[0].ResourceID != "" {
		t.Fatalf("generation history output was not tombstoned on delete: %+v", summaries[0].Outputs)
	}

	taskView := localtask.TaskForOutput(taskRow)
	AttachTaskDelivery(
		deliverer,
		taskView,
		nil,
		func([]model.Task) map[string]localtask.OutcomeFacts { return map[string]localtask.OutcomeFacts{} },
		generation.PersistedFailureBlocksRetry(taskRow.Error, taskRow.Stage, taskRow.ErrorCode),
		nil,
	)
	if taskView.ResultState != localtask.ResultStateFailedPermanent || len(taskView.Outputs) != 1 || taskView.Outputs[0].MaterializationErrorCode != "asset_deleted" {
		t.Fatalf("deleted asset task detail drifted: resultState=%q outputs=%+v", taskView.ResultState, taskView.Outputs)
	}
	if taskView.Outcome == nil || *taskView.Outcome != wantDeletedOutcome {
		t.Fatalf("deleted asset task detail Outcome = %+v, want %+v", taskView.Outcome, wantDeletedOutcome)
	}

	// Recovery pass must never resurrect a deleted asset.
	if err := deliverer.RecoverIncomplete(10); err != nil {
		t.Fatalf("RecoverIncomplete() error = %v", err)
	}
	afterRecovery, afterTotal, err := repo.UserAssetsPage(userID, 1, 20, repository.UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if afterTotal != 0 || len(afterRecovery) != 0 {
		t.Fatalf("RecoverIncomplete resurrected deleted asset: total=%d rows=%+v", afterTotal, afterRecovery)
	}
}

func TestDeleteGeneratedVideoDirectRemovesHistoryAndKeepsLiveCanvasResource(t *testing.T) {
	db, repo, assetSvc, deliverer, _ := newDeletedAssetVisibilityFixture(t)
	const userID = "user-573-vid"
	const projectID = "canvas-573-vid"
	const resourceID = "res-video-573"
	const taskID = "task-video-573"

	now := time.Now().UTC()
	resource := model.Resource{
		ID: resourceID, UserID: userID, Kind: "video", Provider: "local",
		ObjectKey: "users/user-573-vid/video/clip.mp4", MimeType: "video/mp4", Size: 4096,
		Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now,
	}
	taskRow := model.Task{
		ID: taskID, UserID: userID, ProjectID: projectID, Type: "canvas_video",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "航拍海岸线",
		ResultJSON: `{"mode":"video","video":{"storageKey":"resource:res-video-573","url":"/api/resources/res-video-573/file","width":1280,"height":720}}`,
		CreatedAt:  now, UpdatedAt: now,
	}
	canvas := model.CanvasProject{
		ID: projectID, UserID: userID, Title: "仍在使用的画布",
		PayloadJSON: `{"nodes":[{"id":"node-v1","metadata":{"storageKey":"resource:res-video-573"}}]}`,
		CreatedAt:   now, UpdatedAt: now,
	}
	for _, row := range []any{&resource, &taskRow, &canvas} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := deliverer.Deliver(taskRow); err != nil {
		t.Fatalf("Deliver() error = %v", err)
	}

	genAssetID := localtask.MaterializedAssetID(taskID, 0)
	if err := assetSvc.DeleteUserAssetWithResources(userID, genAssetID); err != nil {
		t.Fatalf("DeleteUserAssetWithResources() error = %v", err)
	}

	// Live canvas still references the underlying resource, so the Resource row MUST be preserved.
	var resCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resourceID).Count(&resCount).Error; err != nil {
		t.Fatal(err)
	}
	if resCount != 1 {
		t.Fatalf("live canvas resource was unexpectedly removed: count=%d", resCount)
	}

	// Yet generation history must no longer expose the deleted video asset or preview URL.
	generatedRows, generatedTotal, err := repo.UserAssetsPage(userID, 1, 20, repository.UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if generatedTotal != 0 || len(generatedRows) != 0 {
		t.Fatalf("generated history still contains deleted video: total=%d", generatedTotal)
	}

	summaries := localtask.SummariesForOutput([]model.Task{taskRow})
	AttachTaskSummaryDeliveries(
		deliverer,
		[]model.Task{taskRow},
		summaries,
		func([]model.Task) map[string]localtask.OutcomeFacts { return map[string]localtask.OutcomeFacts{} },
		generation.PersistedFailureBlocksRetry,
		nil,
		nil,
	)
	wantDeletedOutcome := localtask.Outcome{Phase: "failed", Regenerate: "confirm", Reason: "result_unrecoverable"}
	if summaries[0].PreviewURL != "" {
		t.Fatalf("deleted video still exposed PreviewURL: %q", summaries[0].PreviewURL)
	}
	if summaries[0].ResultState != localtask.ResultStateFailedPermanent || summaries[0].Outcome == nil || *summaries[0].Outcome != wantDeletedOutcome {
		t.Fatalf("deleted video outcome drifted: resultState=%q outcome=%+v", summaries[0].ResultState, summaries[0].Outcome)
	}
	if len(summaries[0].Outputs) != 1 || summaries[0].Outputs[0].MaterializationErrorCode != "asset_deleted" {
		t.Fatalf("video output not tombstoned: %+v", summaries[0].Outputs)
	}

	// Recovery pass must not resurrect even though the Resource still exists for the live canvas.
	if err := deliverer.RecoverIncomplete(10); err != nil {
		t.Fatalf("RecoverIncomplete() error = %v", err)
	}
	var assetCount int64
	if err := db.Model(&model.Asset{}).Where("id = ?", genAssetID).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 0 {
		t.Fatalf("RecoverIncomplete resurrected deleted video asset while canvas kept resource")
	}
}

func TestDeleteAssetDoesNotDeleteOrTombstoneUnrelatedTaskSharingSameResource(t *testing.T) {
	db, repo, assetSvc, deliverer, _ := newDeletedAssetVisibilityFixture(t)
	const userID = "user-573-shared"
	const projectID = "canvas-573-shared"
	const sharedResourceID = "res-shared-573"
	const taskIDA = "task-shared-a"
	const taskIDB = "task-shared-b"

	now := time.Now().UTC()
	resource := model.Resource{
		ID: sharedResourceID, UserID: userID, Kind: "image", Provider: "local",
		ObjectKey: "users/user-573-shared/image/shared.png", MimeType: "image/png", Size: 2048,
		Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now,
	}
	taskA := model.Task{
		ID: taskIDA, UserID: userID, ProjectID: projectID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "任务A",
		ResultJSON: `{"mode":"image","images":[{"storageKey":"resource:res-shared-573","url":"/api/resources/res-shared-573/file","width":1024,"height":1024}]}`,
		CreatedAt:  now, UpdatedAt: now,
	}
	taskB := model.Task{
		ID: taskIDB, UserID: userID, ProjectID: projectID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "任务B",
		ResultJSON: `{"mode":"image","images":[{"storageKey":"resource:res-shared-573","url":"/api/resources/res-shared-573/file","width":1024,"height":1024}]}`,
		CreatedAt:  now.Add(time.Second), UpdatedAt: now.Add(time.Second),
	}
	for _, row := range []any{&resource, &taskA, &taskB} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []model.Task{taskA, taskB} {
		if err := deliverer.Deliver(row); err != nil {
			t.Fatalf("Deliver(%s) error = %v", row.ID, err)
		}
	}

	personalAJSON, _ := json.Marshal(map[string]any{
		"id":     "canvas-copy-a",
		"kind":   "image",
		"title":  "任务A副本",
		"source": "Canvas",
		"status": "confirmed",
		"data":   map[string]any{"storageKey": "resource:" + sharedResourceID},
		"metadata": map[string]any{
			"source":      "canvas-generation",
			"canvasId":    projectID,
			"taskId":      taskIDA,
			"resourceKey": "resource:" + sharedResourceID,
		},
	})
	personalUnrelatedJSON, _ := json.Marshal(map[string]any{
		"id":       "personal-upload-shared",
		"kind":     "image",
		"title":    "独立个人上传",
		"source":   "本地上传",
		"status":   "confirmed",
		"data":     map[string]any{"storageKey": "resource:" + sharedResourceID},
		"metadata": map[string]any{"source": "upload"},
	})
	for _, assetRow := range []model.Asset{
		{ID: "canvas-copy-a", UserID: userID, Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "任务A副本", PayloadJSON: string(personalAJSON), CreatedAt: now, UpdatedAt: now},
		{ID: "personal-upload-shared", UserID: userID, Kind: "image", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, Title: "独立个人上传", PayloadJSON: string(personalUnrelatedJSON), CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.Create(&assetRow).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Deleting taskA's personal canvas copy must remove only taskA's twin and tombstone only taskA.
	if err := assetSvc.DeleteUserAssetWithResources(userID, "canvas-copy-a"); err != nil {
		t.Fatalf("DeleteUserAssetWithResources(canvas-copy-a) error = %v", err)
	}
	// Deleting an unrelated personal upload pointing to the same resource must NOT touch taskB either.
	if err := assetSvc.DeleteUserAssetWithResources(userID, "personal-upload-shared"); err != nil {
		t.Fatalf("DeleteUserAssetWithResources(personal-upload-shared) error = %v", err)
	}

	genAssetIDA := localtask.MaterializedAssetID(taskIDA, 0)
	genAssetIDB := localtask.MaterializedAssetID(taskIDB, 0)
	generatedRows, generatedTotal, err := repo.UserAssetsPage(userID, 1, 20, repository.UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if generatedTotal != 1 || len(generatedRows) != 1 || generatedRows[0].ID != genAssetIDB {
		t.Fatalf("expected only taskB generated asset %q to survive, got total=%d rows=%+v", genAssetIDB, generatedTotal, generatedRows)
	}

	var resCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", sharedResourceID).Count(&resCount).Error; err != nil {
		t.Fatal(err)
	}
	if resCount != 1 {
		t.Fatalf("shared resource referenced by taskB was unexpectedly deleted: count=%d", resCount)
	}

	summaries := localtask.SummariesForOutput([]model.Task{taskA, taskB})
	AttachTaskSummaryDeliveries(
		deliverer,
		[]model.Task{taskA, taskB},
		summaries,
		func([]model.Task) map[string]localtask.OutcomeFacts { return map[string]localtask.OutcomeFacts{} },
		generation.PersistedFailureBlocksRetry,
		nil,
		nil,
	)
	if summaries[0].ResultState != localtask.ResultStateFailedPermanent || len(summaries[0].Outputs) != 1 || summaries[0].Outputs[0].MaterializationErrorCode != "asset_deleted" {
		t.Fatalf("taskA was not tombstoned cleanly: %+v", summaries[0])
	}
	if summaries[1].ResultState != localtask.ResultStateReady || summaries[1].PreviewURL == "" || len(summaries[1].Outputs) != 1 || summaries[1].Outputs[0].MaterializedAssetID != genAssetIDB || summaries[1].Outputs[0].ResourceID != sharedResourceID {
		t.Fatalf("taskB was cross-tombstoned by unrelated delete (genA=%s): %+v", genAssetIDA, summaries[1])
	}
	wantReady := localtask.Outcome{Phase: "ready", Regenerate: "allowed", Reason: "result_ready"}
	if summaries[1].Outcome == nil || *summaries[1].Outcome != wantReady {
		t.Fatalf("taskB Outcome = %+v, want %+v", summaries[1].Outcome, wantReady)
	}
}

func TestDeleteAssetDoesNotTombstoneResultOnlyUnrelatedTaskSharingSameResource(t *testing.T) {
	db, repo, assetSvc, deliverer, dataDir := newDeletedAssetVisibilityFixture(t)
	const userID = "user-573-result-only"
	const projectID = "canvas-573-result-only"
	const sharedResourceID = "res-shared-result-only"
	const taskIDA = "task-result-only-a"
	const taskIDB = "task-result-only-b"

	now := time.Now().UTC()
	resource := model.Resource{
		ID: sharedResourceID, UserID: userID, Kind: "image", Provider: "local",
		ObjectKey: "users/user-573-result-only/image/shared.png", MimeType: "image/png", Size: 1024,
		Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now,
	}
	sharedBlobPath := writeResourceBlob(t, dataDir, resource.ObjectKey)
	taskA := model.Task{
		ID: taskIDA, UserID: userID, ProjectID: projectID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "任务A",
		ResultJSON: `{"mode":"image","images":[{"storageKey":"resource:res-shared-result-only","url":"/api/resources/res-shared-result-only/file"}]}`,
		CreatedAt:  now, UpdatedAt: now,
	}
	taskB := model.Task{
		ID: taskIDB, UserID: userID, ProjectID: projectID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "任务B（仅Result无Asset）",
		ResultJSON: `{"mode":"image","images":[{"storageKey":"resource:res-shared-result-only","url":"/api/resources/res-shared-result-only/file"}]}`,
		CreatedAt:  now.Add(time.Second), UpdatedAt: now.Add(time.Second),
	}
	// taskB only has a generation_output result row referencing the shared resource, with no Asset row.
	taskBOutputPayload, _ := localtask.EncodeOutputPayload(localtask.CanonicalOutput{
		OutputIndex:         0,
		MediaType:           "image",
		ResourceID:          sharedResourceID,
		ProviderArtifactRef: "resource:" + sharedResourceID,
		EffectKey:           localtask.MaterializeEffectKey(taskIDB, 0),
	})
	taskBResult := model.Result{
		ID: "result-only-b", UserID: userID, TaskID: taskIDB, Kind: "generation_output",
		URL: "/api/resources/" + sharedResourceID + "/file", Payload: taskBOutputPayload,
		CreatedAt: now.Add(time.Second),
	}
	for _, row := range []any{&resource, &taskA, &taskB, &taskBResult} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := deliverer.Deliver(taskA); err != nil {
		t.Fatalf("Deliver(taskA) error = %v", err)
	}

	genAssetIDA := localtask.MaterializedAssetID(taskIDA, 0)
	if err := assetSvc.DeleteUserAssetWithResources(userID, genAssetIDA); err != nil {
		t.Fatalf("DeleteUserAssetWithResources(genA) error = %v", err)
	}
	assetSvc.DrainDeletionJobs(10)

	// Shared resource must survive in DB, have zero deletion jobs, and keep its physical file on disk.
	var resCount, jobCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", sharedResourceID).Count(&resCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ResourceDeletionJob{}).Where("resource_id = ?", sharedResourceID).Count(&jobCount).Error; err != nil {
		t.Fatal(err)
	}
	if resCount != 1 {
		t.Fatalf("shared resource referenced by result-only taskB was deleted: count=%d", resCount)
	}
	if jobCount != 0 {
		t.Fatalf("unexpected deletion job scheduled for resource still referenced by taskB: count=%d", jobCount)
	}
	if _, err := os.Stat(sharedBlobPath); err != nil {
		t.Fatalf("shared resource physical file was removed while taskB still references it: %v", err)
	}

	// Atomic repository TX guard must also refuse direct resource deletion while taskB's generation_output is live.
	extraAsset := model.Asset{
		ID: "unrelated-personal-asset", UserID: userID, Kind: "image", Status: model.AssetVersionStatusConfirmed,
		Title: "无关个人资产", PayloadJSON: `{"data":{"storageKey":"resource:` + sharedResourceID + `"}}`,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&extraAsset).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteAssetsAndResources(userID, extraAsset.ID, nil, []string{sharedResourceID}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("direct DeleteAssetsAndResources() = %v, want ErrResourceCleanupStillReferenced", err)
	}

	var refreshedA model.Result
	if err := db.Where("user_id = ? AND task_id = ? AND kind = ?", userID, taskIDA, "generation_output").First(&refreshedA).Error; err != nil {
		t.Fatal(err)
	}
	outA, err := localtask.DecodeOutputPayload(refreshedA.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if outA.MaterializationErrorCode != localtask.MaterializeErrorAssetDeleted {
		t.Fatalf("taskA output not tombstoned: %+v", outA)
	}

	var refreshedB model.Result
	if err := db.Where("id = ?", taskBResult.ID).First(&refreshedB).Error; err != nil {
		t.Fatal(err)
	}
	outB, err := localtask.DecodeOutputPayload(refreshedB.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if outB.MaterializationErrorCode != "" || outB.ResourceID != sharedResourceID || refreshedB.URL != "/api/resources/"+sharedResourceID+"/file" {
		t.Fatalf("result-only unrelated taskB was cross-tombstoned or lost URL: %+v (url=%q)", outB, refreshedB.URL)
	}
}

func TestPurgeArchivedAssetDoesNotDeleteActiveTwinOrTombstoneLiveHistory(t *testing.T) {
	db, repo, assetSvc, deliverer, _ := newDeletedAssetVisibilityFixture(t)
	const userID = "user-573-archive"
	const projectID = "canvas-573-archive"
	const resourceID = "res-archive-573"
	const taskID = "task-archive-573"

	now := time.Now().UTC()
	resource := model.Resource{
		ID: resourceID, UserID: userID, Kind: "image", Provider: "local",
		ObjectKey: "users/user-573-archive/image/item.png", MimeType: "image/png", Size: 1024,
		Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now,
	}
	taskRow := model.Task{
		ID: taskID, UserID: userID, ProjectID: projectID, Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Stage: "生成完成", Prompt: "回收站隔离测试",
		ResultJSON: `{"mode":"image","images":[{"storageKey":"resource:res-archive-573","url":"/api/resources/res-archive-573/file"}]}`,
		CreatedAt:  now, UpdatedAt: now,
	}
	for _, row := range []any{&resource, &taskRow} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := deliverer.Deliver(taskRow); err != nil {
		t.Fatalf("Deliver() error = %v", err)
	}
	genAssetID := localtask.MaterializedAssetID(taskID, 0)

	archivedPersonalPayload, _ := json.Marshal(map[string]any{
		"id":     "canvas-copy-archived-1",
		"kind":   "image",
		"title":  "回收站副本",
		"source": "Canvas",
		"status": "archived",
		"data":   map[string]any{"storageKey": "resource:" + resourceID},
		"metadata": map[string]any{
			"source":      "canvas-generation",
			"canvasId":    projectID,
			"taskId":      taskID,
			"resourceKey": "resource:" + resourceID,
		},
	})
	archivedPersonal := model.Asset{
		ID: "canvas-copy-archived-1", UserID: userID, Kind: "image", Category: model.AssetCategoryMaterial,
		Status: model.AssetVersionStatusArchived, Title: "回收站副本", PayloadJSON: string(archivedPersonalPayload),
		CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&archivedPersonal).Error; err != nil {
		t.Fatal(err)
	}

	// Emptying recycle bin (expectedStatus=archived) must NOT delete the active (confirmed) generation twin or tombstone live history.
	if err := assetSvc.DeleteUserAssetWithResources(userID, archivedPersonal.ID, string(model.AssetVersionStatusArchived)); err != nil {
		t.Fatalf("DeleteUserAssetWithResources(archived) error = %v", err)
	}

	var activeTwin model.Asset
	if err := db.Where("id = ? AND user_id = ?", genAssetID, userID).First(&activeTwin).Error; err != nil {
		t.Fatalf("active generation twin was unexpectedly deleted during archived purge: %v", err)
	}
	if activeTwin.Status != model.AssetVersionStatusConfirmed {
		t.Fatalf("active generation twin status = %q, want confirmed", activeTwin.Status)
	}

	var resCount int64
	if err := db.Model(&model.Resource{}).Where("id = ?", resourceID).Count(&resCount).Error; err != nil {
		t.Fatal(err)
	}
	if resCount != 1 {
		t.Fatalf("resource referenced by surviving active twin was deleted: count=%d", resCount)
	}

	summaries := localtask.SummariesForOutput([]model.Task{taskRow})
	AttachTaskSummaryDeliveries(
		deliverer,
		[]model.Task{taskRow},
		summaries,
		func([]model.Task) map[string]localtask.OutcomeFacts { return map[string]localtask.OutcomeFacts{} },
		generation.PersistedFailureBlocksRetry,
		nil,
		nil,
	)
	if summaries[0].ResultState != localtask.ResultStateReady || len(summaries[0].Outputs) != 1 || summaries[0].Outputs[0].MaterializedAssetID != genAssetID {
		t.Fatalf("live generation output was tombstoned despite surviving active twin: %+v", summaries[0])
	}

	// Once both the personal copy and the generation twin are archived, purging with expectedStatus=archived removes both and tombstones the output.
	if err := db.Model(&model.Asset{}).Where("id = ? AND user_id = ?", genAssetID, userID).Update("status", model.AssetVersionStatusArchived).Error; err != nil {
		t.Fatal(err)
	}
	archivedPersonal2 := archivedPersonal
	archivedPersonal2.ID = "canvas-copy-archived-2"
	if err := db.Create(&archivedPersonal2).Error; err != nil {
		t.Fatal(err)
	}
	if err := assetSvc.DeleteUserAssetWithResources(userID, archivedPersonal2.ID, string(model.AssetVersionStatusArchived)); err != nil {
		t.Fatalf("DeleteUserAssetWithResources(both archived) error = %v", err)
	}
	_, remainingGenTotal, err := repo.UserAssetsPage(userID, 1, 20, repository.UserAssetPageFilter{Status: "archived", Generated: true})
	if err != nil {
		t.Fatal(err)
	}
	if remainingGenTotal != 0 {
		t.Fatalf("archived generation twin should have been purged alongside archived personal copy: total=%d", remainingGenTotal)
	}
	summariesAfter := localtask.SummariesForOutput([]model.Task{taskRow})
	AttachTaskSummaryDeliveries(
		deliverer,
		[]model.Task{taskRow},
		summariesAfter,
		func([]model.Task) map[string]localtask.OutcomeFacts { return map[string]localtask.OutcomeFacts{} },
		generation.PersistedFailureBlocksRetry,
		nil,
		nil,
	)
	if summariesAfter[0].ResultState != localtask.ResultStateFailedPermanent || len(summariesAfter[0].Outputs) != 1 || summariesAfter[0].Outputs[0].MaterializationErrorCode != "asset_deleted" {
		t.Fatalf("expected output tombstoned after both archived copies purged: %+v", summariesAfter[0])
	}
}
