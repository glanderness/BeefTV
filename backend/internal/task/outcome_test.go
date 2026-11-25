package task

import (
	"fmt"
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
		{"尚未派发", failed, "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "allowed", ReasonNotCharged)},
		{"本地准备失败", failed, "", OutcomeFacts{RequestNotSent: true}, want("failed", "allowed", ReasonNotCharged)},
		{"参考素材上传失败允许直接重生成", with(func(t *model.Task) { t.ErrorCode = "reference_upload_failed" }), "", OutcomeFacts{}, want("failed", "allowed", ReasonNotCharged)},
		{"参考素材上传失败不覆盖submission_unknown", with(func(t *model.Task) { t.ErrorCode = "reference_upload_failed"; t.Stage = "submission_unknown" }), "", OutcomeFacts{}, want("retrievable", "blocked", "image_recovery_pending")},
		{"参考素材上传失败不覆盖已接受证据", with(func(t *model.Task) { t.ErrorCode = "reference_upload_failed" }), "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"参考素材上传失败不覆盖已有上游视频任务号", with(func(t *model.Task) {
			t.Type = "canvas_video"
			t.ErrorCode = "reference_upload_failed"
			t.ProviderRequestID = "vid-1"
		}), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"阶段文字不参与判断", with(func(t *model.Task) { t.Stage = "请求尚未提交" }), "", OutcomeFacts{}, want("failed", "confirm", "task_failed")},
		{"未发出但上游已有任务号", with(func(t *model.Task) { t.ProviderRequestID = "upstream" }), "", OutcomeFacts{RequestNotSent: true}, want("retrievable", "blocked", "provider_result_pending")},
		{"未发出阶段被接受证据推翻", failed, "", OutcomeFacts{RequestNotSent: true, DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"明确没建任务", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "rejected_no_job"}, want("failed", "allowed", "no_result")},
		{"明确拒绝未建任务但已有POST调用日志", failed, "", OutcomeFacts{HasImageReceipt: true, DispatchState: "rejected_no_job"}, want("failed", "allowed", ReasonNotCharged)},
		{"明确失败不代表退款", with(func(t *model.Task) { t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "no_result")},
		{"旧回执没有路由", failed, "", OutcomeFacts{HasImageReceipt: true}, want("retrievable", "blocked", "image_recovery_pending")},
		{"已接受", failed, "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"取消后提交未确认不假装自动取回且需确认重生成", with(func(t *model.Task) { t.Status = model.TaskStatusCancelled }), "", OutcomeFacts{DispatchState: "submission_unknown"}, want("failed", "confirm", "cancelled_result_unconfirmed")},
		{"取消后已接受仍需核对原请求并在确认后可重生成", with(func(t *model.Task) { t.Status = model.TaskStatusCancelled }), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "cancelled_result_unconfirmed")},
		{"取消后证据读取失败保留evidence_unavailable不误报未确认", with(func(t *model.Task) { t.Status = model.TaskStatusCancelled }), "", OutcomeFacts{Unreadable: true}, want("retrievable", "blocked", "evidence_unavailable")},
		{"取消前确认未发送可重新生成", with(func(t *model.Task) { t.Status = model.TaskStatusCancelled }), "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "allowed", ReasonNotCharged)},
		{"取消后确认无结果保留终态", with(func(t *model.Task) { t.Status = model.TaskStatusCancelled; t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "no_result")},
		{"取消后BeefTV视频已确认扣费保留已扣费结论并退出活跃轮询", with(func(t *model.Task) {
			u := "completed"
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-cancelled-completed"
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"取消后BeefTV视频已确认扣费优先于未清零的reserved计费状态", with(func(t *model.Task) {
			u := "completed"
			b := "reserved"
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-cancelled-completed-reserved"
			t.BeefUsageState = &u
			t.BeefBillingState = &b
		}), "", OutcomeFacts{}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"取消后BeefTV视频已确认扣费优先于空串计费状态", with(func(t *model.Task) {
			u := "completed"
			b := ""
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-cancelled-completed-empty"
			t.BeefUsageState = &u
			t.BeefBillingState = &b
		}), "", OutcomeFacts{}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"取消后BeefTV图片已确认扣费保留已扣费结论并退出活跃轮询", with(func(t *model.Task) {
			b := "settled"
			t.Status = model.TaskStatusCancelled
			t.ImageJobID = "img-cancelled-settled"
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"取消后BeefTV已结算优先于未清零的pending用量状态", with(func(t *model.Task) {
			u := "pending"
			b := "settled"
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-cancelled-settled-pending"
			t.BeefUsageState = &u
			t.BeefBillingState = &b
		}), "", OutcomeFacts{}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"取消后usage=failed优先于残留billing=settled保持allowed", with(func(t *model.Task) {
			u := "failed"
			b := "settled"
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-cancelled-failed-settled"
			t.BeefUsageState = &u
			t.BeefBillingState = &b
		}), "", OutcomeFacts{}, want("failed", "allowed", "task_failed")},
		{"非取消usage=failed优先于残留billing=settled保持allowed且不重入retrievable", with(func(t *model.Task) {
			u := "failed"
			b := "settled"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-failed-settled"
			t.BeefUsageState = &u
			t.BeefBillingState = &b
		}), "", OutcomeFacts{}, want("failed", "allowed", "task_failed")},
		{"终态恢复usage=failed优先于残留billing=settled保持allowed", with(func(t *model.Task) {
			u := "failed"
			b := "settled"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-terminal-failed-settled"
			t.RecoveryOutcome = &noResult
			t.BeefUsageState = &u
			t.BeefBillingState = &b
		}), "", OutcomeFacts{}, want("failed", "allowed", "no_result")},
		{"usage=failed但billing仍reserved时继续阻塞待结算", with(func(t *model.Task) {
			u := "failed"
			b := "reserved"
			dl := "2026-04-20T12:15:00Z"
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-failed-reserved"
			t.BeefUsageState = &u
			t.BeefBillingState = &b
			t.BeefReconcileDeadline = &dl
		}), "", OutcomeFacts{}, Outcome{Phase: "failed", Regenerate: "blocked", Reason: "settlement_pending", ReconcileDeadline: "2026-04-20T12:15:00Z"}},
		{"视频已接受尚无ProviderRequestID失败后等待上游结果取回", with(func(t *model.Task) {
			t.Type = "canvas_video"
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "provider_result_pending")},
		{"取消后BeefTV待结算继续阻塞重生成并透传截止时间", with(func(t *model.Task) {
			u := "pending"
			dl := "2026-04-20T12:00:00Z"
			t.Type = "canvas_video"
			t.Status = model.TaskStatusCancelled
			t.ProviderRequestID = "vid-cancelled-pending"
			t.BeefUsageState = &u
			t.BeefReconcileDeadline = &dl
		}), "", OutcomeFacts{}, Outcome{Phase: "failed", Regenerate: "blocked", Reason: "settlement_pending", ReconcileDeadline: "2026-04-20T12:00:00Z"}},
		{"取消后BeefTV图片已退款允许直接重生成", with(func(t *model.Task) {
			b := "refunded"
			t.Status = model.TaskStatusCancelled
			t.ImageJobID = "img-cancelled-refunded"
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "allowed", "task_failed")},
		{"同键待重发", failed, "", OutcomeFacts{DispatchState: "submission_unknown", SafeImageReplay: true}, want("retrievable", "blocked", "image_recovery_pending")},
		{"旧提交未确认等待扫描", with(func(t *model.Task) { t.Stage = "submission_unknown" }), "", OutcomeFacts{}, want("retrievable", "blocked", "image_recovery_pending")},
		{"确认取不回", with(func(t *model.Task) { t.RecoveryOutcome = &unrecoverable }), "", OutcomeFacts{HasImageReceipt: true}, want("failed", "confirm", "result_unrecoverable")},
		{"读证据失败不是没结果", failed, "", OutcomeFacts{Unreadable: true}, want("retrievable", "blocked", "evidence_unavailable")},
		{"审核失败确认后可重新生成", with(func(t *model.Task) {
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "SAFETY.INPUT.TEXT"}
		}), "", OutcomeFacts{}, want("failed", "confirm", "input_rejected")},
		{"内容审核失败不当成没扣钱", with(func(t *model.Task) {
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "content_policy_violation"}
		}), "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "confirm", "input_rejected")},
		{"深度本地不收费", with(func(t *model.Task) { t.Type = model.TaskTypeDepthCapture }), "", OutcomeFacts{}, want("failed", "allowed", "task_failed")},
		{"计费不明", failed, "", OutcomeFacts{}, want("failed", "confirm", "task_failed")},
		{"接受证据覆盖旧未发出阶段", with(func(t *model.Task) { t.Stage = "request_not_sent"; t.RecoveryOutcome = &noResult }), "", OutcomeFacts{DispatchState: "accepted", ImageResponseAccepted: true}, want("failed", "confirm", "no_result")},
		{"视频沿用原任务查询", with(func(t *model.Task) { t.Type = "canvas_video"; t.ProviderRequestID = "original" }), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"视频确认上游失败", with(func(t *model.Task) {
			t.Type = "canvas_video"
			t.ProviderRequestID = "original"
			t.RecoveryOutcome = &noResult
		}), "", OutcomeFacts{}, want("failed", "confirm", "no_result")},
		{"视频过保或无法取回", with(func(t *model.Task) {
			t.Type = "canvas_video"
			t.ProviderRequestID = "original"
			t.RecoveryOutcome = &unrecoverable
		}), "", OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"图片超分沿用上游查询", with(func(t *model.Task) {
			t.Type = "canvas_image"
			t.Model = "topaz-standard-v2"
			t.ProviderRequestID = "upscale-req-1"
		}), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"图片超分确认无结果", with(func(t *model.Task) {
			t.Type = "canvas_image"
			t.Model = "topaz-standard-v2"
			t.ProviderRequestID = "upscale-req-1"
			t.RecoveryOutcome = &noResult
		}), "", OutcomeFacts{}, want("failed", "confirm", "no_result")},
		{"图片超分确认取不回", with(func(t *model.Task) {
			t.Type = "canvas_image"
			t.Model = "topaz-standard-v2"
			t.ProviderRequestID = "upscale-req-1"
			t.RecoveryOutcome = &unrecoverable
		}), "", OutcomeFacts{}, want("failed", "confirm", "result_unrecoverable")},
		{"BeefTV视频已结算失败允许直接重生成", with(func(t *model.Task) {
			u := "failed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-failed"
			t.RecoveryOutcome = &noResult
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("failed", "allowed", "no_result")},
		{"BeefTV视频待结算阻塞重生成并透传截止时间", with(func(t *model.Task) {
			u := "pending"
			dl := "2026-04-20T12:00:00Z"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-pending"
			t.RecoveryOutcome = &noResult
			t.BeefUsageState = &u
			t.BeefReconcileDeadline = &dl
		}), "", OutcomeFacts{}, Outcome{Phase: "failed", Regenerate: "blocked", Reason: "settlement_pending", ReconcileDeadline: "2026-04-20T12:00:00Z"}},
		{"BeefTV视频已扣费可取回阶段阻塞重生成", with(func(t *model.Task) {
			u := "completed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-completed"
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("retrievable", "blocked", "provider_result_pending")},
		{"BeefTV视频已扣费但结果无法取回需确认重生成", with(func(t *model.Task) {
			u := "completed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-completed"
			t.RecoveryOutcome = &unrecoverable
			t.BeefUsageState = &u
		}), "", OutcomeFacts{}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"BeefTV图片已退款允许直接重生成", with(func(t *model.Task) {
			b := "refunded"
			t.ImageJobID = "img-job-1"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "allowed", "no_result")},
		{"BeefTV图片已扣费可取回阶段阻塞重生成", with(func(t *model.Task) {
			b := "settled"
			t.ImageJobID = "img-job-2"
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("retrievable", "blocked", "image_recovery_pending")},
		{"BeefTV图片已扣费但结果无法取回需确认重生成", with(func(t *model.Task) {
			b := "settled"
			t.ImageJobID = "img-job-2"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "charged_result_unrecoverable")},
		{"BeefTV图片待结算空串阻塞重生成并透传截止时间", with(func(t *model.Task) {
			b := ""
			dl := "2026-04-20T12:30:00Z"
			t.ImageJobID = "img-job-3"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
			t.BeefReconcileDeadline = &dl
		}), "", OutcomeFacts{DispatchState: "accepted"}, Outcome{Phase: "failed", Regenerate: "blocked", Reason: "settlement_pending", ReconcileDeadline: "2026-04-20T12:30:00Z"}},
		{"BeefTV图片缺失billing_state键按第三方兜底需确认", with(func(t *model.Task) {
			t.ImageJobID = "img-job-no-billing-key"
			t.RecoveryOutcome = &unrecoverable
			t.BeefBillingState = nil
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "confirm", "result_unrecoverable")},
		{"BeefTV图片无job_id且未发出按第三方兜底允许重生成", with(func(t *model.Task) {
			t.BeefBillingState = nil
		}), "", OutcomeFacts{DispatchState: "not_sent"}, want("failed", "allowed", ReasonNotCharged)},
		{"Ark成片版权拦截且已退款标记输入拒绝并允许直接重生成", with(func(t *model.Task) {
			u := "failed"
			t.Type = "canvas_video"
			t.ProviderRequestID = "vid-policy"
			t.RecoveryOutcome = &noResult
			t.BeefUsageState = &u
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "OutputVideoSensitiveContentDetected.PolicyViolation"}
		}), "", OutcomeFacts{}, want("failed", "allowed", "input_rejected")},
		{"Ark参考图隐私拦截且图片已退款标记输入拒绝并允许直接重生成", with(func(t *model.Task) {
			b := "refunded"
			t.ImageJobID = "img-policy"
			t.RecoveryOutcome = &noResult
			t.BeefBillingState = &b
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "InputImageSensitiveContentDetected.PrivacyInformation"}
		}), "", OutcomeFacts{DispatchState: "accepted"}, want("failed", "allowed", "input_rejected")},
		{"Ark策略拦截无Beef结算字段按需确认处理", with(func(t *model.Task) {
			t.FailureDiagnostics = &model.TaskFailureDiagnostics{ProviderCode: "OutputVideoSensitiveContentDetected.PolicyViolation"}
		}), "", OutcomeFacts{}, want("failed", "confirm", "input_rejected")},
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

func TestCancelledUnconfirmedImageLeavesActiveList(t *testing.T) {
	task := model.Task{ID: "cancelled-image", Type: "canvas_image", Status: model.TaskStatusCancelled}
	outcome := ComputeOutcome(task, "", OutcomeFacts{DispatchState: "submission_unknown"})
	active := Outcome{Phase: "running", Regenerate: "blocked", Reason: "task_running"}
	got := filterActiveTaskSummaries([]Summary{
		{ID: task.ID, Status: task.Status, Outcome: &outcome},
		{ID: "running-image", Status: model.TaskStatusRunning, Outcome: &active},
	}, 30)
	if len(got) != 1 || got[0].ID != "running-image" {
		t.Fatalf("active summaries = %+v", got)
	}
	if outcome.Regenerate != "confirm" || !RegenerableFailure(outcome) {
		t.Fatalf("unconfirmed cancellation should require explicit confirmation instead of deadlocking node: %+v", outcome)
	}
}

func TestCancelledMediaResultUnconfirmed(t *testing.T) {
	for _, kind := range []string{"canvas_image", "canvas_video", "canvas_audio", "video_subtitle_erase"} {
		t.Run(kind, func(t *testing.T) {
			task := model.Task{Type: kind, Status: model.TaskStatusCancelled, ProviderRequestID: "original-request", ProviderCancelStatus: model.ProviderCancelStatusUncertain}
			got := ComputeOutcome(task, "", OutcomeFacts{})
			if got != (Outcome{Phase: "failed", Regenerate: "confirm", Reason: "cancelled_result_unconfirmed"}) {
				t.Fatalf("cancelled task outcome = %+v", got)
			}
			if isActiveTaskSummary(Summary{Status: task.Status, Outcome: &got}) {
				t.Fatal("unconfirmed cancellation must not poll as active")
			}
			if !RegenerableFailure(got) {
				t.Fatal("unconfirmed cancellation must remain confirm-regenerable instead of bricking the node")
			}
		})
		t.Run(kind+"-accepted-without-provider-id", func(t *testing.T) {
			task := model.Task{Type: kind, Status: model.TaskStatusCancelled}
			got := ComputeOutcome(task, "", OutcomeFacts{DispatchState: "accepted"})
			if got != (Outcome{Phase: "failed", Regenerate: "confirm", Reason: "cancelled_result_unconfirmed"}) {
				t.Fatalf("cancelled accepted %s outcome = %+v", kind, got)
			}
		})
	}
	task := model.Task{Type: "canvas_image", Model: "topaz-standard-v2", Status: model.TaskStatusCancelled, ProviderRequestID: "upscale-original"}
	got := ComputeOutcome(task, "", OutcomeFacts{})
	if got.Phase != "failed" || got.Reason != "cancelled_result_unconfirmed" || got.Regenerate != "confirm" {
		t.Fatalf("cancelled upscale outcome = %+v", got)
	}
	upscaleAccepted := ComputeOutcome(model.Task{Type: "canvas_image", Model: "topaz-standard-v2", Status: model.TaskStatusCancelled}, "", OutcomeFacts{DispatchState: "accepted"})
	if upscaleAccepted != (Outcome{Phase: "failed", Regenerate: "confirm", Reason: "cancelled_result_unconfirmed"}) {
		t.Fatalf("cancelled accepted upscale outcome = %+v", upscaleAccepted)
	}
	unreadable := ComputeOutcome(model.Task{Type: "canvas_image", Status: model.TaskStatusCancelled}, "", OutcomeFacts{Unreadable: true})
	if unreadable != (Outcome{Phase: "retrievable", Regenerate: "blocked", Reason: "evidence_unavailable"}) {
		t.Fatalf("cancelled unreadable outcome = %+v", unreadable)
	}
	if !isActiveTaskSummary(Summary{Status: model.TaskStatusCancelled, Outcome: &unreadable}) {
		t.Fatal("cancelled unreadable task must remain active until evidence can be read")
	}
}

func TestCanvasFailureScanRefreshesWhenProviderCancelStatusChanges(t *testing.T) {
	scan := &CanvasFailureScan{
		checked: map[string]canvasFailureCheck{
			"cancelled-task": {
				outcome:              Outcome{Phase: "failed", Regenerate: "confirm", Reason: ReasonCancelledResultUnconfirmed},
				providerCancelStatus: model.ProviderCancelStatusRequested,
				revision:             7,
			},
		},
	}
	outcome := Outcome{Phase: "failed", Regenerate: "confirm", Reason: ReasonCancelledResultUnconfirmed}
	if !scan.unchanged([]model.Task{{ID: "cancelled-task", ProviderCancelStatus: model.ProviderCancelStatusRequested}}, []Outcome{outcome}, 7) {
		t.Fatal("same outcome, providerCancelStatus, and revision should be treated as unchanged")
	}
	if scan.unchanged([]model.Task{{ID: "cancelled-task", ProviderCancelStatus: model.ProviderCancelStatusConfirmed}}, []Outcome{outcome}, 7) {
		t.Fatal("transitioning providerCancelStatus from requested to confirmed must trigger a canvas node refresh")
	}
}

type boundedUnreadableFallbackStore struct {
	*memStore
	terminalTasks []model.Task
	fallbackCalls int
}

func (s *boundedUnreadableFallbackStore) EvidenceReadable() bool { return false }

func (s *boundedUnreadableFallbackStore) ListActiveCandidatesAfter(string, string, *time.Time, string, int) ([]model.Task, error) {
	return nil, nil
}

func (s *boundedUnreadableFallbackStore) ListTerminalForUnreadableEvidenceAfter(_ string, _ string, beforeCreatedAt *time.Time, beforeID string, limit int) ([]model.Task, error) {
	s.fallbackCalls++
	out := make([]model.Task, 0, limit)
	for _, task := range s.terminalTasks {
		if beforeCreatedAt != nil {
			if task.CreatedAt.After(*beforeCreatedAt) || (task.CreatedAt.Equal(*beforeCreatedAt) && task.ID >= beforeID) {
				continue
			}
		}
		out = append(out, task)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func TestActiveOnlyUnreadableFallbackIsHardBoundedByPageBudget(t *testing.T) {
	now := time.Now().UTC()
	terminal := make([]model.Task, 0, 500)
	for i := 500; i > 0; i-- {
		ts := now.Add(time.Duration(i) * time.Second)
		terminal = append(terminal, model.Task{
			ID:        fmt.Sprintf("cancelled-non-active-%03d", i),
			UserID:    "u1",
			Type:      "canvas_text",
			Status:    model.TaskStatusCancelled,
			CreatedAt: ts,
			UpdatedAt: ts,
		})
	}
	store := &boundedUnreadableFallbackStore{
		memStore:      newMemStore(),
		terminalTasks: terminal,
	}
	svc := NewService(store, Dependencies{Present: identityPresent{}})
	got, err := svc.list("u1", ListOptions{Limit: 50, ActiveOnly: true})
	if err != nil {
		t.Fatalf("List(activeOnly=true) error = %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d active summaries, want 0", len(got))
	}
	if store.fallbackCalls != 2 {
		t.Fatalf("unreadable fallback paged %d times across 500 terminal rows, want hard cap 2", store.fallbackCalls)
	}
}
