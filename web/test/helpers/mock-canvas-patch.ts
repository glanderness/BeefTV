import { canonicalize } from "json-canonicalize";
import { stripCanvasNodeBookkeeping } from "@/lib/canvas/canvas-content";
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
    expectedConnections?: Record<string, Entity>;
    expectedChatSessions?: Record<string, Entity>;
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

const IGNORED_NOOP_DOC_FIELDS = new Set([
    "revision",
    "createdAt",
    "updatedAt",
    "viewport",
    "remoteContentHash",
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

function isPatchEmpty(v: unknown): boolean {
    if (v === null || v === undefined || v === "") return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
    return false;
}

function samePatchValue(left: unknown, right: unknown): boolean {
    if (isPatchEmpty(left) && isPatchEmpty(right)) return true;
    if (left === right) return true;
    return canonicalize(left) === canonicalize(right);
}

function sameNormalizedNode(left: Entity, right: Entity): boolean {
    return samePatchValue(stripCanvasNodeBookkeeping(left), stripCanvasNodeBookkeeping(right));
}

function sameEffectiveCanvasDoc(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (IGNORED_NOOP_DOC_FIELDS.has(key)) continue;
        if (!samePatchValue(left[key], right[key])) return false;
    }
    return true;
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

function nodeUploadOverlayFlag(meta: Record<string, unknown> | undefined): boolean {
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

function nodeHasSettledUpload(node: Entity): boolean {
    if (!nodeHasMedia(node)) return false;
    const status = metaStr(node.metadata, "status");
    if (status === "success") return true;
    return !nodeUploadOverlayFlag(node.metadata) && status !== "loading" && status !== "error";
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

    const incomingUploadingOverlay = nodeUploadOverlayFlag(incomingMeta) && !(nodeHasMedia(incoming) && incomingStatus === "success");
    if (nodeHasSettledUpload(existing) && incomingUploadingOverlay) {
        const merged = structuredClone(incoming);
        const meta: Record<string, unknown> = { ...(merged.metadata ?? {}) };
        for (const key of SETTLED_UPLOAD_KEYS) {
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

    return { node: structuredClone(incoming), preserved: false };
}

function mergeEntitiesWithOverlap<T extends Entity>(
    existing: readonly T[] | undefined,
    upserts: readonly T[] | undefined,
    expected: Record<string, Entity> | undefined,
    serverAdvanced: boolean,
    shouldDrop: (item: T) => boolean,
): { items: T[]; overlapped: boolean } {
    const byId = new Map<string, T>();
    const order: string[] = [];
    let overlapped = false;
    for (const item of existing ?? []) {
        if (!item?.id) continue;
        if (shouldDrop(item)) {
            const expectedBase = expected?.[item.id];
            if (expectedBase) {
                if (!samePatchValue(item, expectedBase)) overlapped = true;
            } else if (serverAdvanced) {
                overlapped = true;
            }
            continue;
        }
        byId.set(item.id, structuredClone(item));
        order.push(item.id);
    }
    for (const item of upserts ?? []) {
        if (!item?.id || shouldDrop(item)) continue;
        const cloned = structuredClone(item);
        const prev = byId.get(item.id);
        if (!prev) {
            if (expected && Object.hasOwn(expected, item.id)) overlapped = true;
            order.push(item.id);
            byId.set(item.id, cloned);
            continue;
        }
        const expectedBase = expected?.[item.id];
        if (expectedBase) {
            if (!samePatchValue(prev, expectedBase) && !samePatchValue(prev, cloned)) overlapped = true;
        } else if (serverAdvanced && !samePatchValue(prev, cloned)) {
            overlapped = true;
        }
        byId.set(item.id, cloned);
    }
    return { items: order.map((id) => byId.get(id)!), overlapped };
}

/**
 * Faithfully mirrors backend `PatchUserCanvasDocument`: entity/field delta merging,
 * per-entity expected overlap & forceHistorySnapshot detection, protected field
 * filtering, generation/upload output preservation, and no-op revision skipping.
 */
export function applyMockCanvasPatch<T extends Record<string, unknown>>(
    current: T | null,
    params: MockCanvasPatchParams,
    nextRevision: number,
): { document: T; serverAdvanced: boolean; mediaPreserved: boolean; snapshotCaptured: boolean; noOp: boolean } {
    const currentSnapshot = structuredClone(current ?? ({ id: params.canvasId ?? "c1", nodes: [], connections: [], chatSessions: [] } as unknown as T));
    const base = structuredClone(currentSnapshot);
    const currentRevision = typeof base.revision === "number" ? base.revision : 0;
    const serverAdvanced = currentRevision > (params.baseRevision ?? 0);
    let mediaPreserved = false;
    let overlapped = Boolean(params.forceHistorySnapshot);
    const deleteNodes = new Set(params.deleteNodeIds ?? []);
    const deleteConns = new Set(params.deleteConnectionIds ?? []);
    const deleteChats = new Set(params.deleteChatSessionIds ?? []);

    if (deleteNodes.size > 0 || (params.upsertNodes?.length ?? 0) > 0) {
        const byId = new Map<string, Entity>();
        const order: string[] = [];
        for (const item of (base.nodes as Entity[] | undefined) ?? []) {
            if (!item?.id) continue;
            if (deleteNodes.has(item.id)) {
                const expectedBase = params.expectedNodes?.[item.id];
                if (expectedBase) {
                    if (!sameNormalizedNode(item, expectedBase)) overlapped = true;
                } else if (serverAdvanced && nodeHasBoundOutput(item)) {
                    overlapped = true;
                }
                continue;
            }
            byId.set(item.id, structuredClone(item));
            order.push(item.id);
        }
        for (const incoming of params.upsertNodes ?? []) {
            if (!incoming?.id || deleteNodes.has(incoming.id)) continue;
            const prev = byId.get(incoming.id);
            if (!prev) {
                if (params.expectedNodes && Object.hasOwn(params.expectedNodes, incoming.id)) overlapped = true;
                order.push(incoming.id);
                byId.set(incoming.id, structuredClone(incoming));
                continue;
            }
            const merged = mergePatchedNode(prev, incoming);
            if (merged.preserved) {
                mediaPreserved = true;
                overlapped = true;
            } else {
                const expectedBase = params.expectedNodes?.[incoming.id];
                if (expectedBase) {
                    if (!sameNormalizedNode(prev, expectedBase) && !sameNormalizedNode(prev, merged.node)) overlapped = true;
                } else if (serverAdvanced && !samePatchValue(prev, merged.node)) {
                    overlapped = true;
                }
            }
            byId.set(incoming.id, merged.node);
        }
        (base as Record<string, unknown>).nodes = order.map((id) => byId.get(id)!);
    }
    if (deleteNodes.size > 0 || deleteConns.size > 0 || (params.upsertConnections?.length ?? 0) > 0) {
        const connResult = mergeEntitiesWithOverlap(
            base.connections as Array<Entity & { fromNodeId?: string; toNodeId?: string }> | undefined,
            params.upsertConnections,
            params.expectedConnections,
            serverAdvanced,
            (item) => deleteConns.has(item.id) || (item.fromNodeId ? deleteNodes.has(item.fromNodeId) : false) || (item.toNodeId ? deleteNodes.has(item.toNodeId) : false),
        );
        (base as Record<string, unknown>).connections = connResult.items;
        if (connResult.overlapped) overlapped = true;
    }
    if (deleteChats.size > 0 || (params.upsertChatSessions?.length ?? 0) > 0) {
        const chatResult = mergeEntitiesWithOverlap(
            base.chatSessions as Entity[] | undefined,
            params.upsertChatSessions,
            params.expectedChatSessions,
            serverAdvanced,
            (item) => deleteChats.has(item.id),
        );
        (base as Record<string, unknown>).chatSessions = chatResult.items;
        if (chatResult.overlapped) overlapped = true;
    }
    for (const [key, value] of Object.entries(params.fields ?? {})) {
        if (PROTECTED_DOC_FIELDS.has(key)) continue;
        if (params.expectedFields && Object.hasOwn(params.expectedFields, key)) {
            if (!samePatchValue(base[key], params.expectedFields[key]) && !samePatchValue(base[key], value)) overlapped = true;
        } else if (serverAdvanced && !samePatchValue(base[key], value)) {
            overlapped = true;
        }
        if (value === null && key !== "activeChatId") delete (base as Record<string, unknown>)[key];
        else (base as Record<string, unknown>)[key] = structuredClone(value);
    }
    (base as Record<string, unknown>).id = params.canvasId ?? base.id ?? "c1";
    if (sameEffectiveCanvasDoc(currentSnapshot, base)) {
        (currentSnapshot as Record<string, unknown>).revision = currentRevision;
        return { document: currentSnapshot, serverAdvanced, mediaPreserved, snapshotCaptured: false, noOp: true };
    }
    (base as Record<string, unknown>).revision = nextRevision;
    return { document: base, serverAdvanced, mediaPreserved, snapshotCaptured: overlapped, noOp: false };
}
