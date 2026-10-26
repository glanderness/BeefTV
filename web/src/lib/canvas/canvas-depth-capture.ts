import { explainGenerationError, generationFailureMetadata } from "@/lib/generation-error";
import { canvasGenerationResultUnavailable, canvasSubmissionVerdictSettled } from "@/lib/canvas/canvas-node-task-state";
import { CanvasGenerationDurableAckError } from "@/services/canvas-generation-errors";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function isDepthCaptureResultNode(node: CanvasNodeData) {
    return Boolean(node.metadata?.depthSourceNodeId) && (!node.metadata?.taskType || node.metadata.taskType === "depth_capture");
}

export function canRecoverOrRetryDepthCapture(node: CanvasNodeData) {
    return isDepthCaptureResultNode(node) && ["failed", "cancelled", "succeeded"].includes(node.metadata?.taskStatus || "");
}

export function findDepthCaptureSourceNode(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const sourceNodeId = node.metadata?.depthSourceNodeId;
    return sourceNodeId ? nodes.find((candidate) => candidate.id === sourceNodeId) : undefined;
}

export function depthCaptureTaskMetadata(task: GenerationTask): CanvasNodeMetadata {
    const active = task.status === "queued" || task.status === "running";
    return {
        taskId: task.id,
        taskType: task.type,
        taskStatus: task.status,
        taskStage: task.stage,
        taskProgress: task.progress,
        taskProvider: task.provider,
        taskErrorCode: task.errorCode,
        taskOfficialStatus: task.officialStatus,
        generationErrorCode: undefined,
        model: task.model,
        taskProviderRequestId: task.providerRequestId,
        taskFailureDiagnostics: task.failureDiagnostics,
        taskCreatedAt: task.createdAt,
        taskUpdatedAt: task.updatedAt,
        taskCompletedAt: task.completedAt,
        generationErrorSummary: task.error,
        processingLabel: task.stage || (task.type === "depth_capture" ? "正在生成深度视频" : "正在生成视频"),
        ...(active ? { status: "loading", errorDetails: undefined } : {}),
    };
}

export function depthCaptureWaitFailureMetadata(error: unknown, observed?: GenerationTask | string): CanvasNodeMetadata {
    const task = typeof observed === "object" ? observed : undefined;
    if (typeof observed === "string" || task?.status === "queued" || task?.status === "running") {
        return { status: "loading", errorDetails: undefined, taskClientOperationTerminal: undefined, processingLabel: "暂时无法同步进度，请重新打开画布查看任务状态" };
    }
    if (task?.status === "succeeded") {
        const cause = error instanceof CanvasGenerationDurableAckError ? error.cause : error;
        const explanation = explainGenerationError(cause);
        return {
            ...generationFailureMetadata(new CanvasGenerationDurableAckError(cause), ""),
            ...(explanation.category === "result_target_unavailable" ? { resourceReloadAvailable: false } : {}),
            status: "error", taskStage: "画布应用结果", taskClientOperationTerminal: false,
            generationErrorSummary: explanation.summary,
            taskFailureDiagnostics: {
                ...task.failureDiagnostics, source: "client_result", executionResult: "completed",
                stage: "画布应用结果", summary: explanation.summary, requestId: explanation.requestId,
                httpStatus: explanation.httpStatus, capturedAt: new Date().toISOString(),
            },
        };
    }
    return { status: "error", errorDetails: task?.error || (error instanceof Error ? error.message : typeof error === "string" ? error : "深度处理失败"), taskClientOperationTerminal: task?.status === "failed" || task?.status === "cancelled" };
}

export function canvasNodeFailureExplanation(node: CanvasNodeData) {
    const explanation = explainGenerationError({ code: node.metadata?.generationErrorCode || node.metadata?.taskErrorCode, message: node.metadata?.errorDetails }, { taskId: node.metadata?.taskId, model: node.metadata?.model, createdAt: node.metadata?.taskCreatedAt, stage: node.metadata?.taskStage });
    // This action opens saved history; it must never dispatch another generation.
    if (explanation.category === "result_target_unavailable") return { ...explanation, blockManualRetry: false };
    // 原任务已经终态，说明这次提交是否成立已有结论；继续显示「提交结果未确认」
    // 会让节点既没有原任务可查、也没有重新生成入口。
    if (explanation.category === "submission_uncertain" && canvasSubmissionVerdictSettled(node.metadata)) {
        // 自动取回中途断网或服务端出错：结果可能还在，交给「继续取回」，不重复提交。
        if (node.metadata?.resourceReloadAvailable) {
            return { ...explanation, reason: "原任务已结束，结果还没取回", action: "点击「继续取回」，不会重新生成", uncertain: true, retryable: false, blockAutomaticRetry: true, blockManualRetry: true };
        }
        // 结果还没确认取不回：客户端会自动按原任务取回结果，不需要用户点，也不该重复提交。
        if (!canvasGenerationResultUnavailable(node.metadata)) {
            return { ...explanation, reason: "原任务已结束，正在取回结果", action: "取回期间不用重新生成；结果取不回时会给出重新生成入口", uncertain: true, retryable: false, blockAutomaticRetry: true, blockManualRetry: true };
        }
        // 后端确认结果取不回：交回「重新生成」给用户决定（新建任务前仍会确认）。
        return { ...explanation, reason: "原任务已结束，但结果已取不回", action: "可以重新生成；会新建任务，可能再次消耗积分", uncertain: false, retryable: true, blockAutomaticRetry: true, blockManualRetry: false };
    }
    if (!canRecoverOrRetryDepthCapture(node)) return explanation;
    if (node.metadata?.taskStage === "已暂停，等待手动继续") {
        return { ...explanation, reason: "深度捕捉已暂停", action: "确认组件已安装后，点击重试继续", uncertain: false, retryable: true, blockAutomaticRetry: false, blockManualRetry: false };
    }
    if (node.metadata?.taskStatus === "succeeded") {
        return { ...explanation, reason: "深度视频已生成，暂时未能显示在画布上", action: "点击「恢复结果」重新加载原任务", uncertain: false, retryable: true, blockAutomaticRetry: false, blockManualRetry: false };
    }
    return {
        ...explanation,
        ...(["unknown", "download_failed", "submission_uncertain"].includes(explanation.category) ? { reason: "深度处理失败", action: "请查看详情，检查深度组件和网络后重试" } : {}),
        uncertain: false,
        retryable: true,
        blockAutomaticRetry: false,
        blockManualRetry: false,
    };
}
