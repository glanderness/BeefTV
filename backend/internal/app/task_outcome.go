package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (s *Service) taskOutcomeFacts(tasks []model.Task) map[string]localtask.OutcomeFacts {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		// 运行中和成功任务的结论不依赖派发证据。
		if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning && task.Status != model.TaskStatusSucceeded {
			ids = append(ids, task.ID)
		}
	}
	evidence, err := s.repo.ImageRecoveryEvidence(ids)
	billing, billingErr := s.repo.TaskProviderBillingEvidence(ids)
	if billingErr != nil {
		if err == nil {
			err = billingErr
		}
	}
	facts := make(map[string]localtask.OutcomeFacts, len(tasks))
	for _, task := range tasks {
		f := localtask.OutcomeFacts{Unreadable: err != nil}
		if e, ok := evidence[task.ID]; ok {
			f.HasImageReceipt = e.HasReceipt
			if e.Attempt != nil && e.Attempt.RouteRun == task.RouteRun {
				f.DispatchState = e.Attempt.DispatchState
				if e.Submission != nil && e.Submission.UserID == task.UserID {
					f.ImageResponseAccepted = e.Submission.ResponseAccepted
					// 是否可安全重发只在实际恢复时验证，不在轮询中加载或解密快照。
				}
			}
		}
		if task.BillingEvidence != nil && task.BillingEvidence.RouteRun == task.RouteRun {
			f.BillingSource = task.BillingEvidence.Source
			f.UsageState = task.BillingEvidence.UsageState
			f.UsageStatePresent = task.BillingEvidence.UsageStatePresent
			f.BillingState = task.BillingEvidence.BillingState
			f.BillingStatePresent = task.BillingEvidence.BillingStatePresent
		} else if b, ok := billing[task.ID]; ok && b.RouteRun == task.RouteRun {
			f.BillingSource = b.Source
			f.UsageState = b.UsageState
			f.UsageStatePresent = b.UsageStatePresent
			f.BillingState = b.BillingState
			f.BillingStatePresent = b.BillingStatePresent
		}
		if f.UsageStatePresent || f.BillingStatePresent {
			f.ConfirmedUncharged = billingEvidenceConfirmsNoCharge(f.UsageState, f.BillingState)
		}
		facts[task.ID] = f
	}
	return facts
}

func billingEvidenceConfirmsNoCharge(usageState, billingState string) bool {
	for _, state := range []string{usageState, billingState} {
		switch strings.ToLower(strings.ReplaceAll(strings.TrimSpace(state), "-", "_")) {
		case "not_charged", "uncharged", "no_charge", "refunded", "refund_completed":
			return true
		}
	}
	return false
}
