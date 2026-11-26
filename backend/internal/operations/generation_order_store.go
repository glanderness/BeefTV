package operations

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

const generationOrderOpName = "canvas.generation.order"

func generationOrderOpID(proposalID string) string {
	return "generation-order:" + strings.TrimSpace(proposalID)
}

func UpsertGenerationOrderInTx(tx *gorm.DB, userID string, order GenerationOrder) error {
	proposalID := strings.TrimSpace(order.ProposalID)
	if proposalID == "" {
		proposalID = strings.TrimSpace(order.OrderID)
	}
	if proposalID == "" {
		return nil
	}
	order.ProposalID = proposalID
	if strings.TrimSpace(order.OrderID) == "" {
		order.OrderID = proposalID
	}
	encoded, err := json.Marshal(order)
	if err != nil {
		return err
	}
	opID := generationOrderOpID(proposalID)
	status := "order:" + string(order.Status)
	turnID := strings.TrimSpace(order.SourceTurnID)
	var existing model.AgentOpRecord
	findErr := tx.Where("user_id = ? AND op_id = ?", userID, opID).First(&existing).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		return tx.Create(&model.AgentOpRecord{
			OpID:        opID,
			UserID:      userID,
			Op:          generationOrderOpName,
			PayloadHash: strings.TrimSpace(order.CanvasID),
			Status:      status,
			ResultJSON:  string(encoded),
			TurnID:      turnID,
		}).Error
	}
	if findErr != nil {
		return findErr
	}
	return tx.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, opID).Updates(map[string]any{
		"payload_hash": strings.TrimSpace(order.CanvasID),
		"status":       status,
		"result_json":  string(encoded),
		"turn_id":      turnID,
	}).Error
}

func LookupGenerationOrderInTx(tx *gorm.DB, userID, proposalID string) (*GenerationOrder, error) {
	proposalID = strings.TrimSpace(proposalID)
	if proposalID == "" {
		return nil, nil
	}
	var record model.AgentOpRecord
	err := tx.Where("user_id = ? AND op_id = ?", userID, generationOrderOpID(proposalID)).First(&record).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var order GenerationOrder
	if err := json.Unmarshal([]byte(record.ResultJSON), &order); err != nil {
		return nil, err
	}
	return &order, nil
}

type GenerationOrderQuery struct {
	CanvasID string
	Status   string
	Page     int
	PageSize int
}

type GenerationOrderPage struct {
	Orders   []GenerationOrder `json:"orders"`
	Page     int               `json:"page"`
	PageSize int               `json:"pageSize"`
	Total    int64             `json:"total"`
}

func generationOrdersQuery(db *gorm.DB, userID string, filter GenerationOrderQuery) *gorm.DB {
	query := db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op = ?", userID, generationOrderOpName)
	if trimmed := strings.TrimSpace(filter.CanvasID); trimmed != "" {
		query = query.Where("payload_hash = ?", trimmed)
	}
	if status := strings.TrimSpace(filter.Status); status != "" {
		query = query.Where("status = ?", "order:"+status)
	}
	return query
}

// listGenerationOrdersPageInDB 是生成单列表的唯一查询实现：按画布、状态过滤后分页。
func listGenerationOrdersPageInDB(db *gorm.DB, userID string, filter GenerationOrderQuery) (GenerationOrderPage, error) {
	page, pageSize := filter.Page, filter.PageSize
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	var total int64
	if err := generationOrdersQuery(db, userID, filter).Count(&total).Error; err != nil {
		return GenerationOrderPage{}, err
	}
	var records []model.AgentOpRecord
	// created_at 相同时用 op_id 做稳定次排序，避免翻页重复或漏行。
	if err := generationOrdersQuery(db, userID, filter).Order("created_at DESC").Order("op_id DESC").
		Offset((page - 1) * pageSize).Limit(pageSize).Find(&records).Error; err != nil {
		return GenerationOrderPage{}, err
	}
	orders := make([]GenerationOrder, 0, len(records))
	for _, rec := range records {
		var order GenerationOrder
		if err := json.Unmarshal([]byte(rec.ResultJSON), &order); err != nil {
			// 损坏的历史记录无法投影成生成单；跳过它，total 仍按原始记录计数。
			continue
		}
		orders = append(orders, order)
	}
	return GenerationOrderPage{Orders: orders, Page: page, PageSize: pageSize, Total: total}, nil
}

// ListGenerationOrdersPage 是操作层读取生成单的入口，和撤销、外部改动共用同一个操作记录存储。
func (s *Store) ListGenerationOrdersPage(userID string, filter GenerationOrderQuery) (GenerationOrderPage, error) {
	if !s.Available() {
		return GenerationOrderPage{}, newError(CodeInternal, "op_store_unavailable", "操作记录存储不可用", nil)
	}
	return listGenerationOrdersPageInDB(s.db, userID, filter)
}

func ListGenerationOrdersInDB(db *gorm.DB, userID, canvasID string) ([]GenerationOrder, error) {
	page, err := listGenerationOrdersPageInDB(db, userID, GenerationOrderQuery{CanvasID: canvasID, PageSize: 100})
	if err != nil {
		return nil, err
	}
	return page.Orders, nil
}

func MarkGenerationOrderSubmittedInTx(
	tx *gorm.DB,
	domain Domain,
	userID, canvasID, turnID, proposalID, kind string,
	nodeIDs []string,
	targets []GenerationTarget,
	admitResult any,
	continuationID, approvedBy string,
	regenerate bool,
) error {
	if strings.TrimSpace(proposalID) == "" {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	existing, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return err
	}
	var taskIDs []string
	if resultMap, ok := admitResult.(map[string]any); ok {
		if ids, ok := resultMap["taskIds"].([]string); ok {
			taskIDs = ids
		}
	}
	var order GenerationOrder
	if existing != nil {
		order = *existing
		order.Status = GenerationOrderSubmitted
		order.ApprovedBy = approvedBy
		order.ApprovedAt = now
		order.TaskIDs = taskIDs
		order.ContinuationID = continuationID
		if strings.TrimSpace(order.SourceTurnID) == "" {
			order.SourceTurnID = turnID
		}
		if resultMap, ok := admitResult.(map[string]any); ok {
			if sid, _ := resultMap["sessionId"].(string); strings.TrimSpace(sid) != "" {
				order.SessionID = strings.TrimSpace(sid)
			}
			if est, ok := resultMap["estimatedCny"].(float64); ok && est >= 0 {
				cp := roundCNY(est)
				order.EstimatedCNY = &cp
			}
		}
		if len(targets) > 0 {
			order.Targets = targets
		}
		order.UpdatedAt = now
	} else {
		modelDisplay := ""
		modelKey := ""
		if len(targets) > 0 {
			modelKey = targets[0].ModelKey
			modelDisplay = modelKey
			if i := strings.LastIndex(modelDisplay, "::"); i >= 0 {
				modelDisplay = modelDisplay[i+2:]
			}
			if choice, resolveErr := domain.ResolveAssistantGenerationModel(targets[0].Kind, modelKey); resolveErr == nil && choice.Display != "" {
				modelDisplay = choice.Display
			}
		}
		order = GenerationOrder{
			OrderID:        proposalID,
			ProposalID:     proposalID,
			CanvasID:       canvasID,
			CallerKind:     CallerAssistant,
			CallerClient:   "assistant-host",
			ApprovalMode:   ApprovalModeAsk,
			Status:         GenerationOrderSubmitted,
			ApprovedBy:     approvedBy,
			ApprovedAt:     now,
			Kind:           kind,
			Model:          modelDisplay,
			ModelKey:       modelKey,
			Pricing:        ResolveModelPricing(domain, modelKey),
			NodeIDs:        nodeIDs,
			Targets:        targets,
			TargetViews:    BuildGenerationOrderTargetViews(domain, targets),
			SourceTurnID:   turnID,
			Regenerate:     regenerate,
			TaskIDs:        taskIDs,
			ContinuationID: continuationID,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		if resultMap, ok := admitResult.(map[string]any); ok {
			if sid, _ := resultMap["sessionId"].(string); strings.TrimSpace(sid) != "" {
				order.SessionID = strings.TrimSpace(sid)
			}
			if est, ok := resultMap["estimatedCny"].(float64); ok && est >= 0 {
				cp := roundCNY(est)
				order.EstimatedCNY = &cp
			}
		}
	}
	if err := UpsertGenerationOrderInTx(tx, userID, order); err != nil {
		return err
	}
	if resultMap, ok := admitResult.(map[string]any); ok {
		resultMap["orderId"] = order.OrderID
		resultMap["proposalId"] = order.ProposalID
		resultMap["order"] = order
	}
	return nil
}

func SubmittedOrderResponse(order *GenerationOrder) map[string]any {
	return map[string]any{
		"canvasId":       order.CanvasID,
		"orderId":        order.OrderID,
		"proposalId":     order.ProposalID,
		"status":         string(order.Status),
		"taskIds":        order.TaskIDs,
		"nodeIds":        order.NodeIDs,
		"continuationId": order.ContinuationID,
		"order":          order,
	}
}

func LookupOrderForApprovalInDB(db *gorm.DB, userID, proposalID string) (*GenerationOrder, error) {
	if strings.TrimSpace(proposalID) == "" {
		return nil, InvalidArg("missing_proposal_id", "proposalId 必填")
	}
	existing, err := LookupGenerationOrderInTx(db, userID, proposalID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, NotFound("generation_order_not_found", "生成单不存在: "+proposalID)
	}
	return existing, nil
}

func ApproveExternalGenerationOrderInTx(tx *gorm.DB, domain Domain, userID, proposalID, approvedBy string) (any, error) {
	order, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, NotFound("generation_order_not_found", "生成单不存在: "+proposalID)
	}
	if order.Status == GenerationOrderSubmitted {
		return SubmittedOrderResponse(order), nil
	}
	raw, err := domain.UserCanvasProject(userID, order.CanvasID)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if order.CanvasRevision > 0 && canvasRevision(doc) != order.CanvasRevision {
		expected := order.CanvasRevision
		opErr := Conflict("revision_conflict", "画布已变化，请重新生成提议后再批准", nil)
		EnrichCanvasConflictErrorInTx(tx, domain, userID, order.CanvasID, &expected, raw, opErr)
		return nil, opErr
	}
	batchTargets, err := GenerationTargets(domain, doc, order.NodeIDs)
	if err != nil {
		return nil, err
	}
	for _, target := range batchTargets {
		choice, resolveErr := domain.ResolveAssistantGenerationModel(target.Kind, target.ModelKey)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if order.ModelConfigRevision > 0 && choice.Revision != order.ModelConfigRevision {
			return nil, Conflict("generation_config_changed", "模型配置已变化，请重新生成提议后再批准", nil)
		}
	}
	if len(order.Targets) > 0 && !generationTargetsContainBatch(order.Targets, batchTargets) {
		return nil, Conflict("production_changed", "制作方案已变化，请重新确认", nil)
	}
	port, ok := domain.(ExternalGenerationAdmission)
	if !ok {
		return nil, Unsupported("generation_unavailable", "当前工作区不能提交生成")
	}
	admitted, err := port.SubmitExternalGeneration(userID, "approve:"+order.ProposalID, order.CanvasID, batchTargets, order.Regenerate)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	order.Status = GenerationOrderSubmitted
	order.ApprovedBy = approvedBy
	order.ApprovedAt = now
	order.UpdatedAt = now
	if resultMap, ok := admitted.(map[string]any); ok {
		if ids, ok := resultMap["taskIds"].([]string); ok {
			order.TaskIDs = ids
		}
		resultMap["orderId"] = order.OrderID
		resultMap["proposalId"] = order.ProposalID
		resultMap["order"] = order
	}
	if err := UpsertGenerationOrderInTx(tx, userID, *order); err != nil {
		return nil, err
	}
	return admitted, nil
}

// LookupTurnSubmittedOrderInTx returns the canonical owner-confirmed GenerationOrder owned by turnID.
// For pre-upgrade databases where AgentOpRecord.TurnID was empty, it falls back to matching
// submitted canvas orders by SourceTurnID in ResultJSON.
func LookupTurnSubmittedOrderInTx(tx *gorm.DB, userID, canvasID, turnID string) (*GenerationOrder, error) {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return nil, nil
	}
	var directRows []model.AgentOpRecord
	if err := tx.Where("user_id = ? AND op = ? AND payload_hash = ? AND status = ? AND turn_id = ?",
		userID, generationOrderOpName, strings.TrimSpace(canvasID), "order:"+string(GenerationOrderSubmitted), turnID).
		Order("created_at DESC").Find(&directRows).Error; err != nil {
		return nil, err
	}
	for _, rec := range directRows {
		var order GenerationOrder
		if json.Unmarshal([]byte(rec.ResultJSON), &order) == nil && order.IsOwnerConfirmed() {
			return &order, nil
		}
	}
	var legacyRows []model.AgentOpRecord
	if err := tx.Where("user_id = ? AND op = ? AND payload_hash = ? AND status = ? AND turn_id = ''",
		userID, generationOrderOpName, strings.TrimSpace(canvasID), "order:"+string(GenerationOrderSubmitted)).
		Order("created_at DESC").Find(&legacyRows).Error; err != nil {
		return nil, err
	}
	for _, rec := range legacyRows {
		var order GenerationOrder
		if json.Unmarshal([]byte(rec.ResultJSON), &order) == nil && order.SourceTurnID == turnID && order.IsOwnerConfirmed() {
			return &order, nil
		}
	}
	return nil, nil
}

// ResolveProposalTargetsForConfirmInTx resolves the authoritative targets for confirming
// (turnID, proposalID). When a canonical GenerationOrder exists for proposalID, inline client
// targets cannot diverge from it and proposals from another turn are rejected.
func ResolveProposalTargetsForConfirmInTx(
	tx *gorm.DB,
	userID, canvasID, turnID, proposalID string,
	inlineTargets []GenerationTarget,
) ([]GenerationTarget, error) {
	order, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return nil, err
	}
	if order != nil {
		if order.CanvasID != "" && order.CanvasID != canvasID {
			return nil, Conflict("production_changed", "制作方案不属于当前画布，请重新确认", nil)
		}
		if order.SourceTurnID != "" && order.SourceTurnID != turnID {
			return nil, Conflict("production_changed", "这一轮已确认了不同的制作方案", nil)
		}
		if len(order.Targets) > 0 {
			if len(inlineTargets) > 0 && !GenerationTargetsEqual(inlineTargets, order.Targets) {
				return nil, Conflict("production_changed", "制作方案已变化，请重新确认", nil)
			}
			return order.Targets, nil
		}
	}
	return inlineTargets, nil
}

// ValidateTurnOrderConflictInTx rejects confirming a second distinct plan on a turn that has
// already submitted an owner-confirmed GenerationOrder.
func ValidateTurnOrderConflictInTx(tx *gorm.DB, userID, canvasID, turnID string, plan GenerationAuthorization) error {
	submitted, err := LookupTurnSubmittedOrderInTx(tx, userID, canvasID, turnID)
	if err != nil {
		return err
	}
	if submitted != nil {
		existing := GenerationAuthorization{SourceTurnID: turnID, ProposalID: submitted.ProposalID, Targets: submitted.Targets, Regenerate: submitted.Regenerate}
		if !existing.SamePlan(plan) {
			return Conflict("production_changed", "这一轮已确认了不同的制作方案", nil)
		}
	}
	return nil
}

// ResolveProposalRegenerateInTx returns the authoritative regenerate flag for
// confirming a proposal: if a canonical GenerationOrder exists, its recorded
// Regenerate flag wins (a caller cannot upgrade a non-regenerate order).
func ResolveProposalRegenerateInTx(tx *gorm.DB, userID, proposalID string, requested bool) (bool, error) {
	order, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return false, err
	}
	if order != nil {
		return order.Regenerate, nil
	}
	return requested, nil
}

// LookupConfirmedOrderPlanInTx resolves a specific owner-confirmed (sourceTurnID, proposalID)
// plan from the canonical GenerationOrder store.
func LookupConfirmedOrderPlanInTx(tx *gorm.DB, userID, canvasID, sourceTurnID, proposalID string) (*GenerationAuthorization, error) {
	if strings.TrimSpace(proposalID) == "" {
		return nil, nil
	}
	order, err := LookupGenerationOrderInTx(tx, userID, proposalID)
	if err != nil {
		return nil, err
	}
	if order != nil && order.IsOwnerConfirmed() && order.CanvasID == canvasID && order.SourceTurnID == sourceTurnID {
		return &GenerationAuthorization{
			SourceTurnID: order.SourceTurnID,
			ProposalID:   order.ProposalID,
			Targets:      order.Targets,
			Regenerate:   order.Regenerate,
		}, nil
	}
	return nil, nil
}

// ResolveAuthorizedOrderForTurnInTx resolves the owner-confirmed production authorization
// governing turnID: either an owner-confirmed GenerationOrder created on turnID itself, or
// the exact 1-hop continuation receipt bound to turnID (never walking up to ancestor plans).
func ResolveAuthorizedOrderForTurnInTx(tx *gorm.DB, userID, canvasID, turnID string) (*GenerationAuthorization, error) {
	if own, err := LookupTurnSubmittedOrderInTx(tx, userID, canvasID, turnID); err != nil {
		return nil, err
	} else if own != nil {
		return &GenerationAuthorization{SourceTurnID: own.SourceTurnID, ProposalID: own.ProposalID, Targets: own.Targets, Regenerate: own.Regenerate}, nil
	}
	var cont model.AssistantContinuation
	err := tx.Where("user_id = ? AND canvas_id = ? AND turn_id = ?", userID, canvasID, strings.TrimSpace(turnID)).First(&cont).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cont.State == "cancelled" {
		return nil, nil
	}
	return LookupConfirmedOrderPlanInTx(tx, userID, canvasID, cont.SourceTurnID, cont.ProposalID)
}

func ProductionTargetHash(target GenerationTarget) string {
	encoded, _ := json.Marshal(NormalizeGenerationTarget(target))
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func productionTargetHashMatches(recorded any, target GenerationTarget) bool {
	got, ok := recorded.(string)
	if !ok || got == "" {
		return false
	}
	canonical := NormalizeGenerationTarget(target)
	if got == ProductionTargetHash(canonical) {
		return true
	}
	if len(canonical.ReferenceNodeIDs) == 0 {
		legacy := canonical
		legacy.ReferenceNodeIDs = nil
		encoded, _ := json.Marshal(legacy)
		if got == fmt.Sprintf("%x", sha256.Sum256(encoded)) {
			return true
		}
	}
	return false
}

func ValidateProductionTask(task *model.Task, canvasID string, target GenerationTarget) error {
	var original struct {
		Metadata map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &original); err != nil {
		return err
	}
	if task.ProjectID != canvasID || task.Type != "canvas_"+target.Kind || task.Prompt != target.Prompt || !productionTargetHashMatches(original.Metadata["assistantProductionTargetHash"], target) {
		return Conflict("production_task_changed", "原制作任务与确认记录不一致，请先检查原任务", nil)
	}
	return nil
}
