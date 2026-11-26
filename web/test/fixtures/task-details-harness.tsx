import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { useCanvasActiveTasks } from "@/pages/canvas/use-canvas-active-tasks";
import { CanvasNodeErrorContent } from "@/components/canvas/canvas-node-error-content";
import { canvasThemes } from "@/lib/canvas-theme";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useTaskDetails } from "../../src/hooks/use-task-details";

function Harness() {
    const [id, setId] = useState<string>();
    const query = useTaskDetails(id, "test-canvas");
    return <>
        {["a", "b", "local:legacy"].map((value) => <button key={value} onClick={() => setId(value)}>{value}</button>)}
        <button onClick={() => setId(undefined)}>close</button>
        <button onClick={() => window.dispatchEvent(new CustomEvent("canvas:task-cancelled", { detail: { task: { ...query.data?.task, id, status: "cancelled", completedAt: "2026-09-29T15:00:03Z" } } }))}>cancel event</button>
        <pre id="snapshot">{JSON.stringify({ id, data: query.data, loading: query.isLoading, error: query.isError })}</pre>
    </>;
}

const panelNode = (id: string, taskId?: string, parentId?: string): CanvasNodeData => ({
    id, type: CanvasNodeType.Video, parentId, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { taskId },
});
const failedNode: CanvasNodeData = {
    ...panelNode("recovery-node", "recovery-task"),
    metadata: {
        taskId: "recovery-task", taskStatus: "failed", status: "error", generationErrorCode: "download_failed",
        taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "provider_result_pending" },
    },
};
const fixtureNodes: CanvasNodeData[] = [
    panelNode("live-node", "live"),
    panelNode("succeed-node", "succeed"),
    panelNode("fail-node", "fail"),
    panelNode("cancel-node", "cancel"),
    { ...panelNode("workflow"), type: CanvasNodeType.Workflow },
    panelNode("child", "child-task", "workflow"),
    failedNode,
    ...Array.from({ length: 34 }, (_, index) => panelNode(`queued-node-${index}`)),
];

function PanelHarness() {
    const tasks = useCanvasActiveTasks("test-canvas", true);
    const [nodes, setNodes] = useState(fixtureNodes);
    const [located, setLocated] = useState("");
    const [retrieved, setRetrieved] = useState("");
    const deleteNode = (id: string) => setNodes(current => removeCanvasNodes(current, new Set([id])).nodes);
    return <>
        <button onClick={() => deleteNode("live-node")}>删除视频节点</button>
        <button onClick={() => deleteNode("workflow")}>删除工作流画框</button>
        <button onClick={() => void tasks.refetch()}>读取最新任务</button>
        <CanvasActiveTaskPanel tasks={tasks.tasks} nodes={nodes} onLocateNode={setLocated}
            refreshFailed={tasks.refreshFailed} refreshing={tasks.refreshing} onRefresh={() => void tasks.refetch()} />
        <CanvasNodeErrorContent node={failedNode} theme={canvasThemes.dark}
            onReloadResource={(node) => setRetrieved(node.metadata?.taskId ?? "")} />
        <output aria-label="定位结果">{located}</output>
        <output aria-label="取回任务">{retrieved}</output>
    </>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}>{location.search === "?panel" ? <PanelHarness /> : <Harness />}</QueryClientProvider>);
