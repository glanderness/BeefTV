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

export type CanvasDocumentPatchPayload = {
    canvasId: string;
    baseRevision: number;
    upsertNodes?: unknown[];
    deleteNodeIds?: string[];
    upsertConnections?: unknown[];
    deleteConnectionIds?: string[];
    upsertChatSessions?: unknown[];
    deleteChatSessionIds?: string[];
    fields?: Record<string, unknown>;
    expectedNodes?: Record<string, unknown>;
    expectedConnections?: Record<string, unknown>;
    expectedChatSessions?: Record<string, unknown>;
    expectedFields?: Record<string, unknown>;
    forceHistorySnapshot?: boolean;
};

export type CanvasDocumentPatchInput = CanvasDocumentPatchPayload & {
    operationId: string;
};

export type CanvasDocumentPatchResult = {
    canvasId: string;
    revision: number;
    title?: string;
    updatedAt?: string;
    serverAdvanced?: boolean;
    mediaPreserved?: boolean;
    snapshotCaptured?: boolean;
    mergedFromRevision?: number;
    document?: Record<string, unknown>;
};

export async function patchCanvasDocument(input: CanvasDocumentPatchInput) {
    return executeWorkspaceOperation<CanvasDocumentPatchResult>("canvas.document.patch", {
        opId: input.operationId,
        params: {
            canvasId: input.canvasId,
            baseRevision: input.baseRevision,
            ...(input.upsertNodes?.length ? { upsertNodes: input.upsertNodes } : {}),
            ...(input.deleteNodeIds?.length ? { deleteNodeIds: input.deleteNodeIds } : {}),
            ...(input.upsertConnections?.length ? { upsertConnections: input.upsertConnections } : {}),
            ...(input.deleteConnectionIds?.length ? { deleteConnectionIds: input.deleteConnectionIds } : {}),
            ...(input.upsertChatSessions?.length ? { upsertChatSessions: input.upsertChatSessions } : {}),
            ...(input.deleteChatSessionIds?.length ? { deleteChatSessionIds: input.deleteChatSessionIds } : {}),
            ...(input.fields && Object.keys(input.fields).length ? { fields: input.fields } : {}),
            ...(input.expectedNodes && Object.keys(input.expectedNodes).length ? { expectedNodes: input.expectedNodes } : {}),
            ...(input.expectedConnections && Object.keys(input.expectedConnections).length ? { expectedConnections: input.expectedConnections } : {}),
            ...(input.expectedChatSessions && Object.keys(input.expectedChatSessions).length ? { expectedChatSessions: input.expectedChatSessions } : {}),
            ...(input.expectedFields && Object.keys(input.expectedFields).length ? { expectedFields: input.expectedFields } : {}),
            ...(input.forceHistorySnapshot ? { forceHistorySnapshot: true } : {}),
        },
    });
}

export async function executeWorkspaceOperation<T>(
    op: string,
    body: { opId?: string; params: unknown },
    signal?: AbortSignal,
    headers?: Record<string, string>,
) {
    return http.post<WorkspaceOperationResult<T>>(`/ops/${encodeURIComponent(op)}`, body, { signal, headers });
}

export async function commitCanvasDocument(input: {
    operationId: string;
    canvasId: string;
    expectedRevision: number;
    document: Record<string, unknown>;
}) {
    return executeWorkspaceOperation<CanvasDocumentCommitResult>("canvas.document.commit", {
        opId: input.operationId,
        params: {
            canvasId: input.canvasId,
            expectedRevision: input.expectedRevision,
            document: input.document,
        },
    });
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
    );
}

export async function bindCanvasTaskOutput(input: {
    operationId: string;
    canvasId: string;
    taskId: string;
    nodeId: string;
    outputIndex?: number;
    signal?: AbortSignal;
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
        taskDiagnosticHeaders(input.taskId, input.traceId),
    );
}
