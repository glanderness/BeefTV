package operations

import (
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
	externalGuardrailSettingKey  = "external_mcp_generation_guardrail"
	ExternalGuardrailModeAllow   = "allow"
	ExternalGuardrailModePropose = "propose_only"
	maxExternalPerCallCapCNY     = 10000
	maxExternalDailyBudgetCapCNY = 100000
)

// ExternalGenerationGuardrail controls optional non-blocking spend protection for
// external MCP/CLI clients without pausing terminal workflows on desktop popups.
type ExternalGenerationGuardrail struct {
	Mode           string  `json:"mode"`
	MaxPerCallCNY  float64 `json:"maxPerCallCny"`
	DailyBudgetCNY float64 `json:"dailyBudgetCny"`
}

type ExternalGuardrailStatus struct {
	ExternalGenerationGuardrail
	TodaySpentCNY float64 `json:"todaySpentCny"`
}

func defaultExternalGenerationGuardrail() ExternalGenerationGuardrail {
	return ExternalGenerationGuardrail{
		Mode:           ExternalGuardrailModeAllow,
		MaxPerCallCNY:  0,
		DailyBudgetCNY: 0,
	}
}

func roundCNY(v float64) float64 {
	return math.Round(v*10000) / 10000
}

// GetExternalGenerationGuardrail reads the workspace external-agent guardrail
// setting, defaulting to unrestricted ("allow", no caps) when unset.
func GetExternalGenerationGuardrail(db *gorm.DB) ExternalGenerationGuardrail {
	cfg := defaultExternalGenerationGuardrail()
	if db == nil {
		return cfg
	}
	var setting model.SystemSetting
	if err := db.Select("value_json").First(&setting, "key = ?", externalGuardrailSettingKey).Error; err != nil {
		return cfg
	}
	if err := json.Unmarshal([]byte(setting.ValueJSON), &cfg); err != nil {
		// Fail closed if persisted guardrail JSON is corrupted so spend protection cannot silently disappear.
		return ExternalGenerationGuardrail{Mode: ExternalGuardrailModePropose}
	}
	if cfg.Mode != ExternalGuardrailModeAllow && cfg.Mode != ExternalGuardrailModePropose {
		cfg.Mode = ExternalGuardrailModeAllow
	}
	if math.IsNaN(cfg.MaxPerCallCNY) || math.IsInf(cfg.MaxPerCallCNY, 0) || cfg.MaxPerCallCNY < 0 {
		cfg.MaxPerCallCNY = 0
	}
	if math.IsNaN(cfg.DailyBudgetCNY) || math.IsInf(cfg.DailyBudgetCNY, 0) || cfg.DailyBudgetCNY < 0 {
		cfg.DailyBudgetCNY = 0
	}
	return cfg
}

// SetExternalGenerationGuardrail validates and persists workspace external-agent guardrails.
func SetExternalGenerationGuardrail(db *gorm.DB, in ExternalGenerationGuardrail) (ExternalGenerationGuardrail, error) {
	if db == nil {
		return ExternalGenerationGuardrail{}, errors.New("settings unavailable")
	}
	mode := strings.TrimSpace(in.Mode)
	if mode == "" {
		mode = ExternalGuardrailModeAllow
	}
	if mode != ExternalGuardrailModeAllow && mode != ExternalGuardrailModePropose {
		return ExternalGenerationGuardrail{}, InvalidArg("invalid_guardrail_mode", "外部 Agent 护栏模式只能是 allow 或 propose_only")
	}
	if math.IsNaN(in.MaxPerCallCNY) || math.IsInf(in.MaxPerCallCNY, 0) || in.MaxPerCallCNY < 0 || in.MaxPerCallCNY > maxExternalPerCallCapCNY {
		return ExternalGenerationGuardrail{}, InvalidArg("invalid_guardrail_cap", fmt.Sprintf("单次上限必须在 0 到 %d 元之间", maxExternalPerCallCapCNY))
	}
	if math.IsNaN(in.DailyBudgetCNY) || math.IsInf(in.DailyBudgetCNY, 0) || in.DailyBudgetCNY < 0 || in.DailyBudgetCNY > maxExternalDailyBudgetCapCNY {
		return ExternalGenerationGuardrail{}, InvalidArg("invalid_guardrail_cap", fmt.Sprintf("每日上限必须在 0 到 %d 元之间", maxExternalDailyBudgetCapCNY))
	}
	clean := ExternalGenerationGuardrail{
		Mode:           mode,
		MaxPerCallCNY:  roundCNY(in.MaxPerCallCNY),
		DailyBudgetCNY: roundCNY(in.DailyBudgetCNY),
	}
	encoded, err := json.Marshal(clean)
	if err != nil {
		return ExternalGenerationGuardrail{}, err
	}
	var existing model.SystemSetting
	findErr := db.Select("key").First(&existing, "key = ?", externalGuardrailSettingKey).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		if err := db.Create(&model.SystemSetting{Key: externalGuardrailSettingKey, ValueJSON: string(encoded)}).Error; err != nil {
			return ExternalGenerationGuardrail{}, err
		}
		return clean, nil
	}
	if findErr != nil {
		return ExternalGenerationGuardrail{}, findErr
	}
	if err := db.Model(&model.SystemSetting{}).Where("key = ?", externalGuardrailSettingKey).Update("value_json", string(encoded)).Error; err != nil {
		return ExternalGenerationGuardrail{}, err
	}
	return clean, nil
}

// TodayExternalEstimatedSpendCNY sums estimated CNY recorded on today's succeeded
// external canvas generation receipts (deduplicated by AgentOpRecord primary key).
func TodayExternalEstimatedSpendCNY(db *gorm.DB, userID string, now time.Time) float64 {
	if db == nil || strings.TrimSpace(userID) == "" {
		return 0
	}
	loc := now.Location()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	var rows []model.AgentOpRecord
	err := db.Select("result_json").
		Where("user_id = ? AND caller_kind = ? AND op IN ? AND status = ? AND created_at >= ?",
			userID, string(CallerExternal), []string{"canvas.generation.submit", "canvas.generation.regenerate"}, "succeeded", startOfDay).
		Find(&rows).Error
	if err != nil {
		return 0
	}
	total := 0.0
	for _, row := range rows {
		var receipt struct {
			EstimatedCNY *float64 `json:"estimatedCny"`
		}
		if json.Unmarshal([]byte(row.ResultJSON), &receipt) != nil || receipt.EstimatedCNY == nil {
			continue
		}
		if !math.IsNaN(*receipt.EstimatedCNY) && !math.IsInf(*receipt.EstimatedCNY, 0) && *receipt.EstimatedCNY > 0 {
			total += *receipt.EstimatedCNY
		}
	}
	return roundCNY(total)
}

// hasFixedEstimate reports whether every target has a known, non-variable, non-reserve
// fixed price so budget caps can be enforced fail-closed.
func hasFixedEstimate(est GenerationEstimate) (amount float64, variable bool, ok bool) {
	if len(est.Items) == 0 || est.Summary.Unknown > 0 || est.Summary.Priced != len(est.Items) {
		for _, item := range est.Items {
			if item.Variable || item.Reserve != nil {
				variable = true
			}
		}
		return 0, variable, false
	}
	for _, item := range est.Items {
		if item.Amount == nil || item.Variable || item.Reserve != nil {
			return 0, item.Variable || item.Reserve != nil, false
		}
	}
	return roundCNY(est.Summary.Amount), false, true
}

// CheckExternalGenerationGuardrail validates external MCP/CLI paid generation against
// the workspace guardrail before task admission. Returns the estimated CNY when pricing
// was evaluated so callers can persist it on the receipt.
func CheckExternalGenerationGuardrail(
	db *gorm.DB,
	domain Domain,
	userID string,
	nodes map[string]map[string]any,
	targets []GenerationTarget,
	now time.Time,
) (*float64, error) {
	cfg := GetExternalGenerationGuardrail(db)
	if cfg.Mode == ExternalGuardrailModePropose {
		return nil, PermissionDenied(
			"external_generation_propose_only",
			"当前工作区已限制外部 Agent 直接发起付费生成，请改用 canvas.generation.propose 提交草稿并由用户运行 beeftv approve 批准，或在「BeefTV MCP」页调整护栏设置",
		)
	}
	estimate := EstimateGenerationCost(domain, estimateGenerationTargets(nodes, targets))
	amount, isVariable, fixedOK := hasFixedEstimate(estimate)
	if cfg.MaxPerCallCNY <= 0 && cfg.DailyBudgetCNY <= 0 {
		// Still record fixed estimate when uncapped so "今日外部已预估消耗" and mid-day cap activation stay accurate.
		if fixedOK {
			return &amount, nil
		}
		return nil, nil
	}
	if !fixedOK {
		return nil, PreconditionFailed(
			"external_budget_price_unknown",
			"当前启用了外部 Agent 付费额度上限，但所选模型暂无固定报价，已阻止直接提交；请在「BeefTV MCP」页调整上限或改用已定价模型",
			map[string]any{
				"unknownCount":   estimate.Summary.Unknown,
				"variable":       isVariable,
				"maxPerCallCny":  cfg.MaxPerCallCNY,
				"dailyBudgetCny": cfg.DailyBudgetCNY,
			},
		)
	}
	if cfg.MaxPerCallCNY > 0 && amount > cfg.MaxPerCallCNY {
		return nil, PreconditionFailed(
			"external_per_call_budget_exceeded",
			fmt.Sprintf("本次外部生成预估 ¥%.2f，超过单次上限 ¥%.2f；请拆分批次或在「BeefTV MCP」页调高单次上限", amount, cfg.MaxPerCallCNY),
			map[string]any{
				"estimatedCny":  amount,
				"maxPerCallCny": cfg.MaxPerCallCNY,
			},
		)
	}
	if cfg.DailyBudgetCNY > 0 {
		spent := TodayExternalEstimatedSpendCNY(db, userID, now)
		if roundCNY(spent+amount) > cfg.DailyBudgetCNY {
			return nil, PreconditionFailed(
				"external_daily_budget_exceeded",
				fmt.Sprintf("今日外部生成已预估消耗 ¥%.2f，加上本次 ¥%.2f 将超过每日上限 ¥%.2f；请在「BeefTV MCP」页调高每日上限", spent, amount, cfg.DailyBudgetCNY),
				map[string]any{
					"estimatedCny":   amount,
					"todaySpentCny":  spent,
					"dailyBudgetCny": cfg.DailyBudgetCNY,
				},
			)
		}
	}
	return &amount, nil
}

// CheckExternalBusinessPaidGuardrail enforces the same external paid-generation guardrail
// on raw Business Catalog paid routes (e.g. POST /tasks, /tasks/:id/retry,
// /creation-runs/:id/execute, /timeline/transcriptions) that do not pass through
// canvas.generation.submit pricing.
func CheckExternalBusinessPaidGuardrail(db *gorm.DB) error {
	cfg := GetExternalGenerationGuardrail(db)
	if cfg.Mode == ExternalGuardrailModePropose {
		return PermissionDenied(
			"external_generation_propose_only",
			"当前工作区已限制外部 Agent 直接发起付费生成，请改用 canvas.generation.propose 提交草稿并由用户通过 beeftv approve 批准，或在「BeefTV MCP」页调整护栏设置",
		)
	}
	if cfg.MaxPerCallCNY > 0 || cfg.DailyBudgetCNY > 0 {
		return PreconditionFailed(
			"external_budget_price_unknown",
			"当前启用了外部 Agent 付费额度上限，底层任务接口无法预先校验固定报价，已阻止直接提交；请改用 canvas.generation.propose / canvas.generation.submit 或在「BeefTV MCP」页调整护栏",
			map[string]any{
				"maxPerCallCny":  cfg.MaxPerCallCNY,
				"dailyBudgetCny": cfg.DailyBudgetCNY,
			},
		)
	}
	return nil
}
