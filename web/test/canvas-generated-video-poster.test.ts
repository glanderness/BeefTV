import { beforeEach, describe, expect, test } from "bun:test";

import { captureUserScope, type CapturedUserScope } from "@/lib/user-scope-guard";
import { bindBackendCanvasGenerationResult } from "@/services/canvas-generation-consumer";
import { CANVAS_VIDEO_PREVIEW_VERSION } from "@/services/canvas-video-preview";
import type { GeneratedVideoMedia } from "@/services/generated-video-preview";
import type { GenerationTask } from "@/services/api/task-center";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { UploadedImage } from "@/services/image-storage";

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

/**
 * 按 project.tsx 的真实结构搭夹具：编辑器的 setNodes 立刻写 nodesRef，
 * store 要等自动保存的 effect 才跟上。所以夹具里 setNodes 不碰 store，
 * 用户的编辑也走同一个入口——这正是取帧期间最容易丢改动的地方。
 */
function bindVideo(params: {
    node: CanvasNodeData;
    task?: GenerationTask;
    captureVideoPreview?: (media: GeneratedVideoMedia) => Promise<UploadedImage | undefined>;
}) {
    const project = videoProject([params.node]);
    useCanvasStore.setState({ projects: [project] });
    const nodesRef = { current: [params.node] };
    const editor = { current: [params.node] };
    const published: CanvasNodeData[][] = [];
    const persisted: CanvasNodeData[][] = [];
    const setNodes = (value: CanvasNodeData[] | ((current: CanvasNodeData[]) => CanvasNodeData[])) => {
        const next = typeof value === "function" ? value(editor.current) : value;
        editor.current = next;
        nodesRef.current = next;
        published.push(next);
    };
    // 用户改画布：只更新编辑器和 ref，store 仍是旧快照（自动保存还没跑）。
    const userEdit = (next: CanvasNodeData[]) => {
        editor.current = next;
        nodesRef.current = next;
    };
    const done = bindBackendCanvasGenerationResult({
        canvasId: project.id,
        nodeId: params.node.id,
        task: params.task ?? succeededVideoTask(),
        isCurrent: () => true,
        nodesRef,
        setNodes,
        runtime: {
            hydrateOutputs: async () => undefined,
            captureScope: () => captured,
            liveScope: () => captured,
            now: () => 0,
            sleep: async () => undefined,
            refreshTask: async () => params.task ?? succeededVideoTask(),
            adoptConfirmedProjection: async () => project,
            persistDocument: async (_id, patch) => { persisted.push((patch.nodes as CanvasNodeData[]) || []); },
            bindOutput: async (value) => ({
                op: "canvas.task.bind",
                opId: value.operationId,
                replayed: false,
                result: { bindingStatus: "bound" as const, canvas: project, revision: 8 },
            }),
            captureVideoPreview: params.captureVideoPreview ?? (async (media) => {
                expect(media).toEqual({ storageKey: "resource:video-result", content: "/api/resources/video-result/file" });
                return { url: "/api/resources/poster/file", storageKey: "resource:poster", width: 400, height: 225, bytes: 30, mimeType: "image/jpeg" };
            }),
        },
    });
    return { done, nodesRef, editor, published, persisted, userEdit };
}

const posterPreview = {
    content: "/api/resources/poster/file",
    storageKey: "resource:poster",
    width: 400,
    height: 225,
    bytes: 30,
    mimeType: "image/jpeg",
    captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
    sourceKey: "resource:video-result",
};

describe("generated video first frame on the bind path", () => {
    beforeEach(() => {
        useCanvasStore.setState({ projects: [] });
    });

    test("a freshly bound generation result gets a stored first frame", async () => {
        const harness = bindVideo({ node: boundVideoNode() });
        await harness.done;

        const node = harness.editor.current.find((item) => item.id === "video-node");
        expect(node?.metadata.videoPreview).toEqual(posterPreview);
        // 首帧还要落盘，重开项目仍在。
        expect(harness.persisted[harness.persisted.length - 1]?.find((item) => item.id === "video-node")?.metadata.videoPreview).toEqual(posterPreview);
        // 视频本体保持绑定回执里的值，首帧只是附加信息。
        expect(node?.metadata.storageKey).toBe("resource:video-result");
    });

    test("a first frame that cannot be read still leaves the bound video intact", async () => {
        const harness = bindVideo({ node: boundVideoNode(), captureVideoPreview: async () => { throw new Error("取帧失败"); } });
        await harness.done;

        const node = harness.editor.current.find((item) => item.id === "video-node");
        expect(node?.metadata.storageKey).toBe("resource:video-result");
        expect(node?.metadata.videoPreview).toBeUndefined();
    });

    test("an existing first frame for this video is not captured again", async () => {
        let calls = 0;
        const harness = bindVideo({
            node: boundVideoNode({ videoPreview: { content: "/api/resources/poster/file", storageKey: "resource:poster", captureVersion: CANVAS_VIDEO_PREVIEW_VERSION, sourceKey: "resource:video-result" } }),
            captureVideoPreview: async () => { calls += 1; return undefined; },
        });
        await harness.done;

        expect(calls).toBe(0);
        expect(harness.editor.current.find((item) => item.id === "video-node")?.metadata.videoPreview?.content).toBe("/api/resources/poster/file");
    });

    test("an image result never triggers video capture", async () => {
        let calls = 0;
        const harness = bindVideo({
            node: boundVideoNode(),
            task: { ...succeededVideoTask(), type: "canvas_image", outputs: [{ outputIndex: 0, mediaType: "image", materializedAssetId: "asset-image" }] },
            captureVideoPreview: async () => { calls += 1; return undefined; },
        });
        await harness.done;

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

describe("first frame capture keeps concurrent canvas edits", () => {
    beforeEach(() => {
        useCanvasStore.setState({ projects: [] });
    });

    test("a node deleted in the editor while the frame is being read is not restored", async () => {
        const poster = deferredPoster();
        const harness = bindVideo({ node: boundVideoNode(), captureVideoPreview: poster.capture });
        await poster.started;
        const writesBeforeCapture = harness.persisted.length;
        const publishesBeforeCapture = harness.published.length;

        harness.userEdit([]);
        poster.release();
        await harness.done;

        expect(harness.editor.current).toHaveLength(0);
        expect(harness.nodesRef.current).toHaveLength(0);
        expect(harness.persisted.slice(writesBeforeCapture)).toEqual([]);
        expect(harness.published.slice(publishesBeforeCapture)).toEqual([]);
    });

    test("a video swapped in the editor while the frame is being read keeps the newer video", async () => {
        const poster = deferredPoster();
        const harness = bindVideo({ node: boundVideoNode(), captureVideoPreview: poster.capture });
        await poster.started;
        const writesBeforeCapture = harness.persisted.length;
        const publishesBeforeCapture = harness.published.length;

        harness.userEdit([videoNode({ taskId: "task-video-1", storageKey: "resource:user-replaced", content: "/api/resources/user-replaced/file" })]);
        poster.release();
        await harness.done;

        const node = harness.editor.current.find((item) => item.id === "video-node");
        expect(node?.metadata.storageKey).toBe("resource:user-replaced");
        expect(node?.metadata.videoPreview).toBeUndefined();
        expect(harness.persisted.slice(writesBeforeCapture)).toEqual([]);
        expect(harness.published.slice(publishesBeforeCapture)).toEqual([]);
    });

    test("edits made in the editor while the frame is being read survive the poster write", async () => {
        const poster = deferredPoster();
        const harness = bindVideo({ node: boundVideoNode(), captureVideoPreview: poster.capture });
        await poster.started;

        const neighbour: CanvasNodeData = { id: "neighbour-node", type: CanvasNodeType.Text, title: "旁白", position: { x: 500, y: 0 }, width: 320, height: 180, metadata: { content: "用户刚写的旁白", status: "success" } };
        const edited = videoNode({ taskId: "task-video-1", status: "success", storageKey: "resource:video-result", content: "/api/resources/video-result/file", prompt: "用户刚改的提示词" });
        harness.userEdit([edited, neighbour]);
        poster.release();
        await harness.done;

        const lastWrite = harness.persisted[harness.persisted.length - 1] ?? [];
        // 首帧那次写入以取帧结束时的编辑器节点为准：两个节点都在，用户的改动都还在。
        expect(lastWrite.map((item) => item.id).sort()).toEqual(["neighbour-node", "video-node"]);
        expect(lastWrite.find((item) => item.id === "neighbour-node")?.metadata.content).toBe("用户刚写的旁白");
        expect(lastWrite.find((item) => item.id === "video-node")?.metadata.prompt).toBe("用户刚改的提示词");
        expect(lastWrite.find((item) => item.id === "video-node")?.metadata.videoPreview).toEqual(posterPreview);
    });
});