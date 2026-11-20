import {
    GENERATION_BIND_METADATA_KEYS,
    GENERATION_ERROR_METADATA_KEYS,
    INTERRUPTED_FILE_UPLOAD_MESSAGE,
    UPLOAD_SETTLEMENT_METADATA_KEYS,
} from "@/lib/canvas/canvas-node-metadata-contract";

type Entity = { id: string; metadata?: Record<string, unknown>; [key: string]: unknown };

export type MockCanvasPatchParams = {
    canvasId?: string;
    baseRevision?: number;
    upsertNodes?: Entity[];
    deleteNodeIds?: string[];
    upsertConnections?: Array<Entity & { fromNodeId?: string; toNodeId?: string }>;
    deleteConnectionIds?: string[];
    upsertChatSessions?: Entity[];
    deleteChatSessionIds?: string[];
    fields?: Record<string, unknown>;
    expectedNodes?: Record<string, Entity>;
    expectedFields?: Record<string, unknown>;
    forceHistorySnapshot?: boolean;
};

const PROTECTED_DOC_FIELDS = new Set([
    "id",
    "revision",
    "createdAt",
    "updatedAt",
    "remoteContentHash",
    "viewport",
    "nodes",
    "connections",
    "chatSessions",
]);

const BOUND_GENERATION_OUTPUT_KEYS = [
    ...GENERATION_BIND_METADATA_KEYS,
    "hasAudio",
    "videoPreview",
    "outputParameterWarning",
    "smartEraseSubtitles",
    "storyboard",
] as const;

const CLEARED_ERROR_KEYS = [
    "error",
    ...GENERATION_ERROR_METADATA_KEYS,
    "fileUpload",
    "fileUploadProgress",
] as const;

const SETTLED_UPLOAD_KEYS = UPLOAD_SETTLEMENT_METADATA_KEYS.filter(
    (key) => key !== "fileUpload" && key !== "fileUploadProgress" && key !== "errorDetails",
);

function metaStr(meta: Record<string, unknown> | undefined, key: string): string {
    const val = meta?.[key];
    return typeof val === "string" ? val.trim() : "";
}

function nodeHasMedia(node: Entity): boolean {
    const meta = node.metadata;
    if (!meta) return false;
    return metaStr(meta, "storageKey") !== "" || metaStr(meta, "assetId") !== "" || metaStr(meta, "content") !== "";
}

function nodeHasBoundOutput(node: Entity): boolean {
    if (nodeHasMedia(node)) return true;
    const meta = node.metadata;
    if (!meta || metaStr(meta, "status") !== "success") return false;
    if (metaStr(meta, "content") !== "") return true;
    return Boolean(meta.storyboard && typeof meta.storyboard === "object");
}

function nodeUploadInProgress(meta: Record<string, unknown> | undefined): boolean {
    if (!meta) return false;
    if (typeof meta.fileUpload === "string") {
        const status = meta.fileUpload.trim().toLowerCase();
        if (status === "uploading" || status === "pending" || status === "processing") return true;
        if (status === "error" && metaStr(meta, "errorDetails") === INTERRUPTED_FILE_UPLOAD_MESSAGE) return true;
        return false;
    }
    if (meta.fileUpload && typeof meta.fileUpload === "object") {
        const status = metaStr(meta.fileUpload as Record<string, unknown>, "status").toLowerCase();
        return status === "uploading" || status === "pending" || status === "processing";
    }
    return false;
}

function mergePatchedNode(existing: Entity, incoming: Entity): { node: Entity; preserved: boolean } {
    const existingMeta = existing.metadata;
    const incomingMeta = incoming.metadata;

    const existingTaskId = metaStr(existingMeta, "taskId");
    const incomingTaskId = metaStr(incomingMeta, "taskId");
    const incomingStatus = metaStr(incomingMeta, "status");
    const incomingStaleOverlay = incomingStatus === "loading" || incomingStatus === "error" || !nodeHasBoundOutput(incoming);
    if (
        existingTaskId !== "" &&
        existingTaskId === incomingTaskId &&
        metaStr(existingMeta, "status") === "success" &&
        nodeHasBoundOutput(existing) &&
        incomingStaleOverlay
    ) {
        const merged = structuredClone(incoming);
        const meta: Record<string, unknown> = { ...(merged.metadata ?? {}) };
        for (const key of BOUND_GENERATION_OUTPUT_KEYS) {
            if (existingMeta && key in existingMeta && existingMeta[key] !== undefined) {
                meta[key] = structuredClone(existingMeta[key]);
            } else {
                delete meta[key];
            }
        }
        for (const key of CLEARED_ERROR_KEYS) delete meta[key];
        merged.metadata = meta;
        return { node: merged, preserved: true };
    }

    const existingSettledUpload = nodeHasMedia(existing) && !nodeUploadInProgress(existingMeta) && metaStr(existingMeta, "status") !== "loading";
    if (existingSettledUpload && nodeUploadInProgress(incomingMeta)) {
        const existingAttempt = metaStr(existingMeta, "fileUploadAttemptId");
        const incomingAttempt = metaStr(incomingMeta, "fileUploadAttemptId");
        const sameUpload = (existingAttempt !== "" && existingAttempt === incomingAttempt) || (!nodeHasMedia(incoming) && incomingAttempt === "");
        if (sameUpload) {
            const merged = structuredClone(incoming);
            const meta: Record<string, unknown> = { ...(merged.metadata ?? {}) };
            for (const key of SETTLED_UPLOAD_KEYS) {
                if (existingMeta && key in existingMeta && existingMeta[key] !== undefined) {
                    meta[key] = structuredClone(existingMeta[key]);
                }
            }
            for (const key of CLEARED_ERROR_KEYS) delete meta[key];
            merged.metadata = meta;
            return { node: merged, preserved: true };
        }
    }

    return { node: structuredClone(incoming), preserved: false };
}

function mergeEntities<T extends Entity>(
    existing: readonly T[] | undefined,
    upserts: readonly T[] | undefined,
    shouldDrop: (item: T) => boolean,
): T[] {
    const byId = new Map<string, T>();
    const order: string[] = [];
    for (const item of existing ?? []) {
        if (!item?.id || shouldDrop(item)) continue;
        byId.set(item.id, structuredClone(item));
        order.push(item.id);
    }
    for (const item of upserts ?? []) {
        if (!item?.id || shouldDrop(item)) continue;
        if (!byId.has(item.id)) order.push(item.id);
        byId.set(item.id, structuredClone(item));
    }
    return order.map((id) => byId.get(id)!);
}

/**
 * Faithfully mirrors backend `PatchUserCanvasDocument` entity/field delta merging,
 * protected field filtering, and generation/upload output preservation.
 */
export function applyMockCanvasPatch<T extends Record<string, unknown>>(
    current: T | null,
    params: MockCanvasPatchParams,
    nextRevision: number,
): { document: T; serverAdvanced: boolean; mediaPreserved: boolean } {
    const base = structuredClone(current ?? ({ id: params.canvasId ?? "c1", nodes: [], connections: [], chatSessions: [] } as unknown as T));
    const currentRevision = typeof base.revision === "number" ? base.revision : 0;
    const serverAdvanced = currentRevision > (params.baseRevision ?? 0);
    let mediaPreserved = false;
    const deleteNodes = new Set(params.deleteNodeIds ?? []);
    const deleteConns = new Set(params.deleteConnectionIds ?? []);
    const deleteChats = new Set(params.deleteChatSessionIds ?? []);

    if (deleteNodes.size > 0 || (params.upsertNodes?.length ?? 0) > 0) {
        const byId = new Map<string, Entity>();
        const order: string[] = [];
        for (const item of (base.nodes as Entity[] | undefined) ?? []) {
            if (!item?.id || deleteNodes.has(item.id)) continue;
            byId.set(item.id, structuredClone(item));
            order.push(item.id);
        }
        for (const incoming of params.upsertNodes ?? []) {
            if (!incoming?.id || deleteNodes.has(incoming.id)) continue;
            const prev = byId.get(incoming.id);
            if (!prev) {
                order.push(incoming.id);
                byId.set(incoming.id, structuredClone(incoming));
                continue;
            }
            const merged = mergePatchedNode(prev, incoming);
            if (merged.preserved) mediaPreserved = true;
            byId.set(incoming.id, merged.node);
        }
        (base as Record<string, unknown>).nodes = order.map((id) => byId.get(id)!);
    }
    if (deleteNodes.size > 0 || deleteConns.size > 0 || (params.upsertConnections?.length ?? 0) > 0) {
        (base as Record<string, unknown>).connections = mergeEntities(
            base.connections as Array<Entity & { fromNodeId?: string; toNodeId?: string }> | undefined,
            params.upsertConnections,
            (item) => deleteConns.has(item.id) || (item.fromNodeId ? deleteNodes.has(item.fromNodeId) : false) || (item.toNodeId ? deleteNodes.has(item.toNodeId) : false),
        );
    }
    if (deleteChats.size > 0 || (params.upsertChatSessions?.length ?? 0) > 0) {
        (base as Record<string, unknown>).chatSessions = mergeEntities(
            base.chatSessions as Entity[] | undefined,
            params.upsertChatSessions,
            (item) => deleteChats.has(item.id),
        );
    }
    for (const [key, value] of Object.entries(params.fields ?? {})) {
        if (PROTECTED_DOC_FIELDS.has(key)) continue;
        if (value === null && key !== "activeChatId") delete (base as Record<string, unknown>)[key];
        else (base as Record<string, unknown>)[key] = structuredClone(value);
    }
    (base as Record<string, unknown>).id = params.canvasId ?? base.id ?? "c1";
    (base as Record<string, unknown>).revision = nextRevision;
    return { document: base, serverAdvanced, mediaPreserved };
}
