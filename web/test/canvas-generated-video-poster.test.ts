import { beforeEach, describe, expect, test } from "bun:test";

import { captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { CANVAS_VIDEO_PREVIEW_VERSION } from "@/services/canvas-video-preview";
import type { GeneratedVideoMedia } from "@/services/generated-video-preview";
import type { GenerationTask } from "@/services/api/task-center";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// 正常生成完成后走的是后端绑定回执这条路（use-canvas-generation 调用
// bindBackendCanvasGenerationResult），不经过历史插入用的 buildGenerationTaskNodeResult。
// 所以首帧必须在这条路上验证，否则单测通过也不代表真实生成的视频有首帧。

const captured: CapturedUserScope = captureUserScope();

function videoNode(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "video-node", type: CanvasNodeType.Video, title: "生成视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata };
}

function videoProject(nodes: CanvasNodeData[], revision = 7): CanvasProject {
    return {
        id: "canvas-video",
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

function succeededVideoTask(): GenerationTask {
    return {
        id: "task-video-1",
        type: "canvas_video",
        status: "succeeded",
        prompt: "镜头",
        attempts: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        outputs: [{ outputIndex: 0, mediaType: "video", materializedAssetId: "asset-video" }],
    };
}

// 后端绑定回执写的是视频本体（storageKey/content），预览字段已被清空。
function boundVideoNode(metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return videoNode({ taskId: "task-video-1", status: "success", nodeRole: "result", resultOrigin: "generated", storageKey: "resource:video-result", content: "/api/resources/video-result/file", ...metadata });
}

function bindWithVideoReceipt(options: {
    node: CanvasNodeData;
    captureVideoPreview?: (media: GeneratedVideoMedia) => Promise<{ url: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string } | undefined>;
    onPersist?: (nodes: CanvasNodeData[]) => void;
    onNodes?: (nodes: CanvasNodeData[]) => void;
}) {
    const project = videoProject([options.node]);
    useCanvasStore.setState({ projects: [project] });
    return bindBackendCanvasGenerationResult({
        canvasId: project.id,
        nodeId: options.node.id,
        task: succeededVideoTask(),
        isCurrent: () => true,
        nodesRef: { current: [options.node] },
        setNodes: (value) => {
            const nodes = typeof value === "function" ? value([options.node]) : value;
            options.onNodes?.(nodes as CanvasNodeData[]);
        },
        runtime: {
            hydrateOutputs: async () => undefined,
            captureScope: () => captured,
            liveScope: () => captured,
            now: () => 0,
            sleep: async () => undefined,
            refreshTask: async () => succeededVideoTask(),
            adoptConfirmedProjection: async () => project,
            persistDocument: async (_id, patch) => { options.onPersist?.((patch.nodes as CanvasNodeData[]) || []); },
            bindOutput: async (value) => ({
                op: "canvas.task.bind",
                opId: value.operationId,
                replayed: false,
                result: { bindingStatus: "bound" as const, canvas: project, revision: 8 },
            }),
            captureVideoPreview: options.captureVideoPreview ?? (async (media) => {
                expect(media).toEqual({ storageKey: "resource:video-result", content: "/api/resources/video-result/file" });
                return { url: "/api/resources/poster/file", storageKey: "resource:poster", width: 400, height: 225, bytes: 30, mimeType: "image/jpeg" };
            }),
        },
    });
}

describe("generated video first frame on the bind path", () => {
    beforeEach(() => {
        useCanvasStore.setState({ projects: [] });
    });

    test("a freshly bound generation result gets a stored first frame", async () => {
        let published: CanvasNodeData[] = [];
        let persisted: CanvasNodeData[] = [];
        await bindWithVideoReceipt({
            node: boundVideoNode(),
            onNodes: (nodes) => { published = nodes; },
            onPersist: (nodes) => { persisted = nodes; },
        });

        const preview = {
            content: "/api/resources/poster/file",
            storageKey: "resource:poster",
            width: 400,
            height: 225,
            bytes: 30,
            mimeType: "image/jpeg",
            captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
            sourceKey: "resource:video-result",
        };
        expect(published.find((node) => node.id === "video-node")?.metadata.videoPreview).toEqual(preview);
        expect(persisted.find((node) => node.id === "video-node")?.metadata.videoPreview).toEqual(preview);
        // 视频本体保持绑定回执里的值，首帧只是附加信息。
        expect(persisted.find((node) => node.id === "video-node")?.metadata.storageKey).toBe("resource:video-result");
    });

    test("a first frame that cannot be read still leaves the bound video intact", async () => {
        let published: CanvasNodeData[] = [];
        await bindWithVideoReceipt({
            node: boundVideoNode(),
            onNodes: (nodes) => { published = nodes; },
            captureVideoPreview: async () => { throw new Error("取帧失败"); },
        });

        expect(published.find((node) => node.id === "video-node")?.metadata.storageKey).toBe("resource:video-result");
        expect(published.find((node) => node.id === "video-node")?.metadata.videoPreview).toBeUndefined();
    });

    test("an existing first frame for this video is not captured again", async () => {
        let calls = 0;
        let published: CanvasNodeData[] = [];
        await bindWithVideoReceipt({
            node: boundVideoNode({
                videoPreview: { content: "/api/resources/poster/file", storageKey: "resource:poster", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:video-result" },
            }),
            captureVideoPreview: async () => { calls += 1; return undefined; },
            onNodes: (nodes) => { published = nodes; },
        });

        expect(calls).toBe(0);
        expect(published.find((node) => node.id === "video-node")?.metadata.videoPreview).toEqual({
            content: "/api/resources/poster/file",
            storageKey: "resource:poster",
            captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
            sourceKey: "resource:video-result",
        });
    });

    test("an image result never triggers video capture", async () => {
        let calls = 0;
        const node = { id: "video-node", type: CanvasNodeType.Video, title: "图片", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { taskId: "task-video-1", storageKey: "resource:video-result" } } as CanvasNodeData;
        const project = videoProject([node]);
        useCanvasStore.setState({ projects: [project] });
        await bindBackendCanvasGenerationResult({
            canvasId: project.id,
            nodeId: node.id,
            task: {
                ...succeededVideoTask(),
                type: "canvas_image",
                outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "asset-image" }],
            },
            isCurrent: () => true,
            nodesRef: { current: [node] },
            setNodes: () => {},
            runtime: {
                hydrateOutputs: async () => undefined,
                captureScope: () => captured,
                liveScope: () => captured,
                now: () => 0,
                sleep: async () => undefined,
                refreshTask: async () => succeededVideoTask(),
                adoptConfirmedProjection: async () => project,
                persistDocument: async () => undefined,
                bindOutput: async (value) => ({ op: "canvas.task.bind", opId: value.operationId, replayed: false, result: { bindingStatus: "bound" as const, canvas: project, revision: 8 } }),
                captureVideoPreview: async () => { calls += 1; return undefined; },
            },
        });
        expect(calls).toBe(0);
    });
});

// 取帧要等视频解码，这一段时间用户仍然可以编辑画布。
// 首帧只能补在那一个节点上，不能把取帧前的快照整份写回去。
function deferredPoster() {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return {
        started: startedPromise,
        release,
        capture: async () => {
            started();
            await gate;
            return { url: "/api/resources/poster/file", storageKey: "resource:poster", width: 400, height: 225, bytes: 30, mimeType: "image/jpeg" };
        },
    };
}

function storeNodes(): CanvasNodeData[] {
    return useCanvasStore.getState().openProject("canvas-video")?.nodes ?? [];
}

describe("first frame capture keeps concurrent canvas edits", () => {
    beforeEach(() => {
        useCanvasStore.setState({ projects: [] });
    });

    test("a node deleted while the frame is being read is not restored", async () => {
        const poster = deferredPoster();
        const persisted: CanvasNodeData[][] = [];
        const published: CanvasNodeData[][] = [];
        const done = bindWithVideoReceipt({
            node: boundVideoNode(),
            captureVideoPreview: poster.capture,
            onPersist: (nodes) => { persisted.push(nodes); },
            onNodes: (nodes) => { published.push(nodes); },
        });
        await poster.started;
        // 绑定前的常规保存与回执采纳都在取帧之前，之后不应再有写入。
        const writesBeforeCapture = persisted.length;
        const publishesBeforeCapture = published.length;

        useCanvasStore.setState({ projects: [videoProject([])] });
        poster.release();
        await done;

        expect(storeNodes()).toHaveLength(0);
        expect(persisted.slice(writesBeforeCapture)).toEqual([]);
        expect(published.slice(publishesBeforeCapture)).toEqual([]);
    });

    test("a video swapped while the frame is being read keeps the newer video and gets no stale poster", async () => {
        const poster = deferredPoster();
        const persisted: CanvasNodeData[][] = [];
        const published: CanvasNodeData[][] = [];
        const done = bindWithVideoReceipt({
            node: boundVideoNode(),
            captureVideoPreview: poster.capture,
            onPersist: (nodes) => { persisted.push(nodes); },
            onNodes: (nodes) => { published.push(nodes); },
        });
        await poster.started;
        const writesBeforeCapture = persisted.length;
        const publishesBeforeCapture = published.length;

        useCanvasStore.setState({ projects: [videoProject([videoNode({ taskId: "task-video-1", storageKey: "resource:user-replaced", content: "/api/resources/user-replaced/file" })])] });
        poster.release();
        await done;

        const node = storeNodes().find((item) => item.id === "video-node");
        expect(node?.metadata.storageKey).toBe("resource:user-replaced");
        expect(node?.metadata.videoPreview).toBeUndefined();
        expect(persisted.slice(writesBeforeCapture)).toEqual([]);
        expect(published.slice(publishesBeforeCapture)).toEqual([]);
    });

    test("edits to other nodes made while the frame is being read survive the poster write", async () => {
        const poster = deferredPoster();
        const persisted: CanvasNodeData[][] = [];
        const done = bindWithVideoReceipt({ node: boundVideoNode(), captureVideoPreview: poster.capture, onPersist: (nodes) => { persisted.push(nodes); } });
        await poster.started;

        const neighbour: CanvasNodeData = { id: "neighbour-node", type: CanvasNodeType.Text, title: "旁白", position: { x: 500, y: 0 }, width: 320, height: 180, metadata: { content: "用户刚写的旁白", status: "success" } };
        const edited = videoNode({ taskId: "task-video-1", status: "success", storageKey: "resource:video-result", content: "/api/resources/video-result/file", prompt: "用户刚改的提示词" });
        useCanvasStore.setState({ projects: [videoProject([edited, neighbour])] });
        poster.release();
        await done;

        // 首帧那次写入以取帧结束时的画布为准：两个节点都在，用户的改动都还在。
        const lastWrite = persisted[persisted.length - 1] ?? [];
        expect(lastWrite.map((item) => item.id).sort()).toEqual(["neighbour-node", "video-node"]);
        expect(lastWrite.find((item) => item.id === "neighbour-node")?.metadata.content).toBe("用户刚写的旁白");
        expect(lastWrite.find((item) => item.id === "video-node")?.metadata.prompt).toBe("用户刚改的提示词");
        expect(lastWrite.find((item) => item.id === "video-node")?.metadata.videoPreview?.sourceKey).toBe("resource:video-result");
    });
});
