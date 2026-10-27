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
	for _, state := range []string{"", "settled", "charged", "unknown"} {
		if billingEvidenceConfirmsNoCharge(state, "") {
			t.Fatalf("state %q was treated as no-charge evidence", state)
		}
	}
	for _, states := range [][2]string{{"failed", ""}, {"", "failed"}} {
		if billingEvidenceConfirmsNoCharge(states[0], states[1]) {
			t.Fatalf("billing states %q/%q were treated as explicit no-charge evidence", states[0], states[1])
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
		Source: "beefapi", Capability: "video", RequestKind: "create", Method: "POST",
		BillingState: "refunded", BillingStatePresent: true, ResponseBody: `{"large":"must not be selected"}`, CreatedAt: now,
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

func TestVideoBillingEvidenceMergeHonorsExplicitEmptyStates(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	root := model.ApiCallLog{ID: "billing-root", UserID: "user", TaskID: "billing-merge-task", Source: "beefapi", Capability: "video", RequestKind: "create", Method: "POST", Status: model.ApiCallStatusSucceeded, BillingState: "refunded", BillingStatePresent: true, CreatedAt: now}
	if err := db.Create(&root).Error; err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"", "settled"} {
		log := model.ApiCallLog{ID: "billing-poll-" + state, UserID: root.UserID, TaskID: root.TaskID, Source: "beefapi", Capability: "video", RequestKind: "poll", Method: "GET", Status: model.ApiCallStatusSucceeded, BillingState: state, BillingStatePresent: true, CreatedAt: now.Add(time.Second)}
		if _, err := s.mergeVideoAPICallLog(log); err != nil {
			t.Fatal(err)
		}
		stored, err := s.repo.APICallLog(root.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.BillingState != state || !stored.BillingStatePresent {
			t.Fatalf("state %q did not overwrite prior evidence: %+v", state, stored)
		}
	}
}

func TestTaskProviderBillingEvidenceIgnoresThirdPartyBillingFields(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	task := model.Task{ID: "third-party-billing-task", UserID: "user", Type: "canvas_video", Status: model.TaskStatusFailed, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{
		ID: "third-party-billing-log", UserID: task.UserID, TaskID: task.ID,
		Source: "backend-task", Capability: "video", RequestKind: "create", Method: "POST",
		BillingState: "refunded", BillingStatePresent: true, CreatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	facts, err := s.repo.TaskProviderBillingEvidence([]string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := facts[task.ID]; ok {
		t.Fatalf("third-party billing evidence was accepted: %#v", facts[task.ID])
	}
	if got := s.taskOutcomeFacts([]model.Task{task})[task.ID]; got.ConfirmedUncharged {
		t.Fatalf("third-party billing evidence allowed retry: %#v", got)
	}
}
