import { afterEach, describe, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { apiClient } from "@/services/api/request";
import { getCanvasHydrationHealth, setCanvasHydrationHealth } from "@/services/canvas-hydration-health";
import { hydrateLocalCanvasProjectsFromBackend } from "@/services/local-workspace-repository";
import { applyUserSession } from "@/lib/user-session";
import { getActiveUserScope, scopedStorageKey, setActiveUserScope, setWorkspaceStorageScope } from "@/lib/user-scope";
import { CANVAS_DRAFTS_KEY, CANVAS_STORE_KEY, flushCanvasStorePersistence, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { serializeCanvasStorageDocument } from "@/lib/canvas/canvas-storage-revision";

type SpyHandle = { mockRestore: () => void };

function makeDraftCanvas(id: string, title: string): CanvasProject {
    const now = "2026-11-21T10:00:00.000Z";
    return {
        id,
        revision: 0,
        workspaceProjectId: id,
        title,
        createdAt: now,
        updatedAt: now,
        nodes: [{ id: `${id}-n1`, type: "text", position: { x: 0, y: 0 }, data: { title: "草稿", content: "unsaved" } }] as unknown as CanvasProject["nodes"],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dark",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

function envelope<T>(data: T) {
    return {
        data: { code: 0, data, msg: "ok" },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {} as never,
    };
}

function makeWorkspacePayload(scope: string) {
    return {
        contractVersion: 1,
        profile: "local",
        capabilities: { localAssets: true, providerCalls: true },
        user: { id: scope, username: "local", displayName: "本地工作区", role: "owner", status: "active", createdAt: "2026-11-21T00:00:00Z", updatedAt: "2026-11-21T00:00:00Z" },
        workspace: { id: scope, name: "本地工作区", owner: "local", storage: "sqlite" },
        storageMode: "local",
        runtimeLimits: { maxUploadMB: 256, maxStructuredDataMB: 256 },
        features: {},
    } as never;
}

describe("desktop cold-boot canvas hydration", () => {
    const spies: SpyHandle[] = [];
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalScope = getActiveUserScope();
    const originalAdapter = apiClient.defaults.adapter;

    function installDesktopWindow() {
        const ls = new Map<string, string>();
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                location: { protocol: "wails:", hostname: "wails.localhost", href: "wails://wails.localhost/" },
                localStorage: {
                    getItem: (key: string) => ls.get(key) ?? null,
                    setItem: (key: string, value: string) => { ls.set(key, value); },
                    removeItem: (key: string) => { ls.delete(key); },
                },
            },
        });
    }

    afterEach(async () => {
        for (const spy of spies.splice(0)) spy.mockRestore();
        apiClient.defaults.adapter = originalAdapter;
        await flushCanvasStorePersistence().catch(() => undefined);
        useCanvasStore.setState({ projects: [] });
        setCanvasHydrationHealth({ error: "", loading: true });
        if (originalWindowDescriptor) Object.defineProperty(globalThis, "window", originalWindowDescriptor);
        else Reflect.deleteProperty(globalThis, "window");
        setActiveUserScope(originalScope);
    });

    test("preserves SQLite-hydrated summary canvases across applyUserSession on desktop cold boot with empty IndexedDB", async () => {
        installDesktopWindow();
        const scope = "desktop-cold-boot-30";
        const memory = new Map<string, string>();
        const detailGets: string[] = [];

        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        apiClient.defaults.adapter = async (config) => {
            const url = String(config.url || "");
            if (url === "/canvas-projects") {
                const projects = Array.from({ length: 30 }, (_, index) => ({
                    id: `lazy-${index + 1}`,
                    workspaceProjectId: `lazy-${index + 1}`,
                    title: `压测画布 ${index + 1}`,
                    revision: 1,
                    createdAt: "2026-11-21T10:00:00.000Z",
                    updatedAt: "2026-11-21T10:00:00.000Z",
                    nodeCount: 2,
                    previewNodes: [],
                    localMediaKeys: [`image:${scope}:key-${index + 1}`],
                }));
                return envelope({ projects, hasMore: false, page: 1, pageSize: 50, total: 30 });
            }
            if (url.startsWith("/canvas-projects/")) {
                detailGets.push(url);
                return envelope({ project: null });
            }
            return envelope({ assets: [] });
        };

        // Mirror exact standalone desktop startup:
        // 1. ensureWorkspaceStorageHydrated() sets scope, rehydrates cache, hydrates SQLite summaries
        setWorkspaceStorageScope(scope);
        await useCanvasStore.persist.rehydrate();
        expect(await hydrateLocalCanvasProjectsFromBackend()).toBe(true);
        expect(useCanvasStore.getState().projects).toHaveLength(30);
        expect(detailGets).toEqual([]);

        // 2. WorkspaceBootstrapHydrator mounts and calls applyUserSession(payload)
        await applyUserSession(makeWorkspacePayload(scope));

        // All 30 SQLite summaries & media protection keys must remain intact for Home & GC!
        const live = useCanvasStore.getState().projects;
        expect(live).toHaveLength(30);
        expect(live[0]?.id).toBe("lazy-1");
        expect(live[0]?.summaryOnly).toBe(true);
        expect(live[0]?.summaryMediaKeys).toEqual([`image:${scope}:key-1`]);
        expect(getCanvasHydrationHealth()).toEqual({ error: "", loading: false, scope });
        expect(detailGets).toEqual([]);
    });

    test("preserves unsaved desktop CANVAS_DRAFTS_KEY projects across applyUserSession when CANVAS_STORE_KEY is absent", async () => {
        installDesktopWindow();
        const scope = "desktop-unsaved-draft-scope";
        const memory = new Map<string, string>();
        const draft = makeDraftCanvas("draft-only-1", "未保存草稿");
        setWorkspaceStorageScope(scope);
        memory.set(
            scopedStorageKey(CANVAS_DRAFTS_KEY, scope),
            serializeCanvasStorageDocument({ state: { projects: [draft] }, version: 0, storageRevision: 1 }),
        );

        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        apiClient.defaults.adapter = async () => envelope({ assets: [] });

        // Simulate backend list hydration failure before applyUserSession runs
        setCanvasHydrationHealth({ error: "项目暂时无法读取", loading: false });
        await applyUserSession(makeWorkspacePayload(scope));

        expect(memory.has(scopedStorageKey(CANVAS_STORE_KEY, scope))).toBe(false);
        expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(["draft-only-1"]);
        expect(getCanvasHydrationHealth().error).toBe("项目暂时无法读取");
    });

    test("resets projects and canvas hydration health when switching to an empty workspace scope", async () => {
        installDesktopWindow();
        const scopeA = "desktop-scope-a";
        const scopeB = "desktop-scope-b";
        const memory = new Map<string, string>();

        spies.push(spyOn(localforage, "getItem").mockImplementation(async (key) => memory.get(String(key)) ?? null));
        spies.push(spyOn(localforage, "setItem").mockImplementation(async (key, value) => {
            memory.set(String(key), String(value));
            return value;
        }));
        spies.push(spyOn(localforage, "removeItem").mockImplementation(async (key) => {
            memory.delete(String(key));
        }));

        apiClient.defaults.adapter = async (config) => {
            if (String(config.url || "") === "/canvas-projects") {
                return envelope({
                    projects: [{
                        id: "canvas-in-a",
                        workspaceProjectId: "canvas-in-a",
                        title: "A 画布",
                        revision: 1,
                        createdAt: "2026-11-21T10:00:00.000Z",
                        updatedAt: "2026-11-21T10:00:00.000Z",
                        nodeCount: 1,
                        previewNodes: [],
                    }],
                    hasMore: false,
                });
            }
            return envelope({ assets: [] });
        };

        setWorkspaceStorageScope(scopeA);
        await useCanvasStore.persist.rehydrate();
        await hydrateLocalCanvasProjectsFromBackend();
        expect(useCanvasStore.getState().projects.map((p) => p.id)).toEqual(["canvas-in-a"]);

        await applyUserSession(makeWorkspacePayload(scopeB));
        expect(useCanvasStore.getState().projects).toEqual([]);
        expect(getCanvasHydrationHealth()).toEqual({ error: "", loading: true });
    });
});
