import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCanvasConnectionController } from "@/pages/canvas/use-canvas-connection-controller";
import { useCanvasConnectionController as useBaseline } from "@/pages/canvas/review-baseline-controller";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType as T, type CanvasNodeData } from "@/types/canvas";

// 只渲染 hook 状态和开始按钮，未渲染画布节点、媒体与世界层。
function Harness({ baseline }: { baseline: boolean }) {
    const nodesRef = useRef<CanvasNodeData[]>([
        { id: "source", type: T.Image, title: "源", position: { x: 0, y: 0 }, width: 320, height: 180 },
        { id: "target", type: T.Image, title: "目标", position: { x: 1000, y: 0 }, width: 320, height: 180 },
    ]);
    const [connections, setConnections] = useState<any[]>([]);
    const connectionsRef = useRef(connections);
    connectionsRef.current = connections;
    const viewportRef = useRef({ x: 0, y: 0, k: 1 });
    const hook = baseline ? useBaseline : useCanvasConnectionController;
    const controller = hook({
        projectId: "independent-review", config: defaultConfig, defaultDrawingEngine: "excalidraw",
        nodesRef, connectionsRef, viewportRef, scriptScrollTopById: {},
        screenToCanvas: (x, y) => ({ x: (x - viewportRef.current.x) / viewportRef.current.k, y: (y - viewportRef.current.y) / viewportRef.current.k }),
        setNodes: value => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
        setConnections, setSelectedNodeIds() {}, setSelectedConnectionId() {}, setContextMenu() {}, setDialogNodeId() {}, setDrawingNodeId() {},
    });
    useLayoutEffect(() => {
        Object.assign(window, { reviewHook: {
            state: () => ({ edges: connections.map(e => ({ from: e.fromNodeId, to: e.toNodeId })), pending: Boolean(controller.pendingConnectionCreate), target: controller.connectionTargetNodeId, batchTarget: controller.batchConnectionPreview?.targetNodeId }),
            batch: () => flushSync(() => controller.beginBatchConnectionMode(["source"])),
            viewport: (k: number) => { viewportRef.current = { x: 0, y: 0, k }; },
        } });
    });
    return <><button id="source" onPointerDown={event => controller.handleConnectStart(event, "source", "source")}>从源端开始</button><button id="batch-source" onPointerDown={event => controller.startBatchConnection(event, ["source"])}>从批量源端开始</button></>;
}

export function mount(baseline: boolean) {
    createRoot(document.getElementById("root")!).render(<Harness baseline={baseline} />);
}
