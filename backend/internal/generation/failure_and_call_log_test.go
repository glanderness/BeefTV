package generation

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestEnrichAPICallLogPayloadNeverTreatsTraceRequestIDOrFailedCreateAsProviderJobID(t *testing.T) {
	t.Run("HTTP 400 error payload with trace request_id keeps ProviderRequestID empty", func(t *testing.T) {
		entry := model.ApiCallLog{
			RequestKind:  "create",
			Status:       model.ApiCallStatusFailed,
			StatusCode:   400,
			ResponseBody: `{"error":{"code":"InvalidParameter","message":"invalid parameter"},"request_id":"req-trace-synthetic-1"}`,
		}
		EnrichAPICallLog(&entry, []byte(entry.ResponseBody))
		if entry.ProviderRequestID != "" {
			t.Fatalf("failed create extracted trace request_id as ProviderRequestID: %q", entry.ProviderRequestID)
		}
	})

	t.Run("HTTP 200 payload with failed status flips Status to failed and skips ProviderRequestID", func(t *testing.T) {
		entry := model.ApiCallLog{
			RequestKind:  "create",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"id":"failed-job-1","status":"failed","error":{"message":"parameter rejected"},"request_id":"req-trace-2"}`,
		}
		EnrichAPICallLog(&entry, []byte(entry.ResponseBody))
		if entry.Status != model.ApiCallStatusFailed || entry.ProviderRequestID != "" {
			t.Fatalf("unexpected entry after failed payload: status=%q providerRequestID=%q", entry.Status, entry.ProviderRequestID)
		}
	})

	t.Run("accepted async create extracts data.task_id while ignoring trace request_id", func(t *testing.T) {
		entry := model.ApiCallLog{
			RequestKind:  "create",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"code":"success","data":{"task_id":"task-async-accepted-1"},"request_id":"req-trace-3"}`,
		}
		EnrichAPICallLog(&entry, []byte(entry.ResponseBody))
		if entry.ProviderRequestID != "task-async-accepted-1" {
			t.Fatalf("ProviderRequestID = %q, want task-async-accepted-1", entry.ProviderRequestID)
		}
	})
}
