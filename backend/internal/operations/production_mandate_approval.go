package operations

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

const (
	toolApprovalOpName = "assistant.tool.approval"

	ToolApprovalStatusPending  = "pending"
	ToolApprovalStatusApproved = "approved"
	ToolApprovalStatusRejected = "rejected"
	ToolApprovalStatusConsumed = "consumed"
)

// ToolApprovalRecord persists a parked paid-tool approval request (and owner
// decision) in agent_op_records so page refresh, host restart, and Go-side
// atomic re-verification share one SQLite source of truth.
type ToolApprovalRecord struct {
	ProposalID      string         `json:"proposalId"`
	CanvasID        string         `json:"canvasId"`
	SessionID       string         `json:"sessionId,omitempty"`
	TurnID          string         `json:"turnId,omitempty"`
	DurableTaskID   int64          `json:"durableTaskId,omitempty"`
	ToolName        string         `json:"toolName"`
	OpName          string         `json:"opName,omitempty"`
	CallID          string         `json:"callId,omitempty"`
	Kind            string         `json:"kind,omitempty"`
	Kinds           []string       `json:"kinds,omitempty"`
	NodeIDs         []string       `json:"nodeIds,omitempty"`
	Summary         string         `json:"summary,omitempty"`
	Reason          string         `json:"reason,omitempty"`
	EstimatedCNY    *float64       `json:"estimatedCny,omitempty"`
	UnquotedCount   int            `json:"unquotedCount,omitempty"`
	SuggestedCapCNY float64        `json:"suggestedCapCny,omitempty"`
	Status          string         `json:"status"`
	Decision        string         `json:"decision,omitempty"`
	ApprovedBy      string         `json:"approvedBy,omitempty"`
	MandateID       string         `json:"mandateId,omitempty"`
	RejectReason    string         `json:"rejectReason,omitempty"`
	Details         map[string]any `json:"details,omitempty"`
	CreatedAt       string         `json:"createdAt"`
	UpdatedAt       string         `json:"updatedAt"`
}

// ToolPrecheckRequest is sent by agent-host's central ToolHooks.beforeTool gate
// to Go before executing a paid operation.
type ToolPrecheckRequest struct {
	CanvasID      string          `json:"canvasId"`
	SessionID     string          `json:"sessionId"`
	TurnID        string          `json:"turnId"`
	DurableTaskID int64           `json:"durableTaskId"`
	ToolName      string          `json:"toolName"`
	OpName        string          `json:"opName"`
	CallID        string          `json:"callId"`
	Params        json.RawMessage `json:"params"`
}

// ToolPrecheckResult tells beforeTool whether to proceed, sleep for owner
// approval, or block immediately.
type ToolPrecheckResult struct {
	Decision        string                 `json:"decision"` // allow | approval_required | deny
	Reason          string                 `json:"reason,omitempty"`
	Message         string                 `json:"message,omitempty"`
	ProposalID      string                 `json:"proposalId,omitempty"`
	MandateID       string                 `json:"mandateId,omitempty"`
	EstimatedCNY    *float64               `json:"estimatedCny,omitempty"`
	UnquotedCount   int                    `json:"unquotedCount,omitempty"`
	Kinds           []string               `json:"kinds,omitempty"`
	Summary         string                 `json:"summary,omitempty"`
	SuggestedCapCNY float64                `json:"suggestedCapCny,omitempty"`
	Approval        *ToolApprovalRecord    `json:"approval,omitempty"`
	Mandate         *ProductionMandateView `json:"mandate,omitempty"`
}

func toolApprovalOpID(proposalID string) string {
	return "tool-approval:" + strings.TrimSpace(proposalID)
}

// DeterministicApprovalProposalID produces a stable proposal ID for (turnID, callID)
// so gatedCall early wakeups on restart never duplicate approval records.
func DeterministicApprovalProposalID(turnID, callID string) string {
	key := strings.TrimSpace(turnID) + "\x00" + strings.TrimSpace(callID)
	sum := sha256.Sum256([]byte(key))
	return "ap-" + hex.EncodeToString(sum[:8])
}

func UpsertToolApprovalInTx(tx *gorm.DB, userID string, rec ToolApprovalRecord) error {
	if tx == nil || strings.TrimSpace(rec.ProposalID) == "" {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if strings.TrimSpace(rec.CreatedAt) == "" {
		rec.CreatedAt = now
	}
	rec.UpdatedAt = now
	if strings.TrimSpace(rec.Status) == "" {
		rec.Status = ToolApprovalStatusPending
	}
	encoded, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	opID := toolApprovalOpID(rec.ProposalID)
	status := "approval:" + rec.Status
	var existing model.AgentOpRecord
	findErr := tx.Where("user_id = ? AND op_id = ?", userID, opID).First(&existing).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		return tx.Create(&model.AgentOpRecord{
			OpID:        opID,
			UserID:      userID,
			Op:          toolApprovalOpName,
			PayloadHash: strings.TrimSpace(rec.CanvasID),
			Status:      status,
			ResultJSON:  string(encoded),
			TurnID:      strings.TrimSpace(rec.TurnID),
		}).Error
	}
	if findErr != nil {
		return findErr
	}
	return tx.Model(&model.AgentOpRecord{}).
		Where("user_id = ? AND op_id = ?", userID, opID).
		Updates(map[string]any{
			"payload_hash": strings.TrimSpace(rec.CanvasID),
			"status":       status,
			"result_json":  string(encoded),
			"turn_id":      strings.TrimSpace(rec.TurnID),
		}).Error
}

func LookupToolApprovalInTx(tx *gorm.DB, userID, proposalID string) (*ToolApprovalRecord, error) {
	if tx == nil || strings.TrimSpace(proposalID) == "" {
		return nil, nil
	}
	var row model.AgentOpRecord
	err := tx.Where("user_id = ? AND op_id = ?", userID, toolApprovalOpID(proposalID)).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, AsError(err)
	}
	var rec ToolApprovalRecord
	if err := json.Unmarshal([]byte(row.ResultJSON), &rec); err != nil {
		return nil, AsError(err)
	}
	return &rec, nil
}

func ListPendingToolApprovalsInTx(tx *gorm.DB, userID, canvasID, sessionID string) ([]ToolApprovalRecord, error) {
	if tx == nil || strings.TrimSpace(userID) == "" {
		return []ToolApprovalRecord{}, nil
	}
	q := tx.Where("user_id = ? AND op = ? AND status = ?", userID, toolApprovalOpName, "approval:"+ToolApprovalStatusPending)
	if c := strings.TrimSpace(canvasID); c != "" {
		q = q.Where("payload_hash = ?", c)
	}
	var rows []model.AgentOpRecord
	if err := q.Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, AsError(err)
	}
	sessionID = strings.TrimSpace(sessionID)
	out := make([]ToolApprovalRecord, 0, len(rows))
	for _, row := range rows {
		var rec ToolApprovalRecord
		if json.Unmarshal([]byte(row.ResultJSON), &rec) != nil {
			continue
		}
		if sessionID != "" && strings.TrimSpace(rec.SessionID) != "" && strings.TrimSpace(rec.SessionID) != sessionID {
			continue
		}
		out = append(out, rec)
	}
	return out, nil
}

// LookupApprovedToolApprovalForCallInTx looks up an owner-approved single-call
// ToolApprovalRecord matching either explicit proposalID, (turnID, callID), or
// an approved pending record on the same (turnID, opName, canvasID).
func LookupApprovedToolApprovalForCallInTx(
	tx *gorm.DB,
	userID, canvasID, turnID, proposalID, callID, opName string,
) (*ToolApprovalRecord, error) {
	if tx == nil {
		return nil, nil
	}
	candidates := []string{}
	if id := strings.TrimSpace(proposalID); id != "" {
		candidates = append(candidates, id)
	}
	if strings.TrimSpace(turnID) != "" && strings.TrimSpace(callID) != "" {
		candidates = append(candidates, DeterministicApprovalProposalID(turnID, callID))
	}
	for _, id := range candidates {
		rec, err := LookupToolApprovalInTx(tx, userID, id)
		if err != nil {
			return nil, err
		}
		if rec != nil && rec.Status == ToolApprovalStatusApproved &&
			(rec.CanvasID == "" || rec.CanvasID == canvasID) &&
			(rec.TurnID == "" || turnID == "" || rec.TurnID == turnID) {
			return rec, nil
		}
	}
	if strings.TrimSpace(turnID) == "" {
		return nil, nil
	}
	var rows []model.AgentOpRecord
	if err := tx.Where("user_id = ? AND op = ? AND payload_hash = ? AND turn_id = ? AND status = ?",
		userID, toolApprovalOpName, strings.TrimSpace(canvasID), strings.TrimSpace(turnID), "approval:"+ToolApprovalStatusApproved).
		Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, AsError(err)
	}
	for _, row := range rows {
		var rec ToolApprovalRecord
		if json.Unmarshal([]byte(row.ResultJSON), &rec) != nil {
			continue
		}
		if opName == "" || rec.OpName == "" || rec.OpName == opName {
			if callID == "" || rec.CallID == "" || rec.CallID == callID {
				return &rec, nil
			}
		}
	}
	return nil, nil
}

func MarkToolApprovalConsumedInTx(tx *gorm.DB, userID string, rec *ToolApprovalRecord) error {
	if tx == nil || rec == nil {
		return nil
	}
	updated := *rec
	updated.Status = ToolApprovalStatusConsumed
	return UpsertToolApprovalInTx(tx, userID, updated)
}

func DecideToolApprovalInTx(
	tx *gorm.DB,
	userID, proposalID, decision, approvedBy, rejectReason string,
	createMandate *CreateProductionMandateInput,
) (*ToolApprovalRecord, *model.AssistantProductionMandate, error) {
	rec, err := LookupToolApprovalInTx(tx, userID, proposalID)
	if err != nil {
		return nil, nil, err
	}
	if rec == nil {
		return nil, nil, NotFound("approval_not_found", "待审批记录不存在: "+proposalID)
	}
	decision = strings.ToLower(strings.TrimSpace(decision))
	if decision != "approve" && decision != "reject" {
		return nil, nil, InvalidArg("invalid_decision", "decision 必须是 approve 或 reject")
	}
	var createdMandate *model.AssistantProductionMandate
	if decision == "approve" && createMandate != nil {
		in := *createMandate
		if strings.TrimSpace(in.CanvasID) == "" {
			in.CanvasID = rec.CanvasID
		}
		if strings.TrimSpace(in.SessionID) == "" {
			in.SessionID = rec.SessionID
		}
		in.ApprovedBy = approvedBy
		m, mErr := CreateProductionMandateInTx(tx, userID, in)
		if mErr != nil {
			return nil, nil, mErr
		}
		createdMandate = m
		rec.MandateID = m.ID
	}
	if rec.Status == ToolApprovalStatusPending {
		if decision == "approve" {
			rec.Status = ToolApprovalStatusApproved
		} else {
			rec.Status = ToolApprovalStatusRejected
		}
		rec.Decision = decision
		rec.ApprovedBy = approvedBy
		rec.RejectReason = strings.TrimSpace(rejectReason)
		if err := UpsertToolApprovalInTx(tx, userID, *rec); err != nil {
			return nil, nil, err
		}
	}
	return rec, createdMandate, nil
}

// suggestedMandateCap rounds an estimated cost up to a helpful budget-pack default.
func suggestedMandateCap(estimatedCNY float64) float64 {
	if estimatedCNY <= 0 || math.IsNaN(estimatedCNY) || math.IsInf(estimatedCNY, 0) {
		return 20
	}
	for _, step := range []float64{20, 50, 100, 200, 500} {
		if estimatedCNY*3 <= step {
			return step
		}
	}
	return math.Ceil(estimatedCNY*2/50) * 50
}

// buildGenerationReserveItems prices each target individually so quoted targets
// reserve exact CNY while unquoted/BYOK targets consume explicit unquoted slots.
func buildGenerationReserveItems(
	domain Domain,
	nodes map[string]map[string]any,
	targets []GenerationTarget,
	callPrefix string,
) (items []MandateReserveItem, totalQuotedCNY float64, unquotedCount int, kinds []string) {
	est := EstimateGenerationCost(domain, estimateGenerationTargets(nodes, targets))
	kindSeen := map[string]bool{}
	items = make([]MandateReserveItem, 0, len(targets))
	for i, target := range targets {
		if !kindSeen[target.Kind] {
			kindSeen[target.Kind] = true
			kinds = append(kinds, target.Kind)
		}
		amount := 0.0
		isUnquoted := true
		if i < len(est.Items) {
			quote := est.Items[i]
			if quote.Amount != nil && !quote.Variable && quote.Reserve == nil && !math.IsNaN(*quote.Amount) && !math.IsInf(*quote.Amount, 0) && roundCNY(*quote.Amount) > 0 {
				amount = roundCNY(*quote.Amount)
				isUnquoted = false
			}
		}
		if isUnquoted {
			unquotedCount++
		} else {
			totalQuotedCNY = roundCNY(totalQuotedCNY + amount)
		}
		items = append(items, MandateReserveItem{
			CallID:    callPrefix + ":" + target.NodeID,
			Kind:      target.Kind,
			AmountCNY: amount,
			Unquoted:  isUnquoted,
		})
	}
	return items, totalQuotedCNY, unquotedCount, kinds
}

func checkMandateCapacity(
	mandate *model.AssistantProductionMandate,
	kinds []string,
	quotedCNY float64,
	unquotedCount int,
	now time.Time,
) (ok bool, reason, message string) {
	if mandate == nil {
		return false, "no_active_mandate", "尚未授权本片预算包，请批准本次调用或批准本片预算包"
	}
	if mandate.Status != model.MandateStatusActive || mandateIsExpired(mandate, now) {
		return false, "mandate_" + mandate.Status, "当前预算包已不可用，请重新授权"
	}
	for _, k := range kinds {
		if !mandateAllowsKind(mandate, k) {
			return false, "mandate_kind_not_allowed", "当前预算包未授权该类型操作: " + k
		}
	}
	if unquotedCount > 0 {
		rem := mandateRemainingUnquoted(mandate)
		if mandate.MaxUnquotedCount <= 0 || unquotedCount > rem {
			return false, "mandate_unquoted_not_allowed", "未报价或自带 Key 模型需要单独确认，当前预算包未报价额度不足"
		}
	}
	if quotedCNY > 0 {
		rem := mandateRemainingCNY(mandate)
		if roundCNY(quotedCNY) > rem {
			return false, "mandate_budget_exceeded", fmt.Sprintf("本次预估 ¥%.2f 超出预算包剩余额度 ¥%.2f", quotedCNY, rem)
		}
	}
	return true, "", ""
}

// isCloudTranscriptionBody inspects business_post_timeline_transcriptions body
// to distinguish paid cloud Whisper (non-empty model) from local whisper.cpp.
func isCloudTranscriptionBody(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var payload struct {
		Body struct {
			Model string `json:"model"`
		} `json:"body"`
		Model string `json:"model"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return false
	}
	return strings.TrimSpace(payload.Body.Model) != "" || strings.TrimSpace(payload.Model) != ""
}

// EvaluatePaidToolPrecheckInTx evaluates a paid tool call before execution inside
// ToolHooks.beforeTool. It never mutates mandate balances (actual atomic reservation
// happens inside the operation transaction), and persists a pending ToolApprovalRecord
// idempotently when owner confirmation is required.
func EvaluatePaidToolPrecheckInTx(
	tx *gorm.DB,
	domain Domain,
	userID string,
	req ToolPrecheckRequest,
) (ToolPrecheckResult, error) {
	opName := strings.TrimSpace(req.OpName)
	if opName == "" {
		opName = strings.TrimSpace(req.ToolName)
	}
	canvasID := strings.TrimSpace(req.CanvasID)
	sessionID := strings.TrimSpace(req.SessionID)
	turnID := strings.TrimSpace(req.TurnID)
	callID := strings.TrimSpace(req.CallID)
	if sessionID == "" && turnID != "" && tx != nil {
		sessionID = lookupTurnSessionID(tx, userID, turnID)
	}
	now := time.Now().UTC()

	var kinds []string
	var nodeIDs []string
	var quotedCNY float64
	var unquotedCount int
	var summary string
	var explicitProposalID string

	switch opName {
	case "canvas.generation.submit", "canvas.generation.regenerate":
		var args struct {
			CanvasID   string   `json:"canvasId"`
			ProposalID string   `json:"proposalId"`
			OrderID    string   `json:"orderId"`
			NodeIDs    []string `json:"nodeIds"`
		}
		_ = json.Unmarshal(req.Params, &args)
		if strings.TrimSpace(args.CanvasID) != "" {
			canvasID = strings.TrimSpace(args.CanvasID)
		}
		explicitProposalID = strings.TrimSpace(args.ProposalID)
		if explicitProposalID == "" {
			explicitProposalID = strings.TrimSpace(args.OrderID)
		}
		nodeIDs = args.NodeIDs
		if domain != nil && canvasID != "" && len(args.NodeIDs) > 0 {
			rawDoc, err := domain.UserCanvasProject(userID, canvasID)
			if err != nil {
				return ToolPrecheckResult{Decision: "deny", Reason: "canvas_not_found", Message: "画布不存在或无权访问"}, nil
			}
			var doc map[string]any
			if err := json.Unmarshal(rawDoc, &doc); err != nil {
				return ToolPrecheckResult{Decision: "deny", Reason: "invalid_canvas", Message: "画布内容无法解析"}, nil
			}
			targets, err := GenerationTargets(domain, doc, args.NodeIDs)
			if err != nil {
				opErr := AsError(err)
				return ToolPrecheckResult{Decision: "deny", Reason: opErr.Reason, Message: opErr.Message}, nil
			}
			// Legacy owner-confirmed GenerationOrder already authorizes this turn's exact targets.
			if turnID != "" && tx != nil {
				if plan, planErr := ResolveAuthorizedOrderForTurnInTx(tx, userID, canvasID, turnID); planErr == nil && plan != nil {
					if opName != "canvas.generation.regenerate" || plan.Regenerate {
						approvedMap := map[string]GenerationTarget{}
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
							return ToolPrecheckResult{Decision: "allow", Reason: "confirmed_generation_order"}, nil
						}
					}
				}
			}
			nodes := map[string]map[string]any{}
			for _, v := range canvasNodes(doc) {
				if n, ok := v.(map[string]any); ok {
					nodes[dependencyString(n, "id")] = n
				}
			}
			_, quotedCNY, unquotedCount, kinds = buildGenerationReserveItems(domain, nodes, targets, "precheck")
			actionLabel := "生成"
			if opName == "canvas.generation.regenerate" {
				actionLabel = "重做"
			}
			summary = fmt.Sprintf("%s %d 个素材节点", actionLabel, len(targets))
		} else {
			unquotedCount = 1
			kinds = []string{model.MandateKindImage}
			summary = "画布素材生成"
		}

	case "media.review":
		var args struct {
			CanvasID string `json:"canvasId"`
			Mode     string `json:"mode"`
		}
		_ = json.Unmarshal(req.Params, &args)
		if strings.TrimSpace(args.CanvasID) != "" {
			canvasID = strings.TrimSpace(args.CanvasID)
		}
		kinds = []string{model.MandateKindMediaReview}
		unquotedCount = 1
		modeLabel := "视频"
		if strings.EqualFold(strings.TrimSpace(args.Mode), "audio") {
			modeLabel = "音频"
		}
		summary = "调用多模态审片模型检查" + modeLabel + "片段"

	case "business.call":
		var args struct {
			Tool string          `json:"tool"`
			Body json.RawMessage `json:"body"`
		}
		_ = json.Unmarshal(req.Params, &args)
		if strings.TrimSpace(args.Tool) != "business_post_timeline_transcriptions" || !isCloudTranscriptionBody(args.Body) {
			return ToolPrecheckResult{Decision: "allow"}, nil
		}
		kinds = []string{model.MandateKindMediaTranscribe}
		unquotedCount = 1
		summary = "调用云端语音转写服务"

	default:
		return ToolPrecheckResult{Decision: "allow"}, nil
	}

	// Check if single-call owner approval already exists for this invocation.
	if tx != nil {
		if approved, err := LookupApprovedToolApprovalForCallInTx(tx, userID, canvasID, turnID, explicitProposalID, callID, opName); err == nil && approved != nil {
			return ToolPrecheckResult{
				Decision:   "allow",
				Reason:     "single_call_approved",
				ProposalID: approved.ProposalID,
				Approval:   approved,
			}, nil
		}
	}

	// Check active ProductionMandate capacity.
	var mandate *model.AssistantProductionMandate
	if tx != nil && canvasID != "" {
		mandate, _ = FindActiveMandateInTx(tx, userID, canvasID, sessionID, now)
	}
	var mandateView *ProductionMandateView
	if mandate != nil {
		v := ProjectProductionMandate(*mandate)
		mandateView = &v
	}
	if ok, reason, msg := checkMandateCapacity(mandate, kinds, quotedCNY, unquotedCount, now); ok {
		return ToolPrecheckResult{
			Decision:      "allow",
			Reason:        "active_mandate",
			MandateID:     mandate.ID,
			EstimatedCNY:  floatPtrIfPositive(quotedCNY),
			UnquotedCount: unquotedCount,
			Kinds:         kinds,
			Mandate:       mandateView,
		}, nil
	} else {
		proposalID := explicitProposalID
		if proposalID == "" {
			if turnID != "" && callID != "" {
				proposalID = DeterministicApprovalProposalID(turnID, callID)
			} else {
				proposalID = newMandateID("ap")
			}
		}
		// Preserve existing record status if already decided (e.g. rejected/approved across wakeup).
		if tx != nil {
			if existing, err := LookupToolApprovalInTx(tx, userID, proposalID); err == nil && existing != nil {
				if existing.Status == ToolApprovalStatusApproved {
					return ToolPrecheckResult{Decision: "allow", Reason: "single_call_approved", ProposalID: existing.ProposalID, Approval: existing}, nil
				}
				if existing.Status == ToolApprovalStatusRejected {
					rejectMsg := existing.RejectReason
					if rejectMsg == "" {
						rejectMsg = "用户已拒绝该操作"
					}
					return ToolPrecheckResult{Decision: "deny", Reason: "approval_rejected", Message: rejectMsg, ProposalID: existing.ProposalID, Approval: existing}, nil
				}
				// Update durableTaskId/sessionId if host restarted and re-parked cleanly.
				if req.DurableTaskID > 0 && existing.DurableTaskID != req.DurableTaskID {
					existing.DurableTaskID = req.DurableTaskID
					if sessionID != "" {
						existing.SessionID = sessionID
					}
					_ = UpsertToolApprovalInTx(tx, userID, *existing)
				}
				return ToolPrecheckResult{
					Decision:        "approval_required",
					Reason:          reason,
					Message:         msg,
					ProposalID:      existing.ProposalID,
					EstimatedCNY:    existing.EstimatedCNY,
					UnquotedCount:   existing.UnquotedCount,
					Kinds:           existing.Kinds,
					Summary:         existing.Summary,
					SuggestedCapCNY: existing.SuggestedCapCNY,
					Approval:        existing,
					Mandate:         mandateView,
				}, nil
			}
		}
		kindSingle := "mixed"
		if len(kinds) == 1 {
			kindSingle = kinds[0]
		}
		estPtr := floatPtrIfPositive(quotedCNY)
		suggested := suggestedMandateCap(quotedCNY)
		rec := ToolApprovalRecord{
			ProposalID:      proposalID,
			CanvasID:        canvasID,
			SessionID:       sessionID,
			TurnID:          turnID,
			DurableTaskID:   req.DurableTaskID,
			ToolName:        strings.TrimSpace(req.ToolName),
			OpName:          opName,
			CallID:          callID,
			Kind:            kindSingle,
			Kinds:           kinds,
			NodeIDs:         nodeIDs,
			Summary:         summary,
			Reason:          reason,
			EstimatedCNY:    estPtr,
			UnquotedCount:   unquotedCount,
			SuggestedCapCNY: suggested,
			Status:          ToolApprovalStatusPending,
		}
		if tx != nil {
			if err := UpsertToolApprovalInTx(tx, userID, rec); err != nil {
				return ToolPrecheckResult{}, err
			}
		}
		return ToolPrecheckResult{
			Decision:        "approval_required",
			Reason:          reason,
			Message:         msg,
			ProposalID:      proposalID,
			EstimatedCNY:    estPtr,
			UnquotedCount:   unquotedCount,
			Kinds:           kinds,
			Summary:         summary,
			SuggestedCapCNY: suggested,
			Approval:        &rec,
			Mandate:         mandateView,
		}, nil
	}
}

func floatPtrIfPositive(v float64) *float64 {
	if v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) {
		c := roundCNY(v)
		return &c
	}
	return nil
}

func lookupTurnCanvasID(db *gorm.DB, userID, turnID string) string {
	if db == nil || strings.TrimSpace(turnID) == "" {
		return ""
	}
	var row model.AssistantTurn
	if err := db.Select("canvas_id").Where("turn_id = ? AND user_id = ?", strings.TrimSpace(turnID), userID).First(&row).Error; err != nil {
		return ""
	}
	return strings.TrimSpace(row.CanvasID)
}

// tryAdmitAssistantGenerationViaMandateInTx attempts to authorize and admit a
// built-in assistant canvas.generation.submit / regenerate call inside the
// caller's Store.Run transaction via either an owner-approved single-call
// ToolApprovalRecord or an active ProductionMandate.
// Returns (result, handled, err). When handled==false, caller falls back to the
// legacy GenerationOrder AuthorizedGenerationAdmission path.
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
	// If the turn already has a legacy owner-confirmed GenerationOrder covering
	// these targets, keep using the legacy AuthorizedGenerationAdmission path.
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
	approvedCall, err := LookupApprovedToolApprovalForCallInTx(tx, ctx.UserID, canvasID, ctx.TurnID, proposalID, ctx.OperationID, opName)
	if err != nil {
		return nil, true, err
	}

	now := time.Now().UTC()
	var activeMandate *model.AssistantProductionMandate
	if approvedCall == nil {
		activeMandate, err = FindActiveMandateInTx(tx, ctx.UserID, canvasID, source.DurableSessionID, now)
		if err != nil {
			return nil, true, err
		}
		if activeMandate == nil {
			if HasAnyMandateInTx(tx, ctx.UserID, canvasID, source.DurableSessionID) {
				return nil, true, PreconditionFailed("approval_required", "当前制作预算包额度已用尽，请批准本次调用或追加预算包", map[string]any{
					"reason": "mandate_exhausted",
				})
			}
			return nil, false, nil
		}
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
	if activeMandate != nil {
		items, quoted, _, _ := buildGenerationReserveItems(ctx.Domain, nodes, targets, "op:"+callKey)
		totalQuotedCNY = quoted
		reservations, updatedMandate, err = ReserveMandateBatchInTx(tx, ctx.UserID, activeMandate.ID, items, now)
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
		if err := MarkToolApprovalConsumedInTx(tx, ctx.UserID, approvedCall); err != nil {
			return nil, true, err
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

// paidSyncPermit holds an in-flight synchronous paid-op reservation (media.review
// or cloud Whisper media_transcribe) so the caller can settle on success or release on error.
type paidSyncPermit struct {
	db            *gorm.DB
	userID        string
	reservationID string
	mandateID     string
	approval      *ToolApprovalRecord
}

func (p *paidSyncPermit) Settle(taskID string) {
	if p == nil || p.db == nil {
		return
	}
	now := time.Now().UTC()
	_ = p.db.Transaction(func(tx *gorm.DB) error {
		if p.approval != nil {
			_ = MarkToolApprovalConsumedInTx(tx, p.userID, p.approval)
		}
		if p.reservationID != "" {
			if strings.TrimSpace(taskID) != "" {
				return BindMandateReservationTaskInTx(tx, p.reservationID, taskID)
			}
			return SettleReservationInTx(tx, p.reservationID, now)
		}
		return nil
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

// acquirePaidSyncPermit reserves an unquoted slot on an active ProductionMandate
// (or matches a single-call approved ToolApprovalRecord) for paid synchronous
// operations (media.review, cloud media_transcribe).
func acquirePaidSyncPermit(ctx *Context, canvasID, kind, opName string) (*paidSyncPermit, error) {
	db := ctx.DB()
	if db == nil {
		return nil, nil
	}
	sessionID := ""
	if strings.TrimSpace(ctx.TurnID) != "" {
		sessionID = lookupTurnSessionID(db, ctx.UserID, ctx.TurnID)
	}
	callID := strings.TrimSpace(ctx.OperationID)
	if callID == "" {
		callID = kind + ":" + newMandateID("call")
	}
	var permit *paidSyncPermit
	err := db.Transaction(func(tx *gorm.DB) error {
		if approved, err := LookupApprovedToolApprovalForCallInTx(tx, ctx.UserID, canvasID, ctx.TurnID, "", ctx.OperationID, opName); err != nil {
			return err
		} else if approved != nil {
			permit = &paidSyncPermit{db: db, userID: ctx.UserID, approval: approved}
			return nil
		}
		now := time.Now().UTC()
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
			CallID:   callID,
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
