package operations_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
)

func TestExternalGenerationGuardrails(t *testing.T) {
	h := newHarness(t)
	db := h.service.Database()

	// Default guardrail allows external calls with zero caps.
	def := operations.GetExternalGenerationGuardrail(db)
	if def.Mode != operations.ExternalGuardrailModeAllow || def.MaxPerCallCNY != 0 || def.DailyBudgetCNY != 0 {
		t.Fatalf("unexpected default guardrail: %+v", def)
	}

	// Set propose_only -> CheckExternalGenerationGuardrail must reject directly.
	if _, err := operations.SetExternalGenerationGuardrail(db, operations.ExternalGenerationGuardrail{
		Mode: operations.ExternalGuardrailModePropose,
	}); err != nil {
		t.Fatalf("set propose_only failed: %v", err)
	}
	_, err := operations.CheckExternalGenerationGuardrail(db, h.service.BindDomain(db), h.userID, map[string]map[string]any{}, []operations.GenerationTarget{
		{NodeID: "n1", Kind: "image", ModelKey: "beeftv::seedream-4.0"},
	}, time.Now())
	if err == nil || !strings.Contains(err.Error(), "canvas.generation.propose") {
		t.Fatalf("expected propose_only rejection, got %v", err)
	}

	// Set budget cap with unknown-price model -> must fail-closed (external_budget_price_unknown).
	if _, err := operations.SetExternalGenerationGuardrail(db, operations.ExternalGenerationGuardrail{
		Mode:          operations.ExternalGuardrailModeAllow,
		MaxPerCallCNY: 5.0,
	}); err != nil {
		t.Fatalf("set cap failed: %v", err)
	}
	_, err = operations.CheckExternalGenerationGuardrail(db, h.service.BindDomain(db), h.userID, map[string]map[string]any{}, []operations.GenerationTarget{
		{NodeID: "n1", Kind: "image", ModelKey: "custom::unpriced-model"},
	}, time.Now())
	if err == nil {
		t.Fatal("expected fail-closed error for unpriced model when cap is enabled")
	}
	if opErr(t, err).Reason != "external_budget_price_unknown" {
		t.Fatalf("expected external_budget_price_unknown, got %+v", opErr(t, err))
	}

	// Corrupt guardrail JSON must fail closed to propose_only instead of silently allowing.
	if err := db.Model(&model.SystemSetting{}).Where("key = ?", "external_mcp_generation_guardrail").Update("value_json", "{not-json").Error; err != nil {
		t.Fatal(err)
	}
	if corruptCfg := operations.GetExternalGenerationGuardrail(db); corruptCfg.Mode != operations.ExternalGuardrailModePropose {
		t.Fatalf("corrupt guardrail JSON must fail closed to propose_only, got %+v", corruptCfg)
	}
	if err := operations.CheckExternalBusinessPaidGuardrail(db); err == nil || opErr(t, err).Reason != "external_generation_propose_only" {
		t.Fatalf("business paid guardrail should reject under corrupt/propose_only, got %v", err)
	}

	// Set cap with allow mode -> business paid guardrail fails closed (external_budget_price_unknown).
	if _, err := operations.SetExternalGenerationGuardrail(db, operations.ExternalGenerationGuardrail{
		Mode:          operations.ExternalGuardrailModeAllow,
		MaxPerCallCNY: 5.0,
	}); err != nil {
		t.Fatalf("set cap failed: %v", err)
	}
	if err := operations.CheckExternalBusinessPaidGuardrail(db); err == nil || opErr(t, err).Reason != "external_budget_price_unknown" {
		t.Fatalf("business paid guardrail should fail closed when cap enabled, got %v", err)
	}

	// TodayExternalEstimatedSpendCNY sums only today's succeeded external submissions.
	now := time.Now()
	if err := db.Create(&model.AgentOpRecord{
		UserID:     h.userID,
		OpID:       "ext-op-1",
		Op:         "canvas.generation.submit",
		CallerKind: string(operations.CallerExternal),
		Status:     "succeeded",
		ResultJSON: `{"taskIds":["t1"],"estimatedCny":1.25}`,
		CreatedAt:  now,
		UpdatedAt:  now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AgentOpRecord{
		UserID:     h.userID,
		OpID:       "ext-op-2",
		Op:         "canvas.generation.regenerate",
		CallerKind: string(operations.CallerExternal),
		Status:     "succeeded",
		ResultJSON: `{"taskIds":["t2"],"estimatedCny":0.75}`,
		CreatedAt:  now,
		UpdatedAt:  now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	spent := operations.TodayExternalEstimatedSpendCNY(db, h.userID, now)
	if spent != 2.0 {
		t.Fatalf("expected today external spend 2.0, got %v", spent)
	}
}

func TestAssistantAutoConfirmBudgetSettingsAndSessionAccounting(t *testing.T) {
	h := newHarness(t)
	db := h.service.Database()

	if got := operations.AssistantAutoConfirmMaxCNY(db); got != 0 {
		t.Fatalf("expected default autoConfirmMaxCny=0, got %v", got)
	}
	if _, err := operations.SetAssistantAutoConfirmMaxCNY(db, -1); err == nil {
		t.Fatal("expected negative auto-confirm limit to fail")
	}
	if _, err := operations.SetAssistantAutoConfirmMaxCNY(db, 100); err == nil {
		t.Fatal("expected >50 auto-confirm limit to fail")
	}
	saved, err := operations.SetAssistantAutoConfirmMaxCNY(db, 5.0)
	if err != nil || saved != 5.0 {
		t.Fatalf("expected saved 5.0, got (%v, %v)", saved, err)
	}

	// Seed one auto-confirmed order in session-A and one in session-B.
	estA := 2.4
	estB := 4.5
	for _, ord := range []operations.GenerationOrder{
		{ProposalID: "gp-a1", CanvasID: h.canvasID, Status: operations.GenerationOrderSubmitted, ApprovedBy: operations.ApprovedByAutoBudget, SessionID: "durable:sess-a", EstimatedCNY: &estA},
		{ProposalID: "gp-b1", CanvasID: h.canvasID, Status: operations.GenerationOrderSubmitted, ApprovedBy: operations.ApprovedByAutoBudget, SessionID: "durable:sess-b", EstimatedCNY: &estB},
	} {
		if err := operations.UpsertGenerationOrderInTx(db, h.userID, ord); err != nil {
			t.Fatal(err)
		}
	}
	spentA, err := operations.SessionAutoConfirmedSpendCNY(db, h.userID, "durable:sess-a", "")
	if err != nil || spentA != 2.4 {
		t.Fatalf("expected session-a spent 2.4, got (%v, %v)", spentA, err)
	}
	// Excluding gp-a1 (idempotent replay check) yields 0.
	spentExclude, err := operations.SessionAutoConfirmedSpendCNY(db, h.userID, "durable:sess-a", "gp-a1")
	if err != nil || spentExclude != 0 {
		t.Fatalf("expected 0 when excluding gp-a1, got (%v, %v)", spentExclude, err)
	}

	// Server-issued auto-budget orders are owner-confirmed ONLY for assistant caller orders.
	assistantOrder := operations.GenerationOrder{
		CallerKind: operations.CallerAssistant,
		Status:     operations.GenerationOrderSubmitted,
		ApprovedBy: operations.ApprovedByAutoBudget,
	}
	if !assistantOrder.IsOwnerConfirmed() {
		t.Fatal("assistant auto-budget order must satisfy IsOwnerConfirmed for multi-stage continuations")
	}
	externalSpoof := operations.GenerationOrder{
		CallerKind: operations.CallerExternal,
		Status:     operations.GenerationOrderSubmitted,
		ApprovedBy: operations.ApprovedByAutoBudget,
	}
	if externalSpoof.IsOwnerConfirmed() {
		t.Fatal("external caller order must never satisfy IsOwnerConfirmed via auto-budget")
	}
}

func TestCreativeBibleOpsAndCanvasGetDigest(t *testing.T) {
	h := newHarness(t)

	// Before any bible exists, canvas.get must omit creativeBibleDigest.
	beforeRaw, err := h.execute(t, h.assistant(), "canvas.get", "", map[string]any{"canvasId": h.canvasID})
	if err != nil {
		t.Fatalf("canvas.get before bible failed: %v", err)
	}
	beforeMap, _ := beforeRaw.Result.(map[string]any)
	if _, exists := beforeMap["creativeBibleDigest"]; exists {
		t.Fatalf("canvas.get should omit creativeBibleDigest when empty, got %+v", beforeMap["creativeBibleDigest"])
	}

	// Update bible via unified operation (shared by built-in assistant & external MCP).
	updated, err := h.execute(t, h.assistant(), "project.bible.update", "bible-update-1", map[string]any{
		"canvasId":         h.canvasID,
		"expectedRevision": 0,
		"title":            "山海纪行",
		"visualStyle":      "国风工笔水墨融合电影光影",
		"taboos":           "禁止出现现代建筑与英文招牌",
		"characters": []map[string]any{
			{"name": "青禾", "appearance": "黑发束冠，眉目清冷", "wardrobe": "青白交领长衫"},
		},
	})
	if err != nil {
		t.Fatalf("project.bible.update failed: %v", err)
	}
	encoded, _ := json.Marshal(updated.Result)
	if !strings.Contains(string(encoded), "山海纪行") || !strings.Contains(string(encoded), "青禾") {
		t.Fatalf("unexpected project.bible.update result: %s", encoded)
	}

	// Built-in assistant in default canvas mode MUST be able to call project.bible.get on current canvas,
	// and MUST be denied on a foreign canvas or bare projectId.
	assistantGot, err := h.execute(t, h.assistant(), "project.bible.get", "", map[string]any{"canvasId": h.canvasID})
	if err != nil {
		t.Fatalf("assistant project.bible.get failed: %v", err)
	}
	assistantEncoded, _ := json.Marshal(assistantGot.Result)
	if !strings.Contains(string(assistantEncoded), "山海纪行") || !strings.Contains(string(assistantEncoded), "青禾") {
		t.Fatalf("assistant did not read shared bible: %s", assistantEncoded)
	}
	if _, err := h.execute(t, h.assistant(), "project.bible.get", "", map[string]any{"canvasId": "foreign-canvas"}); err == nil {
		t.Fatal("assistant project.bible.get on foreign canvas should be denied")
	}

	// External caller can read the exact same bible via project.bible.get.
	got, err := h.execute(t, operations.ExternalCaller(false), "project.bible.get", "", map[string]any{"canvasId": h.canvasID})
	if err != nil {
		t.Fatalf("external project.bible.get failed: %v", err)
	}
	gotEncoded, _ := json.Marshal(got.Result)
	if !strings.Contains(string(gotEncoded), "国风工笔水墨") || !strings.Contains(string(gotEncoded), "禁止出现现代建筑") {
		t.Fatalf("external caller did not read shared bible: %s", gotEncoded)
	}

	// Now canvas.get automatically includes compact creativeBibleDigest for studio-digest injection.
	afterRaw, err := h.execute(t, h.assistant(), "canvas.get", "", map[string]any{"canvasId": h.canvasID})
	if err != nil {
		t.Fatalf("canvas.get after bible failed: %v", err)
	}
	afterMap, _ := afterRaw.Result.(map[string]any)
	digest, _ := afterMap["creativeBibleDigest"].(string)
	if !strings.Contains(digest, "山海纪行") || !strings.Contains(digest, "青禾") {
		t.Fatalf("expected creativeBibleDigest in canvas.get, got %q", digest)
	}
}
