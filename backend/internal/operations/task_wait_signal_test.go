package operations

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestEvaluateTaskWaitSignalMatchesTaskWaitState(t *testing.T) {
	cases := []struct {
		name        string
		task        model.Task
		wantSettled bool
		wantState   string
		wantReason  string
	}{
		{
			name:        "queued is pending",
			task:        model.Task{ID: "t-queued", Status: model.TaskStatusQueued},
			wantSettled: false,
		},
		{
			name:        "running is pending",
			task:        model.Task{ID: "t-running", Status: model.TaskStatusRunning},
			wantSettled: false,
		},
		{
			name: "succeeded without saved resourceId is still saving",
			task: model.Task{
				ID:     "t-saving",
				Status: model.TaskStatusSucceeded,
				Outputs: []model.TaskOutput{
					{OutputIndex: 0, ResourceID: ""},
				},
			},
			wantSettled: false,
		},
		{
			name: "failed with retrievable phase is still downloading",
			task: model.Task{
				ID:      "t-retrievable",
				Status:  model.TaskStatusFailed,
				Outcome: &model.TaskOutcome{Phase: "retrievable"},
			},
			wantSettled: false,
		},
		{
			name: "succeeded with saved resourceId is settled completed",
			task: model.Task{
				ID:          "t-saved",
				Status:      model.TaskStatusSucceeded,
				ResultState: "ready",
				Outputs: []model.TaskOutput{
					{OutputIndex: 0, ResourceID: "res-1"},
				},
			},
			wantSettled: true,
			wantState:   "completed",
			wantReason:  "saved",
		},
		{
			name: "succeeded with permanent materialization failure is settled failed",
			task: model.Task{
				ID:          "t-mat-fail",
				Status:      model.TaskStatusSucceeded,
				ResultState: "failed_permanent",
				Outputs: []model.TaskOutput{
					{OutputIndex: 0, MaterializationErrorCode: "download_404"},
				},
			},
			wantSettled: true,
			wantState:   "failed",
			wantReason:  "materialization_failed",
		},
		{
			name: "failed task is settled failed",
			task: model.Task{
				ID:     "t-failed",
				Status: model.TaskStatusFailed,
				Error:  "upstream rejected",
			},
			wantSettled: true,
			wantState:   "failed",
			wantReason:  "task_failed",
		},
		{
			name: "cancelled task is settled cancelled",
			task: model.Task{
				ID:     "t-cancelled",
				Status: model.TaskStatusCancelled,
				Error:  "任务已取消",
			},
			wantSettled: true,
			wantState:   "failed",
			wantReason:  "cancelled",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EvaluateTaskWaitSignal(tc.task)
			if got.Settled != tc.wantSettled {
				t.Fatalf("Settled=%v, want %v (payload=%+v)", got.Settled, tc.wantSettled, got.Payload)
			}
			if !tc.wantSettled {
				return
			}
			if got.Payload["taskId"] != tc.task.ID {
				t.Fatalf("payload taskId=%v, want %q", got.Payload["taskId"], tc.task.ID)
			}
			if got.Payload["state"] != tc.wantState {
				t.Fatalf("payload state=%v, want %q", got.Payload["state"], tc.wantState)
			}
			if got.Payload["reason"] != tc.wantReason {
				t.Fatalf("payload reason=%v, want %q", got.Payload["reason"], tc.wantReason)
			}
		})
	}
}
