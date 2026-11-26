package operations

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

const (
	assistantAutoConfirmMaxCNYKey = "assistant_auto_confirm_max_cny"
	maxAssistantAutoConfirmCapCNY = 50
	ApprovedByAutoBudget          = "auto-budget"
)

// AssistantAutoConfirmMaxCNY returns the optional per-session small-budget auto-confirm
// cap (in CNY). Zero means disabled (every paid proposal requires an explicit click).
func AssistantAutoConfirmMaxCNY(db *gorm.DB) float64 {
	if db == nil {
		return 0
	}
	var setting model.SystemSetting
	if err := db.Select("value_json").First(&setting, "key = ?", assistantAutoConfirmMaxCNYKey).Error; err != nil {
		return 0
	}
	var limit float64
	if err := json.Unmarshal([]byte(setting.ValueJSON), &limit); err != nil {
		return 0
	}
	if math.IsNaN(limit) || math.IsInf(limit, 0) || limit < 0 {
		return 0
	}
	if limit > maxAssistantAutoConfirmCapCNY {
		return maxAssistantAutoConfirmCapCNY
	}
	return roundCNY(limit)
}

// SetAssistantAutoConfirmMaxCNY persists the optional per-session small-budget cap.
func SetAssistantAutoConfirmMaxCNY(db *gorm.DB, limit float64) (float64, error) {
	if db == nil {
		return 0, errors.New("settings unavailable")
	}
	if math.IsNaN(limit) || math.IsInf(limit, 0) || limit < 0 || limit > maxAssistantAutoConfirmCapCNY {
		return 0, InvalidArg("invalid_auto_confirm_limit", fmt.Sprintf("会话免确认额度需在 0 到 %d 元之间", maxAssistantAutoConfirmCapCNY))
	}
	clean := roundCNY(limit)
	encoded, err := json.Marshal(clean)
	if err != nil {
		return 0, err
	}
	var existing model.SystemSetting
	findErr := db.Select("key").First(&existing, "key = ?", assistantAutoConfirmMaxCNYKey).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		if err := db.Create(&model.SystemSetting{Key: assistantAutoConfirmMaxCNYKey, ValueJSON: string(encoded)}).Error; err != nil {
			return 0, err
		}
		return clean, nil
	}
	if findErr != nil {
		return 0, findErr
	}
	if err := db.Model(&model.SystemSetting{}).Where("key = ?", assistantAutoConfirmMaxCNYKey).Update("value_json", string(encoded)).Error; err != nil {
		return 0, err
	}
	return clean, nil
}

// SessionAutoConfirmedSpendCNY sums previously auto-confirmed proposal estimates
// within the same durable assistant session (excluding excludeProposalID for idempotency).
func SessionAutoConfirmedSpendCNY(db *gorm.DB, userID, sessionID, excludeProposalID string) (float64, error) {
	if db == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(sessionID) == "" {
		return 0, nil
	}
	var records []model.AgentOpRecord
	if err := db.Select("result_json").
		Where("user_id = ? AND op = ? AND status = ?", userID, generationOrderOpName, "order:"+string(GenerationOrderSubmitted)).
		Find(&records).Error; err != nil {
		return 0, err
	}
	total := 0.0
	for _, rec := range records {
		var order GenerationOrder
		if json.Unmarshal([]byte(rec.ResultJSON), &order) != nil {
			continue
		}
		if order.ApprovedBy != ApprovedByAutoBudget || strings.TrimSpace(order.SessionID) != strings.TrimSpace(sessionID) {
			continue
		}
		if excludeProposalID != "" && order.ProposalID == excludeProposalID {
			continue
		}
		if order.EstimatedCNY != nil && *order.EstimatedCNY > 0 && !math.IsNaN(*order.EstimatedCNY) && !math.IsInf(*order.EstimatedCNY, 0) {
			total += *order.EstimatedCNY
		}
	}
	return roundCNY(total), nil
}

// AutoConfirmEvaluation reports the authoritative server-side check before
// automatically approving a low-cost assistant generation proposal.
type AutoConfirmEvaluation struct {
	SessionID       string
	EstimatedCNY    float64
	SessionSpentCNY float64
	LimitCNY        float64
}

// EvaluateAssistantAutoConfirm checks whether a pending assistant proposal qualifies
// for automatic confirmation under the user's configured session small-budget cap.
func EvaluateAssistantAutoConfirm(
	db *gorm.DB,
	domain Domain,
	userID, canvasID, turnID, proposalID string,
	nodeIDs []string,
	targets []GenerationTarget,
	regenerate bool,
) (*AutoConfirmEvaluation, error) {
	limit := AssistantAutoConfirmMaxCNY(db)
	if limit <= 0 {
		return nil, PreconditionFailed("auto_confirm_disabled", "当前未开启小额生成免确认", nil)
	}
	if regenerate {
		return nil, PreconditionFailed("auto_confirm_regenerate_blocked", "原地重做可能产生额外费用，需手动点击确认", nil)
	}
	sessionID := lookupTurnSessionID(db, userID, turnID)
	if sessionID == "" {
		return nil, PreconditionFailed("auto_confirm_session_required", "当前回合未绑定持久会话，请手动确认生成", nil)
	}
	raw, err := domain.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, mapDomainError(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, AsError(err)
	}
	expectedTargets, err := ResolveProposalTargetsForConfirmInTx(db, userID, canvasID, turnID, proposalID, targets)
	if err != nil {
		return nil, err
	}
	ids := nodeIDs
	if len(expectedTargets) > 0 {
		ids = make([]string, 0, len(expectedTargets))
		for _, t := range expectedTargets {
			ids = append(ids, t.NodeID)
		}
	}
	currentTargets, err := GenerationTargets(domain, doc, ids)
	if err != nil {
		return nil, err
	}
	if len(expectedTargets) > 0 && !GenerationTargetsEqual(currentTargets, expectedTargets) {
		return nil, Conflict("production_changed", "制作方案已变化，请手动确认", nil)
	}
	owned := map[string]map[string]any{}
	for _, rawNode := range canvasNodes(doc) {
		if node, ok := rawNode.(map[string]any); ok {
			if id, _ := node["id"].(string); id != "" {
				owned[id] = node
			}
		}
	}
	estimate := EstimateGenerationCost(domain, estimateGenerationTargets(owned, currentTargets))
	amount, isVariable, fixedOK := hasFixedEstimate(estimate)
	if !fixedOK {
		return nil, PreconditionFailed("auto_confirm_price_unknown", "部分模型暂无固定报价，需手动确认生成", map[string]any{
			"unknownCount": estimate.Summary.Unknown,
			"variable":     isVariable,
		})
	}
	spent, err := SessionAutoConfirmedSpendCNY(db, userID, sessionID, proposalID)
	if err != nil {
		return nil, AsError(err)
	}
	if roundCNY(spent+amount) > limit {
		return nil, PreconditionFailed(
			"auto_confirm_budget_exceeded",
			fmt.Sprintf("本会话已自动确认 ¥%.2f，本次预估 ¥%.2f，超出 ¥%.2f 免确认额度，请手动确认", spent, amount, limit),
			map[string]any{
				"estimatedCny":    amount,
				"sessionSpentCny": spent,
				"limitCny":        limit,
			},
		)
	}
	return &AutoConfirmEvaluation{
		SessionID:       sessionID,
		EstimatedCNY:    amount,
		SessionSpentCNY: spent,
		LimitCNY:        limit,
	}, nil
}

// AttachAutoConfirmResult decorates an admitted production response with server-computed
// auto-confirm budget accounting so receipts and UI share one authoritative source.
func AttachAutoConfirmResult(result any, eval *AutoConfirmEvaluation) {
	if eval == nil {
		return
	}
	if resultMap, ok := result.(map[string]any); ok {
		resultMap["autoConfirmed"] = true
		resultMap["sessionId"] = eval.SessionID
		resultMap["estimatedCny"] = eval.EstimatedCNY
		resultMap["sessionSpentCny"] = roundCNY(eval.SessionSpentCNY + eval.EstimatedCNY)
		resultMap["limitCny"] = eval.LimitCNY
	}
}
