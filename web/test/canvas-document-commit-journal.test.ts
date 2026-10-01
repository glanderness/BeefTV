import { beforeEach, describe, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";
let failNextSetItem = false;

function isRetryableStatus(status?: number) {
    return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

class ApiError extends Error {
    status?: number;
    code?: number;
    reason?: string;
    retryable: boolean;
    constructor(message: string, options: { status?: number; code?: number; reason?: string; retryable?: boolean } = {}) {
        super(message);
        this.name = "ApiError";
        this.status = options.status;
        this.code = options.code;
        this.reason = options.reason;
        this.retryable = options.retryable ?? isRetryableStatus(options.status ?? options.code);
    }
}

const server = {
    revision: 1,
    document: null as Record<string, unknown> | null,
    commits: [] as Array<{ opId: string; expectedRevision: number; title: string }>,
    receipts: new Map<string, { revision: number; title: string }>(),
    failNext: null as { status?: number; retryable?: boolean; reason?: string; transport?: boolean } | null,
    hold: null as Promise<void> | null,
    postStarted: 0,
    abortAfterCommit: false,
};

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => {
            if (failNextSetItem) {
                failNextSetItem = false;
                throw new Error("IndexedDB unavailable");
            }
            stored.set(`${scope ?? activeScope}:${name}`, value);
        },
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
        get: async () => ({ project: server.document }),
        put: async () => ({ project: { id: "c1", revision: 1 } }),
        post: async (_path: string, body: { opId: string; params: { expectedRevision: number; document: { title: string } } }) => {
            server.postStarted += 1;
            if (server.hold) await server.hold;
            if (server.failNext?.transport) {
                server.failNext = null;
                throw new TypeError("Failed to fetch");
            }
            if (server.failNext) {
                const failure = server.failNext;
                server.failNext = null;
                const options: { status?: number; reason?: string; retryable?: boolean } = { status: failure.status, reason: failure.reason };
                if (failure.retryable !== undefined) options.retryable = failure.retryable;
                throw new ApiError("保存失败", options);
            }
            const existing = server.receipts.get(body.opId);
            if (existing) {
                return {
                    op: "canvas.document.commit",
                    opId: body.opId,
                    replayed: true,
                    caller: "manual",
                    revision: existing.revision,
                    result: { canvasId: "c1", revision: existing.revision, updatedAt: "2026-01-01T00:00:00.000Z" },
                };
            }
            server.revision += 1;
            server.commits.push({ opId: body.opId, expectedRevision: body.params.expectedRevision, title: body.params.document.title });
            server.receipts.set(body.opId, { revision: server.revision, title: body.params.document.title });
            server.document = { ...body.params.document, id: "c1", revision: server.revision };
            if (server.abortAfterCommit) {
                server.abortAfterCommit = false;
                throw new DOMException("The operation was aborted", "AbortError");
            }
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

const { persistCanvasDocument, refreshLocalCanvasProjectIfChanged, resetLocalCanvasBackendSaveState, syncLocalCanvasProjectToBackend, hasUnconfirmedCanvasEdits, selectPreferredCanvasProject } = await import("@/services/local-workspace-repository");
const { useCanvasStore, canvasDocumentBase, clearCanvasDocumentBase, recordCanvasDocumentBase } = await import("@/stores/canvas/use-canvas-store");
const { CanvasJournalError, loadCanvasOperationJournal, peekCanvasOperationJournal, recordConfirmedCanvasCommit, resetCanvasOperationJournalMemory, saveCanvasOperationJournal } = await import("@/services/canvas-operation-journal");
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
    resetLocalCanvasBackendSaveState();
    activeScope = "guest";
    failNextSetItem = false;
    server.revision = 1;
    server.document = canvas("基线", 1);
    server.commits = [];
    server.receipts.clear();
    server.failNext = null;
    server.hold = null;
    server.postStarted = 0;
    server.abortAfterCommit = false;
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
        server.failNext = { status: 503 };
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

    test("传输层 TypeError 保留同一 operationId 与草稿", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "传输失败" });
        server.failNext = { transport: true };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(TypeError);
        const firstId = (await loadCanvasOperationJournal("c1")).inFlight?.operationId;
        expect(firstId).toBeTruthy();
        expect(useCanvasStore.getState().projects[0].title).toBe("传输失败");
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toEqual([expect.objectContaining({ opId: firstId, title: "传输失败" })]);
    });

    test("服务端已提交后取消：保留 operationId，回放不另开 revision", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "取消后仍在" });
        server.abortAfterCommit = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(DOMException);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBeTruthy();
        expect(journal.inFlight?.payload.document.title).toBe("取消后仍在");
        expect(useCanvasStore.getState().projects[0].title).toBe("取消后仍在");
        const firstId = journal.inFlight!.operationId;
        expect(server.commits).toEqual([expect.objectContaining({ opId: firstId, title: "取消后仍在" })]);

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toHaveLength(1);
        expect((await loadCanvasOperationJournal("c1")).inFlight).toBeNull();
        expect(useCanvasStore.getState().projects[0].title).toBe("取消后仍在");
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

    test("账号切换时进行中的提交写回原作用域，不污染新账号", async () => {
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        useCanvasStore.setState({ projects: [canvas("用户A基线", 1)] });
        recordCanvasDocumentBase(canvas("用户A基线", 1), "user-a");
        await saveCanvasOperationJournal({
            userScope: "user-a",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("用户A基线", 1),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { title: "用户A草稿" });

        let release = () => {};
        server.hold = new Promise<void>((resolve) => { release = resolve; });
        const pending = persistCanvasDocument("c1", { title: "用户A草稿" });
        for (let attempt = 0; attempt < 50 && server.postStarted === 0; attempt += 1) await Promise.resolve();
        expect(server.postStarted).toBe(1);

        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        release();
        await pending;

        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.inFlight).toBeNull();
        expect(journalA.confirmedRevision).toBeGreaterThan(1);
        expect(journalA.confirmedSnapshot?.title).toBe("用户A草稿");
        expect(canvasDocumentBase("c1", "user-a")?.snapshot.title).toBe("用户A草稿");

        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("用户B画布");
        const journalB = await loadCanvasOperationJournal("c1", "user-b");
        expect(journalB.inFlight).toBeNull();
        expect(journalB.confirmedSnapshot).toBeNull();
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

    test("损坏的日记 fail-closed，不发明空操作", async () => {
        stored.set("guest:canvas-document-journal:c1", "{not-json");
        await expect(loadCanvasOperationJournal("c1")).rejects.toBeInstanceOf(CanvasJournalError);
        expect(peekCanvasOperationJournal("c1")).toBeUndefined();

        stored.set("guest:canvas-document-journal:c1", JSON.stringify({ userScope: "guest", canvasId: "c1" }));
        await expect(loadCanvasOperationJournal("c1")).rejects.toBeInstanceOf(CanvasJournalError);
        expect(peekCanvasOperationJournal("c1")).toBeUndefined();
    });

    test("IndexedDB 写入失败时不发布内存日记，下次保存使用新 operationId", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "未落盘" });
        failNextSetItem = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow("IndexedDB unavailable");
        expect(server.postStarted).toBe(0);
        expect(peekCanvasOperationJournal("c1")?.inFlight).toBeFalsy();
        expect(useCanvasStore.getState().projects[0].title).toBe("未落盘");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.commits).toHaveLength(1);
        expect(server.commits[0]?.title).toBe("未落盘");
        expect((await loadCanvasOperationJournal("c1")).inFlight).toBeNull();
    });

    test("刷新与非匹配 ack 不得清除未确认操作，confirmedRevision 不回退", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: {
                operationId: "op-keep",
                expectedRevision: 1,
                payload: { canvasId: "c1", expectedRevision: 1, document: canvas("在途", 1) },
            },
        });
        await recordConfirmedCanvasCommit(canvas("刷新", 4));
        let journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.title).toBe("刷新");

        await recordConfirmedCanvasCommit(canvas("更旧回执", 2), "guest", { ackOperationId: "other-op" });
        journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.title).toBe("刷新");

        await recordConfirmedCanvasCommit(canvas("确认", 6), "guest", { ackOperationId: "op-keep" });
        journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight).toBeNull();
        expect(journal.confirmedRevision).toBe(6);
    });

    test("丢失响应后外部写入再回放：后来的编辑保留，confirmedRevision 不回退", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "第一次" });
        server.abortAfterCommit = true;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(DOMException);
        const firstId = (await loadCanvasOperationJournal("c1")).inFlight?.operationId;
        expect(firstId).toBeTruthy();

        useCanvasStore.getState().updateProject("c1", { title: "后来的编辑" });
        server.revision = 5;
        server.document = canvas("助手改过", 5);
        expect(await refreshLocalCanvasProjectIfChanged("c1")).toBeUndefined();
        expect(useCanvasStore.getState().projects[0].title).toBe("后来的编辑");
        expect((await loadCanvasOperationJournal("c1")).inFlight?.operationId).toBe(firstId);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(5);

        await syncLocalCanvasProjectToBackend("c1");
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight).toBeNull();
        expect(journal.confirmedRevision).toBeGreaterThanOrEqual(5);
        expect(useCanvasStore.getState().projects[0].title).toBe("后来的编辑");
        expect(server.commits).toEqual([
            expect.objectContaining({ opId: firstId, title: "第一次" }),
            expect.objectContaining({ title: "后来的编辑" }),
        ]);
        expect(server.commits[1]?.opId).not.toBe(firstId);
    });
});
