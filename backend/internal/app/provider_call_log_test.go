package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestEnrichAPICallLogRecordsStablePaymentRequiredCode(t *testing.T) {
	log := &model.ApiCallLog{Status: model.ApiCallStatusFailed, StatusCode: 402}
	(&Service{}).EnrichAPICallLog(log, []byte(`{"error":{"message":"insufficient balance api-key=secret"}}`))
	if log.ErrorCode != "quota_unknown" {
		t.Fatalf("ErrorCode = %q, want quota_unknown", log.ErrorCode)
	}
	if log.Error == "" || log.Error == "insufficient balance api-key=secret" || strings.Contains(log.Error, "secret") || strings.Contains(log.Error, "api-key") {
		t.Fatalf("unsafe or empty user-facing error: %q", log.Error)
	}
}

func TestEnrichAPICallLogPersistsProviderBillingEvidence(t *testing.T) {
	log := &model.ApiCallLog{Capability: "video", Path: "/v1/videos/task-1", Status: model.ApiCallStatusSucceeded}
	(&Service{}).EnrichAPICallLog(log, []byte(`{"id":"task-1","status":"failed","usage_state":"charged","billing_state":"settled"}`))
	if log.ProviderRequestID != "task-1" || log.UsageState != "charged" || log.BillingState != "settled" || !log.UsageStatePresent || !log.BillingStatePresent {
		t.Fatalf("billing evidence = %+v", log)
	}
	missing := &model.ApiCallLog{Capability: "image"}
	(&Service{}).EnrichAPICallLog(missing, []byte(`{"id":"image-1"}`))
	if missing.UsageStatePresent || missing.BillingStatePresent || missing.UsageState != "" || missing.BillingState != "" {
		t.Fatalf("missing billing fields were treated as present: %+v", missing)
	}
	empty := &model.ApiCallLog{Capability: "video"}
	(&Service{}).EnrichAPICallLog(empty, []byte(`{"usage_state":"","billing_state":""}`))
	if !empty.UsageStatePresent || !empty.BillingStatePresent || empty.UsageState != "" || empty.BillingState != "" {
		t.Fatalf("empty billing fields lost presence: %+v", empty)
	}
}

func TestCallLogKeepsSpecificFailureWithoutRawProviderEcho(t *testing.T) {
	for _, status := range []int{200, 400, 402, 451} {
		log := &model.ApiCallLog{Status: model.ApiCallStatusFailed, StatusCode: status}
		(&Service{}).EnrichAPICallLog(log, []byte(`{"error":{"code":"prompt_blocked","message":"content safety policy prompt=PRIVATE api_key=PRIVATE"}}`))
		if log.ErrorCode != "prompt_blocked" || !strings.Contains(log.Error, "内容安全审核") || strings.Contains(log.Error, "PRIVATE") {
			t.Fatalf("status %d: unsafe or generic diagnostics: %s %s", status, log.ErrorCode, log.Error)
		}
	}
}
