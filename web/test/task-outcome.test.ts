import { describe, expect, it } from "bun:test";
import {
    canRecoverTaskOutcome,
    canRegenerateTaskOutcome,
    canReloadCanvasNodeResource,
    canvasNodeHasPendingOutcomeResult,
    deliveryPendingTaskOutcome,
    fetchingTaskOutcome,
    formatReconcileDeadlineCopy,
    isNodeRegenerateBlocked,
    isNodeRegenerateConfirm,
    isRegenerateAllowed,
    isRegenerateBlocked,
    isRegenerateConfirm,
    isTaskOutcomeFailed,
    isTaskOutcomeReady,
    isTaskOutcomeReconciling,
    isTaskOutcomeRetrievable,
    isTaskOutcomeRunningOrFetching,
    isTaskOutcomeSubmissionUncertain,
    isTaskOutcomeWorking,
    isTaskRegenerateBlocked,
    nodeRequiresRegenerateConfirmation,
    normalizeTaskOutcome,
    notChargedTaskOutcome,
    readNodeTaskOutcome,
    readTaskOutcome,
    readyTaskOutcome,
    resultTargetUnavailableTaskOutcome,
    runningTaskOutcome,
    submissionUnknownTaskOutcome,
    taskOutcomeCopy,
    taskRequiresRegenerateConfirmation,
    type TaskOutcome,
    type TaskOutcomePhase,
    type TaskOutcomeRegenerate,
} from "@/lib/task-outcome";

describe("task-outcome", () => {
    it("keeps unconfirmed cancellation out of active work while requiring explicit confirmation to regenerate", () => {
        const outcome: TaskOutcome = { phase: "failed", regenerate: "confirm", reason: "cancelled_result_unconfirmed" };
        expect(isTaskOutcomeWorking(outcome)).toBe(false);
        expect(canRecoverTaskOutcome(outcome)).toBe(false);
        expect(isRegenerateBlocked(outcome)).toBe(false);
        expect(isRegenerateConfirm(outcome)).toBe(true);
        expect(canRegenerateTaskOutcome(outcome)).toBe(true);
        const copy = taskOutcomeCopy(outcome);
        expect(copy.badge).toBe("结果待确认");
        expect(copy.message).toContain("核对原请求");
        expect(copy.message).not.toContain("正在");
        expect(copy.confirmTitle).toBe("确认重新生成？");
        expect(copy.confirmContent).toContain("再扣一次");

        // Legacy fallback without explicit outcome stays consistent with backend projection.
        expect(readTaskOutcome({ status: "cancelled", stage: "submission_unknown" })).toEqual(outcome);
        expect(readTaskOutcome({ status: "cancelled", providerRequestId: "req-1" })).toEqual(outcome);
        expect(readTaskOutcome({ status: "cancelled", errorCode: "submission_uncertain" })).toEqual(outcome);
        expect(readTaskOutcome({ status: "cancelled" })).toEqual({ phase: "failed", regenerate: "confirm", reason: "task_failed" });
        expect(isRegenerateConfirm(readTaskOutcome({ status: "cancelled" }))).toBe(true);
        expect(readTaskOutcome({ status: "failed" })).toEqual({ phase: "failed", regenerate: "confirm", reason: "task_failed" });
        expect(isRegenerateConfirm(readTaskOutcome({ status: "failed" }))).toBe(true);
        expect(readTaskOutcome({ status: "failed", type: "depth_capture" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readTaskOutcome({ status: "failed", type: "depth_capture", stage: "submission_unknown" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readTaskOutcome({ status: "cancelled", type: "depth_capture", stage: "submission_unknown" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readTaskOutcome({ status: "cancelled", type: "depth_capture", stage: "delivery_paused" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readTaskOutcome({ status: "cancelled", type: "depth_capture", errorCode: "download_failed" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readTaskOutcome({ status: "failed", type: "depth_capture", errorCode: "submission_uncertain" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readTaskOutcome({ status: "failed", type: "depth_capture", errorCode: "download_failed" })).toEqual(deliveryPendingTaskOutcome());
        expect(readTaskOutcome({ status: "failed", errorCode: "request_not_sent" })).toEqual(notChargedTaskOutcome());
        expect(readTaskOutcome({ status: "cancelled", errorCode: "request_not_sent" })).toEqual(notChargedTaskOutcome());
        expect(readTaskOutcome({ status: "cancelled", stage: "request_not_sent" })).toEqual(notChargedTaskOutcome());

        expect(readNodeTaskOutcome({ taskStatus: "cancelled", taskStage: "submission_unknown" })).toEqual(outcome);
        expect(readNodeTaskOutcome({ taskStatus: "cancelled", generationSubmissionState: "unknown" })).toEqual(outcome);
        expect(readNodeTaskOutcome({ taskStatus: "cancelled", generationErrorCode: "submission_uncertain" })).toEqual(outcome);
        expect(readNodeTaskOutcome({ taskStatus: "cancelled", taskProviderRequestId: "req-1" })).toEqual(outcome);
        expect(isNodeRegenerateConfirm({ taskStatus: "cancelled", taskProviderRequestId: "req-1" })).toBe(true);
        expect(readNodeTaskOutcome({ status: "loading", taskStatus: "cancelled" })).toEqual({ phase: "failed", regenerate: "confirm", reason: "task_failed" });
        expect(readNodeTaskOutcome({ status: "loading", taskStatus: "cancelled", taskProviderRequestId: "req-1" })).toEqual(outcome);
        expect(readNodeTaskOutcome({ status: "loading", taskStatus: "failed" })).toEqual({ phase: "failed", regenerate: "confirm", reason: "task_failed" });
        expect(isNodeRegenerateConfirm({ status: "loading", taskStatus: "failed" })).toBe(true);
        expect(readNodeTaskOutcome({ status: "loading", taskStatus: "failed", taskType: "depth_capture" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readNodeTaskOutcome({ taskType: "depth_capture", taskStatus: "failed", generationSubmissionState: "unknown" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readNodeTaskOutcome({ taskType: "depth_capture", taskStatus: "cancelled", taskStage: "submission_unknown" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readNodeTaskOutcome({ taskType: "depth_capture", taskStatus: "cancelled", generationErrorCode: "download_failed" })).toEqual({ phase: "failed", regenerate: "allowed", reason: "task_failed" });
        expect(readNodeTaskOutcome({ taskType: "depth_capture", taskStatus: "failed", generationErrorCode: "download_failed" })).toEqual(deliveryPendingTaskOutcome());
        expect(readNodeTaskOutcome({ status: "loading", taskStatus: "failed", taskProviderRequestId: "req-1" })).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" });
        expect(readNodeTaskOutcome({ status: "loading", taskStatus: "text_replay" })).toEqual({ phase: "failed", regenerate: "confirm", reason: "task_failed" });
        expect(readNodeTaskOutcome({ taskStatus: "cancelled" })).toEqual({ phase: "failed", regenerate: "confirm", reason: "task_failed" });
        expect(isNodeRegenerateConfirm({ taskStatus: "cancelled" })).toBe(true);
        expect(readNodeTaskOutcome({ taskStatus: "cancelled", generationErrorCode: "request_not_sent" })).toEqual(notChargedTaskOutcome());
        expect(readNodeTaskOutcome({ taskStatus: "cancelled", taskStage: "request_not_sent" })).toEqual(notChargedTaskOutcome());

        const confirmedCopy = taskOutcomeCopy(outcome, undefined, { providerCancelStatus: "confirmed" });
        expect(confirmedCopy.badge).toBe("已取消");
        expect(confirmedCopy.reason).toContain("上游已确认取消");
        expect(confirmedCopy.message).toContain("扣费");
        expect(confirmedCopy.confirmContent).toContain("再扣一次");
    });
    it("recognizes all 5 phase values and 3 regenerate values", () => {
        const phases: TaskOutcomePhase[] = ["running", "fetching", "ready", "retrievable", "failed"];
        const regenerates: TaskOutcomeRegenerate[] = ["allowed", "confirm", "blocked"];

        for (const phase of phases) {
            for (const regenerate of regenerates) {
                const outcome = normalizeTaskOutcome({
                    phase,
                    regenerate,
                    reason: `${phase}_${regenerate}`,
                });
                expect(outcome).toEqual({
                    phase,
                    regenerate,
                    reason: `${phase}_${regenerate}`,
                });
            }
        }

        expect(isTaskOutcomeWorking({ phase: "running", regenerate: "blocked", reason: "task_running" })).toBe(true);
        expect(isTaskOutcomeWorking({ phase: "fetching", regenerate: "blocked", reason: "result_fetching" })).toBe(true);
        expect(isTaskOutcomeWorking({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" })).toBe(true);
        expect(isTaskOutcomeWorking({ phase: "ready", regenerate: "allowed", reason: "result_ready" })).toBe(false);
        expect(isTaskOutcomeWorking({ phase: "failed", regenerate: "allowed", reason: "no_result" })).toBe(false);

        expect(isTaskOutcomeRunningOrFetching({ phase: "running", regenerate: "blocked", reason: "task_running" })).toBe(true);
        expect(isTaskOutcomeRunningOrFetching({ phase: "fetching", regenerate: "blocked", reason: "result_fetching" })).toBe(true);
        expect(isTaskOutcomeRunningOrFetching({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" })).toBe(false);

        expect(isTaskOutcomeRetrievable({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" })).toBe(true);
        expect(isTaskOutcomeReady({ phase: "ready", regenerate: "allowed", reason: "result_ready" })).toBe(true);
        expect(isTaskOutcomeFailed({ phase: "failed", regenerate: "allowed", reason: "no_result" })).toBe(true);
    });

    it("ignores conflicting status/stage/errorCode/error text when task.outcome or metadata.taskOutcome is present", () => {
        // Task has status=failed & stage=submission_unknown & errorCode=download_failed,
        // but backend outcome says failed + allowed -> must strictly follow outcome
        const allowedOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "allowed",
            reason: "not_charged",
        };
        const taskWithAllowedOutcome = {
            status: "failed",
            stage: "submission_unknown",
            errorCode: "download_failed",
            error: "下载超时，结果仍保留在服务器",
            outcome: allowedOutcome,
        };
        expect(readTaskOutcome(taskWithAllowedOutcome)).toEqual(allowedOutcome);
        expect(isTaskRegenerateBlocked(taskWithAllowedOutcome)).toBe(false);
        expect(isRegenerateAllowed(readTaskOutcome(taskWithAllowedOutcome))).toBe(true);

        // Task has status=succeeded, but backend outcome says retrievable + blocked -> must follow outcome
        const retrievableOutcome: TaskOutcome = {
            phase: "retrievable",
            regenerate: "blocked",
            reason: "delivery_pending",
        };
        const taskWithRetrievableOutcome = {
            status: "succeeded",
            stage: "done",
            outcome: retrievableOutcome,
        };
        expect(readTaskOutcome(taskWithRetrievableOutcome)).toEqual(retrievableOutcome);
        expect(isTaskRegenerateBlocked(taskWithRetrievableOutcome)).toBe(true);
        expect(canRecoverTaskOutcome(readTaskOutcome(taskWithRetrievableOutcome))).toBe(true);

        // Canvas node has generationErrorCode=download_failed & generationSubmissionState=unknown,
        // but metadata.taskOutcome says failed + confirm -> must strictly follow metadata.taskOutcome
        const confirmOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "confirm",
            reason: "result_unrecoverable",
        };
        const nodeMetadata = {
            taskId: "task_123",
            taskStatus: "running",
            taskStage: "submission_unknown",
            generationSubmissionState: "unknown",
            generationErrorCode: "download_failed",
            errorDetails: "画布版本冲突，结果未写回",
            taskOutcome: confirmOutcome,
        };
        expect(readNodeTaskOutcome(nodeMetadata)).toEqual(confirmOutcome);
        expect(isNodeRegenerateBlocked(nodeMetadata)).toBe(false);
        expect(isNodeRegenerateConfirm(nodeMetadata)).toBe(true);
        expect(canReloadCanvasNodeResource(nodeMetadata)).toBe(false);
    });

    it("evaluates regenerate permissions and node resource reload eligibility from outcome", () => {
        const blockedOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "blocked",
            reason: "settlement_pending",
            reconcileDeadline: "2026-04-20T14:35:00.000Z",
        };
        expect(isRegenerateBlocked(blockedOutcome)).toBe(true);
        expect(isRegenerateConfirm(blockedOutcome)).toBe(false);
        expect(isRegenerateAllowed(blockedOutcome)).toBe(false);
        expect(canRegenerateTaskOutcome(blockedOutcome)).toBe(false);

        const confirmOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "confirm",
            reason: "charged_result_unrecoverable",
        };
        expect(isRegenerateBlocked(confirmOutcome)).toBe(false);
        expect(isRegenerateConfirm(confirmOutcome)).toBe(true);
        expect(isRegenerateAllowed(confirmOutcome)).toBe(false);
        expect(canRegenerateTaskOutcome(confirmOutcome)).toBe(true);

        const allowedOutcome: TaskOutcome = {
            phase: "failed",
            regenerate: "allowed",
            reason: "no_result",
        };
        expect(isRegenerateBlocked(allowedOutcome)).toBe(false);
        expect(isRegenerateConfirm(allowedOutcome)).toBe(false);
        expect(isRegenerateAllowed(allowedOutcome)).toBe(true);
        expect(canRegenerateTaskOutcome(allowedOutcome)).toBe(true);

        // Standalone node with retrievable outcome can reload resource
        expect(
            canReloadCanvasNodeResource({
                taskId: "task_recover_1",
                taskOutcome: {
                    phase: "retrievable",
                    regenerate: "blocked",
                    reason: "delivery_pending",
                },
            }),
        ).toBe(true);

        // Batch child node with batchRootId must not expose manual reload button
        expect(
            canReloadCanvasNodeResource({
                taskId: "task_recover_child",
                batchRootId: "node_batch_root",
                taskOutcome: {
                    phase: "retrievable",
                    regenerate: "blocked",
                    reason: "delivery_pending",
                },
            }),
        ).toBe(false);

        // Parent node detects pending outcome result on batch child
        const rootNode = {
            id: "node_batch_root",
            metadata: {
                batchChildIds: ["node_child_1"],
                taskOutcome: {
                    phase: "ready" as const,
                    regenerate: "allowed" as const,
                    reason: "result_ready",
                },
            },
        };
        const childNode = {
            id: "node_child_1",
            metadata: {
                batchRootId: "node_batch_root",
                taskOutcome: {
                    phase: "retrievable" as const,
                    regenerate: "blocked" as const,
                    reason: "image_recovery_pending",
                },
            },
        };
        expect(canvasNodeHasPendingOutcomeResult(rootNode, [rootNode, childNode])).toBe(true);
    });

    it("formats reconcileDeadline copy for future and expired deadlines and never leaks internal tokens", () => {
        const nowMs = Date.parse("2026-04-20T06:00:00.000Z");
        const futureIso = new Date(nowMs + 15 * 60_000).toISOString();
        const expiredIso = new Date(nowMs - 60_000).toISOString();

        const futureCopy = formatReconcileDeadlineCopy(futureIso, nowMs);
        expect(futureCopy).toMatch(/^BeefTV 正在核对上次提交，预计 \d{2}:\d{2} 前有结论$/);

        const expiredCopy = formatReconcileDeadlineCopy(expiredIso, nowMs);
        expect(expiredCopy).toBe("BeefTV 正在核对，已超过预计时间，可联系客服");

        const confirmUncertain = taskOutcomeCopy(
            {
                phase: "failed",
                regenerate: "confirm",
                reason: "result_unrecoverable",
            },
            nowMs,
        );
        expect(confirmUncertain.reason).toBe("无法确认上次是否已扣费，可先到模型服务后台查看使用记录");
        expect(confirmUncertain.confirmContent).toContain("重新生成可能会再扣一次");

        const confirmCharged = taskOutcomeCopy(
            {
                phase: "failed",
                regenerate: "confirm",
                reason: "charged_result_unrecoverable",
            },
            nowMs,
        );
        expect(confirmCharged.reason).toBe("上次已扣费，但结果拿不回，重新生成会再扣一次");

        const forbiddenTokens = [
            "BeefAPI",
            "beefapi",
            "usage_state",
            "billing_state",
            "reconcile_deadline",
            "pending",
            "settled",
            "refunded",
            "routeRun",
            "operationId",
            "no_result",
            "unrecoverable",
        ];

        const sampleOutcomes: TaskOutcome[] = [
            { phase: "running", regenerate: "blocked", reason: "task_running" },
            { phase: "fetching", regenerate: "blocked", reason: "result_fetching" },
            { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            { phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" },
            { phase: "retrievable", regenerate: "blocked", reason: "image_recovery_pending" },
            { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" },
            { phase: "retrievable", regenerate: "blocked", reason: "evidence_unavailable" },
            { phase: "failed", regenerate: "blocked", reason: "settlement_pending", reconcileDeadline: futureIso },
            { phase: "failed", regenerate: "blocked", reason: "billing_pending", reconcileDeadline: expiredIso },
            { phase: "failed", regenerate: "blocked", reason: "reconcile_pending" },
            { phase: "failed", regenerate: "blocked", reason: "result_target_unavailable" },
            { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" },
            { phase: "failed", regenerate: "confirm", reason: "charged_result_unrecoverable" },
            { phase: "failed", regenerate: "confirm", reason: "input_rejected" },
            { phase: "failed", regenerate: "allowed", reason: "no_result" },
            { phase: "failed", regenerate: "allowed", reason: "refunded" },
            { phase: "failed", regenerate: "allowed", reason: "not_charged" },
            { phase: "failed", regenerate: "allowed", reason: "task_failed" },
        ];

        for (const outcome of sampleOutcomes) {
            const copy = taskOutcomeCopy(outcome, nowMs);
            const combined = [copy.badge, copy.reason, copy.action, copy.message, copy.confirmTitle ?? "", copy.confirmContent ?? ""].join(" ");
            for (const token of forbiddenTokens) {
                expect(combined).not.toContain(token);
            }
        }
    });

    it("provides canonical constructors and reconciling/submission-uncertain predicates", () => {
        expect(runningTaskOutcome()).toEqual({ phase: "running", regenerate: "blocked", reason: "task_running" });
        expect(fetchingTaskOutcome()).toEqual({ phase: "fetching", regenerate: "blocked", reason: "result_fetching" });
        expect(readyTaskOutcome()).toEqual({ phase: "ready", regenerate: "allowed", reason: "result_ready" });
        expect(deliveryPendingTaskOutcome()).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "delivery_pending" });
        expect(submissionUnknownTaskOutcome()).toEqual({ phase: "retrievable", regenerate: "blocked", reason: "submission_unknown" });
        expect(notChargedTaskOutcome()).toEqual({ phase: "failed", regenerate: "allowed", reason: "not_charged" });
        expect(resultTargetUnavailableTaskOutcome()).toEqual({ phase: "failed", regenerate: "blocked", reason: "result_target_unavailable" });

        expect(isTaskOutcomeReconciling({ phase: "failed", regenerate: "blocked", reason: "settlement_pending" })).toBe(true);
        expect(isTaskOutcomeReconciling({ phase: "failed", regenerate: "blocked", reason: "billing_pending" })).toBe(true);
        expect(isTaskOutcomeReconciling({ phase: "failed", regenerate: "blocked", reason: "reconcile_pending" })).toBe(true);
        expect(isTaskOutcomeReconciling(resultTargetUnavailableTaskOutcome())).toBe(false);

        expect(isTaskOutcomeSubmissionUncertain(submissionUnknownTaskOutcome())).toBe(true);
        expect(isTaskOutcomeSubmissionUncertain({ phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" })).toBe(true);
        expect(isTaskOutcomeSubmissionUncertain(deliveryPendingTaskOutcome())).toBe(false);
        expect(isTaskOutcomeSubmissionUncertain({ phase: "failed", regenerate: "blocked", reason: "settlement_pending" })).toBe(true);
        expect(isTaskOutcomeSubmissionUncertain(notChargedTaskOutcome())).toBe(false);
    });

    it("suppresses reload on cancelled evidence_unavailable nodes and requires confirmation when cancel is requested or uncertain", () => {
        const cancelledEvidenceMeta = {
            taskId: "task-cancelled-unreadable",
            taskStatus: "cancelled",
            taskOutcome: { phase: "retrievable" as const, regenerate: "blocked" as const, reason: "evidence_unavailable" },
        };
        expect(canReloadCanvasNodeResource(cancelledEvidenceMeta)).toBe(false);
        expect(isNodeRegenerateBlocked(cancelledEvidenceMeta)).toBe(true);
        expect(
            canReloadCanvasNodeResource({
                ...cancelledEvidenceMeta,
                taskStatus: "failed",
            }),
        ).toBe(true);

        const allowedOutcome: TaskOutcome = { phase: "failed", regenerate: "allowed", reason: "task_failed" };
        expect(taskRequiresRegenerateConfirmation({ outcome: allowedOutcome, providerCancelStatus: "requested" })).toBe(true);
        expect(taskRequiresRegenerateConfirmation({ outcome: allowedOutcome, providerCancelStatus: "uncertain" })).toBe(true);
        expect(taskRequiresRegenerateConfirmation({ outcome: allowedOutcome, providerCancelStatus: "confirmed" })).toBe(false);
        expect(
            nodeRequiresRegenerateConfirmation({
                taskId: "task-req-1",
                taskStatus: "cancelled",
                taskProviderCancelStatus: "requested",
                taskOutcome: allowedOutcome,
            }),
        ).toBe(true);
        expect(
            isNodeRegenerateConfirm({
                taskId: "task-req-1",
                taskStatus: "cancelled",
                taskProviderCancelStatus: "requested",
                taskOutcome: allowedOutcome,
            }),
        ).toBe(true);
        expect(
            isNodeRegenerateConfirm({
                taskId: "task-unc-1",
                taskStatus: "cancelled",
                taskProviderCancelStatus: "uncertain",
                taskOutcome: allowedOutcome,
            }),
        ).toBe(true);

        const requestedAllowedCopy = taskOutcomeCopy(allowedOutcome, undefined, { providerCancelStatus: "requested" });
        expect(requestedAllowedCopy.badge).toBe("取消待确认");
        expect(requestedAllowedCopy.confirmTitle).toContain("取消仍在确认中");
        expect(requestedAllowedCopy.confirmContent).toContain("可能会再扣一次");
        const uncertainAllowedCopy = taskOutcomeCopy(allowedOutcome, undefined, { providerCancelStatus: "uncertain" });
        expect(uncertainAllowedCopy.badge).toBe("取消待确认");
        expect(uncertainAllowedCopy.confirmTitle).toContain("未能确认取消");
        expect(uncertainAllowedCopy.confirmContent).toContain("可能会再扣一次");
        const uncertainConfirmCopy = taskOutcomeCopy(
            { phase: "failed", regenerate: "confirm", reason: "cancelled_result_unconfirmed" },
            undefined,
            { providerCancelStatus: "uncertain" },
        );
        expect(uncertainConfirmCopy.badge).toBe("取消待确认");
        expect(uncertainConfirmCopy.confirmTitle).toContain("未能确认取消");
        expect(uncertainConfirmCopy.confirmContent).toContain("可能会再扣一次");
    });

    it("treats generationSubmissionState=submitting without explicit terminal state as running and blocks regeneration", () => {
        expect(readNodeTaskOutcome({ generationSubmissionState: "submitting" })).toEqual(runningTaskOutcome());
        expect(readNodeTaskOutcome({ status: "error", generationSubmissionState: "submitting" })).toEqual(runningTaskOutcome());
        expect(isTaskOutcomeWorking(readNodeTaskOutcome({ status: "error", generationSubmissionState: "submitting" }))).toBe(true);
        expect(isNodeRegenerateBlocked({ status: "error", generationSubmissionState: "submitting" })).toBe(true);

        // Authoritative backend taskOutcome or explicit terminal taskStatus still takes precedence.
        expect(
            readNodeTaskOutcome({
                status: "error",
                generationSubmissionState: "submitting",
                taskOutcome: notChargedTaskOutcome(),
            }),
        ).toEqual(notChargedTaskOutcome());
        expect(
            readNodeTaskOutcome({
                status: "error",
                generationSubmissionState: "submitting",
                taskStatus: "failed",
                generationErrorCode: "request_not_sent",
            }),
        ).toEqual(notChargedTaskOutcome());
    });
});
