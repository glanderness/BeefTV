import { beforeEach, describe, expect, mock, test } from "bun:test";
import { buildCanvasDocumentPatch, preserveUntouchedStoredNodes } from "@/lib/canvas/canvas-document-patch";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { applyMockCanvasPatch, type MockCanvasPatchParams } from "./helpers/mock-canvas-patch";

const stored = new Map<string, string>();
const server = {
    projects: new Map<string, Record<string, unknown>>(),
    patches: [] as Array<{ opId?: string; params: MockCanvasPatchParams }>,
    commits: [] as Array<{ opId?: string; params: Record<string, unknown> }>,
    puts: 0,
};

class ApiError extends Error {
    status?: number;
    reason?: string;
    retryable = false;
    constructor(message: string, options: { status?: number; reason?: string } = {}) {
        super(message);
        this.status = options.status;
        this.reason = options.reason;
    }
}

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
        get: async (path: string) => {
            if (path === "/canvas-projects") {
                return { projects: [...server.projects.values()].map((p) => ({ id: p.id })), hasMore: false };
            }
            const id = decodeURIComponent(path.split("/").pop() ?? "");
            return { project: structuredClone(server.projects.get(id)) };
        },
        put: async (_path: string, body: { project: Record<string, unknown> }) => {
            server.puts += 1;
            const id = String(body.project.id);
            const existing = server.projects.get(id);
            const rev = ((existing?.revision as number) ?? 0) + 1;
            const saved = { ...structuredClone(body.project), revision: rev };
            server.projects.set(id, saved);
            return { project: { id, revision: rev, updatedAt: "2026-01-01T00:00:00.000Z" } };
        },
        post: async (path: string, body: { opId?: string; params?: MockCanvasPatchParams & { canvasId?: string; expectedRevision?: number; document?: Record<string, unknown> } }) => {
            const id = String(body.params?.canvasId ?? "c1");
            const current = server.projects.get(id) ?? null;
            const nextRev = ((current?.revision as number) ?? 0) + 1;
            if (path === "/ops/canvas.document.patch") {
                server.patches.push({ opId: body.opId, params: structuredClone(body.params ?? {}) });
                const { document, serverAdvanced } = applyMockCanvasPatch(current, body.params ?? {}, nextRev);
                server.projects.set(id, document);
                return {
                    op: "canvas.document.patch",
                    opId: body.opId,
                    replayed: false,
                    caller: "manual",
                    revision: nextRev,
                    result: {
                        canvasId: id,
                        revision: nextRev,
                        updatedAt: "2026-01-01T00:00:00.000Z",
                        serverAdvanced,
                        ...(serverAdvanced ? { document: structuredClone(document) } : {}),
                    },
                };
            }
            server.commits.push({ opId: body.opId, params: structuredClone(body.params ?? {}) });
            const saved = { ...structuredClone(body.params?.document ?? {}), id, revision: nextRev };
            server.projects.set(id, saved);
            return {
                op: "canvas.document.commit",
                opId: body.opId,
                replayed: false,
                caller: "manual",
                revision: nextRev,
                result: { canvasId: id, revision: nextRev, updatedAt: "2026-01-01T00:00:00.000Z" },
            };
        },
    },
}));

mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: () => {},
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
    adoptServerConfirmedGenerationPatch,
    hydrateLocalCanvasProjectsFromBackend,
    resetLocalCanvasBackendSaveState,
    syncLocalCanvasProjectToBackend,
} = await import("@/services/local-workspace-repository");
const { clearCanvasDocumentBase, clearCanvasExternalRevisionConflict, recordCanvasDocumentBase, useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
const { canvasBackendSubmitPaused } = await import("@/services/canvas-revision-conflict");
const { resetCanvasOperationJournalMemory, saveCanvasOperationJournal } = await import("@/services/canvas-operation-journal");
const { getActiveUserScope } = await import("@/lib/user-scope");
const { projectSyncProgress, useSyncProgressStore } = await import("@/stores/use-sync-progress-store");

const scope = getActiveUserScope();

function makeNode(id: string, title: string, extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id,
        type: "image",
        title,
        position: { x: 0, y: 0 },
        width: 320,
        height: 220,
        metadata: {},
        ...extra,
    } as CanvasNodeData;
}

function makeCanvas(id: string, revision: number, extra: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id,
        revision,
        title: `画布-${id}`,
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
        ...extra,
    } as CanvasProject;
}

beforeEach(() => {
    stored.clear();
    server.projects.clear();
    server.patches = [];
    server.commits = [];
    server.puts = 0;
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    useSyncProgressStore.getState().clearAll();
    clearCanvasExternalRevisionConflict(scope, "c1");
    clearCanvasExternalRevisionConflict(scope, "c2");
    clearCanvasDocumentBase("c1", scope);
    clearCanvasDocumentBase("c2", scope);
    useCanvasStore.setState({ projects: [] });
});

describe("canvas-document-patch 单元测试", () => {
    test("拖动单个节点只发送该节点的增量，且过滤打开时的时间戳与恢复占位文案", () => {
        const loadingNode = makeNode("n-load", "生成中", { metadata: { status: "loading", taskId: "t1" } });
        const dragNode = makeNode("n-drag", "图片", { position: { x: 10, y: 20 } });
        const base = makeCanvas("c1", 5, { nodes: [loadingNode, dragNode] });
        const live = makeCanvas("c1", 5, {
            nodes: [
                {
                    ...loadingNode,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    metadata: { ...loadingNode.metadata, errorDetails: "正在从任务中心恢复生成状态..." },
                } as CanvasNodeData,
                {
                    ...dragNode,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    position: { x: 300, y: 400 },
                } as CanvasNodeData,
            ],
        });

        const patch = buildCanvasDocumentPatch(base, live);
        expect(patch).not.toBeNull();
        expect(patch?.baseRevision).toBe(5);
        expect(patch?.upsertNodes?.map((n) => n.id)).toEqual(["n-drag"]);
        expect((patch?.upsertNodes?.[0] as { position?: unknown }).position).toEqual({ x: 300, y: 400 });
        expect("createdAt" in (patch?.upsertNodes?.[0] ?? {})).toBe(false);
        expect(patch?.deleteNodeIds).toBeUndefined();
        expect(patch?.fields).toBeUndefined();
    });

    test("preserveUntouchedStoredNodes 保留未动节点的原始存储引用，只写回真正编辑的节点", () => {
        const storedA = makeNode("a", "A");
        const storedB = makeNode("b", "B", { metadata: { status: "loading", taskId: "t1" } });
        const observedA = { ...storedA, createdAt: "2026-01-01" } as CanvasNodeData;
        const observedB = { ...storedB, createdAt: "2026-01-01", metadata: { status: "loading", taskId: "t1", errorDetails: "正在从任务中心恢复生成状态..." } } as CanvasNodeData;
        const draggedA = { ...observedA, position: { x: 99, y: 88 } };

        const result = preserveUntouchedStoredNodes([observedA, observedB], [storedA, storedB], [draggedA, observedB]);
        expect(result[0]).toBe(draggedA);
        expect(result[1]).toBe(storedB);
    });
});

describe("单用户版本冲突五类根因回归测试", () => {
    test("并行两个后台任务完成时本地拖动节点：一次增量 patch 收敛，无冲突且两端数据全保留", async () => {
        const n1 = makeNode("n1", "任务1", { metadata: { status: "loading", taskId: "t1" } });
        const n2 = makeNode("n2", "任务2", { metadata: { status: "loading", taskId: "t2" } });
        const nDrag = makeNode("n-drag", "拖动节点", { position: { x: 10, y: 10 } });
        const initial = makeCanvas("c1", 1, { nodes: [n1, n2, nDrag] });
        server.projects.set("c1", structuredClone(initial) as unknown as Record<string, unknown>);
        await saveCanvasOperationJournal({
            userScope: scope,
            canvasId: "c1",
            confirmedRevision: 1,
            confirmedSnapshot: structuredClone(initial),
            inFlight: null,
        });
        recordCanvasDocumentBase(structuredClone(initial), scope);
        useCanvasStore.setState({ projects: [structuredClone(initial)] });

        // 后端两个生成任务并行写回（rev 1 -> 2 -> 3）。
        const afterTasks = makeCanvas("c1", 3, {
            nodes: [
                makeNode("n1", "任务1", { metadata: { status: "success", taskId: "t1", content: "/res/1.png", storageKey: "resource:1" } }),
                makeNode("n2", "任务2", { metadata: { status: "success", taskId: "t2", content: "/res/2.png", storageKey: "resource:2" } }),
                nDrag,
            ],
        });
        server.projects.set("c1", structuredClone(afterTasks) as unknown as Record<string, unknown>);

        // 同时用户拖动 n-drag。
        useCanvasStore.getState().updateProject("c1", {
            nodes: [n1, n2, { ...nDrag, position: { x: 520, y: 310 } }],
        });

        await syncLocalCanvasProjectToBackend("c1");

        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].params.upsertNodes?.map((item) => item.id)).toEqual(["n-drag"]);
        expect(canvasBackendSubmitPaused("c1", scope)).toBe(false);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
        const liveNodes = useCanvasStore.getState().openProject("c1")!.nodes;
        expect(liveNodes.find((n) => n.id === "n1")?.metadata?.content).toBe("/res/1.png");
        expect(liveNodes.find((n) => n.id === "n2")?.metadata?.content).toBe("/res/2.png");
        expect(liveNodes.find((n) => n.id === "n-drag")?.position).toEqual({ x: 520, y: 310 });
    });

    test("冷缓存无基线时收到生成结果：合并本地节点与服务端产物，不触发暂停冲突", async () => {
        const localNode = makeNode("n-local", "本地刚建");
        useCanvasStore.setState({ projects: [makeCanvas("c1", 1, { nodes: [localNode] })] });
        const remote = makeCanvas("c1", 4, {
            nodes: [makeNode("n-gen", "后台生成", { metadata: { status: "success", content: "/res/gen.png" } })],
        });
        const adopted = await adoptServerConfirmedGenerationPatch(remote);
        expect(adopted?.nodes.map((n) => n.id).sort()).toEqual(["n-gen", "n-local"]);
        expect(canvasBackendSubmitPaused("c1", scope)).toBe(false);
    });

    test("多画布 hydration 并发进行时，期间对其中一张画布的编辑不会被旧快照覆盖", async () => {
        const c1Server = makeCanvas("c1", 2, { nodes: [makeNode("a", "A")] });
        const c2Server = makeCanvas("c2", 2, { nodes: [makeNode("b", "B")] });
        server.projects.set("c1", structuredClone(c1Server) as unknown as Record<string, unknown>);
        server.projects.set("c2", structuredClone(c2Server) as unknown as Record<string, unknown>);
        useCanvasStore.setState({
            projects: [
                makeCanvas("c1", 2, { nodes: [makeNode("a", "A"), makeNode("local-new", "用户新建")] }),
                makeCanvas("c2", 1, { nodes: [] }),
            ],
        });
        recordCanvasDocumentBase(makeCanvas("c1", 2, { nodes: [makeNode("a", "A")] }), scope);
        recordCanvasDocumentBase(makeCanvas("c2", 1, { nodes: [] }), scope);

        expect(await hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        const liveC1 = useCanvasStore.getState().openProject("c1");
        const liveC2 = useCanvasStore.getState().openProject("c2");
        expect(liveC1?.nodes.map((n) => n.id)).toEqual(["a", "local-new"]);
        expect(liveC2?.nodes.map((n) => n.id)).toEqual(["b"]);
    });
});
