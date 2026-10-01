import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
import {
    createCanvasLibraryFolder,
    deleteCanvasLibraryFolder,
    hydrateCanvasLibraryFolders,
    peekCanvasFolderPendingForTests,
    persistCanvasFolderCover,
    renameCanvasLibraryFolder,
    resetCanvasFolderStorageForTests,
    setCanvasFolderDigestDelayForTests,
} from "@/lib/canvas/canvas-folder-storage";
import { apiClient } from "@/services/api/request";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

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

function failure(status: number, msg: string) {
    return { data: { code: status, msg, data: null }, status, statusText: "ERR", headers: {}, config: {} as never };
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

async function withAdapter<T>(adapter: NonNullable<typeof apiClient.defaults.adapter>, run: () => Promise<T>) {
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = adapter;
    try {
        return await run();
    } finally {
        apiClient.defaults.adapter = previous;
    }
}

const spies: Array<{ mockRestore: () => void }> = [];
const memory = new Map<string, string>();

function desktopBackend() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
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
    useCanvasStore.setState({ folders: [] });
    memory.clear();
    setCanvasFolderDigestDelayForTests();
});

describe("canvas folder storage", () => {
    test("hydrate preserves cache-only folders as unsaved pending", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({
            folders: [record("legacy", "本地剧集"), record("remote-1", "已同步")],
            hydrated: true,
        });
        try {
            await withAdapter(async (config) => {
                if (String(config.method).toLowerCase() === "get" && String(config.url).includes("/canvas-folders")) {
                    return envelope({ folders: [record("remote-1", "已同步")] });
                }
                throw new Error(`unexpected ${config.method} ${config.url}`);
            }, async () => {
                await hydrateCanvasLibraryFolders(captureUserScope());
            });
            const folders = useCanvasStore.getState().folders;
            expect(folders.find((folder) => folder.id === "legacy")?.name).toBe("本地剧集");
            expect(folders.find((folder) => folder.id === "legacy")?.unsaved).toBe(true);
            expect(folders.find((folder) => folder.id === "remote-1")?.unsaved).toBeUndefined();
            expect(peekCanvasFolderPendingForTests("owner-a").legacy?.kind).toBe("upsert");
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("read error is not success and does not drop pending folders", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("legacy", "本地剧集")], hydrated: true });
        try {
            await withAdapter(async () => failure(503, "服务暂时不可用，请稍后重试"), async () => {
                await expect(hydrateCanvasLibraryFolders(captureUserScope())).rejects.toThrow(/服务暂时不可用/);
            });
            expect(useCanvasStore.getState().folders.some((folder) => folder.id === "legacy")).toBe(true);
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("concurrent rename keeps the later edit when an older PUT returns", async () => {
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
                const first = renameCanvasLibraryFolder("folder-1", "第一次", captureUserScope());
                await entered.promise;
                const second = renameCanvasLibraryFolder("folder-1", "第二次", captureUserScope());
                gate.resolve();
                await expect(first).rejects.toThrow(/保存失败/);
                await second;
                expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.name).toBe("第二次");
                expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.unsaved).toBeUndefined();
                expect(names).toEqual(["第一次", "第二次"]);
            });
        } finally {
            restoreWindow();
            restore();
        }
    });

    test("delete pending prevents a stale list read from restoring the folder", async () => {
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
                const hydrating = hydrateCanvasLibraryFolders(captureUserScope());
                await entered.promise;
                await deleteCanvasLibraryFolder("folder-1", captureUserScope());
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

    test("A-B-A during cover hash does not write the new epoch", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        useCanvasStore.setState({ folders: [record("folder-1", "封面")], hydrated: true });
        const digest = deferred();
        const puts: string[] = [];
        let delayedOnce = false;
        setCanvasFolderDigestDelayForTests(async () => {
            if (delayedOnce) return;
            delayedOnce = true;
            await digest.promise;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => ({ blob: async () => new Blob(["cover"], { type: "image/jpeg" }) })) as never;
        try {
            const firstEpoch = captureUserScope();
            const pending = withAdapter(async (config) => {
                puts.push(`${String(config.method)} ${String(config.url)}`);
                if (String(config.url).includes("/resources")) return envelope({ resource: { id: "cover-1", status: "ready" } });
                return envelope({ folder: record("folder-1", "封面", { coverResourceId: "cover-1" }) });
            }, async () => persistCanvasFolderCover("folder-1", "data:image/jpeg;base64,aaaa", firstEpoch));

            await new Promise((resolve) => setTimeout(resolve, 10));
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            digest.resolve();
            await expect(pending).rejects.toBeInstanceOf(UserScopeAbandonedError);
            expect(puts.some((item) => String(item).includes("/canvas-folders/"))).toBe(false);
            expect(useCanvasStore.getState().folders.find((folder) => folder.id === "folder-1")?.coverResourceId).toBeUndefined();
        } finally {
            globalThis.fetch = originalFetch;
            restoreWindow();
            restore();
        }
    });

    test("create stays visible as unsaved when the backend write fails", async () => {
        const restore = switchScope("owner-a");
        const restoreWindow = installWindow();
        desktopBackend();
        try {
            await withAdapter(async () => failure(500, "文件夹没有保存成功"), async () => {
                await expect(createCanvasLibraryFolder("新建", captureUserScope())).rejects.toThrow(/文件夹没有保存成功/);
            });
            const created = useCanvasStore.getState().folders.find((folder) => folder.name === "新建");
            expect(created?.unsaved).toBe(true);
            expect(created?.saveError).toMatch(/文件夹没有保存成功/);
        } finally {
            restoreWindow();
            restore();
        }
    });
});
