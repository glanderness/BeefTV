import { expect, test } from "bun:test";

import { findDepthCaptureSourceNode, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { generationTaskStageLabel } from "@/lib/generation-task-display";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Video, title: "原视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} };
const depth: CanvasNodeData = { id: "depth", type: CanvasNodeType.Video, title: "深度动作捕捉", position: { x: 400, y: 0 }, width: 320, height: 180, metadata: { depthSourceNodeId: source.id, taskId: "depth-task" } };

test("depth result nodes retain their dedicated retry contract instead of generic video generation", () => {
    expect(isDepthCaptureResultNode(depth)).toBe(true);
    expect(findDepthCaptureSourceNode(depth, [source, depth])).toBe(source);
    expect(isDepthCaptureResultNode(source)).toBe(false);
});

test("depth task stages show the existing CPU slow-path and CUDA fallback notice", () => {
    expect(generationTaskStageLabel({ status: "running", stage: "使用 CPU 处理，可能耗时较长" })).toBe("使用 CPU 处理，可能耗时较长");
    expect(generationTaskStageLabel({ status: "running", stage: "CUDA 设备故障，改用 CPU（可能耗时较长）" })).toBe("CUDA 设备故障，改用 CPU（可能耗时较长）");
});
