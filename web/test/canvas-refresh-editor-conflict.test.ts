import { beforeEach, describe, expect, mock, test } from "bun:test";
import { applyMockCanvasPatch, type MockCanvasPatchParams } from "./helpers/mock-canvas-patch";

const stored = new Map<string, string>();
const server = { document: null as Record<string, unknown> | null, revision: 0, posts: [] as Array<{ path: string; expectedRevision?: number; baseRevision?: number }> };
let library: CanvasProject[] = [];
type RefreshListener = (project: never, previous: never) => void;
const refreshListeners = new Set<RefreshListener>();

class ApiError extends Error {
    status?: number;
    reason?: string;
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
        get: async (path: string) => path === "/canvas-projects"
            ? { projects: library.map(({ id }) => ({ id })), hasMore: false }
            : { project: library.find(({ id }) => path === `/canvas-projects/${id}`) ?? server.document },
        put: async (_path: string, body: { project: Record<string, unknown> }) => {
            server.revision += 1;
            server.document = { ...body.project, revision: server.revision };
            return { project: { id: String(body.project.id), revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" } };
        },
        post: async (path: string, body: { opId?: string; params?: MockCanvasPatchParams & { expectedRevision?: number; document?: Record<string, unknown> } }) => {
            server.revision += 1;
            if (path === "/ops/canvas.document.patch") {
                const { document, serverAdvanced } = applyMockCanvasPatch(server.document, body.params ?? {}, server.revision);
                server.document = document;
                server.posts.push({ path, baseRevision: body.params?.baseRevision });
                return {
                    op: "canvas.document.patch",
                    opId: body.opId,
                    replayed: false,
                    caller: "manual",
                    revision: server.revision,
                    result: {
                        canvasId: "c1",
                        revision: server.revision,
                        updatedAt: "2026-01-01T00:00:00.000Z",
                        serverAdvanced,
                        ...(serverAdvanced ? { document } : {}),
                    },
                };
            }
            server.posts.push({ path, expectedRevision: body.params?.expectedRevision });
            server.document = { ...body.params?.document, revision: server.revision };
            return { op: "canvas.document.commit", opId: body.opId, replayed: false, caller: "manual", revision: server.revision, result: { canvasId: "c1", revision: server.revision, updatedAt: "2026-01-01T00:00:00.000Z" } };
        },
    },
}));

// Same contract as the real module: the repository notifies, the editor listens.
mock.module("@/services/local-workspace-sync", () => ({
    notifyCanvasRefresh: (project: never, previous: never) => {
        for (const listener of [...refreshListeners]) listener(project, previous);
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
    hydrateLocalCanvasProjectsFromBackend,
    refreshLocalCanvasProjectIfChanged,
    resetLocalCanvasBackendSaveState,
    syncLocalCanvasProjectToBackend,
} = await import("@/services/local-workspace-repository");
const { mergeCanvasRefreshPatch } = await import("@/lib/canvas/canvas-patch-merge");
const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
const { getActiveUserScope } = await import("@/lib/user-scope");
const { projectSyncProgress, useSyncProgressStore } = await import("@/stores/use-sync-progress-store");
const { resetCanvasOperationJournalMemory } = await import("@/services/canvas-operation-journal");
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";

const scope = getActiveUserScope();

function textNode(id: string, title: string): CanvasNodeData {
    return { id, type: "text", title, position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { content: title } } as CanvasNodeData;
}

function canvas(revision: number, nodes: CanvasNodeData[]): CanvasProject {
    return {
        id: "c1",
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    } as CanvasProject;
}

const stamp = (node: CanvasNodeData): CanvasNodeData => ({ ...node, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

/** The refresh step of use-canvas-project-lifecycle, against an editor graph held in memory. */
function mountEditor(initial: CanvasNodeData[]) {
    const editor = { nodes: initial, held: 0 };
    const listener = (project: CanvasProject, previous: CanvasProject | undefined) => {
        editor.nodes = previous ? mergeCanvasRefreshPatch(previous, project, editor.nodes, []).nodes : project.nodes;
    };
    refreshListeners.add(listener as RefreshListener);
    return editor;
}

const assistantNodes = [textNode("a1", "助手文本一"), textNode("a2", "助手文本二")];

async function confirmedAssistantCanvas() {
    server.document = canvas(0, assistantNodes) as never;
    server.revision = 0;
    useCanvasStore.setState({ projects: [canvas(0, assistantNodes)] });
    await syncLocalCanvasProjectToBackend("c1");
}

beforeEach(() => {
    stored.clear();
    library = [];
    refreshListeners.clear();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    server.posts = [];
    useSyncProgressStore.getState().clearAll();
    useCanvasStore.setState({ projects: [] });
});

describe("外部撤销到达编辑器", () => {
    test("重新生成遇到旧任务回执时不暂停保存，下一次提交使用新版本", async () => {
        const failed: CanvasNodeData = { ...textNode("retry", "视频"), metadata: { status: "error", taskId: "old-task", taskStatus: "failed", errorDetails: "旧失败" } };
        server.document = canvas(0, [failed]) as never;
        server.revision = 0;
        useCanvasStore.setState({ projects: [canvas(0, [failed])] });
        await syncLocalCanvasProjectToBackend("c1");
        const retry: CanvasNodeData = { ...failed, metadata: { status: "loading", taskClientOperationId: "retry-operation", generationSubmissionState: "submitting" } };
        const editor = mountEditor([retry]);
        server.document = canvas(2, [{ ...failed, metadata: { ...failed.metadata, taskUpdatedAt: "2026-01-02" } }]) as never;
        server.revision = 2;

        await refreshLocalCanvasProjectIfChanged("c1");

        expect(editor.held).toBe(0);
        expect(editor.nodes[0].metadata).toEqual(retry.metadata);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
        useCanvasStore.getState().updateProject("c1", { nodes: editor.nodes });
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.posts.at(-1)?.baseRevision).toBe(2);
        expect((server.document?.nodes as CanvasNodeData[])[0].metadata).toEqual(retry.metadata);
    });

    test("编辑器副本只多了节点时间戳：删除照常落到编辑器，不暂停保存", async () => {
        await confirmedAssistantCanvas();
        const editor = mountEditor(assistantNodes.map(stamp));
        server.document = canvas(2, []) as never;

        await refreshLocalCanvasProjectIfChanged("c1");

        expect(editor.held).toBe(0);
        expect(editor.nodes).toEqual([]);
        expect(useCanvasStore.getState().projects[0].nodes).toEqual([]);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
    });

    test("编辑器与远端删除重叠：确定性保留本地改过的节点、删除未改动节点，不锁死自动保存", async () => {
        await confirmedAssistantCanvas();
        const editor = mountEditor([{ ...stamp(assistantNodes[0]), title: "用户刚改的标题" }, stamp(assistantNodes[1])]);
        server.document = canvas(2, []) as never;

        await refreshLocalCanvasProjectIfChanged("c1");

        expect(editor.held).toBe(0);
        expect(editor.nodes.map((node) => node.title)).toEqual(["用户刚改的标题"]);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");

        useCanvasStore.getState().updateProject("c1", { nodes: editor.nodes });
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.posts.at(-1)?.path).toBe("/ops/canvas.document.patch");
        expect((server.document?.nodes as CanvasNodeData[]).map((node) => node.title)).toEqual(["用户刚改的标题"]);
    });
});

test("后台刷新多个画布时保留先刷新画布刚刚写入的同版本草稿", async () => {
    await confirmedAssistantCanvas();
    const store = useCanvasStore.getState();
    const first = store.openProject("c1")!;
    library = [first, { ...canvas(1, []), id: "c2" }];
    let edited = false;
    const unsubscribe = useCanvasStore.subscribe((state) => {
        if (edited || !state.openProject("c2")) return;
        edited = true;
        store.updateProject("c1", { nodes: [{ ...first.nodes[0], title: "刷新期间的新标题" }, first.nodes[1]] });
    });

    try {
        expect(await hydrateLocalCanvasProjectsFromBackend()).toBe(true);
    } finally {
        unsubscribe();
    }

    expect(edited).toBe(true);
    expect(store.openProject("c1")?.revision).toBe(first.revision);
    expect(store.openProject("c1")?.nodes[0]?.title).toBe("刷新期间的新标题");
    expect(store.openProject("c2")).toBeDefined();
    expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
    await syncLocalCanvasProjectToBackend("c1");
    expect(server.posts.at(-1)?.baseRevision ?? server.posts.at(-1)?.expectedRevision).toBe(first.revision);
    expect((server.document?.nodes as CanvasNodeData[])[0]?.title).toBe("刷新期间的新标题");
});
