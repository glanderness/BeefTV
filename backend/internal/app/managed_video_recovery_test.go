package app

import (
	"context"
	"infinite-canvas/backend/internal/model"
	"testing"
	"time"
)

func TestManagedVideoDoesNotInferSettlementOrExpiry(t *testing.T) {
	task := model.Task{ID: "managed-no-receipt", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, CreatedAt: time.Now().Add(-48 * time.Hour), InputJSON: `{"mode":"video","config":{"credentialRef":"beefapi-enterprise","apiKey":"enc:unread"}}`}
	if videoTaskPastRetentionWindow(task, time.Now()) {
		t.Fatal("local clock expired an API task")
	}
	for _, cause := range []error{providerHTTPError{StatusCode: 404}, context.DeadlineExceeded, context.Canceled} {
		if outcome := classifyFailedVideoQueryOutcome(task, "", cause); outcome != "" {
			t.Fatalf("unknown query inferred %s", outcome)
		}
	}
	if outcome := classifyFailedVideoQueryOutcome(task, "failed", providerHTTPError{StatusCode: 500}); outcome != "" {
		t.Fatal("missing settlement was treated as a known outcome")
	}
	svc, db, _, _ := creationTestService(t)
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	svc.recordMissingVideoReceiptOutcome(&task, task.UserID)
	stored, err := svc.repo.Task(task.ID)
	if err != nil || stored.RecoveryOutcome != nil || stored.NextPollAt == nil {
		t.Fatalf("unknown receipt was closed: %+v err=%v", stored, err)
	}
	task.InputJSON = `{"mode":"video","config":{"channelId":"beefapi","apiKey":"enc:unread"}}`
	if videoTaskPastRetentionWindow(task, time.Now()) {
		t.Fatal("historical built-in channel expired locally")
	}
	task.InputJSON = `{"mode":"video","config":{"baseUrl":"https://enterprise.beefapi.com","apiKey":"enc:third-party-key"}}`
	if !videoTaskPastRetentionWindow(task, time.Now()) {
		t.Fatal("BYOK retention behavior changed")
	}
}
