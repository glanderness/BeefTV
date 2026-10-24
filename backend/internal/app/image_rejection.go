package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
)

// A completed input rejection ends this attempt. It does not authorize an
// automatic resend, and cannot erase an earlier accepted or uncertain request.
func definiteImageInputRejection(err error) bool {
	var unknown generation.SubmissionUnknownError
	var pending generation.StatePendingError
	var upstream providerHTTPError
	if isImageRecoveryError(err) || errors.As(err, &unknown) || errors.As(err, &pending) || !errors.As(err, &upstream) || upstream.IdempotencyReplayed {
		return false
	}
	if upstream.StatusCode != http.StatusBadRequest && upstream.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	failure := classifyProviderHTTP(upstream)
	if failure.Uncertain || failure.TaskID != "" || strings.Contains(upstream.Body, "upstream_task_id:") {
		return false
	}
	var body map[string]any
	if json.Unmarshal([]byte(upstream.Body), &body) == nil && imageRejectionHasJob(body, 0) {
		return false
	}
	switch failure.Category {
	case generation.CategoryInvalidParams, generation.CategoryModerationInput, generation.CategoryModerationReference,
		generation.CategoryInputTooLarge, generation.CategoryInputInaccessible, generation.CategoryContextTooLong:
		return true
	}
	return false
}

func imageRejectionHasJob(body map[string]any, depth int) bool {
	if depth > 8 {
		return true
	}
	for _, key := range []string{"id", "task_id", "taskId"} {
		if value := body[key]; value != nil && value != "" {
			return true
		}
	}
	for _, key := range []string{"data", "error", "output"} {
		if child, ok := body[key].(map[string]any); ok && imageRejectionHasJob(child, depth+1) {
			return true
		}
		if children, ok := body[key].([]any); ok && len(children) > 0 {
			return true
		}
	}
	return false
}

// Only one fully recorded create response can repair the historical label.
// Poll errors, omitted requests and earlier transport failures cannot prove rejection.
func recordedImageInputRejection(task model.Task) (generation.Failure, bool) {
	d := task.FailureDiagnostics
	if task.Type != "canvas_image" || task.Status != model.TaskStatusFailed || task.Stage != "submission_unknown" || task.ProviderRequestID != "" || task.ResultJSON != "" || len(task.Outputs) != 0 || d == nil || d.ProviderTaskID != "" || d.Source != "upstream_http" || d.ExecutionResult != "failed" || d.OmittedRequests != 0 || len(d.Requests) != 1 {
		return generation.Failure{}, false
	}
	r := d.Requests[0]
	if !r.Dispatched || r.Method != http.MethodPost || (r.Operation != "image_generate" && r.Operation != "image_edit") || r.TransportPhase != "response" || r.Outcome != "http_error" || r.HTTPStatus != d.HTTPStatus || r.ProviderCode != d.ProviderCode || r.RequestID != d.RequestID {
		return generation.Failure{}, false
	}
	raw, _ := json.Marshal(map[string]any{"error": map[string]string{"code": r.ProviderCode, "message": r.Summary}, "request_id": r.RequestID})
	err := providerHTTPError{StatusCode: r.HTTPStatus, Body: string(raw)}
	return classifyProviderHTTP(err), definiteImageInputRejection(err)
}
