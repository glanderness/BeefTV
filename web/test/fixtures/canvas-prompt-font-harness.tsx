import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppModal } from "@/components/ui/product/app-modal";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { getAntThemeConfig } from "@/lib/app-theme";
import { buildCanvasResourceReferences } from "@/lib/canvas/canvas-resource-references";
import { connectAndAppendCanvasResourceMention, useCanvasPickConnectStore } from "@/lib/canvas/canvas-text-mention";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { applySkinTheme, DEFAULT_CLASSIC_SKIN } from "@/lib/skin-themes";
import { isCanvasPointerMoving, shouldMountCanvasPromptPanel } from "@/pages/canvas/canvas-pointer-chrome";
import { useCanvasKeyboard } from "@/pages/canvas/use-canvas-keyboard";
import { useCanvasNodeClick } from "@/pages/canvas/use-canvas-node-click";
import { useCanvasPointerSelectionChrome } from "@/pages/canvas/use-canvas-pointer-chrome";
import { useCanvasSelectionController } from "@/pages/canvas/use-canvas-selection-controller";
import { createCanvasPageUiStore } from "@/stores/canvas/use-canvas-page-ui-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const modes = { image: CanvasNodeType.Image, video: CanvasNodeType.Video, audio: CanvasNodeType.Audio, text: CanvasNodeType.Text };
const mode = params.get("mode") as keyof typeof modes | null;
const imageModels = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2-high-resolution-editorial-retouch-preview", "dola-seedream-5-0-pro-260628"];
const videoModels = ["wan3.0-video", "wan3.0-video-high-resolution-cinematic-preview"];
const videoSettingsProfile = defaultModelCapabilityConfig("newapi", videoModels[0]);
videoSettingsProfile.video!.duration = { selection: "enum", values: [-1, 4, 7, 15], default: 4 };
const channel = createModelChannel({
    id: "fixture",
    name: "Fixture",
    apiKey: "fixture",
    baseUrl: "https://example.test/v1",
    models: [...imageModels, ...videoModels, "tts-1", "gpt-4o"],
    modelProfiles: [
        ...imageModels.map(model => ({ model, capability: "image" as const, protocol: "openai-image" })),
        ...videoModels.map(model => ({
            model,
            ...(model === "wan3.0-video" ? { displayName: "Seedance 2.0 Fast" } : {}),
            capability: "video" as const,
            protocol: "newapi",
            ...(params.has("video-settings") && model === videoModels[0] ? { capabilityConfig: videoSettingsProfile, videoCapabilitiesVersion: "fixture" } : {}),
            videoPricing: { currency: "CNY" as const, mode: "seconds" as const, rates: { "720p": { output: 0.35, reference_video: 0 } } },
        })),
    ],
});
const { config } = normalizeConfigSnapshot({ config: {
    ...defaultConfig,
    channels: [channel],
    imageModel: "fixture::gpt-image-2",
    videoModel: "fixture::wan3.0-video",
    audioModel: "fixture::tts-1",
    textModel: "fixture::gpt-4o",
} });
useThemeStore.getState().setTheme(dark ? "dark" : "light");
applySkinTheme(DEFAULT_CLASSIC_SKIN, dark ? "dark" : "light");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const initial: CanvasNodeData = { id: "font-preview", type: mode ? modes[mode] : CanvasNodeType.Image, title: "预览节点", width: 500, height: 300, position: { x: 0, y: 0 }, metadata: { ...(mode === "image" ? { size: "1024x1024", quality: "low" } : {}), prompt: "镜头缓缓推进，窗边的猫望向远处。保留自然光影与细节。" } };

function Harness() {
    const [node, setNode] = useState(initial);
    const [composed, setComposed] = useState("使用已连接的素材，生成温暖的场景。");
    const [nodeDeleted, setNodeDeleted] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    return <ConfigProvider theme={getAntThemeConfig(dark, DEFAULT_CLASSIC_SKIN)}><App><QueryClientProvider client={client}>
        <main style={{ padding: 12, maxWidth: 680, margin: "auto" }}>
            {params.has("keyboard-delete") ? <CanvasDeleteKeyboard node={node} onDelete={() => setNodeDeleted(true)} /> : null}
            {params.has("modal-delete") && <>
                <button onClick={() => setEditorOpen(true)}>打开编辑器</button>
                <AppModal open={editorOpen} title="编辑器" footer={null} destroyOnHidden={false} onCancel={() => setEditorOpen(false)}>
                    <textarea aria-label="字幕草稿" defaultValue="一二三" />
                    <button onClick={() => setEditorOpen(false)}>关闭编辑器</button>
                </AppModal>
            </>}
            {!nodeDeleted ? <section data-testid="node-panel" data-canvas-no-zoom style={{ width: "100%", position: "relative" }}>
                <CanvasNodePromptPanel projectId="font-test" node={node} config={mode ? config : undefined} isRunning={false} workspaceMode={mode ? "professional" : "simple"} onPromptChange={(_, prompt) => setNode(current => ({ ...current, metadata: { ...current.metadata, prompt } }))} onConfigChange={(_, patch) => setNode(current => ({ ...current, metadata: { ...current.metadata, ...patch } }))} onGenerate={() => { throw new Error("字号调节不能生成任务"); }} />
            </section> : null}
            <section data-testid="config-composer" style={{ marginTop: 24 }}>
                <CanvasConfigComposer value={composed} inputs={[]} onChange={setComposed} onClose={() => {}} workspaceMode="simple" />
            </section>
            <output hidden data-testid="prompt-value">{node.metadata?.prompt}</output>
        </main>
    </QueryClientProvider></App></ConfigProvider>;
}

const noop = () => {};
function CanvasDeleteKeyboard({ node, onDelete }: { node: CanvasNodeData; onDelete: () => void }) {
    const [pageUi] = useState(createCanvasPageUiStore);
    const nodesRef = useRef([node]);
    const [edge, setEdge] = useState(params.has("selected-edge") ? "selected-edge" : null);
    const selectedNodeIdsRef = useRef(new Set([node.id]));
    useCanvasKeyboard({
        pageUi, projectId: "font-test", nodesRef, selectedNodeIdsRef, selectedConnectionId: edge,
        setShortcutRequestNonce: noop, setInfoNodeId: noop, setCropNodeId: noop, setMaskEditNodeId: noop,
        setAnnotationNodeId: noop, saveCanvasProject: noop, zoomToActualSize: noop, fitCanvasContent: noop,
        fitCanvasSelection: noop, undoCanvas: noop, redoCanvas: noop, cancelSelectionBox: noop,
        copySelectedNodes: noop, pasteCopiedNodes: () => false, restoreCopiedNodesFromText: () => false,
        shouldPreferCopiedNodes: () => false, pasteSystemClipboard: () => false,
        deleteNodes: (ids) => { if (ids.has(node.id)) onDelete(); }, deleteConnection: id => { if (id === edge) setEdge(null); }, deselectCanvas: noop,
        zoomCanvasIn: noop, zoomCanvasOut: noop, autoArrangeCanvasNodes: noop, focusMode: false, exitFocusMode: noop,
        toggleFocusMode: noop, onOpenSearch: noop, beginBatchConnection: noop,
    });
    return edge ? <output data-testid="selected-edge">{edge}</output> : null;
}

const sourceImage: CanvasNodeData = {
    id: "pick-image", type: CanvasNodeType.Image, title: "参考图", width: 150, height: 120, position: { x: 20, y: 60 },
    metadata: { content: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='120'%3E%3Crect width='150' height='120' fill='gray'/%3E%3C/svg%3E" },
};

function PickConnectHarness() {
    const [nodes, setNodes] = useState([{ ...initial, position: { x: 220, y: 300 } }, sourceImage]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [pageUi] = useState(() => {
        const store = createCanvasPageUiStore();
        store.getState().setDialogNodeId(initial.id);
        store.getState().setSelectedNodeIds(new Set([initial.id]));
        return store;
    });
    const [target, image] = nodes;
    const dialogNodeId = pageUi(state => state.dialogNodeId);
    const selectedNodeIds = pageUi(state => state.selectedNodeIds);
    const pickTargetId = useCanvasPickConnectStore(state => state.pickConnectTargetNodeId);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    selectedNodeIdsRef.current = selectedNodeIds;
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const containerRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef({ x: 0, y: 0, k: 1 });
    const historyPausedRef = useRef(false);
    const pointerChrome = useCanvasPointerSelectionChrome({ pageUi, projectId: "pick-test", nodesRef });
    const { handleSelectedNodeClick } = useCanvasNodeClick({
        pageUi, projectId: "pick-test", nodesRef, bringNodeToFront: noop, setDrawingNodeId: noop,
        onPickConnect: (targetId, sourceId) => {
            const linked = connectAndAppendCanvasResourceMention(nodesRef.current, connections, targetId, sourceId, "pick-edge");
            setNodes(linked.nodes);
            setConnections(linked.connections);
        },
    });
    const controller = useCanvasSelectionController({
        pageUi, projectId: "pick-test", containerRef, nodesRef, viewportRef, selectedNodeIdsRef, historyPausedRef,
        screenToCanvas: (x, y) => ({ x, y }), setNodes, cancelPendingConnectionCreate: noop,
        onCanvasSelectionStart: pointerChrome.handleCanvasSelectionStart, onNodeInteractionStart: pointerChrome.handleNodeInteractionStart,
        onNodeClick: handleSelectedNodeClick, onNodeDragEnd: pointerChrome.handleNodeDragEnd, onDeselect: pointerChrome.handleCanvasDeselect,
    });
    const isNodeMoving = isCanvasPointerMoving(controller.isNodeDragging, controller.dragPreview);
    return <ConfigProvider theme={getAntThemeConfig(dark, DEFAULT_CLASSIC_SKIN)}><App><QueryClientProvider client={client}>
        <div ref={containerRef}>
            {[target, image].map(node => (
                <CanvasNode key={node.id} data={node} scale={1} isSelected={selectedNodeIds.has(node.id)} isRelated={false} isFocusRelated={false} isConnectionTarget={false} onMouseDown={controller.handleNodeMouseDown} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onTitleChange={noop} onContentChange={noop} onContextMenu={noop} />
            ))}
            {dialogNodeId === target.id && shouldMountCanvasPromptPanel(target.id, isNodeMoving, pickTargetId) ? (
                <section data-testid="node-panel" className={isNodeMoving ? "invisible" : undefined} style={{ width: 660, marginLeft: 220, position: "relative" }}>
                    <CanvasNodePromptPanel projectId="pick-test" node={target} isRunning={false} config={config} workspaceMode="professional" mentionReferences={buildCanvasResourceReferences(nodes, connections, target.id)} onPromptChange={noop} onConfigChange={noop} onGenerate={noop} />
                </section>
            ) : null}
            <output hidden data-testid="pick-result">{JSON.stringify({ prompt: target.metadata?.composerContent, position: target.position, edges: connections })}</output>
        </div>
    </QueryClientProvider></App></ConfigProvider>;
}

createRoot(document.getElementById("root")!).render(params.has("pick-connect") ? <PickConnectHarness /> : <Harness />);
