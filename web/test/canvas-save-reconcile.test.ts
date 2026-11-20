import { beforeEach, describe, expect, mock, test } from "bun:test";
import { applyMockCanvasPatch, type MockCanvasPatchParams } from "./helpers/mock-canvas-patch";

const stored = new Map<string, string>();
const drafts: Array<{ title?: string; chatSessions?: Array<{ id: string }> }> = [];
const notifications: Array<{ id: string; revision: number }> = [];

class ApiError extends Error {
    status?: number;
    code?: number;
    reason?: string;
    retryable: boolean;
    constructor(message: string, options: { status?: number; reason?: string; retryable?: boolean } = {}) {
        super(message);
        this.name = "ApiError";
        this.status = options.status;
        this.reason = options.reason;
        this.retryable = options.retryable ?? false;
    }
}

type Doc = Record<string, unknown> & { revision: number; nodes: Array<{ id: string }>; title: string };

/**
 * A server with real compare-and-set: a commit must name the current revision
 * unless its opId already has a receipt (idempotent replay).
 */
const server = {
    revision: 0,
    document: null as Doc | null,
    attempts: [] as Array<{ opId: string; expectedRevision: number; accepted: boolean }>,
    receipts: new Map<string, number>(),
    gets: 0,
    getHold: null as Promise<void> | null,
    commitHold: null as Promise<void> | null,
    commitStarted: 0,
    beforeCommit: [] as Array<() => void>,
    failNext: null as { status: number } | null,
    failGets: 0,
};
let draftFailure = false;

mock.module("@/lib/localforage-storage", () => {
    const storage = {
        getItem: async (name: string) => stored.get(name) ?? null,
        setItem: async (name: string, value: string) => { stored.set(name, value); },
        removeItem: async (name: string) => { stored.delete(name); },
    };
    return { localForageStorageForScope: () => storage, localForageStorage: storage };
});

const actualRequest = await import("@/services/api/request");
mock.module("@/services/api/request", () => ({
    ...actualRequest,
    ApiError,
    apiBaseURL: "/api",
    compactApiParams: (params: Record<string, unknown>) => params,
    http: {
        get: async () => {
            server.gets += 1;
            if (server.failGets > 0) {
                server.failGets -= 1;
                throw new Error("读取失败");
            }
            // The response reflects the server at the moment the request arrived.
            const snapshot = structuredClone(server.document);
            if (server.getHold) await server.getHold;
            return { project: snapshot };
        },
        put: async (_path: string, body: { project: Record<string, unknown> }) => {
            server.revision += 1;
            server.document = { ...structuredClone(body.project), revision: server.revision } as Doc;
            return { project: { id: String(body.project.id), revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" } };
        },
        post: async (path: string, body: { opId: string; params: MockCanvasPatchParams & { canvasId: string; expectedRevision?: number; document?: Record<string, unknown> } }) => {
            server.commitStarted += 1;
            server.beforeCommit.shift()?.();
            if (server.commitHold) await server.commitHold;
            if (server.failNext) {
                const failure = server.failNext;
                server.failNext = null;
                throw new ApiError("保存失败", { status: failure.status, retryable: failure.status >= 500 });
            }
            const receipt = server.receipts.get(body.opId);
            const isPatch = path === "/ops/canvas.document.patch";
            const reply = (revision: number, replayed: boolean, extra: Record<string, unknown> = {}) => ({
                op: isPatch ? "canvas.document.patch" : "canvas.document.commit",
                opId: body.opId,
                replayed,
                caller: "manual",
                revision,
                result: { canvasId: "c1", revision, updatedAt: "2026-01-01T00:00:00.000Z", ...extra },
            });
            if (receipt !== undefined) return reply(receipt, true);
            if (isPatch) {
                const baseRevision = body.params.baseRevision ?? 0;
                server.revision += 1;
                const { document, serverAdvanced, mediaPreserved } = applyMockCanvasPatch(server.document, body.params, server.revision);
                server.document = document as Doc;
                server.receipts.set(body.opId, server.revision);
                server.attempts.push({ opId: body.opId, expectedRevision: baseRevision, accepted: true });
                return reply(server.revision, false, {
                    serverAdvanced,
                    mediaPreserved,
                    ...(serverAdvanced || mediaPreserved ? { document: structuredClone(document) } : {}),
                });
            }
            const expectedRevision = body.params.expectedRevision ?? 0;
            if (expectedRevision !== server.revision) {
                server.attempts.push({ opId: body.opId, expectedRevision, accepted: false });
                throw new ApiError("画布已被其他入口修改", { status: 409, reason: "stale_revision" });
            }
            server.revision += 1;
            server.document = { ...structuredClone(body.params.document ?? {}), id: "c1", revision: server.revision } as Doc;
            server.receipts.set(body.opId, server.revision);
            server.attempts.push({ opId: body.opId, expectedRevision, accepted: true });
            return reply(server.revision, false);
        },
    },
}));

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: (project: { id: string; revision?: number }) => {
        notifications.push({ id: project.id, revision: project.revision ?? 0 });
    },
    isLocalWorkspaceMode: () => true,
}));

mock.module("@/services/canvas-sync-drafts", () => ({
    preserveCanvasSyncDraft: async (project: { title?: string; chatSessions?: Array<{ id: string }> }) => {
        if (draftFailure) throw new Error("存储空间不足");
        drafts.push(structuredClone(project));
        return drafts.length;
    },
    readCanvasSyncDrafts: async () => [],
    readAllCanvasSyncDrafts: async () => [],
}));

mock.module("@/stores/use-asset-store", () => ({
    useAssetStore: { getState: () => ({ assets: [] }) },
    flushAssetStorePersistence: async () => {},
}));

mock.module("@/services/workspace-mode", () => ({ isLocalWorkspaceMode: () => true }));

mock.module("@/services/api/resources", () => ({
    resourceIdFromStorageKey: () => "",
    resourceFileUrl: () => "",
}));

const {
    hasUnconfirmedCanvasEdits,
    openLocalCanvasProjectFromBackend,
    refreshLocalCanvasProjectIfChanged,
    resetLocalCanvasBackendSaveState,
    scheduleLocalCanvasBackendSync,
    syncLocalCanvasProjectToBackend,
} = await import("@/services/local-workspace-repository");
const { clearCanvasDocumentBase, recordCanvasDocumentBase, useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
const { getActiveUserScope } = await import("@/lib/user-scope");
const { projectSyncProgress, useSyncProgressStore } = await import("@/stores/use-sync-progress-store");
const { loadCanvasOperationJournal, resetCanvasOperationJournalMemory, saveCanvasOperationJournal } = await import("@/services/canvas-operation-journal");

const scope = getActiveUserScope();

function shot(id: string, title: string) {
    return { id, type: "text", title, position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { content: title } };
}

function chat(id: string, text: string) {
    return { id, title: "对话", messages: [{ id: `${id}-m`, role: "user", content: text }] };
}

function canvas(revision: number, patch: Record<string, unknown> = {}): Doc {
    return {
        id: "c1",
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [shot("n1", "镜头一")],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...patch,
    } as Doc;
}

/** A server-side writer (assistant turn, task bind) that bumps the revision. */
function externalWrite(change: (doc: Doc) => Doc) {
    server.revision += 1;
    server.document = { ...change(structuredClone(server.document!)), revision: server.revision };
}

const addNode = (id: string, title: string) => (doc: Doc) => ({ ...doc, nodes: [...doc.nodes, shot(id, title)] });

async function seedConfirmed(doc: Doc) {
    server.revision = doc.revision;
    server.document = structuredClone(doc);
    await saveCanvasOperationJournal({ userScope: scope, canvasId: "c1", confirmedRevision: doc.revision, confirmedSnapshot: structuredClone(doc) as never, inFlight: null, pendingProjection: null });
    recordCanvasDocumentBase(structuredClone(doc) as never, scope);
    useCanvasStore.setState({ projects: [structuredClone(doc) as never] });
}

/** Simulate an app reload: process memory is gone, IndexedDB keeps the journal and the cached canvas. */
function reloadWith(live: Doc) {
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    clearCanvasDocumentBase("c1", scope);
    useSyncProgressStore.getState().clearAll();
    useCanvasStore.setState({ projects: [structuredClone(live) as never] });
}

const live = () => useCanvasStore.getState().openProject("c1")!;
const ids = (items: Array<{ id: string }> | undefined) => (items ?? []).map((item) => item.id);
const attempts = () => server.attempts.map((attempt) => [attempt.expectedRevision, attempt.accepted]);

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

beforeEach(() => {
    stored.clear();
    drafts.length = 0;
    notifications.length = 0;
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    server.revision = 0;
    server.document = null;
    server.attempts = [];
    server.receipts.clear();
    server.gets = 0;
    server.getHold = null;
    server.commitHold = null;
    server.commitStarted = 0;
    server.beforeCommit = [];
    server.failNext = null;
    server.failGets = 0;
    draftFailure = false;
    useSyncProgressStore.getState().clearAll();
    useCanvasStore.setState({ projects: [] });
});

describe("服务端写入与本地自动保存交错", () => {
    test("助手写入节点时本地正在自动保存聊天：刷新后两边都保留，并按最新 revision 提交", async () => {
        await seedConfirmed(canvas(1));
        useCanvasStore.getState().updateProject("c1", { chatSessions: [chat("s1", "帮我加一个镜头")] as never, activeChatId: "s1" });
        scheduleLocalCanvasBackendSync("c1");
        externalWrite(addNode("n2", "助手加的镜头"));

        await refreshLocalCanvasProjectIfChanged("c1");

        expect(ids(live().nodes)).toEqual(["n1", "n2"]);
        expect(ids(live().chatSessions)).toEqual(["s1"]);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await waitFor(() => !hasUnconfirmedCanvasEdits("c1"));
        expect(attempts()).toEqual([[2, true]]);
        expect(ids(server.document!.nodes)).toEqual(["n1", "n2"]);
        expect(ids(server.document!.chatSessions as never)).toEqual(["s1"]);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
    });

    test("自动保存撞上助手写入：增量 patch 一次请求在服务端原子合并并返回最新文档，不触发 409", async () => {
        await seedConfirmed(canvas(1));
        useCanvasStore.getState().updateProject("c1", { chatSessions: [chat("s1", "帮我加一个镜头")] as never });
        server.beforeCommit.push(() => externalWrite(addNode("n2", "助手加的镜头")));

        await syncLocalCanvasProjectToBackend("c1");

        expect(attempts()).toEqual([[1, true]]);
        expect(server.gets).toBe(0);
        expect(ids(server.document!.nodes)).toEqual(["n1", "n2"]);
        expect(ids(server.document!.chatSessions as never)).toEqual(["s1"]);
        expect(ids(live().nodes)).toEqual(["n1", "n2"]);
        expect(ids(live().chatSessions)).toEqual(["s1"]);
        expect(notifications.some((item) => item.revision === 3)).toBe(true);
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
    });

    test("同一字段两边都改过：增量 patch 保留本地标题并在服务端合并完成，不锁死自动保存", async () => {
        await seedConfirmed(canvas(1));
        useCanvasStore.getState().updateProject("c1", { title: "本地标题" });
        server.beforeCommit.push(() => externalWrite((doc) => ({ ...doc, title: "助手标题" })));

        await syncLocalCanvasProjectToBackend("c1");

        expect(attempts()).toEqual([[1, true]]);
        expect(live().title).toBe("本地标题");
        expect(server.document!.title).toBe("本地标题");
        expect((await loadCanvasOperationJournal("c1", scope)).confirmedRevision).toBe(3);
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
    });

    test("连续多次并发写入：增量 patch 连续收敛，不丢任何一方的新增节点与聊天", async () => {
        await seedConfirmed(canvas(1));
        useCanvasStore.getState().updateProject("c1", { chatSessions: [chat("s1", "帮我加一个镜头")] as never });
        server.beforeCommit.push(() => {
            externalWrite(addNode("n2", "助手加的镜头"));
            externalWrite(addNode("n3", "又加一个"));
        });

        await syncLocalCanvasProjectToBackend("c1");

        expect(ids(server.document!.nodes)).toEqual(["n1", "n2", "n3"]);
        expect(ids(server.document!.chatSessions as never)).toEqual(["s1"]);
        expect(ids(live().nodes)).toEqual(["n1", "n2", "n3"]);
        expect(ids(live().chatSessions)).toEqual(["s1"]);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("会话内在途 patch 提交结果未知时服务端被改：重放原 operationId 原子合并成功，不暂停", async () => {
        await seedConfirmed(canvas(1));
        useCanvasStore.getState().updateProject("c1", { chatSessions: [chat("s1", "帮我加一个镜头")] as never });
        server.failNext = { status: 503 };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const lostOp = (await loadCanvasOperationJournal("c1", scope)).inFlight?.operationId;
        expect(lostOp).toBeTruthy();
        externalWrite(addNode("n2", "助手加的镜头"));

        await refreshLocalCanvasProjectIfChanged("c1");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await waitFor(() => !hasUnconfirmedCanvasEdits("c1"));
        expect(server.attempts.map((attempt) => [attempt.opId === lostOp, attempt.expectedRevision, attempt.accepted])).toEqual([[true, 1, true]]);
        expect(ids(server.document!.nodes)).toEqual(["n1", "n2"]);
        expect(ids(server.document!.chatSessions as never)).toEqual(["s1"]);
        expect((await loadCanvasOperationJournal("c1", scope)).inFlight).toBeNull();
    });

    test("未知提交重放只发送改动的标题字段，不会把旧成功媒体写回远端 loading 节点", async () => {
        const original = { ...shot("n1", "原图"), type: "image", metadata: { taskId: "task-1", status: "success", content: "media-a", storageKey: "resource:old" } };
        await seedConfirmed(canvas(1, { nodes: [original] }));
        useCanvasStore.getState().updateProject("c1", { title: "本地标题" });
        server.failNext = { status: 503 };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        const originalOperation = (await loadCanvasOperationJournal("c1", scope)).inFlight?.operationId;
        externalWrite((doc) => ({ ...doc, nodes: [{ ...original, metadata: { taskId: "task-1", status: "loading", taskStatus: "running", content: "" } }] }));

        await syncLocalCanvasProjectToBackend("c1");

        expect(server.attempts.map((attempt) => [attempt.opId === originalOperation, attempt.expectedRevision, attempt.accepted])).toEqual([[true, 1, true]]);
        expect(server.document?.title).toBe("本地标题");
        const saved = server.document!.nodes[0] as typeof original;
        expect(saved.metadata.status).toBe("loading");
        expect(saved.metadata.content).toBe("");
        expect(saved.metadata.storageKey).toBeUndefined();
        expect(live().nodes[0].metadata?.status).toBe("loading");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("提交回执之后才返回的旧 GET 不会退回已确认版本，也不会制造冲突", async () => {
        await seedConfirmed(canvas(1));
        let releaseGet = () => {};
        server.getHold = new Promise<void>((resolve) => { releaseGet = resolve; });
        const refreshing = refreshLocalCanvasProjectIfChanged("c1");
        await waitFor(() => server.gets === 1);

        useCanvasStore.getState().updateProject("c1", { title: "本地标题" });
        await syncLocalCanvasProjectToBackend("c1");
        releaseGet();

        expect(await refreshing).toBeUndefined();
        const journal = await loadCanvasOperationJournal("c1", scope);
        expect(journal.confirmedRevision).toBe(2);
        expect(journal.confirmedSnapshot?.title).toBe("本地标题");
        expect(live().title).toBe("本地标题");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });
});

describe("重载后恢复", () => {
    test("在途提交没落到服务端、服务端又被助手改过：打开不暂停，重放被拒后合并保存", async () => {
        await seedConfirmed(canvas(1));
        const draft = canvas(1, { chatSessions: [chat("s1", "帮我加一个镜头")] });
        await saveCanvasOperationJournal({
            userScope: scope,
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas(1) as never,
            inFlight: { operationId: "op-lost", expectedRevision: 1, payload: { canvasId: "c1", expectedRevision: 1, document: draft as never } },
            pendingProjection: null,
        });
        externalWrite(addNode("n2", "助手加的镜头"));
        reloadWith(draft);

        const opened = await openLocalCanvasProjectFromBackend("c1");
        expect(ids(opened?.chatSessions)).toEqual(["s1"]);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.attempts.map((attempt) => [attempt.opId, attempt.expectedRevision, attempt.accepted])).toEqual([["op-lost", 1, false], [expect.any(String), 2, true]]);
        expect(ids(server.document!.nodes)).toEqual(["n1", "n2"]);
        expect(ids(server.document!.chatSessions as never)).toEqual(["s1"]);
        expect(ids(live().nodes)).toEqual(["n1", "n2"]);
        expect((await loadCanvasOperationJournal("c1", scope)).inFlight).toBeNull();
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("在途提交其实已落到服务端：重放拿到原回执，不另开 revision", async () => {
        await seedConfirmed(canvas(1));
        const draft = canvas(1, { title: "已提交的标题" });
        await saveCanvasOperationJournal({
            userScope: scope,
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: canvas(1) as never,
            inFlight: { operationId: "op-applied", expectedRevision: 1, payload: { canvasId: "c1", expectedRevision: 1, document: draft as never } },
            pendingProjection: null,
        });
        server.revision = 2;
        server.document = { ...draft, revision: 2 };
        server.receipts.set("op-applied", 2);
        reloadWith(draft);

        await openLocalCanvasProjectFromBackend("c1");
        await syncLocalCanvasProjectToBackend("c1");

        expect(server.attempts).toEqual([]);
        expect(server.revision).toBe(2);
        const journal = await loadCanvasOperationJournal("c1", scope);
        expect(journal.inFlight).toBeNull();
        expect(journal.confirmedRevision).toBe(2);
        expect(live().title).toBe("已提交的标题");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
    });

    test("未保存的聊天修改与服务端新节点互不相关：打开时合并，不暂停，下一次保存带上两边", async () => {
        await seedConfirmed(canvas(1));
        externalWrite(addNode("n2", "助手加的镜头"));
        reloadWith(canvas(1, { chatSessions: [chat("s1", "帮我加一个镜头")] }));

        const opened = await openLocalCanvasProjectFromBackend("c1");
        expect(ids(opened?.nodes)).toEqual(["n1", "n2"]);
        expect(ids(opened?.chatSessions)).toEqual(["s1"]);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await syncLocalCanvasProjectToBackend("c1");
        expect(attempts()).toEqual([[2, true]]);
        expect(ids(server.document!.chatSessions as never)).toEqual(["s1"]);
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("本地缓存改了节点标题、日记停在旧版本、服务端新增连线：打开时合并，保存不覆盖服务端连线", async () => {
        const nodes = [shot("n0", "镜头零"), shot("n1", "镜头一")];
        await seedConfirmed(canvas(105, { nodes }));
        server.revision = 111;
        server.document = canvas(111, { nodes, connections: [{ id: "e0", fromNodeId: "n0", toNodeId: "n1" }] });
        reloadWith(canvas(105, { nodes: [{ ...nodes[0], title: "未保存的标题" }, nodes[1]] }));
        // The journal survives reload: only process memory was lost.
        await saveCanvasOperationJournal({ userScope: scope, canvasId: "c1", confirmedRevision: 105, confirmedSnapshot: canvas(105, { nodes }) as never, inFlight: null, pendingProjection: null });

        const opened = await openLocalCanvasProjectFromBackend("c1");
        expect(ids(opened?.connections as never)).toEqual(["e0"]);
        expect((opened?.nodes as Array<{ title: string }>)[0].title).toBe("未保存的标题");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await syncLocalCanvasProjectToBackend("c1");
        expect(attempts()).toEqual([[111, true]]);
        expect(ids(server.document!.connections as never)).toEqual(["e0"]);
        expect((server.document!.nodes as Array<{ title: string }>)[0].title).toBe("未保存的标题");
    });

    test("本地和服务端改了同一字段：打开时保留本地修改并推进基线，不锁死自动保存", async () => {
        await seedConfirmed(canvas(1));
        externalWrite((doc) => ({ ...doc, title: "助手标题" }));
        reloadWith(canvas(1, { title: "本地标题" }));

        const opened = await openLocalCanvasProjectFromBackend("c1");
        expect(opened?.title).toBe("本地标题");
        expect(live().title).toBe("本地标题");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.document!.title).toBe("本地标题");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });
});

describe("本地保存状态", () => {
    test("等待、保存中、已保存、失败都如实写进进度", async () => {
        await seedConfirmed(canvas(1));
        useCanvasStore.getState().updateProject("c1", { title: "第一次" });
        let release = () => {};
        server.commitHold = new Promise<void>((resolve) => { release = resolve; });

        scheduleLocalCanvasBackendSync("c1");
        expect(projectSyncProgress("c1", scope)?.phase).toBe("pending");
        await waitFor(() => server.commitStarted === 1);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("saving");
        release();
        await waitFor(() => !hasUnconfirmedCanvasEdits("c1"));
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");

        server.commitHold = null;
        useCanvasStore.getState().updateProject("c1", { title: "第二次" });
        server.failNext = { status: 503 };
        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();
        expect(projectSyncProgress("c1", scope)?.phase).toBe("error");

        await syncLocalCanvasProjectToBackend("c1");
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
        expect(server.document!.title).toBe("第二次");
    });
});
