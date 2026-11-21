import { beforeEach, describe, expect, it, mock } from "bun:test";

type Project = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    revision?: number;
    nodes: Array<{ id: string }>;
    connections: unknown[];
    chatSessions: unknown[];
    activeChatId: null;
    backgroundMode: "grid";
    showImageInfo: boolean;
    viewport: { x: number; y: number; k: number };
    directorScenes: unknown[];
};

let projects: any[] = [];
const bases = new Map<string, { revision: number; snapshot: any }>();
const journalMemory = new Map<string, any>();
let remoteProject: any;
let remoteProjects: any[] = [];
let failurePath = "";
let remotePages: any[][] | null = null;
const remoteDetailsById = new Map<string, any>();

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

const resetProjects = (next: any[]) => {
    projects = next;
    bases.clear();
};

const setRequestFailure = (path: string) => {
    failurePath = path;
};

const setRemoteProject = (next: any) => {
    remotePages = null;
    failurePath = "";
    remoteProject = next;
    remoteProjects = next ? [{ id: next.id }] : [];
};

const setRemotePages = (pages: any[][]) => {
    remotePages = pages;
};

const getStoreState = () => ({
    projects,
    openProject: (id: string) => projects.find((item) => item.id === id) ?? null,
    createProject: () => "unused",
    updateProject: () => {},
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
    useCanvasHistoryStore: { getState: () => ({ recordDeletedProjects: () => {} }) },
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
    useAssetStore: { getState: () => ({ assets: [] }) },
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
        project: { ...local, revision: remote.revision, updatedAt: remote.updatedAt, remoteContentHash: remote.remoteContentHash },
        conflict: false,
    }),
}));

mock.module("@/services/api/request", () => ({
    ApiError: MockApiError,
    compactApiParams: (params: Record<string, unknown>) => params,
    serializeApiParams: () => "",
    http: {
        get: async (path: string, options?: any) => {
            if (path === failurePath) throw new Error("read failed");
            if (path.startsWith("/canvas-projects/")) {
                const id = decodeURIComponent(path.slice("/canvas-projects/".length));
                if (remoteDetailsById.has(id)) {
                    const entry = remoteDetailsById.get(id);
                    if (entry === "404") throw new MockApiError("画布不存在", 404);
                    if (entry === "500") throw new MockApiError("服务暂不可用", 500);
                    return { project: entry };
                }
            }
            if (remotePages) {
                const page = options?.params?.page || 1;
                if (path === "/canvas-projects") return { projects: remotePages[page - 1] || [], hasMore: page < remotePages.length };
                return { project: remotePages.flat().find((item) => path.endsWith("/" + item.id)) };
            }
            return path === "/canvas-projects" ? { projects: remoteProjects } : { project: remoteProject };
        },
    },
}));

mock.module("@/services/api/operations", () => ({
    commitCanvasDocument: async () => ({ revision: 1, result: {} }),
    patchCanvasDocument: async () => ({ revision: 1, result: {} }),
}));

class MockCanvasJournalError extends Error {
    constructor(message: string) {
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

mock.module("@/services/canvas-operation-journal", () => ({
    CanvasJournalError: MockCanvasJournalError,
    peekCanvasOperationJournal: (id: string) => journalMemory.get(id),
    loadCanvasOperationJournal: async (id: string) => journalMemory.get(id) ?? emptyJournal(id),
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
}));

const repository = await import("@/services/local-workspace-repository");

const project = (overrides: Partial<Project> = {}): Project => ({
    id: "canvas-a",
    title: "画布 A",
    createdAt: "2026-09-22T08:00:00.000Z",
    updatedAt: "2026-09-22T08:00:00.000Z",
    revision: 0,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "grid",
    showImageInfo: true,
    viewport: { x: 0, y: 0, k: 1 },
    directorScenes: [],
    ...overrides,
});

beforeEach(() => {
    resetProjects([]);
    setRemoteProject(undefined);
    remoteDetailsById.clear();
    journalMemory.clear();
});

describe("local workspace stale backend protection", () => {
    it("hydrates every backend page when the server clamps the requested page size", async () => {
        const pageProjects = Array.from({ length: 64 }, (_, index) => project({ id: `paged-${index}`, revision: 1 }));
        setRemotePages([pageProjects.slice(0, 50), pageProjects.slice(50)]);
        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(projects).toHaveLength(64);
        expect(projects.some((item) => item.id === "paged-63")).toBe(true);
    });

    it("reports failed list/detail reads and retains cached projects until retry", async () => {
        const health = await import("@/services/canvas-hydration-health");
        const local = project({ nodes: [{ id: "keep" }] });
        for (const path of ["/canvas-projects", "/canvas-projects/canvas-a"]) {
            resetProjects([local]);
            setRemoteProject(project());
            setRequestFailure(path);
            expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(false);
            expect(projects[0]).toEqual(local);
            expect(health.getCanvasHydrationHealth().error).toContain("现有数据已保留");
            expect(health.getCanvasHydrationHealth().loading).toBe(false);
            setRequestFailure("");
            await repository.hydrateLocalCanvasProjectsFromBackend();
            expect(health.getCanvasHydrationHealth().error).toBe("");
        }
    });

    it("keeps dirty local drafts when opening a backend snapshot", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 2, nodes: [] });
        resetProjects([local]);
        bases.set(local.id, { revision: 0, snapshot: project({ nodes: [] }) });
        setRemoteProject(remote);

        const opened = await repository.openLocalCanvasProjectFromBackend(local.id);
        expect(opened?.nodes).toEqual([{ id: "kept-node" }]);
        expect(opened?.revision).toBe(2);
        expect(projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("keeps dirty local drafts during backend hydration", async () => {
        const local = project({ updatedAt: "2026-09-22T08:00:00.000Z", nodes: [{ id: "kept-node" }] });
        const remote = project({ updatedAt: "2026-09-22T09:00:00.000Z", revision: 2, nodes: [] });
        resetProjects([local]);
        bases.set(local.id, { revision: 0, snapshot: project({ nodes: [] }) });
        setRemoteProject(remote);

        await repository.hydrateLocalCanvasProjectsFromBackend();
        expect(projects[0].nodes).toEqual([{ id: "kept-node" }]);
    });

    it("clean caches adopt the backend document", async () => {
        const local = project({ updatedAt: "2026-09-22T09:00:00.000Z", nodes: [] });
        const remote = project({ updatedAt: "2026-09-22T08:00:00.000Z", revision: 1, nodes: [{ id: "remote-node" }] });
        resetProjects([local]);
        bases.set(local.id, { revision: 0, snapshot: local });
        setRemoteProject(remote);

        expect(await repository.openLocalCanvasProjectFromBackend(local.id)).toEqual(remote);
        expect(projects[0].nodes).toEqual([{ id: "remote-node" }]);
    });

    it("does not prune cached canvases when backend returns an empty list", async () => {
        const cached = project({ id: "canvas-cached", revision: 3 });
        resetProjects([cached]);
        bases.set(cached.id, { revision: 3, snapshot: cached });
        setRemoteProject(undefined);

        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(false);
        expect(projects.map((item) => item.id)).toEqual(["canvas-cached"]);
    });

    it("keeps a canvas omitted from a paginated list when per-ID verification returns 200", async () => {
        const page1 = project({ id: "canvas-p1", revision: 2 });
        const shifted = project({ id: "canvas-shifted", revision: 2, title: "旧标题" });
        const shiftedRemote = project({ id: "canvas-shifted", revision: 3, title: "翻页期间刚改名" });
        resetProjects([page1, shifted]);
        bases.set(page1.id, { revision: 2, snapshot: page1 });
        bases.set(shifted.id, { revision: 2, snapshot: shifted });
        setRemotePages([[page1]]);
        remoteDetailsById.set(shifted.id, shiftedRemote);

        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(projects.find((item) => item.id === shifted.id)?.title).toBe("翻页期间刚改名");
    });

    it("prunes clean server-backed canvases only on authoritative per-ID 404 while preserving unsaved, dirty, and in-flight canvases", async () => {
        const kept = project({ id: "canvas-kept", revision: 2 });
        const cleanDeleted = project({ id: "canvas-clean-deleted", revision: 4 });
        const dirtyDeleted = project({ id: "canvas-dirty-deleted", revision: 4, nodes: [{ id: "unsaved-local-node" }] });
        const inFlightDeleted = project({ id: "canvas-inflight-deleted", revision: 4 });
        const unsavedDraft = project({ id: "canvas-unsaved-draft", revision: 0 });
        resetProjects([kept, cleanDeleted, dirtyDeleted, inFlightDeleted, unsavedDraft]);
        bases.set(cleanDeleted.id, { revision: 4, snapshot: cleanDeleted });
        bases.set(dirtyDeleted.id, { revision: 4, snapshot: project({ id: "canvas-dirty-deleted", revision: 4, nodes: [] }) });
        bases.set(inFlightDeleted.id, { revision: 4, snapshot: inFlightDeleted });
        journalMemory.set(inFlightDeleted.id, { ...emptyJournal(inFlightDeleted.id), inFlight: { operationId: "op-1", expectedRevision: 4 } });
        setRemoteProject(kept);
        remoteDetailsById.set(cleanDeleted.id, "404");
        remoteDetailsById.set(dirtyDeleted.id, "404");
        remoteDetailsById.set(inFlightDeleted.id, "404");

        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(projects.map((item) => item.id).sort()).toEqual([
            "canvas-dirty-deleted",
            "canvas-inflight-deleted",
            "canvas-kept",
            "canvas-unsaved-draft",
        ]);
        expect(bases.has(cleanDeleted.id)).toBe(false);
    });

    it("handles list/detail 404 races without failing hydration of remaining canvases", async () => {
        const surviving = project({ id: "canvas-surviving", revision: 2 });
        const raced = project({ id: "canvas-raced-delete", revision: 2 });
        resetProjects([surviving, raced]);
        bases.set(raced.id, { revision: 2, snapshot: raced });
        // Bump raced revision in list summary so lazy hydration performs a detail read
        // and exercises a concurrent delete (list hit -> detail 404).
        setRemotePages([[surviving, { ...raced, revision: 3 }]]);
        remoteDetailsById.set(surviving.id, surviving);
        remoteDetailsById.set(raced.id, "404");

        expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(projects.map((item) => item.id)).toEqual(["canvas-surviving"]);
    });

    it("direct open evicts a clean ghost on 404, keeps dirty drafts on 404, and falls back to cache on 500", async () => {
        const cleanGhost = project({ id: "ghost-clean", revision: 3 });
        const dirtyGhost = project({ id: "ghost-dirty", revision: 3, nodes: [{ id: "local-edit" }] });
        const offlineCanvas = project({ id: "offline-canvas", revision: 3 });
        resetProjects([cleanGhost, dirtyGhost, offlineCanvas]);
        bases.set(cleanGhost.id, { revision: 3, snapshot: cleanGhost });
        bases.set(dirtyGhost.id, { revision: 3, snapshot: project({ id: "ghost-dirty", revision: 3, nodes: [] }) });
        bases.set(offlineCanvas.id, { revision: 3, snapshot: offlineCanvas });
        remoteDetailsById.set(cleanGhost.id, "404");
        remoteDetailsById.set(dirtyGhost.id, "404");
        remoteDetailsById.set(offlineCanvas.id, "500");

        expect(await repository.openLocalCanvasProjectFromBackend(cleanGhost.id)).toBeNull();
        expect(projects.some((item) => item.id === cleanGhost.id)).toBe(false);

        const keptDirty = await repository.openLocalCanvasProjectFromBackend(dirtyGhost.id);
        expect(keptDirty?.nodes).toEqual([{ id: "local-edit" }]);

        const keptOffline = await repository.openLocalCanvasProjectFromBackend(offlineCanvas.id);
        expect(keptOffline?.id).toBe(offlineCanvas.id);
    });

    it("protects the open editor canvas from background hydration 404 eviction under Wails hash and embedded basePath routing", async () => {
        const { isCanvasOpenInEditor } = await import("@/services/local-workspace-hydration");
        expect(isCanvasOpenInEditor("open-1", {
            location: { protocol: "wails:", host: "wails", pathname: "/index.html", hash: "#/canvas/open-1?tab=nodes" },
        })).toBe(true);
        expect(isCanvasOpenInEditor("open 2", {
            location: { protocol: "https:", host: "host.test", pathname: "/beeftv/app/canvas/open%202/" },
            basePath: "/beeftv/app",
        })).toBe(true);

        const originalWindow = globalThis.window;
        try {
            // 1. Native Wails hash routing (#/canvas/open-wails)
            const kept = project({ id: "canvas-kept", revision: 2 });
            const openWails = project({ id: "open-wails", revision: 3 });
            const closedDeleted = project({ id: "closed-deleted", revision: 3 });
            resetProjects([kept, openWails, closedDeleted]);
            bases.set(openWails.id, { revision: 3, snapshot: openWails });
            bases.set(closedDeleted.id, { revision: 3, snapshot: closedDeleted });
            setRemoteProject(kept);
            remoteDetailsById.set(openWails.id, "404");
            remoteDetailsById.set(closedDeleted.id, "404");
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: {
                    location: {
                        protocol: "wails:",
                        host: "wails",
                        hostname: "wails",
                        pathname: "/index.html",
                        hash: "#/canvas/open-wails",
                        href: "wails://wails/index.html#/canvas/open-wails",
                        origin: "wails://wails",
                    },
                },
            });

            expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
            expect(projects.map((item) => item.id).sort()).toEqual(["canvas-kept", "open-wails"]);

            // 2. Embedded basePath browser routing (/beeftv/app/canvas/open-base)
            const openBase = project({ id: "open-base", revision: 3 });
            const closedDeleted2 = project({ id: "closed-deleted-2", revision: 3 });
            resetProjects([kept, openBase, closedDeleted2]);
            bases.set(openBase.id, { revision: 3, snapshot: openBase });
            bases.set(closedDeleted2.id, { revision: 3, snapshot: closedDeleted2 });
            remoteDetailsById.set(openBase.id, "404");
            remoteDetailsById.set(closedDeleted2.id, "404");
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: {
                    location: {
                        protocol: "https:",
                        host: "host.test",
                        hostname: "host.test",
                        pathname: "/beeftv/app/canvas/open-base",
                        hash: "",
                        href: "https://host.test/beeftv/app/canvas/open-base",
                        origin: "https://host.test",
                    },
                    __BEEFTV_HARNESS__: {
                        embedded: true,
                        basePath: "/beeftv/app",
                        apiBase: "/beeftv/app/api",
                    },
                },
            });

            expect(await repository.hydrateLocalCanvasProjectsFromBackend()).toBe(true);
            expect(projects.map((item) => item.id).sort()).toEqual(["canvas-kept", "open-base"]);
        } finally {
            if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
            else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
        }
    });
});
