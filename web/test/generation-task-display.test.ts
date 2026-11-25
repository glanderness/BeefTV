import { expect, test } from "bun:test";
import { generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel } from "@/lib/generation-task-display";
import { canBatchRetryTaskInTaskCenter, canQueryProviderTask, checkTaskCanvasAvailability, providerCancelStatusLabel, resolveTaskCenterNewSubmissionRoute, taskAttentionReason, taskCenterRetryRequiresNewSubmission, taskOutcomeCopyForTask } from "@/pages/tasks/task-shared";
import { ApiError } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";

test("cancelled image with unconfirmed result does not claim recovery is running", () => {
    const task = {
        id: "cancelled-1",
        type: "canvas_image",
        status: "cancelled" as const,
        stage: "任务已取消",
        createdAt: "2026-11-20T00:00:00Z",
        updatedAt: "2026-11-20T00:00:00Z",
        attempts: 1,
        outcome: { phase: "failed" as const, regenerate: "confirm" as const, reason: "cancelled_result_unconfirmed" },
    } as GenerationTask;
    expect(generationTaskStatusLabel(task)).toBe("结果待确认");
    expect(generationTaskStageLabel(task)).toBe("任务已取消，无法确认上游是否已生成或扣费");
    expect(generationTaskShowsProgress(task)).toBe(false);
    expect(taskAttentionReason(task)).toContain("核对原请求状态");
    expect(providerCancelStatusLabel(task)).toContain("核对原请求状态");
    const confirmedTask = { ...task, providerCancelStatus: "confirmed" as const };
    expect(generationTaskStatusLabel(confirmedTask)).toBe("已取消");
    expect(generationTaskStageLabel(confirmedTask)).toBe("上游已确认取消，请核对渠道后台确认是否已扣费");
    expect(taskAttentionReason(confirmedTask)).toContain("上游已确认取消");
    expect(taskAttentionReason(confirmedTask)).not.toContain("无法确认上游是否已生成");
    expect(providerCancelStatusLabel(confirmedTask)).toBe("上游已确认取消，请核对渠道后台确认是否已扣费");
    const confirmedModalCopy = taskOutcomeCopyForTask(confirmedTask);
    expect(confirmedModalCopy.confirmTitle).toBe("确认重新生成？");
    expect(confirmedModalCopy.confirmContent).toContain("上游已确认取消");
    expect(confirmedModalCopy.confirmContent).not.toContain("无法确认渠道是否已执行");
    expect(providerCancelStatusLabel({ ...task, outcome: undefined, providerCancelStatus: "confirmed" })).toBe("上游已确认取消");
    expect(providerCancelStatusLabel({ ...task, outcome: undefined })).toBe("任务已取消，请核对原任务的结果与扣费状态");

    // requested/uncertain providerCancelStatus must not be shadowed when outcome=cancelled_result_unconfirmed is present.
    const requestedTask = { ...task, providerCancelStatus: "requested" as const };
    expect(providerCancelStatusLabel(requestedTask)).toBe("已请求上游取消，正在等待确认");
    expect(generationTaskStatusLabel(requestedTask)).toBe("取消待确认");
    expect(generationTaskStageLabel(requestedTask)).toBe("已请求上游取消，正在等待确认");
    const uncertainTask = { ...task, providerCancelStatus: "uncertain" as const, providerCancelError: "上游超时未返回取消结果" };
    expect(providerCancelStatusLabel(uncertainTask)).toBe("上游超时未返回取消结果");
    expect(generationTaskStatusLabel(uncertainTask)).toBe("取消待确认");

    // Allowed outcome with requested/uncertain providerCancelStatus surfaces consistent stage & attention copy (even when error/stage exist).
    const allowedRequestedCancel = {
        ...task,
        error: "任务已取消",
        providerCancelStatus: "requested" as const,
        outcome: { phase: "failed" as const, regenerate: "allowed" as const, reason: "task_failed" },
    };
    expect(generationTaskStatusLabel(allowedRequestedCancel)).toBe("取消待确认");
    expect(generationTaskStageLabel(allowedRequestedCancel)).toBe("已请求上游取消，正在等待确认");
    expect(taskAttentionReason(allowedRequestedCancel)).toContain("正在等待确认");
    expect(taskAttentionReason(allowedRequestedCancel)).toContain("可能会再扣一次");
    const allowedUncertainCancel = { ...allowedRequestedCancel, providerCancelStatus: "uncertain" as const };
    expect(generationTaskStatusLabel(allowedUncertainCancel)).toBe("取消待确认");
    expect(generationTaskStageLabel(allowedUncertainCancel)).toBe("上游无法确认取消，状态待确认");
    expect(taskAttentionReason(allowedUncertainCancel)).toContain("上游无法确认取消");

    // Cancelled tasks with evidence_unavailable must never expose the RecoverTask button (backend rejects cancelled /recover).
    const cancelledUnreadable = {
        ...task,
        status: "cancelled" as const,
        outcome: { phase: "retrievable" as const, regenerate: "blocked" as const, reason: "evidence_unavailable" },
    };
    expect(canQueryProviderTask(cancelledUnreadable)).toBe(false);
    expect(canQueryProviderTask({ ...cancelledUnreadable, status: "failed" as const })).toBe(true);

    // Task-center retry must never invoke in-place /retry for confirm, submission_unknown, or submitted image tasks.
    expect(taskCenterRetryRequiresNewSubmission(task)).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...task, model: "topaz-standard-v2" })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...task, outcome: { phase: "failed", regenerate: "allowed", reason: "refunded" } })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...task, outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" } })).toBe(false);
    expect(taskCenterRetryRequiresNewSubmission({ ...task, type: "canvas_video" })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...task, type: "canvas_video", stage: "submission_unknown", outcome: { phase: "failed", regenerate: "allowed", reason: "task_failed" } })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...task, type: "canvas_video", outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" } })).toBe(false);

    expect(canBatchRetryTaskInTaskCenter(task)).toBe(false);
    expect(canBatchRetryTaskInTaskCenter({ ...task, type: "canvas_video", outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" } })).toBe(true);
    expect(canBatchRetryTaskInTaskCenter({ ...task, outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" } })).toBe(true);

    // Allowed video/audio tasks whose error category triggers backend BlocksRetry or moderation must not invoke in-place /retry.
    const allowedVideoBase = {
        ...task,
        type: "canvas_video",
        status: "failed" as const,
        stage: "生成失败",
        outcome: { phase: "failed" as const, regenerate: "allowed" as const, reason: "task_failed" },
    } as GenerationTask;
    for (const errorCode of ["download_failed", "invalid_params", "moderation_input", "timeout", "quota_user", "auth"]) {
        const blockedByBackend = { ...allowedVideoBase, errorCode };
        expect(taskCenterRetryRequiresNewSubmission(blockedByBackend)).toBe(true);
        expect(canBatchRetryTaskInTaskCenter(blockedByBackend)).toBe(false);
    }
    expect(taskCenterRetryRequiresNewSubmission({ ...allowedVideoBase, type: "canvas_audio", errorCode: "download_failed" })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...allowedVideoBase, outcome: { phase: "failed", regenerate: "allowed", reason: "input_rejected" } })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...allowedVideoBase, status: "cancelled", providerCancelStatus: "requested" })).toBe(true);
    expect(taskCenterRetryRequiresNewSubmission({ ...allowedVideoBase, stage: "请求尚未提交", errorCode: "moderation_input" })).toBe(true);

    // Retryable backend categories & request_not_sent stay eligible for safe in-place /retry and batch retry.
    for (const errorCode of ["throttled", "concurrency", "provider_unavailable", "request_not_sent"]) {
        const safeRetry = { ...allowedVideoBase, errorCode };
        expect(taskCenterRetryRequiresNewSubmission(safeRetry)).toBe(false);
        expect(canBatchRetryTaskInTaskCenter(safeRetry)).toBe(true);
    }
    expect(taskCenterRetryRequiresNewSubmission({ ...allowedVideoBase, stage: "请求尚未提交", errorCode: "quota_user" })).toBe(false);
    expect(taskCenterRetryRequiresNewSubmission({
        ...allowedVideoBase,
        errorCode: "reference_upload_failed",
        error: "参考素材上传失败，本次尚未开始生成。请检查网络或稍后重试。",
        outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" },
    })).toBe(false);

    // canvas_image with backend-projected not_charged outcome for reference_upload_failed retries in-place cleanly.
    const uploadFailedImageTask: GenerationTask = {
        ...task,
        type: "canvas_image",
        status: "failed",
        stage: "生成失败",
        errorCode: "reference_upload_failed",
        error: "对象存储密钥无效（HTTP 403，InvalidAccessKeyId），本次尚未开始生成。请检查 Access Key ID（腾讯云 COS 为 SecretId）后重试。",
        outcome: { phase: "failed", regenerate: "allowed", reason: "not_charged" },
    };
    expect(taskCenterRetryRequiresNewSubmission(uploadFailedImageTask)).toBe(false);
    expect(canBatchRetryTaskInTaskCenter(uploadFailedImageTask)).toBe(true);
    expect(taskOutcomeCopyForTask(uploadFailedImageTask).reason).toContain("未扣费");
});

test("task-center new-submission routing distinguishes unloaded vs deleted vs unreachable canvases and preserves video references", async () => {
    const emptyStore = new Map<string, unknown>();
    expect(await checkTaskCanvasAvailability("canvas-unloaded", emptyStore, async () => ({ id: "canvas-unloaded" }))).toBe("available");
    expect(await checkTaskCanvasAvailability("canvas-deleted", emptyStore, async () => { throw new ApiError("not found", { status: 404 }); })).toBe("missing");
    expect(await checkTaskCanvasAvailability("canvas-down", emptyStore, async () => { throw new Error("network down"); })).toBe("unreachable");
    expect(await checkTaskCanvasAvailability("canvas-loaded", new Map([["canvas-loaded", {}]]), async () => { throw new Error("should not fetch"); })).toBe("available");

    // Unloaded but backend-available canvas navigates cleanly instead of claiming deletion.
    expect(resolveTaskCenterNewSubmissionRoute({
        type: "canvas_image",
        prompt: "雨夜街角",
        projectId: "canvas-unloaded",
    }, "提示消息。", "available")).toEqual({ kind: "navigate_canvas", canvasId: "canvas-unloaded" });

    // Network/5xx error checking canvas never falsely claims canvas is deleted.
    expect(resolveTaskCenterNewSubmissionRoute({
        type: "canvas_image",
        prompt: "雨夜街角",
        projectId: "canvas-down",
    }, "提示消息。", "unreachable")).toEqual({ kind: "error", message: "暂时无法确认原画布状态，请稍后重试" });

    // Bound video_* task whose canvas is deleted warns instead of silently dropping projectId into standalone prefill.
    const deletedBoundVideo = resolveTaskCenterNewSubmissionRoute({
        type: "video_text_to_video",
        operation: "text_to_video",
        prompt: "城市航拍",
        projectId: "canvas-deleted",
        inputJson: JSON.stringify({ mode: "video", prompt: "城市航拍" }),
    }, "提示消息。", "missing");
    expect(deletedBoundVideo.kind).toBe("warn");
    expect(deletedBoundVideo.kind === "warn" ? deletedBoundVideo.message : "").toContain("原画布已不存在");

    // Bound video_* task without nodeId whose canvas is available preserves projectId when prompt-only.
    expect(resolveTaskCenterNewSubmissionRoute({
        type: "video_text_to_video",
        operation: "text_to_video",
        prompt: "城市航拍",
        model: "seedance-2.0",
        projectId: "canvas-unloaded",
        inputJson: JSON.stringify({ mode: "video", prompt: "城市航拍" }),
    }, "提示消息。", "available")).toEqual({
        kind: "prefill_video_modal",
        values: { operation: "text_to_video", prompt: "城市航拍", model: "seedance-2.0", projectId: "canvas-unloaded" },
    });

    // Standalone video_* with reference media or specialized payload refuses lossy modal prefill.
    for (const inputPayload of [
        { mode: "video", referenceImages: [{ storageKey: "resource:img-1" }] },
        { mode: "video", referenceVideos: [{ storageKey: "resource:vid-1" }] },
        { mode: "video", referenceAudios: [{ storageKey: "resource:aud-1" }] },
        { mode: "video", mask: { storageKey: "resource:mask-1" } },
        { mode: "video", subtitleErase: { eraseMethod: "auto" } },
        { mode: "video", upscale: { factor: 2 } },
    ]) {
        const routed = resolveTaskCenterNewSubmissionRoute({
            type: "video_image_to_video",
            operation: "image_to_video",
            prompt: "参考首帧生成",
            inputJson: JSON.stringify(inputPayload),
        }, "提示消息。");
        expect(routed.kind).toBe("warn");
    }
    expect(resolveTaskCenterNewSubmissionRoute({
        type: "video_image_to_video",
        operation: "image_to_video",
        prompt: "缺少 inputJson 的图生视频",
    }, "提示消息。").kind).toBe("warn");

    // Standalone prompt-only video_* still prefills cleanly.
    expect(resolveTaskCenterNewSubmissionRoute({
        type: "video_text_to_video",
        operation: "text_to_video",
        prompt: "极光下的雪山",
        model: "seedance-2.0",
        inputJson: JSON.stringify({ mode: "video", prompt: "极光下的雪山", referenceImages: [] }),
    }, "提示消息。")).toEqual({
        kind: "prefill_video_modal",
        values: { operation: "text_to_video", prompt: "极光下的雪山", model: "seedance-2.0", projectId: undefined },
    });
});

for (const [stage, label] of [["delivery_paused", "已暂停取回结果"], ["delivery_timed_out", "下载超时，可继续取回原结果"]]) {
    test(`${stage} keeps generation success separate from result delivery`, () => {
        const task = { status: "succeeded" as const, stage };
        expect(generationTaskStatusLabel(task)).toBe("待取回结果");
        expect(generationTaskStageLabel(task)).toBe(label);
        expect(generationTaskShowsProgress(task)).toBe(false);
    });
}
