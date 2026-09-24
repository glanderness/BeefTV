import { describe, expect, test } from "bun:test";

import { CANVAS_VIDEO_PREVIEW_CAPTURE_VERSION, canvasVideoPreviewNeedsRefresh } from "../src/services/canvas-video-preview";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function videoNode(captureVersion?: number): CanvasNodeData {
    return {
        id: "video-node",
        type: CanvasNodeType.Video,
        title: "video",
        position: { x: 0, y: 0 },
        width: 400,
        height: 225,
        metadata: {
            content: "https://example.com/video.mp4",
            videoPreview: { content: "https://example.com/poster.jpg", captureVersion },
        },
    };
}

describe("canvas video preview refresh", () => {
    test("refreshes legacy posters once and keeps posters produced by the reliable capture pipeline", () => {
        expect(canvasVideoPreviewNeedsRefresh(videoNode())).toBe(true);
        expect(canvasVideoPreviewNeedsRefresh(videoNode(CANVAS_VIDEO_PREVIEW_CAPTURE_VERSION))).toBe(false);
    });
});
