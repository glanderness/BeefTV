import type { CapturedUserScope } from "@/lib/user-scope-guard";
import { sanitizeCostEstimate, type CostEstimate } from "@/lib/generation-cost";
import { http } from "@/services/api/request";
import { taskDiagnosticHeaders } from "@/services/diagnostics/client-diagnostics";

export type WorkspaceCallerKind = "manual" | "assistant" | "external";

export type WorkspaceOperationResult<T = unknown> = {
    op: string;
    opId?: string;
    replayed: boolean;
    result: T;
    revision?: number;
    caller?: WorkspaceCallerKind;
};

export type CanvasDocumentCommitResult = {
    canvasId: string;
    revision: number;
    title?: string;
    updatedAt?: string;
};

export async function executeWorkspaceOperation<T>(
    op: string,
    body: { opId?: string; params: unknown },
    signal?: AbortSignal,
    expectedScope?: CapturedUserScope,
    headers?: Record<string, string>,
) {
    return http.post<WorkspaceOperationResult<T>>(`/ops/${encodeURIComponent(op)}`, body, { signal, expectedScope, headers });
}

export async function commitCanvasDocument(input: {
    operationId: string;
    canvasId: string;
    expectedRevision: number;
    document: Record<string, unknown>;
    expectedScope?: CapturedUserScope;
}) {
    return executeWorkspaceOperation<CanvasDocumentCommitResult>("canvas.document.commit", {
        opId: input.operationId,
        params: {
            canvasId: input.canvasId,
            expectedRevision: input.expectedRevision,
            document: input.document,
        },
    }, undefined, input.expectedScope);
}

export type CanvasCostEstimateRequest = {
    canvasId: string;
    nodeIds?: string[];
    /** 还没建节点的一次性批量（分镜、批量表格）：按同一模型估算这些项。 */
    batch?: {
        kind: "image" | "video" | "audio";
        model: string;
        count?: number;
        items?: Array<{ parameters?: Record<string, string>; text?: string }>;
    };
};

/**
 * 生成前的费用估算：只读、不联网、不建任务。估算失败只影响这一行提示，
 * 不能拦住用户已经确认的生成，所以这里把失败收敛成 null。
 */
export async function estimateGenerationCost(params: CanvasCostEstimateRequest): Promise<CostEstimate | null> {
    try {
        const response = await executeWorkspaceOperation<{ estimate?: unknown }>("canvas.cost.estimate", { params });
        return sanitizeCostEstimate(response.result?.estimate);
    } catch {
        return null;
    }
}

export type CanvasTaskBindReceipt = {
    applied?: boolean;
    canvasId?: string;
    nodeId?: string;
    taskId?: string;
    outputIndex?: number;
    effectKey?: string;
    mediaType?: string;
    assetId?: string;
    resourceId?: string;
    storageKey?: string;
    content?: string;
    revision?: number;
    alreadyBound?: boolean;
    bindingStatus?: "bound" | "deleted" | "replaced";
    historical?: {
        taskId?: string;
        content?: string;
        storageKey?: string;
        assetId?: string;
        resourceId?: string;
        revision?: number;
    };
    canvas?: CanvasProjectLike;
    node?: {
        id?: string;
        title?: string;
        position?: { x?: number; y?: number };
        metadata?: Record<string, unknown>;
    };
};

type CanvasProjectLike = {
    id?: string;
    revision?: number;
    nodes?: CanvasTaskBindReceipt["node"][];
    [key: string]: unknown;
};

export type ConversationMessageAttachReceipt = {
    applied?: boolean;
    conversationId?: string;
    messageId?: string;
    taskId?: string;
    outputIndex?: number;
    effectKey?: string;
    mediaType?: string;
    assetId?: string;
    resourceId?: string;
    storageKey?: string;
    content?: string;
    resultUrls?: string[];
    revision?: number;
    alreadyBound?: boolean;
    bindingStatus?: "bound" | "deleted" | "replaced";
    historical?: {
        taskId?: string;
        content?: string;
        resultUrls?: string[];
        revision?: number;
    };
    conversation?: Record<string, unknown>;
    message?: Record<string, unknown>;
};

export async function attachConversationMessage(input: {
    operationId: string;
    conversationId: string;
    taskId: string;
    messageId: string;
    outputIndex?: number;
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
}) {
    return executeWorkspaceOperation<ConversationMessageAttachReceipt>(
        "conversation.message.attach",
        {
            opId: input.operationId,
            params: {
                conversationId: input.conversationId,
                taskId: input.taskId,
                messageId: input.messageId,
                outputIndex: input.outputIndex ?? 0,
            },
        },
        input.signal,
        input.expectedScope,
    );
}

export async function bindCanvasTaskOutput(input: {
    operationId: string;
    canvasId: string;
    taskId: string;
    nodeId: string;
    outputIndex?: number;
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
    traceId?: string;
}) {
    return executeWorkspaceOperation<CanvasTaskBindReceipt>(
        "canvas.task.bind",
        {
            opId: input.operationId,
            params: {
                canvasId: input.canvasId,
                taskId: input.taskId,
                nodeId: input.nodeId,
                outputIndex: input.outputIndex ?? 0,
            },
        },
        input.signal,
        input.expectedScope,
        taskDiagnosticHeaders(input.taskId, input.traceId),
    );
}
