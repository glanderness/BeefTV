import { beforeEach, describe, expect, it, mock } from "bun:test";

let projects: any[] = [];
let recordedDeletedProjects: any[] = [];
const bases = new Map<string, { revision: number; snapshot: any }>();
const journalMemory = new Map<string, any>();
let failClearJournalIds = new Set<string>();
let delete404Ids = new Set<string>();
let getDelayMsById = new Map<string, number>();
let get500Ids = new Set<string>();
let putHangUntilAbortIds = new Set<string>();
let putAbortedIds: string[] = [];
let getAbortedIds: string[] = [];
const writeRequests: Array<{ method: string; path: string }> = [];

class MockApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

const emptyJournal = (id: string) => ({
    userScope: "guest",
    canvasId: id,
    confirmedRevision: 0,
    confirmedSnapshot: null,
    inFlight: null,
    pendingProjection: null,
});

const getStoreState = () => ({
    projects,
    openProject: (id: string) => projects.find((item) => item.id === id) ?? null,
    createProject: (title: string) => {
        const id = `created-${projects.length + 1}`;
        projects = [fullProject(id, { revision: 0, title }), ...projects];
        return id;
    },
    updateProject: (id: string, patch: Record<string, unknown>) => {
        projects = projects.map((item) => (item.id === id ? { ...item, ...patch } : item));
    },
    deleteProjects: (ids: string[]) => {
        projects = projects.filter((item) => !ids.includes(item.id));
    },
    restoreProject: (item: any) => {
        if (!projects.some((existing) => existing.id === item.id)) {
            projects = [item, ...projects];
        }
    },
});

mock.module("@/stores/canvas/use-canvas-store", () => ({
    useCanvasStore: {
        getState: getStoreState,
        setState: (update: any) => {
            const patch = typeof update === "function" ? update(getStoreState()) : update;
            if (patch.projects) projects = patch.projects;
        },
    },
    flushCanvasStorePersistence: async () => undefined,
    canvasDurableSnapshot: () => undefined,
    recordCanvasDocumentBase: (proj: any) => {
        bases.set(proj.id, { revision: proj.revision ?? 0, snapshot: proj });
    },
    canvasDocumentBase: (id: string) => bases.get(id),
    clearCanvasDocumentBase: (id: string) => {
        bases.delete(id);
    },
}));

mock.module("@/stores/canvas/use-canvas-history-store", () => ({
    useCanvasHistoryStore: {
        getState: () => ({
            deletedProjects: [],
            recordDeletedProjects: (items: any[]) => {
                recordedDeletedProjects.push(...items);
            },
            removeDeletedHistoryItem: () => undefined,
        }),
    },
}));

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: () => undefined,
    loadCanvasProjectForEditing: async () => undefined,
}));

class MockCanvasBackendSubmitPausedError extends Error {
    constructor(message = "") {
        super(message);
        this.name = "CanvasBackendSubmitPausedError";
    }
}

mock.module("@/services/canvas-revision-conflict", () => ({
    CanvasBackendSubmitPausedError: MockCanvasBackendSubmitPausedError,
    clearCanvasBackendSaveProgress: () => undefined,
    isCanvasRevisionConflict: (error: unknown) => error instanceof MockApiError && error.status === 409,
    isCanvasSubmitControlError: (error: unknown) => error instanceof MockCanvasBackendSubmitPausedError,
    setCanvasBackendSaveProgress: () => undefined,
}));

class MockCanvasJournalError extends Error {
    constructor(message = "") {
        super(message);
        this.name = "CanvasJournalError";
    }
}

mock.module("@/services/canvas-operation-journal", () => ({
    CanvasJournalError: MockCanvasJournalError,
    loadCanvasOperationJournal: async (id: string) => structuredClone(journalMemory.get(id) ?? emptyJournal(id)),
    peekCanvasOperationJournal: (id: string) => journalMemory.get(id) ?? null,
    saveCanvasOperationJournal: async (journal: any) => {
        journalMemory.set(journal.canvasId, structuredClone(journal));
    },
    updateCanvasOperationJournal: async (id: string, _scope: string, updater: (current: any) => any) => {
        const current = structuredClone(journalMemory.get(id) ?? emptyJournal(id));
        const next = updater(current);
        const stored = next ?? current;
        journalMemory.set(id, structuredClone(stored));
        return structuredClone(stored);
    },
    recordConfirmedCanvasCommit: async (project: any) => {
        const next = {
            ...emptyJournal(project.id),
            confirmedRevision: project.revision ?? 0,
            confirmedSnapshot: structuredClone(project),
            inFlight: null,
            pendingProjection: null,
        };
        journalMemory.set(project.id, structuredClone(next));
        return structuredClone(next);
    },
    clearCanvasPendingProjection: async () => undefined,
    abandonCanvasInFlight: async () => undefined,
    clearCanvasOperationJournal: async (id: string) => {
        if (failClearJournalIds.has(id)) {
            throw new Error("IndexedDB transaction failed during journal clear");
        }
        journalMemory.delete(id);
    },
    markCanvasJournalForceHistorySnapshot: async () => undefined,
    newCanvasCommitOperationId: () => "op-resilience",
    newCanvasProjectionIdentity: () => "proj-resilience",
}));

mock.module("@/services/api/operations", () => ({
    patchCanvasDocument: async () => ({ op: "canvas.document.patch", replayed: false, result: { revision: 2 } }),
    commitCanvasDocument: async () => ({ op: "canvas.document.commit", replayed: false, result: { revision: 2 } }),
}));

mock.module("@/services/api/request", () => ({
    ApiError: MockApiError,
    getTransportFailureKind: () => undefined,
    apiBaseURL: "/api",
    apiClient: {},
    configureApiRuntime: () => undefined,
    request: async (promise: Promise<any>) => promise,
    compactApiParams: (params: Record<string, unknown>) => params,
    serializeApiParams: () => "",
    http: {
        get: async (path: string, config?: { signal?: AbortSignal }) => {
            const id = decodeURIComponent(path.replace("/canvas-projects/", ""));
            if (get500Ids.has(id)) {
                throw new MockApiError("后端暂时不可用", 500);
            }
            const delayMs = getDelayMsById.get(id);
            if (delayMs !== undefined) {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, delayMs);
                    config?.signal?.addEventListener("abort", () => {
                        clearTimeout(timer);
                        getAbortedIds.push(id);
                        reject(new DOMException("Aborted", "AbortError"));
                    }, { once: true });
                });
            }
            return { project: fullProject(id, { revision: 2 }) };
        },
        put: async (path: string, body: any, config?: { signal?: AbortSignal }) => {
            const id = decodeURIComponent(path.replace("/canvas-projects/", ""));
            writeRequests.push({ method: "PUT", path });
            if (putHangUntilAbortIds.has(id)) {
                await new Promise<void>((_resolve, reject) => {
                    if (config?.signal?.aborted) {
                        putAbortedIds.push(id);
                        reject(new DOMException("Aborted", "AbortError"));
                        return;
                    }
                    config?.signal?.addEventListener("abort", () => {
                        putAbortedIds.push(id);
                        reject(new DOMException("Aborted", "AbortError"));
                    }, { once: true });
                });
            }
            return {
                project: {
                    id,
                    title: body.project.title,
                    createdAt: body.project.createdAt,
                    updatedAt: body.project.updatedAt,
                    revision: (body.project.revision ?? 0) + 1,
                },
            };
        },
        delete: async (path: string) => {
            const id = decodeURIComponent(path.replace("/canvas-projects/", ""));
            writeRequests.push({ method: "DELETE", path });
            if (delete404Ids.has(id)) {
                throw new MockApiError("画布不存在", 404);
            }
            return { id };
        },
    },
}));

mock.module("@/services/workspace-mode", () => ({
    isLocalWorkspaceMode: () => true,
}));

const repository = await import("@/services/local-workspace-repository");

function fullProject(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        revision: 1,
        workspaceProjectId: id,
        title: `画布 ${id}`,
        createdAt: "2026-11-27T00:00:00.000Z",
        updatedAt: "2026-11-27T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...overrides,
    };
}

describe("#326 canvas delete resilience and in-flight save abort", () => {
    beforeEach(() => {
        projects = [];
        recordedDeletedProjects = [];
        bases.clear();
        journalMemory.clear();
        failClearJournalIds.clear();
        delete404Ids.clear();
        getDelayMsById.clear();
        get500Ids.clear();
        putHangUntilAbortIds.clear();
        putAbortedIds = [];
        getAbortedIds = [];
        writeRequests.length = 0;
        repository.resetLocalCanvasBackendSaveState();
    });

    it("bounds summaryOnly snapshot GET (timeout or 500) as best-effort and still executes DELETE", async () => {
        projects = [
            fullProject("canvas-slow-get", { revision: 2, summaryOnly: true }),
            fullProject("canvas-500-get", { revision: 2, summaryOnly: true }),
        ];
        getDelayMsById.set("canvas-slow-get", 4_000);
        get500Ids.add("canvas-500-get");

        const start = Date.now();
        await repository.deleteLocalCanvasProjects(["canvas-slow-get", "canvas-500-get"], {
            snapshotTimeoutMs: 60,
        });
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(1_000);
        expect(getAbortedIds).toEqual(["canvas-slow-get"]);
        expect(writeRequests).toEqual([
            { method: "DELETE", path: "/canvas-projects/canvas-slow-get" },
            { method: "DELETE", path: "/canvas-projects/canvas-500-get" },
        ]);
        expect(projects).toEqual([]);
        expect(recordedDeletedProjects).toHaveLength(0);
    });

    it("treats 404 on DELETE unconditionally as deleted even for persisted revision >= 1 with recordHistory", async () => {
        const persisted = fullProject("canvas-already-gone", { revision: 3 });
        projects = [persisted];
        bases.set(persisted.id, { revision: 3, snapshot: persisted });
        delete404Ids.add("canvas-already-gone");

        await repository.deleteLocalCanvasProjects(["canvas-already-gone"], { recordHistory: true });

        expect(writeRequests).toEqual([{ method: "DELETE", path: "/canvas-projects/canvas-already-gone" }]);
        expect(projects).toEqual([]);
        expect(bases.has("canvas-already-gone")).toBe(false);
        expect(recordedDeletedProjects.map((p) => p.id)).toEqual(["canvas-already-gone"]);
    });

    it("never resurrects a zombie entry when secondary IndexedDB/journal cleanup throws after backend DELETE", async () => {
        const target = fullProject("canvas-cleanup-fail", { revision: 2 });
        projects = [target];
        bases.set(target.id, { revision: 2, snapshot: target });
        failClearJournalIds.add("canvas-cleanup-fail");

        await repository.deleteLocalCanvasProjects(["canvas-cleanup-fail"]);

        expect(writeRequests).toEqual([{ method: "DELETE", path: "/canvas-projects/canvas-cleanup-fail" }]);
        expect(projects).toEqual([]);
        expect(bases.has("canvas-cleanup-fail")).toBe(false);
    });

    it("actively aborts an in-flight canvas save request before issuing DELETE", async () => {
        const draft = fullProject("canvas-inflight", { revision: 0 });
        projects = [draft];
        putHangUntilAbortIds.add("canvas-inflight");

        const savePromise = repository.syncLocalCanvasProjectToBackend("canvas-inflight").catch((err) => err);
        // Wait a microtask tick so the PUT enters flight and registers its abort listener.
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(writeRequests).toEqual([{ method: "PUT", path: "/canvas-projects/canvas-inflight" }]);

        await repository.deleteLocalCanvasProjects(["canvas-inflight"], { idleSettleTimeoutMs: 200 });
        const saveResult = await savePromise;

        expect(putAbortedIds).toEqual(["canvas-inflight"]);
        expect(saveResult).toBeInstanceOf(MockCanvasBackendSubmitPausedError);
        expect(writeRequests).toEqual([
            { method: "PUT", path: "/canvas-projects/canvas-inflight" },
            { method: "DELETE", path: "/canvas-projects/canvas-inflight" },
        ]);
        expect(projects).toEqual([]);
    });
});
