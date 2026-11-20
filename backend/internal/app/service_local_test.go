package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	localasset "infinite-canvas/backend/internal/asset"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNewLocalKeepsLocalBoundaries(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.PluginPlatformState{}, &model.UserPluginState{}); err != nil {
		t.Fatal(err)
	}

	svc := NewLocal(repository.New(db), t.TempDir())
	if svc == nil {
		t.Fatal("NewLocal returned nil")
	}
	if !svc.IsLocalMode() {
		t.Fatal("local service must report local runtime mode")
	}
	if !svc.localResourceStorage {
		t.Fatal("local service must use local resource storage")
	}
	if svc.coordinator == nil {
		t.Fatal("local service must initialize a local coordinator")
	}
	if svc.pluginRuntime == nil {
		t.Fatal("local service must keep protocol plugins available")
	}
	policy, err := svc.RuntimePolicy()
	if err != nil {
		t.Fatalf("local runtime policy: %v", err)
	}
	if policy.Resource.StoredFileGB != 999 || policy.Task.ActiveTaskLimit != 999 {
		t.Fatalf("local runtime policy = %#v, want self-use limits", policy)
	}
}

func TestLocalFeatureAvailabilityDoesNotReadHostedSettings(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	features, err := svc.FeatureAvailability()
	if err != nil {
		t.Fatal(err)
	}
	if !features.ShortDramaEnabled || !features.TaskCenterEnabled || !features.PluginCenterEnabled {
		t.Fatalf("local features unexpectedly disabled: %#v", features)
	}
	if features.FrontendModelsEnabled {
		t.Fatalf("local commercial/system features unexpectedly enabled: %#v", features)
	}
	for _, feature := range []string{FeatureShortDrama, FeatureTaskCenter, FeaturePluginCenter, FeatureCustomChannels, FeatureTimelineTranscription} {
		enabled, err := svc.FeatureEnabled(feature)
		if err != nil || !enabled {
			t.Fatalf("local feature %s = enabled:%v err:%v", feature, enabled, err)
		}
	}
}

func TestLocalTaskListReturnsLocalTaskSummary(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := db.Create(&model.Task{ID: "local-task-1", UserID: "local", Status: model.TaskStatusSucceeded, Type: "image", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	tasks, err := svc.TasksWithOptions("local", TaskListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 {
		t.Fatalf("local task count = %d, want 1", len(tasks))
	}
	if tasks[0].ID != "local-task-1" || tasks[0].Status != model.TaskStatusSucceeded {
		t.Fatalf("unexpected local task summary: %#v", tasks[0])
	}
}

func TestLocalServiceSkipsHostedActivityAnalytics(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.UserDailyActivity{}); err != nil {
		t.Fatal(err)
	}

	svc := NewLocal(repository.New(db), t.TempDir())
	svc.recordActivity("local", "task", 1)

	var count int64
	if err := db.Model(&model.UserDailyActivity{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("local activity analytics rows = %d, want 0", count)
	}
}

func TestLocalTaskListReturnsSafeActionableFailure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	raw := `{"error":{"code":"400","message":"素材转换失败: Height must be between 300px and 6000px. api_key=PRIVATE_LIST_TEST","type":"api_error"}}`
	if err := db.Create(&model.Task{ID: "failed-video", UserID: "local", Type: "video", Status: model.TaskStatusFailed, Error: raw}).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())
	tasks, err := svc.TasksWithOptions("local", TaskListOptions{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 {
		t.Fatalf("task count = %d", len(tasks))
	}
	got := tasks[0]
	if got.ErrorCode != "invalid_params" || !strings.Contains(got.Error, "300–6000") || strings.Contains(got.Error, "PRIVATE_LIST_TEST") || strings.Contains(got.Error, `{"error"`) {
		t.Fatalf("unsafe or missing list error: %#v", got)
	}
}

func TestLocalServiceSkipsMultiTenantQuotaScansLedgersAndRateMap(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately omit hosted quota/analytics tables (`user_daily_upload_usages`,
	// `task_logs`, `task_text_delta`, `api_call_logs`) so any accidental
	// UserStorageUsage scan or daily-upload ledger write fails immediately.
	if err := db.AutoMigrate(
		&model.Resource{},
		&model.UserUploadReservation{},
		&model.Asset{},
		&model.AssetFolder{},
		&model.CanvasProject{},
		&model.CanvasDrawing{},
		&model.CanvasLibraryFolder{},
		&model.CanvasSnapshot{},
		&model.CanvasSnapshotResource{},
		&model.Task{},
		&model.Result{},
	); err != nil {
		t.Fatal(err)
	}
	svc := NewLocal(repository.New(db), t.TempDir())

	// 1. Local upload skips daily upload ledger and reservation rows while keeping duplicate live guard.
	uploaded, err := svc.UploadResourceFile("local", "shot.png", 7, "image", 1, 1, 0, bytes.NewReader([]byte("payload")), "local-key-1")
	if err != nil || uploaded == nil || uploaded.Status != model.ResourceStatusReady {
		t.Fatalf("local UploadResourceFile() = %#v, err = %v", uploaded, err)
	}
	var resvCount int64
	if err := db.Model(&model.UserUploadReservation{}).Count(&resvCount).Error; err != nil {
		t.Fatal(err)
	}
	if resvCount != 0 {
		t.Fatalf("local upload created %d reservation rows, want 0", resvCount)
	}
	day, err := svc.fileQuota().ReserveUpload("local", 7, "live-dup-id")
	if err != nil || day == "" {
		t.Fatalf("first local ReserveUpload() = %q, %v", day, err)
	}
	if _, dupErr := svc.fileQuota().ReserveUpload("local", 7, "live-dup-id"); dupErr == nil || dupErr.Error() != localasset.UploadInProgress().Error() {
		t.Fatalf("duplicate live local ReserveUpload() error = %v, want UploadInProgress", dupErr)
	}
	svc.fileQuota().Release("local", day, 7, "live-dup-id")
	if day2, err := svc.fileQuota().ReserveUpload("local", 7, "live-dup-id"); err != nil {
		t.Fatalf("local ReserveUpload after release = %q, %v", day2, err)
	} else {
		svc.fileQuota().Commit("local", 7, "live-dup-id")
	}

	// 2. Local asset + canvas writes succeed without running UserStorageUsage full-table scans.
	assetRaw := json.RawMessage(`{"id":"asset-local-1","kind":"image","title":"角色图","coverUrl":"","tags":[],"data":{"storageKey":"resource:` + uploaded.ID + `","dataUrl":"/api/resources/` + uploaded.ID + `/file","width":1,"height":1,"bytes":7,"mimeType":"image/png"}}`)
	if _, err := svc.UpsertUserAsset("local", assetRaw); err != nil {
		t.Fatalf("local UpsertUserAsset() error = %v", err)
	}
	canvasRaw := json.RawMessage(`{"id":"canvas-local-1","title":"本地画布","revision":0,"nodes":[],"connections":[]}`)
	if _, err := svc.UpsertUserCanvasProject("local", canvasRaw); err != nil {
		t.Fatalf("local UpsertUserCanvasProject() error = %v", err)
	}
	drawingRaw := json.RawMessage(`{"drawingId":"sketch-local-1","engine":"excalidraw","revision":0,"snapshot":{"elements":[]},"shapeCount":0,"pageCount":1}`)
	if _, err := svc.UpsertUserCanvasDrawing("local", "canvas-local-1", "sketch-local-1", drawingRaw); err != nil {
		t.Fatalf("local UpsertUserCanvasDrawing() error = %v", err)
	}

	// 3. Local task create + completion succeed without UserStorageUsage scans.
	policy, err := svc.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Resource.Unlimited || !policy.Request.Unlimited {
		t.Fatalf("local runtime policy must mark Resource and Request unlimited: %#v", policy)
	}
	task := &model.Task{ID: "task-local-1", UserID: "local", Type: "image", Status: model.TaskStatusRunning, Prompt: "test"}
	if err := svc.createTaskWithinStorageQuota(task, policy); err != nil {
		t.Fatalf("local createTaskWithinStorageQuota() error = %v", err)
	}
	if err := svc.saveTaskCompletionWithinStorageQuota(task, []byte(`{"urls":[]}`), nil, false); err != nil {
		t.Fatalf("local saveTaskCompletionWithinStorageQuota() error = %v", err)
	}

	// 4. Explicit external-service rate limits still work in local mode.
	if ok, err := svc.AllowRequest(context.Background(), "beeftv-start", 1, time.Minute); err != nil || !ok {
		t.Fatalf("first explicit AllowRequest = %v, %v", ok, err)
	}
	if ok, err := svc.AllowRequest(context.Background(), "beeftv-start", 1, time.Minute); err != nil || ok {
		t.Fatalf("second explicit AllowRequest = %v, %v, want false", ok, err)
	}
}
