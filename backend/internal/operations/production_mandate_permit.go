package operations

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/assistantturns"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

// tryAdmitAssistantGenerationViaMandateInTx attempts to authorize and admit a
// built-in assistant canvas.generation.submit / regenerate call inside the
// caller's Store.Run transaction via either an owner-approved single-call
// ToolApprovalRecord or an active ProductionMandate.
// When an approval also created a ProductionMandate (approvedCall.MandateID != ""),
// the triggering call is STILL atomically reserved against that mandate so Shot 1
// never bypasses the newly created budget cap.
func tryAdmitAssistantGenerationViaMandateInTx(
	ctx *Context,
	canvasID, proposalID string,
	nodes map[string]map[string]any,
	targets []GenerationTarget,
	releaseEnded bool,
) (any, bool, error) {
	tx := ctx.DB()
	if tx == nil || strings.TrimSpace(ctx.TurnID) == "" {
		return nil, false, nil
	}
	if plan, err := ResolveAuthorizedOrderForTurnInTx(tx, ctx.UserID, canvasID, ctx.TurnID); err != nil {
		return nil, true, err
	} else if plan != nil && plan.SourceTurnID != "" {
		if !releaseEnded || plan.Regenerate {
			approvedMap := make(map[string]GenerationTarget, len(plan.Targets))
			for _, t := range plan.Targets {
				approvedMap[t.NodeID] = t
			}
			allCovered := len(targets) > 0
			for _, t := range targets {
				exp, ok := approvedMap[t.NodeID]
				if !ok || !GenerationTargetEqual(exp, t) {
					allCovered = false
					break
				}
			}
			if allCovered {
				return nil, false, nil
			}
		}
	}

	var source model.AssistantTurn
	if err := tx.First(&source, "turn_id = ? AND user_id = ? AND canvas_id = ?", ctx.TurnID, ctx.UserID, canvasID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, false, nil
		}
		return nil, true, AsError(err)
	}
	if source.Undone || source.ContinuationInvalidated {
		return nil, true, PreconditionFailed("production_revoked", "本次制作授权已停止", nil)
	}

	opName := "canvas.generation.submit"
	if releaseEnded {
		opName = "canvas.generation.regenerate"
	}
	targetNodeIDs := make([]string, 0, len(targets))
	for _, t := range targets {
		targetNodeIDs = append(targetNodeIDs, t.NodeID)
	}
	targetDigest := ComputeApprovalTargetDigest(opName, canvasID, targetNodeIDs, nil)
	approvedCall, err := LookupApprovedToolApprovalForCallInTx(
		tx,
		ctx.UserID,
		canvasID,
		ctx.TurnID,
		ctx.OperationID,
		opName,
		targetNodeIDs,
		targetDigest,
	)
	if err != nil {
		return nil, true, err
	}

	now := time.Now().UTC()
	var chargeMandate *model.AssistantProductionMandate
	if approvedCall != nil {
		// Atomically consume the single-call approval before reserving/submitting.
		if err := ConsumeToolApprovalAtomicInTx(tx, ctx.UserID, approvedCall); err != nil {
			return nil, true, err
		}
		// If owner approved with a newly created mandate, deduct the triggering call from it!
		if strings.TrimSpace(approvedCall.MandateID) != "" {
			m, mErr := GetProductionMandateInTx(tx, ctx.UserID, approvedCall.MandateID)
			if mErr != nil {
				return nil, true, mErr
			}
			chargeMandate = m
		}
	} else {
		activeMandate, findErr := FindActiveMandateInTx(tx, ctx.UserID, canvasID, source.DurableSessionID, now)
		if findErr != nil {
			return nil, true, findErr
		}
		if activeMandate == nil {
			if HasAnyMandateInTx(tx, ctx.UserID, canvasID, source.DurableSessionID) {
				return nil, true, PreconditionFailed("approval_required", "当前制作预算包额度已用尽，请批准本次调用或追加预算包", map[string]any{
					"reason": "mandate_exhausted",
				})
			}
			return nil, false, nil
		}
		chargeMandate = activeMandate
	}

	port, ok := ctx.Domain.(ExternalGenerationAdmission)
	if !ok {
		return nil, true, Unsupported("generation_unavailable", "当前工作区不能提交生成")
	}

	callKey := strings.TrimSpace(ctx.OperationID)
	if callKey == "" {
		callKey = "turn:" + ctx.TurnID + ":" + newMandateID("call")
	}

	var reservations []model.AssistantMandateReservation
	var updatedMandate *model.AssistantProductionMandate
	var totalQuotedCNY float64
	if chargeMandate != nil {
		items, quoted, _, _ := buildGenerationReserveItems(ctx.Domain, nodes, targets, "op:"+callKey)
		totalQuotedCNY = quoted
		reservations, updatedMandate, err = ReserveMandateBatchInTx(tx, ctx.UserID, chargeMandate.ID, items, now)
		if err != nil {
			return nil, true, err
		}
	}

	admitKey := "mandate:" + callKey
	if approvedCall != nil {
		admitKey = "approval:" + approvedCall.ProposalID + ":" + callKey
	}
	out, err := port.SubmitExternalGeneration(ctx.UserID, admitKey, canvasID, targets, releaseEnded)
	if err != nil {
		return nil, true, err
	}

	taskIDs := extractSubmittedTaskIDs(out)
	for i := range reservations {
		if i < len(taskIDs) && strings.TrimSpace(taskIDs[i]) != "" {
			if bindErr := BindMandateReservationTaskInTx(tx, reservations[i].ID, taskIDs[i]); bindErr != nil {
				return nil, true, AsError(bindErr)
			}
		}
	}

	approvedBy := "ui"
	if approvedCall != nil {
		if strings.TrimSpace(approvedCall.ApprovedBy) != "" {
			approvedBy = approvedCall.ApprovedBy
		}
	} else if updatedMandate != nil {
		approvedBy = "mandate:" + updatedMandate.ID
	}

	if outMap, ok := out.(map[string]any); ok {
		if updatedMandate != nil {
			outMap["mandateId"] = updatedMandate.ID
			outMap["mandateRemainingCny"] = mandateRemainingCNY(updatedMandate)
			outMap["mandateRemainingUnquoted"] = mandateRemainingUnquoted(updatedMandate)
		}
		if totalQuotedCNY > 0 {
			outMap["estimatedCny"] = totalQuotedCNY
		}
		if approvedCall != nil {
			outMap["approvalProposalId"] = approvedCall.ProposalID
		}
	}

	orderProposalID := proposalID
	if orderProposalID == "" {
		if approvedCall != nil {
			orderProposalID = approvedCall.ProposalID
		} else {
			orderProposalID = "mp-" + callKey
		}
	}
	nodeIDs := make([]string, 0, len(targets))
	kind := ""
	for _, t := range targets {
		nodeIDs = append(nodeIDs, t.NodeID)
		if kind == "" {
			kind = t.Kind
		} else if kind != t.Kind {
			kind = "mixed"
		}
	}
	_ = MarkGenerationOrderSubmittedInTx(tx, ctx.Domain, ctx.UserID, canvasID, ctx.TurnID, orderProposalID, kind, nodeIDs, targets, out, "", approvedBy, releaseEnded)
	return out, true, nil
}

// AttachMandateForProductionConfirmInTx atomically creates a ProductionMandate
// inside ConfirmAssistantProduction's transaction, deducts the confirmed batch
// from that new mandate (binding submitted taskIds), and attaches the updated
// mandate view to result. Any validation or budget error fails and rolls back the tx.
func AttachMandateForProductionConfirmInTx(
	tx *gorm.DB,
	domain Domain,
	userID, canvasID, sessionID, proposalID, approvedBy string,
	createMandate *CreateProductionMandateInput,
	doc map[string]any,
	batch []GenerationTarget,
	result any,
) error {
	if createMandate == nil {
		return nil
	}
	in := *createMandate
	if strings.TrimSpace(in.CanvasID) == "" {
		in.CanvasID = canvasID
	} else if strings.TrimSpace(in.CanvasID) != strings.TrimSpace(canvasID) {
		return InvalidArg("canvas_mismatch", "预算包画布与当前生成方案所属画布不一致")
	}
	if strings.TrimSpace(in.SessionID) == "" {
		in.SessionID = sessionID
	}
	in.ApprovedBy = approvedBy

	m, err := CreateProductionMandateInTx(tx, userID, in)
	if err != nil {
		return err
	}
	nodes := map[string]map[string]any{}
	for _, v := range canvasNodes(doc) {
		if n, ok := v.(map[string]any); ok {
			nodes[dependencyString(n, "id")] = n
		}
	}
	now := time.Now().UTC()
	items, _, _, _ := buildGenerationReserveItems(domain, nodes, batch, "confirm:"+strings.TrimSpace(proposalID))
	reservations, updatedMandate, err := ReserveMandateBatchInTx(tx, userID, m.ID, items, now)
	if err != nil {
		return err
	}
	taskIDs := extractSubmittedTaskIDs(result)
	for i := range reservations {
		if i < len(taskIDs) && strings.TrimSpace(taskIDs[i]) != "" {
			if bindErr := BindMandateReservationTaskInTx(tx, reservations[i].ID, taskIDs[i]); bindErr != nil {
				return AsError(bindErr)
			}
		}
	}
	if resMap, ok := result.(map[string]any); ok && updatedMandate != nil {
		resMap["mandate"] = ProjectProductionMandate(*updatedMandate)
	}
	return nil
}

// paidSyncPermit holds an in-flight synchronous paid-op reservation (media.review
// or cloud Whisper media_transcribe) so the caller can settle on success or release on error.
type paidSyncPermit struct {
	db            *gorm.DB
	userID        string
	reservationID string
	mandateID     string
}

func (p *paidSyncPermit) Settle(taskID string) {
	if p == nil || p.db == nil || p.reservationID == "" {
		return
	}
	now := time.Now().UTC()
	_ = p.db.Transaction(func(tx *gorm.DB) error {
		if tid := strings.TrimSpace(taskID); tid != "" {
			if err := BindMandateReservationTaskInTx(tx, p.reservationID, tid); err != nil {
				return err
			}
			var res model.AssistantMandateReservation
			if err := tx.Where("id = ?", p.reservationID).First(&res).Error; err != nil {
				return err
			}
			var task model.Task
			taskPtr := &task
			if err := tx.Where("id = ?", tid).First(&task).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					taskPtr = nil
				} else {
					return err
				}
			}
			return ReconcileTaskReservationInTx(tx, res, taskPtr, now)
		}
		return SettleReservationInTx(tx, p.reservationID, now)
	})
}

func (p *paidSyncPermit) Release() {
	if p == nil || p.db == nil || p.reservationID == "" {
		return
	}
	now := time.Now().UTC()
	_ = p.db.Transaction(func(tx *gorm.DB) error {
		return ReleaseReservationInTx(tx, p.reservationID, now)
	})
}

// acquirePaidSyncPermit atomically consumes a single-call ToolApprovalRecord
// (and deducts from its bound MandateID if present) or reserves an unquoted slot
// on an active ProductionMandate for paid synchronous ops (media.review / cloud transcribe).
func acquirePaidSyncPermit(ctx *Context, canvasID, kind, opName, targetDigest string) (*paidSyncPermit, error) {
	db := ctx.DB()
	if db == nil {
		return nil, nil
	}
	sessionID := ""
	if strings.TrimSpace(ctx.TurnID) != "" {
		sessionID = lookupTurnSessionID(db, ctx.UserID, ctx.TurnID)
	}
	callID := strings.TrimSpace(ctx.OperationID)
	reserveCallID := callID
	if reserveCallID == "" {
		reserveCallID = kind + ":" + newMandateID("call")
	}
	var permit *paidSyncPermit
	err := db.Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		approved, err := LookupApprovedToolApprovalForCallInTx(tx, ctx.UserID, canvasID, ctx.TurnID, callID, opName, nil, targetDigest)
		if err != nil {
			return err
		}
		if approved != nil {
			// Atomically consume inside the initial tx so concurrent calls cannot double-use.
			if err := ConsumeToolApprovalAtomicInTx(tx, ctx.UserID, approved); err != nil {
				return err
			}
			if mID := strings.TrimSpace(approved.MandateID); mID != "" {
				res, _, rErr := ReserveMandateInTx(tx, ctx.UserID, mID, MandateReserveItem{
					CallID:   reserveCallID,
					Kind:     kind,
					Unquoted: true,
				}, now)
				if rErr != nil {
					return rErr
				}
				permit = &paidSyncPermit{db: db, userID: ctx.UserID, reservationID: res.ID, mandateID: mID}
				return nil
			}
			permit = &paidSyncPermit{db: db, userID: ctx.UserID}
			return nil
		}
		mandate, err := FindActiveMandateInTx(tx, ctx.UserID, canvasID, sessionID, now)
		if err != nil {
			return err
		}
		if mandate == nil {
			return PreconditionFailed("approval_required", "该付费操作需要用户批准或有效制作预算包授权", map[string]any{
				"kind":   kind,
				"reason": "no_active_mandate",
			})
		}
		res, _, err := ReserveMandateInTx(tx, ctx.UserID, mandate.ID, MandateReserveItem{
			CallID:   reserveCallID,
			Kind:     kind,
			Unquoted: true,
		}, now)
		if err != nil {
			return err
		}
		permit = &paidSyncPermit{db: db, userID: ctx.UserID, reservationID: res.ID, mandateID: mandate.ID}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return permit, nil
}

// ReconcileTaskReservationInTx aligns a single reserved row against its owning task's
// canonical ComputeOutcome state.
// Hard #297 invariant: NEVER release failed+retrievable, settlement-pending,
// cancelled_result_unconfirmed, or result_unrecoverable; ONLY release when
// ComputeOutcome explicitly confirms outcome.Regenerate == "allowed".
func ReconcileTaskReservationInTx(tx *gorm.DB, res model.AssistantMandateReservation, task *model.Task, now time.Time) error {
	if res.Status != model.MandateReservationStatusReserved {
		return nil
	}
	if task == nil {
		return ReleaseReservationInTx(tx, res.ID, now)
	}
	if task.Status == model.TaskStatusSucceeded {
		return SettleReservationInTx(tx, res.ID, now)
	}
	if task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning {
		return nil
	}
	proj, _, _, err := assistantturns.ProjectTaskInTx(tx, res.UserID, *task)
	if err != nil {
		return nil
	}
	outcome := proj.Outcome
	usageState := strings.ToLower(strings.TrimSpace(task.ProviderUsageState()))
	billingState := strings.ToLower(strings.TrimSpace(task.ProviderBillingState()))

	if usageState == "completed" || (billingState == "settled" && usageState != "failed") || outcome.Reason == localtask.ReasonChargedResultUnrecoverable {
		return SettleReservationInTx(tx, res.ID, now)
	}
	if outcome.Phase == "retrievable" || outcome.Phase == "fetching" || outcome.Phase == "running" ||
		task.MediaSettlementPending() || outcome.Reason == localtask.ReasonSettlementPending {
		return nil
	}
	// Strictly require outcome.Regenerate == "allowed" (never release on
	// ReasonCancelledResultUnconfirmed or result_unrecoverable where Regenerate == "confirm").
	if (task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled) &&
		outcome.Phase == "failed" &&
		outcome.Regenerate == "allowed" {
		return ReleaseReservationInTx(tx, res.ID, now)
	}
	return nil
}

// ReconcileTaskMandateReservations reconciles any reserved mandate entries bound to taskID.
func ReconcileTaskMandateReservations(db *gorm.DB, taskID string) error {
	taskID = strings.TrimSpace(taskID)
	if db == nil || taskID == "" {
		return nil
	}
	var count int64
	if err := db.Model(&model.AssistantMandateReservation{}).
		Where("task_id = ? AND status = ?", taskID, model.MandateReservationStatusReserved).
		Count(&count).Error; err != nil || count == 0 {
		return err
	}
	now := time.Now().UTC()
	return db.Transaction(func(tx *gorm.DB) error {
		var rows []model.AssistantMandateReservation
		if err := tx.Where("task_id = ? AND status = ?", taskID, model.MandateReservationStatusReserved).Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		var task model.Task
		taskPtr := &task
		if err := tx.Where("id = ?", taskID).First(&task).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				taskPtr = nil
			} else {
				return err
			}
		}
		for _, res := range rows {
			if err := ReconcileTaskReservationInTx(tx, res, taskPtr, now); err != nil {
				return err
			}
		}
		return nil
	})
}

// ReconcileOrphanedMandateReservations runs on Go backend startup to settle or release
// reservations left behind by crashes between reserve and task admission or task completion.
func ReconcileOrphanedMandateReservations(db *gorm.DB) error {
	if db == nil {
		return nil
	}
	if !db.Migrator().HasTable(&model.AssistantMandateReservation{}) {
		return nil
	}
	now := time.Now().UTC()
	return db.Transaction(func(tx *gorm.DB) error {
		var rows []model.AssistantMandateReservation
		if err := tx.Where("status = ?", model.MandateReservationStatusReserved).Find(&rows).Error; err != nil {
			return err
		}
		for _, res := range rows {
			if strings.TrimSpace(res.TaskID) == "" {
				if err := ReleaseReservationInTx(tx, res.ID, now); err != nil {
					return err
				}
				continue
			}
			var task model.Task
			taskPtr := &task
			if err := tx.Where("id = ?", res.TaskID).First(&task).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					taskPtr = nil
				} else {
					return err
				}
			}
			if err := ReconcileTaskReservationInTx(tx, res, taskPtr, now); err != nil {
				return err
			}
		}
		return nil
	})
}
