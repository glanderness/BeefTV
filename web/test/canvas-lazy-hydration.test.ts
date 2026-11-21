import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mergeCanvasStorageProjects, parseCanvasStorageDocument, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";

let projects: any[] = [];
let recordedDeletedProjects: any[] = [];
let deletedHistoryEntries: Array<{ id: string; title: string; deletedAt: string; updatedAt: string; project: any }> = [];
let createdCounter = 0;
let failPutOnCall = 0;
let putCallCount = 0;
let failFlushOnce = false;
let delete404Ids = new Set<string>();
let delete500Ids = new Set<string>();
const bases = new Map<string, { revision: number; snapshot: any }>();
const journalMemory = new Map<string, any>();
let remotePages: any[][] = [];
const remoteDetailsById = new Map<string, any>();
const detailGetIds: string[] = [];
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
    createProject: (title: string, projectId?: string, workspaceProjectId?: string) => {
        const id = `created-${++createdCounter}`;
        const now = "2026-04-03T00:00:00.000Z";
        projects = [
            {
                id,
                revision: 0,
                workspaceProjectId: workspaceProjectId || id,
                projectId,
                title,
                createdAt: now,
                updatedAt: now,
                nodes: [],
                connections: [],
                chatSessions: [],
                activeChatId: null,
                backgroundMode: "grid",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                directorScenes: [],
            },
            ...projects,
        ];
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
    flushCanvasStorePersistence: async () => {
        if (failFlushOnce) {
            failFlushOnce = false;
            throw new Error("IndexedDB quota exceeded");
        }
    },
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
            deletedProjects: deletedHistoryEntries,
            recordDeletedProjects: (items: any[]) => {
                recordedDeletedProjects.push(...items);
                deletedHistoryEntries = [
                    ...items.map((item) => ({
                        id: item.id,
                        title: item.title,
                        deletedAt: "2026-04-03T00:00:00.000Z",
                        updatedAt: item.updatedAt,
                        project: item,
                    })),
                    ...deletedHistoryEntries,
                ];
            },
            removeDeletedHistoryItem: (id: string) => {
                deletedHistoryEntries = deletedHistoryEntries.filter((entry) => entry.id !== id);
            },
        }),
    },
}));

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: () => {},
    loadCanvasProjectForEditing: async (id: string) => {
        const mod = await import("@/services/local-workspace-repository");
        const loaded = await mod.openLocalCanvasProjectFromBackend(id);
        if (loaded?.summaryOnly) throw new Error("画布尚未完整加载，请重试");
        return loaded || undefined;
    },
}));

class MockCanvasBackendSubmitPausedError extends Error {
    constructor(message = "") {
        super(message);
        this.name = "CanvasBackendSubmitPausedError";
    }
}

mock.module("@/services/canvas-revision-conflict", () => ({
    CanvasBackendSubmitPausedError: MockCanvasBackendSubmitPausedError,
    isCanvasRevisionConflict: () => false,
    isCanvasSubmitControlError: (error: unknown) => error instanceof MockCanvasBackendSubmitPausedError,
    setCanvasBackendSaveProgress: () => {},
    clearCanvasBackendSaveProgress: () => {},
}));

mock.module("@/stores/use-asset-store", () => ({
    useAssetStore: { getState: () => ({ assets: [], addAsset: () => "unexpected-asset" }) },
}));

mock.module("@/services/workspace-mode", () => ({
    isLocalWorkspaceMode: () => true,
}));

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => "guest",
    setActiveUserScope: () => {},
    setWorkspaceStorageScope: () => {},
    onStorageNamespaceChange: () => () => {},
    scopedStorageKey: (name: string) => `${name}:user:guest`,
    scopedLocalStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    },
}));

mock.module("@/lib/canvas/canvas-content", () => ({
    stripCanvasNodeBookkeeping: (node: any) => node,
    normalizeCanvasProjectGraph: (proj: any) => ({
        ...proj,
        nodes: Array.isArray(proj?.nodes) ? proj.nodes : [],
        connections: Array.isArray(proj?.connections) ? proj.connections : [],
        viewport: proj?.viewport && typeof proj.viewport.k === "number" && proj.viewport.k > 0 ? proj.viewport : { x: 0, y: 0, k: 1 },
    }),
    sameCanvasDocument: (left: any, right: any) => {
        if (left === right) return true;
        if (!left || !right) return false;
        return JSON.stringify(left.nodes || []) === JSON.stringify(right.nodes || []) && left.title === right.title;
    },
}));

mock.module("@/lib/canvas/canvas-document-rebase", () => ({
    settleInFlightGenerationOverlay: ({ local }: any) => local,
    rebaseCanvasDocumentThreeWay: ({ local, remote }: any) => ({
        project: { ...local, revision: remote.revision, updatedAt: remote.updatedAt },
        conflict: false,
    }),
}));

mock.module("@/services/api/request", () => ({
    ApiError: MockApiError,
    getTransportFailureKind: () => undefined,
    apiBaseURL: "/api",
    apiClient: {},
    configureApiRuntime: () => {},
    request: async (promise: Promise<any>) => promise,
    compactApiParams: (params: Record<string, unknown>) => params,
    serializeApiParams: () => "",
    http: {
        get: async (path: string, config?: { params?: { page?: number } }) => {
            if (path === "/canvas-projects") {
                const page = config?.params?.page ?? 1;
                const batch = remotePages[page - 1] ?? [];
                return { projects: batch, hasMore: page < remotePages.length };
            }
            if (path.startsWith("/canvas-projects/")) {
                const id = decodeURIComponent(path.slice("/canvas-projects/".length));
                detailGetIds.push(id);
                const detail = remoteDetailsById.get(id);
                if (detail === "404") throw new MockApiError("画布不存在", 404);
                if (detail === "500") throw new MockApiError("后端暂时不可用", 500);
                if (!detail) throw new MockApiError("画布不存在", 404);
                return { project: detail };
            }
            throw new Error(`unexpected GET ${path}`);
        },
        put: async (path: string, body?: { project?: { id?: string } }) => {
            writeRequests.push({ method: "PUT", path });
            putCallCount += 1;
            const id = body?.project?.id || decodeURIComponent(path.slice("/canvas-projects/".length));
            if (failPutOnCall > 0 && putCallCount === failPutOnCall) {
                delete404Ids.add(id);
                throw new MockApiError("后端保存失败", 500);
            }
            return { project: { id, revision: 1, updatedAt: "2026-04-03T00:00:00.000Z" } };
        },
        patch: async (path: string) => {
            writeRequests.push({ method: "PATCH", path });
            return {};
        },
        post: async (path: string) => {
            writeRequests.push({ method: "POST", path });
            return {};
        },
        delete: async (path: string) => {
            writeRequests.push({ method: "DELETE", path });
            const id = decodeURIComponent(path.slice("/canvas-projects/".length));
            if (delete500Ids.has(id)) {
                throw new MockApiError("后端删除服务不可用", 500);
            }
            if (delete404Ids.has(id)) {
                throw new MockApiError("画布不存在", 404);
            }
            return {};
        },
    },
}));

mock.module("@/services/api/operations", () => ({
    commitCanvasDocument: async (payload: { id?: string }) => {
        writeRequests.push({ method: "COMMIT", path: payload?.id ?? "" });
        return { revision: 1, result: {} };
    },
    patchCanvasDocument: async (payload: { id?: string }) => {
        writeRequests.push({ method: "PATCH", path: payload?.id ?? "" });
        return { revision: 1, result: {} };
    },
}));

mock.module("@/services/canvas-operation-journal", () => {
    class MockCanvasJournalError extends Error {
        constructor(message = "") {
            super(message);
            this.name = "CanvasJournalError";
        }
    }
    const updateJournal = async (id: string, _scope: string, updater: (cur: any) => any) => {
        const current = journalMemory.get(id) ?? emptyJournal(id);
        const next = await updater(current);
        if (next == null) return current;
        journalMemory.set(id, next);
        return next;
    };
    return {
        CanvasJournalError: MockCanvasJournalError,
        loadCanvasOperationJournal: async (id: string) => {
            const existing = journalMemory.get(id) ?? emptyJournal(id);
            journalMemory.set(id, existing);
            return existing;
        },
        peekCanvasOperationJournal: (id: string) => journalMemory.get(id) ?? null,
        saveCanvasOperationJournal: async (journal: any) => {
            journalMemory.set(journal.canvasId, journal);
        },
        updateCanvasOperationJournal: updateJournal,
        recordConfirmedCanvasCommit: async (proj: any, _scope: string, options?: any) =>
            updateJournal(proj.id, "guest", (current) => {
                const incoming = proj.revision ?? current.confirmedRevision;
                const ackMatches = options?.ackOperationId && current.inFlight?.operationId === options.ackOperationId;
                const recoveryBase = current.pendingProjection?.base ?? current.confirmedSnapshot;
                return {
                    ...current,
                    confirmedRevision: Math.max(current.confirmedRevision, incoming),
                    confirmedSnapshot: incoming < current.confirmedRevision ? current.confirmedSnapshot : proj,
                    inFlight: ackMatches ? null : current.inFlight,
                    pendingProjection:
                        options?.unflushedProjection && recoveryBase
                            ? { identity: "proj-test", revision: incoming, base: recoveryBase, remote: proj }
                            : current.pendingProjection,
                };
            }),
        clearCanvasPendingProjection: async (id: string, _scope: string, identity: string) =>
            updateJournal(id, "guest", (current) => {
                if (current.pendingProjection?.identity !== identity) return;
                return { ...current, pendingProjection: null };
            }),
        markCanvasJournalForceHistorySnapshot: async () => undefined,
        abandonCanvasInFlight: async () => {},
        clearCanvasOperationJournal: async (id: string) => {
            journalMemory.delete(id);
        },
        newCanvasCommitOperationId: () => "op",
        newCanvasProjectionIdentity: () => "proj-test",
    };
});

const repository = await import("@/services/local-workspace-repository");
const workspaceProjects = await import("@/services/workspace-project-repository");
const repair = await import("@/services/canvas-asset-repair");
const { exportCanvasProjects } = await import("@/lib/canvas/canvas-export");
const { prepareRestoredDeletedCanvas, restoreDeletedCanvasProjects } = workspaceProjects;

function summaryItem(index: number) {
    const id = `canvas-${index}`;
    return {
        id,
        workspaceProjectId: index % 2 === 0 ? `ws-${index}` : `ws-${index - 1}`,
        folderId: index < 10 ? "folder-1" : undefined,
        title: `画布 ${index}`,
        canvasTitle: `分镜 ${index}`,
        revision: 2,
        localMediaKeys: index === 0 ? ["image:guest:local-1", "audio:guest:bgm-1"] : undefined,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: `2026-04-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
        nodeCount: 12,
        previewNodes: [
            {
                id: `img-${index}`,
                type: "image",
                position: { x: 0, y: 0 },
                metadata: { storageKey: `image:k-${index}`, content: `/api/resources/r-${index}/file` },
            },
        ],
    };
}

function fullProject(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        workspaceProjectId: `ws-${id}`,
        title: `完整 ${id}`,
        revision: 2,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-02T01:00:00.000Z",
        nodes: [
            { id: "n1", type: "text", position: { x: 0, y: 0 }, metadata: { content: "正文" } },
            { id: "n2", type: "image", position: { x: 100, y: 0 }, metadata: { content: "/api/resources/full/file", storageKey: "image:full" } },
        ],
        connections: [{ id: "c1", from: "n1", to: "n2" }],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid" as const,
        showImageInfo: false,
        viewport: { x: 12, y: 24, k: 1.5 },
        directorScenes: [],
        ...overrides,
    };
}

describe("canvas lazy hydration", () => {
    beforeEach(() => {
        projects = [];
        recordedDeletedProjects = [];
        deletedHistoryEntries = [];
        createdCounter = 0;
        failPutOnCall = 0;
        putCallCount = 0;
        failFlushOnce = false;
        delete404Ids = new Set<string>();
        delete500Ids = new Set<string>();
        bases.clear();
        journalMemory.clear();
        remotePages = [];
        remoteDetailsById.clear();
        detailGetIds.length = 0;
        writeRequests.length = 0;
        repository.resetLocalCanvasBackendSaveState();
    });

    it("hydrates 64 paginated canvases with zero per-canvas detail GETs and loads full on demand", async () => {
        const summaries = Array.from({ length: 64 }, (_, index) => summaryItem(index));
        remotePages = [summaries.slice(0, 50), summaries.slice(50)];
        remoteDetailsById.set("canvas-5", fullProject("canvas-5", { workspaceProjectId: "ws-4", title: "画布 5", canvasTitle: "分镜 5" }));

        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(detailGetIds).toEqual([]);
        expect(projects).toHaveLength(64);
        expect(projects.every((item) => item.summaryOnly === true)).toBe(true);
        expect(projects[5]).toMatchObject({
            id: "canvas-5",
            workspaceProjectId: "ws-4",
            folderId: "folder-1",
            canvasTitle: "分镜 5",
            summaryOnly: true,
            summaryNodeCount: 12,
        });

        const opened = await repository.openLocalCanvasProjectFromBackend("canvas-5");
        expect(detailGetIds).toEqual(["canvas-5"]);
        expect(opened?.summaryOnly).toBeUndefined();
        expect(opened?.nodes).toHaveLength(2);
        expect(opened?.connections).toHaveLength(1);
        expect(projects.filter((item) => !item.summaryOnly).map((item) => item.id)).toEqual(["canvas-5"]);
        expect(projects.filter((item) => item.summaryOnly === true)).toHaveLength(63);
    });

    it("preserves real journal.inFlight.payload.document edits on open (200 and 500) and never returns summaryOnly", async () => {
        remotePages = [[summaryItem(0), summaryItem(1), summaryItem(2)]];
        const staleBackend0 = fullProject("canvas-0", { revision: 2, title: "服务端旧版本" });
        const pendingInFlightDoc0 = fullProject("canvas-0", {
            revision: 2,
            title: "崩溃前未确认编辑",
            nodes: [
                { id: "n1", type: "text", position: { x: 0, y: 0 }, metadata: { content: "本地未确认节点" } },
                { id: "n2", type: "image", position: { x: 100, y: 0 }, metadata: { content: "/api/resources/full/file" } },
                { id: "n3", type: "text", position: { x: 200, y: 0 }, metadata: { content: "新增第三节点" } },
            ],
        });
        const pendingInFlightDoc2 = fullProject("canvas-2", { revision: 2, title: "离线恢复中的未确认编辑" });
        const full1 = fullProject("canvas-1", { revision: 2 });
        const confirmed1 = fullProject("canvas-1", { revision: 4, title: "更高已确认版本" });
        remoteDetailsById.set("canvas-0", staleBackend0);
        remoteDetailsById.set("canvas-1", full1);
        remoteDetailsById.set("canvas-2", "500");

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(projects[0]?.summaryMediaKeys).toEqual(["image:guest:local-1", "audio:guest:bgm-1"]);

        journalMemory.set("canvas-0", {
            ...emptyJournal("canvas-0"),
            confirmedRevision: 2,
            confirmedSnapshot: staleBackend0,
            inFlight: {
                operationId: "op-crash-0",
                expectedRevision: 2,
                payload: {
                    canvasId: "canvas-0",
                    expectedRevision: 2,
                    document: pendingInFlightDoc0,
                },
            },
        });
        journalMemory.set("canvas-1", {
            ...emptyJournal("canvas-1"),
            confirmedRevision: 4,
            confirmedSnapshot: confirmed1,
        });
        journalMemory.set("canvas-2", {
            ...emptyJournal("canvas-2"),
            confirmedRevision: 2,
            inFlight: {
                operationId: "op-crash-2",
                expectedRevision: 2,
                payload: {
                    canvasId: "canvas-2",
                    expectedRevision: 2,
                    document: pendingInFlightDoc2,
                },
            },
        });

        const opened0 = await repository.openLocalCanvasProjectFromBackend("canvas-0");
        expect(opened0?.summaryOnly).toBeUndefined();
        expect(opened0?.title).toBe("崩溃前未确认编辑");
        expect(opened0?.nodes).toHaveLength(3);

        const opened1 = await repository.openLocalCanvasProjectFromBackend("canvas-1");
        expect(opened1?.summaryOnly).toBeUndefined();
        expect(opened1?.title).toBe("更高已确认版本");
        expect(opened1?.connections).toHaveLength(1);

        // Even when backend returns 500 during open, in-flight document recovers cleanly instead of deadlocking.
        const opened2 = await repository.openLocalCanvasProjectFromBackend("canvas-2");
        expect(opened2?.summaryOnly).toBeUndefined();
        expect(opened2?.title).toBe("离线恢复中的未确认编辑");
    });

    it("loads full documents into recycle bin before deleting, restores at revision 0 via PUT, and supports history-free rollback deletes", async () => {
        remotePages = [[summaryItem(0), summaryItem(1), summaryItem(2)]];
        const full0 = fullProject("canvas-0", { revision: 2, remoteContentHash: "old-hash" });
        const full2 = fullProject("canvas-2", { revision: 1 });
        remoteDetailsById.set("canvas-0", full0);
        remoteDetailsById.set("canvas-1", "500");
        remoteDetailsById.set("canvas-2", full2);

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(projects[0]?.summaryOnly).toBe(true);

        // Non-404 preload error aborts deletion before issuing DELETE.
        await expect(repository.deleteLocalCanvasProjects(["canvas-1"])).rejects.toThrow("后端暂时不可用");
        expect(writeRequests).toEqual([]);
        expect(projects.some((item) => item.id === "canvas-1")).toBe(true);

        // History-free rollback deletion removes without polluting recycle bin.
        await repository.deleteLocalCanvasProjects(["canvas-2"], { recordHistory: false });
        expect(recordedDeletedProjects).toHaveLength(0);

        await repository.deleteLocalCanvasProjects(["canvas-0"]);
        expect(writeRequests).toEqual([
            { method: "DELETE", path: "/canvas-projects/canvas-2" },
            { method: "DELETE", path: "/canvas-projects/canvas-0" },
        ]);
        expect(recordedDeletedProjects).toHaveLength(1);
        expect(recordedDeletedProjects[0]?.summaryOnly).toBeUndefined();
        expect(recordedDeletedProjects[0]?.nodes).toHaveLength(2);
        expect(recordedDeletedProjects[0]?.connections).toHaveLength(1);

        // Restore via prepareRestoredDeletedCanvas resets revision to 0 and clears remoteContentHash
        // so desktop draft persistence retains it and syncLocalCanvasProjectToBackend recreates it via PUT.
        const restored = prepareRestoredDeletedCanvas(recordedDeletedProjects[0]);
        expect(restored.revision).toBe(0);
        expect(restored.remoteContentHash).toBeUndefined();
        expect(restored.summaryOnly).toBeUndefined();
        projects = [restored, ...projects];
        writeRequests.length = 0;

        await repository.syncLocalCanvasProjectToBackend(restored.id);
        expect(writeRequests).toEqual([{ method: "PUT", path: "/canvas-projects/canvas-0" }]);
        expect(projects.find((item) => item.id === "canvas-0")?.revision).toBe(1);
    });

    it("rethrows non-404 read errors instead of opening a summaryOnly preview as editable", async () => {
        remotePages = [[summaryItem(0)]];
        remoteDetailsById.set("canvas-0", "500");

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(projects[0]?.summaryOnly).toBe(true);
        await expect(repository.openLocalCanvasProjectFromBackend("canvas-0")).rejects.toThrow("后端暂时不可用");
    });

    it("refuses to persist or sync summaryOnly canvases back to the backend", async () => {
        remotePages = [[summaryItem(0)]];
        await repository.hydrateLocalCanvasProjectsFromBackend();

        await expect(repository.persistCanvasDocument("canvas-0", { title: "误改" })).rejects.toThrow("画布尚未完整加载");
        await expect(repository.syncLocalCanvasProjectToBackend("canvas-0")).rejects.toThrow("画布尚未完整加载");
        expect(writeRequests).toEqual([]);
    });

    it("keeps unchanged full canvases without re-fetching and only fetches moved full canvases", async () => {
        const cleanFull = fullProject("canvas-0", { revision: 2 });
        const movedFull = fullProject("canvas-1", { revision: 2 });
        const updatedMoved = fullProject("canvas-1", { revision: 3, title: "远端更新" });
        projects = [cleanFull, movedFull];
        bases.set(cleanFull.id, { revision: 2, snapshot: cleanFull });
        bases.set(movedFull.id, { revision: 2, snapshot: movedFull });

        remotePages = [[
            { ...summaryItem(0), id: "canvas-0", revision: 2 },
            { ...summaryItem(1), id: "canvas-1", revision: 3 },
            { ...summaryItem(2), id: "canvas-2", revision: 1 },
        ]];
        remoteDetailsById.set("canvas-1", updatedMoved);

        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(detailGetIds).toEqual(["canvas-1"]);
        expect(projects.find((item) => item.id === "canvas-0")?.summaryOnly).toBeUndefined();
        expect(projects.find((item) => item.id === "canvas-0")?.connections).toHaveLength(1);
        expect(projects.find((item) => item.id === "canvas-1")?.title).toBe("远端更新");
        expect(projects.find((item) => item.id === "canvas-2")?.summaryOnly).toBe(true);
    });

    it("skips summaryOnly canvases during asset repair and never overwrites full durable IndexedDB projects", async () => {
        remotePages = [[summaryItem(0)]];
        await repository.hydrateLocalCanvasProjectsFromBackend();

        expect(repair.repairMissingCanvasAssets()).toEqual({ createdAssets: 0, updatedProjects: 0 });
        expect(repair.rebindInconsistentCanvasAssets([])).toEqual({ reboundNodes: 0, createdAssets: 0, updatedProjects: 0 });
        expect(repair.collectCanvasMediaAssetIds(projects)).toEqual(new Set());

        const durableFull = fullProject("canvas-0", { revision: 2 });
        const durable: CanvasStorageDocument = {
            state: { projects: [durableFull as any] },
            version: 0,
            storageRevision: 4,
            deletedProjectIds: {},
        };
        const merged = mergeCanvasStorageProjects({
            durable,
            baseProjects: [],
            localProjects: projects,
            baseRevision: 4,
        });
        expect(merged.document.state.projects).toHaveLength(1);
        expect(merged.document.state.projects[0]?.summaryOnly).toBeUndefined();
        expect(merged.document.state.projects[0]?.connections).toHaveLength(1);

        const parsed = parseCanvasStorageDocument(JSON.stringify({
            state: { projects: [projects[0], durableFull] },
            version: 0,
            storageRevision: 5,
        }));
        expect(parsed.state.projects).toHaveLength(1);
        expect(parsed.state.projects[0]?.summaryOnly).toBeUndefined();

        // Deleting a summaryOnly canvas still tombstones and evicts a prior full durable entry in IndexedDB.
        const deletedMerge = mergeCanvasStorageProjects({
            durable,
            baseProjects: projects,
            localProjects: [],
            baseRevision: 4,
        });
        expect(deletedMerge.document.state.projects).toEqual([]);
        expect(deletedMerge.document.deletedProjectIds?.["canvas-0"]).toBeGreaterThan(4);

        // Unopened summaryOnly canvas with no prior durable entry is never serialized into IndexedDB.
        const emptyDurable: CanvasStorageDocument = { state: { projects: [] }, version: 0, storageRevision: 1, deletedProjectIds: {} };
        const summaryOnlyWrite = mergeCanvasStorageProjects({
            durable: emptyDurable,
            baseProjects: [],
            localProjects: projects,
            baseRevision: 1,
        });
        expect(summaryOnlyWrite.document.state.projects).toEqual([]);

        await expect(exportCanvasProjects([projects[0]])).rejects.toThrow("画布尚未完整加载");
    });

    it("inserts recovered in-flight journal document into store on deep-link 500/404 so edits remain saveable", async () => {
        const pendingDoc = fullProject("deep-link-1", { revision: 2, title: "深链崩溃恢复稿" });
        remoteDetailsById.set("deep-link-1", "500");
        journalMemory.set("deep-link-1", {
            ...emptyJournal("deep-link-1"),
            confirmedRevision: 2,
            inFlight: {
                operationId: "op-deep-link",
                expectedRevision: 2,
                payload: {
                    canvasId: "deep-link-1",
                    expectedRevision: 2,
                    document: pendingDoc,
                },
            },
        });

        // Store has NO entry for deep-link-1 (e.g. list hydration failed before direct URL open).
        expect(projects).toHaveLength(0);
        const recovered = await repository.openLocalCanvasProjectFromBackend("deep-link-1");
        expect(recovered?.id).toBe("deep-link-1");
        expect(recovered?.title).toBe("深链崩溃恢复稿");
        expect(projects.some((item) => item.id === "deep-link-1" && !item.summaryOnly)).toBe(true);

        // Subsequent edits and commits operate on the inserted store entry cleanly.
        await repository.persistCanvasDocument("deep-link-1", { title: "深链二次编辑" });
        expect(projects.find((item) => item.id === "deep-link-1")?.title).toBe("深链二次编辑");
        expect(writeRequests.some((req) => req.method === "COMMIT" || req.method === "PATCH")).toBe(true);
    });

    it("captures in-flight journal document into recycle bin when deleting a summaryOnly canvas", async () => {
        remotePages = [[summaryItem(0)]];
        remoteDetailsById.set("canvas-0", fullProject("canvas-0", { revision: 2, title: "服务端旧稿" }));
        await repository.hydrateLocalCanvasProjectsFromBackend();

        const inFlightDoc = fullProject("canvas-0", { revision: 2, title: "在途未确认最新稿" });
        journalMemory.set("canvas-0", {
            ...emptyJournal("canvas-0"),
            confirmedRevision: 2,
            inFlight: {
                operationId: "op-del-0",
                expectedRevision: 2,
                payload: {
                    canvasId: "canvas-0",
                    expectedRevision: 2,
                    document: inFlightDoc,
                },
            },
        });

        await repository.deleteLocalCanvasProjects(["canvas-0"]);
        expect(recordedDeletedProjects).toHaveLength(1);
        expect(recordedDeletedProjects[0]?.title).toBe("在途未确认最新稿");
        expect(detailGetIds).toEqual([]);
    });

    it("rolls back both persisted and failed revision-0 copies when duplicating a multi-canvas project fails mid-way", async () => {
        remotePages = [[
            { ...summaryItem(0), id: "canvas-0", workspaceProjectId: "ws-multi" },
            { ...summaryItem(1), id: "canvas-1", workspaceProjectId: "ws-multi" },
        ]];
        remoteDetailsById.set("canvas-0", fullProject("canvas-0", { workspaceProjectId: "ws-multi", title: "主画布" }));
        remoteDetailsById.set("canvas-1", fullProject("canvas-1", { workspaceProjectId: "ws-multi", title: "第二画布" }));
        await repository.hydrateLocalCanvasProjectsFromBackend();

        failPutOnCall = 2;
        await expect(
            workspaceProjects.duplicateWorkspaceCanvasProject(projects, { id: "canvas-0", title: "主画布" }),
        ).rejects.toThrow("后端保存失败");

        // Both created-1 (revision 1 on backend) and created-2 (revision 0 returning 404 on DELETE) must be cleaned up.
        expect(projects.map((item) => item.id)).toEqual(["canvas-0", "canvas-1"]);
        expect(recordedDeletedProjects).toHaveLength(0);
        expect(deletedHistoryEntries).toHaveLength(0);
        expect(writeRequests.filter((req) => req.method === "DELETE").map((req) => req.path)).toEqual([
            "/canvas-projects/created-2",
            "/canvas-projects/created-1",
        ]);
    });

    it("keeps recycle-bin entry and rolls back active store when restore backend PUT fails, and removes it on success", async () => {
        const deletedFull = fullProject("canvas-restore-1", { revision: 3, title: "回收站画布" });
        deletedHistoryEntries = [{
            id: deletedFull.id,
            title: deletedFull.title,
            deletedAt: "2026-04-03T00:00:00.000Z",
            updatedAt: deletedFull.updatedAt,
            project: deletedFull,
        }];

        failPutOnCall = 1;
        const failed = await restoreDeletedCanvasProjects(["canvas-restore-1"]);
        expect(failed.restoredIds).toEqual([]);
        expect(failed.failedIds).toEqual(["canvas-restore-1"]);
        expect(failed.firstError).toBeInstanceOf(Error);
        expect(projects).toHaveLength(0);
        expect(deletedHistoryEntries).toHaveLength(1);

        failPutOnCall = 0;
        putCallCount = 0;
        delete404Ids.clear();
        const succeeded = await restoreDeletedCanvasProjects(["canvas-restore-1"]);
        expect(succeeded.restoredIds).toEqual(["canvas-restore-1"]);
        expect(succeeded.failedIds).toEqual([]);
        expect(projects.find((item) => item.id === "canvas-restore-1")?.revision).toBe(1);
        expect(deletedHistoryEntries).toHaveLength(0);
    });

    it("cleans up failed revision-0 copy even under DELETE 500 and surfaces rollback error for both persisted and uncertain unpersisted copies", async () => {
        remotePages = [[
            { ...summaryItem(0), id: "canvas-0", workspaceProjectId: "ws-multi" },
            { ...summaryItem(1), id: "canvas-1", workspaceProjectId: "ws-multi" },
        ]];
        remoteDetailsById.set("canvas-0", fullProject("canvas-0", { workspaceProjectId: "ws-multi", title: "主画布" }));
        remoteDetailsById.set("canvas-1", fullProject("canvas-1", { workspaceProjectId: "ws-multi", title: "第二画布" }));
        await repository.hydrateLocalCanvasProjectsFromBackend();

        failPutOnCall = 2;
        delete500Ids.add("created-1");
        delete500Ids.add("created-2");
        await expect(
            workspaceProjects.duplicateWorkspaceCanvasProject(projects, { id: "canvas-0", title: "主画布" }),
        ).rejects.toThrow("回滚清理未确认");

        // Unpersisted revision-0 copy (created-2) must NEVER remain in active store even when DELETE returns 500.
        expect(projects.some((item) => item.id === "created-2")).toBe(false);
        expect(recordedDeletedProjects).toHaveLength(0);

        // Single-canvas duplication with PUT 500 + DELETE 500 (response-lost uncertainty):
        // removes local draft AND surfaces rollback warning instead of swallowing DELETE 500.
        projects = [fullProject("solo-0", { workspaceProjectId: "ws-solo", title: "单画布" })];
        failPutOnCall = 1;
        putCallCount = 0;
        delete500Ids = new Set(["created-3"]);
        await expect(
            workspaceProjects.duplicateWorkspaceCanvasProject(projects, { id: "solo-0", title: "单画布" }),
        ).rejects.toThrow("回滚清理未确认");
        expect(projects.map((item) => item.id)).toEqual(["solo-0"]);
    });

    it("handles flush failure cleanly without leaving restored drafts in store and reports summaryOnly recycle-bin entries", async () => {
        const deletedFull = fullProject("canvas-flush-fail", { revision: 3, title: "写盘失败画布" });
        const legacySummary = { ...fullProject("canvas-legacy-summary", { title: "旧摘要记录" }), summaryOnly: true };
        deletedHistoryEntries = [
            {
                id: deletedFull.id,
                title: deletedFull.title,
                deletedAt: "2026-04-03T00:00:00.000Z",
                updatedAt: deletedFull.updatedAt,
                project: deletedFull,
            },
            {
                id: legacySummary.id,
                title: legacySummary.title,
                deletedAt: "2026-04-03T00:00:00.000Z",
                updatedAt: legacySummary.updatedAt,
                project: legacySummary,
            },
        ];

        failFlushOnce = true;
        const flushFailed = await restoreDeletedCanvasProjects(["canvas-flush-fail"]);
        expect(flushFailed.restoredIds).toEqual([]);
        expect(flushFailed.failedIds).toEqual(["canvas-flush-fail"]);
        expect(flushFailed.firstError).toBeInstanceOf(Error);
        expect(projects).toHaveLength(0);
        expect(deletedHistoryEntries).toHaveLength(2);

        const summaryOnlyResult = await restoreDeletedCanvasProjects(["canvas-legacy-summary"]);
        expect(summaryOnlyResult.restoredIds).toEqual([]);
        expect(summaryOnlyResult.failedIds).toEqual(["canvas-legacy-summary"]);
        expect((summaryOnlyResult.firstError as Error)?.message).toContain("仅包含摘要");
        expect(deletedHistoryEntries).toHaveLength(2);
    });
});
