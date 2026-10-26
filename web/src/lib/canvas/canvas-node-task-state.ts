import { generationTaskVerdictSettled } from "@/lib/generation-task-display";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

/** A historical taskId is not a lock. Only live task states / submission are. */
export function isCanvasNodeGenerating(node: CanvasNodeData | undefined, runningNodeId?: string | null) {
    if (!node) return false;
    if (runningNodeId === node.id) return true;
    const meta = node.metadata;
    if (meta?.taskId && (meta.taskStatus === "queued" || meta.taskStatus === "running")) return true;
    if (meta?.taskStatus === "succeeded" && !meta.content && !meta.storageKey) return true;
    if (["succeeded", "failed", "cancelled"].includes(meta?.taskStatus || "")) return false;
    return meta?.status === "loading" || Boolean(meta?.taskId && meta.status !== "success" && meta.status !== "error");
}

/** 提交结果未确认：上游可能已经生成，必须先查原任务，不能重复提交。 */
export function imageSubmissionUnknown(metadata: CanvasNodeMetadata | undefined) {
    return metadata?.generationSubmissionState === "unknown" || metadata?.taskStage === "submission_unknown" || metadata?.generationErrorCode === "submission_uncertain";
}

/** 原任务已终态、但结果确认取不回（后端按回执恢复被拒）：是否重新生成交回用户决定。 */
export function canvasGenerationResultUnavailable(metadata: CanvasNodeMetadata | undefined) {
    return Boolean(metadata?.taskId && metadata.generationResultUnavailableTaskId === metadata.taskId);
}

/**
 * 原任务自己就能证明这次提交结论未确认：后端对这类任务只会按回执取回，
 * 取不到回执就拒绝重试，不会重新提交上游。自动取回只认这种任务侧证据，
 * 不认仅来自客户端的 `generationSubmissionState`（那种情况下的重试可能真的重新提交并产生费用）。
 */
export function canvasTaskProvesSubmissionUnknown(metadata: CanvasNodeMetadata | undefined) {
    return metadata?.taskStage === "submission_unknown" || metadata?.generationErrorCode === "submission_uncertain" || metadata?.taskErrorCode === "submission_uncertain";
}

/**
 * 手动「重新生成」前的判定：原任务已终态，且这次提交结论未确认。
 *
 * 必须与自动取回用同一份任务侧证据：两边判定不一致时，会出现
 * 「自动取回被后端拒绝 → 点重新生成 → 没弹付费确认就新建任务」。
 */
export function canvasSubmissionVerdictSettled(metadata: CanvasNodeMetadata | undefined) {
    return generationTaskVerdictSettled(metadata) && canvasTaskProvesSubmissionUnknown(metadata);
}

/**
 * 需要自动取回原结果的节点：提交结论未确认，而原任务已经终态。
 *
 * 只有这一类节点可以自动调用任务重试：后端会先按已存回执重建结果，不会重新提交上游；
 * 其他失败状态下同一个入口可能真的重新提交上游并产生费用，必须由用户发起。
 */
export function canvasNodeNeedsOriginalResultRecovery(node: CanvasNodeData) {
    const metadata = node.metadata;
    return Boolean(
        metadata?.taskId
        && metadata.status === "error"
        && !metadata.resourceReloadAvailable
        && canvasTaskProvesSubmissionUnknown(metadata)
        && generationTaskVerdictSettled(metadata)
        && !canvasGenerationResultUnavailable(metadata),
    );
}

/**
 * 还需要自动复查的节点：提交结论未确认的节点里，原任务已终态（按回执取回结果），
 * 或提交身份还没查回来（这次提交可能刚到服务端）。复查只读任务，不新建任务。
 */
export function canvasNodeNeedsGenerationRecoveryRetry(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (!metadata || metadata.status !== "error") return false;
    if (canvasNodeNeedsOriginalResultRecovery(node)) return true;
    return !metadata.taskId && imageSubmissionUnknown(metadata);
}
