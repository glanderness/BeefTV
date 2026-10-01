import type { CapturedUserScope } from "@/lib/user-scope-guard";
import { http } from "@/services/api/request";

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
) {
    return http.post<WorkspaceOperationResult<T>>(`/ops/${encodeURIComponent(op)}`, body, { signal, expectedScope });
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

export async function bindCanvasTaskOutput(input: {
    operationId: string;
    canvasId: string;
    taskId: string;
    nodeId: string;
    outputIndex?: number;
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
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
    );
}
