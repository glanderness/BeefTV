import { beforeEach, describe, expect, mock, test } from "bun:test";
import { sameCanvasContent, sameCanvasDocument } from "@/lib/canvas/canvas-content";
import { buildCanvasDocumentPatch, preserveUntouchedStoredNodes } from "@/lib/canvas/canvas-document-patch";
import { normalizeCanvasNodeTimestamps } from "@/lib/canvas/canvas-node-timestamps";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import { applyMockCanvasPatch, type MockCanvasPatchParams } from "./helpers/mock-canvas-patch";

const stored = new Map<string, string>();
const server = {
    projects: new Map<string, Record<string, unknown>>(),
    patches: [] as Array<{ opId?: string; params: MockCanvasPatchParams; snapshotCaptured: boolean; noOp: boolean }>,
    commits: [] as Array<{ opId?: string; params: Record<string, unknown> }>,
    puts: 0,
    getGates: new Map<string, Promise<void>>(),
    onGetStarted: null as ((id: string) => void) | null,
    patchHold: null as Promise<void> | null,
    onPatchStarted: null as (() => void) | null,
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
            server.onGetStarted?.(id);
            const gate = server.getGates.get(id);
            if (gate) await gate;
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
                server.onPatchStarted?.();
                if (server.patchHold) await server.patchHold;
                const { document, serverAdvanced, mediaPreserved, snapshotCaptured, noOp } = applyMockCanvasPatch(current, body.params ?? {}, nextRev);
                const appliedRev = noOp ? ((current?.revision as number) ?? 0) : nextRev;
                server.patches.push({ opId: body.opId, params: structuredClone(body.params ?? {}), snapshotCaptured, noOp });
                server.projects.set(id, document);
                return {
                    op: "canvas.document.patch",
                    opId: body.opId,
                    replayed: false,
                    caller: "manual",
                    revision: appliedRev,
                    result: {
                        canvasId: id,
                        revision: appliedRev,
                        updatedAt: "2026-01-01T00:00:00.000Z",
                        serverAdvanced,
                        mediaPreserved,
                        snapshotCaptured,
                        ...(serverAdvanced || mediaPreserved ? { document: structuredClone(document) } : {}),
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
    flushLocalWorkspace,
    hasUnconfirmedCanvasEdits,
    hydrateLocalCanvasProjectsFromBackend,
    markCanvasMergeOverlap,
    refreshLocalCanvasProjectIfChanged,
    resetLocalCanvasBackendSaveState,
    syncLocalCanvasProjectToBackend,
} = await import("@/services/local-workspace-repository");
const { clearCanvasDocumentBase, recordCanvasDocumentBase, useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
const { loadCanvasOperationJournal, resetCanvasOperationJournalMemory, saveCanvasOperationJournal, setCanvasJournalStorageDelay } = await import("@/services/canvas-operation-journal");
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
    server.getGates.clear();
    server.onGetStarted = null;
    server.patchHold = null;
    server.onPatchStarted = null;
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    useSyncProgressStore.getState().clearAll();
    for (const id of ["c1", "c2", "c3", "c4"]) {
        clearCanvasDocumentBase(id, scope);
    }
    useCanvasStore.setState({ projects: [] });
});

describe("canvas-document-patch 单元测试", () => {
    test("拖动单个节点只发送该节点的增量与 expectedNodes，过滤打开时的时间戳与恢复占位文案", () => {
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
        expect(patch?.upsertNodes?.map((n) => (n as { id: string }).id)).toEqual(["n-drag"]);
        expect((patch?.upsertNodes?.[0] as { position?: unknown }).position).toEqual({ x: 300, y: 400 });
        expect("createdAt" in ((patch?.upsertNodes?.[0] ?? {}) as Record<string, unknown>)).toBe(false);
        expect(patch?.expectedNodes && Object.keys(patch.expectedNodes)).toEqual(["n-drag"]);
        expect((patch?.expectedNodes?.["n-drag"] as { position?: unknown }).position).toEqual({ x: 10, y: 20 });
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

    test("sameCanvasDocument 与 buildCanvasDocumentPatch 共享节点 bookkeeping 规则，编辑器节点时间戳不会导致永久未确认", async () => {
        const rawNode = makeNode("n1", "图片", { position: { x: 10, y: 20 } });
        const serverDoc = makeCanvas("c1", 2, { nodes: [rawNode] });
        const stampedNodes = normalizeCanvasNodeTimestamps([rawNode], {
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
        });
        const liveWithTimestamps = makeCanvas("c1", 2, { nodes: stampedNodes });

        expect(sameCanvasDocument(serverDoc, liveWithTimestamps)).toBe(true);
        expect(sameCanvasContent(serverDoc, liveWithTimestamps)).toBe(true);
        expect(buildCanvasDocumentPatch(serverDoc, liveWithTimestamps)).toBeNull();

        server.projects.set("c1", structuredClone(serverDoc) as unknown as Record<string, unknown>);
        await saveCanvasOperationJournal({
            userScope: scope,
            canvasId: "c1",
            confirmedRevision: 2,
            confirmedSnapshot: structuredClone(serverDoc),
            inFlight: null,
        });
        recordCanvasDocumentBase(structuredClone(serverDoc), scope);
        useCanvasStore.setState({ projects: [liveWithTimestamps] });
        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);

        // User drags a stamped node while another task completes on server (returned server doc has no node timestamps).
        const serverAfterTask = makeCanvas("c1", 3, {
            nodes: [rawNode, makeNode("n-agent", "助手新增")],
        });
        server.projects.set("c1", structuredClone(serverAfterTask) as unknown as Record<string, unknown>);
        const movedStamped = [{ ...stampedNodes[0]!, position: { x: 200, y: 300 }, updatedAt: "2026-01-03T00:00:00.000Z" } as CanvasNodeData];
        useCanvasStore.getState().updateProject("c1", { nodes: movedStamped });
        await syncLocalCanvasProjectToBackend("c1");

        expect(hasUnconfirmedCanvasEdits("c1")).toBe(false);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
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

        const afterTasks = makeCanvas("c1", 3, {
            nodes: [
                makeNode("n1", "任务1", { metadata: { status: "success", taskId: "t1", content: "/res/1.png", storageKey: "resource:1" } }),
                makeNode("n2", "任务2", { metadata: { status: "success", taskId: "t2", content: "/res/2.png", storageKey: "resource:2" } }),
                nDrag,
            ],
        });
        server.projects.set("c1", structuredClone(afterTasks) as unknown as Record<string, unknown>);

        useCanvasStore.getState().updateProject("c1", {
            nodes: [n1, n2, { ...nDrag, position: { x: 520, y: 310 } }],
        });

        await syncLocalCanvasProjectToBackend("c1");

        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].params.upsertNodes?.map((item) => item.id)).toEqual(["n-drag"]);
        expect(projectSyncProgress("c1", scope)?.phase).toBe("done");
        const liveNodes = useCanvasStore.getState().openProject("c1")!.nodes;
        expect(liveNodes.find((n) => n.id === "n1")?.metadata?.content).toBe("/res/1.png");
        expect(liveNodes.find((n) => n.id === "n2")?.metadata?.content).toBe("/res/2.png");
        expect(liveNodes.find((n) => n.id === "n-drag")?.position).toEqual({ x: 520, y: 310 });
    });

    test("刷新同字段本地胜出后，后续同 revision patch 携带 forceHistorySnapshot=true 触发后端合并前快照", async () => {
        const baseNode = makeNode("n1", "标题", { type: "text" as never, metadata: { content: "原文本", status: "success" } });
        const initial = makeCanvas("c1", 1, { nodes: [baseNode] });
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

        // User edits n1 content locally while Agent also edits n1 content on server (rev 2).
        useCanvasStore.getState().updateProject("c1", {
            nodes: [{ ...baseNode, metadata: { content: "用户本地文本", status: "success" } }],
        });
        server.projects.set("c1", structuredClone(makeCanvas("c1", 2, {
            nodes: [{ ...baseNode, metadata: { content: "Agent 文本", status: "success" } }],
        })) as unknown as Record<string, unknown>);

        await refreshLocalCanvasProjectIfChanged("c1");
        expect(useCanvasStore.getState().openProject("c1")?.nodes[0]?.metadata?.content).toBe("用户本地文本");

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].params.baseRevision).toBe(2);
        expect(server.patches[0].params.forceHistorySnapshot).toBe(true);
        expect(server.patches[0].snapshotCaptured).toBe(true);
    });

    test("旧在途 patch 回执不能清掉期间产生的重叠快照标记，重载后仍携带 forceHistorySnapshot", async () => {
        const baseNode = makeNode("n1", "标题", { type: "text" as never, metadata: { content: "原文本", status: "success" } });
        const initial = makeCanvas("c1", 1, { nodes: [baseNode] });
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

        // 1. Start an older patch (without forceHistorySnapshot) and hold it in flight.
        let releasePatch!: () => void;
        let patchStarted!: () => void;
        const patchStartedPromise = new Promise<void>((resolve) => { patchStarted = resolve; });
        server.patchHold = new Promise<void>((resolve) => { releasePatch = resolve; });
        server.onPatchStarted = () => { patchStarted(); };
        useCanvasStore.getState().updateProject("c1", { title: "编辑A" });
        const savingA = syncLocalCanvasProjectToBackend("c1");
        await patchStartedPromise;

        // 2. While A is in flight, a merge overlap occurs and user makes edit B.
        markCanvasMergeOverlap("c1", scope);
        useCanvasStore.getState().updateProject("c1", { title: "编辑B" });

        // 3. Old patch A acknowledges (it did NOT carry forceHistorySnapshot).
        server.patchHold = null;
        releasePatch();
        await savingA;
        expect(server.patches[0].params.forceHistorySnapshot).toBeUndefined();

        // 4. Simulate renderer reload (memory cleared, IndexedDB journal + live draft kept).
        const liveDraft = structuredClone(useCanvasStore.getState().openProject("c1")!);
        resetCanvasOperationJournalMemory();
        resetLocalCanvasBackendSaveState();
        clearCanvasDocumentBase("c1", scope);
        useCanvasStore.setState({ projects: [liveDraft] });

        // 5. After reload, saving B MUST still carry forceHistorySnapshot=true and trigger snapshotCaptured=true!
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.patches).toHaveLength(2);
        expect(server.patches[1].params.forceHistorySnapshot).toBe(true);
        expect(server.patches[1].snapshotCaptured).toBe(true);
    });

    test("旧 force patch A 在途期间发生新重叠 B：A 回执不会清掉 B 的 forceHistorySnapshot 标记", async () => {
        const baseNode = makeNode("n1", "标题", { type: "text" as never, metadata: { content: "原文本", status: "success" } });
        const initial = makeCanvas("c1", 1, { nodes: [baseNode] });
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

        // 1. Overlap A marks epoch 1 and kicks off force patch A, held in flight.
        markCanvasMergeOverlap("c1", scope);
        let releasePatch!: () => void;
        let patchStarted!: () => void;
        const patchStartedPromise = new Promise<void>((resolve) => { patchStarted = resolve; });
        server.patchHold = new Promise<void>((resolve) => { releasePatch = resolve; });
        server.onPatchStarted = () => { patchStarted(); };
        useCanvasStore.getState().updateProject("c1", { title: "冲突A胜出" });
        const savingA = syncLocalCanvasProjectToBackend("c1");
        await patchStartedPromise;

        // 2. While force patch A (epoch 1) is in flight, overlap B marks epoch 2 and updates live.
        markCanvasMergeOverlap("c1", scope);
        useCanvasStore.getState().updateProject("c1", { title: "冲突B胜出" });

        // 3. Force patch A acks (epoch 1 < epoch 2, so epoch 2 MUST remain active).
        server.patchHold = null;
        releasePatch();
        await savingA;
        expect(server.patches[0].params.forceHistorySnapshot).toBe(true);

        // 4. Subsequent save for B MUST STILL carry forceHistorySnapshot=true and capture snapshot!
        await syncLocalCanvasProjectToBackend("c1");
        expect(server.patches).toHaveLength(2);
        expect(server.patches[1].params.forceHistorySnapshot).toBe(true);
        expect(server.patches[1].snapshotCaptured).toBe(true);
    });

    test("markCanvasMergeOverlap 后尚未保存即刷新重载，flush 后标记已持久化到 journal", async () => {
        const baseNode = makeNode("n1", "标题", { type: "text" as never, metadata: { content: "原文本", status: "success" } });
        const initial = makeCanvas("c1", 1, { nodes: [baseNode] });
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

        // Overlap occurs on editor rebase / patch align, no backend save yet before reload.
        markCanvasMergeOverlap("c1", scope);
        useCanvasStore.getState().updateProject("c1", { title: "重载前本地胜出" });
        await flushLocalWorkspace();

        // Simulate immediate renderer reload before 500ms autosave fired.
        const liveDraft = structuredClone(useCanvasStore.getState().openProject("c1")!);
        resetCanvasOperationJournalMemory();
        resetLocalCanvasBackendSaveState();
        clearCanvasDocumentBase("c1", scope);
        useCanvasStore.setState({ projects: [liveDraft] });

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].params.forceHistorySnapshot).toBe(true);
        expect(server.patches[0].snapshotCaptured).toBe(true);
    });

    test("flushLocalWorkspace 等待期间并发新产生的 markCanvasMergeOverlap 也会被完全 drain 落盘", async () => {
        const baseNode = makeNode("n1", "标题", { type: "text" as never, metadata: { content: "原文本", status: "success" } });
        const initial = makeCanvas("c1", 1, { nodes: [baseNode] });
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

        let releaseFirstWrite!: () => void;
        let firstWriteBlocked!: () => void;
        const firstWriteBlockedPromise = new Promise<void>((resolve) => { firstWriteBlocked = resolve; });
        let writeCount = 0;
        setCanvasJournalStorageDelay({
            beforeSet: async () => {
                writeCount += 1;
                if (writeCount === 1) {
                    firstWriteBlocked();
                    await new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
                }
            },
        });

        try {
            // First overlap enters storage write and pauses.
            markCanvasMergeOverlap("c1", scope);
            await firstWriteBlockedPromise;

            // Start flush while first write is in flight, then emit a second overlap DURING flush!
            const flushing = flushLocalWorkspace();
            markCanvasMergeOverlap("c1", scope);
            useCanvasStore.getState().updateProject("c1", { title: "并发 mark 后重载" });
            releaseFirstWrite();
            await flushing;
        } finally {
            setCanvasJournalStorageDelay(null);
        }

        // Simulate immediate renderer reload: epoch 2 MUST already be persisted on disk.
        const liveDraft = structuredClone(useCanvasStore.getState().openProject("c1")!);
        resetCanvasOperationJournalMemory();
        resetLocalCanvasBackendSaveState();
        clearCanvasDocumentBase("c1", scope);
        useCanvasStore.setState({ projects: [liveDraft] });

        const reloadedJournal = await loadCanvasOperationJournal("c1", scope);
        expect(reloadedJournal.pendingForceHistorySnapshotEpoch).toBe(2);

        await syncLocalCanvasProjectToBackend("c1");
        expect(server.patches).toHaveLength(1);
        expect(server.patches[0].params.forceHistorySnapshot).toBe(true);
        expect(server.patches[0].snapshotCaptured).toBe(true);
    });

    test("冷缓存无基线时收到生成结果：合并本地节点与服务端产物，不触发暂停冲突", async () => {
        const localNode = makeNode("n-local", "本地刚建");
        useCanvasStore.setState({ projects: [makeCanvas("c1", 1, { nodes: [localNode] })] });
        const remote = makeCanvas("c1", 4, {
            nodes: [makeNode("n-gen", "后台生成", { metadata: { status: "success", content: "/res/gen.png" } })],
        });
        const adopted = await adoptServerConfirmedGenerationPatch(remote);
        expect(adopted?.nodes.map((n) => n.id).sort()).toEqual(["n-gen", "n-local"]);
        expect(projectSyncProgress("c1", scope)?.phase).not.toBe("conflict");
    });

    test("多画布 hydration 在 GET 挂起期间发生并发编辑、新建与删除时，不以旧快照覆盖实时状态", async () => {
        const c1Base = makeCanvas("c1", 1, { nodes: [makeNode("a", "A")] });
        const c2Base = makeCanvas("c2", 1, { nodes: [] });
        const c4Base = makeCanvas("c4", 1, { nodes: [makeNode("d", "D")] });
        server.projects.set("c1", structuredClone(makeCanvas("c1", 2, { nodes: [makeNode("a", "A"), makeNode("a-remote", "远端A")] })) as unknown as Record<string, unknown>);
        server.projects.set("c2", structuredClone(makeCanvas("c2", 2, { nodes: [makeNode("b", "B")] })) as unknown as Record<string, unknown>);
        server.projects.set("c4", structuredClone(c4Base) as unknown as Record<string, unknown>);

        useCanvasStore.setState({ projects: [structuredClone(c1Base), structuredClone(c2Base), structuredClone(c4Base)] });
        recordCanvasDocumentBase(structuredClone(c1Base), scope);
        recordCanvasDocumentBase(structuredClone(c2Base), scope);
        recordCanvasDocumentBase(structuredClone(c4Base), scope);

        let releaseC1!: () => void;
        let c1Started!: () => void;
        const c1StartedPromise = new Promise<void>((resolve) => { c1Started = resolve; });
        server.getGates.set("c1", new Promise<void>((resolve) => { releaseC1 = resolve; }));
        server.onGetStarted = (id) => { if (id === "c1") c1Started(); };

        const hydrating = hydrateLocalCanvasProjectsFromBackend();
        await c1StartedPromise;

        // While c1 detail GET is in flight: edit c1, create brand-new c3, and delete c4!
        useCanvasStore.getState().updateProject("c1", {
            nodes: [makeNode("a", "A"), makeNode("local-mid-flight", "挂起期间编辑")],
        });
        useCanvasStore.setState((state) => ({
            projects: [...state.projects.filter((p) => p.id !== "c4"), makeCanvas("c3", 0, { nodes: [makeNode("n3", "新建画布")] })],
        }));

        releaseC1();
        expect(await hydrating).toBe(true);

        const liveProjects = useCanvasStore.getState().projects;
        const liveC1 = liveProjects.find((p) => p.id === "c1");
        const liveC2 = liveProjects.find((p) => p.id === "c2");
        const liveC3 = liveProjects.find((p) => p.id === "c3");
        const liveC4 = liveProjects.find((p) => p.id === "c4");
        expect(liveC1?.nodes.map((n) => n.id).sort()).toEqual(["a", "a-remote", "local-mid-flight"]);
        expect(liveC2?.nodes.map((n) => n.id)).toEqual(["b"]);
        expect(liveC3?.nodes.map((n) => n.id)).toEqual(["n3"]);
        expect(liveC4).toBeUndefined();
    });
});
