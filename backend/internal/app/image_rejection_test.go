package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

func imageRejectionDiagnostics(code, message string) *model.TaskFailureDiagnostics {
	return &model.TaskFailureDiagnostics{
		Source: "upstream_http", ExecutionResult: "failed", HTTPStatus: 400,
		ProviderCode: code, Summary: message, RequestID: "req-rejection-123",
		Requests: []model.TaskRequestEvidence{{Operation: "image_generate", Method: "POST", Dispatched: true, TransportPhase: "response", Outcome: "http_error", HTTPStatus: 400, ProviderCode: code, Summary: message, RequestID: "req-rejection-123"}},
	}
}

func TestImageHTTPRejectionSurvivesExecutionAndTaskOutput(t *testing.T) {
	for _, tc := range []struct{ name, code, message, category string }{
		{"ark-input", "InputTextSensitiveContentDetected", "The request failed because the input text may contain sensitive information.", "moderation_input"},
		{"image-edit", "invalid_request", "`/v1/images/edits` only supports Grok image models.", "invalid_params"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, task, row, _ := imageSubmissionFixture(t, false)
			if err := db.Delete(row).Error; err != nil {
				t.Fatal(err)
			}
			attempt, err := s.repo.LatestRouteAttempt(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]any{"error": map[string]string{"code": tc.code, "message": tc.message}, "request_id": "req-rejection-123"})
			cause := providerHTTPError{StatusCode: 400, Body: string(body)}
			executor := newTaskRouteExecutor(s)
			adapter := executor.port.(taskRouteServiceAdapter)
			calls := 0
			adapter.process = func(context.Context, model.Task) (map[string]interface{}, []map[string]interface{}, error) {
				calls++
				return nil, nil, cause
			}
			executor.port = adapter
			result, err := executor.execute(context.Background(), &task, attempt)
			if err != nil || calls != 1 {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
			failure := classifyTaskFailure(result.err)
			if string(failure.Category) != tc.category || failure.Uncertain || attempt.DispatchState != "rejected_no_job" {
				t.Fatalf("failure=%+v dispatch=%s", failure, attempt.DispatchState)
			}
			_ = s.terminalCoordinator().handleExecutionFailure(&task, result.err, false, false)
			stored, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, got := range []string{taskForOutput(*stored).ErrorCode, taskSummaryForOutput(*stored).ErrorCode} {
				if got != tc.category {
					t.Fatalf("output category=%s", got)
				}
			}
			if stored.Stage == "submission_unknown" || strings.Contains(stored.Error, "结果尚未确认") {
				t.Fatalf("terminal=%+v", stored)
			}
			if err := s.validateImageTaskRetry(stored); err != nil {
				t.Fatalf("edited-input retry blocked: %v", err)
			}
			if !generation.ClassifyText(stored.Error).BlocksAutomaticRetry() {
				t.Fatal("unchanged request must not auto-retry")
			}
		})
	}
}

func TestHistoricalImageRejectionProjectionAndRetry(t *testing.T) {
	s, db, task, row, _ := imageSubmissionFixture(t, false)
	if err := db.Delete(row).Error; err != nil {
		t.Fatal(err)
	}
	task.Status, task.Stage, task.Error = model.TaskStatusFailed, "submission_unknown", "图片结果尚未确认，自动恢复已停止"
	task.FailureDiagnostics = imageRejectionDiagnostics("InputTextSensitiveContentDetected", "The request failed because the input text may contain sensitive information.")
	got := taskForOutput(task)
	if got.ErrorCode != "moderation_input" || got.Stage == "submission_unknown" || !strings.Contains(got.Error, "输入文本未通过内容安全审核") {
		t.Fatalf("detail=%+v", got)
	}
	if taskSummaryForOutput(task).ErrorCode != "moderation_input" {
		t.Fatal("list differs from detail")
	}
	if err := s.validateImageTaskRetry(&task); err != nil {
		t.Fatalf("edited-input retry blocked: %v", err)
	}
	if task.Stage != "submission_unknown" || !strings.HasPrefix(task.Error, "图片结果尚未确认") {
		t.Fatal("raw history changed")
	}
}

func TestHistoricalImageRejectionRequiresCompleteUnambiguousEvidence(t *testing.T) {
	for _, mutate := range []func(*model.Task){
		func(task *model.Task) { task.ProviderRequestID = "accepted-task" },
		func(task *model.Task) { task.ResultJSON = `{"images":["saved-result"]}` },
		func(task *model.Task) { task.FailureDiagnostics.ProviderTaskID = "accepted-task" },
		func(task *model.Task) { task.FailureDiagnostics.OmittedRequests = 1 },
		func(task *model.Task) {
			task.FailureDiagnostics.Requests = append(task.FailureDiagnostics.Requests, model.TaskRequestEvidence{Outcome: "transport_error"})
		},
		func(task *model.Task) { task.FailureDiagnostics.Requests[0].Outcome = "transport_error" },
		func(task *model.Task) { task.FailureDiagnostics.Requests[0].Operation = "image_poll" },
		func(task *model.Task) { task.FailureDiagnostics.Requests[0].TransportPhase = "response_wait" },
		func(task *model.Task) { task.FailureDiagnostics.HTTPStatus = 500 },
	} {
		task := model.Task{Type: "canvas_image", Status: model.TaskStatusFailed, Stage: "submission_unknown", FailureDiagnostics: imageRejectionDiagnostics("invalid_request", "invalid size")}
		mutate(&task)
		if taskForOutput(task).Stage != "submission_unknown" {
			t.Fatalf("uncertainty discarded: %+v", task)
		}
	}
}

func TestImageInputRejectionCannotEraseEarlierSubmission(t *testing.T) {
	for _, body := range []string{
		`{"error":{"code":"invalid_request","message":"invalid size"}}`,
		`{"error":{"code":"invalid_request","message":"Midjourney generates four images per request; n must be 4 or omitted"}}`,
	} {
		for _, accepted := range []bool{false, true} {
			s, _, task, row, _ := imageSubmissionFixture(t, false)
			if accepted {
				if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			_, _, err := s.sendImageSubmissionWith(context.Background(), task, row, func(_ *http.Request, admit func() error) ([]byte, string, error) {
				if err := admit(); err != nil {
					return nil, "", err
				}
				calls++
				if !accepted && calls == 1 {
					return nil, "", io.ErrUnexpectedEOF
				}
				return nil, "", providerHTTPError{StatusCode: 400, Body: body}
			}, noImageWait)
			if !isImageRecoveryError(err) || !classifyTaskFailure(err).Uncertain || calls > 2 {
				t.Fatalf("calls=%d failure=%+v", calls, classifyTaskFailure(err))
			}
			attempt, _ := s.repo.LatestRouteAttempt(task.ID)
			s.finishTaskRouteAttempt(attempt, &task, err)
			if attempt.DispatchState == "rejected_no_job" {
				t.Fatal("prior submission discarded")
			}
		}
	}
}

func TestHistoricalImageInputRejectionCannotOverrideAcceptedAttempt(t *testing.T) {
	for _, state := range []string{"accepted-attempt", "accepted-response", "multiple-sends"} {
		t.Run(state, func(t *testing.T) {
			s, db, task, row, _ := imageSubmissionFixture(t, false)
			task.Status, task.Stage = model.TaskStatusFailed, "submission_unknown"
			task.FailureDiagnostics = imageRejectionDiagnostics("invalid_request", "invalid size")
			switch state {
			case "accepted-attempt":
				attempt, _ := s.repo.LatestRouteAttempt(task.ID)
				attempt.DispatchState = "accepted"
				if err := s.repo.SaveRouteAttempt(attempt); err != nil {
					t.Fatal(err)
				}
			case "accepted-response":
				if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
					t.Fatal(err)
				}
			case "multiple-sends":
				if err := db.Model(row).Update("send_count", 2).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := s.validateImageTaskRetry(&task); err == nil {
				t.Fatal("accepted or earlier uncertain request unlocked")
			}
		})
	}
}
