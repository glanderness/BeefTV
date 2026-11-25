package app

import (
	"encoding/json"
	"fmt"
	"gorm.io/gorm"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestAssistantProductionConfirmsLargeBatchWithContinuePlan(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	nodes := make([]any, 0, 12)
	nodeIDs := make([]string, 0, 12)
	for i := 1; i <= 12; i++ {
		id := fmt.Sprintf("batch-img-%d", i)
		nodeIDs = append(nodeIDs, id)
		nodes = append(nodes, map[string]any{
			"id": id, "type": "image", "title": id,
			"metadata": map[string]any{"prompt": "雨后街景", "size": "9:16", "count": 1},
		})
	}
	doc["nodes"] = nodes
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "aabbccdd11228812"
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
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, nodeIDs)
	if err != nil {
		t.Fatal(err)
	}
	request := AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-large-12", Kind: "image",
		NodeIDs: nodeIDs, Targets: targets, ContinuePlan: true,
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return operations.UpsertGenerationOrderInTx(tx, "local", operations.GenerationOrder{
			OrderID: request.ProposalID, ProposalID: request.ProposalID, CanvasID: canvasID,
			CallerKind: operations.CallerAssistant, ApprovalMode: operations.ApprovalModeAsk,
			Status: operations.GenerationOrderPending, Kind: "image", NodeIDs: nodeIDs,
			ProductionNodeIDs: nodeIDs, Targets: targets, SourceTurnID: source,
		})
	}); err != nil {
		t.Fatal(err)
	}
	res, err := svc.ConfirmAssistantProduction("local", source, request)
	if err != nil {
		t.Fatalf("12 个节点带 ContinuePlan 应成功确认提交: %v", err)
	}
	payload := res.(map[string]any)
	taskIDs, _ := payload["taskIds"].([]string)
	if len(taskIDs) != 12 {
		t.Fatalf("应创建 12 个任务，得到 %d", len(taskIDs))
	}
	if contID, _ := payload["continuationId"].(string); contID == "" {
		t.Fatalf("应建立自动继续回执: %#v", payload)
	}
}

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
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return operations.UpsertGenerationOrderInTx(tx, "local", operations.GenerationOrder{
			OrderID: request.ProposalID, ProposalID: request.ProposalID, CanvasID: canvasID,
			CallerKind: operations.CallerAssistant, ApprovalMode: operations.ApprovalModeAsk,
			Status: operations.GenerationOrderPending, Kind: "image", NodeIDs: []string{"image"},
			ProductionNodeIDs: []string{"image", "speech"}, Targets: targets, SourceTurnID: source,
		})
	}); err != nil {
		t.Fatal(err)
	}
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
	if rolledOrder, lookupErr := operations.LookupGenerationOrderInTx(svc.Database(), "local", request.ProposalID); lookupErr != nil || rolledOrder == nil || rolledOrder.Status != operations.GenerationOrderPending {
		t.Fatalf("failed admission must roll back order status to pending: %+v %v", rolledOrder, lookupErr)
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
	if origin.GenerationAuthorizationJSON != "" {
		t.Fatalf("confirmation should use single-source GenerationOrder instead of dual-writing GenerationAuthorizationJSON: %s", origin.GenerationAuthorizationJSON)
	}
	submittedOrder, err := operations.LookupTurnSubmittedOrderInTx(svc.Database(), "local", canvasID, source)
	if err != nil || submittedOrder == nil || submittedOrder.ProposalID != request.ProposalID {
		t.Fatalf("canonical submitted GenerationOrder not persisted: %+v %v", submittedOrder, err)
	}
	if err := svc.repo.SaveAssistantTurn(nil, &stale); err != nil {
		t.Fatal(err)
	}
	if afterStale, lookupErr := operations.LookupTurnSubmittedOrderInTx(svc.Database(), "local", canvasID, source); lookupErr != nil || afterStale == nil {
		t.Fatalf("delayed turn settlement affected canonical GenerationOrder: %+v %v", afterStale, lookupErr)
	}
	if first.(map[string]any)["revision"] != second.(map[string]any)["revision"] {
		t.Fatal("same confirmation changed canvas revision")
	}
	// The next official round (armed by the continuation receipt) resolves the finite grant
	// directly from canonical GenerationOrder, never from copied turn JSON or transcripts.
	next := first.(map[string]any)["continuationId"].(string)
	if _, err = svc.BeginAssistantTurn("local", canvasID, next, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err = svc.AssistantTurns().BindDurableSession("local", next, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
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
		return svc.BindDomain(tx).(*operationSession).RecordGenerationOrder("local", operations.GenerationOrder{
			OrderID: "gp-chat-confirm", ProposalID: "gp-chat-confirm", CanvasID: canvasID,
			Status: operations.GenerationOrderPending, Kind: "image",
			NodeIDs: []string{"image"}, ProductionNodeIDs: []string{"image", "speech"},
			Targets: targets, SourceTurnID: proposeTurn,
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
	res1, err := svc.ConfirmAssistantProduction("local", turn1, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn1-shot1", Kind: "image", NodeIDs: []string{"img1"}, Targets: targetsP1, ContinuePlan: true,
	})
	if err != nil {
		t.Fatalf("Turn 1 confirm failed: %v", err)
	}
	// Continuation Turn 2 is armed by Turn 1's confirmation (no JSON copy onto assistant_turns)
	// and proposes a NEW production plan P2 (img2 + speech2).
	turn2 := res1.(map[string]any)["continuationId"].(string)
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn2, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn2, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targetsP2, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img2", "speech2"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return svc.BindDomain(tx).(*operationSession).RecordGenerationOrder("local", operations.GenerationOrder{
			OrderID: "gp-turn2-shot2", ProposalID: "gp-turn2-shot2", CanvasID: canvasID, Status: operations.GenerationOrderPending,
			Kind: "image", NodeIDs: []string{"img2"}, ProductionNodeIDs: []string{"img2", "speech2"}, Targets: targetsP2, SourceTurnID: turn2,
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.FinalizeAssistantTurn(turn2); err != nil {
		t.Fatal(err)
	}

	// Divergent client inline Targets against the recorded canonical GenerationOrder must be rejected.
	tamperedP2 := append([]operations.GenerationTarget(nil), targetsP2...)
	tamperedP2[0].Prompt = "客户端篡改后的提示词"
	if _, err := svc.ConfirmAssistantProduction("local", turn2, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-turn2-shot2", Kind: "image", NodeIDs: []string{"img2"}, Targets: tamperedP2, ContinuePlan: true,
	}); operations.AsError(err) == nil || operations.AsError(err).Reason != "production_changed" {
		t.Fatalf("expected 409 production_changed for inline targets diverging from canonical GenerationOrder, got: %v", err)
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

	// Continuation Turn 3 resolves T2's confirmed GenerationOrder through its continuation link:
	// (a) T3 can submit already-authorized speech2 from P2 without re-confirmation;
	// (b) T3 can also propose a single-batch ordinary proposal (omitting inline Targets) and confirm it!
	turn3 := res2Map["continuationId"].(string)
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn3, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn3, backgroundContinuationSession, false); err != nil {
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

func TestOwnerCLIApprovalGrantsAssistantContinuationAuthorization(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "img1", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "茶杯", "size": "1:1", "count": 1}},
		map[string]any{"id": "speech1", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "清晨阳光", "model": "custom::speech", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const turn1 = "7788990011223344"
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
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img1", "speech1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return operations.UpsertGenerationOrderInTx(tx, "local", operations.GenerationOrder{
			OrderID: "gp-owner-cli", ProposalID: "gp-owner-cli", CanvasID: canvasID,
			CallerKind: operations.CallerAssistant, ApprovalMode: operations.ApprovalModeAsk,
			Status: operations.GenerationOrderPending, Kind: "image",
			NodeIDs: []string{"img1"}, ProductionNodeIDs: []string{"img1", "speech1"},
			Targets: targets, SourceTurnID: turn1,
		})
	}); err != nil {
		t.Fatal(err)
	}
	approved, err := svc.ApproveGenerationOrder("local", "gp-owner-cli", "owner-cli")
	if err != nil {
		t.Fatalf("ApproveGenerationOrder(owner-cli) failed: %v", err)
	}
	contID := approved.(map[string]any)["continuationId"].(string)
	if _, err := svc.BeginAssistantTurn("local", canvasID, contID, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", contID, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", contID, canvasID, targets[1:])
		return e
	}); err != nil {
		t.Fatalf("owner-cli approved order failed to authorize continuation turn: %v", err)
	}
}

func TestExternalAutoSubmitCannotHijackAssistantPendingOrder(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "img1", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "茶杯", "size": "1:1", "count": 1}},
		map[string]any{"id": "speech1", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "清晨阳光", "model": "custom::speech", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const source = "ee11ff22aa33bb44"
	if _, err := svc.BeginAssistantTurn("local", canvasID, source, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", source, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	raw, _ = svc.UserCanvasProject("local", canvasID)
	_ = json.Unmarshal(raw, &doc)
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img1", "speech1"})
	if err != nil {
		t.Fatal(err)
	}
	const proposalID = "gp-assistant-pending"
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		return operations.UpsertGenerationOrderInTx(tx, "local", operations.GenerationOrder{
			OrderID: proposalID, ProposalID: proposalID, CanvasID: canvasID,
			CallerKind: operations.CallerAssistant, CallerClient: "assistant-host",
			ApprovalMode: operations.ApprovalModeAsk, Status: operations.GenerationOrderPending,
			Kind: "image", NodeIDs: []string{"img1"}, ProductionNodeIDs: []string{"img1", "speech1"},
			Targets: targets, SourceTurnID: source,
		})
	}); err != nil {
		t.Fatal(err)
	}
	// External auto client must NOT be able to submit an assistant pending proposal.
	r := operations.NewRegistry(svc, operations.NewStore(svc.Database()))
	operations.RegisterDefaultOps(r)
	caller := operations.ExternalCaller(false)
	caller.ClientLabel = "ext-mcp"
	caller.ApprovalMode = operations.ApprovalModeAuto
	submitRaw, _ := json.Marshal(map[string]any{
		"canvasId": canvasID, "kind": "image", "nodeIds": []string{"img1"}, "proposalId": proposalID,
	})
	_, extErr := r.Execute(operations.Request{
		Op: "canvas.generation.submit", OpID: "ext-hijack-1", UserID: "local", Params: submitRaw, Caller: caller,
	})
	if operations.AsError(extErr) == nil || operations.AsError(extErr).Reason != "generation_approval_required" {
		t.Fatalf("external auto submit of assistant order = %v, want generation_approval_required", extErr)
	}
	order, err := operations.LookupGenerationOrderInTx(svc.Database(), "local", proposalID)
	if err != nil || order == nil || order.Status != operations.GenerationOrderPending {
		t.Fatalf("assistant order mutated by rejected external submit: %+v %v", order, err)
	}
	// Even if a submitted row exists with non-owner ApprovedBy (e.g. auto:ext-mcp),
	// SubmitAuthorizedGeneration must still reject it.
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		forged := *order
		forged.Status = operations.GenerationOrderSubmitted
		forged.ApprovedBy = "auto:ext-mcp"
		return operations.UpsertGenerationOrderInTx(tx, "local", forged)
	}); err != nil {
		t.Fatal(err)
	}
	err = svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", source, canvasID, targets[1:])
		return e
	})
	if operations.AsError(err) == nil || operations.AsError(err).Reason != "production_authorization_required" {
		t.Fatalf("non-owner-approved submitted order authorized assistant spend: %v", err)
	}
}

func TestLegacyTurnIDEmptySubmittedOrderAndConflict(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "img1", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "茶杯", "size": "1:1", "count": 1}},
		map[string]any{"id": "speech1", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "清晨阳光", "model": "custom::speech", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const turn1 = "ab12cd34ef560011"
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
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img1", "speech1"})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate pre-upgrade GenerationOrder stored with turn_id='' in agent_op_records.
	encodedOrder, _ := json.Marshal(operations.GenerationOrder{
		OrderID: "gp-old-empty-turnid", ProposalID: "gp-old-empty-turnid", CanvasID: canvasID,
		CallerKind: operations.CallerAssistant, ApprovalMode: operations.ApprovalModeAsk,
		Status: operations.GenerationOrderSubmitted, ApprovedBy: "ui",
		Kind: "image", NodeIDs: []string{"img1"}, Targets: targets, SourceTurnID: turn1,
	})
	if err := svc.Database().Create(&model.AgentOpRecord{
		OpID: "generation-order:gp-old-empty-turnid", UserID: "local", Op: "canvas.generation.order",
		PayloadHash: canvasID, Status: "order:submitted", ResultJSON: string(encodedOrder), TurnID: "",
	}).Error; err != nil {
		t.Fatal(err)
	}
	// 1) Own-turn SubmitAuthorizedGeneration succeeds through turn_id='' fallback.
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", turn1, canvasID, targets[1:])
		return e
	}); err != nil {
		t.Fatalf("turn_id='' legacy submitted order failed to authorize own turn: %v", err)
	}
	// 2) Confirming a distinct second proposal on turn1 must still be rejected with 409 production_changed.
	if _, err := svc.ConfirmAssistantProduction("local", turn1, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-second-distinct", Kind: "image", NodeIDs: []string{"img1"}, Targets: targets[:1],
	}); operations.AsError(err) == nil || operations.AsError(err).Reason != "production_changed" {
		t.Fatalf("distinct second confirmation on turn with turn_id='' order = %v, want production_changed", err)
	}
}

func TestContinuationAuthorizationRejectsUndoneOwnerCrossTurnAndUnconfirmedHop(t *testing.T) {
	svc, canvasID, _ := newAssistantTurnService(t)
	if err := svc.SaveLocalModelConfig([]byte(`{"imageModel":"custom::image","audioModel":"custom::speech","channels":[{"id":"custom","enabled":true,"baseUrl":"https://example.invalid/v1","apiKey":"test-only","models":["image","speech"],"modelProfiles":[{"model":"image","capability":"image","protocol":"openai-image"},{"model":"speech","capability":"audio","protocol":"openai-audio"}]}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, _ := svc.UserCanvasProject("local", canvasID)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["nodes"] = []any{
		map[string]any{"id": "img1", "type": "image", "title": "首帧", "metadata": map[string]any{"prompt": "茶杯", "size": "1:1", "count": 1}},
		map[string]any{"id": "speech1", "type": "audio", "title": "旁白", "metadata": map[string]any{"prompt": "清晨阳光", "model": "custom::speech", "audioVoice": "alloy"}},
	}
	doc["connections"] = []any{}
	raw, _ = json.Marshal(doc)
	if _, err := svc.UpsertUserCanvasProject("local", raw); err != nil {
		t.Fatal(err)
	}
	const turn1 = "11223344aabbccdd"
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
	targets, err := operations.GenerationTargets(svc.BindDomain(nil), doc, []string{"img1", "speech1"})
	if err != nil {
		t.Fatal(err)
	}
	res1, err := svc.ConfirmAssistantProduction("local", turn1, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-owner-plan", Kind: "image", NodeIDs: []string{"img1"}, Targets: targets, ContinuePlan: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	turn2 := res1.(map[string]any)["continuationId"].(string)
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn2, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn2, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	// Cross-turn proposalId reuse on turn2 must fail with 409 production_changed.
	if err := svc.FinalizeAssistantTurn(turn2); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmAssistantProduction("local", turn2, AssistantProductionConfirmation{
		CanvasID: canvasID, ProposalID: "gp-owner-plan", Kind: "image", NodeIDs: []string{"img1"}, Targets: targets,
	}); operations.AsError(err) == nil || operations.AsError(err).Reason != "production_changed" {
		t.Fatalf("cross-turn proposalId confirm = %v, want production_changed", err)
	}
	// 1-hop strictness: a continuation turn3 pointing to an unconfirmed proposal on turn2
	// must NOT walk up to turn1's ancestor plan.
	const turn3 = "9988776655443322"
	if _, err := svc.BeginAssistantTurn("local", canvasID, turn3, AssistantTurnInput{}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AssistantTurns().BindDurableSession("local", turn3, backgroundContinuationSession, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		if err := operations.UpsertGenerationOrderInTx(tx, "local", operations.GenerationOrder{
			OrderID: "gp-unconfirmed-hop", ProposalID: "gp-unconfirmed-hop", CanvasID: canvasID,
			CallerKind: operations.CallerAssistant, ApprovalMode: operations.ApprovalModeAsk,
			Status: operations.GenerationOrderPending, Kind: "audio", NodeIDs: []string{"speech1"},
			Targets: targets[1:], SourceTurnID: turn2,
		}); err != nil {
			return err
		}
		return tx.Create(&model.AssistantContinuation{
			ID: turn3, UserID: "local", CanvasID: canvasID, SessionID: backgroundContinuationSession,
			SourceTurnID: turn2, ProposalID: "gp-unconfirmed-hop", Kind: "audio",
			TurnID: turn3, RequestID: "req-" + turn3, State: "running", PermissionMode: "canvas",
		}).Error
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", turn3, canvasID, targets[1:])
		return e
	}); operations.AsError(err) == nil || operations.AsError(err).Reason != "production_authorization_required" {
		t.Fatalf("unconfirmed continuation hop fell back to ancestor plan: %v", err)
	}
	// Undoing owner turn1 revokes continuation turn2's authorization.
	if err := svc.Database().Model(&model.AssistantTurn{}).Where("turn_id = ?", turn1).Update("undone", true).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.Database().Transaction(func(tx *gorm.DB) error {
		_, e := svc.BindDomain(tx).(*operationSession).SubmitAuthorizedGeneration("local", turn2, canvasID, targets[1:])
		return e
	}); operations.AsError(err) == nil || operations.AsError(err).Reason != "production_revoked" {
		t.Fatalf("undone owner turn still authorized continuation turn2: %v", err)
	}
}
