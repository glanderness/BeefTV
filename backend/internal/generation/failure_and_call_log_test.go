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

	t.Run("xai-style video create path /v1/videos/generations extracts request_id on success and stays empty on failure", func(t *testing.T) {
		okEntry := model.ApiCallLog{
			RequestKind:  "create",
			Capability:   "video",
			Path:         "/v1/videos/generations",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"request_id":"xai-video-job-123"}`,
		}
		EnrichAPICallLog(&okEntry, []byte(okEntry.ResponseBody))
		if okEntry.ProviderRequestID != "xai-video-job-123" {
			t.Fatalf("ProviderRequestID = %q, want xai-video-job-123", okEntry.ProviderRequestID)
		}

		failEntry := model.ApiCallLog{
			RequestKind:  "create",
			Capability:   "video",
			Path:         "/v1/videos/generations",
			Status:       model.ApiCallStatusFailed,
			StatusCode:   400,
			ResponseBody: `{"error":{"code":"invalid_request","message":"invalid duration"},"request_id":"req-trace-400"}`,
		}
		EnrichAPICallLog(&failEntry, []byte(failEntry.ResponseBody))
		if failEntry.ProviderRequestID != "" {
			t.Fatalf("failed create on /v1/videos/generations polluted ProviderRequestID: %q", failEntry.ProviderRequestID)
		}
	})

	t.Run("explicit job ID in failed create without error.code stays recoverable and is not misclassified as rejected_no_job", func(t *testing.T) {
		body := []byte(`{"status":"failed","task_id":"job-accepted-1","message":"invalid parameter"}`)
		explicitID, err := extractExplicitProviderJobID(body)
		if err != nil || explicitID != "job-accepted-1" {
			t.Fatalf("extractExplicitProviderJobID = %q, err=%v", explicitID, err)
		}
		resultErr := ProtocolResultError("invalid parameter", explicitID, body)
		if DefiniteImageInputRejection(resultErr) {
			t.Fatalf("failed create with accepted task_id must not be DefiniteImageInputRejection: %v", resultErr)
		}
	})

	t.Run("managed media poll path /v1/media/tasks/<task_ref> never treats client task_ref as ProviderRequestID when task_id is absent", func(t *testing.T) {
		unknownPoll := model.ApiCallLog{
			RequestKind:  "poll",
			Capability:   "video",
			Path:         "/v1/media/tasks/c64554ba-b04b-5993-b7e8-9bb37fa907e9",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"task_ref":"c64554ba-b04b-5993-b7e8-9bb37fa907e9","media_type":"video","status":"unknown","error":{"code":"media_result_unknown","category":"unknown","message":"The original submission is unconfirmed."}}`,
		}
		EnrichAPICallLog(&unknownPoll, []byte(unknownPoll.ResponseBody))
		if unknownPoll.ProviderRequestID != "" {
			t.Fatalf("managed media poll without task_id polluted ProviderRequestID with task_ref: %q", unknownPoll.ProviderRequestID)
		}

		rejectedPoll := model.ApiCallLog{
			RequestKind:  "poll",
			Capability:   "video",
			Path:         "/v1/media/tasks/c64554ba-b04b-5993-b7e8-9bb37fa907e9",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"task_ref":"c64554ba-b04b-5993-b7e8-9bb37fa907e9","media_type":"video","status":"failed","error":{"code":"media_submission_rejected","category":"upstream","message":"The original submission did not start and was not charged."}}`,
		}
		EnrichAPICallLog(&rejectedPoll, []byte(rejectedPoll.ResponseBody))
		if rejectedPoll.ProviderRequestID != "" {
			t.Fatalf("managed media rejected poll without task_id polluted ProviderRequestID: %q", rejectedPoll.ProviderRequestID)
		}

		for _, variantPath := range []string{
			"/v1/media/tasks/c64554ba-b04b-5993-b7e8-9bb37fa907e9?poll=1",
			"/v1/media/tasks/c64554ba-b04b-5993-b7e8-9bb37fa907e9/content",
		} {
			if got := ProviderRequestIDFromPath(variantPath); got != "" {
				t.Fatalf("ProviderRequestIDFromPath(%q) = %q, want empty", variantPath, got)
			}
		}

		acceptedPoll := model.ApiCallLog{
			RequestKind:  "poll",
			Capability:   "video",
			Path:         "/v1/media/tasks/c64554ba-b04b-5993-b7e8-9bb37fa907e9",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"task_ref":"c64554ba-b04b-5993-b7e8-9bb37fa907e9","task_id":"task_real_provider_id","media_type":"video","status":"in_progress"}`,
		}
		EnrichAPICallLog(&acceptedPoll, []byte(acceptedPoll.ResponseBody))
		if acceptedPoll.ProviderRequestID != "task_real_provider_id" {
			t.Fatalf("ProviderRequestID = %q, want task_real_provider_id", acceptedPoll.ProviderRequestID)
		}
	})

	t.Run("dashscope output envelopes extract output.task_id and never pollute ProviderRequestID with tracing request_id", func(t *testing.T) {
		asyncCreate := model.ApiCallLog{
			RequestKind:  "create",
			Capability:   "image",
			Path:         "/api/v1/services/aigc/image-generation/generation",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"output":{"task_id":"dash-task-1","task_status":"PENDING"},"request_id":"dash-trace-create"}`,
		}
		EnrichAPICallLog(&asyncCreate, []byte(asyncCreate.ResponseBody))
		if asyncCreate.ProviderRequestID != "dash-task-1" {
			t.Fatalf("async create ProviderRequestID = %q, want dash-task-1", asyncCreate.ProviderRequestID)
		}

		syncCreate := model.ApiCallLog{
			RequestKind:  "create",
			Capability:   "image",
			Path:         "/api/v1/services/aigc/multimodal-generation/generation",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"output":{"choices":[{"message":{"content":[{"image":"https://cdn.example/out.png"}]}}]},"request_id":"dash-trace-sync"}`,
		}
		EnrichAPICallLog(&syncCreate, []byte(syncCreate.ResponseBody))
		if syncCreate.ProviderRequestID != "" {
			t.Fatalf("sync DashScope create polluted ProviderRequestID with tracing request_id: %q", syncCreate.ProviderRequestID)
		}

		dashPoll := model.ApiCallLog{
			RequestKind:  "poll",
			Capability:   "image",
			Path:         "/api/v1/tasks/dash-task-1",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"output":{"task_status":"RUNNING"},"request_id":"dash-trace-poll"}`,
		}
		EnrichAPICallLog(&dashPoll, []byte(dashPoll.ResponseBody))
		if dashPoll.ProviderRequestID != "dash-task-1" {
			t.Fatalf("DashScope poll overwrote path taskId with tracing request_id: got %q, want dash-task-1", dashPoll.ProviderRequestID)
		}

		genericPoll := model.ApiCallLog{
			RequestKind:  "poll",
			Capability:   "video",
			Path:         "/v1/videos/vid-real-99",
			Status:       model.ApiCallStatusSucceeded,
			StatusCode:   200,
			ResponseBody: `{"status":"in_progress","request_id":"trace-poll-99"}`,
		}
		EnrichAPICallLog(&genericPoll, []byte(genericPoll.ResponseBody))
		if genericPoll.ProviderRequestID != "vid-real-99" {
			t.Fatalf("poll response tracing request_id overwrote path taskId: got %q, want vid-real-99", genericPoll.ProviderRequestID)
		}
	})
}
