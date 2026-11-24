package app

import (
	"encoding/json"
	"gorm.io/gorm"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantProductionAtomicAuthorizationAndReplay(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{map[string]any{"id": "image", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "雨后的花店", "size": "9:16", "count": 1}}, map[string]any{"id": "speech", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "把春天，带回家。", "model": "custom::speech", "audioVoice": "alloy"}}}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "aabbccdd11229900"
	if _, err := svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(source); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"image", "speech"})
	if err != nil {
		t.Fatal(err)
	}
	request := AssistantProductionConfirmation{CanvasID: canvasID, ProposalID: "gp-production-test", Kind: "image", NodeIDs: []string{"image"}, Targets: targets}
	if err = svc.Database().Exec("CREATE TRIGGER fail_production_admission BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'fixture admission failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ConfirmAssistantProduction("local", source, request); err == nil {
		t.Fatal("admission fault accepted")
	}
	var rejected model.AssistantTurn
	if err = svc.Database().First(&rejected, "turn_id = ?", source).Error; err != nil || rejected.GenerationAuthorizationJSON != "" {
		t.Fatal("failed admission left a spend authorization", err)
	}
	var rolledBack int64
	svc.Database().Model(&model.Task{}).Count(&rolledBack)
	if rolledBack != 0 {
		t.Fatal("failed admission left paid tasks", rolledBack)
	}
	svc.Database().Model(&model.AssistantContinuation{}).Count(&rolledBack)
	if rolledBack != 0 {
		t.Fatal("failed admission left a continuation", rolledBack)
	}
	if err = svc.Database().Exec("DROP TRIGGER fail_production_admission").Error; err != nil {
		t.Fatal(err)
	}
	var stale model.AssistantTurn
	if err := svc.Database().First(&stale, "turn_id = ?", source).Error; err != nil {
		t.Fatal(err)
	}
	first, err := svc.ConfirmAssistantProduction("local", source, request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.ConfirmAssistantProduction("local", source, request)
	if err != nil {
		t.Fatal(err)
	}
	if first.(map[string]any)["taskIds"].([]string)[0] != second.(map[string]any)["taskIds"].([]string)[0] {
		t.Fatal("confirmation replay purchased another task")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("expected exactly one accepted task", count)
	}
	var origin model.AssistantTurn
	svc.Database().First(&origin, "turn_id = ?", source)
	if origin.GenerationAuthorizationJSON == "" {
		t.Fatal("authorization not persisted")
	}
	if err := svc.repo.SaveAssistantTurn(nil, &stale); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().First(&origin, "turn_id = ?", source).Error; err != nil || origin.GenerationAuthorizationJSON == "" {
		t.Fatal("delayed settlement erased production authorization", err)
	}
	if first.(map[string]any)["revision"] != second.(map[string]any)["revision"] {
		t.Fatal("same confirmation changed canvas revision")
	}
	// The next official round receives the same finite grant, never a transcript-derived permission.
	const next = "bbccddaa11229900"
	if _, err = svc.BeginAssistantTurn("local", canvasID, next, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err = svc.AssistantTurns().BindDurableSession("local", next, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	svc.Database().Model(&model.AssistantTurn{}).Where("turn_id = ?", next).Update("generation_authorization_json", origin.GenerationAuthorizationJSON)
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, targets[1:])
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("next approved stage not admitted", count)
	}
	imageTask := first.(map[string]any)["taskIds"].([]string)[0]
	if err = svc.Database().Model(&model.Task{}).Where("id = ?", imageTask).Updates(map[string]any{"status": "failed", "error": "fixture local preflight failure"}).Error; err != nil {
		t.Fatal(err)
	}
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, targets[:1])
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	failedDoc, _ := svc.UserCanvasProject("local", canvasID)
	var failed map[string]any
	_ = json.Unmarshal(failedDoc, &failed)
	failedMeta := failed["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)
	if failedMeta["status"] != "error" || failedMeta["taskStatus"] != "failed" || failedMeta["error"] != "fixture local preflight failure" {
		t.Fatal("original failed task disguised as generating", failedMeta)
	}
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("recovering failed receipt created another purchase", count)
	}
	changed := targets[1]
	changed.Prompt = "新增一段未确认的旁白"
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, []operations.GenerationTarget{changed})
		return e
	})
	if err == nil {
		t.Fatal("changed paid input accepted")
	}
	if err = svc.AssistantTurns().CancelContinuations("local", canvasID, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", next, canvasID, targets[1:])
		return e
	})
	if err == nil {
		t.Fatal("stopped authorization revived")
	}
}

func TestAssistantProductionPendingProposalCannotAuthorizeNextTurn(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "image", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "雨后的花店", "size": "9:16", "count": 1}},
		map[string]any{"id": "speech", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "把春天，带回家。", "model": "custom::speech", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"image", "speech"})
	if err != nil {
		t.Fatal(err)
	}

	const proposeTurn = "1111222233334444"
	if _, err := svc.BeginAssistantTurn("local", canvasID, proposeTurn, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", proposeTurn, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return svc.BindDomain(tx).(*operationSession).RecordAssistantGenerationProposal("local", proposeTurn, canvasID, operations.GenerationAuthorization{
			ProposalID: "gp-chat-confirm",
			Targets:    targets,
		})
	}); err != nil {
		t.Fatal(err)
	}
	// Self-confirming in the same turn without a user reply must be rejected.
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", proposeTurn, canvasID, targets[:1])
		return e
	}); err == nil {
		t.Fatal("model self-confirmed proposal in the proposing turn")
	}
	if err := svc.FinalizeAssistantTurn(proposeTurn); err != nil {
		t.Fatal(err)
	}

	// A new user turn (question, rejection, or edit request)
	// invalidates previous continuations on /assistant/chat admission.
	if err := svc.AssistantTurns().CancelContinuations("local", canvasID, backgroundContinuationSession, true); err != nil {
		t.Fatal(err)
	}
	const confirmTurn = "5555666677778888"
	if _, err := svc.BeginAssistantTurn("local", canvasID, confirmTurn, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", confirmTurn, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}

	// A model's next-turn submit call is not a user confirmation event.
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", confirmTurn, canvasID, targets[:1])
		return e
	})
	if err == nil {
		t.Fatal("pending proposal was promoted without an explicit confirmation grant")
	}
	var count int64
	svc.Database().Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatalf("unconfirmed next turn admitted %d paid tasks", count)
	}
	for _, id := range []string{proposeTurn, confirmTurn} {
		var turn model.AssistantTurn
		if err := svc.Database().First(&turn, "turn_id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		var grant operations.GenerationAuthorization
		if turn.GenerationAuthorizationJSON != "" {
			_ = json.Unmarshal([]byte(turn.GenerationAuthorizationJSON), &grant)
		}
		if grant.SourceTurnID != "" {
			t.Fatal("unconfirmed call persisted a spend grant")
		}
	}
}

func TestContinuationTurnCanConfirmNewProductionAndSingleBatchProposal(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	sqlDB, _ := svc.Database().DB()
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "img1", "type": "image", "title": "镜头1", "metadata": map[string]any{"prompt": "茶杯", "size": "1:1", "count": 1}},
		map[string]any{"id": "img2", "type": "image", "title": "镜头2", "metadata": map[string]any{"prompt": "书桌", "size": "1:1", "count": 1}},
		map[string]any{"id": "img3", "type": "image", "title": "镜头3", "metadata": map[string]any{"prompt": "窗台", "size": "1:1", "count": 1}},
		map[string]any{"id": "speech2", "type": "audio", "title": "旁白2", "metadata": map[string]any{"prompt": "清晨阳光。", "model": "custom::speech", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}

	// Turn 1 confirms P1 (img1)
	const turn1 = "101010101010101010101010"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn1, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn1, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(turn1); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targetsP1, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmAssistantProduction("local", turn1, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn1-shot1", Kind: "image", NodeIDs: []string{"img1"}, Targets: targetsP1, ContinuePlan: true,
	}); err != nil {
		t.Fatalf("Turn 1 confirm failed: %v", err)
	}
	var t1Row model.AssistantTurn
	if err := svc.Database().First(&t1Row, "turn_id = ?", turn1).Error; err != nil {
		t.Fatal(err)
	}

	// Continuation Turn 2 inherits T1's GenerationAuthorizationJSON, proposes NEW production P2 (img2 + speech2)
	const turn2 = "202020202020202020202020202020202020202020202020"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn2, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn2, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Model(&model.AssistantTurn{}).Where("turn_id = ?", turn2).Update("generation_authorization_json", t1Row.GenerationAuthorizationJSON).Error; err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targetsP2, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img2", "speech2"})
	if err != nil {
		t.Fatal(err)
	}
	// Propose in T2: RecordAssistantGenerationProposal preserves inherited T1 grant while T2 runs,
	// while GenerationOrder records P2 with SourceTurnID=turn2.
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		dom := svc.BindDomain(tx).(*operationSession)
		if err := dom.RecordAssistantGenerationProposal("local", turn2, canvasID, operations.GenerationAuthorization{ProposalID: "gp-turn2-shot2", Targets: targetsP2}); err != nil {
			return err
		}
		return dom.RecordGenerationOrder("local", operations.GenerationOrder{
			OrderID: "gp-turn2-shot2", ProposalID: "gp-turn2-shot2", CanvasID: canvasID, Status: operations.GenerationOrderPending,
			Kind: "image", NodeIDs: []string{"img2"}, ProductionNodeIDs: []string{"img2", "speech2"}, Targets: targetsP2, SourceTurnID: turn2,
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(turn2); err != nil {
		t.Fatal(err)
	}

	// Confirming P2 on continuation Turn 2 must succeed (previously 409 production_changed deadlock!)
	res2, err := svc.ConfirmAssistantProduction("local", turn2, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn2-shot2", Kind: "image", NodeIDs: []string{"img2"}, Targets: targetsP2, ContinuePlan: true,
	})
	if err != nil {
		t.Fatalf("Continuation Turn 2 production confirm failed: %v", err)
	}
	res2Map := res2.(map[string]any)
	if len(res2Map["taskIds"].([]string)) != 1 || res2Map["continuationId"] == "" {
		t.Fatalf("unexpected Turn 2 confirm result: %#v", res2Map)
	}

	// Replaying the exact same P2 on Turn 2 must stay idempotent
	res2Replay, err := svc.ConfirmAssistantProduction("local", turn2, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn2-shot2", Kind: "image", NodeIDs: []string{"img2"}, Targets: targetsP2, ContinuePlan: true,
	})
	if err != nil {
		t.Fatalf("Turn 2 replay confirm failed: %v", err)
	}
	if res2Replay.(map[string]any)["taskIds"].([]string)[0] != res2Map["taskIds"].([]string)[0] {
		t.Fatal("Turn 2 replay created a duplicate task")
	}

	// Confirming a DIFFERENT proposal on Turn 2 AFTER Turn 2 already confirmed P2 must still return 409 production_changed
	targetsP3, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img3"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmAssistantProduction("local", turn2, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn2-conflict", Kind: "image", NodeIDs: []string{"img3"}, Targets: targetsP3, ContinuePlan: true,
	}); operations.AsError(err) == nil || operations.AsError(err).Reason != "production_changed" {
		t.Fatalf("expected 409 production_changed for second distinct confirmation on same turn, got: %v", err)
	}

	// Continuation Turn 3 inherits T2's newly confirmed grant:
	// (a) T3 can submit already-authorized speech2 from P2 without re-confirmation;
	// (b) T3 can also propose a single-batch ordinary proposal (omitting inline Targets) and confirm it!
	var t2Row model.AssistantTurn
	if err := svc.Database().First(&t2Row, "turn_id = ?", turn2).Error; err != nil {
		t.Fatal(err)
	}
	const turn3 = "303030303030303030303030303030303030303030303030"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn3, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn3, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Model(&model.AssistantTurn{}).Where("turn_id = ?", turn3).Update("generation_authorization_json", t2Row.GenerationAuthorizationJSON).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", turn3, canvasID, targetsP2[1:])
		return e
	}); err != nil {
		t.Fatalf("Turn 3 authorized submit for P2 stage 2 failed: %v", err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return svc.BindDomain(tx).(*operationSession).RecordGenerationOrder("local", operations.GenerationOrder{
			OrderID: "gp-turn3-single", ProposalID: "gp-turn3-single", CanvasID: canvasID, Status: operations.GenerationOrderPending,
			Kind: "image", NodeIDs: []string{"img3"}, Targets: targetsP3, SourceTurnID: turn3,
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(turn3); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmAssistantProduction("local", turn3, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn3-single", Kind: "image", NodeIDs: []string{"img3"}, ContinuePlan: false,
	}); err != nil {
		t.Fatalf("Continuation Turn 3 single-batch confirm (without inline Targets) failed: %v", err)
	}
}
