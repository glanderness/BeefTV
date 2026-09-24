import { describe, expect, test } from "bun:test";

import { exportCanvasMedia, type CanvasMediaExportDependencies } from "@/services/desktop-media-export";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function mediaNode(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "video-1",
        type: CanvasNodeType.Video,
        title: "一只水牛在雨中徒步",
        position: { x: 0, y: 0 },
        width: 1280,
        height: 720,
        metadata: {
            content: "blob:wails://wails/stale-session-url",
            storageKey: "resource:resource-video-1",
            mimeType: "video/mp4",
            status: "success",
        },
        ...overrides,
    };
}

describe("desktop canvas media export", () => {
    test("exports by stable resource id without using stale node content", async () => {
        const calls: Array<{ resourceId: string; fileName: string }> = [];
        const dependencies: CanvasMediaExportDependencies = {
            desktopExport: async (resourceId, fileName) => {
                calls.push({ resourceId, fileName });
                return { canceled: false, path: `/exports/${fileName}` };
            },
            readBlob: async () => { throw new Error("desktop export must not read the stale URL"); },
            saveBlob: () => { throw new Error("desktop export must not use browser download"); },
        };

        const result = await exportCanvasMedia(mediaNode(), "雨中漫步", dependencies);

        expect(result.status).toBe("exported");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.resourceId).toBe("resource-video-1");
        expect(calls[0]?.fileName).toMatch(/^雨中漫步_一只水牛在雨中徒步_\d{8}\.mp4$/);
    });

    test("reports directory selection cancellation without browser fallback", async () => {
        let browserSaved = false;
        const result = await exportCanvasMedia(mediaNode(), "画布", {
            desktopExport: async () => ({ canceled: true, path: "" }),
            readBlob: async () => null,
            saveBlob: () => { browserSaved = true; },
        });

        expect(result).toEqual({ status: "canceled" });
        expect(browserSaved).toBe(false);
    });

    test("uses the stored Blob when no desktop binding is available", async () => {
        const blob = new Blob(["image-bytes"], { type: "image/png" });
        const saved: Array<{ blob: Blob; fileName: string }> = [];
        const node = mediaNode({
            type: CanvasNodeType.Image,
            title: "关键帧",
            metadata: { content: "https://example.invalid/stale.png", storageKey: "image:local:1", mimeType: "image/png" },
        });

        const result = await exportCanvasMedia(node, "画布", {
            readBlob: async () => blob,
            saveBlob: (value, fileName) => saved.push({ blob: value, fileName }),
        });

        expect(result.status).toBe("exported");
        expect(saved[0]?.blob).toBe(blob);
        expect(saved[0]?.fileName).toMatch(/^画布_关键帧_\d{8}\.png$/);
    });
});
