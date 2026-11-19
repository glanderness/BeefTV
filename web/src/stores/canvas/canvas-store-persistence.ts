import type { PersistStorage, StorageValue } from "zustand/middleware";

import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import { traceCanvasGraph } from "@/lib/canvas/canvas-graph-trace";
import { parseCanvasStorageDocument, rebaseCanvasProjects, serializeCanvasStorageDocument, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";
import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { usesBrowserLocalResourceStore } from "@/services/workspace-resource-storage";
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
};

export type CanvasFolder = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    coverDataUrl?: string;
    coverResourceId?: string;
    unsaved?: boolean;
    saveError?: string;
};

export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
export const CANVAS_DRAFTS_KEY = "infinite-canvas:canvas_unsaved_drafts";

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
    revision: number;
};

type CanvasGenerationPersistenceAttempt = {
    previousNodes?: CanvasNodeData[];
    nodes?: CanvasNodeData[];
    previousConnections?: CanvasConnection[];
    connections?: CanvasConnection[];
    previousChatSessions?: CanvasAssistantSession[];
    chatSessions?: CanvasAssistantSession[];
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
const pendingCanvasGenerationAttempts = new Map<string, Map<string, CanvasGenerationPersistenceAttempt>>();
const canvasStorageTails = new Map<string, Promise<void>>();
const canvasDocumentBases = new Map<string, CanvasDocumentBase>();
const desktopDraftsPersistedScopes = new Set<string>();

function isDesktopSingleSourceMode(): boolean {
    return typeof window !== "undefined" && isDesktopShellOrigin(window.location) && !usesBrowserLocalResourceStore();
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

export function recordCanvasStorageDocument(scope: string, document: CanvasStorageDocument) {
    observedCanvasPersists.set(scope, {
        projects: document.state.projects,
        revision: document.storageRevision,
    });
}

function selectUnsavedDesktopDrafts(scope: string, projects: CanvasProject[]): CanvasProject[] {
    return projects.filter((project) => {
        const base = canvasDocumentBase(project.id, scope);
        if (!base) {
            return (project.revision ?? 0) === 0;
        }
        return !sameCanvasContent(project, base.snapshot);
    });
}

export async function commitPendingCanvasStorePersistenceLocked(scope: string) {
    const storage = localForageStorageForScope(scope);
    let committed: CanvasStorageDocument | null = null;

    while (true) {
        const queued = queuedCanvasPersists.get(scope);
        if (!queued) return committed;

        if (isDesktopSingleSourceMode()) {
            const drafts = selectUnsavedDesktopDrafts(scope, queued.state.projects);
            const emptyTombstones = { projects: {}, nodes: {}, connections: {}, sessions: {}, messages: {} };
            if (drafts.length === 0) {
                await Promise.allSettled([storage.removeItem(CANVAS_DRAFTS_KEY), storage.removeItem(CANVAS_STORE_KEY)]);
                desktopDraftsPersistedScopes.delete(scope);
                const doc: CanvasStorageDocument = {
                    state: { projects: queued.state.projects },
                    version: 0,
                    storageRevision: (observedCanvasPersists.get(scope)?.revision ?? 0) + 1,
                    tombstones: emptyTombstones,
                };
                committed = doc;
                recordCanvasStorageDocument(scope, doc);
            } else {
                const doc: CanvasStorageDocument = {
                    state: { projects: drafts },
                    version: 0,
                    storageRevision: (observedCanvasPersists.get(scope)?.revision ?? 0) + 1,
                    tombstones: emptyTombstones,
                };
                await storage.setItem(CANVAS_DRAFTS_KEY, serializeCanvasStorageDocument(doc));
                desktopDraftsPersistedScopes.add(scope);
                committed = doc;
                recordCanvasStorageDocument(scope, { ...doc, state: { projects: queued.state.projects } });
            }
        } else {
            const durable = parseCanvasStorageDocument(await storage.getItem(queued.name), queued.baseProjects);
            const rebased = rebaseCanvasProjects({
                document: durable,
                baseProjects: queued.baseProjects,
                localProjects: queued.state.projects,
                baseRevision: queued.baseRevision,
            }).document;
            await storage.setItem(queued.name, serializeCanvasStorageDocument(rebased));
            for (const project of rebased.state.projects) {
                const previous = durable.state.projects.find((item) => item.id === project.id);
                if (previous?.connections?.length !== project.connections?.length) {
                    traceCanvasGraph("cache.commit", { previous, queued: queued.state.projects.find((item) => item.id === project.id), saved: project });
                }
            }
            committed = rebased;
            recordCanvasStorageDocument(scope, rebased);
        }

        const latest = queuedCanvasPersists.get(scope);
        if (!latest || latest.token === queued.token) {
            if (latest?.token === queued.token) queuedCanvasPersists.delete(scope);
            return committed;
        }

        latest.baseProjects = queued.state.projects;
        latest.baseRevision = committed.storageRevision;
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

export function registerCanvasGenerationPersistenceAttempt(scope: string, projectId: string, effectKey: string, attempt: CanvasGenerationPersistenceAttempt) {
    const projectKey = `${scope}\0${projectId}`;
    const attempts = pendingCanvasGenerationAttempts.get(projectKey) ?? new Map<string, CanvasGenerationPersistenceAttempt>();
    attempts.set(effectKey, attempt);
    pendingCanvasGenerationAttempts.set(projectKey, attempts);
    const queued = queuedCanvasPersists.get(scope);
    if (queued) {
        const latestMemory = canvasMemoryStates.get(scope)?.projects ?? queued.state.projects;
        const durableProjects = observedCanvasPersists.get(scope)?.projects ?? queued.baseProjects;
        queued.state = ordinaryCanvasPersistenceState(scope, { projects: latestMemory }, durableProjects);
    }
    return () => {
        if (attempts.get(effectKey) !== attempt) return;
        attempts.delete(effectKey);
        if (!attempts.size) pendingCanvasGenerationAttempts.delete(projectKey);
    };
}

function hasUnconfirmedGenerationKey(localKeys?: string[], durableKeys?: string[]) {
    return Boolean(localKeys?.some((key) => !durableKeys?.includes(key)));
}

export function samePersistenceValue(left: unknown, right: unknown) {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function rollbackGenerationValue(previous: unknown, attempted: unknown, live: unknown, durable: unknown): unknown {
    if (samePersistenceValue(previous, attempted)) return live;
    if (samePersistenceValue(live, attempted)) return durable;
    if (!previous || !attempted || !live || !durable || Array.isArray(previous) || Array.isArray(attempted) || Array.isArray(live) || Array.isArray(durable) || typeof previous !== "object" || typeof attempted !== "object" || typeof live !== "object" || typeof durable !== "object") return live;

    const previousRecord = previous as Record<string, unknown>;
    const attemptedRecord = attempted as Record<string, unknown>;
    const liveRecord = live as Record<string, unknown>;
    const durableRecord = durable as Record<string, unknown>;
    const result: Record<string, unknown> = { ...durableRecord };
    for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(attemptedRecord), ...Object.keys(liveRecord)])) {
        const previousHasKey = Object.hasOwn(previousRecord, key);
        const attemptedHasKey = Object.hasOwn(attemptedRecord, key);
        const liveHasKey = Object.hasOwn(liveRecord, key);
        if (!previousHasKey && !attemptedHasKey) {
            if (liveHasKey) result[key] = liveRecord[key];
            continue;
        }
        if (!previousHasKey && attemptedHasKey) {
            if (!liveHasKey || samePersistenceValue(liveRecord[key], attemptedRecord[key])) delete result[key];
            else result[key] = liveRecord[key];
            continue;
        }
        if (previousHasKey && !attemptedHasKey) {
            if (liveHasKey) result[key] = liveRecord[key];
            continue;
        }
        if (!liveHasKey) {
            delete result[key];
            continue;
        }
        const value = rollbackGenerationValue(previousRecord[key], attemptedRecord[key], liveRecord[key], durableRecord[key]);
        if (value === undefined) delete result[key];
        else result[key] = value;
    }
    return result;
}

function pendingGenerationAttempt(scope: string, projectId: string, effectKeys?: string[]) {
    const attempts = pendingCanvasGenerationAttempts.get(`${scope}\0${projectId}`);
    if (!attempts) return undefined;
    for (const effectKey of effectKeys || []) {
        const attempt = attempts.get(effectKey);
        if (attempt) return attempt;
    }
    return undefined;
}

function rollbackGenerationConnections(live: CanvasConnection[], attempt: CanvasGenerationPersistenceAttempt) {
    if (!attempt.previousConnections || !attempt.connections) return live;
    const previous = new Map(attempt.previousConnections.map((edge) => [edge.id, edge]));
    const attempted = new Map(attempt.connections.map((edge) => [edge.id, edge]));
    const liveIds = new Set(live.map((edge) => edge.id));
    const result: CanvasConnection[] = [];
    for (const edge of live) {
        const before = previous.get(edge.id);
        const after = attempted.get(edge.id);
        if (samePersistenceValue(before, after)) result.push(edge);
        else if (before) result.push(rollbackGenerationValue(before, after, edge, before) as CanvasConnection);
    }
    for (const edge of attempt.previousConnections) {
        if (!attempted.has(edge.id) && !liveIds.has(edge.id)) result.push(edge);
    }
    return result;
}

function ordinaryCanvasProjectSnapshot(scope: string, project: CanvasProject, durableProject: CanvasProject | undefined) {
    if (!hasGenerationEffectKeys(project) && !hasGenerationEffectKeys(durableProject)) return project;
    const durableNodes = new Map((durableProject?.nodes || []).map((node) => [node.id, node]));
    const durableSessions = new Map((durableProject?.chatSessions || []).map((session) => [session.id, session]));
    const confirmed = canvasDocumentBase(project.id, scope)?.snapshot;
    for (const node of confirmed?.nodes || []) {
        const cachedKeys = durableNodes.get(node.id)?.metadata?.generationEffectKeys;
        if (hasUnconfirmedGenerationKey(node.metadata?.generationEffectKeys, cachedKeys)) {
            durableNodes.set(node.id, { ...node, metadata: { ...node.metadata, generationEffectKeys: [...new Set([...(cachedKeys || []), ...(node.metadata?.generationEffectKeys || [])])] } });
        }
    }
    for (const session of confirmed?.chatSessions || []) {
        const cachedKeys = durableSessions.get(session.id)?.generationEffectKeys;
        if (hasUnconfirmedGenerationKey(session.generationEffectKeys, cachedKeys)) {
            durableSessions.set(session.id, { ...session, generationEffectKeys: [...new Set([...(cachedKeys || []), ...(session.generationEffectKeys || [])])] });
        }
    }
    const unconfirmedAttempts = new Set<CanvasGenerationPersistenceAttempt>();
    let changed = false;
    let hasUnconfirmedGeneration = false;
    const nodes: CanvasNodeData[] = [];
    for (const node of project.nodes) {
        const durableNode = durableNodes.get(node.id);
        const durableKeys = durableNode?.metadata?.generationEffectKeys;
        const localKeys = node.metadata?.generationEffectKeys;
        if (durableProject && hasUnconfirmedGenerationKey(localKeys, durableKeys)) {
            hasUnconfirmedGeneration = true;
            changed = true;
            const attempt = pendingGenerationAttempt(scope, project.id, localKeys);
            if (attempt) unconfirmedAttempts.add(attempt);
            if (durableNode) {
                const previousNode = attempt?.previousNodes?.find((candidate) => candidate.id === node.id);
                const attemptedNode = attempt?.nodes?.find((candidate) => candidate.id === node.id);
                const rolledBack = previousNode && attemptedNode
                    ? (rollbackGenerationValue(previousNode, attemptedNode, node, durableNode) as CanvasNodeData)
                    : { ...durableNode, metadata: durableNode.metadata ? { ...durableNode.metadata } : undefined };
                const metadata = { ...(rolledBack.metadata || {}) };
                if (durableKeys?.length) metadata.generationEffectKeys = [...durableKeys];
                else delete metadata.generationEffectKeys;
                nodes.push({ ...rolledBack, metadata });
            }
            continue;
        }
        if (sameGenerationEffectKeys(localKeys, durableKeys)) {
            nodes.push(node);
            continue;
        }
        changed = true;
        const metadata = { ...(node.metadata || {}) };
        if (durableKeys?.length) metadata.generationEffectKeys = [...durableKeys];
        else delete metadata.generationEffectKeys;
        nodes.push({ ...node, metadata });
    }
    const chatSessions: CanvasAssistantSession[] = [];
    for (const session of project.chatSessions || []) {
        const durableSession = durableSessions.get(session.id);
        const durableKeys = durableSession?.generationEffectKeys;
        if (durableProject && hasUnconfirmedGenerationKey(session.generationEffectKeys, durableKeys)) {
            hasUnconfirmedGeneration = true;
            changed = true;
            const attempt = pendingGenerationAttempt(scope, project.id, session.generationEffectKeys);
            if (attempt) unconfirmedAttempts.add(attempt);
            if (durableSession) {
                const previousSession = attempt?.previousChatSessions?.find((candidate) => candidate.id === session.id);
                const attemptedSession = attempt?.chatSessions?.find((candidate) => candidate.id === session.id);
                const rolledBack = previousSession && attemptedSession
                    ? (rollbackGenerationValue(previousSession, attemptedSession, session, durableSession) as CanvasAssistantSession)
                    : { ...durableSession, generationEffectKeys: durableSession.generationEffectKeys ? [...durableSession.generationEffectKeys] : undefined };
                if (durableKeys?.length) rolledBack.generationEffectKeys = [...durableKeys];
                else delete rolledBack.generationEffectKeys;
                chatSessions.push(rolledBack);
            }
            continue;
        }
        if (sameGenerationEffectKeys(session.generationEffectKeys, durableKeys)) {
            chatSessions.push(session);
            continue;
        }
        changed = true;
        const nextSession = { ...session };
        if (durableKeys?.length) nextSession.generationEffectKeys = [...durableKeys];
        else delete nextSession.generationEffectKeys;
        chatSessions.push(nextSession);
    }
    if (durableProject && hasUnconfirmedGeneration) {
        let connections = project.connections;
        for (const attempt of unconfirmedAttempts) connections = rollbackGenerationConnections(connections, attempt);
        const nodeIds = new Set(nodes.map((node) => node.id));
        return {
            ...project,
            nodes,
            connections: connections.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)),
            chatSessions,
            activeChatId: durableProject.activeChatId,
        };
    }
    return changed ? { ...project, nodes, chatSessions } : project;
}

function hasGenerationEffectKeys(value: CanvasProject | undefined) {
    if (!value) return false;
    return (value.nodes || []).some((node) => Boolean(node.metadata?.generationEffectKeys?.length))
        || (value.chatSessions || []).some((session) => Boolean(session.generationEffectKeys?.length));
}

function sameGenerationEffectKeys(left?: readonly string[], right?: readonly string[]) {
    if (left === right) return true;
    if (!left?.length && !right?.length) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function ordinaryCanvasPersistenceState(scope: string, state: PersistedCanvasState, durableProjects: CanvasProject[]) {
    const durableById = new Map(durableProjects.map((project) => [project.id, project]));
    return {
        projects: state.projects.map((project) => ordinaryCanvasProjectSnapshot(scope, project, durableById.get(project.id))),
    };
}

export function createCanvasPersistStorage<TStore extends { projects: CanvasProject[] }>(): PersistStorage<TStore> {
    return {
        getItem: async (name) => {
            const scope = getActiveUserScope();
            const storage = localForageStorageForScope(scope);
            if (isDesktopSingleSourceMode()) {
                const draftRaw = await storage.getItem(CANVAS_DRAFTS_KEY);
                const legacyRaw = draftRaw ? null : await storage.getItem(name);
                const raw = draftRaw || legacyRaw;
                if (!raw) {
                    desktopDraftsPersistedScopes.delete(scope);
                    canvasMemoryStates.set(scope, { projects: [] });
                    observedCanvasPersists.set(scope, { projects: [], revision: 0 });
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
                observedCanvasPersists.set(scope, { projects: [], revision: 0 });
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

            const queued = queuedCanvasPersists.get(scope);
            const observed = observedCanvasPersists.get(scope);
            const token = (canvasPersistTokens.get(scope) || 0) + 1;
            canvasPersistTokens.set(scope, token);
            const baseProjects = queued?.baseProjects ?? observed?.projects ?? [];
            queuedCanvasPersists.set(scope, {
                name,
                scope,
                baseProjects,
                baseRevision: queued?.baseRevision ?? observed?.revision ?? 0,
                state: ordinaryCanvasPersistenceState(scope, nextState, observed?.projects ?? baseProjects),
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

if (typeof window !== "undefined") {
    window.__BEEFTV_FLUSH_BEFORE_RELOAD__ = () => {
        void flushCanvasStorePersistence();
    };
}
