import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mergeCanvasStorageProjects, parseCanvasStorageDocument, type CanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";

let projects: any[] = [];
let recordedDeletedProjects: any[] = [];
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
    createProject: () => "unused",
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
    flushCanvasStorePersistence: async () => {},
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
            recordDeletedProjects: (items: any[]) => {
                recordedDeletedProjects.push(...items);
            },
        }),
    },
}));

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: () => {},
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
        put: async (path: string) => {
            writeRequests.push({ method: "PUT", path });
            return {};
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
const repair = await import("@/services/canvas-asset-repair");
const { exportCanvasProjects } = await import("@/lib/canvas/canvas-export");

function summaryItem(index: number) {
    const id = `canvas-${index}`;
    return {
        id,
        workspaceProjectId: index % 2 === 0 ? `ws-${index}` : `ws-${index - 1}`,
        folderId: index < 10 ? "folder-1" : undefined,
        title: `画布 ${index}`,
        canvasTitle: `分镜 ${index}`,
        revision: 2,
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

    it("never returns a summaryOnly preview when opening a canvas with an in-flight journal or higher confirmed revision", async () => {
        remotePages = [[summaryItem(0), summaryItem(1)]];
        const full0 = fullProject("canvas-0", { revision: 2 });
        const full1 = fullProject("canvas-1", { revision: 2 });
        const confirmed1 = fullProject("canvas-1", { revision: 4, title: "更高已确认版本" });
        remoteDetailsById.set("canvas-0", full0);
        remoteDetailsById.set("canvas-1", full1);

        await repository.hydrateLocalCanvasProjectsFromBackend();
        journalMemory.set("canvas-0", {
            ...emptyJournal("canvas-0"),
            confirmedRevision: 1,
            inFlight: { operationId: "op-crash", baseRevision: 1 },
        });
        journalMemory.set("canvas-1", {
            ...emptyJournal("canvas-1"),
            confirmedRevision: 4,
            confirmedSnapshot: confirmed1,
        });

        const opened0 = await repository.openLocalCanvasProjectFromBackend("canvas-0");
        expect(opened0?.summaryOnly).toBeUndefined();
        expect(opened0?.nodes).toHaveLength(2);
        expect(opened0?.connections).toHaveLength(1);

        const opened1 = await repository.openLocalCanvasProjectFromBackend("canvas-1");
        expect(opened1?.summaryOnly).toBeUndefined();
        expect(opened1?.title).toBe("更高已确认版本");
        expect(opened1?.connections).toHaveLength(1);
    });

    it("loads full documents into recycle bin before deleting summaryOnly canvases and restores full content cleanly", async () => {
        remotePages = [[summaryItem(0), summaryItem(1)]];
        const full0 = fullProject("canvas-0", { revision: 2 });
        remoteDetailsById.set("canvas-0", full0);
        remoteDetailsById.set("canvas-1", "500");

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(projects[0]?.summaryOnly).toBe(true);

        // Non-404 preload error aborts deletion before issuing DELETE.
        await expect(repository.deleteLocalCanvasProjects(["canvas-1"])).rejects.toThrow("后端暂时不可用");
        expect(writeRequests).toEqual([]);
        expect(projects.some((item) => item.id === "canvas-1")).toBe(true);

        await repository.deleteLocalCanvasProjects(["canvas-0"]);
        expect(writeRequests).toEqual([{ method: "DELETE", path: "/canvas-projects/canvas-0" }]);
        expect(recordedDeletedProjects).toHaveLength(1);
        expect(recordedDeletedProjects[0]?.summaryOnly).toBeUndefined();
        expect(recordedDeletedProjects[0]?.nodes).toHaveLength(2);
        expect(recordedDeletedProjects[0]?.connections).toHaveLength(1);

        // Restore from recycle bin and open even after server returns 404 for the deleted ID.
        remoteDetailsById.set("canvas-0", "404");
        projects = [recordedDeletedProjects[0], ...projects];
        const reopened = await repository.openLocalCanvasProjectFromBackend("canvas-0");
        expect(reopened?.summaryOnly).toBeUndefined();
        expect(reopened?.nodes).toHaveLength(2);
        expect(reopened?.connections).toHaveLength(1);
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

        await expect(exportCanvasProjects([projects[0]])).rejects.toThrow("画布尚未完整加载");
    });
});
