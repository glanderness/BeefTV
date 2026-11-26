import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClientProvider } from "@tanstack/react-query";
import { UpscaleNodePanel } from "../../src/components/canvas/nodes/upscale-node";
import { CanvasNodePanelOverlay } from "@/components/canvas/canvas-workspace-overlays";
import { CanvasNodeGraphContext } from "@/components/canvas/canvas-node-graph-context";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { useCanvasUpscaleBatch } from "../../src/pages/canvas/use-canvas-upscale-batch";
import { createDefaultUpscaleSettings } from "../../src/lib/canvas/canvas-upscale";
import { appQueryClient } from "../../src/lib/query-client";
import { canvasThemes } from "@/lib/canvas-theme";
import { setActiveUserScope } from "@/lib/user-scope";
import { createModelChannel, useConfigStore } from "../../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../../src/types/canvas";
import { createCanvasPageUiStore } from "../../src/stores/canvas/use-canvas-page-ui-store";
const pageUi = createCanvasPageUiStore();

setActiveUserScope("upscale-confirmation-test");
useConfigStore.setState(state => ({ config: { ...state.config, channels: [createModelChannel({ id: "beeftv", pinned: true, enabled: true, credentialRef: "beeftv", baseUrl: "https://beeftv.app", models: [] })] } }));

function Harness() {
    const query = new URLSearchParams(location.search);
    const video = query.has("video");
    const overview = query.has("overview");
    const [scale, setScale] = useState(overview ? 0.1 : 1);
    const [open, setOpen] = useState(!overview);
    const containerRef = useRef<HTMLDivElement>(null);
    const [nodes, setNodes] = useState<CanvasNodeData[]>([
        { id: "source", title: "原图", type: video ? CanvasNodeType.Video : CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "success", storageKey: "resource:owned-source", naturalWidth: video ? 1920 : 1024, naturalHeight: video ? 1080 : 1024 } },
        ...(query.has("mixed") ? [{ id: "extra", type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 1920, height: 1080, metadata: { content: "https://example.test/video.mp4" } }] : []),
        { id: "processor", type: CanvasNodeType.Upscale, position: { x: 0, y: 0 }, width: overview ? 720 : 360, height: overview ? 405 : 200, metadata: { upscale: createDefaultUpscaleSettings() } },
    ]);
    const [connections, setConnections] = useState<CanvasConnection[]>([{ id: "edge", fromNodeId: "source", toNodeId: "processor" }, ...(query.has("mixed") ? [{ id: "extra-edge", fromNodeId: "extra", toNodeId: "processor" }] : [])]);
    const [error, setError] = useState("");
    const [observed, setObserved] = useState("");
    const nodesRef = useRef(nodes); nodesRef.current = nodes;
    const connectionsRef = useRef(connections); connectionsRef.current = connections;
    const { startUpscaleBatch } = useCanvasUpscaleBatch({ pageUi, projectId: "upscale-canvas", nodes, nodesRef, connectionsRef, setNodes, setConnections, observeTask: (task, nodeId) => {
        setObserved(task.id);
        if (task.status === "failed") setNodes(current => current.map(node => node.id === nodeId
            ? { ...node, metadata: { ...node.metadata, status: "error", taskStatus: task.status, taskOutcome: task.outcome } }
            : node));
    } });
    const processor = nodes.find(node => node.id === "processor")!;
    return <>
        <CanvasNodeGraphContext.Provider value={{ getUpstreamNodes: () => nodes.filter(node => node.id === "source" || node.id === "extra"), getNode: id => nodes.find(node => node.id === id) }}>
            <CanvasNodeActionContext.Provider value={{ updateMetadata: (id, patch) => setNodes(current => current.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, ...patch } } : node)), prepareUpscaleResource: async source => source.id === "source" ? "owned-source" : "prepared-source", startUpscaleBatch: async (node, quotes) => { try { await startUpscaleBatch(node, quotes); } catch (cause) { setError(String(cause)); throw cause; } } }}>
                <style>{`[data-canvas-node-panel] { position: absolute; }`}</style>
                <button type="button" onClick={() => setScale(0.5)}>测试缩放画布</button>
                <button type="button" onClick={() => setNodes(current => current.filter(node => node.id === "source" || node.id === "processor" || node.id === "extra"))}>测试删除结果</button>
                <div ref={containerRef} style={{ position: "relative", height: 540 }}>
                    <div id="world-card" data-node-id={processor.id} onClick={() => setOpen(true)}
                        style={{ width: processor.width, height: processor.height, position: "absolute", transform: `scale(${scale})`, transformOrigin: "top left" }} />
                    {open ? <CanvasNodePanelOverlay node={processor} viewport={{ x: 0, y: 0, k: scale }} containerRef={containerRef}
                        panelHeight={164} panelMinWidth={300} panelMaxWidth={420} keepBelowNode>
                        <UpscaleNodePanel node={processor} theme={canvasThemes.light} />
                    </CanvasNodePanelOverlay> : null}
                </div>
            </CanvasNodeActionContext.Provider>
        </CanvasNodeGraphContext.Provider>
        <pre id="snapshot" style={{ marginTop: 200 }}>{JSON.stringify({ nodes, observed, error })}</pre>
    </>;
}
createRoot(document.getElementById("root")!).render(<ConfigProvider><App><QueryClientProvider client={appQueryClient}><Harness /></QueryClientProvider></App></ConfigProvider>);
