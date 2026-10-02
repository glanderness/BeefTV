import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "antd";
import { useCanvasProjectLifecycle } from "../../src/pages/canvas/use-canvas-project-lifecycle";
import { useCanvasHistory } from "../../src/pages/canvas/use-canvas-history";
import { canvasAppearanceForTheme } from "../../src/lib/canvas/canvas-appearance";
import { useCanvasStore, flushCanvasStorePersistence } from "../../src/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { recordConfirmedCanvasCommit } from "../../src/services/canvas-operation-journal";
import { syncLocalCanvasProjectToBackend } from "../../src/services/local-workspace-repository";
import type { CanvasNodeData, CanvasConnection, CanvasAssistantSession } from "../../src/types/canvas";

const noop = () => {};
const cached = { id: "c1", revision: 105, title: "Restart", createdAt: "2026-10-02", updatedAt: "2026-10-02", nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, width: 320, height: 200, position: { x: i * 400, y: 0 }, metadata: {} })), connections: [], chatSessions: [], activeChatId: null, backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
const harness = (window as any).__lifecycle = { renders: [], updates: [], media: noop, deleteEdges: noop, save: async () => {}, restartLoad: async (_remote: unknown) => {}, setSession: (ready: boolean) => useUserStore.getState().setHydrated(ready) };
const scenario = new URLSearchParams(location.search).get("scenario");
await useCanvasStore.persist.rehydrate();
if (scenario !== "missing-cache-and-journal") await recordConfirmedCanvasCommit(cached as never);
const local = structuredClone(cached);
if (scenario === "dirty-cache") local.nodes[0]!.title = "Unsaved manual title";
useCanvasStore.setState({ projects: scenario?.startsWith("missing-cache") ? [] : [local as never], hydrated: true });
await flushCanvasStorePersistence();
useUserStore.getState().setHydrated(true);
useCanvasStore.subscribe((state) => { const p = state.projects.find(p => p.id === "c1"); if (p) harness.updates.push({ edges: p.connections.length, revision: p.revision }); });

function Harness() {
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [canvasAppearance, setCanvasAppearance] = useState(() => canvasAppearanceForTheme("dark"));
    const [backgroundMode, setBackgroundMode] = useState<any>("grid");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const [projectLoaded, setProjectLoaded] = useState(false);
    const nodesRef = useRef(nodes), connectionsRef = useRef(connections), chatSessionsRef = useRef(chatSessions), activeChatIdRef = useRef(activeChatId), viewportRef = useRef(viewport);
    const history = useCanvasHistory({ projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, setNodes, setConnections, setChatSessions, setActiveChatId, applyCanvasAppearance: setCanvasAppearance, setBackgroundMode, setShowImageInfo, setSelectedNodeIds: noop, setSelectedConnectionId: noop, setContextMenu: noop });
    useCanvasProjectLifecycle({ projectId: "c1", projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, viewport, nodesRef, connectionsRef, chatSessionsRef, activeChatIdRef, viewportRef, historyPausedRef: history.historyPausedRef, setNodes, setConnections, setChatSessions, setActiveChatId, setCanvasAppearance, setBackgroundMode, setShowImageInfo, setViewport, setProjectLoaded, resetHistory: history.resetHistory, adoptExternalSnapshot: history.adoptExternalSnapshot, cleanupAssetImages: noop, cleanupCanvasFiles: noop });
    useLayoutEffect(() => { nodesRef.current = nodes; connectionsRef.current = connections; chatSessionsRef.current = chatSessions; activeChatIdRef.current = activeChatId; viewportRef.current = viewport; }, [nodes, connections, chatSessions, activeChatId, viewport]);
    useEffect(() => { harness.renders.push({ nodes: nodes.length, edges: connections.length, projectLoaded }); });
    harness.media = () => setNodes(current => current.map((node, i) => i === 1 ? { ...node, width: node.width + 1 } : node));
    harness.restartLoad = async (remote: unknown) => { await recordConfirmedCanvasCommit(remote as never); useCanvasStore.setState({ projects: [remote as never] }); useUserStore.getState().setHydrated(false); harness.media(); };
    harness.deleteEdges = () => setConnections([]);
    harness.save = async () => { await flushCanvasStorePersistence(); await syncLocalCanvasProjectToBackend("c1"); };
    return <div data-testid="graph">{`${projectLoaded}:${nodes.length}:${connections.length}`}</div>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><App><Harness /></App></MemoryRouter>);
