import { canonicalize } from "json-canonicalize";
import { stripCanvasNodeBookkeeping } from "@/lib/canvas/canvas-content";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasDocumentPatchPayload } from "@/services/api/operations";
import type { CanvasNodeData } from "@/types/canvas";

const NON_PATCHABLE_DOC_FIELDS = new Set<string>([
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

const VIEW_PREFERENCE_FIELDS = new Set<string>(["appearance", "backgroundMode", "showImageInfo"]);

function sameSerialized(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    return canonicalize(left) === canonicalize(right);
}

function isEmptyDefault(value: unknown): boolean {
    if (value === undefined || value === null || value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
    return false;
}

function diffEntityList<T extends { id: string }>(
    baseItems: readonly T[] | undefined,
    liveItems: readonly T[] | undefined,
    normalize: (item: T) => T = (item) => item,
): { upserts: T[]; deletedIds: string[]; expectedById: Record<string, T> } {
    const baseById = new Map((baseItems || []).map((item) => [item.id, item]));
    const liveById = new Map((liveItems || []).map((item) => [item.id, item]));
    const upserts: T[] = [];
    const deletedIds: string[] = [];
    const expectedById: Record<string, T> = {};
    for (const item of liveItems || []) {
        const prev = baseById.get(item.id);
        const normalizedLive = normalize(item);
        const normalizedPrev = prev ? normalize(prev) : undefined;
        if (!normalizedPrev || !sameSerialized(normalizedPrev, normalizedLive)) {
            upserts.push(normalizedLive);
            if (normalizedPrev) expectedById[item.id] = normalizedPrev;
        }
    }
    for (const [id, prev] of baseById.entries()) {
        if (!liveById.has(id)) {
            deletedIds.push(id);
            expectedById[id] = normalize(prev);
        }
    }
    return { upserts, deletedIds, expectedById };
}

/**
 * Compute a minimal node/edge/field delta between the last confirmed server
 * snapshot (`base`) and the current live canvas (`live`), including per-entity
 * expected base snapshots so the server can detect genuine overlaps accurately.
 */
export function buildCanvasDocumentPatch(
    base: CanvasProject,
    live: CanvasProject,
    options: { forceHistorySnapshot?: boolean } = {},
): CanvasDocumentPatchPayload | null {
    const nodesDiff = diffEntityList(base.nodes, live.nodes, stripCanvasNodeBookkeeping);
    const connDiff = diffEntityList(base.connections, live.connections);
    const chatDiff = diffEntityList(base.chatSessions, live.chatSessions);
    const fields: Record<string, unknown> = {};
    const expectedFields: Record<string, unknown> = {};
    const baseRecord = base as unknown as Record<string, unknown>;
    const liveRecord = live as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(liveRecord)])) {
        if (NON_PATCHABLE_DOC_FIELDS.has(key)) continue;
        const prev = baseRecord[key];
        const next = liveRecord[key];
        if (VIEW_PREFERENCE_FIELDS.has(key) && prev === undefined) continue;
        if (prev === undefined && isEmptyDefault(next)) continue;
        if (next === undefined && isEmptyDefault(prev)) continue;
        if (!sameSerialized(prev, next)) {
            fields[key] = next ?? null;
            expectedFields[key] = prev ?? null;
        }
    }
    const hasChanges =
        nodesDiff.upserts.length > 0 ||
        nodesDiff.deletedIds.length > 0 ||
        connDiff.upserts.length > 0 ||
        connDiff.deletedIds.length > 0 ||
        chatDiff.upserts.length > 0 ||
        chatDiff.deletedIds.length > 0 ||
        Object.keys(fields).length > 0;
    if (!hasChanges) return null;
    const expectedNodes = nodesDiff.expectedById;
    const expectedConnections = connDiff.expectedById;
    const expectedChatSessions = chatDiff.expectedById;
    return {
        canvasId: live.id,
        baseRevision: base.revision ?? 0,
        ...(nodesDiff.upserts.length ? { upsertNodes: nodesDiff.upserts } : {}),
        ...(nodesDiff.deletedIds.length ? { deleteNodeIds: nodesDiff.deletedIds } : {}),
        ...(connDiff.upserts.length ? { upsertConnections: connDiff.upserts } : {}),
        ...(connDiff.deletedIds.length ? { deleteConnectionIds: connDiff.deletedIds } : {}),
        ...(chatDiff.upserts.length ? { upsertChatSessions: chatDiff.upserts } : {}),
        ...(chatDiff.deletedIds.length ? { deleteChatSessionIds: chatDiff.deletedIds } : {}),
        ...(Object.keys(fields).length ? { fields } : {}),
        ...(Object.keys(expectedNodes).length ? { expectedNodes } : {}),
        ...(Object.keys(expectedConnections).length ? { expectedConnections } : {}),
        ...(Object.keys(expectedChatSessions).length ? { expectedChatSessions } : {}),
        ...(Object.keys(expectedFields).length ? { expectedFields } : {}),
        ...(options.forceHistorySnapshot ? { forceHistorySnapshot: true } : {}),
    };
}

/**
 * When the editor publishes an autosave back to the Zustand store, keep the
 * stored node reference for any node that has not changed relative to what the
 * editor observed on open. This prevents open-only normalizations from dirtying
 * untouched nodes in downstream incremental diffs.
 */
export function preserveUntouchedStoredNodes(
    observedNodes: readonly CanvasNodeData[] | undefined,
    storedNodes: readonly CanvasNodeData[] | undefined,
    nextNodes: CanvasNodeData[],
): CanvasNodeData[] {
    if (!observedNodes?.length || !storedNodes?.length) return nextNodes;
    const observedById = new Map(observedNodes.map((node) => [node.id, node]));
    const storedById = new Map(storedNodes.map((node) => [node.id, node]));
    let changed = false;
    const result = nextNodes.map((node) => {
        const observed = observedById.get(node.id);
        const stored = storedById.get(node.id);
        if (observed && stored && (node === observed || sameSerialized(observed, node))) {
            if (stored !== node) changed = true;
            return stored;
        }
        return node;
    });
    return changed ? result : nextNodes;
}
