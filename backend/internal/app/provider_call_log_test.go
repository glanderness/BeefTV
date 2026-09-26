package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestEnrichAPICallLogRecordsStablePaymentRequiredCode(t *testing.T) {
	log := &model.ApiCallLog{Status: model.ApiCallStatusFailed, StatusCode: 402}
	(&Service{}).EnrichAPICallLog(log, []byte(`{"error":{"message":"insufficient balance api-key=secret"}}`))
	if log.ErrorCode != "provider_payment_required" {
		t.Fatalf("ErrorCode = %q, want provider_payment_required", log.ErrorCode)
	}
	if log.Error == "" || log.Error == "insufficient balance api-key=secret" || strings.Contains(log.Error, "secret") || strings.Contains(log.Error, "api-key") {
		t.Fatalf("unsafe or empty user-facing error: %q", log.Error)
	}
}
