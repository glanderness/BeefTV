import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { useCanvasConnectionController } from "@/pages/canvas/use-canvas-connection-controller";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

/**
 * 真实控制器落点回归的夹具：只挂 `useCanvasConnectionController`，不渲染画布节点、媒体与
 * 世界层。事件走真实的 `pointerdown → pointermove → rAF → pointerup` 序列，因此判定经过
 * 控制器自己的落点查询与松手分支，而不是测试里另写一遍的等价表达式。
 *
 * 画布固定为两张图片：源 `(0,0)-(320,180)`，目标 `(1000,0)-(320,180)`。100% 缩放时目标
 * 左输入端锚点在 `(1000, 90)`，吸附半径为 56 世界像素。
 */
export function mountConnectionDropHarness(element: HTMLElement) {
    function Harness() {
        const nodesRef = useRef<CanvasNodeData[]>([
            { id: "source", type: CanvasNodeType.Image, title: "源", position: { x: 0, y: 0 }, width: 320, height: 180 },
            { id: "target", type: CanvasNodeType.Image, title: "目标", position: { x: 1000, y: 0 }, width: 320, height: 180 },
        ]);
        const [connections, setConnections] = useState<CanvasConnection[]>([]);
        const connectionsRef = useRef(connections);
        connectionsRef.current = connections;
        const viewportRef = useRef<ViewportTransform>({ x: 0, y: 0, k: 1 });
        const controller = useCanvasConnectionController({
            projectId: "connection-drop-test",
            config: defaultConfig,
            defaultDrawingEngine: "excalidraw",
            nodesRef,
            connectionsRef,
            viewportRef,
            scriptScrollTopById: {},
            screenToCanvas: (clientX, clientY) => ({ x: (clientX - viewportRef.current.x) / viewportRef.current.k, y: (clientY - viewportRef.current.y) / viewportRef.current.k }),
            setNodes: (value) => { nodesRef.current = typeof value === "function" ? value(nodesRef.current) : value; },
            setConnections,
            setSelectedNodeIds() {},
            setSelectedConnectionId() {},
            setContextMenu() {},
            setDialogNodeId() {},
            setDrawingNodeId() {},
        });
        useLayoutEffect(() => {
            Object.assign(window, {
                connectionDrop: {
                    state: () => ({
                        edges: connections.map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId })),
                        target: controller.connectionTargetNodeId,
                        batchTarget: controller.batchConnectionPreview?.targetNodeId ?? null,
                        pending: Boolean(controller.pendingConnectionCreate),
                    }),
                    viewport: (k: number) => { viewportRef.current = { x: 0, y: 0, k }; },
                },
            });
        });
        return (
            <>
                <button id="source" onPointerDown={(event) => controller.handleConnectStart(event, "source", "source")}>从源端开始</button>
                <button id="batch-source" onPointerDown={(event) => controller.startBatchConnection(event, ["source"])}>从批量源端开始</button>
            </>
        );
    }
    createRoot(element).render(<Harness />);
}
