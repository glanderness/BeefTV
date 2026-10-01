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

export async function executeWorkspaceOperation<T>(op: string, body: { opId?: string; params: unknown }) {
    return http.post<WorkspaceOperationResult<T>>(`/ops/${encodeURIComponent(op)}`, body);
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
