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
import { applyGenerationConsumerEffect } from "../../src/services/generation-consumer-dedupe";
import { attachNodeEffectKey } from "../../src/services/generation-task-materializer";
import { hasUnconfirmedCanvasEdits } from "../../src/services/local-workspace-repository";
import { syncLocalCanvasProjectToBackend } from "../../src/services/local-workspace-repository";
import { refreshLocalCanvasProjectIfChanged } from "../../src/services/local-workspace-repository";
import { getActiveUserScope, setActiveUserScope } from "../../src/lib/user-scope";
import type { CanvasNodeData, CanvasConnection, CanvasAssistantSession } from "../../src/types/canvas";

const noop = () => {};
const cached = (window as any).__reopenProject ?? { id: "c1", revision: 105, title: "Restart", createdAt: "2026-10-02", updatedAt: "2026-10-02", nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, type: "image", title: `Node ${i}`, width: 320, height: 200, position: { x: i * 400, y: 0 }, metadata: {} })), connections: [], chatSessions: [], activeChatId: null, appearance: canvasAppearanceForTheme("dark"), backgroundMode: "grid", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, directorScenes: [] };
const harness = (window as any).__lifecycle = { renders: [], updates: [], media: noop, deleteEdges: noop, save: async () => {}, restartLoad: async (_remote: unknown) => {}, setSession: (ready: boolean) => useUserStore.getState().setHydrated(ready) };
const scenario = new URLSearchParams(location.search).get("scenario");
await useCanvasStore.persist.rehydrate();
if (scenario !== "missing-cache-and-journal") await recordConfirmedCanvasCommit(cached as never);
const local = structuredClone(cached);
if (scenario === "dirty-cache") local.nodes[0]!.title = "Unsaved manual title";
if (scenario === "startup-stamp") local.nodes[0]!.metadata = applyGenerationConsumerEffect(local.nodes[0]!.metadata || {}, attachNodeEffectKey("completed-task-receipt", "n0", 0), metadata => metadata).value;
useCanvasStore.setState({ projects: scenario?.startsWith("missing-cache") ? [] : [local as never], hydrated: true });
await flushCanvasStorePersistence();
useUserStore.getState().setHydrated(true);
useCanvasStore.subscribe((state) => { const p = state.projects.find(p => p.id === "c1"); if (p) harness.updates.push({ edges: p.connections.length, revision: p.revision }); });

function Harness() {
    const [projectId, setProjectId] = useState("c1");
    (harness as any).switchCanvas = setProjectId;
    (harness as any).scopeCycle = () => { const scope = getActiveUserScope(); setActiveUserScope("leave-owner-b"); setActiveUserScope(scope); };
    const [, unrelatedRender] = useState(0);
    (harness as any).pulse = () => new Promise<void>(resolve => {
        let count = 0;
        const timer = setInterval(() => {
            unrelatedRender(value => value + 1);
            if (++count === 17) { clearInterval(timer); resolve(); }
        }, 50);
    });
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
    useCanvasProjectLifecycle({ projectId, projectLoaded, nodes, connections, chatSessions, activeChatId, canvasAppearance, backgroundMode, showImageInfo, viewport, nodesRef, connectionsRef, chatSessionsRef, activeChatIdRef, viewportRef, historyPausedRef: history.historyPausedRef, setNodes, setConnections, setChatSessions, setActiveChatId, setCanvasAppearance, setBackgroundMode, setShowImageInfo, setViewport, setProjectLoaded, resetHistory: history.resetHistory, adoptExternalSnapshot: history.adoptExternalSnapshot, cleanupAssetImages: noop, cleanupCanvasFiles: noop });
    useLayoutEffect(() => { nodesRef.current = nodes; connectionsRef.current = connections; chatSessionsRef.current = chatSessions; activeChatIdRef.current = activeChatId; viewportRef.current = viewport; }, [nodes, connections, chatSessions, activeChatId, viewport]);
    useEffect(() => { harness.renders.push({ nodes: nodes.length, edges: connections.length, projectLoaded }); });
    (harness as any).dirty = () => hasUnconfirmedCanvasEdits("c1");
    (harness as any).hydrateCompletedTaskStamp = () => {
        // A completed task already has its media bound. Recovery records only the
        // consumer acknowledgement, before the editor sees the same store graph.
        const effectKey = attachNodeEffectKey("completed-task-receipt", "n0", 0);
        const next = nodesRef.current.map(node => node.id === "n0" ? { ...node,
            metadata: applyGenerationConsumerEffect(node.metadata || {}, effectKey, metadata => metadata).value } : node);
        useCanvasStore.getState().updateProject("c1", { nodes: next });
        nodesRef.current = next;
        setNodes(next);
        return effectKey;
    };
    harness.media = () => setNodes(current => current.map((node, i) => i === 1 ? { ...node, width: node.width + 1 } : node));
    harness.restartLoad = async (remote: unknown) => { await recordConfirmedCanvasCommit(remote as never); useCanvasStore.setState({ projects: [remote as never] }); useUserStore.getState().setHydrated(false); harness.media(); };
    harness.deleteEdges = () => setConnections([]);
    (harness as any).editTitle = () => setNodes(current => current.map(node => node.id === "n0" ? { ...node, title: "Local unsaved text" } : node));
    (harness as any).title = () => nodesRef.current.find(node => node.id === "n0")?.title;
    (harness as any).refresh = () => refreshLocalCanvasProjectIfChanged(projectId);
    harness.save = async () => { await flushCanvasStorePersistence(); await syncLocalCanvasProjectToBackend("c1"); };
    return <div data-testid="graph">{`${projectLoaded}:${nodes.length}:${connections.length}`}</div>;
}
function MountController() {
    const [mounted, setMounted] = useState(true);
    (harness as any).unmount = () => setMounted(false);
    return mounted ? <Harness /> : <div data-testid="unmounted">Left canvas</div>;
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><App><MountController /></App></MemoryRouter>);
