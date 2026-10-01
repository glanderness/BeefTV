import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasDocumentRebaseResult = {
    project: CanvasProject;
    conflict: boolean;
};

const VIEW_PREFERENCE_KEYS = new Set(["viewport", "appearance", "backgroundMode", "showImageInfo"]);
const SERVER_OWNED_KEYS = new Set(["revision", "updatedAt", "remoteContentHash", "createdAt"]);
const ENTITY_LIST_KEYS = new Set(["nodes", "connections", "chatSessions"]);
const SKIP_GENERIC_KEYS = new Set(["id", ...VIEW_PREFERENCE_KEYS, ...SERVER_OWNED_KEYS, ...ENTITY_LIST_KEYS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equal(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function mergeField(base: unknown, local: unknown, remote: unknown, conflict: { value: boolean }): unknown {
    if (equal(local, base)) return remote;
    if (equal(remote, base) || equal(local, remote)) return local;
    if (isPlainObject(local) && isPlainObject(remote)) {
        return mergeObject(isPlainObject(base) ? base : {}, local, remote, conflict);
    }
    conflict.value = true;
    return local;
}

function mergeObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    conflict: { value: boolean },
): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        const baseHas = Object.prototype.hasOwnProperty.call(base, key);
        const localHas = Object.prototype.hasOwnProperty.call(local, key);
        const remoteHas = Object.prototype.hasOwnProperty.call(remote, key);
        if (!localHas && baseHas) {
            if (remoteHas && !equal(remote[key], base[key])) conflict.value = true;
            continue;
        }
        if (!localHas) {
            if (remoteHas) merged[key] = remote[key];
            continue;
        }
        if (!remoteHas) {
            if (baseHas && !equal(local[key], base[key])) {
                conflict.value = true;
                merged[key] = local[key];
            } else if (!baseHas) {
                merged[key] = local[key];
            }
            continue;
        }
        if (!baseHas) {
            merged[key] = mergeField(undefined, local[key], remote[key], conflict);
            continue;
        }
        merged[key] = mergeField(base[key], local[key], remote[key], conflict);
    }
    return merged;
}

function mergeEntityList<T extends { id: string }>(
    base: T[] | undefined,
    local: T[] | undefined,
    remote: T[] | undefined,
    conflict: { value: boolean },
): T[] {
    const baseItems = Array.isArray(base) ? base : [];
    const localItems = Array.isArray(local) ? local : [];
    const remoteItems = Array.isArray(remote) ? remote : [];
    const baseById = new Map(baseItems.map((item) => [item.id, item]));
    const localById = new Map(localItems.map((item) => [item.id, item]));
    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    const result: T[] = [];
    const seen = new Set<string>();

    const consider = (id: string) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const baseItem = baseById.get(id);
        const localItem = localById.get(id);
        const remoteItem = remoteById.get(id);
        if (baseItem && !localItem) {
            if (remoteItem && !equal(remoteItem, baseItem)) conflict.value = true;
            return;
        }
        if (baseItem && !remoteItem) {
            if (localItem && !equal(localItem, baseItem)) {
                conflict.value = true;
                result.push(localItem);
            }
            return;
        }
        if (localItem && remoteItem) {
            result.push(mergeObject(
                (baseItem || {}) as unknown as Record<string, unknown>,
                localItem as unknown as Record<string, unknown>,
                remoteItem as unknown as Record<string, unknown>,
                conflict,
            ) as unknown as T);
            return;
        }
        if (localItem) {
            result.push(localItem);
            return;
        }
        if (remoteItem) result.push(remoteItem);
    };

    for (const item of localItems) consider(item.id);
    for (const item of remoteItems) consider(item.id);
    return result;
}

/**
 * 以已确认快照为基线的字段级三路合并。
 *
 * 本地相对基线的删除与未冲突编辑保留；服务端相对基线、本地未改的字段（含生成媒体）采纳。
 * 同一字段双方都改过时保留本地可见值并标冲突，不猜胜者。
 */
export function rebaseCanvasDocumentThreeWay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasDocumentRebaseResult {
    const conflict = { value: false };
    const generic = mergeObject(
        Object.fromEntries(Object.entries(input.base).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.local).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.remote).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        conflict,
    );
    const project: CanvasProject = {
        ...input.remote,
        ...generic,
        id: input.local.id,
        title: (generic.title as string | undefined) ?? input.local.title,
        nodes: mergeEntityList<CanvasNodeData>(input.base.nodes, input.local.nodes, input.remote.nodes, conflict),
        connections: mergeEntityList<CanvasConnection>(input.base.connections, input.local.connections, input.remote.connections, conflict),
        chatSessions: mergeEntityList(input.base.chatSessions, input.local.chatSessions, input.remote.chatSessions, conflict),
        viewport: input.local.viewport || input.remote.viewport,
        appearance: input.local.appearance || input.remote.appearance,
        backgroundMode: input.local.backgroundMode || input.remote.backgroundMode,
        showImageInfo: input.local.showImageInfo,
        revision: input.remote.revision,
        updatedAt: input.remote.updatedAt,
        remoteContentHash: input.remote.remoteContentHash,
        createdAt: input.remote.createdAt || input.local.createdAt,
    };
    return { project, conflict: conflict.value };
}
