package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

func openMandateTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := database.Open(database.Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	return db
}

type mandateCanvasDomain struct {
	tx            *gorm.DB
	doc           map[string]any
	catalog       *modelcatalog.CatalogResponse
	admittedTasks int
	mu            sync.Mutex
}

func (d *mandateCanvasDomain) BindDomain(tx *gorm.DB) Domain {
	return &mandateCanvasDomain{tx: tx, doc: d.doc, catalog: d.catalog}
}

func (d *mandateCanvasDomain) VerifyOpenAssistantTurnInTx(tx *gorm.DB, userID, turnID, canvasID string) error {
	var row model.AssistantTurn
	if err := tx.First(&row, "turn_id = ? AND user_id = ? AND canvas_id = ?", turnID, userID, canvasID).Error; err != nil {
		return PreconditionFailed("turn_not_open", "回合未打开", nil)
	}
	if row.State != "open" {
		return PreconditionFailed("turn_not_open", "回合已结束", nil)
	}
	return nil
}

func (d *mandateCanvasDomain) UserCanvasProject(_ string, _ string) (json.RawMessage, error) {
	raw, err := json.Marshal(d.doc)
	return raw, err
}

func (d *mandateCanvasDomain) ResolveAssistantGenerationModel(kind, selected string) (AssistantGenerationModel, error) {
	key := selected
	if key == "" {
		key = "beeftv::img-fixed"
	}
	return AssistantGenerationModel{Display: key, ModelKey: key, Revision: 1}, nil
}

func (d *mandateCanvasDomain) AgentModelCatalog() (*modelcatalog.CatalogResponse, error) {
	return d.catalog, nil
}

func (d *mandateCanvasDomain) SubmitExternalGeneration(userID, operationID, canvasID string, targets []GenerationTarget, _ bool) (any, error) {
	taskIDs := make([]string, 0, len(targets))
	nodeIDs := make([]string, 0, len(targets))
	for i, target := range targets {
		taskID := fmt.Sprintf("task-%s-%d", target.NodeID, i)
		opKey := fmt.Sprintf("mandate-op-%s-%s", operationID, target.NodeID)
		task := model.Task{
			ID:                taskID,
			UserID:            userID,
			ProjectID:         canvasID,
			Type:              "canvas_" + target.Kind,
			Prompt:            target.Prompt,
			Status:            model.TaskStatusQueued,
			ClientOperationID: &opKey,
		}
		if err := d.tx.Create(&task).Error; err != nil {
			return nil, err
		}
		taskIDs = append(taskIDs, taskID)
		nodeIDs = append(nodeIDs, target.NodeID)
	}
	return map[string]any{
		"canvasId": canvasID,
		"taskIds":  taskIDs,
		"nodeIds":  nodeIDs,
		"status":   "submitted",
	}, nil
}

func (d *mandateCanvasDomain) RecordGenerationOrder(userID string, order GenerationOrder) error {
	return UpsertGenerationOrderInTx(d.tx, userID, order)
}

func (d *mandateCanvasDomain) LookupGenerationOrder(userID, proposalID string) (*GenerationOrder, error) {
	return LookupGenerationOrderInTx(d.tx, userID, proposalID)
}

func (d *mandateCanvasDomain) SubmitAuthorizedGeneration(_, _, _ string, _ []GenerationTarget) (any, error) {
	return nil, PreconditionFailed("production_authorization_required", "请先确认制作方案", nil)
}

// Unused Domain methods for test fixture.
func (d *mandateCanvasDomain) UserCanvasProjectsPage(string, int, int, string, string, string) (canvas.CanvasLibraryPage, error) {
	return canvas.CanvasLibraryPage{}, nil
}
func (d *mandateCanvasDomain) UserAssetsPage(string, int, int, canvas.UserAssetPageFilter) (canvas.UserAssetPage, error) {
	return canvas.UserAssetPage{}, nil
}
func (d *mandateCanvasDomain) UserAsset(string, string) (json.RawMessage, error) { return nil, nil }
func (d *mandateCanvasDomain) Task(string, string) (*model.Task, error)          { return nil, nil }
func (d *mandateCanvasDomain) CreateUserCanvasNodes(string, string, []canvas.NodeDraft, int64) (canvas.UserDataSummary, []canvas.CreatedNode, error) {
	return canvas.UserDataSummary{}, nil, nil
}
func (d *mandateCanvasDomain) PrepareUserCanvasStoryboard(string, string, string, canvas.StoryboardPreparation, int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error) {
	return canvas.UserDataSummary{}, canvas.StoryboardPreparationResult{}, nil
}
func (d *mandateCanvasDomain) UpdateUserCanvasNodeFields(string, string, string, map[string]any, int64) (canvas.UserDataSummary, error) {
	return canvas.UserDataSummary{}, nil
}
func (d *mandateCanvasDomain) AppendUserCanvasStoryboardRows(string, string, string, []canvas.StoryboardRowDraft, int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error) {
	return canvas.UserDataSummary{}, nil, nil
}
func (d *mandateCanvasDomain) UpdateUserCanvasStoryboardRows(string, string, string, []canvas.StoryboardRowPatch, int64) (canvas.UserDataSummary, canvas.StoryboardRowUpdate, error) {
	return canvas.UserDataSummary{}, canvas.StoryboardRowUpdate{}, nil
}
func (d *mandateCanvasDomain) RemoveUserCanvasStoryboardRows(string, string, string, []string, int64) (canvas.UserDataSummary, int, error) {
	return canvas.UserDataSummary{}, 0, nil
}
func (d *mandateCanvasDomain) ConnectUserCanvasNodesAtRevision(string, string, string, string, int64) (canvas.UserDataSummary, error) {
	return canvas.UserDataSummary{}, nil
}
func (d *mandateCanvasDomain) CommitUserCanvasDocument(string, string, int64, json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) {
	return canvas.UserDataSummary{}, nil, nil
}
func (d *mandateCanvasDomain) PatchUserCanvasDocument(string, string, canvas.DocumentPatch) (canvas.DocumentPatchResult, error) {
	return canvas.DocumentPatchResult{}, nil
}
func (d *mandateCanvasDomain) WorkspaceTask(string, string) (*model.Task, error) { return nil, nil }
func (d *mandateCanvasDomain) GenerationOutputs(string) ([]localtask.CanonicalOutput, error) {
	return nil, nil
}
func (d *mandateCanvasDomain) OwnedReadyResource(string, string) (*model.Resource, error) {
	return nil, nil
}
func (d *mandateCanvasDomain) OwnedAsset(string, string) (*model.Asset, error) { return nil, nil }
func (d *mandateCanvasDomain) BindExistingCanvasNode(string, canvas.TaskOutputBind) (canvas.TaskOutputBindResult, error) {
	return canvas.TaskOutputBindResult{}, nil
}
func (d *mandateCanvasDomain) UserConversation(string, string) (taskbinding.ConversationView, error) {
	return taskbinding.ConversationView{}, nil
}
func (d *mandateCanvasDomain) AttachConversationMessage(string, taskbinding.MessageAttachInput) (taskbinding.ConversationView, error) {
	return taskbinding.ConversationView{}, nil
}

func makeMandateTestCatalog(t *testing.T) *modelcatalog.CatalogResponse {
	t.Helper()
	resp := modelcatalog.NewCatalogResponse(modelcatalog.CatalogSourceSystem, nil, []modelcatalog.PublicChannelCatalog{
		{
			ID: "beeftv",
			Models: []modelcatalog.PublicChannelModel{
				{
					ID:         "img-fixed",
					ModelKey:   "img-fixed",
					Capability: "image",
					Pricing:    priceRow(t, `{"mode":"per_request","per_request_cny":2.5,"display_kind":"image"}`),
				},
			},
		},
		{
			ID: "byok",
			Models: []modelcatalog.PublicChannelModel{
				{
					ID:         "img-unquoted",
					ModelKey:   "img-unquoted",
					Capability: "image",
					Pricing:    nil,
				},
			},
		},
	})
	return &resp
}

func makeMandateCanvasDoc(nodeCount int, modelKey string) map[string]any {
	nodes := make([]any, 0, nodeCount)
	for i := 1; i <= nodeCount; i++ {
		nodes = append(nodes, map[string]any{
			"id":    fmt.Sprintf("shot-%d", i),
			"type":  "image",
			"title": fmt.Sprintf("镜头 %d", i),
			"metadata": map[string]any{
				"model":  modelKey,
				"prompt": fmt.Sprintf("赛博朋克雨夜镜头 %d", i),
			},
		})
	}
	return map[string]any{
		"id":          "canvas-1",
		"revision":    1,
		"nodes":       nodes,
		"connections": []any{},
	}
}

func TestProductionMandate6ShotAutoExecutionAndBudgetExhaustion(t *testing.T) {
	db := openMandateTestDB(t)
	userID, canvasID, sessionID, turnID := "u1", "canvas-1", "durable:00000000-0000-0000-0000-000000000001", "turn-1"
	if err := db.Create(&model.AssistantTurn{
		TurnID: turnID, UserID: userID, CanvasID: canvasID, DurableSessionID: sessionID, State: "open",
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Each shot costs ¥2.50 -> 6 shots = ¥15.00; mandate cap = ¥15.00 -> 6 succeed, 7th requires approval.
	mandate, err := CreateProductionMandateInTx(db, userID, CreateProductionMandateInput{
		CanvasID:     canvasID,
		SessionID:    sessionID,
		MaxAmountCNY: 15.0,
		AllowedKinds: []string{model.MandateKindImage, model.MandateKindVideo},
		ApprovedBy:   "ui",
	})
	if err != nil {
		t.Fatal(err)
	}

	binder := &mandateCanvasDomain{doc: makeMandateCanvasDoc(7, "beeftv::img-fixed"), catalog: makeMandateTestCatalog(t)}
	reg := NewRegistry(binder, NewStore(db))
	RegisterDefaultOps(reg)

	for i := 1; i <= 6; i++ {
		params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{fmt.Sprintf("shot-%d", i)}})
		res, execErr := reg.Execute(Request{
			OpID:   fmt.Sprintf("op-shot-%d", i),
			Op:     "canvas.generation.submit",
			UserID: userID,
			TurnID: turnID,
			Caller: Caller{Kind: CallerAssistant, Scope: allowAllScope{}},
			Params: params,
		})
		if execErr != nil {
			t.Fatalf("shot %d under active mandate failed: %v", i, execErr)
		}
		resMap, _ := res.Result.(map[string]any)
		if resMap["mandateId"] != mandate.ID {
			t.Fatalf("shot %d expected mandateId=%s, got %+v", i, mandate.ID, resMap)
		}
	}

	// Verify exact accounting: 6 * ¥2.50 = ¥15.00 reserved, status exhausted.
	after6, err := GetProductionMandateInTx(db, userID, mandate.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after6.ReservedAmountCNY != 15.0 || after6.SpentAmountCNY != 0 || after6.Status != model.MandateStatusExhausted {
		t.Fatalf("unexpected mandate state after 6 shots: %+v", after6)
	}

	// 7th shot must pause with approval_required (not bypass or double-charge).
	params7, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"shot-7"}})
	_, err7 := reg.Execute(Request{
		OpID:   "op-shot-7",
		Op:     "canvas.generation.submit",
		UserID: userID,
		TurnID: turnID,
		Caller: Caller{Kind: CallerAssistant, Scope: allowAllScope{}},
		Params: params7,
	})
	if err7 == nil || AsError(err7).Reason != "approval_required" {
		t.Fatalf("expected 7th shot to return approval_required, got %v", err7)
	}
}

func TestProductionMandateParallel4ToolReservationsNoDeadlock(t *testing.T) {
	db := openMandateTestDB(t)
	userID, canvasID, sessionID, turnID := "u1", "canvas-1", "durable:00000000-0000-0000-0000-000000000002", "turn-par"
	if err := db.Create(&model.AssistantTurn{
		TurnID: turnID, UserID: userID, CanvasID: canvasID, DurableSessionID: sessionID, State: "open",
	}).Error; err != nil {
		t.Fatal(err)
	}
	mandate, err := CreateProductionMandateInTx(db, userID, CreateProductionMandateInput{
		CanvasID:     canvasID,
		SessionID:    sessionID,
		MaxAmountCNY: 20.0,
		AllowedKinds: []string{model.MandateKindImage},
		ApprovedBy:   "ui",
	})
	if err != nil {
		t.Fatal(err)
	}
	binder := &mandateCanvasDomain{doc: makeMandateCanvasDoc(4, "beeftv::img-fixed"), catalog: makeMandateTestCatalog(t)}
	reg := NewRegistry(binder, NewStore(db))
	RegisterDefaultOps(reg)

	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 1; i <= 4; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			params, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{fmt.Sprintf("shot-%d", idx)}})
			_, execErr := reg.Execute(Request{
				OpID:   fmt.Sprintf("par-op-%d", idx),
				Op:     "canvas.generation.submit",
				UserID: userID,
				TurnID: turnID,
				Caller: Caller{Kind: CallerAssistant, Scope: allowAllScope{}},
				Params: params,
			})
			errs <- execErr
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatalf("parallel tool reservation failed: %v", e)
		}
	}

	got, err := GetProductionMandateInTx(db, userID, mandate.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReservedAmountCNY != 10.0 || got.SpentAmountCNY != 0 {
		t.Fatalf("expected exact 4 * 2.50 = 10.00 reserved, got %+v", got)
	}
	var resCount int64
	db.Model(&model.AssistantMandateReservation{}).Where("mandate_id = ? AND status = ?", mandate.ID, model.MandateReservationStatusReserved).Count(&resCount)
	if resCount != 4 {
		t.Fatalf("expected 4 reserved rows, got %d", resCount)
	}
}

func TestProductionMandateLifecycleRetrievableNeverReleasesAndOrphanReconciliation(t *testing.T) {
	db := openMandateTestDB(t)
	userID, canvasID := "u1", "canvas-1"
	now := time.Now().UTC()
	mandate, err := CreateProductionMandateInTx(db, userID, CreateProductionMandateInput{
		CanvasID:     canvasID,
		MaxAmountCNY: 12.0, // 4 items * ¥3.00 = ¥12.00 (exhausts mandate initially)
		AllowedKinds: []string{model.MandateKindImage, model.MandateKindVideo},
		ApprovedBy:   "ui",
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Reserve 4 items -> mandate becomes exhausted (reserved=12.0).
	var reservations [4]*model.AssistantMandateReservation
	for i := 0; i < 4; i++ {
		res, _, rErr := ReserveMandateInTx(db, userID, mandate.ID, MandateReserveItem{
			CallID:    fmt.Sprintf("life-call-%d", i),
			TaskID:    fmt.Sprintf("task-life-%d", i),
			Kind:      model.MandateKindVideo,
			AmountCNY: 3.0,
		}, now)
		if rErr != nil {
			t.Fatalf("reserve %d failed: %v", i, rErr)
		}
		reservations[i] = res
	}
	// Also test idempotency: repeating the same (mandate_id, call_id) returns the existing row without double-reserving.
	dup, _, dupErr := ReserveMandateInTx(db, userID, mandate.ID, MandateReserveItem{
		CallID:    "life-call-0",
		Kind:      model.MandateKindVideo,
		AmountCNY: 3.0,
	}, now)
	if dupErr != nil || dup.ID != reservations[0].ID {
		t.Fatalf("idempotent reserve failed: dup=%+v err=%v", dup, dupErr)
	}

	// Task 0: failed + retrievable (has ProviderRequestID, no RecoveryOutcome -> ComputeOutcome Phase=retrievable).
	if err := db.Create(&model.Task{
		ID: "task-life-0", UserID: userID, ProjectID: canvasID, Type: "canvas_video",
		Status: model.TaskStatusFailed, ProviderRequestID: "upstream-req-297",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := ReconcileTaskMandateReservations(db, "task-life-0"); err != nil {
		t.Fatal(err)
	}
	var row0 model.AssistantMandateReservation
	db.First(&row0, "id = ?", reservations[0].ID)
	if row0.Status != model.MandateReservationStatusReserved {
		t.Fatalf("failed+retrievable task MUST keep reservation reserved (#297), got %s", row0.Status)
	}

	// Task 1: succeeded -> must settle reserved -> spent!
	if err := db.Create(&model.Task{
		ID: "task-life-1", UserID: userID, ProjectID: canvasID, Type: "canvas_video",
		Status: model.TaskStatusSucceeded,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := ReconcileTaskMandateReservations(db, "task-life-1"); err != nil {
		t.Fatal(err)
	}
	var row1 model.AssistantMandateReservation
	db.First(&row1, "id = ?", reservations[1].ID)
	if row1.Status != model.MandateReservationStatusSpent {
		t.Fatalf("succeeded task must settle to spent, got %s", row1.Status)
	}

	// Task 2: non-retrievable terminal failure (RecoveryOutcome = no_result) -> must release & reactivate mandate!
	noResult := localtask.RecoveryNoResult
	if err := db.Create(&model.Task{
		ID: "task-life-2", UserID: userID, ProjectID: canvasID, Type: "canvas_video",
		Status: model.TaskStatusFailed, RecoveryOutcome: &noResult,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := ReconcileTaskMandateReservations(db, "task-life-2"); err != nil {
		t.Fatal(err)
	}
	// Repeat reconcile to assert idempotency.
	if err := ReconcileTaskMandateReservations(db, "task-life-2"); err != nil {
		t.Fatal(err)
	}
	var row2 model.AssistantMandateReservation
	db.First(&row2, "id = ?", reservations[2].ID)
	if row2.Status != model.MandateReservationStatusReleased {
		t.Fatalf("non-retrievable failed task must release reservation, got %s", row2.Status)
	}

	// Task 3: missing task row (simulated crash between reserve and task admit).
	// Startup reconciliation MUST release Task 3 while keeping Task 0 reserved!
	if err := ReconcileOrphanedMandateReservations(db); err != nil {
		t.Fatal(err)
	}
	var row3 model.AssistantMandateReservation
	db.First(&row3, "id = ?", reservations[3].ID)
	if row3.Status != model.MandateReservationStatusReleased {
		t.Fatalf("orphaned reservation without task row must release on startup, got %s", row3.Status)
	}
	db.First(&row0, "id = ?", reservations[0].ID)
	if row0.Status != model.MandateReservationStatusReserved {
		t.Fatalf("startup reconciliation must NOT release failed+retrievable task 0, got %s", row0.Status)
	}

	got, err := GetProductionMandateInTx(db, userID, mandate.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Task 0 reserved (¥3), Task 1 spent (¥3), Task 2 released, Task 3 released -> remaining ¥6, active!
	if got.SpentAmountCNY != 3.0 || got.ReservedAmountCNY != 3.0 || got.Status != model.MandateStatusActive {
		t.Fatalf("expected spent=3 reserved=3 status=active, got %+v", got)
	}
}

func TestProductionMandateUnquotedBYOKNeverGetsFreePass(t *testing.T) {
	db := openMandateTestDB(t)
	userID, canvasID, sessionID, turnID := "u1", "canvas-1", "durable:00000000-0000-0000-0000-000000000003", "turn-byok"
	if err := db.Create(&model.AssistantTurn{
		TurnID: turnID, UserID: userID, CanvasID: canvasID, DurableSessionID: sessionID, State: "open",
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Mandate with ¥100 CNY budget but max_unquoted_count = 0 MUST reject BYOK unquoted model!
	mandate0, err := CreateProductionMandateInTx(db, userID, CreateProductionMandateInput{
		CanvasID:         canvasID,
		SessionID:        sessionID,
		MaxAmountCNY:     100.0,
		MaxUnquotedCount: 0,
		AllowedKinds:     []string{model.MandateKindImage},
		ApprovedBy:       "ui",
	})
	if err != nil {
		t.Fatal(err)
	}
	binder := &mandateCanvasDomain{doc: makeMandateCanvasDoc(2, "byok::img-unquoted"), catalog: makeMandateTestCatalog(t)}
	reg := NewRegistry(binder, NewStore(db))
	RegisterDefaultOps(reg)

	params1, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"shot-1"}})
	_, err1 := reg.Execute(Request{
		OpID: "byok-1", Op: "canvas.generation.submit", UserID: userID, TurnID: turnID,
		Caller: Caller{Kind: CallerAssistant, Scope: allowAllScope{}}, Params: params1,
	})
	if err1 == nil || AsError(err1).Reason != "approval_required" {
		t.Fatalf("BYOK unquoted model must NEVER bypass CNY mandate when max_unquoted_count=0, got %v", err1)
	}

	// Revoke mandate0 and create mandate1 with explicit max_unquoted_count = 1.
	if _, err := RevokeProductionMandateInTx(db, userID, mandate0.ID); err != nil {
		t.Fatal(err)
	}
	mandate1, err := CreateProductionMandateInTx(db, userID, CreateProductionMandateInput{
		CanvasID:         canvasID,
		SessionID:        sessionID,
		MaxAmountCNY:     100.0,
		MaxUnquotedCount: 1,
		AllowedKinds:     []string{model.MandateKindImage},
		ApprovedBy:       "ui",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Execute(Request{
		OpID: "byok-1-ok", Op: "canvas.generation.submit", UserID: userID, TurnID: turnID,
		Caller: Caller{Kind: CallerAssistant, Scope: allowAllScope{}}, Params: params1,
	}); err != nil {
		t.Fatalf("BYOK with explicit max_unquoted_count=1 should succeed: %v", err)
	}
	// 2nd BYOK call must be blocked once the 1 unquoted slot is consumed!
	params2, _ := json.Marshal(map[string]any{"canvasId": canvasID, "nodeIds": []string{"shot-2"}})
	_, err2 := reg.Execute(Request{
		OpID: "byok-2-blocked", Op: "canvas.generation.submit", UserID: userID, TurnID: turnID,
		Caller: Caller{Kind: CallerAssistant, Scope: allowAllScope{}}, Params: params2,
	})
	if err2 == nil || AsError(err2).Reason != "approval_required" {
		t.Fatalf("2nd BYOK call must fail with approval_required after 1 slot consumed, got %v", err2)
	}
	got, _ := GetProductionMandateInTx(db, userID, mandate1.ID)
	if got.UsedUnquotedCount != 1 {
		t.Fatalf("expected used_unquoted_count=1, got %d", got.UsedUnquotedCount)
	}
}

type failingReviewDomain struct {
	*reviewDomain
	failNext bool
}

func (d *failingReviewDomain) ReviewMedia(ctx context.Context, p MediaPart, q string) (MediaReviewObservation, error) {
	if d.failNext {
		d.failNext = false
		return MediaReviewObservation{}, errors.New("upstream_review_timeout")
	}
	return d.reviewDomain.ReviewMedia(ctx, p, q)
}

func TestProductionMandateMediaReviewExhaustsAndPauses(t *testing.T) {
	db := openMandateTestDB(t)
	userID, canvasID, turnID := "owner", "canvas", "turn-review"
	if err := db.Create(&model.AssistantTurn{
		TurnID: turnID, UserID: userID, CanvasID: canvasID, State: "open",
	}).Error; err != nil {
		t.Fatal(err)
	}
	mandate, err := CreateProductionMandateInTx(db, userID, CreateProductionMandateInput{
		CanvasID:         canvasID,
		MaxAmountCNY:     10.0,
		MaxUnquotedCount: 2,
		AllowedKinds:     []string{model.MandateKindMediaReview},
		ApprovedBy:       "ui",
	})
	if err != nil {
		t.Fatal(err)
	}

	data := nativeMediaFixture(t, true, false)
	sum := sha256.Sum256(data)
	dom := &failingReviewDomain{reviewDomain: &reviewDomain{mediaDomain: &mediaDomain{owner: userID, data: data}}}
	args, _ := json.Marshal(mediaReviewArgs{
		CanvasID: canvasID, NodeID: "node", ExpectedVersion: hex.EncodeToString(sum[:]),
		StartMs: 200, EndMs: 1200, Question: "检查画面动作",
	})
	call := func() (any, error) {
		return runMediaReview(&Context{
			Context: context.Background(),
			UserID:  userID,
			TurnID:  turnID,
			Caller:  Caller{Kind: CallerAssistant},
			Domain:  dom,
			Store:   NewStore(db),
		}, args)
	}

	// Failed ReviewMedia must release its slot so it doesn't burn the mandate.
	dom.failNext = true
	if _, err := call(); err == nil {
		t.Fatal("expected injected review failure")
	}
	afterFail, _ := GetProductionMandateInTx(db, userID, mandate.ID)
	if afterFail.UsedUnquotedCount != 0 {
		t.Fatalf("failed media.review must release unquoted slot, got used=%d", afterFail.UsedUnquotedCount)
	}

	// 2 successful media.review calls consume both slots.
	for i := 0; i < 2; i++ {
		if _, err := call(); err != nil {
			t.Fatalf("review %d should succeed under mandate: %v", i+1, err)
		}
	}
	// 3rd call must be blocked BEFORE calling ReviewMedia!
	if _, err := call(); err == nil || AsError(err).Reason != "approval_required" {
		t.Fatalf("3rd media.review must trigger approval_required, got %v", err)
	}
	if dom.calls != 2 {
		t.Fatalf("expected exactly 2 provider ReviewMedia calls, got %d", dom.calls)
	}
}

type allowAllScope struct{}

func (allowAllScope) Visible(*Op) bool              { return true }
func (allowAllScope) Allows(*Op, json.RawMessage) error { return nil }
