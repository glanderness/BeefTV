package app

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestBillingEvidenceConfirmsNoChargeOnlyForExplicitStates(t *testing.T) {
	for _, state := range []string{"not_charged", "not-charged", "uncharged", "no_charge", "refunded", "refund_completed"} {
		if !billingEvidenceConfirmsNoCharge(state, "") {
			t.Fatalf("state %q was not recognized as explicit no-charge evidence", state)
		}
	}
	for _, state := range []string{"", "settled", "charged", "unknown", "failed"} {
		if billingEvidenceConfirmsNoCharge(state, "") {
			t.Fatalf("state %q was treated as no-charge evidence", state)
		}
	}
}

func TestTaskProviderBillingEvidenceReadsOnlyLatestSmallFields(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	task := model.Task{ID: "billing-evidence-task", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{
		ID: "billing-evidence-log", UserID: task.UserID, TaskID: task.ID,
		Capability: "video", RequestKind: "create", Method: "POST",
		BillingState: "refunded", ResponseBody: `{"large":"must not be selected"}`, CreatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	facts, err := s.repo.TaskProviderBillingEvidence([]string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	if facts[task.ID].BillingState != "refunded" || facts[task.ID].UsageState != "" {
		t.Fatalf("billing evidence = %#v", facts[task.ID])
	}
	outcomeFacts := s.taskOutcomeFacts([]model.Task{task})[task.ID]
	if !outcomeFacts.ConfirmedUncharged || outcomeFacts.Unreadable {
		t.Fatalf("outcome billing facts = %#v", outcomeFacts)
	}
}
