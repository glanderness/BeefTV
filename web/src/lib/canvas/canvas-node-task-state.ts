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

/**
 * 原任务已在任务中心落定终态（失败或取消）：这次提交到底有没有成立已经有了结论。
 * 「提交结果未确认」的防重锁只在结论未知时成立；任务已经终态还继续锁着，节点就没有出路。
 */
export function generationTaskVerdictSettled(metadata: CanvasNodeMetadata | undefined) {
    return Boolean(metadata?.taskId && (metadata.taskStatus === "failed" || metadata.taskStatus === "cancelled"));
}

/** 提交结果未确认：上游可能已经生成，必须先查原任务，不能重复提交。 */
export function imageSubmissionUnknown(metadata: CanvasNodeMetadata | undefined) {
    return metadata?.generationSubmissionState === "unknown" || metadata?.taskStage === "submission_unknown" || metadata?.generationErrorCode === "submission_uncertain";
}

/**
 * 按回执取回原结果已被后端拒绝：沿用「结果不能继续取回」的既有标记（resourceReloadAvailable 为 false），
 * 不另加字段。新建任务时这个标记会随旧任务绑定一起清掉。是否重新生成交回用户决定。
 */
export function canvasGenerationResultUnavailable(metadata: CanvasNodeMetadata | undefined) {
    return Boolean(metadata?.taskId && metadata.resourceReloadAvailable === false && canvasTaskProvesSubmissionUnknown(metadata));
}

/**
 * 原任务自己就能证明这次提交结论未确认：后端对这类任务只会按回执取回，
 * 取不到回执就拒绝重试，不会重新提交上游。只认从任务同步来的 `taskStage` / `taskErrorCode`；
 * 客户端自己写的 `generationErrorCode`、`generationSubmissionState` 不算——
 * 节点上可能还挂着一个普通失败的旧任务，对它调重试会真的重新入队并扣费。
 * 节点正在提交或新提交结论未知时，挂着的任务号可能是旧的，同样不算。
 */
export function canvasTaskProvesSubmissionUnknown(metadata: CanvasNodeMetadata | undefined) {
    if (metadata?.generationSubmissionState === "submitting" || metadata?.generationSubmissionState === "unknown") return false;
    return metadata?.taskStage === "submission_unknown" || metadata?.taskErrorCode === "submission_uncertain";
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
 * 恢复扫描要先按回执取回原结果的节点：提交结论未确认，而原任务已经终态，且还没取过（「继续取回」未亮、也没确认取不回）。
 * 「继续取回」已经亮起的节点交给它，不再自动重试。
 */
export function canvasNodeNeedsOriginalResultRecovery(node: CanvasNodeData) {
    const metadata = node.metadata;
    return Boolean(
        metadata?.taskId
        && metadata.status === "error"
        && metadata.resourceReloadAvailable === undefined
        && canvasTaskProvesSubmissionUnknown(metadata)
        && generationTaskVerdictSettled(metadata),
    );
}
