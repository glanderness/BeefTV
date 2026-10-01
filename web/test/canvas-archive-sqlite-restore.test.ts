import { afterAll, afterEach, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { restoreCanvasArchive } from "@/lib/canvas/canvas-archive-restore";
import { openCanvasArchive } from "@/lib/canvas/canvas-export";
import { createZip } from "@/lib/zip";
import { apiClient, configureApiRuntime, http } from "@/services/api/request";
import { resetCanvasOperationJournalMemory } from "@/services/canvas-operation-journal";
import { syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const backendDir = resolve(import.meta.dir, "../../backend");
const serverBin = join(tmpdir(), `beeftv-archive-restore-server-${process.pid}`);
const videoBytes = new Uint8Array([9, 8, 7, 6]);
const audioBytes = new Uint8Array([5, 4, 3, 2, 1]);
let built = false;

type RunningServer = {
    dataDir: string;
    port: number;
    process: Subprocess;
};

function resetStores() {
    useCanvasStore.setState({ projects: [], folders: [], hydrated: true });
    useAssetStore.setState({ assets: [], hydrated: true });
    resetCanvasOperationJournalMemory();
}

async function buildServer() {
    if (built) return;
    const build = spawn(["go", "build", "-o", serverBin, "./cmd/server"], {
        cwd: backendDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CGO_ENABLED: "1" },
    });
    const code = await build.exited;
    if (code !== 0) {
        const err = await new Response(build.stderr).text();
        throw new Error(`go build failed: ${err}`);
    }
    built = true;
}

async function waitReady(port: number, process: Subprocess) {
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
        if (process.exitCode != null) {
            const err = process.stderr ? await new Response(process.stderr).text() : "";
            throw new Error(`backend exited ${process.exitCode}: ${err || last}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
            last = await response.text();
            if (response.ok && last.includes('"code":0')) return;
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        await Bun.sleep(200);
    }
    throw new Error(`backend not ready: ${last}`);
}

function freePort() {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("ok"); } });
    const port = probe.port;
    probe.stop(true);
    return port;
}

async function startServer(dataDir: string): Promise<RunningServer> {
    await buildServer();
    const port = freePort();
    const child = spawn([serverBin], {
        cwd: backendDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            CANVAS_BACKEND_DATA_DIR: dataDir,
            CANVAS_BACKEND_ADDR: `127.0.0.1:${port}`,
            CANVAS_AUTO_MIGRATE: "true",
            CANVAS_DATABASE_DRIVER: "sqlite",
            CANVAS_CORS_ORIGINS: "*",
        },
    });
    await waitReady(port, child);
    return { dataDir, port, process: child };
}

async function stopServer(server: RunningServer | undefined) {
    if (!server) return;
    server.process.kill();
    await Promise.race([server.process.exited, Bun.sleep(5_000)]);
}

function connect(port: number) {
    configureApiRuntime(`http://127.0.0.1:${port}/api`, "");
    apiClient.defaults.timeout = 20_000;
}

async function listProjects() {
    const data = await http.get<{ projects: Array<{ id: string }> }>("/canvas-projects");
    return data.projects || [];
}

async function readProject(id: string) {
    const data = await http.get<{ project: {
        id: string;
        workspaceProjectId?: string;
        nodes: Array<{ metadata?: { storageKey?: string; prompt?: string; assetId?: string } }>;
        timeline?: { clips: Array<{ directMedia?: { storageKey?: string; assetId?: string } }> };
    } }>(`/canvas-projects/${encodeURIComponent(id)}`);
    return data.project;
}

async function readResourceBytes(resourceId: string) {
    const response = await apiClient.get<ArrayBuffer>(`/resources/${encodeURIComponent(resourceId)}/file?proxy=1`, { responseType: "arraybuffer" });
    return new Uint8Array(response.data);
}

function resourceId(storageKey?: string) {
    return storageKey?.startsWith("resource:") ? storageKey.slice("resource:".length) : "";
}

async function fixtureZip() {
    return createZip([
        {
            name: "projects.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 4,
                exportedAt: "2026-10-02T00:00:00.000Z",
                projects: [{
                    project: {
                        id: "old-canvas",
                        workspaceProjectId: "old-workspace",
                        title: "持久画布",
                        revision: 0,
                        nodes: [{
                            id: "n-video",
                            type: "video",
                            title: "镜头",
                            position: { x: 0, y: 0 },
                            width: 320,
                            height: 180,
                            metadata: {
                                storageKey: "video:clip",
                                content: "blob:expired",
                                prompt: "描述里提到 data:image/png 和 blob:expired，但不是媒体文件",
                            },
                        }],
                        connections: [],
                        timeline: {
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
                        },
                    },
                    files: [
                        { storageKey: "video:clip", path: "projects/old-canvas/files/clip.mp4", mimeType: "video/mp4", bytes: videoBytes.byteLength },
                        { storageKey: "audio:voice", path: "projects/old-canvas/files/voice.wav", mimeType: "audio/wav", bytes: audioBytes.byteLength },
                    ],
                }],
            }),
        },
        { name: "projects/old-canvas/files/clip.mp4", data: videoBytes },
        { name: "projects/old-canvas/files/voice.wav", data: audioBytes },
    ]);
}

afterEach(() => {
    void globalThis.window;
    configureApiRuntime("/api", "");
    resetStores();
});

afterAll(() => {
    rmSync(serverBin, { force: true });
});

test("valid archive restores into isolated SQLite, survives backend restart, and keeps media bytes plus timeline", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "beeftv-archive-sqlite-"));
    let server: RunningServer | undefined;
    try {
        server = await startServer(dataDir);
        connect(server.port);
        resetStores();
        const zip = await fixtureZip();
        const result = await restoreCanvasArchive(zip);
        expect(result.storage).toBe("backend");
        expect(result.count).toBe(1);
        expect(result.projectIds[0]).not.toBe("old-canvas");
        const listed = await listProjects();
        expect(listed.map((item) => item.id)).toEqual(result.projectIds);
        const saved = await readProject(result.projectIds[0]);
        expect(saved.id).toBe(result.projectIds[0]);
        expect(saved.workspaceProjectId).not.toBe("old-workspace");
        expect(saved.nodes[0].metadata?.storageKey).toStartWith("resource:");
        expect(saved.nodes[0].metadata?.prompt).toContain("data:image/png");
        expect(saved.nodes[0].metadata?.assetId).toBeTruthy();
        const clipKey = saved.timeline?.clips[0].directMedia?.storageKey;
        expect(clipKey).toStartWith("resource:");
        const videoId = resourceId(saved.nodes[0].metadata?.storageKey);
        const audioId = resourceId(clipKey);
        expect(await readResourceBytes(videoId)).toEqual(videoBytes);
        expect(await readResourceBytes(audioId)).toEqual(audioBytes);

        await stopServer(server);
        server = await startServer(dataDir);
        connect(server.port);
        const restarted = await readProject(result.projectIds[0]);
        expect(restarted.nodes[0].metadata?.storageKey).toBe(saved.nodes[0].metadata?.storageKey);
        expect(restarted.timeline?.clips[0].directMedia?.storageKey).toBe(clipKey);
        expect(await readResourceBytes(videoId)).toEqual(videoBytes);
        expect(await readResourceBytes(audioId)).toEqual(audioBytes);

        const retry = await restoreCanvasArchive(zip);
        expect(retry.projectIds[0]).not.toBe(result.projectIds[0]);
        expect(retry.projectIds[0]).not.toBe("old-canvas");
        const afterRetry = await listProjects();
        expect(afterRetry.map((item) => item.id).sort()).toEqual([...result.projectIds, ...retry.projectIds].sort());
        const retried = await readProject(retry.projectIds[0]);
        expect(retried.id).not.toBe("old-canvas");
        expect(retried.workspaceProjectId).not.toBe("old-workspace");
        expect(retried.workspaceProjectId).not.toBe(saved.workspaceProjectId);
        expect(retried.nodes[0].metadata?.storageKey).toStartWith("resource:");
    } finally {
        await stopServer(server);
        rmSync(dataDir, { recursive: true, force: true });
    }
}, 180_000);

test("missing archive entry and persist failure do not create a saved SQLite canvas", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "beeftv-archive-sqlite-neg-"));
    let server: RunningServer | undefined;
    try {
        server = await startServer(dataDir);
        connect(server.port);
        resetStores();
        const missing = await createZip([{
            name: "projects.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 4,
                projects: [{
                    project: {
                        id: "broken",
                        title: "损坏画布",
                        nodes: [{ id: "n1", type: "video", title: "镜头", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { storageKey: "video:missing" } }],
                        connections: [],
                    },
                    files: [{ storageKey: "video:missing", path: "projects/broken/files/missing.mp4", mimeType: "video/mp4", bytes: 3 }],
                }],
            }),
        }]);
        await expect(openCanvasArchive(missing)).rejects.toThrow("missing.mp4");
        await expect(restoreCanvasArchive(missing)).rejects.toThrow("missing.mp4");
        expect(await listProjects()).toEqual([]);
        expect(useCanvasStore.getState().projects).toEqual([]);

        const zip = await fixtureZip();
        await expect(restoreCanvasArchive(zip, {
            persistProject: async (id) => {
                await syncLocalCanvasProjectToBackend(id);
                throw new Error("画布未保存到工作区");
            },
        })).rejects.toThrow("画布未保存到工作区");
        expect(useCanvasStore.getState().projects).toEqual([]);
        expect(await listProjects()).toEqual([]);
    } finally {
        await stopServer(server);
        rmSync(dataDir, { recursive: true, force: true });
    }
}, 180_000);
