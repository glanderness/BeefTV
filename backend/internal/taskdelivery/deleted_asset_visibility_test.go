package taskdelivery

import (
	"encoding/json"
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

func newDeletedAssetVisibilityFixture(t *testing.T) (*gorm.DB, *repository.Repository, *localasset.Service, *Deliverer) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	repo := repository.New(db)
	assetSvc := localasset.NewService(localasset.Dependencies{
		Repository: localasset.NewRepository(repo),
		Blobs:      localasset.NewFileStore(t.TempDir()),
		Quota:      deletedVisibilityNopQuota{},
		Lifecycle:  deletedVisibilityNopLifecycle{},
	})
	deliverer := New(NewRepoStore(repo, localtask.PublicTaskInputJSON), nil)
	return db, repo, assetSvc, deliverer
}

func TestDeletePersonalCopyRemovesTwinGeneratedHistoryAndTombstonesTaskOutput(t *testing.T) {
	db, repo, assetSvc, deliverer := newDeletedAssetVisibilityFixture(t)
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
	db, repo, assetSvc, deliverer := newDeletedAssetVisibilityFixture(t)
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
	db, repo, assetSvc, deliverer := newDeletedAssetVisibilityFixture(t)
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
