import { explainGenerationError, generationFailureMetadata, generationPromptFingerprint, shouldBlockAutomaticRetry, unchangedModeratedPrompt } from "@/lib/generation-error";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasGenerationTargetSaveError } from "@/services/canvas-generation-errors";
import { generationTaskMetadata } from "@/lib/canvas/canvas-project-generation";

type GenerationReference = { id?: string; storageKey?: string; url?: string; dataUrl?: string };
export type CanvasGenerationFailureInput = {
    mode?: "text" | "image" | "video" | "audio";
    prompt: string;
    referenceImages?: GenerationReference[];
    referenceVideos?: GenerationReference[];
    referenceAudios?: GenerationReference[];
    mask?: GenerationReference;
};

function submittedReferences(input: CanvasGenerationFailureInput) {
    if (input.mode === "audio") return [];
    const videos = input.mode === "image" ? [] : input.referenceVideos || [];
    const audios = input.mode === "image" || input.mode === "text" ? [] : input.referenceAudios || [];
    return [...(input.referenceImages || []), ...videos, ...audios, ...(input.mask ? [input.mask] : [])].map((reference) => ({
        id: reference.storageKey || reference.url || reference.dataUrl ? undefined : reference.id,
        // Blob URLs and signed download URLs may change while the stored input stays the same.
        ...(reference.storageKey ? { storageKey: reference.storageKey } : { url: reference.url || reference.dataUrl }),
    }));
}

export function canvasGenerationFailureMetadata(error: unknown, input: CanvasGenerationFailureInput) {
    const failure = generationFailureMetadata(error, input.prompt, submittedReferences(input));
    if (error instanceof CanvasGenerationTargetSaveError) return { ...failure, errorDetails: error.message, generationErrorSummary: error.message };
    return { ...failure, ...(failure.generationErrorCode === "canvas_conflict" ? { resourceReloadAvailable: true } : {}) };
}

export function canvasTaskFailureMetadata(task: GenerationTask, metadata?: CanvasNodeMetadata, error: unknown = { code: task.errorCode, message: task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败") }) {
    let input: CanvasGenerationFailureInput = { prompt: task.prompt || metadata?.prompt || "" };
    try {
        const stored = JSON.parse(task.inputJson || "{}");
        if (stored && typeof stored === "object") {
            const references = (value: unknown): GenerationReference[] => (Array.isArray(value) ? value.filter((item): item is GenerationReference => Boolean(item && typeof item === "object")) : []);
            input = { ...input, referenceImages: references(stored.referenceImages), referenceVideos: references(stored.referenceVideos), referenceAudios: references(stored.referenceAudios), mask: references([stored.mask])[0] };
        }
    } catch {
        // Older task records may not carry a readable submission snapshot.
    }
    const failure = canvasGenerationFailureMetadata(error, input);
    if (failure.failedInputFingerprint && task.id === metadata?.taskId && metadata.failedInputFingerprint) {
        failure.failedInputFingerprint = metadata.failedInputFingerprint;
        failure.failedPromptFingerprint = metadata.failedPromptFingerprint;
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const diagnostics = task.status === "succeeded" ? { ...task.failureDiagnostics, source: "client_result" as const, executionResult: "completed" as const, summary: cause instanceof Error ? cause.message : failure.generationErrorSummary, stage: "画布应用结果", capturedAt: new Date().toISOString() } : task.failureDiagnostics;
    return { ...failure, taskFailureDiagnostics: diagnostics, taskProviderRequestId: task.providerRequestId };
}

export function canvasGenerationRetryBlocked(metadata: CanvasNodeMetadata | undefined, input?: CanvasGenerationFailureInput) {
    if (metadata?.resourceReloadAvailable) return true;
    const error = { code: metadata?.generationErrorCode || metadata?.taskErrorCode, message: metadata?.errorDetails };
    if (!shouldBlockAutomaticRetry(error, metadata?.taskStage)) return false;
    // Only a resolved submission can prove that moderated input was changed.
    if (input && explainGenerationError(error).moderation) {
        if (!metadata?.failedInputFingerprint) return !metadata?.failedPromptFingerprint || metadata.failedPromptFingerprint === generationPromptFingerprint(input.prompt);
        return unchangedModeratedPrompt(metadata, input.prompt, submittedReferences(input));
    }
    if (input) return metadata?.taskStage === "submission_unknown" || ["submission_uncertain", "timeout", "download_failed", "results_missing", "partial_success", "canvas_conflict"].includes(explainGenerationError(error).category);
    return true;
}

export function canvasImageGenerationHasPendingResult(node: CanvasNodeData | undefined, nodes: CanvasNodeData[]) {
    return Boolean(node?.metadata?.resourceReloadAvailable || node?.metadata?.generationErrorCode === "canvas_conflict"
        || node?.metadata?.batchChildIds?.some((id) => {
            const child = nodes.find((item) => item.id === id);
            return child?.metadata?.resourceReloadAvailable || child?.metadata?.generationErrorCode === "canvas_conflict";
        }));
}

export function canvasGenerationTaskNodes(nodes: CanvasNodeData[], targetNodeId: string, task: GenerationTask): CanvasNodeData[] {
    return nodes.map((node) => {
        if (node.id !== targetNodeId) return node;
        const failed = task.status === "failed" || task.status === "cancelled";
        const hasCompletedContent = task.status === "succeeded" && Boolean(node.metadata?.content || node.metadata?.storageKey);
        const retainRecovery = task.status === "succeeded" && !hasCompletedContent && Boolean(node.metadata?.resourceReloadAvailable || node.metadata?.generationErrorCode === "canvas_conflict");
        const failure = failed ? canvasTaskFailureMetadata(task, node.metadata) : undefined;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                ...generationTaskMetadata(task),
                status: failed || retainRecovery ? "error" : hasCompletedContent ? "success" : "loading",
                ...(failure || (retainRecovery
                    ? { resourceReloadAvailable: true, generationErrorCode: "canvas_conflict", errorDetails: node.metadata?.errorDetails || "生成结果已保留，请重新加载资源" }
                    : { errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined, failedInputFingerprint: undefined })),
            },
        };
    });
}
