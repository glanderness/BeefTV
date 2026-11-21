import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import {
    createCanvasLibraryFolder,
    deleteCanvasLibraryFolder,
    hydrateCanvasLibraryFolders,
    persistCanvasFolderCover,
    renameCanvasLibraryFolder,
    resetCanvasFolderStorageForTests,
} from "@/lib/canvas/canvas-folder-storage";
import { apiClient } from "@/services/api/request";
import { peekCanvasOperationJournal, resetCanvasOperationJournalMemory } from "@/services/canvas-operation-journal";
import { resetLocalCanvasBackendSaveState } from "@/services/local-workspace-repository";
import {
    clearCanvasDocumentBase,
    recordCanvasDocumentBase,
    useCanvasStore,
    type CanvasFolder,
    type CanvasProject,
} from "@/stores/canvas/use-canvas-store";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function failure(status: number, msg: string, reason?: string) {
    return { data: { code: status, msg, data: null, reason }, status, statusText: "ERR", headers: {}, config: {} as never };
}

function requestBody(config: { data?: unknown }) {
    const data = config.data;
    if (typeof data === "string") {
        try { return JSON.parse(data) as Record<string, unknown>; } catch { return {}; }
    }
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function record(id: string, name: string, extras: Partial<CanvasFolder> = {}): CanvasFolder {
    return {
        id,
        name,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        ...extras,
    };
}

function canvasProject(id: string, folderId: string | undefined, revision: number, patch: Partial<CanvasProject> = {}): CanvasProject {
    return {
        id,
        folderId,
        revision,
        title: "画布",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [{ id: "n1", type: "image", title: "镜头1", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "基线" } }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
        ...patch,
    } as CanvasProject;
}

const spies: Array<{ mockRestore: () => void }> = [];
const memory = new Map<string, string>();

function stubJournalStorage() {
    spies.push(spyOn(localforage, "getItem").mockResolvedValue(null as never));
    spies.push(spyOn(localforage, "setItem").mockImplementation(async (_key, value) => value as never));
    spies.push(spyOn(localforage, "removeItem").mockResolvedValue(undefined as never));
}

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function browserLocalMode() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(false));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
}

function installWindow() {
    const original = globalThis.window;
    globalThis.window = {
        localStorage: {
            getItem: (key: string) => memory.get(String(key)) ?? null,
            setItem: (key: string, value: string) => { memory.set(String(key), String(value)); },
            removeItem: (key: string) => { memory.delete(String(key)); },
        },
        location: { protocol: "wails:" },
    } as never;
    return () => {
        if (original) globalThis.window = original;
        else delete (globalThis as { window?: unknown }).window;
    };
}

afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
    resetCanvasFolderStorageForTests();
    resetCanvasOperationJournalMemory();
    resetLocalCanvasBackendSaveState();
    clearCanvasDocumentBase("c1");
    clearCanvasDocumentBase("c2");
    useCanvasStore.setState({ folders: [], projects: [] });
    memory.clear();
});

describe("canvas folder storage", () => {
    test("hydrate uses SQLite as single source of truth and drops stale local-only folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({
            folders: [record("stale-cache", "旧缓存"), record("remote-1", "旧标题")],
            hydrated: true,
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-folders")) {
                    return envelope({ folders: [record("remote-1", "已同步", { coverResourceId: "res-cover" })] });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await hydrateCanvasLibraryFolders();
            });
            const folders = useCanvasStore.getState().folders;
            expect(folders.map((folder) => folder.id)).toEqual(["remote-1"]);
            expect(folders[0]?.name).toBe("已同步");
            expect(folders[0]?.coverResourceId).toBe("res-cover");
            expect(folders[0]?.coverDataUrl).toContain("/resources/res-cover/file");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("hydrate read error rejects and preserves current folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("keep", "保留中")], hydrated: true });
        try {
            await withAdapter(async () => failure(503, "服务暂时不可用，请稍后重试"), async () => {
                await expect(hydrateCanvasLibraryFolders()).rejects.toThrow(/服务暂时不可用/);
            });
            expect(useCanvasStore.getState().folders.map((folder) => folder.id)).toEqual(["keep"]);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("concurrent rename serializes writes and keeps the later successful edit", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "原名")], hydrated: true });
        const entered = deferred();
        const gate = deferred();
        const names: string[] = [];
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/canvas-folders/folder-1")) {
                    const body = requestBody(config) as { folder: { name: string } };
                    names.push(body.folder.name);
                    if (body.folder.name === "第一次") {
                        entered.resolve();
                        await gate.promise;
                        return failure(500, "保存失败");
                    }
                    return envelope({ folder: record("folder-1", body.folder.name, { updatedAt: "2026-10-02T00:00:00.000Z" }) });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const first = renameCanvasLibraryFolder("folder-1", "第一次");
                await entered.promise;
                const second = renameCanvasLibraryFolder("folder-1", "第二次");
                gate.resolve();
                await expect(first).rejects.toThrow(/保存失败/);
                await second;
                expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.name).toBe("第二次");
                expect(names).toEqual(["第一次", "第二次"]);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("delete prevents a stale in-flight hydrate GET from restoring the folder", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "待删")], hydrated: true });
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") {
                    entered.resolve();
                    await gate.promise;
                    return envelope({ folders: [record("folder-1", "待删")] });
                }
                if (String(config.method).toLowerCase() === "delete") return envelope({ id: "folder-1" });
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const hydrating = hydrateCanvasLibraryFolders();
                await entered.promise;
                await deleteCanvasLibraryFolder("folder-1");
                expect(useCanvasStore.getState().folders.some((folder) => folder.id === "folder-1")).toBe(false);
                gate.resolve();
                await hydrating;
                expect(useCanvasStore.getState().folders.some((folder) => folder.id === "folder-1")).toBe(false);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("create and rename during slow hydrate survive when hydrate resolves", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "旧名")], hydrated: true });
        const entered = deferred();
        const gate = deferred();
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get") {
                    entered.resolve();
                    await gate.promise;
                    return envelope({ folders: [record("folder-1", "旧名")] });
                }
                if (String(config.method).toLowerCase() === "put") {
                    const body = requestBody(config) as { folder: CanvasFolder };
                    return envelope({ folder: { ...body.folder, updatedAt: "2026-10-02T00:00:00.000Z" } });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                const hydrating = hydrateCanvasLibraryFolders();
                await entered.promise;
                const createdId = await createCanvasLibraryFolder("新建剧集");
                await renameCanvasLibraryFolder("folder-1", "改名后");
                gate.resolve();
                await hydrating;
                const folders = useCanvasStore.getState().folders;
                expect(folders.find((folder) => folder.id === createdId)?.name).toBe("新建剧集");
                expect(folders.find((folder) => folder.id === "folder-1")?.name).toBe("改名后");
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("create failure and invalid PUT receipts reject without adding phantom folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "原名")], hydrated: true });
        try {
            await withAdapter(async () => failure(500, "文件夹没有保存成功"), async () => {
                await expect(createCanvasLibraryFolder("新建")).rejects.toThrow(/文件夹没有保存成功/);
            });
            expect(useCanvasStore.getState().folders.map((folder) => folder.id)).toEqual(["folder-1"]);

            await withAdapter(async () => envelope({}), async () => {
                await expect(renameCanvasLibraryFolder("folder-1", "空回执")).rejects.toThrow(/文件夹没有保存成功/);
            });
            expect(useCanvasStore.getState().folders[0]?.name).toBe("原名");

            await withAdapter(async () => envelope({ folder: record("other-id", "错身份") }), async () => {
                await expect(renameCanvasLibraryFolder("folder-1", "错身份")).rejects.toThrow(/文件夹没有保存成功/);
            });
            expect(useCanvasStore.getState().folders[0]?.name).toBe("原名");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("cover upload stores coverResourceId and keeps data URLs out of localStorage", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "封面")], hydrated: true });
        const cover = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let uploadedCover = false;
        let savedCoverId = "";
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "post" && String(config.url).includes("/resources")) {
                    uploadedCover = true;
                    return envelope({ resource: { id: "res-cover-1", status: "ready" } });
                }
                if (String(config.method).toLowerCase() === "put" && String(config.url).includes("/canvas-folders/folder-1")) {
                    const body = requestBody(config) as { folder: CanvasFolder };
                    savedCoverId = body.folder.coverResourceId || "";
                    return envelope({ folder: record("folder-1", body.folder.name, { coverResourceId: savedCoverId, updatedAt: "2026-10-02T00:00:00.000Z" }) });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await persistCanvasFolderCover("folder-1", cover);
            });
            expect(uploadedCover).toBe(true);
            expect(savedCoverId).toBe("res-cover-1");
            const folder = useCanvasStore.getState().folders.find((item) => item.id === "folder-1");
            expect(folder?.coverResourceId).toBe("res-cover-1");
            expect(folder?.coverDataUrl).toContain("/resources/res-cover-1/file");
            expect(JSON.stringify([...memory.values()])).not.toContain("data:image/png;base64");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("folder delete applies canonical canvas receipt and keeps unrelated canvases", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        stubJournalStorage();
        const clean = canvasProject("c1", "folder-1", 1);
        const unrelated = canvasProject("c2", "other-folder", 3, { title: "别的画布", nodes: [{ id: "n2", type: "image", title: "别的镜头", position: { x: 1, y: 1 }, width: 320, height: 220, metadata: { prompt: "别的" } }] });
        useCanvasStore.setState({
            folders: [record("folder-1", "待删")],
            projects: [clean, unrelated],
            hydrated: true,
        });
        recordCanvasDocumentBase(clean, "owner-a");
        recordCanvasDocumentBase(unrelated, "owner-a");
        const receipt = canvasProject("c1", undefined, 2, { updatedAt: "2026-10-02T00:00:00.000Z" });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "delete" && String(config.url).includes("/canvas-folders/folder-1")) {
                    return envelope({ id: "folder-1" });
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-projects/c1")) {
                    return envelope({ project: receipt });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await deleteCanvasLibraryFolder("folder-1");
            });
            const applied = useCanvasStore.getState().projects.find((project) => project.id === "c1");
            expect(applied?.folderId).toBeUndefined();
            expect(applied?.revision).toBe(2);
            expect(applied?.nodes).toEqual(receipt.nodes);
            expect(useCanvasStore.getState().projects.find((project) => project.id === "c2")?.folderId).toBe("other-folder");
            expect(useCanvasStore.getState().folders.some((folder) => folder.id === "folder-1")).toBe(false);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("folder delete keeps a newer unsaved canvas edit and merges the remote receipt", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        stubJournalStorage();
        const baseline = canvasProject("c1", "folder-1", 1);
        const localNodes = [{ id: "n-local", type: "image" as const, title: "用户刚改", position: { x: 8, y: 8 }, width: 320, height: 220, metadata: { prompt: "未保存" } }];
        const live = { ...baseline, nodes: localNodes };
        useCanvasStore.setState({
            folders: [record("folder-1", "待删")],
            projects: [live],
            hydrated: true,
        });
        recordCanvasDocumentBase(baseline, "owner-a");
        const receipt = canvasProject("c1", undefined, 4, {
            nodes: [{ id: "n-remote", type: "image", title: "服务端改过", position: { x: 0, y: 0 }, width: 320, height: 220, metadata: { prompt: "远端" } }],
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "delete" && String(config.url).includes("/canvas-folders/folder-1")) {
                    return envelope({ id: "folder-1" });
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-projects/c1")) {
                    return envelope({ project: receipt });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await deleteCanvasLibraryFolder("folder-1");
            });
            const kept = useCanvasStore.getState().projects.find((project) => project.id === "c1");
            expect(kept?.nodes.map((node) => node.id)).toEqual(["n-local", "n-remote"]);
            expect(kept?.nodes[0]).toEqual(localNodes[0]);
            expect(kept?.folderId).toBeUndefined();
            expect(peekCanvasOperationJournal("c1", "owner-a")?.confirmedRevision).toBe(4);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("cover PUT failure and delete failure reject while preserving existing folder state", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "封面", { coverResourceId: "res-old" })], hydrated: true });
        const cover = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "post" && String(config.url).includes("/resources")) {
                    return envelope({ resource: { id: "res-new", status: "ready" } });
                }
                if (String(config.method).toLowerCase() === "put") {
                    return failure(500, "封面没有保存成功");
                }
                if (String(config.method).toLowerCase() === "delete") {
                    return failure(500, "删除失败");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await expect(persistCanvasFolderCover("folder-1", cover)).rejects.toThrow(/封面没有保存成功/);
                expect(useCanvasStore.getState().folders[0]?.coverResourceId).toBe("res-old");

                await expect(deleteCanvasLibraryFolder("folder-1")).rejects.toThrow(/删除失败/);
                expect(useCanvasStore.getState().folders.map((folder) => folder.id)).toEqual(["folder-1"]);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("folder delete clears local folderId even if subsequent canvas refresh fails", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        stubJournalStorage();
        const project = canvasProject("c1", "folder-1", 1);
        useCanvasStore.setState({
            folders: [record("folder-1", "待删")],
            projects: [project],
            hydrated: true,
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "delete" && String(config.url).includes("/canvas-folders/folder-1")) {
                    return envelope({ id: "folder-1" });
                }
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-projects/c1")) {
                    return failure(503, "画布刷新暂时不可用");
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await deleteCanvasLibraryFolder("folder-1");
            });
            expect(useCanvasStore.getState().folders).toEqual([]);
            expect(useCanvasStore.getState().projects.find((item) => item.id === "c1")?.folderId).toBeUndefined();
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("browser-local mode manages folders directly in canvas store without backend requests", async () => {
        const restore = switchScope("browser-only");
        const restoreWindow = installWindow();
        browserLocalMode();
        try {
            await withAdapter(async (config) => {
                throw new Error(`unexpected network ${config.method} ${config.url}`);
            }, async () => {
                const id = await createCanvasLibraryFolder("浏览器本地");
                await renameCanvasLibraryFolder(id, "本地改名");
                await persistCanvasFolderCover(id, "data:image/png;base64,abc");
                const current = useCanvasStore.getState().folders.find((folder) => folder.id === id);
                expect(current?.name).toBe("本地改名");
                expect(current?.coverDataUrl).toBe("data:image/png;base64,abc");
                await deleteCanvasLibraryFolder(id);
                expect(useCanvasStore.getState().folders).toEqual([]);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });
});
