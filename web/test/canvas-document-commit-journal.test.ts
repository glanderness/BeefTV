import { beforeEach, describe, expect, mock, test } from "bun:test";

type Stored = Map<string, string>;
const stored: Stored = new Map();
let activeScope = "guest";
let failNextSetItem = false;
let failSetItemOn = 0;
let setItemCount = 0;

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
    commits: [] as Array<{ opId: string; expectedRevision: number; title: string; nodeIds?: string[] }>,
    receipts: new Map<string, { revision: number; title: string }>(),
    failNext: null as { status?: number; retryable?: boolean; reason?: string; transport?: boolean } | null,
    hold: null as Promise<void> | null,
    postStarted: 0,
    abortAfterCommit: false,
    deletes: [] as string[],
    deleteStarted: 0,
    deleteHold: null as Promise<void> | null,
};

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: (scope?: string) => ({
        getItem: async (name: string) => stored.get(`${scope ?? activeScope}:${name}`) ?? null,
        setItem: async (name: string, value: string) => {
            setItemCount += 1;
            if (failNextSetItem || (failSetItemOn > 0 && setItemCount === failSetItemOn)) {
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
        post: async (_path: string, body: { opId: string; params: { expectedRevision: number; document: { title: string; nodes?: Array<{ id: string }> } } }) => {
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
            const document = body.params.document as { title: string; nodes?: Array<{ id: string }> };
            server.commits.push({
                opId: body.opId,
                expectedRevision: body.params.expectedRevision,
                title: document.title,
                nodeIds: (document.nodes ?? []).map((node) => node.id),
            });
            server.receipts.set(body.opId, { revision: server.revision, title: document.title });
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
        delete: async (path: string) => {
            server.deleteStarted += 1;
            if (server.deleteHold) await server.deleteHold;
            server.deletes.push(path);
            return undefined;
        },
    },
}));

mock.module("@/services/local-workspace-sync", () => ({ notifyCanvasRefresh: () => {} }));
mock.module("@/services/canvas-sync-drafts", () => ({ preserveCanvasSyncDraft: async () => 1 }));
mock.module("@/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ assets: [] }) } }));
mock.module("@/services/workspace-mode", () => ({ isLocalWorkspaceMode: () => true }));
mock.module("@/services/api/resources", () => ({ resourceIdFromStorageKey: () => "" }));

const { persistCanvasDocument, refreshLocalCanvasProjectIfChanged, resetLocalCanvasBackendSaveState, syncLocalCanvasProjectToBackend, hasUnconfirmedCanvasEdits, selectPreferredCanvasProject, deleteLocalCanvasProjects, adoptServerConfirmedGenerationPatch, openLocalCanvasProjectFromBackend, CanvasStaleScopeError, CanvasBackendSubmitPausedError } = await import("@/services/local-workspace-repository");
const { useCanvasStore, canvasDocumentBase, canvasExternalRevisionConflict, clearCanvasDocumentBase, clearCanvasExternalRevisionConflict, recordCanvasDocumentBase } = await import("@/stores/canvas/use-canvas-store");
const { CanvasJournalError, loadCanvasOperationJournal, peekCanvasOperationJournal, recordConfirmedCanvasCommit, resetCanvasOperationJournalMemory, saveCanvasOperationJournal, setCanvasJournalStorageDelay, updateCanvasOperationJournal } = await import("@/services/canvas-operation-journal");
const { canvasBackendSubmitPaused } = await import("@/services/canvas-revision-conflict");
const { projectSyncProgress, useSyncProgressStore } = await import("@/stores/use-sync-progress-store");

function canvas(title: string, revision = 1, patch: Record<string, unknown> = {}) {
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
        ...patch,
    } as never;
}

function node(id: string, title: string, patch: Record<string, unknown> = {}) {
    return { id, type: "image", title, position: { x: 0, y: 0 }, width: 320, height: 220, metadata: {}, ...patch };
}

function connection(id: string, fromNodeId: string, toNodeId: string) {
    return { id, fromNodeId, toNodeId };
}

async function seedConfirmed(doc: ReturnType<typeof canvas> = canvas("基线", 1), scope = activeScope) {
    await saveCanvasOperationJournal({
        userScope: scope,
        canvasId: "c1",
        confirmedRevision: (doc as { revision: number }).revision,
        confirmedSnapshot: doc,
        inFlight: null,
    });
    recordCanvasDocumentBase(doc as never, scope);
    useCanvasStore.setState({ projects: [doc as never] });
}

async function holdJournalWrite() {
    let release = () => {};
    let waiting = false;
    setCanvasJournalStorageDelay({
        beforeSet: async () => {
            waiting = true;
            await new Promise<void>((resolve) => { release = resolve; });
        },
    });
    return {
        wait: () => waitUntil(() => waiting),
        resume: () => release(),
    };
}

async function waitUntil(predicate: () => boolean, attempts = 80) {
    for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1) await Promise.resolve();
    expect(predicate()).toBe(true);
}

beforeEach(() => {
    stored.clear();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    activeScope = "guest";
    failNextSetItem = false;
    failSetItemOn = 0;
    setItemCount = 0;
    server.revision = 1;
    server.document = canvas("基线", 1);
    server.commits = [];
    server.receipts.clear();
    server.failNext = null;
    server.hold = null;
    server.postStarted = 0;
    server.abortAfterCommit = false;
    server.deletes = [];
    server.deleteStarted = 0;
    server.deleteHold = null;
    useSyncProgressStore.getState().clearAll();
    clearCanvasExternalRevisionConflict("guest", "c1");
    clearCanvasExternalRevisionConflict("user-a", "c1");
    clearCanvasExternalRevisionConflict("user-b", "c1");
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
        await waitUntil(() => server.postStarted === 1);

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

    test("丢失响应后外部写入再回放：后来的编辑保留，不得把远端读成功当成新基线", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });
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
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(canvasExternalRevisionConflict("guest", "c1")?.remoteRevision).toBe(5);

        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(CanvasBackendSubmitPausedError);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.inFlight).toBeNull();
        expect(journal.confirmedRevision).toBe(2);
        expect(journal.confirmedSnapshot?.title).toBe("第一次");
        expect(useCanvasStore.getState().projects[0].title).toBe("后来的编辑");
        expect(server.commits).toEqual([
            expect.objectContaining({ opId: firstId, title: "第一次" }),
        ]);
        expect((server.document as { title: string }).title).toBe("助手改过");
    });

    test("外部新增节点时本地改了另一节点：keep-local 后自动保存不得丢掉外部节点", async () => {
        const localNode = node("n1", "镜头1");
        const remoteAdded = node("n2", "助手加的");
        useCanvasStore.setState({ projects: [canvas("基线", 1, { nodes: [localNode] })] });
        recordCanvasDocumentBase(canvas("基线", 1, { nodes: [localNode] }));
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1, { nodes: [localNode] }),
            inFlight: null,
        });
        useCanvasStore.getState().updateProject("c1", { nodes: [{ ...localNode, title: "本地改名" }] as never });

        server.revision = 5;
        server.document = canvas("助手加了节点", 5, { nodes: [localNode, remoteAdded] });
        expect(await refreshLocalCanvasProjectIfChanged("c1")).toBeUndefined();

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id)).toEqual(["n1"]);
        expect(live.nodes[0].title).toBe("本地改名");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(projectSyncProgress("c1")?.phase).toBe("conflict");

        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toBeInstanceOf(CanvasBackendSubmitPausedError);
        expect(server.commits).toEqual([]);
        expect((server.document as { nodes: Array<{ id: string }> }).nodes.map((item) => item.id)).toEqual(["n1", "n2"]);
        expect(useCanvasStore.getState().projects[0].nodes[0].title).toBe("本地改名");
    });

    test("同画布日记更新串行，后写基于队列内最新快照", async () => {
        let releaseGet = () => {};
        const getHold = new Promise<void>((resolve) => { releaseGet = resolve; });
        let gets = 0;
        resetCanvasOperationJournalMemory();
        setCanvasJournalStorageDelay({
            beforeGet: async () => {
                gets += 1;
                if (gets === 1) await getHold;
            },
        });

        const first = updateCanvasOperationJournal("c1", "guest", (current) => ({
            ...current,
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
        }));
        await waitUntil(() => gets === 1);
        const second = updateCanvasOperationJournal("c1", "guest", (current) => ({
            ...current,
            inFlight: {
                operationId: "op-keep",
                expectedRevision: current.confirmedRevision,
                payload: { canvasId: "c1", expectedRevision: current.confirmedRevision, document: canvas("在途", current.confirmedRevision) },
            },
        }));
        releaseGet();
        await first;
        await second;
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(1);
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(journal.confirmedSnapshot?.title).toBe("基线");
    });

    test("peek 给出的在途 payload 被篡改不会改写已序列化请求", async () => {
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
        const peeked = peekCanvasOperationJournal("c1");
        expect(peeked?.inFlight?.payload.document.title).toBe("在途");
        (peeked!.inFlight!.payload.document as { title: string }).title = "篡改";
        expect(peekCanvasOperationJournal("c1")?.inFlight?.payload.document.title).toBe("在途");
    });

    test("日记确认写入失败时不把 HTTP 回执当成已保存", async () => {
        useCanvasStore.getState().updateProject("c1", { title: "未确认回执" });
        failSetItemOn = 2;
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow("IndexedDB unavailable");
        expect(server.postStarted).toBe(1);
        expect(server.commits).toHaveLength(1);
        expect(peekCanvasOperationJournal("c1")?.inFlight?.payload.document.title).toBe("未确认回执");
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
    });

    test("账号切换后未发出的提交返回过期作用域错误，不是成功", async () => {
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
        const first = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);

        useCanvasStore.getState().updateProject("c1", { title: "用户A再改" });
        const second = persistCanvasDocument("c1", { title: "用户A再改" });
        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        release();
        await first;
        await expect(second).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.commits).toHaveLength(1);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
    });

    test("删除与未完成提交串行，账号切换后不以新凭证删除同一 id", async () => {
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
        const save = persistCanvasDocument("c1", { title: "用户A草稿" });
        await waitUntil(() => server.postStarted === 1);

        const pendingDelete = deleteLocalCanvasProjects(["c1"]);
        await Promise.resolve();
        expect(server.deleteStarted).toBe(0);

        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        release();
        await save;
        await expect(pendingDelete).rejects.toBeInstanceOf(CanvasStaleScopeError);
        expect(server.deleteStarted).toBe(0);
        expect(server.deletes).toEqual([]);
        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("用户B画布");
    });

    test("生成回写入草稿时按 id 合并，不丢掉本地额外节点", async () => {
        const localOnly = node("n-local", "本地节点");
        const generated = node("n-gen", "生成结果");
        useCanvasStore.setState({ projects: [canvas("草稿", 1, { nodes: [localOnly] })] });
        recordCanvasDocumentBase(canvas("基线", 1));
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [generated] }));
        expect(adopted.nodes.map((item) => item.id).sort()).toEqual(["n-gen", "n-local"]);
        expect(useCanvasStore.getState().projects[0].title).toBe("草稿");
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.nodes.map((item) => item.id)).toEqual(["n-gen"]);
        expect(journal.inFlight).toBeNull();
    });

    test("本地删除的节点和连线不会被生成回写复活", async () => {
        const n1 = node("n1", "镜头1");
        const n2 = node("n2", "镜头2");
        const generated = node("n-gen", "生成结果", { metadata: { storageKey: "res-gen" } });
        const c1 = connection("c1", "n1", "n2");
        const base = canvas("基线", 1, { nodes: [n1, n2], connections: [c1] });
        await seedConfirmed(base);
        useCanvasStore.getState().updateProject("c1", { nodes: [n1] as never, connections: [] as never });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [n1, n2, generated], connections: [c1] }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id)).toEqual(["n1", "n-gen"]);
        expect(live.connections.map((item) => item.id)).toEqual([]);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("本地改过的文案保留，未改动字段采纳生成媒体", async () => {
        const baseNode = node("n1", "镜头1", { metadata: { prompt: "基线提示" } });
        await seedConfirmed(canvas("基线", 1, { nodes: [baseNode] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, title: "本地改名", metadata: { prompt: "本地提示" } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [{ ...baseNode, metadata: { prompt: "基线提示", storageKey: "res-gen", content: "https://media/gen" } }],
        }));

        const liveNode = useCanvasStore.getState().projects[0].nodes[0];
        expect(liveNode.title).toBe("本地改名");
        expect(liveNode.metadata?.prompt).toBe("本地提示");
        expect(liveNode.metadata?.storageKey).toBe("res-gen");
        expect(liveNode.metadata?.content).toBe("https://media/gen");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("本地清空的数组不会被基线填回，服务端新增实体仍采纳", async () => {
        const n1 = node("n1", "镜头1");
        const generated = node("n-gen", "生成结果");
        const c1 = connection("c1", "n1", "n1");
        const cGen = connection("c-gen", "n-gen", "n1");
        await seedConfirmed(canvas("基线", 1, { nodes: [n1], connections: [c1] }));
        useCanvasStore.getState().updateProject("c1", { nodes: [] as never, connections: [] as never });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [n1, generated],
            connections: [c1, cGen],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes.map((item) => item.id)).toEqual(["n-gen"]);
        expect(live.connections.map((item) => item.id)).toEqual(["c-gen"]);
    });

    test("服务端删除且本地未改的节点会随生成回写去掉", async () => {
        const n1 = node("n1", "镜头1");
        const n2 = node("n2", "镜头2");
        await seedConfirmed(canvas("基线", 1, { nodes: [n1, n2] }));

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [n1] }));

        expect(useCanvasStore.getState().projects[0].nodes.map((item) => item.id)).toEqual(["n1"]);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("同一节点本地位移与服务端生成结果一并保留", async () => {
        const baseNode = node("n1", "镜头1");
        await seedConfirmed(canvas("基线", 1, { nodes: [baseNode] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, position: { x: 40, y: 80 } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [{ ...baseNode, metadata: { storageKey: "res-gen", content: "https://media/gen" } }],
        }));

        const liveNode = useCanvasStore.getState().projects[0].nodes[0];
        expect(liveNode.position).toEqual({ x: 40, y: 80 });
        expect(liveNode.metadata?.storageKey).toBe("res-gen");
        expect(liveNode.title).toBe("镜头1");
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("同一字段本地元数据与服务端元数据冲突时暂停，不猜胜者", async () => {
        const baseNode = node("n1", "镜头1", { metadata: { prompt: "基线提示" } });
        await seedConfirmed(canvas("基线", 1, { nodes: [baseNode] }));
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, metadata: { prompt: "本地提示" } }] as never,
        });

        await adoptServerConfirmedGenerationPatch(canvas("生成", 4, {
            nodes: [{ ...baseNode, metadata: { prompt: "服务端提示" } }],
        }));

        const live = useCanvasStore.getState().projects[0];
        expect(live.nodes[0].metadata?.prompt).toBe("本地提示");
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
        expect(canvasExternalRevisionConflict("guest", "c1")?.remoteRevision).toBe(4);
        expect(canvasExternalRevisionConflict("guest", "c1")?.candidate.nodes[0].metadata?.prompt).toBe("服务端提示");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("无已确认快照时不把生成结果静默并进草稿", async () => {
        resetCanvasOperationJournalMemory();
        clearCanvasDocumentBase("c1");
        const localOnly = node("n-local", "本地节点");
        useCanvasStore.setState({ projects: [canvas("草稿", 1, { nodes: [localOnly] })] });

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }));

        expect(adopted.nodes.map((item) => item.id)).toEqual(["n-local"]);
        expect(useCanvasStore.getState().projects[0].nodes.map((item) => item.id)).toEqual(["n-local"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(0);
        expect(canvasDocumentBase("c1")).toBeUndefined();
        expect(canvasBackendSubmitPaused("c1")).toBe(true);
    });

    test("日记写入等待期间的手工编辑在生成回写后仍在", async () => {
        await seedConfirmed(canvas("基线", 1));
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("基线", 4, { nodes: [node("n-gen", "生成结果")] }));
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        await pending;

        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("手工改了");
        expect(live.nodes.map((item) => item.id)).toEqual(["n-gen"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
        expect(canvasDocumentBase("c1")?.revision).toBe(4);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("生成回写日记失败时不发布基线，等待期间的编辑仍在", async () => {
        await seedConfirmed(canvas("基线", 1));
        const hold = await holdJournalWrite();
        failNextSetItem = true;
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }));
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        await pending;

        expect(useCanvasStore.getState().projects[0].title).toBe("手工改了");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(canvasDocumentBase("c1")?.revision).toBe(1);
    });

    test("等待生成回写时画布被删掉则不再写回 store", async () => {
        await seedConfirmed(canvas("基线", 1));
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }));
        await hold.wait();
        useCanvasStore.setState({ projects: [] });
        hold.resume();
        await pending;

        expect(useCanvasStore.getState().projects).toEqual([]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(4);
    });

    test("等待生成回写时切换账号，不改新账号的 store", async () => {
        activeScope = "user-a";
        resetCanvasOperationJournalMemory();
        await seedConfirmed(canvas("用户A基线", 1), "user-a");
        const hold = await holdJournalWrite();
        const pending = adoptServerConfirmedGenerationPatch(canvas("生成", 4, { nodes: [node("n-gen", "生成结果")] }), "user-a");
        await hold.wait();
        activeScope = "user-b";
        useCanvasStore.setState({ projects: [canvas("用户B画布", 1)] });
        recordCanvasDocumentBase(canvas("用户B画布", 1), "user-b");
        hold.resume();
        await pending;

        expect(useCanvasStore.getState().projects[0].title).toBe("用户B画布");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        const journalA = await loadCanvasOperationJournal("c1", "user-a");
        expect(journalA.confirmedRevision).toBe(4);
        expect(journalA.confirmedSnapshot?.revision).toBe(4);
        expect(canvasDocumentBase("c1", "user-b")?.snapshot.title).toBe("用户B画布");
        expect((await loadCanvasOperationJournal("c1", "user-b")).confirmedSnapshot).toBeNull();
    });

    test("过期生成响应不改确认快照，在途回执仍可回放，revision 与 snapshot 对齐", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 4,
            confirmedSnapshot: canvas("已确认", 4),
            inFlight: {
                operationId: "op-keep",
                expectedRevision: 1,
                payload: { canvasId: "c1", expectedRevision: 1, document: canvas("在途", 1) },
            },
        });
        useCanvasStore.setState({ projects: [canvas("本地草稿", 4)] });
        recordCanvasDocumentBase(canvas("已确认", 4));

        const adopted = await adoptServerConfirmedGenerationPatch(canvas("过期生成", 2, { nodes: [node("n-stale", "旧结果")] }));

        expect(adopted.title).toBe("本地草稿");
        expect(useCanvasStore.getState().projects[0].title).toBe("本地草稿");
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(4);
        expect(journal.confirmedSnapshot?.title).toBe("已确认");
        expect(journal.confirmedSnapshot?.revision).toBe(4);
        expect(journal.inFlight?.operationId).toBe("op-keep");
        expect(canvasDocumentBase("c1")?.revision).toBe(4);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("已确认");
    });

    test("日记写入会把 snapshot.revision 对齐到 confirmedRevision", async () => {
        await saveCanvasOperationJournal({
            userScope: "guest",
            canvasId: "c1",
            confirmedRevision: 3,
            confirmedSnapshot: canvas("基线", 1),
            inFlight: null,
        });
        const journal = await loadCanvasOperationJournal("c1");
        expect(journal.confirmedRevision).toBe(3);
        expect(journal.confirmedSnapshot?.revision).toBe(3);
    });

    test("刷新在日记写入等待期间保留手工编辑并采纳未冲突的远端节点", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("基线", 5, { nodes: [node("n-ext", "外部节点")] });
        const hold = await holdJournalWrite();
        const pending = refreshLocalCanvasProjectIfChanged("c1");
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        const applied = await pending;

        expect(applied?.title).toBe("手工改了");
        expect(useCanvasStore.getState().projects[0].title).toBe("手工改了");
        expect(useCanvasStore.getState().projects[0].nodes.map((item) => item.id)).toEqual(["n-ext"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(5);
        expect(canvasDocumentBase("c1")?.revision).toBe(5);
        expect(canvasBackendSubmitPaused("c1")).toBe(false);
    });

    test("刷新日记写入失败时不发布基线", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("助手改过", 5);
        failNextSetItem = true;
        expect(await refreshLocalCanvasProjectIfChanged("c1")).toBeUndefined();
        expect(useCanvasStore.getState().projects[0].title).toBe("基线");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
        expect(canvasDocumentBase("c1")?.revision).toBe(1);
    });

    test("打开后端文档时日记写入等待期间的手工编辑不会丢", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("基线", 5, { nodes: [node("n-ext", "外部节点")] });
        const hold = await holdJournalWrite();
        const pending = openLocalCanvasProjectFromBackend("c1");
        await hold.wait();
        useCanvasStore.getState().updateProject("c1", { title: "手工改了" });
        hold.resume();
        await pending;

        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("手工改了");
        expect(live.nodes.map((item) => item.id)).toEqual(["n-ext"]);
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(5);
        expect(canvasDocumentBase("c1")?.revision).toBe(5);
    });

    test("打开后端文档时日记写入失败不发布基线", async () => {
        await seedConfirmed(canvas("基线", 1));
        server.document = canvas("助手改过", 5);
        failNextSetItem = true;
        await openLocalCanvasProjectFromBackend("c1");
        expect(useCanvasStore.getState().projects[0].title).toBe("基线");
        expect((await loadCanvasOperationJournal("c1")).confirmedRevision).toBe(1);
        expect(canvasDocumentBase("c1")?.snapshot.title).toBe("基线");
    });
});
