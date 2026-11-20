import { afterEach, expect, test } from "bun:test";
import { zipSync } from "fflate";

import { archiveMediaIdempotencyKey, restoreCanvasArchive, type CanvasArchiveRestoreHost } from "@/lib/canvas/canvas-archive-restore";
import { openCanvasArchive } from "@/lib/canvas/canvas-export";
import { useOperationProgress } from "@/stores/use-operation-progress";
import { ARCHIVE_MAX_ENTRY_BYTES, ARCHIVE_MAX_FILES, ARCHIVE_MAX_TOTAL_BYTES, createZip } from "@/lib/zip";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

const encoder = new TextEncoder();

afterEach(() => {
    useOperationProgress.setState({ entries: {} });
    globalThis.window = undefined as unknown as Window & typeof globalThis;
});

function videoNode(storageKey = "video:clip"): CanvasNodeData {
    return {
        id: "n-video",
        type: "video",
        title: "镜头",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: {
            storageKey,
            content: "blob:expired",
            assetId: "source-asset",
            prompt: "描述里提到 data:image/png 和 blob:expired，但不是媒体文件",
        },
    };
}

function drawingNode(): CanvasNodeData {
    return {
        id: "n-drawing",
        type: "drawing",
        title: "分镜手稿",
        position: { x: 40, y: 0 },
        width: 240,
        height: 240,
        metadata: { drawingId: "sketch" },
    };
}

function textNode(): CanvasNodeData {
    return {
        id: "n-text",
        type: "text",
        title: "说明",
        position: { x: 80, y: 0 },
        width: 200,
        height: 80,
        metadata: { content: "data:image/png;base64,not-a-file" },
    };
}

function timeline(): TimelineProject {
    return {
        version: 2,
        durationMs: 1000,
        tracks: [{ id: "voice", kind: "audio", label: "配音", order: 0 }],
        clips: [{
            id: "c1",
            kind: "audio",
            nodeId: "n-video",
            trackId: "voice",
            startMs: 0,
            durationMs: 1000,
            directMedia: { id: "m1", kind: "audio", title: "配音", storageKey: "audio:voice", url: "blob:expired", assetId: "source-clip-asset" },
        }],
    };
}

function archiveData(overrides: Record<string, unknown> = {}) {
    return {
        app: "infinite-canvas",
        version: 4,
        exportedAt: "2026-10-02T00:00:00.000Z",
        folders: [{ id: "folder-old", name: "剧集", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
        projects: [{
            project: {
                id: "old-canvas",
                workspaceProjectId: "old-workspace",
                projectId: "source-business",
                folderId: "folder-old",
                title: "测试画布",
                nodes: [videoNode(), drawingNode(), textNode()],
                connections: [],
                timeline: timeline(),
            },
            files: [
                { storageKey: "video:clip", path: "projects/old-canvas/files/clip.mp4", mimeType: "video/mp4", bytes: 4 },
                { storageKey: "audio:voice", path: "projects/old-canvas/files/voice.wav", mimeType: "audio/wav", bytes: 5 },
            ],
            drawingDocuments: [{
                drawingId: "sketch",
                version: 2,
                engine: "excalidraw",
                snapshot: { elements: [] },
                revision: 2,
                updatedAt: "2026-10-02T00:00:00.000Z",
                shapeCount: 1,
                pageCount: 1,
            }],
        }],
        ...overrides,
    };
}

async function validZip(data = archiveData()) {
    return createZip([
        { name: "projects.json", data: JSON.stringify(data) },
        { name: "projects/old-canvas/files/clip.mp4", data: new Uint8Array([1, 2, 3, 4]) },
        { name: "projects/old-canvas/files/voice.wav", data: "voice" },
    ]);
}

function memoryHost(overrides: Partial<CanvasArchiveRestoreHost> = {}) {
    const folders: Array<{ id: string; name: string }> = [];
    const projects: CanvasProject[] = [];
    const media = new Map<string, Uint8Array>();
    const drawings: string[] = [];
    const drawingSnapshots = new Map<string, unknown>();
    const deleted: string[] = [];
    const deletedResources: string[] = [];
    const binds: Array<{ canvasId: string; node: CanvasNodeData }> = [];
    const idempotencyKeys: string[] = [];
    let folderSeq = 0;
    let projectSeq = 0;
    let assetSeq = 0;
    let mediaSeq = 0;
    const host: Partial<CanvasArchiveRestoreHost> = {
        usesCanonicalBackend: true,
        createFolder: (name) => {
            const id = `folder-${++folderSeq}`;
            folders.push({ id, name });
            return id;
        },
        deleteFolder: (id) => {
            const index = folders.findIndex((folder) => folder.id === id);
            if (index >= 0) folders.splice(index, 1);
        },
        importProject: (project) => {
            const id = `imported-${++projectSeq}`;
            projects.push({
                id,
                revision: 0,
                workspaceProjectId: id,
                folderId: project.folderId,
                title: project.title || "导入画布",
                createdAt: "2026-10-02T00:00:00.000Z",
                updatedAt: "2026-10-02T00:00:00.000Z",
                nodes: (project.nodes || []) as CanvasNodeData[],
                connections: project.connections || [],
                chatSessions: [],
                activeChatId: null,
                backgroundMode: "dots",
                showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 },
                directorScenes: project.directorScenes || [],
                timeline: project.timeline,
            });
            return id;
        },
        updateProject: (id, patch) => {
            const index = projects.findIndex((project) => project.id === id);
            if (index >= 0) projects[index] = { ...projects[index], ...patch };
        },
        persistProject: async (id) => {
            if (!projects.some((project) => project.id === id)) throw new Error("画布未保存到工作区");
        },
        deleteProjects: async (ids) => {
            deleted.push(...ids);
            for (const id of ids) {
                const index = projects.findIndex((project) => project.id === id);
                if (index >= 0) projects.splice(index, 1);
            }
        },
        discardProjects: (ids) => {
            for (const id of ids) {
                const index = projects.findIndex((project) => project.id === id);
                if (index >= 0) projects.splice(index, 1);
            }
        },
        uploadMedia: async (blob, _kind, _meta) => {
            const resourceId = `res-${++mediaSeq}`;
            const storageKey = `resource:${resourceId}`;
            media.set(storageKey, new Uint8Array(await blob.arrayBuffer()));
            return { storageKey, url: `/api/resources/${resourceId}/file`, resourceId };
        },
        bindMediaAsset: async (options) => {
            binds.push(options);
            return `asset-${++assetSeq}`;
        },
        saveDrawing: async (projectId, drawingId, _engine, snapshot) => {
            drawings.push(`${projectId}:${drawingId}`);
            drawingSnapshots.set(`${projectId}:${drawingId}`, snapshot);
            return { version: 2, engine: "excalidraw", snapshot, revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", shapeCount: 0, pageCount: 1 };
        },
        loadDrawing: async (projectId, drawingId) => (
            drawings.includes(`${projectId}:${drawingId}`) ? { drawingId, revision: 1, snapshot: drawingSnapshots.get(`${projectId}:${drawingId}`) } : null
        ),
        deleteResource: async (resourceId) => {
            deletedResources.push(resourceId);
        },
        ...overrides,
    };
    return { host, folders, projects, media, drawings, deleted, deletedResources, binds, idempotencyKeys };
}

test("missing media degrades gracefully while preflight rejects invalid project, version, duplicate IDs, and data/blob keys before writes", async () => {
    const writes: string[] = [];
    const host = memoryHost({
        createFolder: (name) => {
            writes.push(name);
            return "folder";
        },
    }).host;

    const missing = await createZip([{
        name: "projects.json",
        data: JSON.stringify({
            app: "infinite-canvas",
            version: 4,
            projects: [{
                project: { id: "broken", title: "损坏画布", nodes: [videoNode()], connections: [] },
                files: [{ storageKey: "video:clip", path: "projects/broken/files/missing.mp4", mimeType: "video/mp4", bytes: 3 }],
            }],
        }),
    }]);
    const missingState = memoryHost();
    const partial = await restoreCanvasArchive(missing, missingState.host);
    expect(partial.count).toBe(1);
    expect(partial.skippedFiles).toEqual([{ owner: "损坏画布", reference: "projects/broken/files/missing.mp4" }]);
    expect(missingState.projects).toHaveLength(1);
    expect(missingState.projects[0].nodes[0].metadata?.storageKey).toBeUndefined();
    expect(missingState.projects[0].nodes[0].metadata?.content).toBe("");
    expect(writes).toEqual([]);

    const invalidProject = await createZip([{
        name: "projects.json",
        data: JSON.stringify({ app: "infinite-canvas", version: 4, projects: [{ project: { title: "无编号" }, files: [] }] }),
    }]);
    await expect(openCanvasArchive(invalidProject)).rejects.toThrow("缺少编号");

    const badVersion = await createZip([{
        name: "projects.json",
        data: JSON.stringify({ app: "infinite-canvas", version: 2, projects: [] }),
    }]);
    await expect(openCanvasArchive(badVersion)).rejects.toThrow("不支持的画布备份版本");

    const duplicate = await createZip([{
        name: "projects.json",
        data: JSON.stringify({
            app: "infinite-canvas",
            version: 4,
            projects: [
                { project: { id: "same", title: "一", nodes: [], connections: [] }, files: [] },
                { project: { id: "same", title: "二", nodes: [], connections: [] }, files: [] },
            ],
        }),
    }]);
    await expect(openCanvasArchive(duplicate)).rejects.toThrow("重复的画布");

    const duplicateDrawing = await createZip([{
        name: "projects.json",
        data: JSON.stringify({
            app: "infinite-canvas",
            version: 4,
            projects: [{
                project: { id: "drawn", title: "重复画板", nodes: [drawingNode()], connections: [] },
                files: [],
                drawingDocuments: [
                    { drawingId: "sketch", version: 2, engine: "excalidraw", snapshot: {}, revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", shapeCount: 0, pageCount: 1 },
                    { drawingId: "sketch", version: 2, engine: "excalidraw", snapshot: {}, revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", shapeCount: 0, pageCount: 1 },
                ],
            }],
        }),
    }]);
    await expect(openCanvasArchive(duplicateDrawing)).rejects.toThrow("重复画板");

    const dataKey = await createZip([
        {
            name: "projects.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 4,
                projects: [{
                    project: { id: "data", title: "内嵌", nodes: [{ ...videoNode(), metadata: { storageKey: "data:image/png;base64,AAAA" } }], connections: [] },
                    files: [{ storageKey: "data:image/png;base64,AAAA", path: "a.bin", mimeType: "image/png", bytes: 1 }],
                }],
            }),
        },
        { name: "a.bin", data: new Uint8Array([1]) },
    ]);
    await expect(openCanvasArchive(dataKey)).rejects.toThrow("无效的媒体引用");
});

test("archive zip bounds match the existing desktop extraction limits", () => {
    expect(ARCHIVE_MAX_FILES).toBe(50_000);
    expect(ARCHIVE_MAX_ENTRY_BYTES).toBe(1024 * 1024 * 1024);
    expect(ARCHIVE_MAX_TOTAL_BYTES).toBe(2 * 1024 * 1024 * 1024);
});

test("zip traversal and duplicate confined paths fail before restore writes", async () => {
    const traversal = new Blob([zipSync({
        "../secret.txt": new Uint8Array([1]),
        "projects.json": encoder.encode(JSON.stringify({ app: "infinite-canvas", version: 4, projects: [] })),
    })]);
    await expect(openCanvasArchive(traversal)).rejects.toThrow("越界路径");

    await expect(createZip([{ name: "same", data: "A" }, { name: "same", data: "B" }])).rejects.toThrow("重名文件");
});

test("production restore remaps media and timeline, preserves drawings, and ignores prompt data/blob strings", async () => {
    const { host, folders, projects, media, drawings, binds } = memoryHost();
    const result = await restoreCanvasArchive(await validZip(), host);
    expect(result.storage).toBe("backend");
    expect(result.count).toBe(1);
    expect(result.projectIds).toEqual(["imported-1"]);
    expect(result.projectIds).not.toContain("old-canvas");
    expect(folders).toEqual([{ id: "folder-1", name: "剧集" }]);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("imported-1");
    expect(projects[0].workspaceProjectId).toBe("imported-1");
    expect(projects[0].projectId).toBeFalsy();
    expect(projects[0].folderId).toBe("folder-1");
    const node = projects[0].nodes.find((item) => item.type === "video")!;
    expect(node.metadata?.storageKey).toStartWith("resource:");
    expect(node.metadata?.content).toStartWith("/api/resources/");
    expect(node.metadata?.prompt).toContain("data:image/png");
    expect(node.metadata?.assetId).toBe("asset-1");
    expect(node.metadata?.assetId).not.toBe("source-asset");
    const text = projects[0].nodes.find((item) => item.type === "text")!;
    expect(text.metadata?.content).toBe("data:image/png;base64,not-a-file");
    const clip = projects[0].timeline?.clips[0].directMedia;
    expect(clip?.storageKey).toStartWith("resource:");
    expect(clip?.url).toStartWith("/api/resources/");
    expect(clip?.assetId).toBe("asset-2");
    expect(clip?.assetId).not.toBe("source-clip-asset");
    expect(binds.every((item) => !item.node.metadata?.assetId)).toBe(true);
    expect([...media.keys()]).toHaveLength(2);
    expect(drawings).toEqual(["imported-1:sketch"]);
});

test("persist failure does not report saved and rolls back this attempt", async () => {
    const { host, folders, projects, deleted } = memoryHost({
        persistProject: async () => {
            const operation = Object.values(useOperationProgress.getState().entries).find(item => item.title === "导入画布备份");
            expect(operation?.phase).toBe("processing");
            throw new Error("画布未保存到工作区");
        },
    });
    await expect(restoreCanvasArchive(await validZip(), host)).rejects.toThrow("画布未保存到工作区");
    expect(projects).toEqual([]);
    expect(folders).toEqual([]);
    expect(deleted).toEqual(["imported-1"]);
    expect(Object.values(useOperationProgress.getState().entries).find(item => item.title === "导入画布备份")?.phase).toBe("error");
});

test("retrying a valid archive creates new IDs and never reuses archive workspace IDs", async () => {
    const state = memoryHost();
    const zip = await validZip();
    const one = await restoreCanvasArchive(zip, state.host);
    const two = await restoreCanvasArchive(zip, state.host);
    expect(state.projects).toHaveLength(2);
    expect(one.projectIds[0]).not.toBe("old-canvas");
    expect(two.projectIds[0]).not.toBe("old-canvas");
    expect(one.projectIds[0]).not.toBe(two.projectIds[0]);
    expect(state.projects.map((project) => project.workspaceProjectId).sort()).toEqual(["imported-1", "imported-2"]);
    expect(state.projects.some((project) => project.id === "old-canvas" || project.workspaceProjectId === "old-workspace")).toBe(false);
    expect(new Set([...one.resourceIds, ...two.resourceIds]).size).toBe(4);
});

test("archive media idempotency follows content, not source storage keys", async () => {
    const same = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" });
    const changed = new Blob([new Uint8Array([1, 2, 3, 5])], { type: "video/mp4" });
    const first = await archiveMediaIdempotencyKey(same);
    const retry = await archiveMediaIdempotencyKey(same);
    const next = await archiveMediaIdempotencyKey(changed);
    expect(first).toBe(retry);
    expect(first).toStartWith("canvas-archive:sha256:");
    expect(next).toStartWith("canvas-archive:sha256:");
    expect(next).not.toBe(first);
});

test("restore remaps imageHistory entries recursively, drops missing entries, and never alters text node prose", async () => {
    const data = archiveData({
        projects: [{
            project: {
                id: "old-canvas",
                title: "历史与正文",
                nodes: [
                    {
                        id: "img-1",
                        type: "image",
                        title: "角色图",
                        position: { x: 0, y: 0 },
                        width: 512,
                        height: 512,
                        metadata: {
                            storageKey: "resource:old-active",
                            content: "/api/resources/old-active/file",
                            assetId: "foreign-active-asset",
                            taskId: "foreign-active-task",
                            imageHistory: [
                                {
                                    id: "hist-only:0",
                                    storageKey: "resource:old-hist",
                                    content: "http://127.0.0.1:19999/api/resources/old-hist/file",
                                    assetId: "foreign-hist-asset",
                                    taskId: "foreign-hist-task",
                                    prompt: "旧版历史",
                                },
                                {
                                    id: "hist-missing:0",
                                    storageKey: "resource:old-missing",
                                    content: "http://127.0.0.1:19999/api/resources/old-missing/file",
                                    assetId: "foreign-missing-asset",
                                    taskId: "foreign-missing-task",
                                },
                                {
                                    id: "hist-active:0",
                                    storageKey: "resource:old-active",
                                    content: "/api/resources/old-active/file",
                                    assetId: "foreign-active-asset",
                                    taskId: "foreign-active-task",
                                },
                            ],
                        },
                    },
                    {
                        id: "text-note",
                        type: "text",
                        title: "笔记",
                        position: { x: 600, y: 0 },
                        width: 240,
                        height: 120,
                        metadata: {
                            content: "接口示例：/api/resources/old-missing/file 与 /api/resources/doc-example/file",
                        },
                    },
                ],
                connections: [],
            },
            files: [
                { storageKey: "resource:old-active", path: "projects/old-canvas/files/active.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-hist", path: "projects/old-canvas/files/hist.png", mimeType: "image/png", bytes: 4 },
            ],
            drawingDocuments: [],
        }],
    });
    const zip = await createZip([
        { name: "projects.json", data: JSON.stringify(data) },
        { name: "projects/old-canvas/files/active.png", data: new Uint8Array([1, 2, 3, 4]) },
        { name: "projects/old-canvas/files/hist.png", data: new Uint8Array([5, 6, 7, 8]) },
    ]);
    const state = memoryHost();
    const result = await restoreCanvasArchive(zip, state.host);
    expect(result.skippedFiles).toEqual([{ owner: "历史与正文", reference: "resource:old-missing" }]);
    const img = state.projects[0].nodes.find((item) => item.id === "img-1")!;
    expect(img.metadata?.storageKey).toStartWith("resource:res-");
    expect(img.metadata?.assetId).toBe("asset-1");
    expect(img.metadata?.taskId).toBeUndefined();
    const history = img.metadata?.imageHistory || [];
    expect(history).toHaveLength(2);
    expect(history[0].storageKey).toStartWith("resource:res-");
    expect(history[0].storageKey).not.toBe(img.metadata?.storageKey);
    expect(history[0].content).not.toContain("19999");
    expect(history[0].assetId).toBeUndefined();
    expect(history[0].taskId).toBeUndefined();
    expect(history[1].storageKey).toBe(img.metadata?.storageKey);
    expect(history[1].assetId).toBe(img.metadata?.assetId);
    expect(state.binds).toHaveLength(1);
    const note = state.projects[0].nodes.find((item) => item.id === "text-note")!;
    expect(note.metadata?.content).toBe("接口示例：/api/resources/old-missing/file 与 /api/resources/doc-example/file");
});

test("restore preserves text node prose even with a mapped file storageKey, remaps URL-only and suffix storageKey fields, and warns on missing folderId", async () => {
    const data = archiveData({
        folders: [],
        projects: [{
            project: {
                id: "old-canvas",
                title: "全量字段与缺失文件夹",
                folderId: "missing-folder-id",
                nodes: [
                    {
                        id: "script-doc",
                        type: "text",
                        title: "上传的剧本",
                        position: { x: 0, y: 0 },
                        width: 320,
                        height: 200,
                        metadata: {
                            storageKey: "file:script-1",
                            content: "第一幕：雨夜霓虹\n主角推开铁门。",
                            prompt: "第一幕：雨夜霓虹\n主角推开铁门。",
                            mimeType: "text/plain",
                        },
                    },
                    {
                        id: "url-only-img",
                        type: "image",
                        title: "仅URL图片",
                        position: { x: 400, y: 0 },
                        width: 512,
                        height: 512,
                        metadata: {
                            content: "http://127.0.0.1:18888/api/resources/old-url-only/file",
                        },
                    },
                    {
                        id: "suffix-vid",
                        type: "video",
                        title: "带尾帧与遮罩的视频",
                        position: { x: 960, y: 0 },
                        width: 320,
                        height: 180,
                        metadata: {
                            storageKey: "resource:old-vid",
                            content: "/api/resources/old-vid/file",
                            lastFrameStorageKey: "resource:old-last-frame",
                            lastFrameUrl: "/api/resources/old-last-frame/file",
                            directorCoverStorageKey: "image:old-dir-cover",
                            directorCoverUrl: "data:image/png;base64,AAAA",
                            drawingPreviewStorageKey: "resource:old-draw-preview",
                            drawingPreviewUrl: "/api/resources/old-draw-preview/file",
                            emotionEdit: { maskStorageKey: "resource:old-mask" },
                            mediaConversion: { resultStorageKey: "resource:old-conv" },
                        },
                    },
                ],
                connections: [],
            },
            files: [
                { storageKey: "file:script-1", path: "projects/old-canvas/files/script.txt", mimeType: "text/plain", bytes: 12 },
                { storageKey: "resource:old-url-only", path: "projects/old-canvas/files/url-only.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-vid", path: "projects/old-canvas/files/vid.mp4", mimeType: "video/mp4", bytes: 4 },
                { storageKey: "resource:old-last-frame", path: "projects/old-canvas/files/last.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "image:old-dir-cover", path: "projects/old-canvas/files/dir-cover.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-draw-preview", path: "projects/old-canvas/files/draw.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-mask", path: "projects/old-canvas/files/mask.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-conv", path: "projects/old-canvas/files/conv.png", mimeType: "image/png", bytes: 4 },
            ],
            drawingDocuments: [],
        }],
    });
    const zip = await createZip([
        { name: "projects.json", data: JSON.stringify(data) },
        { name: "projects/old-canvas/files/script.txt", data: encoder.encode("第一幕：雨夜霓虹") },
        { name: "projects/old-canvas/files/url-only.png", data: new Uint8Array([1, 2, 3, 4]) },
        { name: "projects/old-canvas/files/vid.mp4", data: new Uint8Array([2, 3, 4, 5]) },
        { name: "projects/old-canvas/files/last.png", data: new Uint8Array([3, 4, 5, 6]) },
        { name: "projects/old-canvas/files/dir-cover.png", data: new Uint8Array([7, 8, 9, 10]) },
        { name: "projects/old-canvas/files/draw.png", data: new Uint8Array([4, 5, 6, 7]) },
        { name: "projects/old-canvas/files/mask.png", data: new Uint8Array([5, 6, 7, 8]) },
        { name: "projects/old-canvas/files/conv.png", data: new Uint8Array([6, 7, 8, 9]) },
    ]);
    const state = memoryHost();
    const result = await restoreCanvasArchive(zip, state.host);
    expect(result.resourceIds).toHaveLength(8);
    expect(result.skippedFiles).toEqual([{ owner: "全量字段与缺失文件夹", reference: "文件夹 missing-folder-id" }]);
    expect(state.projects[0].folderId).toBeUndefined();

    const scriptNode = state.projects[0].nodes.find((item) => item.id === "script-doc")!;
    expect(scriptNode.metadata?.storageKey).toStartWith("resource:res-");
    expect(scriptNode.metadata?.content).toBe("第一幕：雨夜霓虹\n主角推开铁门。");
    expect(scriptNode.metadata?.prompt).toBe("第一幕：雨夜霓虹\n主角推开铁门。");

    const urlOnlyNode = state.projects[0].nodes.find((item) => item.id === "url-only-img")!;
    expect(urlOnlyNode.metadata?.storageKey).toStartWith("resource:res-");
    expect(urlOnlyNode.metadata?.content).toStartWith("/api/resources/res-");
    expect(urlOnlyNode.metadata?.content).not.toContain("18888");
    expect(urlOnlyNode.metadata?.assetId).toBeTruthy();

    const suffixNode = state.projects[0].nodes.find((item) => item.id === "suffix-vid")!;
    expect(suffixNode.metadata?.storageKey).toStartWith("resource:res-");
    expect(suffixNode.metadata?.lastFrameStorageKey).toStartWith("resource:res-");
    expect(suffixNode.metadata?.lastFrameStorageKey).not.toBe("resource:old-last-frame");
    expect(suffixNode.metadata?.lastFrameUrl).toContain(suffixNode.metadata!.lastFrameStorageKey!.slice("resource:".length));
    expect(suffixNode.metadata?.lastFrameUrl).not.toBe(suffixNode.metadata?.content);
    expect(suffixNode.metadata?.directorCoverStorageKey).toStartWith("resource:res-");
    expect(suffixNode.metadata?.directorCoverUrl).toContain(suffixNode.metadata!.directorCoverStorageKey!.slice("resource:".length));
    expect(suffixNode.metadata?.directorCoverUrl).not.toStartWith("data:");
    expect(suffixNode.metadata?.drawingPreviewStorageKey).toStartWith("resource:res-");
    expect(suffixNode.metadata?.drawingPreviewUrl).toContain(suffixNode.metadata!.drawingPreviewStorageKey!.slice("resource:".length));
    expect(suffixNode.metadata?.drawingPreviewUrl).not.toBe(suffixNode.metadata?.content);
    expect(suffixNode.metadata?.emotionEdit?.maskStorageKey).toStartWith("resource:res-");
    expect(suffixNode.metadata?.mediaConversion?.resultStorageKey).toStartWith("resource:res-");
});

test("restore preserves external CDN URLs and remaps bare resourceId fields in workflows and legacy metadata", async () => {
    const remoteUrl = "https://cdn.example.com/api/resources/ext-id/file";
    const data = archiveData({
        folders: [],
        projects: [{
            project: {
                id: "old-canvas",
                title: "远端链接与裸资源ID",
                nodes: [
                    {
                        id: "remote-img",
                        type: "image",
                        title: "外链图",
                        position: { x: 0, y: 0 },
                        width: 240,
                        height: 240,
                        metadata: {
                            content: remoteUrl,
                            referenceUrls: [remoteUrl],
                        },
                    },
                    {
                        id: "legacy-meta",
                        type: "image",
                        title: "旧版资源ID",
                        position: { x: 260, y: 0 },
                        width: 240,
                        height: 240,
                        metadata: {
                            resourceId: "old-legacy-id",
                            referenceResourceIds: ["old-legacy-id", "old-missing-ref"],
                        } as unknown as CanvasProject["nodes"][number]["metadata"],
                    },
                    {
                        id: "wf-node",
                        type: "group",
                        title: "工作流实例",
                        position: { x: 520, y: 0 },
                        width: 400,
                        height: 300,
                        metadata: {
                            reusableWorkflow: {
                                templateId: "tpl-1",
                                definition: {
                                    version: 1,
                                    nodes: [
                                        { id: "n1", title: "图1", mediaType: "image", role: "input", resourceId: "old-wf-def" },
                                    ],
                                    edges: [],
                                    outputNodeIds: ["n1"],
                                },
                                run: {
                                    id: "run-1",
                                    templateId: "tpl-1",
                                    templateName: "模板",
                                    status: "succeeded",
                                    steps: [{
                                        nodeId: "n1",
                                        title: "图1",
                                        status: "succeeded",
                                        taskId: "foreign-wf-task",
                                        resourceId: "old-wf-run",
                                        candidates: [{ resourceId: "old-wf-run" }, { resourceId: "old-missing-ref" }],
                                    }],
                                    outputs: [{ nodeId: "n1", mediaType: "image", resourceId: "old-wf-run" }],
                                    createdAt: "2026-01-01T00:00:00Z",
                                    updatedAt: "2026-01-01T00:00:00Z",
                                },
                                intent: {
                                    clientOperationId: "op-1",
                                    inputs: { n1: { resourceId: "old-wf-def" } },
                                },
                            },
                        },
                    },
                ],
                connections: [],
            },
            files: [
                { storageKey: "resource:old-legacy-id", path: "projects/old-canvas/files/legacy.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-wf-def", path: "projects/old-canvas/files/wf-def.png", mimeType: "image/png", bytes: 4 },
                { storageKey: "resource:old-wf-run", path: "projects/old-canvas/files/wf-run.png", mimeType: "image/png", bytes: 4 },
            ],
            drawingDocuments: [],
        }],
    });
    const zip = await createZip([
        { name: "projects.json", data: JSON.stringify(data) },
        { name: "projects/old-canvas/files/legacy.png", data: new Uint8Array([1, 2, 3, 4]) },
        { name: "projects/old-canvas/files/wf-def.png", data: new Uint8Array([2, 3, 4, 5]) },
        { name: "projects/old-canvas/files/wf-run.png", data: new Uint8Array([3, 4, 5, 6]) },
    ]);
    const state = memoryHost();
    const result = await restoreCanvasArchive(zip, state.host);
    expect(result.resourceIds).toHaveLength(3);
    expect(result.skippedFiles).toEqual([{ owner: "远端链接与裸资源ID", reference: "resource:old-missing-ref" }]);

    const remote = state.projects[0].nodes.find((item) => item.id === "remote-img")!;
    expect(remote.metadata?.content).toBe(remoteUrl);
    expect((remote.metadata as Record<string, unknown>)?.referenceUrls).toEqual([remoteUrl]);
    expect(remote.metadata?.storageKey).toBeUndefined();

    const legacy = state.projects[0].nodes.find((item) => item.id === "legacy-meta")!.metadata as Record<string, unknown>;
    expect(typeof legacy.resourceId).toBe("string");
    expect(legacy.resourceId).toStartWith("res-");
    expect(legacy.resourceId).not.toBe("old-legacy-id");
    expect(legacy.referenceResourceIds).toEqual([legacy.resourceId]);

    const wf = state.projects[0].nodes.find((item) => item.id === "wf-node")!.metadata!.reusableWorkflow!;
    const newDefId = wf.definition.nodes[0].resourceId!;
    const newRunId = wf.run!.steps[0].resourceId!;
    expect(newDefId).toStartWith("res-");
    expect(newDefId).not.toBe("old-wf-def");
    expect(newRunId).toStartWith("res-");
    expect(newRunId).not.toBe("old-wf-run");
    expect(wf.run!.steps[0].taskId).toBeUndefined();
    expect(wf.run!.steps[0].candidates).toEqual([{ resourceId: newRunId }, {}]);
    expect(wf.run!.outputs[0].resourceId).toBe(newRunId);
    expect(wf.intent!.inputs.n1.resourceId).toBe(newDefId);
});

test("restore uploads and remaps hosted-origin URL-only media when packaged in the archive while preserving un-packaged external CDN URLs", async () => {
    const hostedUrl = "https://app.example.com/api/resources/old-hosted/file";
    const externalUrl = "https://cdn.example.com/api/resources/ext-id/file";
    const data = archiveData({
        folders: [],
        projects: [{
            project: {
                id: "old-canvas",
                title: "托管域迁移与外链",
                nodes: [
                    {
                        id: "hosted-img",
                        type: "image",
                        title: "托管域图片",
                        position: { x: 0, y: 0 },
                        width: 240,
                        height: 240,
                        metadata: { content: hostedUrl },
                    },
                    {
                        id: "external-img",
                        type: "image",
                        title: "外链图片",
                        position: { x: 260, y: 0 },
                        width: 240,
                        height: 240,
                        metadata: { content: externalUrl },
                    },
                ],
                connections: [],
            },
            files: [
                { storageKey: "resource:old-hosted", path: "projects/old-canvas/files/hosted.png", mimeType: "image/png", bytes: 4 },
            ],
            drawingDocuments: [],
        }],
    });
    const zip = await createZip([
        { name: "projects.json", data: JSON.stringify(data) },
        { name: "projects/old-canvas/files/hosted.png", data: new Uint8Array([9, 8, 7, 6]) },
    ]);
    const state = memoryHost();
    const result = await restoreCanvasArchive(zip, state.host);
    expect(result.resourceIds).toHaveLength(1);
    expect(result.skippedFiles).toBeUndefined();
    expect(state.media.size).toBe(1);
    expect(Array.from(state.media.values())[0]).toEqual(new Uint8Array([9, 8, 7, 6]));

    const hosted = state.projects[0].nodes.find((item) => item.id === "hosted-img")!;
    expect(hosted.metadata?.storageKey).toBe(`resource:${result.resourceIds[0]}`);
    expect(hosted.metadata?.content).toBe(`/api/resources/${result.resourceIds[0]}/file`);
    expect(hosted.metadata?.assetId).toBeTruthy();

    const external = state.projects[0].nodes.find((item) => item.id === "external-img")!;
    expect(external.metadata?.content).toBe(externalUrl);
    expect(external.metadata?.storageKey).toBeUndefined();
});

test("restore remaps director panorama, object, and screenshot media into the destination workspace", async () => {
    const data = archiveData();
    const project = data.projects[0].project as Partial<CanvasProject>;
    project.directorScenes = [{
        id: "scene", panorama: { storageKey: "video:clip", url: "blob:old", rotation: 0 },
        objects: [{ id: "actor", storageKey: "video:clip", url: "blob:old", assetId: "old-asset" }],
        shots: [{ id: "shot", screenshots: [{ id: "capture", storageKey: "audio:voice", url: "blob:old" }] }],
    }] as CanvasProject["directorScenes"];
    const state = memoryHost();
    await restoreCanvasArchive(await validZip(data), state.host);
    const scene = state.projects[0].directorScenes[0];
    expect(scene.panorama?.storageKey).toStartWith("resource:");
    expect(scene.panorama?.url).toStartWith("/api/resources/");
    expect(scene.objects[0].assetId).toBeUndefined();
    expect(scene.objects[0].url).toBe(scene.panorama?.url);
    expect(scene.shots[0].screenshots?.[0].url).toStartWith("/api/resources/");
});

test("one immediate upload rejection waits for delayed success then cleans that artifact", async () => {
    let closed = false;
    let delayedDone = false;
    const activeProgress = new Set<string>();
    const { host, deleted, deletedResources, projects, folders } = memoryHost({
        onProjectProgress: (id, value) => { if (value) activeProgress.add(id); else activeProgress.delete(id); },
        uploadMedia: async (_blob, _kind, meta) => {
            if (closed) throw new Error("post-cleanup write");
            if (meta.storageKey === "video:clip") throw new Error("upload-fail");
            await new Promise((resolve) => setTimeout(resolve, 40));
            if (closed) throw new Error("post-cleanup write");
            delayedDone = true;
            return { storageKey: "resource:delayed", url: "/api/resources/delayed/file", resourceId: "delayed" };
        },
    });
    await expect(restoreCanvasArchive(await validZip(), host)).rejects.toThrow("upload-fail");
    expect(delayedDone).toBe(true);
    expect(deletedResources).toEqual(["delayed"]);
    expect(projects).toEqual([]);
    expect(folders).toEqual([]);
    expect(deleted).toEqual([]);
    expect(activeProgress.size).toBe(0);
    closed = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
});

test("asset binding failure removes import save progress before returning", async () => {
    const activeProgress = new Set<string>();
    const state = memoryHost({
        onProjectProgress: (id, value) => { if (value) activeProgress.add(id); else activeProgress.delete(id); },
        bindMediaAsset: async () => { throw new Error("binding-fail"); },
    });
    await expect(restoreCanvasArchive(await validZip(), state.host)).rejects.toThrow("binding-fail");
    expect(activeProgress.size).toBe(0);
    expect(state.projects).toEqual([]);
});

test("failed durable cleanup preserves the visible imported project and reports both failures", async () => {
    const state = memoryHost({
        persistProject: async () => { throw new Error("save-failed"); },
        deleteProjects: async () => { throw new Error("delete-failed"); },
    });
    let failure: unknown;
    try { await restoreCanvasArchive(await validZip(), state.host); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain("save-failed");
    expect((failure as AggregateError).errors[1].message).toBe("delete-failed");
    expect(state.projects).toHaveLength(1);
    expect(state.deletedResources).toEqual([]);
});

test("drawing failure waits for all sibling writes before deleting the imported project", async () => {
    const data = archiveData();
    data.projects[0].drawingDocuments.push({ ...data.projects[0].drawingDocuments[0], drawingId: "delayed" });
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const events: string[] = [];
    const state = memoryHost();
    const save = state.host.saveDrawing;
    const remove = state.host.deleteProjects;
    state.host.saveDrawing = async (...args) => {
        if (args[1] === "sketch") throw new Error("drawing-save-failed");
        started();
        await pending;
        events.push("drawing-saved");
        return save(...args);
    };
    state.host.deleteProjects = async (ids) => { events.push("cleanup"); await remove(ids); };
    const completion = restoreCanvasArchive(await validZip(data), state.host).catch((error: unknown) => error);
    await startedPromise;
    expect(events).toEqual([]);
    release();
    const failure = await completion;
    expect((failure as Error).message).toBe("drawing-save-failed");
    expect(events).toEqual(["drawing-saved", "cleanup"]);
    expect(state.projects).toEqual([]);
});

test("drawing receipt must contain the saved snapshot", async () => {
    const state = memoryHost({ loadDrawing: async (_projectId, drawingId) => ({ drawingId, revision: 1 }) });
    await expect(restoreCanvasArchive(await validZip(), state.host)).rejects.toThrow("画板未保存到工作区");
    expect(state.projects).toEqual([]);
});

test("missing folder cover degrades gracefully while present cover restores under the new folder ID", async () => {
    const data = archiveData({ folders: [{ id: "folder-old", name: "剧集", coverPath: "folders/old/cover.jpg", coverMimeType: "image/jpeg" }] });
    const archive = await openCanvasArchive(await validZip());
    archive.data = data as typeof archive.data;
    let restored: { id: string; bytes: number[]; mime: string } | undefined;
    const state = memoryHost({ restoreFolderCover: async (id, blob) => {
        restored = { id, bytes: [...new Uint8Array(await blob.arrayBuffer())], mime: blob.type };
    } });
    const partial = await restoreCanvasArchive(archive, state.host);
    expect(partial.skippedFiles).toEqual([{ owner: "剧集", reference: "folders/old/cover.jpg" }]);
    expect(state.folders).toEqual([{ id: "folder-1", name: "剧集" }]);
    expect(restored).toBeUndefined();
    archive.files.set("folders/old/cover.jpg", new Blob([new Uint8Array([7, 8, 9])]));
    const full = await restoreCanvasArchive(archive, state.host);
    expect(full.skippedFiles).toBeUndefined();
    expect(restored).toEqual({ id: "folder-2", bytes: [7, 8, 9], mime: "image/jpeg" });
});

test("native canonical restore reports local saving rather than cloud synchronization", async () => {
    const progress: Array<{ phase: string; message: string }> = [];
    const state = memoryHost({ usesCanonicalBackend: true, onProjectProgress: (_id, value) => { if (value) progress.push(value); } });
    await restoreCanvasArchive(await validZip(), state.host);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((value) => value.phase === "saving" && value.message.includes("本地"))).toBe(true);
});

