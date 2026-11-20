import { beforeEach, describe, expect, mock, test } from "bun:test";
import { applyMockCanvasPatch, type MockCanvasPatchParams } from "./helpers/mock-canvas-patch";

type Stored = Map<string, string>;
const stored: Stored = new Map();

/** 一次性可控的 HTTP 替身：服务端文档、revision 与「挂起的 GET」都在这里。 */
type ServerState = {
    document: Record<string, unknown> | null;
    revision: number;
    gets: number;
    puts: Array<{ id: string; revision: number }>;
    posts: Array<{ path: string; opId?: string; expectedRevision?: number; baseRevision?: number }>;
    releaseGet: (() => void) | null;
    rejectNextWrite: { status: number } | null;
};

const server: ServerState = { document: null, revision: 0, gets: 0, puts: [], posts: [], releaseGet: null, rejectNextWrite: null };
const notifications: Array<{ id: string; revision: number }> = [];
let rejectEditorMerge = false;

class ApiError extends Error {
    status?: number;
    reason?: string;
    constructor(message: string, options: { status?: number; reason?: string } = {}) {
        super(message);
        this.status = options.status;
        this.reason = options.reason;
    }
}

mock.module("@/lib/localforage-storage", () => ({
    localForageStorageForScope: () => ({
        getItem: async (name: string) => stored.get(name) ?? null,
        setItem: async (name: string, value: string) => { stored.set(name, value); },
        removeItem: async (name: string) => { stored.delete(name); },
    }),
    localForageStorage: {
        getItem: async (name: string) => stored.get(name) ?? null,
        setItem: async (name: string, value: string) => { stored.set(name, value); },
        removeItem: async (name: string) => { stored.delete(name); },
    },
}));

const actualRequest = await import("@/services/api/request");
mock.module("@/services/api/request", () => ({
    ...actualRequest,
    ApiError,
    apiBaseURL: "/api",
    compactApiParams: (params: Record<string, unknown>) => params,
    http: {
        get: async () => {
            server.gets += 1;
            if (server.releaseGet) {
                await new Promise<void>((resolve) => { server.pendingResolve = resolve; });
            }
            return { project: server.document };
        },
        put: async (path: string, body: { project: Record<string, unknown> }) => {
            if (server.rejectNextWrite) {
                const status = server.rejectNextWrite.status;
                server.rejectNextWrite = null;
                throw new ApiError("画布已被其他入口修改", { status, reason: "canvas_revision_conflict" });
            }
            server.revision += 1;
            const id = String(body.project.id);
            server.puts.push({ id, revision: server.revision });
            server.document = { ...body.project, revision: server.revision };
            return { project: { id, revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" } };
        },
        post: async (path: string, body: { opId?: string; params?: MockCanvasPatchParams & { expectedRevision?: number; document?: Record<string, unknown> } }) => {
            if (server.rejectNextWrite) {
                const status = server.rejectNextWrite.status;
                server.rejectNextWrite = null;
                throw new ApiError("画布已被其他入口修改", { status, reason: "stale_revision" });
            }
            server.revision += 1;
            if (path === "/ops/canvas.document.patch") {
                const id = String(body.params?.canvasId || "c1");
                const { document, serverAdvanced } = applyMockCanvasPatch(server.document, body.params ?? {}, server.revision);
                server.posts.push({ path, opId: body.opId, baseRevision: body.params?.baseRevision });
                server.document = document;
                return {
                    op: "canvas.document.patch",
                    opId: body.opId,
                    replayed: false,
                    caller: "manual",
                    revision: server.revision,
                    result: {
                        canvasId: id,
                        revision: server.revision,
                        updatedAt: "2026-01-01T00:00:00.000Z",
                        serverAdvanced,
                        ...(serverAdvanced ? { document } : {}),
                    },
                };
            }
            const document = body.params?.document ?? {};
            const id = String(body.params?.canvasId || document.id || "c1");
            server.posts.push({ path, opId: body.opId, expectedRevision: body.params?.expectedRevision });
            server.document = { ...document, id, revision: server.revision };
            return {
                op: "canvas.document.commit",
                opId: body.opId,
                replayed: false,
                caller: "manual",
                revision: server.revision,
                result: { canvasId: id, revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" },
            };
        },
    },
}));

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: (project: { id: string; revision?: number }, previous: unknown) => {
        if (previous && rejectEditorMerge) throw new Error("live editor conflict");
        notifications.push({ id: project.id, revision: project.revision ?? 0 });
    },
    isLocalWorkspaceMode: () => true,
}));

mock.module("@/services/canvas-sync-drafts", () => ({
    preserveCanvasSyncDraft: async () => 1,
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
    refreshLocalCanvasProjectIfChanged,
    resetLocalCanvasBackendSaveState,
    syncLocalCanvasProjectToBackend,
} = await import("@/services/local-workspace-repository");
const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
const { getActiveUserScope } = await import("@/lib/user-scope");
const { projectSyncProgress, useSyncProgressStore } = await import("@/stores/use-sync-progress-store");
const { resetCanvasOperationJournalMemory } = await import("@/services/canvas-operation-journal");

const scope = getActiveUserScope();

function canvas(revision: number, patch: Record<string, unknown> = {}) {
    return {
        id: "c1",
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [{ id: "n1", type: "image", title: "镜头1", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "服务端提示" } }],
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

function replaceServerDocument(document: unknown) {
    server.document = document as Record<string, unknown>;
}

/** 用真实保存链建立服务端确认基线：store 内容 == 服务端已接受的内容。 */
async function establishConfirmedBaseline() {
    server.document = canvas(0);
    server.revision = 0;
    useCanvasStore.setState({ projects: [canvas(0)] });
    await syncLocalCanvasProjectToBackend("c1");
}

beforeEach(() => {
    stored.clear();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    notifications.length = 0;
    rejectEditorMerge = false;
    server.gets = 0;
    server.puts = [];
    server.posts = [];
    server.releaseGet = null;
    server.rejectNextWrite = null;
    useSyncProgressStore.getState().clearAll();
    useCanvasStore.setState({ projects: [] });
});

describe("画布刷新接缝（服务端基线）", () => {
    test("刷新通知抛错仍完成投影，基线与 live 一致", async () => {
        await establishConfirmedBaseline();
        replaceServerDocument(canvas(4, { title: "外部新增内容" }));
        rejectEditorMerge = true;
        const applied = await refreshLocalCanvasProjectIfChanged("c1");
        expect(applied?.title).toBe("外部新增内容");
        expect(useCanvasStore.getState().projects[0].title).toBe("外部新增内容");
        expect(useCanvasStore.getState().projects[0].revision).toBe(4);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
        expect(server.puts.length).toBe(1);
    });
    test("本地内容与服务端确认内容一致时，外部新 revision 立即可见", async () => {
        await establishConfirmedBaseline();
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);

        replaceServerDocument(canvas(2, { title: "外部改名", nodes: [{ id: "n1", type: "image", title: "镜头1", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "外部提示" } }] }));
        const applied = await refreshLocalCanvasProjectIfChanged("c1");

        expect(applied?.title).toBe("外部改名");
        expect(useCanvasStore.getState().projects[0].nodes[0].metadata?.prompt).toBe("外部提示");
        expect(notifications.map((item) => item.id)).toContain("c1");
    });

    test("外部刷新落地后，后续手工提交通过增量 patch 带上最新 baseRevision", async () => {
        await establishConfirmedBaseline();
        replaceServerDocument(canvas(2, { title: "助手改过" }));
        await refreshLocalCanvasProjectIfChanged("c1");
        useCanvasStore.getState().updateProject("c1", { title: "手工再改" });
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.posts).toEqual([expect.objectContaining({ path: "/ops/canvas.document.patch", baseRevision: 2 })]);
        expect(useCanvasStore.getState().projects[0].title).toBe("手工再改");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
    });

    test("GET 返回后用户又编辑：确定性保留用户刚改的标题且不进入版本冲突暂停", async () => {
        await establishConfirmedBaseline();
        // 挂起这次 GET，模拟「请求在途时用户继续编辑」。
        server.releaseGet = () => {};
        const pending = refreshLocalCanvasProjectIfChanged("c1");
        await new Promise((resolve) => setTimeout(resolve, 0));

        replaceServerDocument(canvas(3, { title: "外部改名" }));
        useCanvasStore.getState().updateProject("c1", { title: "用户刚改的标题" });
        (server as unknown as { pendingResolve: () => void }).pendingResolve();
        server.releaseGet = null;
        const applied = await pending;

        expect(applied?.title).toBe("用户刚改的标题");
        const live = useCanvasStore.getState().projects[0];
        expect(live.title).toBe("用户刚改的标题");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
    });

    test("HTTP 提交尚未落地时不会被判成可安全刷新", async () => {
        await establishConfirmedBaseline();
        useCanvasStore.getState().updateProject("c1", { title: "本地新标题" });

        // 服务端还没确认这次编辑：即使本地内容已经写进浏览器存储也必须算未确认。
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
    });

    test("本地编辑的是旧白名单之外的字段时，外部刷新保留本地字段并合并其余服务端字段", async () => {
        await establishConfirmedBaseline();
        // folderId 不在旧的七字段白名单里：编辑它同样不得被外部内容静默覆盖。
        useCanvasStore.getState().updateProject("c1", { folderId: "folder-keep-me" });
        replaceServerDocument(canvas(5, { title: "外部改名", folderId: "folder-from-external" }));

        const applied = await refreshLocalCanvasProjectIfChanged("c1");

        expect(applied?.folderId).toBe("folder-keep-me");
        const live = useCanvasStore.getState().projects[0];
        expect(live.folderId).toBe("folder-keep-me");
        expect(live.title).toBe("外部改名");
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.document?.folderId).toBe("folder-keep-me");
        expect(server.document?.title).toBe("外部改名");
    });

    test("偶发 409 且服务端已推进时自动读回合并并重试成功；服务端未推进时转为可重试失败且不改写本地内容", async () => {
        await establishConfirmedBaseline();
        useCanvasStore.getState().updateProject("c1", { title: "本地新标题" });
        server.rejectNextWrite = { status: 409 };

        await expect(syncLocalCanvasProjectToBackend("c1")).rejects.toThrow();

        expect(projectSyncProgress("c1")?.phase).toBe("error");
        expect(useCanvasStore.getState().projects[0].title).toBe("本地新标题");
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(true);
    });

    test("外部刷新采纳远端文档内容时保留本地视口与画布视图偏好（含 showImageInfo）", async () => {
        await establishConfirmedBaseline();
        useCanvasStore.getState().updateProject("c1", {
            viewport: { x: 180, y: -64, k: 0.75 },
            appearance: { theme: "dark" } as never,
            backgroundMode: "dots",
            showImageInfo: true,
        });
        replaceServerDocument(canvas(3, {
            title: "远端新标题",
            nodes: [{ id: "n1", type: "image", title: "远端镜头", position: { x: 10, y: 20 }, width: 320, height: 220, metadata: { prompt: "远端提示" } }],
            viewport: { x: 0, y: 0, k: 1 },
            appearance: undefined,
            backgroundMode: "grid",
            showImageInfo: false,
        }));

        const applied = await refreshLocalCanvasProjectIfChanged("c1");
        expect(applied?.title).toBe("远端新标题");
        expect(applied?.revision).toBe(3);
        expect(applied?.nodes[0]?.title).toBe("远端镜头");
        expect(applied?.viewport).toEqual({ x: 180, y: -64, k: 0.75 });
        expect(applied?.appearance).toEqual({ theme: "dark" } as never);
        expect(applied?.backgroundMode).toBe("dots");
        expect(applied?.showImageInfo).toBe(true);
    });
});
