import { expect, test } from "bun:test";
import type { PointerEvent as ReactPointerEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasFrameNode } from "@/components/canvas/canvas-frame-node";
import { ReusableWorkflowNode, WorkflowVideo } from "@/components/canvas/nodes/reusable-workflow-node";
import { createWorkflowInstance } from "@/lib/canvas/reusable-workflow-instance";
import type { CanvasWorkflow, WorkflowRun } from "@/services/api/canvas-workflows";

const template: CanvasWorkflow = { id: "test", name: "人物替换", description: "", createdAt: "", updatedAt: "", definition: { version: 1, nodes: [
    { id: "in", role: "input", title: "动作参考", mediaType: "video", resourceId: "old" },
    { id: "depth", role: "depth", title: "深度", mediaType: "video" },
    { id: "out", role: "generation", title: "生成结果", mediaType: "video", sourceTaskId: "source" },
], edges: [{ fromNodeId: "in", toNodeId: "depth" }, { fromNodeId: "depth", toNodeId: "out" }], outputNodeIds: ["out"] } };
const noop = () => {};

test("result model and status share one compact header without resolution", () => {
    const configured = structuredClone(template);
    configured.definition.nodes.find(node => node.id === "out")!.config = { modelOption: "channel::seedance-2.0-fast", vquality: "720p" };
    const graph = createWorkflowInstance(configured, { x: 0, y: 0 });
    const output = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "out")!;
    output.metadata!.workflowSlot!.status = "succeeded";
    const html = renderToStaticMarkup(<ReusableWorkflowNode node={output} nodes={graph.nodes} readOnly={false} onAction={async () => {}} onValue={async () => {}} onUploadBusy={noop} onError={noop} />);
    expect(html).toMatch(/justify-between[^>]*><span[^>]*><span title="Seedance 2.0 fast">Seedance 2.0 fast<\/span><\/span><span[^>]*><span>已完成<\/span><\/span><\/div>/);
    expect(html).not.toContain("720p");
});

test("workflow video starts on the poster path without mounting native controls", () => {
    const html = renderToStaticMarkup(<WorkflowVideo storageKey="resource:video" />);
    expect(html).toContain("data-workflow-video");
    expect(html).toContain("正在读取首帧");
    expect(html).toContain('aria-label="播放工作流视频"');
    expect(html).not.toContain("<video");
    expect(html).not.toContain("canvas-video-player");
});

test("input actions use explicit sources and place removal over the preview", () => {
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    const input = graph.nodes.find(node => node.metadata?.workflowSlot?.role === "input")!;
    input.metadata!.storageKey = "resource:input";
    const html = renderToStaticMarkup(<ReusableWorkflowNode node={input} nodes={graph.nodes} readOnly={false} onAction={async () => {}} onValue={async () => {}} onUploadBusy={noop} onError={noop} />);
    expect(html).toContain("从本地上传");
    expect(html).toContain("从画布中选择");
    expect(html).toMatch(/data-workflow-preview[\s\S]*class="[^"]*absolute[^"]*right-2[^"]*top-2[^"]*"[^>]*aria-label="清空/);
    expect(html).toMatch(/class="[^"]*absolute right-2 top-2[^"]*size-9[^"]*"[^>]*aria-label="清空/);
});

test("completed result is draggable as a card without a separate export button", () => {
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    const output = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "out")!;
    output.metadata!.storageKey = "resource:output";
    const html = renderToStaticMarkup(<ReusableWorkflowNode node={output} nodes={graph.nodes} readOnly={false} onAction={async () => {}} onValue={async () => {}} onUploadBusy={noop} onError={noop} onResultDrag={noop} />);
    expect(html).not.toContain("拖出到画布");
    expect(html).toContain("cursor-grab");
});

test("result drag requires a held pointer and clears preparation after external release", () => {
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    const output = graph.nodes.find(node => node.metadata?.workflowSlot?.nodeId === "out")!;
    output.metadata!.storageKey = "resource:output";
    let surface!: ReturnType<typeof ReusableWorkflowNode>;
    const dragged: string[] = [];
    function Harness() {
        surface = ReusableWorkflowNode({ node: output, nodes: graph.nodes, readOnly: false, onAction: async () => {}, onValue: async () => {}, onUploadBusy: noop, onError: noop, onResultDrag: (_event, id) => { dragged.push(id); } });
        return null;
    }
    renderToStaticMarkup(<Harness />);
    const handlers = surface!.props;
    const listeners = new Map<string, Set<() => void>>();
    const originalWindow = globalThis.window;
    const fakeWindow = {
        addEventListener: (name: string, callback: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); },
        removeEventListener: (name: string, callback: () => void) => { listeners.get(name)?.delete(callback); },
    };
    const event = (overrides = {}) => ({ button: 0, buttons: 1, pointerId: 7, clientX: 100, clientY: 100,
        target: { closest: () => null }, currentTarget: { setPointerCapture: noop }, stopPropagation: noop, preventDefault: noop, ...overrides }) as unknown as ReactPointerEvent<HTMLDivElement>;
    try {
        globalThis.window = fakeWindow as unknown as Window & typeof globalThis;
        handlers.onPointerDown(event());
        handlers.onPointerMove(event({ clientX: 120, buttons: 0 }));
        expect(dragged).toEqual([]);
        handlers.onPointerDown(event());
        for (const callback of listeners.get("pointerup") || []) callback();
        handlers.onPointerMove(event({ clientX: 120 }));
        expect(dragged).toEqual([]);
        handlers.onPointerDown(event());
        handlers.onPointerMove(event({ clientX: 120, pointerId: 8 }));
        expect(dragged).toEqual([]);
        handlers.onPointerDown(event());
        for (const callback of listeners.get("blur") || []) callback();
        handlers.onPointerMove(event({ clientX: 120 }));
        expect(dragged).toEqual([]);
        handlers.onPointerDown(event());
        handlers.onPointerMove(event({ clientX: 103 }));
        expect(dragged).toEqual([]);
        handlers.onPointerMove(event({ clientX: 120 }));
        expect(dragged).toEqual([output.id]);
        expect([...listeners.values()].every(items => items.size === 0)).toBe(true);
    } finally { globalThis.window = originalWindow; }
});

test("technical replacement completion remains visibly pending quality review", () => {
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    graph.control.metadata!.reusableWorkflow!.run = { id: "run", status: "succeeded", steps: [], outputs: [{ nodeId: "out", mediaType: "video", resourceId: "output", reviewRequired: true }] } as unknown as WorkflowRun;
    const html = renderToStaticMarkup(<ReusableWorkflowNode node={graph.control} nodes={graph.nodes} readOnly={false} onAction={async () => {}} onValue={async () => {}} onUploadBusy={noop} onError={noop} />);
    expect(html).toContain("执行完成 · 待效果验收");
    expect(html).toMatch(/data-workflow-actions[\s\S]*role="status"[^>]*class="[^"]*text-xl/);
    expect(html).not.toContain("text-2xl");
});

test("workflow header sits outside the frame and keeps its screen size", () => {
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    const html = renderToStaticMarkup(<CanvasFrameNode data={graph.frame} scale={0.25} childNodes={graph.nodes.slice(1)} isSelected={false} isDropTarget={false} readOnly onMouseDown={noop} onResize={noop} onToggleCollapsed={noop} onFolderStyleChange={noop} onTitleChange={noop} onContextMenu={noop} />);
    expect(html).toMatch(/data-canvas-frame-header[^>]*bottom-full[^>]*transform:scale\(var\(--canvas-live-inverse-scale, 4\)\)/);
    expect(html).not.toContain("data-canvas-frame-count");
});

test("workflow progress counts executable steps and presents a running command", () => {
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    graph.control.metadata!.reusableWorkflow!.run = { id: "run", status: "running", steps: [{ nodeId: "in", status: "succeeded" }, { nodeId: "depth", status: "succeeded" }, { nodeId: "out", status: "running", progress: 40, stage: "正在下载生成视频" }] } as WorkflowRun;
    const html = renderToStaticMarkup(<ReusableWorkflowNode node={graph.control} nodes={graph.nodes} readOnly={false} onAction={async () => {}} onValue={async () => {}} onUploadBusy={noop} onError={noop} onUpdate={async () => {}} />);
    expect(html).toContain('aria-label="工作流执行进度"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="70"');
    expect(html).toContain("70% · 正在下载生成视频");
    expect(html).toMatch(/aria-label="已完成步骤"[^>]*>1\/2</);
    expect(html).not.toContain("步骤 1/2");
    expect(html).not.toContain("更新实例");
    expect(html).toContain("运行中");
    const actionButtons = Array.from(html.slice(html.indexOf("data-workflow-actions")).matchAll(/<button[^>]*>/g)).map(match => match[0]);
    expect(actionButtons).toHaveLength(2);
    expect(actionButtons.map(button => button.match(/style="([^"]*)"/)?.[1])).toEqual([
        "font-size:20px;height:44px;min-width:116px", "font-size:20px;height:44px;min-width:116px",
    ]);
    expect(actionButtons.every(button => button.includes("ant-btn-lg"))).toBe(true);
    expect(html).not.toContain("重新运行");
    expect(html).not.toContain("运行将使用模型额度");
    expect(html).not.toContain("个生成步骤");
    expect(html).not.toContain("输入 ");
    expect(html).toMatch(/justify-end[^>]*data-workflow-actions/);
    expect(html).toContain("text-xl");
    expect(html).not.toContain("text-2xl");
});
