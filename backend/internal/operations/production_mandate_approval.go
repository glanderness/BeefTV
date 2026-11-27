package operations

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
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
	ToolApprovalStatusClosed   = "closed"

	defaultApprovalTTL = 24 * time.Hour
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
	TargetDigest    string         `json:"targetDigest,omitempty"`
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

func sortedUniqueStrings(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(items))
	out := make([]string, 0, len(items))
	for _, raw := range items {
		v := strings.TrimSpace(raw)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// ComputeApprovalTargetDigest builds a deterministic SHA-256 digest binding an
// approval strictly to (opName, canvasID, sorted nodeIDs, normalized params).
func ComputeApprovalTargetDigest(opName, canvasID string, nodeIDs []string, normalizedParams map[string]any) string {
	payload := map[string]any{
		"op":      strings.TrimSpace(opName),
		"canvas":  strings.TrimSpace(canvasID),
		"nodeIds": sortedUniqueStrings(nodeIDs),
	}
	if len(normalizedParams) > 0 {
		payload["params"] = normalizedParams
	}
	encoded, _ := json.Marshal(payload)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:16])
}

func sortedNodeIDsMatch(a, b []string) bool {
	sa := sortedUniqueStrings(a)
	sb := sortedUniqueStrings(b)
	if len(sa) != len(sb) {
		return false
	}
	for i := range sa {
		if sa[i] != sb[i] {
			return false
		}
	}
	return true
}

func approvalIsExpired(rec *ToolApprovalRecord, now time.Time) bool {
	if rec == nil || strings.TrimSpace(rec.CreatedAt) == "" {
		return false
	}
	created, err := time.Parse(time.RFC3339, strings.TrimSpace(rec.CreatedAt))
	if err != nil {
		return false
	}
	return now.Sub(created) > defaultApprovalTTL
}

// isApprovalTurnLiveInTx returns true when turnID is empty (non-turn-scoped) or
// the owning AssistantTurn row is still open, not undone, and not invalidated.
func isApprovalTurnLiveInTx(tx *gorm.DB, userID, turnID string) bool {
	turnID = strings.TrimSpace(turnID)
	if tx == nil || turnID == "" {
		return true
	}
	var turn model.AssistantTurn
	err := tx.Select("turn_id, user_id, state, undone, continuation_invalidated").
		Where("turn_id = ? AND user_id = ?", turnID, strings.TrimSpace(userID)).
		First(&turn).Error
	if err != nil {
		return false
	}
	return strings.TrimSpace(turn.State) == "open" && !turn.Undone && !turn.ContinuationInvalidated
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
	rec.NodeIDs = sortedUniqueStrings(rec.NodeIDs)
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

// ClosePendingApprovalsForCanvasSessionInTx closes lingering pending approvals
// on a canvas (optionally scoped to sessionID) when the user explicitly cancels a turn.
func ClosePendingApprovalsForCanvasSessionInTx(tx *gorm.DB, userID, canvasID, sessionID string) error {
	canvasID = strings.TrimSpace(canvasID)
	if tx == nil || strings.TrimSpace(userID) == "" || canvasID == "" {
		return nil
	}
	var rows []model.AgentOpRecord
	if err := tx.Where("user_id = ? AND op = ? AND payload_hash = ? AND status = ?",
		strings.TrimSpace(userID), toolApprovalOpName, canvasID, "approval:"+ToolApprovalStatusPending).
		Find(&rows).Error; err != nil {
		return AsError(err)
	}
	sessionID = strings.TrimSpace(sessionID)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, row := range rows {
		var rec ToolApprovalRecord
		if json.Unmarshal([]byte(row.ResultJSON), &rec) != nil {
			continue
		}
		if sessionID != "" && strings.TrimSpace(rec.SessionID) != "" && strings.TrimSpace(rec.SessionID) != sessionID {
			continue
		}
		rec.Status = ToolApprovalStatusClosed
		rec.UpdatedAt = now
		encoded, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		if err := tx.Model(&model.AgentOpRecord{}).
			Where("user_id = ? AND op_id = ? AND status = ?", row.UserID, row.OpID, "approval:"+ToolApprovalStatusPending).
			Updates(map[string]any{
				"status":      "approval:" + ToolApprovalStatusClosed,
				"result_json": string(encoded),
			}).Error; err != nil {
			return AsError(err)
		}
	}
	return nil
}

// ListPendingToolApprovalsInTx returns only live pending approvals whose owning
// AssistantTurn is still open (not settled, undone, or invalidated) and within TTL.
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
	now := time.Now().UTC()
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
		if approvalIsExpired(&rec, now) || !isApprovalTurnLiveInTx(tx, userID, rec.TurnID) {
			continue
		}
		out = append(out, rec)
	}
	return out, nil
}

// LookupApprovedToolApprovalForCallInTx performs strict single-call approval
// binding: never accepts an untrusted model-supplied proposalID to hijack another
// call, always enforces OpName, CanvasID, CallID (when non-empty), sorted NodeIDs,
// and TargetDigest equality.
func LookupApprovedToolApprovalForCallInTx(
	tx *gorm.DB,
	userID, canvasID, turnID, callID, opName string,
	nodeIDs []string,
	targetDigest string,
) (*ToolApprovalRecord, error) {
	if tx == nil {
		return nil, nil
	}
	canvasID = strings.TrimSpace(canvasID)
	turnID = strings.TrimSpace(turnID)
	callID = strings.TrimSpace(callID)
	opName = strings.TrimSpace(opName)
	targetDigest = strings.TrimSpace(targetDigest)
	if opName == "" {
		return nil, nil
	}
	matchesRecord := func(rec *ToolApprovalRecord) bool {
		if rec == nil || rec.Status != ToolApprovalStatusApproved {
			return false
		}
		if strings.TrimSpace(rec.CanvasID) != canvasID {
			return false
		}
		if strings.TrimSpace(rec.OpName) != opName {
			return false
		}
		if turnID != "" && strings.TrimSpace(rec.TurnID) != turnID {
			return false
		}
		if callID != "" && strings.TrimSpace(rec.CallID) != callID {
			return false
		}
		if len(nodeIDs) > 0 || len(rec.NodeIDs) > 0 {
			if !sortedNodeIDsMatch(rec.NodeIDs, nodeIDs) {
				return false
			}
		}
		if targetDigest != "" && strings.TrimSpace(rec.TargetDigest) != "" && strings.TrimSpace(rec.TargetDigest) != targetDigest {
			return false
		}
		return true
	}

	if turnID != "" && callID != "" {
		rec, err := LookupToolApprovalInTx(tx, userID, DeterministicApprovalProposalID(turnID, callID))
		if err != nil {
			return nil, err
		}
		if matchesRecord(rec) {
			return rec, nil
		}
		return nil, nil
	}
	if turnID == "" {
		return nil, nil
	}
	var rows []model.AgentOpRecord
	if err := tx.Where("user_id = ? AND op = ? AND payload_hash = ? AND turn_id = ? AND status = ?",
		userID, toolApprovalOpName, canvasID, turnID, "approval:"+ToolApprovalStatusApproved).
		Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, AsError(err)
	}
	for _, row := range rows {
		var rec ToolApprovalRecord
		if json.Unmarshal([]byte(row.ResultJSON), &rec) != nil {
			continue
		}
		if matchesRecord(&rec) {
			return &rec, nil
		}
	}
	return nil, nil
}

// ConsumeToolApprovalAtomicInTx transitions an approved record to consumed via a
// conditional UPDATE verifying status='approval:approved' and RowsAffected==1 so
// concurrent or retried calls can never double-spend a single-call approval.
func ConsumeToolApprovalAtomicInTx(tx *gorm.DB, userID string, rec *ToolApprovalRecord) error {
	if tx == nil || rec == nil {
		return nil
	}
	updated := *rec
	updated.Status = ToolApprovalStatusConsumed
	updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	encoded, err := json.Marshal(updated)
	if err != nil {
		return AsError(err)
	}
	res := tx.Model(&model.AgentOpRecord{}).
		Where("user_id = ? AND op_id = ? AND status = ?", userID, toolApprovalOpID(rec.ProposalID), "approval:"+ToolApprovalStatusApproved).
		Updates(map[string]any{
			"status":      "approval:" + ToolApprovalStatusConsumed,
			"result_json": string(encoded),
		})
	if res.Error != nil {
		return AsError(res.Error)
	}
	if res.RowsAffected != 1 {
		return Conflict("approval_already_consumed", "该次审批已被使用或已失效，请重新确认", nil)
	}
	rec.Status = ToolApprovalStatusConsumed
	return nil
}

// checkMandateInputCoversApproval verifies that a newly created mandate requested
// alongside approval actually covers the triggering call's kinds, estimated cost,
// and unquoted count so Shot 1 cannot bypass or exceed the new mandate ceiling.
func checkMandateInputCoversApproval(in CreateProductionMandateInput, rec *ToolApprovalRecord) error {
	if rec == nil {
		return nil
	}
	allowed, err := normalizeMandateKinds(in.AllowedKinds)
	if err != nil {
		return err
	}
	allowedSet := make(map[string]bool, len(allowed))
	for _, k := range allowed {
		allowedSet[k] = true
	}
	for _, k := range rec.Kinds {
		if !allowedSet[strings.ToLower(strings.TrimSpace(k))] {
			return InvalidArg("mandate_kind_not_allowed", "新建预算包未包含当前操作所需类型: "+k)
		}
	}
	if rec.EstimatedCNY != nil && roundCNY(*rec.EstimatedCNY) > roundCNY(in.MaxAmountCNY) {
		return InvalidArg("mandate_insufficient_for_call", fmt.Sprintf("新建预算包上限 ¥%.2f 低于本次预估 ¥%.2f", in.MaxAmountCNY, *rec.EstimatedCNY))
	}
	if rec.UnquotedCount > 0 && in.MaxUnquotedCount < rec.UnquotedCount {
		return InvalidArg("mandate_unquoted_not_allowed", fmt.Sprintf("新建预算包未报价次数上限 %d 低于本次所需 %d 次", in.MaxUnquotedCount, rec.UnquotedCount))
	}
	return nil
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
	now := time.Now().UTC()
	if rec.Status == ToolApprovalStatusClosed || rec.Status == ToolApprovalStatusConsumed {
		return nil, nil, Conflict("approval_stale", "该审批记录已结束或已失效，请让助手重新发起", nil)
	}
	if approvalIsExpired(rec, now) || !isApprovalTurnLiveInTx(tx, userID, rec.TurnID) {
		rec.Status = ToolApprovalStatusClosed
		_ = UpsertToolApprovalInTx(tx, userID, *rec)
		return nil, nil, Conflict("approval_stale", "该审批所属回合已结束、已撤销或已过期，请让助手重新发起", nil)
	}
	var createdMandate *model.AssistantProductionMandate
	if decision == "approve" && createMandate != nil {
		in := *createMandate
		if strings.TrimSpace(in.CanvasID) == "" {
			in.CanvasID = rec.CanvasID
		} else if strings.TrimSpace(rec.CanvasID) != "" && strings.TrimSpace(in.CanvasID) != strings.TrimSpace(rec.CanvasID) {
			return nil, nil, InvalidArg("canvas_mismatch", "预算包画布与待审批操作所属画布不一致")
		}
		if strings.TrimSpace(in.SessionID) == "" {
			in.SessionID = rec.SessionID
		}
		in.ApprovedBy = approvedBy
		if err := checkMandateInputCoversApproval(in, rec); err != nil {
			return nil, nil, err
		}
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
