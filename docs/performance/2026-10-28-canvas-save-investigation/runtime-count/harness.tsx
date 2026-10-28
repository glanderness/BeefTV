/**
 * 运行计数夹具：在真实浏览器里挂载真实的画布生命周期 + 生成钩子 + zustand 画布 store，
 * 用免费假任务驱动「进度 tick / 节点内容 tick」，让真实保存入口自己跑起来。
 *
 * 这里只负责驱动与重置；比较/保存/请求的次数由 run.ts 在构建期注入的计数器统计。
 * 不改任何产品代码，也不调用真实模型。
 */
import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useCanvasGeneration } from "../../../../web/src/pages/canvas/use-canvas-generation";
import { useCanvasProjectLifecycle } from "../../../../web/src/pages/canvas/use-canvas-project-lifecycle";
import { useCanvasHistory } from "../../../../web/src/pages/canvas/use-canvas-history";
import { canvasAppearanceForTheme } from "../../../../web/src/lib/canvas/canvas-appearance";
import { stampCanvasNodeChanges } from "../../../../web/src/lib/canvas/canvas-node-timestamps";
import { useCanvasStore, flushCanvasStorePersistence } from "../../../../web/src/stores/canvas/use-canvas-store";
import { useUserStore } from "../../../../web/src/stores/use-user-store";
import { recordConfirmedCanvasCommit } from "../../../../web/src/services/canvas-operation-journal";
import type { GenerationTask } from "../../../../web/src/services/api/task-center";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData } from "../../../../web/src/types/canvas";

const PROJECT_ID = "c1";
const NODE_COUNT = Math.max(2, Number(new URLSearchParams(location.search).get("nodes") || 300));
const noop = () => {};

function buildNodes(count: number): CanvasNodeData[] {
    return Array.from({ length: count }, (_, index) => {
        const generating = index === 0;
        return {
            id: generating ? "n0" : `n${index}`,
            type: index % 7 === 0 ? "video" : "image",
            title: `合成节点 ${index}`,
            width: 320,
            height: 200,
            position: { x: (index % 40) * 360, y: Math.floor(index / 40) * 240 },
            metadata: generating
                ? { status: "loading", taskId: "task-progress", taskProgress: 0, taskStage: "generating", prompt: "synthetic progress probe" }
                : { prompt: `合成提示词 ${index}`, content: `asset://synthetic/${index}`, storageKey: `synthetic/${index}.png`, naturalWidth: 1280, naturalHeight: 720 },
        } as unknown as CanvasNodeData;
    });
}

const project = {
    id: PROJECT_ID,
    revision: 105,
    title: "运行计数夹具",
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    nodes: buildNodes(NODE_COUNT),
    connections: [] as CanvasConnection[],
    chatSessions: [] as CanvasAssistantSession[],
    activeChatId: null,
    appearance: canvasAppearanceForTheme("dark"),
    backgroundMode: "grid",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
    directorScenes: [],
};

await useCanvasStore.persist.rehydrate();
// 假后端要返回同一份画布，否则生命周期加载会把本地节点覆盖成空文档。
await fetch("/__seed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) });
await recordConfirmedCanvasCommit(structuredClone(project) as never);
const local = structuredClone(project);
useCanvasStore.setState({ projects: [local as never], hydrated: true });
await flushCanvasStorePersistence();
useUserStore.getState().setHydrated(true);

function fakeTask(progress: number): GenerationTask {
    return {
        id: "task-progress",
        type: "canvas_image",
        status: "running",
        progress,
        stage: "generating",
        prompt: "synthetic progress probe",
        clientOperationId: "probe:n0",
        // 固定 updatedAt：让每次 tick 的变化只来自 progress/stage，便于核对计数。
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        attempts: 1,
        outputs: [],
    } as unknown as GenerationTask;
}

const counts = () => ({ ...((globalThis as unknown as { __counts?: Record<string, number> }).__counts || {}) });
const resetCounts = () => { (globalThis as unknown as { __counts?: Record<string, number> }).__counts = {}; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 时间线只记「写入/请求/守卫」这些决定保存次数的节点，避免 JSON 过大。 */
const TIMELINE_EVENTS = new Set(["store.updateProject", "store.updateProject.write", "flush.writeQueuedCanvasPersist", "indexedDb.setItem", "backend.scheduleSync", "backend.syncLocalCanvasProject", "backend.commitCanvasDocument", "sameCanvasDocument"]);

function Harness() {
    const [nodes, setNodesState] = useState<CanvasNodeData[]>([]);
    const nodesRef = useRef(nodes);
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>(value => {
        if (typeof value === "function") {
            setNodesState(current => {
                const next = stampCanvasNodeChanges(current, value(current));
                nodesRef.current = next;
                return next;
            });
            return;
        }
        const next = stampCanvasNodeChanges(nodesRef.current, value);
        nodesRef.current = next;
        setNodesState(next);
    }, []);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [canvasAppearance, setCanvasAppearance] = useState(() => canvasAppearanceForTheme("dark"));
    const [backgroundMode, setBackgroundMode] = useState<never>("grid" as never);
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const [projectLoaded, setProjectLoaded] = useState(false);
    const connectionsRef = useRef(connections);
    const chatSessionsRef = useRef(chatSessions);
    const activeChatIdRef = useRef(activeChatId);
    const viewportRef = useRef(viewport);
    const history = useCanvasHistory({
        projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo,
        setNodes, setConnections, setChatSessions, setActiveChatId,
        applyCanvasAppearance: setCanvasAppearance, setBackgroundMode: setBackgroundMode as never, setShowImageInfo,
        setSelectedNodeIds: noop, setSelectedConnectionId: noop, setContextMenu: noop,
    });
    useCanvasProjectLifecycle({
        projectId: PROJECT_ID, projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, viewport,
        nodesRef, connectionsRef, chatSessionsRef, activeChatIdRef, viewportRef, historyPausedRef: history.historyPausedRef,
        setNodes, setConnections, setChatSessions, setActiveChatId,
        setCanvasAppearance, setBackgroundMode: setBackgroundMode as never, setShowImageInfo, setViewport, setProjectLoaded,
        resetHistory: history.resetHistory, adoptExternalSnapshot: history.adoptExternalSnapshot,
        cleanupAssetImages: noop, cleanupCanvasFiles: noop,
    });
    const generation = useCanvasGeneration({ projectId: PROJECT_ID, projectLoaded: false, nodes, nodesRef, setNodes });
    const bindRef = useRef(generation.bindGenerationTask);
    bindRef.current = generation.bindGenerationTask;
    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        chatSessionsRef.current = chatSessions;
        activeChatIdRef.current = activeChatId;
        viewportRef.current = viewport;
    }, [nodes, connections, chatSessions, activeChatId, viewport]);

    useEffect(() => {
        (window as unknown as { __probe?: unknown }).__probe = {
            ready: true,
            projectLoaded: () => projectLoaded,
            async run(mode: "poll" | "content", cadenceMs: number, ticks: number) {
                // 先把被测节点复位成「生成中」，并让这一次复位自身的写入先落完，再清零计数。
                setNodes(current => current.map(node => node.id === "n0"
                    ? { ...node, metadata: { ...node.metadata, status: "loading", taskProgress: 0, taskStage: "generating" } }
                    : node));
                await sleep(1500);
                resetCounts();
                const globals = globalThis as unknown as { __timeline?: Array<[string, number]>; __recordTimeline?: boolean };
                globals.__timeline = [];
                globals.__recordTimeline = true;
                const startedAt = performance.now();
                for (let tick = 1; tick <= ticks; tick++) {
                    await sleep(cadenceMs);
                    if (mode === "poll") bindRef.current("n0", fakeTask(tick));
                    else setNodes(current => current.map(node => node.id === "n0"
                        ? { ...node, metadata: { ...node.metadata, composerContent: `tick ${tick}` } }
                        : node));
                }
                // 等两个去抖窗口（400/500ms）与后端提交收尾。
                await sleep(1600);
                globals.__recordTimeline = false;
                const timeline = (globals.__timeline || []).filter(([name]) => TIMELINE_EVENTS.has(name));
                return {
                    mode,
                    cadenceMs,
                    ticks,
                    nodes: nodesRef.current.length,
                    wallMs: Math.round(performance.now() - startedAt),
                    counts: counts(),
                    timeline,
                };
            },
        };
    }, [projectLoaded, setNodes]);

    return <div data-testid="graph">{`${projectLoaded}:${nodes.length}:${connections.length}`}</div>;
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <MemoryRouter>
            <QueryClientProvider client={new QueryClient()}>
                <App>
                    <Harness />
                </App>
            </QueryClientProvider>
        </MemoryRouter>
    </StrictMode>,
);
