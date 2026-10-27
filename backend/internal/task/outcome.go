package task

import (
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Outcome 是只读投影，不持有状态，也不授权任何提交。
type Outcome = model.TaskOutcome

const (
	RecoveryNoResult      = "no_result"
	RecoveryUnrecoverable = "unrecoverable"
)

// OutcomeFacts 来自持久化证据。读失败必须显式标记，不能当成没有证据。
// 渠道未声明某类失败不收费时，ConfirmedUncharged 保持 false。
type OutcomeFacts struct {
	Unreadable            bool
	DispatchState         string
	HasImageReceipt       bool
	ImageResponseAccepted bool
	SafeImageReplay       bool
	ConfirmedUncharged    bool
}

func ComputeOutcome(task model.Task, resultState string, facts OutcomeFacts) Outcome {
	out := func(phase, regenerate, reason string) Outcome {
		return Outcome{Phase: phase, Regenerate: regenerate, Reason: reason}
	}
	if task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning {
		return out("running", "blocked", "task_running")
	}
	if task.Status == model.TaskStatusSucceeded {
		if resultState == ResultStateReady {
			return out("ready", "allowed", "result_ready")
		}
		if resultState == ResultStateFailedPermanent {
			return out("failed", "confirm", "result_unrecoverable")
		}
		if resultState == ResultStatePendingMaterialization || resultState == ResultStateMaterializing {
			return out("fetching", "blocked", "result_fetching")
		}
		return out("retrievable", "blocked", "delivery_pending")
	}
	if facts.Unreadable {
		return out("retrievable", "blocked", "evidence_unavailable")
	}
	regenerate := "confirm"
	if task.Type == model.TaskTypeDepthCapture || facts.ConfirmedUncharged || (!facts.ImageResponseAccepted && task.ProviderRequestID == "" && (facts.DispatchState == "not_sent" || facts.DispatchState == "rejected_no_job" || ((task.Stage == "request_not_sent" || task.Stage == "请求尚未提交") && facts.DispatchState != "accepted" && facts.DispatchState != "submission_unknown"))) {
		regenerate = "allowed"
	}
	// 只读结构化上游错误码；不从 Error 文案重新推断审核或计费。
	if d := task.FailureDiagnostics; d != nil {
		code := d.ProviderCode
		if code == "content_policy_violation" || code == "content_moderation" || strings.HasPrefix(code, "SAFETY.INPUT.") {
			return out("failed", "blocked", "input_rejected")
		}
	}
	if task.RecoveryOutcome != nil {
		switch *task.RecoveryOutcome {
		case RecoveryUnrecoverable:
			return out("failed", "confirm", "result_unrecoverable")
		case RecoveryNoResult:
			return out("failed", regenerate, "no_result")
		}
	}
	if task.Type == "canvas_image" && (facts.HasImageReceipt || facts.ImageResponseAccepted || facts.SafeImageReplay || facts.DispatchState == "accepted" || facts.DispatchState == "submission_unknown" || task.Stage == "submission_unknown") {
		return out("retrievable", "blocked", "image_recovery_pending")
	}
	if task.ProviderRequestID != "" {
		return out("retrievable", "blocked", "provider_result_pending")
	}
	return out("failed", regenerate, "task_failed")
}
