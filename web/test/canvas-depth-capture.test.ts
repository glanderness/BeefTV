import { expect, test } from "bun:test";

import { findDepthCaptureSourceNode, isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Video, title: "原视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: {} };
const depth: CanvasNodeData = { id: "depth", type: CanvasNodeType.Video, title: "深度动作捕捉", position: { x: 400, y: 0 }, width: 320, height: 180, metadata: { depthSourceNodeId: source.id, taskId: "depth-task" } };

test("depth result nodes retain their dedicated retry contract instead of generic video generation", () => {
    expect(isDepthCaptureResultNode(depth)).toBe(true);
    expect(findDepthCaptureSourceNode(depth, [source, depth])).toBe(source);
    expect(isDepthCaptureResultNode(source)).toBe(false);
});
