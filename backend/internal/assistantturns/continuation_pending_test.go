package assistantturns_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
)

func TestPendingContinuationsScansBoundedReceiptsAndSkipsTerminalRows(t *testing.T) {
	fx := openTurnFixture(t)
	for index := range 20 {
		id := fmt.Sprintf("%024x", index)
		state := "waiting"
		if index == 0 {
			state = "done"
		} else if index == 1 {
			state = "cancelled"
		} else if index == 2 {
			state = "claimed"
		} else if index == 3 {
			state = "running"
		}
		if err := fx.db.Create(&model.AssistantContinuation{ID: id, TurnID: id, UserID: fx.userID, State: state}).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, err := fx.turns.PendingContinuations("", 0)
	if err != nil || len(first) != 16 || first[0].State != "claimed" || first[1].State != "running" {
		t.Fatalf("first page: %+v %v", first, err)
	}
	last, err := fx.turns.PendingContinuations(first[len(first)-1].ID, 16)
	if err != nil || len(last) != 2 || last[0].ID <= first[len(first)-1].ID {
		t.Fatalf("last page: %+v %v", last, err)
	}
	if rows, err := fx.turns.PendingContinuations("", 1000); err != nil || len(rows) != 16 {
		t.Fatalf("unbounded scan: %d %v", len(rows), err)
	}
}

func TestProjectTaskInTxHydratesProviderRequestIDForCancelledTask(t *testing.T) {
	fx := openTurnFixture(t)
	now := time.Now().UTC()
	task := model.Task{
		ID:        "cancelled-log-only-req",
		UserID:    fx.userID,
		ProjectID: "canvas-1",
		Type:      "canvas_video",
		Status:    model.TaskStatusCancelled,
		Stage:     "任务已取消",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := fx.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	logRow := model.ApiCallLog{
		ID:                "log-cancelled-req-1",
		UserID:            fx.userID,
		TaskID:            task.ID,
		Capability:        "video",
		RequestKind:       "create",
		Method:            http.MethodPost,
		Status:            model.ApiCallStatusSucceeded,
		ProviderRequestID: "upstream-video-log-only",
		CreatedAt:         now,
	}
	if err := fx.db.Create(&logRow).Error; err != nil {
		t.Fatal(err)
	}

	proj, _, _, err := assistantturns.ProjectTaskInTx(fx.db, fx.userID, task)
	if err != nil {
		t.Fatal(err)
	}
	want := model.TaskOutcome{Phase: "failed", Regenerate: "confirm", Reason: "cancelled_result_unconfirmed"}
	if proj.Outcome != want {
		t.Fatalf("ProjectTaskInTx cancelled log-only outcome = %+v, want %+v", proj.Outcome, want)
	}
}
