package operations

import (
	"crypto/rand"
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
	defaultMandateTTLMinutes = 180
	maxMandateTTLMinutes     = 24 * 60
	maxMandateAmountCNY      = 10000
	maxMandateUnquotedCount  = 500
)

var validMandateKinds = map[string]bool{
	model.MandateKindImage:           true,
	model.MandateKindVideo:           true,
	model.MandateKindAudio:           true,
	model.MandateKindMediaReview:     true,
	model.MandateKindMediaTranscribe: true,
}

func defaultMandateKinds() []string {
	return []string{
		model.MandateKindImage,
		model.MandateKindVideo,
		model.MandateKindAudio,
		model.MandateKindMediaReview,
		model.MandateKindMediaTranscribe,
	}
}

// ProductionMandateView is the API-facing projection of an AssistantProductionMandate.
type ProductionMandateView struct {
	ID                string   `json:"id"`
	UserID            string   `json:"userId"`
	CanvasID          string   `json:"canvasId"`
	SessionID         string   `json:"sessionId,omitempty"`
	MaxAmountCNY      float64  `json:"maxAmountCny"`
	SpentAmountCNY    float64  `json:"spentAmountCny"`
	ReservedAmountCNY float64  `json:"reservedAmountCny"`
	RemainingCNY      float64  `json:"remainingCny"`
	MaxUnquotedCount  int      `json:"maxUnquotedCount"`
	UsedUnquotedCount int      `json:"usedUnquotedCount"`
	RemainingUnquoted int      `json:"remainingUnquoted"`
	AllowedKinds      []string `json:"allowedKinds"`
	Status            string   `json:"status"`
	Version           int64    `json:"version"`
	ApprovedBy        string   `json:"approvedBy"`
	ExpiresAt         string   `json:"expiresAt,omitempty"`
	CreatedAt         string   `json:"createdAt"`
	UpdatedAt         string   `json:"updatedAt"`
}

// CreateProductionMandateInput defines owner-submitted bounds for a production mandate.
type CreateProductionMandateInput struct {
	CanvasID         string     `json:"canvasId"`
	SessionID        string     `json:"sessionId,omitempty"`
	MaxAmountCNY     float64    `json:"maxAmountCny"`
	MaxUnquotedCount int        `json:"maxUnquotedCount"`
	AllowedKinds     []string   `json:"allowedKinds,omitempty"`
	ExpiresInMinutes int        `json:"expiresInMinutes,omitempty"`
	ExpiresAt        *time.Time `json:"-"`
	ApprovedBy       string     `json:"-"`
}

// MandateReserveItem describes one paid unit to reserve inside a caller transaction.
type MandateReserveItem struct {
	CallID    string
	TaskID    string
	Kind      string
	AmountCNY float64
	Unquoted  bool
}

func newMandateID(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(buf)
}

func normalizeMandateKinds(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return defaultMandateKinds(), nil
	}
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		kind := strings.ToLower(strings.TrimSpace(item))
		if !validMandateKinds[kind] {
			return nil, InvalidArg("invalid_mandate_kind", "不支持的预算包类型: "+item)
		}
		if !seen[kind] {
			seen[kind] = true
			out = append(out, kind)
		}
	}
	return out, nil
}

func parseMandateAllowedKinds(raw string) []string {
	var kinds []string
	if err := json.Unmarshal([]byte(raw), &kinds); err != nil || len(kinds) == 0 {
		return defaultMandateKinds()
	}
	out := make([]string, 0, len(kinds))
	for _, k := range kinds {
		k = strings.ToLower(strings.TrimSpace(k))
		if validMandateKinds[k] {
			out = append(out, k)
		}
	}
	if len(out) == 0 {
		return defaultMandateKinds()
	}
	return out
}

func mandateAllowsKind(m *model.AssistantProductionMandate, kind string) bool {
	if m == nil {
		return false
	}
	target := strings.ToLower(strings.TrimSpace(kind))
	for _, allowed := range parseMandateAllowedKinds(m.AllowedKindsJSON) {
		if allowed == target {
			return true
		}
	}
	return false
}

func mandateRemainingCNY(m *model.AssistantProductionMandate) float64 {
	if m == nil {
		return 0
	}
	rem := roundCNY(m.MaxAmountCNY - m.SpentAmountCNY - m.ReservedAmountCNY)
	if rem < 0 {
		return 0
	}
	return rem
}

func mandateRemainingUnquoted(m *model.AssistantProductionMandate) int {
	if m == nil {
		return 0
	}
	rem := m.MaxUnquotedCount - m.UsedUnquotedCount
	if rem < 0 {
		return 0
	}
	return rem
}

func mandateIsExpired(m *model.AssistantProductionMandate, now time.Time) bool {
	return m != nil && m.ExpiresAt != nil && now.After(*m.ExpiresAt)
}

func nextMandateCapacityStatus(m *model.AssistantProductionMandate, now time.Time) string {
	if m.Status == model.MandateStatusRevoked {
		return model.MandateStatusRevoked
	}
	if mandateIsExpired(m, now) {
		return model.MandateStatusExpired
	}
	hasCNYBudget := m.MaxAmountCNY > 0 && mandateRemainingCNY(m) > 0
	hasUnquotedBudget := m.MaxUnquotedCount > 0 && mandateRemainingUnquoted(m) > 0
	if !hasCNYBudget && !hasUnquotedBudget {
		return model.MandateStatusExhausted
	}
	return model.MandateStatusActive
}

// ProjectProductionMandate builds the API view of a mandate row.
func ProjectProductionMandate(m model.AssistantProductionMandate) ProductionMandateView {
	view := ProductionMandateView{
		ID:                m.ID,
		UserID:            m.UserID,
		CanvasID:          m.CanvasID,
		SessionID:         m.SessionID,
		MaxAmountCNY:      roundCNY(m.MaxAmountCNY),
		SpentAmountCNY:    roundCNY(m.SpentAmountCNY),
		ReservedAmountCNY: roundCNY(m.ReservedAmountCNY),
		RemainingCNY:      mandateRemainingCNY(&m),
		MaxUnquotedCount:  m.MaxUnquotedCount,
		UsedUnquotedCount: m.UsedUnquotedCount,
		RemainingUnquoted: mandateRemainingUnquoted(&m),
		AllowedKinds:      parseMandateAllowedKinds(m.AllowedKindsJSON),
		Status:            m.Status,
		Version:           m.Version,
		ApprovedBy:        m.ApprovedBy,
		CreatedAt:         m.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:         m.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if m.ExpiresAt != nil && !m.ExpiresAt.IsZero() {
		view.ExpiresAt = m.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return view
}

// CreateProductionMandateInTx creates an owner-approved mandate inside the caller's tx.
func CreateProductionMandateInTx(tx *gorm.DB, userID string, in CreateProductionMandateInput) (*model.AssistantProductionMandate, error) {
	if tx == nil {
		return nil, newError(CodeInternal, "db_unavailable", "数据库连接不可用", nil)
	}
	userID = strings.TrimSpace(userID)
	canvasID := strings.TrimSpace(in.CanvasID)
	if userID == "" || canvasID == "" {
		return nil, InvalidArg("invalid_mandate", "userId 和 canvasId 必填")
	}
	if math.IsNaN(in.MaxAmountCNY) || math.IsInf(in.MaxAmountCNY, 0) || in.MaxAmountCNY < 0 || in.MaxAmountCNY > maxMandateAmountCNY {
		return nil, InvalidArg("invalid_mandate_budget", fmt.Sprintf("预算上限必须在 0 到 %d 元之间", maxMandateAmountCNY))
	}
	if in.MaxUnquotedCount < 0 || in.MaxUnquotedCount > maxMandateUnquotedCount {
		return nil, InvalidArg("invalid_mandate_unquoted", fmt.Sprintf("未报价调用上限必须在 0 到 %d 次之间", maxMandateUnquotedCount))
	}
	if roundCNY(in.MaxAmountCNY) <= 0 && in.MaxUnquotedCount <= 0 {
		return nil, InvalidArg("invalid_mandate_budget", "预算金额上限或未报价次数上限至少需要设置一项")
	}
	kinds, err := normalizeMandateKinds(in.AllowedKinds)
	if err != nil {
		return nil, err
	}
	kindsJSON, _ := json.Marshal(kinds)
	now := time.Now().UTC()
	var expiresAt *time.Time
	if in.ExpiresAt != nil && !in.ExpiresAt.IsZero() {
		t := in.ExpiresAt.UTC()
		expiresAt = &t
	} else {
		ttl := in.ExpiresInMinutes
		if ttl <= 0 {
			ttl = defaultMandateTTLMinutes
		}
		if ttl > maxMandateTTLMinutes {
			ttl = maxMandateTTLMinutes
		}
		t := now.Add(time.Duration(ttl) * time.Minute)
		expiresAt = &t
	}
	approvedBy := strings.TrimSpace(in.ApprovedBy)
	if approvedBy == "" {
		approvedBy = "ui"
	}
	sessionID := strings.TrimSpace(in.SessionID)
	// Enforce at most ONE active mandate per (user_id, canvas_id, session_id) scope:
	// atomically revoke any prior active mandates in this scope before inserting the new one
	// so revoking the current active mandate never resurrects an older hidden active mandate.
	revokeQuery := tx.Model(&model.AssistantProductionMandate{}).
		Where("user_id = ? AND canvas_id = ? AND status = ?", userID, canvasID, model.MandateStatusActive)
	if sessionID != "" {
		revokeQuery = revokeQuery.Where("(session_id = ? OR session_id = '')", sessionID)
	}
	if err := revokeQuery.Updates(map[string]any{
		"status":     model.MandateStatusRevoked,
		"version":    gorm.Expr("version + 1"),
		"updated_at": now,
	}).Error; err != nil {
		return nil, AsError(err)
	}
	row := &model.AssistantProductionMandate{
		ID:                newMandateID("pm"),
		UserID:            userID,
		CanvasID:          canvasID,
		SessionID:         sessionID,
		MaxAmountCNY:      roundCNY(in.MaxAmountCNY),
		SpentAmountCNY:    0,
		ReservedAmountCNY: 0,
		MaxUnquotedCount:  in.MaxUnquotedCount,
		UsedUnquotedCount: 0,
		AllowedKindsJSON:  string(kindsJSON),
		Status:            model.MandateStatusActive,
		Version:           1,
		ApprovedBy:        approvedBy,
		ExpiresAt:         expiresAt,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := tx.Create(row).Error; err != nil {
		return nil, AsError(err)
	}
	return row, nil
}

// GetProductionMandateInTx fetches a single mandate owned by userID.
func GetProductionMandateInTx(tx *gorm.DB, userID, mandateID string) (*model.AssistantProductionMandate, error) {
	if tx == nil {
		return nil, newError(CodeInternal, "db_unavailable", "数据库连接不可用", nil)
	}
	var row model.AssistantProductionMandate
	err := tx.Where("id = ? AND user_id = ?", strings.TrimSpace(mandateID), strings.TrimSpace(userID)).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, NotFound("mandate_not_found", "预算包不存在")
	}
	if err != nil {
		return nil, AsError(err)
	}
	return &row, nil
}

// ListProductionMandatesInTx lists mandates for a user/canvas (expiring overdue active rows).
func ListProductionMandatesInTx(tx *gorm.DB, userID, canvasID, sessionID, status string) ([]ProductionMandateView, error) {
	if tx == nil {
		return []ProductionMandateView{}, nil
	}
	now := time.Now().UTC()
	q := tx.Where("user_id = ?", strings.TrimSpace(userID))
	if c := strings.TrimSpace(canvasID); c != "" {
		q = q.Where("canvas_id = ?", c)
	}
	if s := strings.TrimSpace(sessionID); s != "" {
		q = q.Where("(session_id = ? OR session_id = '')", s)
	}
	var rows []model.AssistantProductionMandate
	if err := q.Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, AsError(err)
	}
	filterStatus := strings.TrimSpace(status)
	out := make([]ProductionMandateView, 0, len(rows))
	for i := range rows {
		if rows[i].Status == model.MandateStatusActive && mandateIsExpired(&rows[i], now) {
			rows[i].Status = model.MandateStatusExpired
			rows[i].UpdatedAt = now
			_ = tx.Model(&model.AssistantProductionMandate{}).
				Where("id = ? AND status = ?", rows[i].ID, model.MandateStatusActive).
				Updates(map[string]any{"status": model.MandateStatusExpired, "updated_at": now}).Error
		}
		if filterStatus != "" && rows[i].Status != filterStatus {
			continue
		}
		out = append(out, ProjectProductionMandate(rows[i]))
	}
	return out, nil
}

// RevokeProductionMandateInTx revokes a mandate so no further reservations succeed.
func RevokeProductionMandateInTx(tx *gorm.DB, userID, mandateID string) (*model.AssistantProductionMandate, error) {
	row, err := GetProductionMandateInTx(tx, userID, mandateID)
	if err != nil {
		return nil, err
	}
	if row.Status == model.MandateStatusRevoked {
		return row, nil
	}
	now := time.Now().UTC()
	res := tx.Model(&model.AssistantProductionMandate{}).
		Where("id = ? AND user_id = ? AND version = ?", row.ID, row.UserID, row.Version).
		Updates(map[string]any{
			"status":     model.MandateStatusRevoked,
			"version":    row.Version + 1,
			"updated_at": now,
		})
	if res.Error != nil {
		return nil, AsError(res.Error)
	}
	if res.RowsAffected == 0 {
		return nil, Conflict("mandate_concurrent_update", "预算包状态正在变化，请重试", nil)
	}
	row.Status = model.MandateStatusRevoked
	row.Version++
	row.UpdatedAt = now
	return row, nil
}

// FindActiveMandateInTx finds the best active non-expired mandate for (userID, canvasID, sessionID).
// Exact session matches take priority over canvas-wide mandates.
func FindActiveMandateInTx(tx *gorm.DB, userID, canvasID, sessionID string, now time.Time) (*model.AssistantProductionMandate, error) {
	if tx == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(canvasID) == "" {
		return nil, nil
	}
	sessionID = strings.TrimSpace(sessionID)
	q := tx.Where("user_id = ? AND canvas_id = ? AND status = ?", strings.TrimSpace(userID), strings.TrimSpace(canvasID), model.MandateStatusActive)
	if sessionID != "" {
		q = q.Where("(session_id = ? OR session_id = '')", sessionID)
	} else {
		q = q.Where("session_id = ''")
	}
	var rows []model.AssistantProductionMandate
	if err := q.Order("CASE WHEN session_id != '' THEN 0 ELSE 1 END ASC, created_at DESC").Find(&rows).Error; err != nil {
		return nil, AsError(err)
	}
	for i := range rows {
		if mandateIsExpired(&rows[i], now) {
			_ = tx.Model(&model.AssistantProductionMandate{}).
				Where("id = ? AND status = ?", rows[i].ID, model.MandateStatusActive).
				Updates(map[string]any{"status": model.MandateStatusExpired, "updated_at": now}).Error
			continue
		}
		return &rows[i], nil
	}
	return nil, nil
}

// HasAnyMandateInTx reports whether any mandate (active or exhausted) exists for this scope.
func HasAnyMandateInTx(tx *gorm.DB, userID, canvasID, sessionID string) bool {
	if tx == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(canvasID) == "" {
		return false
	}
	q := tx.Model(&model.AssistantProductionMandate{}).
		Where("user_id = ? AND canvas_id = ? AND status IN ?", strings.TrimSpace(userID), strings.TrimSpace(canvasID), []string{model.MandateStatusActive, model.MandateStatusExhausted})
	if s := strings.TrimSpace(sessionID); s != "" {
		q = q.Where("(session_id = ? OR session_id = '')", s)
	}
	var count int64
	if err := q.Count(&count).Error; err != nil {
		return false
	}
	return count > 0
}

// ReserveMandateInTx atomically reserves spend or an unquoted slot inside the caller's tx.
// Idempotent by (mandate_id, call_id). NEVER opens a nested transaction.
func ReserveMandateInTx(
	tx *gorm.DB,
	userID, mandateID string,
	item MandateReserveItem,
	now time.Time,
) (*model.AssistantMandateReservation, *model.AssistantProductionMandate, error) {
	if tx == nil {
		return nil, nil, newError(CodeInternal, "db_unavailable", "数据库连接不可用", nil)
	}
	userID = strings.TrimSpace(userID)
	mandateID = strings.TrimSpace(mandateID)
	callID := strings.TrimSpace(item.CallID)
	kind := strings.ToLower(strings.TrimSpace(item.Kind))
	if mandateID == "" || callID == "" || !validMandateKinds[kind] {
		return nil, nil, InvalidArg("invalid_mandate_reservation", "预算预留参数无效")
	}

	mandate, err := GetProductionMandateInTx(tx, userID, mandateID)
	if err != nil {
		return nil, nil, err
	}

	// Idempotent replay check on unique (mandate_id, call_id).
	var existing model.AssistantMandateReservation
	findErr := tx.Where("mandate_id = ? AND call_id = ?", mandate.ID, callID).First(&existing).Error
	if findErr == nil {
		if existing.Status == model.MandateReservationStatusReserved || existing.Status == model.MandateReservationStatusSpent {
			return &existing, mandate, nil
		}
		return nil, mandate, Conflict("mandate_call_already_released", "该调用的预算预留已释放，请使用新的调用编号", nil)
	} else if !errors.Is(findErr, gorm.ErrRecordNotFound) {
		return nil, nil, AsError(findErr)
	}

	if mandate.Status == model.MandateStatusActive && mandateIsExpired(mandate, now) {
		_ = tx.Model(&model.AssistantProductionMandate{}).
			Where("id = ? AND status = ?", mandate.ID, model.MandateStatusActive).
			Updates(map[string]any{"status": model.MandateStatusExpired, "updated_at": now}).Error
		mandate.Status = model.MandateStatusExpired
	}
	if mandate.Status != model.MandateStatusActive {
		return nil, mandate, PreconditionFailed("approval_required", "当前制作预算包已不可用，请重新确认", map[string]any{
			"mandateId":     mandate.ID,
			"mandateStatus": mandate.Status,
			"reason":        "mandate_" + mandate.Status,
		})
	}
	if !mandateAllowsKind(mandate, kind) {
		return nil, mandate, PreconditionFailed("approval_required", "当前制作预算包未授权该类型操作，请确认", map[string]any{
			"mandateId": mandate.ID,
			"kind":      kind,
			"reason":    "mandate_kind_not_allowed",
		})
	}

	// Hard security invariant: unquoted / BYOK calls (amount <= 0 or missing fixed quote)
	// NEVER pass under a CNY budget unless max_unquoted_count > used_unquoted_count.
	isUnquoted := item.Unquoted || math.IsNaN(item.AmountCNY) || math.IsInf(item.AmountCNY, 0) || roundCNY(item.AmountCNY) <= 0
	amount := 0.0
	nextReserved := roundCNY(mandate.ReservedAmountCNY)
	nextUsedUnquoted := mandate.UsedUnquotedCount

	if isUnquoted {
		if mandate.MaxUnquotedCount <= 0 || mandate.UsedUnquotedCount >= mandate.MaxUnquotedCount {
			return nil, mandate, PreconditionFailed("approval_required", "未报价或自带 Key 模型需要单独确认，当前预算包没有可用的未报价额度", map[string]any{
				"mandateId":         mandate.ID,
				"kind":              kind,
				"unquoted":          true,
				"maxUnquotedCount":  mandate.MaxUnquotedCount,
				"usedUnquotedCount": mandate.UsedUnquotedCount,
				"reason":            "mandate_unquoted_not_allowed",
			})
		}
		nextUsedUnquoted++
	} else {
		amount = roundCNY(item.AmountCNY)
		projected := roundCNY(mandate.SpentAmountCNY + mandate.ReservedAmountCNY + amount)
		if projected > roundCNY(mandate.MaxAmountCNY) {
			return nil, mandate, PreconditionFailed(
				"approval_required",
				fmt.Sprintf("本次预估 ¥%.2f 超出预算包剩余额度 ¥%.2f，请确认", amount, mandateRemainingCNY(mandate)),
				map[string]any{
					"mandateId":    mandate.ID,
					"kind":         kind,
					"estimatedCny": amount,
					"remainingCny": mandateRemainingCNY(mandate),
					"maxAmountCny": roundCNY(mandate.MaxAmountCNY),
					"reason":       "mandate_budget_exceeded",
				},
			)
		}
		nextReserved = roundCNY(mandate.ReservedAmountCNY + amount)
	}

	updatedMandate := *mandate
	updatedMandate.ReservedAmountCNY = nextReserved
	updatedMandate.UsedUnquotedCount = nextUsedUnquoted
	updatedMandate.Version = mandate.Version + 1
	updatedMandate.UpdatedAt = now
	updatedMandate.Status = nextMandateCapacityStatus(&updatedMandate, now)

	upd := tx.Model(&model.AssistantProductionMandate{}).
		Where("id = ? AND user_id = ? AND version = ? AND status = ?", mandate.ID, mandate.UserID, mandate.Version, model.MandateStatusActive).
		Updates(map[string]any{
			"reserved_amount_cny": updatedMandate.ReservedAmountCNY,
			"used_unquoted_count": updatedMandate.UsedUnquotedCount,
			"status":              updatedMandate.Status,
			"version":             updatedMandate.Version,
			"updated_at":          now,
		})
	if upd.Error != nil {
		return nil, nil, AsError(upd.Error)
	}
	if upd.RowsAffected != 1 {
		return nil, nil, Conflict("mandate_concurrent_update", "预算包余额已变更，请重试", nil)
	}

	res := &model.AssistantMandateReservation{
		ID:        newMandateID("pmr"),
		MandateID: mandate.ID,
		UserID:    userID,
		TaskID:    strings.TrimSpace(item.TaskID),
		CallID:    callID,
		Kind:      kind,
		AmountCNY: amount,
		Unquoted:  isUnquoted,
		Status:    model.MandateReservationStatusReserved,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := tx.Create(res).Error; err != nil {
		return nil, nil, AsError(err)
	}
	return res, &updatedMandate, nil
}

// ReserveMandateBatchInTx reserves a slice of paid items atomically within the caller's tx.
func ReserveMandateBatchInTx(
	tx *gorm.DB,
	userID, mandateID string,
	items []MandateReserveItem,
	now time.Time,
) ([]model.AssistantMandateReservation, *model.AssistantProductionMandate, error) {
	if len(items) == 0 {
		return nil, nil, InvalidArg("invalid_batch", "至少需要 1 项预留")
	}
	reservations := make([]model.AssistantMandateReservation, 0, len(items))
	var latest *model.AssistantProductionMandate
	for _, item := range items {
		res, m, err := ReserveMandateInTx(tx, userID, mandateID, item, now)
		if err != nil {
			return nil, m, err
		}
		reservations = append(reservations, *res)
		latest = m
	}
	return reservations, latest, nil
}

// BindMandateReservationTaskInTx links a created async task ID to its reservation in the same tx.
func BindMandateReservationTaskInTx(tx *gorm.DB, reservationID, taskID string) error {
	if tx == nil || strings.TrimSpace(reservationID) == "" || strings.TrimSpace(taskID) == "" {
		return nil
	}
	return tx.Model(&model.AssistantMandateReservation{}).
		Where("id = ?", strings.TrimSpace(reservationID)).
		Updates(map[string]any{"task_id": strings.TrimSpace(taskID), "updated_at": time.Now().UTC()}).Error
}

// SettleReservationInTx transitions a reservation from reserved -> spent idempotently.
func SettleReservationInTx(tx *gorm.DB, reservationID string, now time.Time) error {
	if tx == nil || strings.TrimSpace(reservationID) == "" {
		return nil
	}
	var res model.AssistantMandateReservation
	err := tx.Where("id = ?", strings.TrimSpace(reservationID)).First(&res).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return AsError(err)
	}
	if res.Status != model.MandateReservationStatusReserved {
		return nil
	}
	updRes := tx.Model(&model.AssistantMandateReservation{}).
		Where("id = ? AND status = ?", res.ID, model.MandateReservationStatusReserved).
		Updates(map[string]any{"status": model.MandateReservationStatusSpent, "updated_at": now})
	if updRes.Error != nil {
		return AsError(updRes.Error)
	}
	if updRes.RowsAffected == 0 {
		return nil
	}
	var mandate model.AssistantProductionMandate
	if err := tx.Where("id = ?", res.MandateID).First(&mandate).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return AsError(err)
	}
	nextReserved := roundCNY(mandate.ReservedAmountCNY - res.AmountCNY)
	if nextReserved < 0 {
		nextReserved = 0
	}
	nextSpent := roundCNY(mandate.SpentAmountCNY + res.AmountCNY)
	mandate.ReservedAmountCNY = nextReserved
	mandate.SpentAmountCNY = nextSpent
	nextStatus := nextMandateCapacityStatus(&mandate, now)
	return tx.Model(&model.AssistantProductionMandate{}).
		Where("id = ?", mandate.ID).
		Updates(map[string]any{
			"reserved_amount_cny": nextReserved,
			"spent_amount_cny":    nextSpent,
			"status":              nextStatus,
			"version":             mandate.Version + 1,
			"updated_at":          now,
		}).Error
}

// ReleaseReservationInTx transitions a reservation from reserved -> released idempotently,
// restoring reserved CNY / unquoted slot and re-activating exhausted non-expired mandates.
func ReleaseReservationInTx(tx *gorm.DB, reservationID string, now time.Time) error {
	if tx == nil || strings.TrimSpace(reservationID) == "" {
		return nil
	}
	var res model.AssistantMandateReservation
	err := tx.Where("id = ?", strings.TrimSpace(reservationID)).First(&res).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return AsError(err)
	}
	if res.Status != model.MandateReservationStatusReserved {
		return nil
	}
	updRes := tx.Model(&model.AssistantMandateReservation{}).
		Where("id = ? AND status = ?", res.ID, model.MandateReservationStatusReserved).
		Updates(map[string]any{"status": model.MandateReservationStatusReleased, "updated_at": now})
	if updRes.Error != nil {
		return AsError(updRes.Error)
	}
	if updRes.RowsAffected == 0 {
		return nil
	}
	var mandate model.AssistantProductionMandate
	if err := tx.Where("id = ?", res.MandateID).First(&mandate).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return AsError(err)
	}
	nextReserved := roundCNY(mandate.ReservedAmountCNY - res.AmountCNY)
	if nextReserved < 0 {
		nextReserved = 0
	}
	nextUsedUnquoted := mandate.UsedUnquotedCount
	if res.Unquoted && nextUsedUnquoted > 0 {
		nextUsedUnquoted--
	}
	mandate.ReservedAmountCNY = nextReserved
	mandate.UsedUnquotedCount = nextUsedUnquoted
	nextStatus := nextMandateCapacityStatus(&mandate, now)
	return tx.Model(&model.AssistantProductionMandate{}).
		Where("id = ?", mandate.ID).
		Updates(map[string]any{
			"reserved_amount_cny": nextReserved,
			"used_unquoted_count": nextUsedUnquoted,
			"status":              nextStatus,
			"version":             mandate.Version + 1,
			"updated_at":          now,
		}).Error
}
