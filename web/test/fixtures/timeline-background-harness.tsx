import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { CanvasTimelineDialog } from "../../src/components/canvas/canvas-timeline-dialog";
import { useCanvasAssembledNode } from "../../src/pages/canvas/use-canvas-assembled-node";
import { TaskResultMedia } from "../../src/pages/tasks/task-result-media";
import type { CanvasNodeData } from "../../src/types/canvas";
import type { TimelineProject } from "../../src/types/timeline";

const timeline: TimelineProject = {
    version: 2, durationMs: 6000, output: { width: 720, height: 1280, fps: 24 },
    tracks: ["video", "voice", "bgm", "subtitle"].map((id, order) => ({ id, kind: id === "subtitle" ? "subtitle" : id === "video" ? "video" : "audio", label: id, order })),
    clips: ["video", "voice", "bgm"].map(id => ({
        id, nodeId: id, trackId: id, kind: id === "video" ? "video" : "audio", startMs: 0, durationMs: 6000,
        sourceStartMs: 200, volume: id === "bgm" ? 0.2 : 1,
        directMedia: { id, kind: id === "video" ? "video" : "audio", title: id, storageKey: `resource:source-${id}` },
    })),
};
timeline.clips.push({ id: "sub", nodeId: "sub", trackId: "subtitle", kind: "subtitle", startMs: 500, durationMs: 1000, text: "中文字幕" });
const receipt = { nodes: [] as CanvasNodeData[], saved: [] as unknown[], progress: [] as string[], uploads: 0 };
function Harness() {
    const [target, setTarget] = useState({ canvasId: "canvas-a", nodeId: "timeline-a", open: true, mounted: true });
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [result, setResult] = useState({ value: JSON.stringify({ resourceId: "render-result", fileName: "timeline.mp4", video: { resourceId: "render-result" } }), status: "succeeded" });
    const create = useCanvasAssembledNode({
        canvasId: target.canvasId, getCanvasCenter: () => ({ x: 500, y: 500 }), setNodes,
        selectInsertedNode: () => {},
        persistMediaNode: async (node, signal) => {
            receipt.saved.push(node);
            const response = await fetch("/fixture/persist", { method: "POST", body: JSON.stringify(node), signal });
            return response.ok;
        },
        startUploadStatus: () => ({ update: () => {}, done: detail => receipt.progress.push(detail || ""), fail: detail => receipt.progress.push(detail || "") }),
    });
    receipt.nodes = nodes;
    Object.assign(window, { timelineBackground: {
        receipt, timeline,
        target: (patch: Partial<typeof target>) => setTarget(current => ({ ...current, ...patch })),
        result: setResult,
    } });
    if (location.search.includes("result")) return <TaskResultMedia value={result.value} status={result.status} taskType="timeline_render" />;
    const node = { id: target.nodeId, type: "video", title: "测试成片", position: { x: 0, y: 0 }, width: 320, height: 180 } as CanvasNodeData;
    return target.mounted ? <CanvasTimelineDialog canvasId={target.canvasId} node={node} nodes={nodes} timeline={timeline} open={target.open}
        onClose={() => setTarget(current => ({ ...current, mounted: false }))} onSave={() => {}} onSaveSubtitles={() => {}}
        onUploadLocalFiles={async () => { receipt.uploads++; return []; }} onCreateAssembledNode={create} /> : null;
}
createRoot(document.getElementById("root")!).render(<App><Harness /></App>);
