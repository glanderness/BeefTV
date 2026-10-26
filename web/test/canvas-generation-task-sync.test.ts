import { describe, expect, test } from "bun:test";

import { applyGeneratedMediaResultMetadata, applyRecoveredGenerationTaskResultToNodes, buildGenerationTaskNodeResult, videoMetadata, type GenerationResultMediaIO } from "@/lib/canvas/canvas-generation-task-sync";
import { CANVAS_VIDEO_PREVIEW_VERSION } from "@/services/canvas-video-preview";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function videoNode(assetId: string, storageKey: string): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Video,
        title: "镜头",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { assetId, storageKey, content: "https://example.test/old.mp4", prompt: "旧提示词" },
    };
}

describe("applyGeneratedMediaResultMetadata", () => {
    test("clears the previous asset binding when a regenerated media result lands", () => {
        const node = videoNode("asset-old", "video:old");
        const next = applyGeneratedMediaResultMetadata(node, videoMetadata({
            url: "https://example.test/new.mp4",
            storageKey: "video:new",
            width: 1280,
            height: 720,
            bytes: 12,
            mimeType: "video/mp4",
            durationMs: 4000,
        }), { prompt: "新提示词" });

        expect(next.assetId).toBeUndefined();
        expect(next.storageKey).toBe("video:new");
        expect(next.content).toBe("https://example.test/new.mp4");
        expect(next.prompt).toBe("新提示词");
        expect(next.status).toBe("success");
    });
});

describe("recovered generation task results", () => {
    test("repairs the original text node and stamps the durable attach effect", async () => {
        const node: CanvasNodeData = {
            id: "text-node",
            type: CanvasNodeType.Text,
            title: "说明文字",
            position: { x: 10, y: 20 },
            width: 320,
            height: 180,
            metadata: { taskId: "task-1", status: "loading", taskStatus: "running", composerContent: "新提示词", prompt: "新提示词" },
        };
        const task = {
            id: "task-1",
            type: "canvas_text",
            status: "succeeded",
            resultJson: JSON.stringify({ text: "恢复后的结果" }),
            prompt: "新提示词",
            clientContext: { nodeId: "text-node" },
        } as never;

        const result = await applyRecoveredGenerationTaskResultToNodes([node], task, node.id);

        expect(result.nodes).toHaveLength(1);
        expect(result.node?.id).toBe(node.id);
        expect(result.node?.metadata?.content).toBe("恢复后的结果");
        expect(result.node?.metadata?.composerContent).toBe("新提示词");
        expect(result.node?.metadata?.status).toBe("success");
        expect(result.node?.metadata?.taskStatus).toBe("succeeded");
        expect(result.node?.metadata?.generationEffectKeys).toContain(result.effectKey);
    });
});

function generatedVideoTask(result: unknown) {
    return {
        id: "task-video",
        type: "canvas_video",
        status: "succeeded",
        prompt: "镜头",
        resultJson: JSON.stringify(result),
        clientContext: { nodeId: "node-1" },
    } as never;
}

function generatedVideoIO(overrides: Partial<GenerationResultMediaIO> = {}) {
    const captured: Array<{ storageKey?: string; content: string }> = [];
    const io: GenerationResultMediaIO = {
        resolveImageUrl: async () => "",
        uploadImage: async () => {
            throw new Error("首帧应当沿用已有的取帧与上传通道，而不是在同步层重新上传");
        },
        resolveMediaUrl: async () => "blob:http://127.0.0.1/result-video",
        storeGeneratedVideo: async () => {
            throw new Error("结果带 storageKey 时复用已有资源，不应再次上传");
        },
        storeGeneratedAudio: async () => {
            throw new Error("视频任务不应写音频");
        },
        captureVideoPreview: async (media) => {
            captured.push(media);
            return { url: "/api/resources/poster/file", storageKey: "resource:poster", width: 400, height: 225, bytes: 30, mimeType: "image/jpeg" };
        },
        fetchBlob: async () => {
            throw new Error("视频任务不应下载音频");
        },
        ...overrides,
    };
    return { io, captured };
}

describe("generated video first frame", () => {
    test("a finished generation stores a first-frame poster like an uploaded video", async () => {
        const node = videoNode("", "");
        node.metadata = { prompt: "镜头" };
        const { io, captured } = generatedVideoIO();

        const result = await buildGenerationTaskNodeResult(
            node,
            generatedVideoTask({ mode: "video", video: { storageKey: "resource:result-video", url: "/api/resources/result-video/file", width: 1280, height: 720, durationMs: 4000, mimeType: "video/mp4" } }),
            [node],
            io,
        );

        expect(captured).toEqual([{ storageKey: "resource:result-video", content: "blob:http://127.0.0.1/result-video" }]);
        expect(result.metadata.videoPreview).toEqual({
            content: "/api/resources/poster/file",
            storageKey: "resource:poster",
            width: 400,
            height: 225,
            bytes: 30,
            mimeType: "image/jpeg",
            captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
            sourceKey: "resource:result-video",
        });
    });

    test("a failed first-frame capture keeps the finished video", async () => {
        const node = videoNode("", "");
        node.metadata = { prompt: "镜头" };
        const { io } = generatedVideoIO({
            captureVideoPreview: async () => {
                throw new Error("取帧失败");
            },
        });

        const result = await buildGenerationTaskNodeResult(
            node,
            generatedVideoTask({ mode: "video", video: { storageKey: "resource:result-video", url: "/api/resources/result-video/file", mimeType: "video/mp4" } }),
            [node],
            io,
        );

        expect(result.metadata.videoPreview).toBeUndefined();
        expect(result.metadata.storageKey).toBe("resource:result-video");
        expect(result.metadata.status).toBe("success");
        expect(result.metadata.taskStatus).toBe("succeeded");
    });
});
