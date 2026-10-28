package task

import (
	"reflect"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestComputeOutcome(t *testing.T) {
	noResult, unrecoverable := RecoveryNoResult, RecoveryUnrecoverable
	failed := model.Task{Type: "canvas_image", Status: model.TaskStatusFailed}
	with := func(change func(*model.Task)) model.Task { copy := failed; change(&copy); return copy }
	want := func(phase, regenerate, reason string) Outcome {
		return Outcome{Phase: phase, Regenerate: regenerate, Reason: reason}
	}
	cases := []struct {
		name  string
		task  model.Task
		state string
		facts OutcomeFacts
		want  Outcome
	}{
		{"排队", with(func(t *model.Task) { t.Status = model.TaskStatusQueued }), "", OutcomeFacts{}, want("running", "blocked", "task_running")},
		{"重启后过期租约仍在运行", with(func(t *model.Task) {
			t.Status = model.TaskStatusRunning
			past := time.Now().Add(-time.Hour)
			t.LeaseExpiresAt = &past
		}), "", OutcomeFacts{}, want("running", "blocked", "task_running")},
		{"所有输出入库", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStateReady, OutcomeFacts{}, want("ready", "allowed", "result_ready")},
		{"部分输出未入库", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStatePendingMaterialization, OutcomeFacts{}, want("fetching", "blocked", "result_fetching")},
		{"下载暂时失败", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStateFailedRetryable, OutcomeFacts{}, want("retrievable", "blocked", "delivery_pending")},
		{"入库确定失败", with(func(t *model.Task) { t.Status = model.TaskStatusSucceeded }), ResultStateFailedPermanent, OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"尚未派发", failed, "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "allowed", "task_failed")},
		{"本地准备失败", with(func(t *model.Task) { t.Stage = "请求尚未提交" }), "", OutcomeFacts{}, want("failed", "allowed", "task_failed")},
		{"明确没建任务", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "rejected_no_job"}, want("failed", "allowed", "no_result")},
		{"明确失败不代表退款", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "no_result")},
		{"有明确退款声明", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{ConfirmedUncharged: true}, want("failed", "allowed", "no_result")},
		{"BeefAPI 视频失败未扣费", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{BillingSource: "beefapi", UsageState: "failed", UsageStatePresent: true}, want("failed", "allowed", "no_result")},
		{"BeefAPI 视频仍在结算", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{BillingSource: "beefapi", UsageState: "pending", UsageStatePresent: true}, want("failed", "blocked", "result_unrecoverable")},
		{"BeefAPI 视频已扣费", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{BillingSource: "beefapi", UsageState: "completed", UsageStatePresent: true}, want("failed", "confirm", "result_unrecoverable")},
		{"BeefAPI 图片明确退款", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{BillingSource: "beefapi", BillingState: "refunded", BillingStatePresent: true}, want("failed", "allowed", "no_result")},
		{"BeefAPI 图片空扣费结论仍待核对", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{BillingSource: "beefapi", BillingStatePresent: true}, want("failed", "blocked", "result_unrecoverable")},
		{"第三方取不回仍需确认", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"旧回执没有路由", failed, "", OutcomeFacts{HasImageReceipt: true}, want("retrievable", "blocked", "image_recovery_pending")},
		{"已接受", failed, "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"同键待重发", failed, "", OutcomeFacts{DispatchState: "submission_unknown", SafeImageReplay: true}, want("retrievable", "blocked", "image_recovery_pending")},
		{"旧提交未确认等待扫描", with(func(t *model.Task) { t.Stage = "submission_unknown" }), "", OutcomeFacts{}, want("retrievable", "blocked", "image_recovery_pending")},
		{"确认取不回", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{HasImageReceipt: true}, want("failed", "confirm", "result_unrecoverable")},
		{"读证据失败不是没结果", failed, "", OutcomeFacts{Unreadable: true}, want("retrievable", "blocked", "evidence_unavailable")},
		{"审核失败不能原样重跑", with(func(t *model.Task) {
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "SAFETY.INPUT.TEXT"}
		}), "", OutcomeFacts{}, want("failed", "blocked", "input_rejected")},
		{"深度本地不收费", with(func(t *model.Task) { t.Type = model.TaskTypeDepthCapture }), "", OutcomeFacts{}, want("failed", "allowed", "task_failed")},
		{"计费不明", failed, "", OutcomeFacts{}, want("failed", "confirm", "task_failed")},
		{"接受证据覆盖旧未发出阶段", with(func(t *model.Task) { t.Stage = "request_not_sent"; t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted", ImageResponseAccepted: true}, want("failed", "confirm", "no_result")},
		{"视频沿用原任务查询", with(func(t *model.Task) { t.Type = "canvas_video"; t.ProviderRequestID = "original" }), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := tc.task
			if got := ComputeOutcome(tc.task, tc.state, tc.facts); got != tc.want {
				t.Fatalf("got=%+v want=%+v", got, tc.want)
			}
			if !reflect.DeepEqual(before, tc.task) {
				t.Fatal("只读投影修改了任务")
			}
			tc.task.Error = "content policy violated: context deadline exceeded 已退款"
			if got := ComputeOutcome(tc.task, tc.state, tc.facts); got != tc.want {
				t.Fatalf("投影解析了错误文案: %+v", got)
			}
		})
	}
}
