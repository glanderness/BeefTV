import { beforeEach, describe, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";

class ApiError extends Error {
    status?: number;
    reason?: string;
    retryable: boolean;
    constructor(message: string, options: { status?: number; reason?: string; retryable?: boolean } = {}) {
        super(message);
        this.status = options.status;
        this.reason = options.reason;
        this.retryable = options.retryable ?? false;
    }
}

const server = {
    revision: 1,
    commits: [] as Array<{ opId: string; expectedRevision: number; title: string }>,
    failNext: null as { status: number; retryable?: boolean; reason?: string } | null,
};

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${scope ?? activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${scope ?? activeScope}:${name}`); },
    }),
    localForageStorage: {
        getItem: async (name: string) => stored.get(`${activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => { stored.set(`${activeScope}:${name}`, value); },
        removeItem: async (name: string) => { stored.delete(`${activeScope}:${name}`); },
    },
}));

mock.module("@/lib/user-scope", () => ({
    getActiveUserScope: () => activeScope,
    getActiveUserScopeEpoch: () => 1,
    scopedStorageKey: (name: string, scope = activeScope) => `${name}:user:${scope}`,
    scopedLocalStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

mock.module("@/services/api/request", () => ({
    ApiError,
    http: {
        get: async () => ({ project: null }),
        put: async () => ({ project: { id: "c1", revision: 1 } }),
        post: async (_path: string, body: { opId: string; params: { expectedRevision: number; document: { title: string } } }) => {
            if (server.failNext) {
                const failure = server.failNext;
                server.failNext = null;
                throw new ApiError("保存失败", { status: failure.status, reason: failure.reason, retryable: failure.retryable });
            }
            server.revision += 1;
            server.commits.push({ opId: body.opId, expectedRevision: body.params.expectedRevision, title: body.params.document.title });
            return {
                op: "canvas.document.commit",
                opId: body.opId,
                replayed: false,
                caller: "manual",
                revision: server.revision,
                result: { canvasId: "c1", revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" },
            };
        },
        delete: async () => undefined,
    },
}));

mock.module("@/services/local-workspace-sync", () => ({ notifyCanvasRefresh: () => {} }));
mock.module("@/services/canvas-sync-drafts", () => ({ preserveCanvasSyncDraft: async () => 1 }));
mock.module("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ assets: [] }) } }));
mock.module("@/services/workspace-mode", () => ({ isLocalWorkspaceMode: () => true }));
mock.module("@/services/api/resources", () => ({ resourceIdFromStorageKey: () => "" }));

const { persistCanvasDocument, syncLocalCanvasProjectToBackend, hasUnconfirmedCanvasEdits, selectPreferredCanvasProject } = await import("@/services/local-workspace-repository");
const { useCanvasStore, canvasDocumentBase, clearCanvasDocumentBase, recordCanvasDocumentBase } = await import("@/stores/canvas/use-canvas-store");
const { loadCanvasOperationJournal, resetCanvasOperationJournalMemory, saveCanvasOperationJournal } = await import("@/services/canvas-operation-journal");
const { useSyncProgressStore } = await import("@/stores/use-sync-progress-store");

function canvas(title: string, revision = 1) {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    } as never;
}

beforeEach(() => {
    stored.clear();
    resetCanvasOperationJournalMemory();
    activeScope = "guest";
    server.revision = 1;
    server.commits = [];
    server.failNext = null;
    useSyncProgressStore.getState().clearAll();
    useCanvasStore.setState({ projects: [canvas("基线", 1)] });
    recordCanvasDocumentBase(canvas("基线", 1));
});

describe("画布文档提交日记", () => {
    test("干净缓存采用后端，脏草稿相对已记录基线保留", () => {
        const localClean = canvas("基线", 1);
        const backend = canvas("助手改过", 2);
        recordCanvasDocumentBase(localClean);
        expect(selectPreferredCanvasProject(localClean, backend).title).toBe("助手改过");

        const localDirty = canvas("本地草稿", 1);
        recordCanvasDocumentBase(canvas("基线", 1));
        expect(selectPreferredCanvasProject(localDirty, backend).title).toBe("本地草稿");
    });

    test("网络未知时重试复用同一 operationId 与 payload，后续编辑另开一笔", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "第一次" });
        server.failNext = { status: 503, retryable: true };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBeTruthy();
        expect(journal.inFlight?.payload.document.title).toBe("第一次");
        const firstId = journal.inFlight!.operationId;

        useCanvasStore.getState().updateProject("c1", { title: "第二次" });
        await syncLocalCanvasProjectToBackend("c1");

        expect(server.commits[0]?.opId).toBe(firstId);
        expect(server.commits[0]?.title).toBe("第一次");
        expect(server.commits[1]?.opId).not.toBe(firstId);
        expect(server.commits[1]?.title).toBe("第二次");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("没有 HTTP 响应时同样复用同一 operationId", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "断线提交" });
        server.failNext = { retryable: false };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const firstId = (await loadCanvasOperationJournal("c1")).inFlight?.operationId;
        expect(firstId).toBeTruthy();
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ opId: firstId, title: "断线提交" })]);
    });

    test("被拒绝的远端写入不得记成已保存", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "冲突草稿" });
        server.failNext = { status: 409, reason: "stale_revision" };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        expect(useCanvasStore.getState().projects[0].title).toBe("冲突草稿");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect((await loadCanvasOperationJournal("c1")).inFlight).toBeNull();
    });

    test("显式 persist 遇到陈旧 revision 时保留本地草稿", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "冲突草稿" });
        server.failNext = { status: 409, reason: "stale_revision" };
        await expect(persistCanvasDocument("c1", { nodes: [] })).rejects.toThrow();
        expect(useCanvasStore.getState().projects[0].title).toBe("冲突草稿");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
    });

    test("用户作用域隔离：不会重放另一用户的 payload", async () => {
        await saveCanvasOperationJournal({
            userScope: "user-b",
            canvasId: "c1",
            confirmedRevision: 9,
            confirmedSnapshot: canvas("别人的", 9),
            inFlight: {
                operationId: "foreign-op",
                expectedRevision: 9,
                payload: { canvasId: "c1", expectedRevision: 9, document: canvas("别人的", 9) },
            },
        });
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        const loaded = await loadCanvasOperationJournal("c1", "user-a");
        expect(loaded.inFlight).toBeNull();
        expect(loaded.confirmedSnapshot).toBeNull();
    });

    test("重启后脏草稿仍相对记录基线未确认", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "未确认草稿" });
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        resetCanvasOperationJournalMemory();
        clearCanvasDocumentBase("c1");
        await loadCanvasOperationJournal("c1");
        useCanvasStore.setState({ projects: [canvas("未确认草稿", 1)] });
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
        expect(selectPreferredCanvasProject(canvas("未确认草稿", 1), canvas("助手改过", 2)).title).toBe("未确认草稿");
    });
});
