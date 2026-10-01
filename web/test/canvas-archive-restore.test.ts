import { afterEach, expect, test } from "bun:test";
import { zipSync } from "fflate";

import { restoreCanvasArchive, type CanvasArchiveRestoreHost } from "@/lib/canvas/canvas-archive-restore";
import { openCanvasArchive } from "@/lib/canvas/canvas-export";
import { ARCHIVE_MAX_ENTRY_BYTES, ARCHIVE_MAX_FILES, ARCHIVE_MAX_TOTAL_BYTES, createZip } from "@/lib/zip";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

const encoder = new TextEncoder();

afterEach(() => {
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
            directMedia: { id: "m1", kind: "audio", title: "配音", storageKey: "audio:voice", url: "blob:expired" },
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
                folderId: "folder-old",
                title: "测试画布",
                nodes: [videoNode(), drawingNode()],
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
    const deleted: string[] = [];
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
                directorScenes: [],
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
        bindMediaAsset: async () => `asset-${++assetSeq}`,
        saveDrawing: async (projectId, drawingId) => {
            drawings.push(`${projectId}:${drawingId}`);
            return { version: 2, engine: "excalidraw", snapshot: {}, revision: 1, updatedAt: "2026-10-02T00:00:00.000Z", shapeCount: 0, pageCount: 1 };
        },
        ...overrides,
    };
    return { host, folders, projects, media, drawings, deleted };
}

test("preflight rejects missing media, invalid project, version, duplicate IDs, and data/blob keys before writes", async () => {
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
    await expect(restoreCanvasArchive(missing, host)).rejects.toThrow("missing.mp4");
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
    const { host, folders, projects, media, drawings } = memoryHost();
    const result = await restoreCanvasArchive(await validZip(), host);
    expect(result.storage).toBe("backend");
    expect(result.count).toBe(1);
    expect(result.projectIds).toEqual(["imported-1"]);
    expect(result.projectIds).not.toContain("old-canvas");
    expect(folders).toEqual([{ id: "folder-1", name: "剧集" }]);
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("imported-1");
    expect(projects[0].workspaceProjectId).toBe("imported-1");
    expect(projects[0].folderId).toBe("folder-1");
    const node = projects[0].nodes.find((item) => item.type === "video")!;
    expect(node.metadata?.storageKey).toStartWith("resource:");
    expect(node.metadata?.content).toStartWith("/api/resources/");
    expect(node.metadata?.prompt).toContain("data:image/png");
    expect(node.metadata?.assetId).toBe("asset-1");
    const clip = projects[0].timeline?.clips[0].directMedia;
    expect(clip?.storageKey).toStartWith("resource:");
    expect(clip?.url).toStartWith("/api/resources/");
    expect(clip?.assetId).toBe("asset-2");
    expect([...media.keys()]).toHaveLength(2);
    expect(drawings).toEqual(["imported-1:sketch"]);
});

test("persist failure does not report saved and rolls back this attempt", async () => {
    const { host, folders, projects, deleted } = memoryHost({
        persistProject: async () => {
            throw new Error("画布未保存到工作区");
        },
    });
    await expect(restoreCanvasArchive(await validZip(), host)).rejects.toThrow("画布未保存到工作区");
    expect(projects).toEqual([]);
    expect(folders).toEqual([]);
    expect(deleted).toEqual(["imported-1"]);
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
