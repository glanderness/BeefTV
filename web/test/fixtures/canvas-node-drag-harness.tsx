import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasNode } from '@/components/canvas/canvas-node';
import { applyCanvasLiveViewport } from '@/lib/canvas/canvas-live-viewport';
import { useCanvasSelectionController } from '@/pages/canvas/use-canvas-selection-controller';
import { CanvasNodeType, type CanvasNodeData } from '@/types/canvas';
import { createCanvasPageUiStore } from "../../src/stores/canvas/use-canvas-page-ui-store";

const noop = () => {};
// 仅挂载内存中的测试节点，不登录、不读写用户画布或调用模型。
export function mountNodeDragHarness(host: HTMLElement, options: { locked?: boolean; readOnly?: boolean } = {}) {
    function Harness() {
        const [nodes, setNodes] = useState<CanvasNodeData[]>([{ id: 'drag-test', type: CanvasNodeType.Html, title: '分镜表测试', position: { x: 100, y: 100 }, width: 800, height: 500, metadata: { content: '<html><body style="background:#222;color:white;height:1600px"><h2>分镜表</h2><table><tr><th>切</th><th>画面</th></tr><tr><td>f1</td><td>测试画面</td></tr></table></body></html>' } }]);
        const nodesRef = useRef(nodes);
        nodesRef.current = nodes;
        const containerRef = useRef<HTMLDivElement>(null);
        const viewportRef = useRef({ x: 0, y: 0, k: 1 });
        // 和画布页一样：每次挂载各持一份界面状态，选中从 store 读。
        const [pageUi] = useState(createCanvasPageUiStore);
        const selected = pageUi((state) => state.selectedNodeIds);
        const selectedNodeIdsRef = useRef(selected);
        selectedNodeIdsRef.current = selected;
        const historyPausedRef = useRef(false);
        const ctrl = useCanvasSelectionController({ pageUi, projectId: "canvas", containerRef, nodesRef, viewportRef, selectedNodeIdsRef, historyPausedRef, screenToCanvas: (x, y) => ({ x, y }), setNodes, cancelPendingConnectionCreate: noop, onCanvasSelectionStart: noop, onNodeInteractionStart: noop, onNodeClick: noop, onDeselect: noop });
        return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
            <output id="drag-position">{JSON.stringify(nodes[0].position)}</output>
            <CanvasNode data={{ ...nodes[0], metadata: { ...nodes[0].metadata, locked: options.locked } }} readOnly={options.readOnly} scale={1} isSelected={selected.has(nodes[0].id)} isRelated={false} isFocusRelated={false} isConnectionTarget={false} dragOffset={ctrl.dragPreview ?? undefined} onMouseDown={ctrl.handleNodeMouseDown} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onTitleChange={noop} onContentChange={noop} onContextMenu={noop} />
        </div>;
    }
    const root = createRoot(host);
    root.render(<Harness />);
    return () => root.unmount();
}

export function mountNodeTitleHarness(
    host: HTMLElement,
    options: { image?: boolean; maskEditActive?: boolean; x?: number; scale?: number; selected?: boolean; readOnly?: boolean; locked?: boolean; error?: boolean } = {},
) {
    function Harness() {
        const scale = options.scale ?? 1;
        const metadata = options.error
            ? { status: 'error' as const, error: '生成超时', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', locked: options.locked }
            : options.locked ? { locked: true } : undefined;
        const [node, setNode] = useState<CanvasNodeData>({ id: 'title-test', type: options.image ? CanvasNodeType.Image : CanvasNodeType.Text, title: '原名称', position: { x: options.x ?? 100, y: 100 }, width: 320, height: 240, metadata });
        const [commits, setCommits] = useState(0);
        const [previews, setPreviews] = useState(0);
        const [drags, setDrags] = useState(0);
        const viewportRef = useRef<HTMLDivElement>(null);
        useEffect(() => {
            applyCanvasLiveViewport(viewportRef.current, { x: 0, y: 0, k: scale }, false);
        }, [scale]);
        return <div ref={viewportRef} data-canvas-viewport style={{ position: 'absolute', inset: 0, overflow: 'hidden', '--canvas-committed-scale': String(scale) } as React.CSSProperties}>
            <div data-testid="canvas-background" onMouseDown={(event) => event.preventDefault()} style={{ position: 'absolute', inset: 0 }} />
            <output data-testid="saved-title">{node.title}</output>
            <output data-testid="commits">{commits}</output>
            <output data-testid="previews">{previews}</output>
            <output data-testid="drags">{drags}</output>
            <div data-canvas-world-layer style={{ position: 'absolute', top: 0, left: 0, transformOrigin: '0 0' }}>
                <div style={{ position: 'absolute', top: 0, left: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
                    <CanvasNode data={node} scale={scale} readOnly={options.readOnly} maskEditActive={options.maskEditActive} showImageInfo={false} isSelected={Boolean(options.selected)} isRelated={false} isFocusRelated={false} isConnectionTarget={false} onMouseDown={() => setDrags((count) => count + 1)} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onTitleChange={(_id, title) => { setNode((current) => ({ ...current, title })); setCommits((count) => count + 1); }} onViewImage={() => setPreviews((count) => count + 1)} onContentChange={noop} onContextMenu={noop} />
                </div>
            </div>
        </div>;
    }
    const root = createRoot(host);
    root.render(<Harness />);
    return () => root.unmount();
}
