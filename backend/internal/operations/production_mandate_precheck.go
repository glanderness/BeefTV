package operations

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

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

// buildGenerationReserveItems prices each target individually:
// - Fixed quotes reserve quote.Amount;
// - Variable/Reserve quotes with a positive Reserve or finite positive Amount reserve
//   that exact CNY upper bound against the mandate;
// - Truly unquoted / BYOK / zero-estimate targets consume explicit unquoted slots.
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
			switch {
			case quote.Reserve != nil && !math.IsNaN(*quote.Reserve) && !math.IsInf(*quote.Reserve, 0) && roundCNY(*quote.Reserve) > 0:
				amount = roundCNY(*quote.Reserve)
				isUnquoted = false
			case quote.Amount != nil && !math.IsNaN(*quote.Amount) && !math.IsInf(*quote.Amount, 0) && roundCNY(*quote.Amount) > 0:
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

func cloudTranscriptionModel(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var payload struct {
		Body struct {
			Model string `json:"model"`
		} `json:"body"`
		Model string `json:"model"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return ""
	}
	if m := strings.TrimSpace(payload.Body.Model); m != "" {
		return m
	}
	return strings.TrimSpace(payload.Model)
}

// isCloudTranscriptionBody inspects business_post_timeline_transcriptions body
// to distinguish paid cloud Whisper (non-empty model) from local whisper.cpp.
func isCloudTranscriptionBody(raw json.RawMessage) bool {
	return cloudTranscriptionModel(raw) != ""
}

func mediaReviewTargetDigest(canvasID, nodeID, assetID, resourceID, mode string, startMs, endMs int64) string {
	m := strings.ToLower(strings.TrimSpace(mode))
	if m == "" {
		m = "video"
	}
	return ComputeApprovalTargetDigest("media.review", canvasID, nil, map[string]any{
		"nodeId":     strings.TrimSpace(nodeID),
		"assetId":    strings.TrimSpace(assetID),
		"resourceId": strings.TrimSpace(resourceID),
		"mode":       m,
		"startMs":    startMs,
		"endMs":      endMs,
	})
}

func cloudTranscribeTargetDigest(canvasID, tool, modelName string) string {
	return ComputeApprovalTargetDigest("business.call", canvasID, nil, map[string]any{
		"tool":  strings.TrimSpace(tool),
		"model": strings.TrimSpace(modelName),
	})
}

func mediaTranscribeTargetDigest(canvasID, nodeID, assetID, resourceID, modelName string) string {
	return ComputeApprovalTargetDigest("media.transcribe", canvasID, nil, map[string]any{
		"nodeId":     strings.TrimSpace(nodeID),
		"assetId":    strings.TrimSpace(assetID),
		"resourceId": strings.TrimSpace(resourceID),
		"model":      strings.TrimSpace(modelName),
	})
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
	var targetDigest string
	var quotedCNY float64
	var unquotedCount int
	var summary string

	switch opName {
	case "canvas.generation.submit", "canvas.generation.regenerate":
		var args struct {
			CanvasID string   `json:"canvasId"`
			NodeIDs  []string `json:"nodeIds"`
		}
		_ = json.Unmarshal(req.Params, &args)
		if strings.TrimSpace(args.CanvasID) != "" {
			canvasID = strings.TrimSpace(args.CanvasID)
		}
		nodeIDs = sortedUniqueStrings(args.NodeIDs)
		targetDigest = ComputeApprovalTargetDigest(opName, canvasID, nodeIDs, nil)
		if domain != nil && canvasID != "" && len(nodeIDs) > 0 {
			rawDoc, err := domain.UserCanvasProject(userID, canvasID)
			if err != nil {
				return ToolPrecheckResult{Decision: "deny", Reason: "canvas_not_found", Message: "画布不存在或无权访问"}, nil
			}
			var doc map[string]any
			if err := json.Unmarshal(rawDoc, &doc); err != nil {
				return ToolPrecheckResult{Decision: "deny", Reason: "invalid_canvas", Message: "画布内容无法解析"}, nil
			}
			targets, err := GenerationTargets(domain, doc, nodeIDs)
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
			CanvasID   string `json:"canvasId"`
			NodeID     string `json:"nodeId"`
			AssetID    string `json:"assetId"`
			ResourceID string `json:"resourceId"`
			StartMs    int64  `json:"startMs"`
			EndMs      int64  `json:"endMs"`
			Mode       string `json:"mode"`
		}
		_ = json.Unmarshal(req.Params, &args)
		if strings.TrimSpace(args.CanvasID) != "" {
			canvasID = strings.TrimSpace(args.CanvasID)
		}
		kinds = []string{model.MandateKindMediaReview}
		unquotedCount = 1
		targetDigest = mediaReviewTargetDigest(canvasID, args.NodeID, args.AssetID, args.ResourceID, args.Mode, args.StartMs, args.EndMs)
		modeLabel := "视频"
		switch strings.ToLower(strings.TrimSpace(args.Mode)) {
		case "audio":
			modeLabel = "音频"
		case "image":
			modeLabel = "图片"
		}
		summary = "调用多模态审片模型检查" + modeLabel + "片段"

	case "media.transcribe":
		var args struct {
			CanvasID   string `json:"canvasId"`
			NodeID     string `json:"nodeId"`
			AssetID    string `json:"assetId"`
			ResourceID string `json:"resourceId"`
			Model      string `json:"model"`
		}
		_ = json.Unmarshal(req.Params, &args)
		if strings.TrimSpace(args.CanvasID) != "" {
			canvasID = strings.TrimSpace(args.CanvasID)
		}
		modelName := strings.TrimSpace(args.Model)
		if modelName == "" {
			return ToolPrecheckResult{Decision: "allow", Reason: "local_whisper_free"}, nil
		}
		kinds = []string{model.MandateKindMediaTranscribe}
		unquotedCount = 1
		targetDigest = mediaTranscribeTargetDigest(canvasID, args.NodeID, args.AssetID, args.ResourceID, modelName)
		summary = "调用云端语音转写服务"

	case "business.call":
		var args struct {
			Tool string          `json:"tool"`
			Body json.RawMessage `json:"body"`
		}
		_ = json.Unmarshal(req.Params, &args)
		modelName := cloudTranscriptionModel(args.Body)
		if strings.TrimSpace(args.Tool) != "business_post_timeline_transcriptions" || modelName == "" {
			return ToolPrecheckResult{Decision: "allow"}, nil
		}
		kinds = []string{model.MandateKindMediaTranscribe}
		unquotedCount = 1
		targetDigest = cloudTranscribeTargetDigest(canvasID, args.Tool, modelName)
		summary = "调用云端语音转写服务"

	default:
		return ToolPrecheckResult{Decision: "allow"}, nil
	}

	// Check if strict single-call owner approval already exists for this exact invocation.
	if tx != nil {
		if approved, err := LookupApprovedToolApprovalForCallInTx(tx, userID, canvasID, turnID, callID, opName, nodeIDs, targetDigest); err == nil && approved != nil {
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
		proposalID := ""
		if turnID != "" && callID != "" {
			proposalID = DeterministicApprovalProposalID(turnID, callID)
		} else {
			proposalID = newMandateID("ap")
		}
		if tx != nil {
			if existing, err := LookupToolApprovalInTx(tx, userID, proposalID); err == nil && existing != nil {
				if existing.Status == ToolApprovalStatusApproved && existing.OpName == opName && existing.TargetDigest == targetDigest {
					return ToolPrecheckResult{Decision: "allow", Reason: "single_call_approved", ProposalID: existing.ProposalID, Approval: existing}, nil
				}
				if existing.Status == ToolApprovalStatusRejected {
					rejectMsg := existing.RejectReason
					if rejectMsg == "" {
						rejectMsg = "用户已拒绝该操作"
					}
					return ToolPrecheckResult{Decision: "deny", Reason: "approval_rejected", Message: rejectMsg, ProposalID: existing.ProposalID, Approval: existing}, nil
				}
				if existing.Status == ToolApprovalStatusPending {
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
			TargetDigest:    targetDigest,
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
