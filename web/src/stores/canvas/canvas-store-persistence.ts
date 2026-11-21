import type { PersistStorage, StorageValue } from "zustand/middleware";

import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import { mergeCanvasStorageProjects, parseCanvasStorageDocument, serializeCanvasStorageDocument, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasAppearance } from "@/lib/canvas/canvas-appearance";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasStarterMode } from "@/lib/canvas/canvas-starter";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { DirectorScene } from "@/types/director";
import type { TimelineProject } from "@/types/timeline";

export type CanvasProject = {
    id: string;
    revision?: number;
    remoteContentHash?: string;
    /** Stable owner for the 1:N workspace-project -> canvases relationship. */
    workspaceProjectId?: string;
    projectId?: string;
    folderId?: string;
    title: string;
    /** Optional user-facing name for this canvas inside its workspace project. */
    canvasTitle?: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    starterMode?: CanvasStarterMode;
    appearance?: CanvasAppearance;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    directorScenes: DirectorScene[];
    timeline?: TimelineProject;
    /**
     * Runtime-only library projection hydrated from `GET /canvas-projects`
     * without fetching the full `GET /canvas-projects/:id` document yet.
     * `nodes` holds preview media nodes only; full editing/saving must load
     * the authoritative document first.
     */
    summaryOnly?: true;
    summaryNodeCount?: number;
    summaryMediaKeys?: string[];
};

export type CanvasFolder = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    coverDataUrl?: string;
    coverResourceId?: string;
};

export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
export const CANVAS_DRAFTS_KEY = "infinite-canvas:canvas_unsaved_drafts";
export const CANVAS_HISTORY_STORE_KEY = "infinite-canvas:deleted_history_store";

export type PersistedCanvasState = { projects: CanvasProject[] };

type QueuedCanvasPersist = {
    name: string;
    scope: string;
    baseProjects: CanvasProject[];
    baseRevision: number;
    state: PersistedCanvasState;
    token: number;
};

type ObservedCanvasPersist = {
    projects: CanvasProject[];
    localProjects: CanvasProject[];
    revision: number;
};

type AsyncCanvasStorageLock = {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type CanvasStorageLockOptions = {
    requireCrossRealmLock?: boolean;
};

type CanvasDocumentBase = {
    revision: number;
    snapshot: CanvasProject;
};

const CANVAS_STORAGE_LOCK_PREFIX = "infinite-canvas:canvas-generation-storage-lock:";

let suppressCanvasStorePersistence = 0;
export const canvasMemoryStates = new Map<string, PersistedCanvasState>();
const observedCanvasPersists = new Map<string, ObservedCanvasPersist>();
const queuedCanvasPersists = new Map<string, QueuedCanvasPersist>();
const canvasSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const canvasPersistTokens = new Map<string, number>();
const canvasStorageTails = new Map<string, Promise<void>>();
const canvasDocumentBases = new Map<string, CanvasDocumentBase>();
const desktopDraftsPersistedScopes = new Set<string>();
const ignoredDeletedCanvasIds = new Map<string, Set<string>>();

function isDesktopSingleSourceMode(): boolean {
    return typeof window !== "undefined" && isDesktopShellOrigin(window.location);
}

function runWithBrowserCanvasStorageLock<T>(scope: string, operation: () => Promise<T>, options: CanvasStorageLockOptions) {
    const locks = typeof window !== "undefined" && typeof navigator !== "undefined" ? (navigator.locks as AsyncCanvasStorageLock | undefined) : undefined;
    const lockName = `${CANVAS_STORAGE_LOCK_PREFIX}${scope}`;
    if (locks) return locks.request(lockName, operation);
    if (options.requireCrossRealmLock && typeof window !== "undefined" && typeof document !== "undefined") {
        throw new Error("当前浏览器不支持跨标签存储锁，已停止画布生成持久化");
    }
    return operation();
}

/**
 * 串行化同一用户作用域的画布持久化，并在一次失败后允许队列继续前进。
 */
export function withCanvasStorePersistenceLock<T>(scope: string, operation: () => Promise<T>, options: CanvasStorageLockOptions = {}): Promise<T> {
    const previous = canvasStorageTails.get(scope) ?? Promise.resolve();
    const pending = previous.then(() => undefined, () => undefined).then(() => runWithBrowserCanvasStorageLock(scope, operation, options));
    const tail = pending.then(
        () => undefined,
        () => undefined,
    );
    canvasStorageTails.set(scope, tail);
    void tail.finally(() => {
        if (canvasStorageTails.get(scope) === tail) canvasStorageTails.delete(scope);
    });
    return pending;
}

function clearCanvasSaveTimer(scope: string) {
    const timer = canvasSaveTimers.get(scope);
    if (!timer) return;
    clearTimeout(timer);
    canvasSaveTimers.delete(scope);
}

/** 该作用域最近一次落进浏览器存储的画布内容；没有记录返回 undefined。 */
export function canvasDurableSnapshot(scope: string, projectId: string) {
    return observedCanvasPersists.get(scope)?.projects.find((project) => project.id === projectId);
}

function canvasDocumentBaseKey(scope: string, projectId: string) {
    return `${scope}\0${projectId}`;
}

/** 最近一次被服务端确认的画布基线（revision + 文档），与 IndexedDB 存储队列无关。 */
export function recordCanvasDocumentBase(project: CanvasProject, scope = getActiveUserScope()) {
    canvasDocumentBases.set(canvasDocumentBaseKey(scope, project.id), {
        revision: project.revision ?? 0,
        snapshot: project,
    });
}

export function canvasDocumentBase(projectId: string, scope = getActiveUserScope()) {
    return canvasDocumentBases.get(canvasDocumentBaseKey(scope, projectId));
}

export function clearCanvasDocumentBase(projectId: string, scope = getActiveUserScope()) {
    canvasDocumentBases.delete(canvasDocumentBaseKey(scope, projectId));
}

export function recordCanvasStorageDocument(
    scope: string,
    document: CanvasStorageDocument,
    localProjects: CanvasProject[] = document.state.projects,
) {
    observedCanvasPersists.set(scope, {
        projects: document.state.projects,
        localProjects,
        revision: document.storageRevision,
    });
}

function selectUnsavedDesktopDrafts(scope: string, projects: CanvasProject[]): CanvasProject[] {
    return projects.filter((project) => {
        if (project.summaryOnly) return false;
        const base = canvasDocumentBase(project.id, scope);
        if (!base) {
            return (project.revision ?? 0) === 0;
        }
        return !sameCanvasContent(project, base.snapshot);
    });
}

function collectConfirmedGenerationKeys(durable: CanvasProject | undefined, confirmed: CanvasProject | undefined) {
    const nodeKeys = new Map<string, Set<string>>();
    const sessionKeys = new Map<string, Set<string>>();
    for (const source of [durable, confirmed]) {
        for (const node of source?.nodes || []) {
            const keys = node.metadata?.generationEffectKeys;
            if (!keys?.length) continue;
            const set = nodeKeys.get(node.id) ?? new Set<string>();
            for (const key of keys) set.add(key);
            nodeKeys.set(node.id, set);
        }
        for (const session of source?.chatSessions || []) {
            const keys = session.generationEffectKeys;
            if (!keys?.length) continue;
            const set = sessionKeys.get(session.id) ?? new Set<string>();
            for (const key of keys) set.add(key);
            sessionKeys.set(session.id, set);
        }
    }
    return { nodeKeys, sessionKeys };
}

/**
 * Strip unconfirmed generationEffectKeys before writing to IndexedDB/drafts so
 * optimistic continuation stamps never skip post-crash result recovery before
 * the backend confirms them.
 */
function stripUnconfirmedGenerationKeys(scope: string, state: PersistedCanvasState, durableProjects: CanvasProject[]): PersistedCanvasState {
    const durableById = new Map(durableProjects.map((project) => [project.id, project]));
    let anyChanged = false;
    const projects = state.projects.map((project) => {
        const hasKeys = project.nodes.some((node) => Boolean(node.metadata?.generationEffectKeys?.length))
            || (project.chatSessions || []).some((session) => Boolean(session.generationEffectKeys?.length));
        if (!hasKeys) return project;
        const { nodeKeys, sessionKeys } = collectConfirmedGenerationKeys(durableById.get(project.id), canvasDocumentBase(project.id, scope)?.snapshot);
        let changed = false;
        const nodes = project.nodes.map((node) => {
            const localKeys = node.metadata?.generationEffectKeys;
            if (!localKeys?.length) return node;
            const allowed = nodeKeys.get(node.id);
            const filtered = allowed ? localKeys.filter((key) => allowed.has(key)) : [];
            if (filtered.length === localKeys.length) return node;
            changed = true;
            const metadata = { ...node.metadata };
            if (filtered.length) metadata.generationEffectKeys = filtered;
            else delete metadata.generationEffectKeys;
            return { ...node, metadata };
        });
        const chatSessions = (project.chatSessions || []).map((session) => {
            const localKeys = session.generationEffectKeys;
            if (!localKeys?.length) return session;
            const allowed = sessionKeys.get(session.id);
            const filtered = allowed ? localKeys.filter((key) => allowed.has(key)) : [];
            if (filtered.length === localKeys.length) return session;
            changed = true;
            const nextSession = { ...session };
            if (filtered.length) nextSession.generationEffectKeys = filtered;
            else delete nextSession.generationEffectKeys;
            return nextSession;
        });
        if (!changed) return project;
        anyChanged = true;
        return { ...project, nodes, chatSessions };
    });
    return anyChanged ? { projects } : state;
}

export async function commitPendingCanvasStorePersistenceLocked(scope: string) {
    const storage = localForageStorageForScope(scope);
    let committed: CanvasStorageDocument | null = null;

    while (true) {
        const queued = queuedCanvasPersists.get(scope);
        if (!queued) return committed;
        const nextRevision = (observedCanvasPersists.get(scope)?.revision ?? 0) + 1;

        if (isDesktopSingleSourceMode()) {
            const drafts = selectUnsavedDesktopDrafts(scope, queued.state.projects);
            if (drafts.length === 0) {
                await Promise.allSettled([storage.removeItem(CANVAS_DRAFTS_KEY), storage.removeItem(CANVAS_STORE_KEY)]);
                desktopDraftsPersistedScopes.delete(scope);
                const doc: CanvasStorageDocument = {
                    state: { projects: queued.state.projects },
                    version: 0,
                    storageRevision: nextRevision,
                };
                committed = doc;
                recordCanvasStorageDocument(scope, doc);
            } else {
                const doc: CanvasStorageDocument = {
                    state: { projects: drafts },
                    version: 0,
                    storageRevision: nextRevision,
                };
                await storage.setItem(CANVAS_DRAFTS_KEY, serializeCanvasStorageDocument(doc));
                desktopDraftsPersistedScopes.add(scope);
                committed = doc;
                recordCanvasStorageDocument(scope, { ...doc, state: { projects: queued.state.projects } });
            }
        } else {
            const durable = parseCanvasStorageDocument(await storage.getItem(queued.name), queued.baseProjects);
            const ignored = ignoredDeletedCanvasIds.get(scope);
            const merged = mergeCanvasStorageProjects({
                durable,
                baseProjects: queued.baseProjects,
                localProjects: queued.state.projects,
                baseRevision: queued.baseRevision,
                ignoredDeletedIds: ignored,
            });
            if (merged.droppedDeletedIds.length > 0) {
                const nextIgnored = ignored ?? new Set<string>();
                for (const id of merged.droppedDeletedIds) nextIgnored.add(id);
                ignoredDeletedCanvasIds.set(scope, nextIgnored);
            }
            await storage.setItem(queued.name, serializeCanvasStorageDocument(merged.document));
            committed = merged.document;
            recordCanvasStorageDocument(scope, merged.document, queued.state.projects);
        }

        const latest = queuedCanvasPersists.get(scope);
        if (!latest || latest.token === queued.token) {
            if (latest?.token === queued.token) queuedCanvasPersists.delete(scope);
            return committed;
        }
        latest.baseProjects = queued.state.projects;
        latest.baseRevision = Math.min(latest.baseRevision, queued.baseRevision);
    }
}

async function writeQueuedCanvasPersist(scope: string, _token: number) {
    await withCanvasStorePersistenceLock(scope, () => commitPendingCanvasStorePersistenceLocked(scope));
}

export function pendingCanvasStorePersistence(scope: string) {
    const queued = queuedCanvasPersists.get(scope);
    return queued ? { projects: queued.state.projects, token: queued.token } : null;
}

export function withCanvasStorePersistenceSuppressed<T>(operation: () => T) {
    suppressCanvasStorePersistence += 1;
    try {
        return operation();
    } finally {
        suppressCanvasStorePersistence -= 1;
    }
}

export function samePersistenceValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function createCanvasPersistStorage<TStore extends { projects: CanvasProject[] }>(): PersistStorage<TStore> {
    return {
        getItem: async (name) => {
            const scope = getActiveUserScope();
            const storage = localForageStorageForScope(scope);
            ignoredDeletedCanvasIds.delete(scope);
            if (isDesktopSingleSourceMode()) {
                const draftRaw = await storage.getItem(CANVAS_DRAFTS_KEY);
                const legacyRaw = draftRaw ? null : await storage.getItem(name);
                const raw = draftRaw || legacyRaw;
                if (!raw) {
                    desktopDraftsPersistedScopes.delete(scope);
                    canvasMemoryStates.set(scope, { projects: [] });
                    observedCanvasPersists.set(scope, { projects: [], localProjects: [], revision: 0 });
                    return null;
                }
                desktopDraftsPersistedScopes.add(scope);
                const document = parseCanvasStorageDocument(raw);
                const state = document.state as PersistedCanvasState;
                canvasMemoryStates.set(scope, state);
                recordCanvasStorageDocument(scope, document);
                return document as unknown as StorageValue<TStore>;
            }
            const value = await storage.getItem(name);
            if (!value) {
                canvasMemoryStates.set(scope, { projects: [] });
                observedCanvasPersists.set(scope, { projects: [], localProjects: [], revision: 0 });
                return null;
            }
            const document = parseCanvasStorageDocument(value);
            const state = document.state as PersistedCanvasState;
            for (const project of state.projects) traceCanvasGraph("cache.rehydrate", { project });
            canvasMemoryStates.set(scope, state);
            recordCanvasStorageDocument(scope, document);
            return document as unknown as StorageValue<TStore>;
        },
        setItem: (name, value) => {
            const scope = getActiveUserScope();
            const nextState = value.state as PersistedCanvasState;
            if (canvasMemoryStates.get(scope)?.projects === nextState.projects) return;
            canvasMemoryStates.set(scope, nextState);
            if (suppressCanvasStorePersistence) return;

            // In desktop mode SQLite is the single source of truth; skip writing
            // IndexedDB completely when every project matches its SQLite base and
            // no stale draft/legacy blob remains to be cleared.
            if (isDesktopSingleSourceMode()
                && selectUnsavedDesktopDrafts(scope, nextState.projects).length === 0
                && !queuedCanvasPersists.has(scope)
                && !desktopDraftsPersistedScopes.has(scope)) {
                return;
            }

            const ignored = ignoredDeletedCanvasIds.get(scope);
            if (ignored) {
                const liveIds = new Set(nextState.projects.map((project) => project.id));
                for (const id of ignored) {
                    if (!liveIds.has(id)) ignored.delete(id);
                }
                if (ignored.size === 0) ignoredDeletedCanvasIds.delete(scope);
            }

            const existing = queuedCanvasPersists.get(scope);
            const observed = observedCanvasPersists.get(scope);
            const token = (canvasPersistTokens.get(scope) || 0) + 1;
            canvasPersistTokens.set(scope, token);
            const baseProjects = existing?.baseProjects ?? observed?.localProjects ?? [];
            const durableProjects = observed?.projects ?? baseProjects;
            queuedCanvasPersists.set(scope, {
                name,
                scope,
                baseProjects,
                baseRevision: existing?.baseRevision ?? observed?.revision ?? 0,
                state: stripUnconfirmedGenerationKeys(scope, nextState, durableProjects),
                token,
            });
            clearCanvasSaveTimer(scope);
            const timer = setTimeout(() => {
                if (canvasSaveTimers.get(scope) === timer) canvasSaveTimers.delete(scope);
                void writeQueuedCanvasPersist(scope, token).catch((error) => {
                    console.error("画布本地持久化失败，已保留待写队列", { scope, error });
                });
            }, 400);
            canvasSaveTimers.set(scope, timer);
        },
        removeItem: (name) => {
            const scope = getActiveUserScope();
            const storage = localForageStorageForScope(scope);
            if (isDesktopSingleSourceMode()) {
                return Promise.all([storage.removeItem(CANVAS_DRAFTS_KEY), storage.removeItem(name)]).then(() => undefined);
            }
            return storage.removeItem(name);
        },
    };
}

export async function flushCanvasStorePersistence() {
    while (canvasStorageTails.size || queuedCanvasPersists.size || canvasSaveTimers.size) {
        for (const scope of [...canvasSaveTimers.keys()]) clearCanvasSaveTimer(scope);
        const writes = [...queuedCanvasPersists.values()].map(({ scope, token }) => writeQueuedCanvasPersist(scope, token));
        if (writes.length) await Promise.all(writes);
        else if (canvasStorageTails.size) await Promise.all([...canvasStorageTails.values()]);
    }
}

export function hasActiveCanvasStorePersistence() {
    return canvasStorageTails.size > 0 || canvasSaveTimers.size > 0;
}
