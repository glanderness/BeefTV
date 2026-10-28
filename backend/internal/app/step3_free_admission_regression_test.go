package app

import (
	"encoding/json"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"testing"
	"time"
)

// P3: free recovery operation receipt left "running" (process exit between
// BeginRetryOperation and Complete/Abort) blocks that operation id forever.
func TestReviewFreeRecoveryRunningReceiptAfterCrash(t *testing.T) {
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	now := time.Now()
	task := model.Task{ID: "paused-free", UserID: "local", Type: "canvas_image", Status: model.TaskStatusSucceeded, Stage: "delivery_paused", RouteRun: 2, ResultJSON: `{"images":[]}`, InputJSON: `{}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"taskId": task.ID, "routeRun": task.RouteRun, "action": "retry"})
	hash := operations.PayloadHash("task.retry", operations.CanonicalJSON(payload))
	// Simulate: previous process claimed the operation, then exited.
	if err := db.Create(&model.AgentOpRecord{UserID: task.UserID, Op: "task.retry", OpID: "op-crash", PayloadHash: hash, Status: "running"}).Error; err != nil {
		t.Fatal(err)
	}
	restarted := NewLocal(svc.repo, svc.dataDir)
	_, err := restarted.RetryTaskWithOperation(task.UserID, task.ID, "op-crash")
	t.Logf("after restart, same op: err=%v", err)
	if err != nil {
		t.Errorf("same operation id stays blocked after process exit: %v", err)
	}
	var record model.AgentOpRecord
	db.Where("op_id = ?", "op-crash").First(&record)
	t.Logf("receipt status=%s", record.Status)
}

// P4: free recovery receipt identity. Contract 3.11 asks for originalRouteRun
// and acceptedRouteRun; check what the free branch persists.
func TestReviewFreeRecoveryReceiptRecordsRouteRuns(t *testing.T) {
	svc, db := openDBRuntimeMatrix(t, t.TempDir())
	defer closeDBRuntimeMatrix(t, svc, db)
	now := time.Now()
	task := model.Task{ID: "paused-free-2", UserID: "local", Type: "canvas_image", Status: model.TaskStatusSucceeded, Stage: "delivery_paused", RouteRun: 3, ResultJSON: `{"images":[]}`, InputJSON: `{}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	first, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "op-free")
	if err != nil {
		t.Fatalf("free resume: %v", err)
	}
	var record model.AgentOpRecord
	if err := db.Where("op_id = ?", "op-free").First(&record).Error; err != nil {
		t.Fatalf("receipt: %v", err)
	}
	t.Logf("first status=%s stage=%s receipt=%s", first.Status, first.Stage, record.ResultJSON)
	var receipt struct {
		Action           string `json:"action"`
		OriginalRouteRun int    `json:"originalRouteRun"`
		AcceptedRouteRun int    `json:"acceptedRouteRun"`
	}
	_ = json.Unmarshal([]byte(record.ResultJSON), &receipt)
	if receipt.OriginalRouteRun != 3 || receipt.AcceptedRouteRun != 3 {
		t.Errorf("free receipt route runs original=%d accepted=%d, want 3/3", receipt.OriginalRouteRun, receipt.AcceptedRouteRun)
	}
	replayed, err := svc.RetryTaskWithOperation(task.UserID, task.ID, "op-free")
	t.Logf("replay: status=%v stage=%v outcome=%+v err=%v", replayed != nil && replayed.Status != "", func() string {
		if replayed != nil {
			return replayed.Stage
		}
		return ""
	}(), func() any {
		if replayed != nil {
			return replayed.Outcome
		}
		return nil
	}(), err)
	current, _ := svc.Task(task.UserID, task.ID)
	if replayed != nil && current != nil && replayed.Stage != current.Stage {
		t.Errorf("replay returned stale snapshot stage=%q, current task stage=%q (contract 3.11: outcome is current projection)", replayed.Stage, current.Stage)
	}
}
