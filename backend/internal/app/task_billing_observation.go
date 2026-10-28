package app

import (
	"encoding/json"
	"time"

	"infinite-canvas/backend/internal/model"
)

// Only the formal gateway's explicit status-query adapters call this writer.
// Result/download responses and diagnostic logs never replace billing facts.
func (s *Service) observeTaskBilling(task model.Task, config providerConfig, upstreamID string, payload map[string]any, started time.Time) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	usage, usagePresent, billing, billingPresent := providerBillingStates(encoded)
	if !usagePresent && !billingPresent {
		return nil
	}
	var deadline int64
	if value, ok := payload["reconcile_deadline"].(float64); ok {
		deadline = int64(value)
	}
	evidence := &model.TaskBillingEvidence{RouteRun: task.RouteRun, RouteID: task.RouteID, ChannelModelID: task.ChannelModelID, ChannelID: config.ChannelID, ProviderRequestID: upstreamID, Source: "beefapi", UsageState: usage, UsageStatePresent: usagePresent, BillingState: billing, BillingStatePresent: billingPresent, ReconcileDeadline: deadline, ObservedAt: started}
	return s.repo.UpdateTaskBillingEvidence(task, evidence)
}

type originalResultConclusion struct{ outcome string }

func (e originalResultConclusion) Error() string { return "原任务已结束，未能取回结果" }
