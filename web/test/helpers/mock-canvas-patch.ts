type Entity = { id: string; [key: string]: unknown };

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
};

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
 * Mirrors backend `PatchUserCanvasDocument` entity/field delta merging for frontend tests.
 */
export function applyMockCanvasPatch<T extends Record<string, unknown>>(
    current: T | null,
    params: MockCanvasPatchParams,
    nextRevision: number,
): { document: T; serverAdvanced: boolean } {
    const base = structuredClone(current ?? ({ id: params.canvasId ?? "c1", nodes: [], connections: [], chatSessions: [] } as unknown as T));
    const currentRevision = typeof base.revision === "number" ? base.revision : 0;
    const serverAdvanced = currentRevision > (params.baseRevision ?? 0);
    const deleteNodes = new Set(params.deleteNodeIds ?? []);
    const deleteConns = new Set(params.deleteConnectionIds ?? []);
    const deleteChats = new Set(params.deleteChatSessionIds ?? []);

    if (deleteNodes.size > 0 || (params.upsertNodes?.length ?? 0) > 0) {
        (base as Record<string, unknown>).nodes = mergeEntities(
            base.nodes as Entity[] | undefined,
            params.upsertNodes,
            (item) => deleteNodes.has(item.id),
        );
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
        if (value === null && key !== "activeChatId") delete (base as Record<string, unknown>)[key];
        else (base as Record<string, unknown>)[key] = structuredClone(value);
    }
    (base as Record<string, unknown>).id = params.canvasId ?? base.id ?? "c1";
    (base as Record<string, unknown>).revision = nextRevision;
    return { document: base, serverAdvanced };
}
