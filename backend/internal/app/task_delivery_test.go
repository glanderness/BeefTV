package app

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestGenerationDeliverySurvivesSQLiteReopenAndUIClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-delivery.db")
	open := func() (*Service, *gorm.DB) {
		return newGenerationDeliveryService(t, path)
	}

	svc, db := open()
	now := time.Now()
	resource := model.Resource{ID: "res-image-1", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 12, Width: 64, Height: 64, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	operation := "canvas-op-manual-1"
	task := model.Task{
		ID: "task-manual-1", UserID: "user-1", ProjectID: "canvas-1", Type: "canvas_image",
		Status: model.TaskStatusSucceeded, Prompt: "a cat", ClientOperationID: &operation,
		InputJSON:  `{"metadata":{"source":"canvas","nodeId":"node-1","clientOperationId":"canvas-op-manual-1"}}`,
		ResultJSON: `{"mode":"image","images":[{"resourceId":"res-image-1","storageKey":"resource:res-image-1","url":"/api/resources/res-image-1/file"}]}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	closeDB(t, db)

	reopened, db := open()
	defer closeDB(t, db)
	got, err := reopened.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantAsset := localtask.MaterializedAssetID(task.ID, 0)
	if got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 1 {
		t.Fatalf("reopened task = state:%s outputs:%#v", got.ResultState, got.Outputs)
	}
	output := got.Outputs[0]
	if output.MaterializedAssetID != wantAsset || output.ResourceID != resource.ID || output.TargetBinding == nil || output.TargetBinding.NodeID != "node-1" {
		t.Fatalf("reopened output = %#v, want asset %s", output, wantAsset)
	}
	if output.EffectKey != localtask.MaterializeEffectKey(task.ID, 0) {
		t.Fatalf("effect key = %q", output.EffectKey)
	}
	var assets, representations, results int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 1 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
	if err := db.Model(&model.Result{}).Where("kind = ?", localtask.ResultKindGenerationOutput).Count(&results).Error; err != nil || results != 1 {
		t.Fatalf("generation results = %d err=%v", results, err)
	}
	summaries, err := reopened.TasksWithOptions("user-1", TaskListOptions{Limit: 10, ProjectID: "canvas-1"})
	if err != nil || len(summaries) != 1 || summaries[0].ResultState != localtask.ResultStateReady || len(summaries[0].Outputs) != 1 || summaries[0].Outputs[0].MaterializedAssetID != wantAsset {
		t.Fatalf("summaries = %#v err=%v", summaries, err)
	}
}

func TestGenerationDeliveryGetRepairsAfterCompletionWithoutWorkerDeliver(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generation-repair.db")
	svc, db := newGenerationDeliveryService(t, path)
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-video-1", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 24, Width: 1280, Height: 720, DurationMs: 5000, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-repair-1", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"source":"create-page","conversationId":"conv-1","messageId":"msg-1"}}`,
		ResultJSON: `{"mode":"video","video":{"resourceId":"res-video-1","storageKey":"resource:res-video-1"}}`,
		CreatedAt:  now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateReady || len(got.Outputs) != 1 || got.Outputs[0].MediaType != "video" {
		t.Fatalf("repaired task = %#v", got)
	}
	if got.Outputs[0].MaterializedAssetID != localtask.MaterializedAssetID(task.ID, 0) {
		t.Fatalf("repaired asset = %q", got.Outputs[0].MaterializedAssetID)
	}
	if got.Outputs[0].TargetBinding == nil || got.Outputs[0].TargetBinding.MessageID != "msg-1" || got.Outputs[0].TargetBinding.ConversationID != "conv-1" {
		t.Fatalf("message binding = %#v", got.Outputs[0].TargetBinding)
	}
}

func TestGenerationDeliveryIsIdenticalForManualAndAgentMetadata(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-agent.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-shared", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 8, Width: 32, Height: 32, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	manual := seedSucceededImageTask(t, db, "task-manual", `{"metadata":{"source":"canvas","nodeId":"node-manual"}}`)
	agent := seedSucceededImageTask(t, db, "task-agent", `{"metadata":{"source":"canvas","nodeId":"node-agent","clientOperationId":"proposal:gp-1:node-agent"}}`)
	if err := svc.DeliverSucceededTask(manual); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(agent); err != nil {
		t.Fatal(err)
	}
	manualGot, err := svc.Task("user-1", manual.ID)
	if err != nil {
		t.Fatal(err)
	}
	agentGot, err := svc.Task("user-1", agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if manualGot.ResultState != localtask.ResultStateReady || agentGot.ResultState != localtask.ResultStateReady {
		t.Fatalf("states manual=%s agent=%s", manualGot.ResultState, agentGot.ResultState)
	}
	if manualGot.Outputs[0].ResourceID != "res-shared" || agentGot.Outputs[0].ResourceID != "res-shared" {
		t.Fatalf("resource ownership drifted: %#v %#v", manualGot.Outputs[0], agentGot.Outputs[0])
	}
	if manualGot.Outputs[0].MaterializedAssetID == agentGot.Outputs[0].MaterializedAssetID {
		t.Fatal("distinct tasks must keep distinct asset identities")
	}
	if manualGot.Outputs[0].TargetBinding.NodeID != "node-manual" || agentGot.Outputs[0].TargetBinding.NodeID != "node-agent" {
		t.Fatalf("target bindings = %#v %#v", manualGot.Outputs[0].TargetBinding, agentGot.Outputs[0].TargetBinding)
	}
}

func TestGenerationDeliveryRejectsForeignResourceAndSkipsCancelled(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-guard.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "foreign-res", UserID: "other-user", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	foreign := model.Task{
		ID: "task-foreign", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"resourceId":"foreign-res"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(foreign); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", foreign.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStateFailedPermanent || got.Outputs[0].MaterializedAssetID != "" || got.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorResourceForeign {
		t.Fatalf("foreign delivery = %#v", got)
	}
	cancelled := model.Task{ID: "task-cancelled", UserID: "user-1", Status: model.TaskStatusCancelled, ResultJSON: `{"images":[{"resourceId":"foreign-res"}]}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&cancelled).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(cancelled); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.Model(&model.Result{}).Where("task_id = ?", cancelled.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("cancelled delivery wrote results: %d %v", count, err)
	}
}

func TestGenerationDeliveryReusesWorkflowOutputSlot(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-workflow.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-workflow", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 10, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	assetID := localtask.StableEntityID("asset", "task-workflow")
	versionID := localtask.OutputVersionID("task-workflow", 0)
	if err := db.Create(&model.Asset{ID: assetID, UserID: "user-1", Kind: "video", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: "镜头产物 · 视频", PayloadJSON: `{"id":"` + assetID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetRepresentation{ID: "existing-output", TaskID: "task-workflow", AssetVersionID: versionID, ResourceID: "res-workflow", MediaType: "video", Role: "output", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-workflow", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"resourceId":"res-workflow"}}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Outputs[0].MaterializedAssetID != assetID {
		t.Fatalf("workflow slot replaced: %q want %q", got.Outputs[0].MaterializedAssetID, assetID)
	}
	var representations int64
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 1 {
		t.Fatalf("representations = %d err=%v", representations, err)
	}
	var stored model.Asset
	if err := db.First(&stored, "id = ?", assetID).Error; err != nil || stored.Title != "镜头产物 · 视频" {
		t.Fatalf("workflow asset overwritten: %#v err=%v", stored, err)
	}
}

func TestGenerationDeliveryLeavesWorkflowSlotForProjectRegistration(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-workflow-pending.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-workflow-pending", UserID: "user-1", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 10, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-workflow-pending", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"workflowStepId":"step-1","shotId":"shot-1"}}`,
		ResultJSON: `{"video":{"resourceId":"res-workflow-pending"}}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	var assets, representations int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 0 {
		t.Fatalf("workflow first pass created assets = %d err=%v", assets, err)
	}
	if err := db.Model(&model.AssetRepresentation{}).Count(&representations).Error; err != nil || representations != 0 {
		t.Fatalf("workflow first pass created representations = %d err=%v", representations, err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStatePendingMaterialization || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("workflow pending = %#v", got)
	}

	assetID := localtask.StableEntityID("asset", task.ID)
	versionID := localtask.OutputVersionID(task.ID, 0)
	if err := db.Create(&model.Asset{ID: assetID, UserID: "user-1", Kind: "video", Category: model.AssetCategoryMaterial, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: "镜头产物 · 视频", PayloadJSON: `{"id":"` + assetID + `"}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: "{}", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AssetRepresentation{ID: "existing-output", TaskID: task.ID, AssetVersionID: versionID, ResourceID: "res-workflow-pending", MediaType: "video", Role: "output", CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	bound, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if bound.ResultState != localtask.ResultStateReady || bound.Outputs[0].MaterializedAssetID != assetID {
		t.Fatalf("workflow bind = %#v", bound)
	}
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 1 {
		t.Fatalf("workflow bind created extra assets = %d err=%v", assets, err)
	}
}

func TestGenerationDeliveryDoesNotDownloadLeftoverRemoteURL(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-remote.db"))
	defer closeDB(t, db)
	now := time.Now()
	task := model.Task{
		ID: "task-remote", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"images":[{"url":"https://upstream.example/a.png"}]}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResultState != localtask.ResultStatePendingMaterialization || got.Outputs[0].ResourceID != "" || got.Outputs[0].MaterializedAssetID != "" {
		t.Fatalf("remote leftover = %#v", got)
	}
	var assets int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 0 {
		t.Fatalf("remote leftover downloaded into assets = %d err=%v", assets, err)
	}
}

func TestGenerationDeliveryKeepsClientOperationIdentity(t *testing.T) {
	svc, db := newGenerationDeliveryService(t, filepath.Join(t.TempDir(), "generation-opid.db"))
	defer closeDB(t, db)
	now := time.Now()
	if err := db.Create(&model.Resource{ID: "res-shared", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	key := "proposal:gp-1:node-1"
	task := seedSucceededImageTask(t, db, "task-op-1", `{"metadata":{"nodeId":"node-1","clientOperationId":"proposal:gp-1:node-1"}}`)
	task.ClientOperationID = &key
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("client_operation_id", key).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeliverSucceededTask(task); err != nil {
		t.Fatal(err)
	}
	existing, err := svc.repo.TaskByClientOperation("user-1", key)
	if err != nil || existing == nil || existing.ID != task.ID {
		t.Fatalf("client operation identity lost: %#v %v", existing, err)
	}
	got, err := svc.Task("user-1", task.ID)
	if err != nil || got.ClientOperationID == nil || *got.ClientOperationID != key {
		t.Fatalf("task client operation = %#v err=%v", got, err)
	}
}

func TestCanonicalOutputJSONRoundTripMatchesFrontendContract(t *testing.T) {
	output := localtask.BindOutput(localtask.CanonicalOutput{OutputIndex: 0, MediaType: "image", ResourceID: "res-1"}, "task-1", localtask.TargetBinding{NodeID: "node-1"})
	output.MaterializedAssetID = localtask.MaterializedAssetID("task-1", 0)
	raw, err := json.Marshal(modelTaskOutputs([]localtask.CanonicalOutput{output}))
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 1 || decoded[0]["outputIndex"] != float64(0) || decoded[0]["materializedAssetId"] != output.MaterializedAssetID {
		t.Fatalf("json = %s", raw)
	}
}

func newGenerationDeliveryService(t *testing.T, path string) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.SystemSetting{}, &model.Task{}, &model.TaskLog{}, &model.Result{},
		&model.Asset{}, &model.AssetVersion{}, &model.AssetRepresentation{}, &model.Resource{},
	); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db
}

func seedSucceededImageTask(t *testing.T, db *gorm.DB, id, inputJSON string) model.Task {
	t.Helper()
	now := time.Now()
	task := model.Task{
		ID: id, UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusSucceeded,
		InputJSON: inputJSON, ResultJSON: `{"images":[{"resourceId":"res-shared","storageKey":"resource:res-shared"}]}`,
		CreatedAt: now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func closeDB(t *testing.T, db *gorm.DB) {
	t.Helper()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
}
