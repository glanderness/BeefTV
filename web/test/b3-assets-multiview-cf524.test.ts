import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssetLibraryPickerContent } from "@/components/assets/asset-library-picker-modal";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { CanvasNodeErrorContent } from "@/components/canvas/canvas-node-error-content";
import { usePersonalAssetLibrary } from "@/hooks/use-personal-asset-library";
import { loadWorkspaceAssetLibraryPage } from "@/services/workspace-asset-read";
import { useUserStore } from "@/stores/use-user-store";
import { canUseSameOriginResourceAsset, resourcePreviewAssetUrl } from "@/services/media-asset-url";
import { isProtectedResourceFileUrl, ownedResourceStorageKey, resourceIdFromStorageKey } from "@/services/api/resources";
import { canvasThemes } from "@/lib/canvas-theme";
import {
    assertCanvasGenerationHistoryTaskForInsert,
    insertableCanvasGenerationHistoryTasks,
} from "@/lib/canvas/canvas-generation-history";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import { nodeReferenceImage } from "@/lib/canvas/canvas-project-generation-metadata";
import { explainGenerationError } from "@/lib/generation-error";
import { readTaskOutcome } from "@/lib/task-outcome";
import * as runtimeMode from "@/lib/runtime-mode";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import type { AiConfig } from "@/stores/use-settings-store";
import { ApiError, apiClient } from "@/services/api/request";
import type { GenerationTask } from "@/services/api/task-center";
import { bindBackendCanvasGenerationResult, CanvasGenerationMaterializationError } from "@/services/canvas-generation-consumer";
import { materializeEffectKey } from "@/services/generation-task-materializer";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { resetWorkspaceAssetReadStateForTests } from "@/services/workspace-asset-read";
import { generationAssetId, recordAssetStoreDraft, resetAssetStoreDraftsForTests, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const spies: Array<{ mockRestore: () => void }> = [];
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

function envelope(data: unknown, status = 200) {
    return { data: { code: 0, msg: "", data }, status, statusText: "OK", headers: {}, config: {} as never };
}

function enterDesktopWailsMode() {
    spies.push(spyOn(runtimeMode, "isNativeDesktopRuntime").mockReturnValue(true));
    spies.push(spyOn(runtimeMode, "isLocalRuntimeMode").mockReturnValue(true));
    const ls = new Map<string, string>();
    Object.assign(globalThis, {
        window: {
            location: { protocol: "wails:", hostname: "wails.localhost", host: "wails.localhost", origin: "wails://wails.localhost" },
            localStorage: {
                getItem: (k: string) => ls.get(k) ?? null,
                setItem: (k: string, v: string) => { ls.set(k, v); },
                removeItem: (k: string) => { ls.delete(k); },
            },
            setTimeout: globalThis.setTimeout.bind(globalThis),
            clearTimeout: globalThis.clearTimeout.bind(globalThis),
            addEventListener: () => {},
            removeEventListener: () => {},
            matchMedia: () => ({
                matches: false,
                media: "",
                onchange: null,
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            }),
        },
    });
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

afterEach(async () => {
    while (spies.length) spies.pop()?.mockRestore();
    Object.assign(globalThis, { window: originalWindow, fetch: originalFetch });
    useAssetStore.setState({ assets: [] });
    resetWorkspaceAssetReadStateForTests();
    await resetAssetStoreDraftsForTests();
});

describe("Bug 1 (#573): deleted assets stay hidden from generation history and avoid duplicate personal copies", () => {
    test("canvas generation history excludes tasks whose outputs are marked asset_deleted", () => {
        const liveTask: GenerationTask = {
            id: "task-live-1",
            projectId: "proj-1",
            type: "canvas_image",
            status: "succeeded",
            prompt: "保留的图",
            previewUrl: "/api/resources/res-live/file",
            previewKind: "image",
            outputs: [{ outputIndex: 0, mediaType: "image", resourceId: "res-live", materializedAssetId: "generation_live" }],
            attempts: 1,
            createdAt: "2026-10-02T10:00:00.000Z",
            updatedAt: "2026-10-02T10:00:00.000Z",
        };
        const deletedTask: GenerationTask = {
            id: "task-deleted-1",
            projectId: "proj-1",
            type: "canvas_image",
            status: "succeeded",
            prompt: "已删的图",
            previewUrl: "",
            outputs: [{ outputIndex: 0, mediaType: "image", materializationErrorCode: "asset_deleted" }],
            attempts: 1,
            createdAt: "2026-10-02T10:01:00.000Z",
            updatedAt: "2026-10-02T10:01:00.000Z",
        };

        const listed = insertableCanvasGenerationHistoryTasks([liveTask, deletedTask], { projectId: "proj-1" });
        expect(listed.map((t) => t.id)).toEqual(["task-live-1"]);

        // Even if legacy resultJson still carries an old URL, assertCanvasGenerationHistoryTaskForInsert must reject deleted outputs.
        expect(() =>
            assertCanvasGenerationHistoryTaskForInsert(
                {
                    ...deletedTask,
                    resultJson: JSON.stringify({ mode: "image", images: [{ storageKey: "resource:res-deleted", url: "/api/resources/res-deleted/file" }] }),
                },
                { projectId: "proj-1", expectedId: "task-deleted-1" },
            ),
        ).toThrow("该任务没有可插入的生成结果");

        // readTaskOutcome fallback must project all-deleted succeeded tasks as unrecoverable failure, never ready.
        expect(readTaskOutcome(deletedTask)).toEqual({
            phase: "failed",
            regenerate: "confirm",
            reason: "result_unrecoverable",
        });
        expect(
            readTaskOutcome({
                ...deletedTask,
                outputs: [
                    { outputIndex: 0, mediaType: "image", materializationErrorCode: "asset_deleted" },
                    { outputIndex: 1, mediaType: "image", materializedAssetId: "generation_live_2" },
                ],
            }),
        ).toEqual({
            phase: "ready",
            regenerate: "allowed",
            reason: "result_ready",
        });
    });

    test("bindBackendCanvasGenerationResult fails immediately on asset_deleted instead of polling for 15 minutes", async () => {
        const deletedTask: GenerationTask = {
            id: "task-bind-deleted-573",
            projectId: "canvas-bind-573",
            type: "canvas_image",
            status: "succeeded",
            prompt: "已删输出",
            outputs: [{ outputIndex: 0, mediaType: "image", materializationErrorCode: "asset_deleted" }],
            attempts: 1,
            createdAt: "2026-10-02T10:01:00.000Z",
            updatedAt: "2026-10-02T10:01:00.000Z",
        };
        const node: CanvasNodeData = {
            id: "node-bind-573",
            type: CanvasNodeType.Image,
            title: "生成中",
            position: { x: 0, y: 0 },
            width: 512,
            height: 512,
            metadata: {
                status: "loading",
                taskId: deletedTask.id,
            },
        };
        let sleepCalls = 0;
        let refreshCalls = 0;

        await expect(
            bindBackendCanvasGenerationResult({
                canvasId: "canvas-bind-573",
                nodeId: node.id,
                task: deletedTask,
                isCurrent: () => true,
                nodesRef: { current: [node] },
                setNodes: () => {},
                runtime: {
                    sleep: async () => {
                        sleepCalls += 1;
                    },
                    refreshTask: async () => {
                        refreshCalls += 1;
                        return deletedTask;
                    },
                },
            }),
        ).rejects.toBeInstanceOf(CanvasGenerationMaterializationError);
        expect(sleepCalls).toBe(0);
        expect(refreshCalls).toBe(0);
    });

    test("ensureCanvasNodeAsset reuses existing backend generation asset instead of creating a duplicate Canvas copy", async () => {
        const prevScope = getActiveUserScope();
        setActiveUserScope("b3-dedupe-scope");
        enterDesktopWailsMode();

        const taskId = "task-dedupe-573";
        const effectKey = materializeEffectKey(taskId, 0);
        const canonicalId = await generationAssetId(effectKey);

        const backendGenAsset: Asset = {
            id: canonicalId,
            kind: "image",
            title: "生成图片",
            coverUrl: "/api/resources/res-dedupe-573/file",
            tags: ["生成"],
            category: "material",
            status: "confirmed",
            source: "生成任务",
            data: {
                dataUrl: "/api/resources/res-dedupe-573/file",
                storageKey: "resource:res-dedupe-573",
                width: 1024,
                height: 1024,
                bytes: 2048,
                mimeType: "image/png",
            },
            metadata: { source: "generation-task", generationEffectKey: effectKey, taskId },
            createdAt: "2026-10-02T10:00:00.000Z",
            updatedAt: "2026-10-02T10:00:00.000Z",
        };

        const putAssetIds: string[] = [];
        try {
            const node: CanvasNodeData = {
                id: "node-gen-573",
                type: CanvasNodeType.Image,
                title: "生成图",
                position: { x: 0, y: 0 },
                width: 512,
                height: 512,
                metadata: {
                    content: "/api/resources/res-dedupe-573/file",
                    storageKey: "resource:res-dedupe-573",
                    taskId,
                    taskOutputIndex: 0,
                    status: "success",
                },
            };

            const result = await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch")) {
                    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
                    return envelope({ assets: ids.includes(canonicalId) ? [backendGenAsset] : [] });
                }
                if (method === "PUT" && url.startsWith("/assets/")) {
                    putAssetIds.push(url.replace("/assets/", ""));
                    return envelope({ asset: { id: canonicalId } });
                }
                return envelope({});
            }, () => ensureCanvasNodeAsset({
                canvasId: "canvas-573",
                node,
                source: "canvas-generation",
                taskId,
            }));

            expect(result.assetId).toBe(canonicalId);
            expect(result.created).toBe(false);
            expect(putAssetIds.every((id) => id === canonicalId)).toBe(true);
        } finally {
            setActiveUserScope(prevScope);
        }
    });

    test("ensureCanvasNodeAsset does not mint a duplicate Canvas asset when /assets/batch fails with transient 5xx", async () => {
        const prevScope = getActiveUserScope();
        setActiveUserScope("b3-batch-err-scope");
        enterDesktopWailsMode();

        const taskId = "task-batch-503";
        const putAssetIds: string[] = [];
        try {
            const node: CanvasNodeData = {
                id: "node-batch-503",
                type: CanvasNodeType.Image,
                title: "生成图",
                position: { x: 0, y: 0 },
                width: 512,
                height: 512,
                metadata: {
                    content: "/api/resources/res-batch-503/file",
                    storageKey: "resource:res-batch-503",
                    taskId,
                    taskOutputIndex: 0,
                    status: "success",
                },
            };

            await expect(
                withAdapter(async (config) => {
                    const method = String(config.method || "get").toUpperCase();
                    const url = String(config.url || "");
                    if (url.includes("/assets/batch")) {
                        throw new ApiError("Service Unavailable", { status: 503 });
                    }
                    if (method === "PUT" && url.startsWith("/assets/")) {
                        putAssetIds.push(url.replace("/assets/", ""));
                    }
                    return envelope({});
                }, () => ensureCanvasNodeAsset({
                    canvasId: "canvas-503",
                    node,
                    source: "canvas-generation",
                    taskId,
                })),
            ).rejects.toThrow("Service Unavailable");

            expect(putAssetIds).toEqual([]);
            expect(useAssetStore.getState().assets).toEqual([]);

            // When /assets/batch and /tasks/:id both explicitly return 404 (no backend canonical or task row), creating a new asset is allowed.
            const createdResult = await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch") || url.includes("/tasks/")) {
                    throw new ApiError("Not Found", { status: 404 });
                }
                if (method === "PUT" && url.startsWith("/assets/")) {
                    putAssetIds.push(url.replace("/assets/", ""));
                    return envelope({ asset: { id: url.replace("/assets/", "") } });
                }
                return envelope({});
            }, () => ensureCanvasNodeAsset({
                canvasId: "canvas-503",
                node,
                source: "canvas-generation",
                taskId,
            }));
            expect(createdResult.created).toBe(true);
            expect(putAssetIds.length).toBe(1);
        } finally {
            setActiveUserScope(prevScope);
        }
    });

    test("ensureCanvasNodeAsset never resurrects a deleted canonical generation asset or creates duplicates while delivering", async () => {
        const prevScope = getActiveUserScope();
        enterDesktopWailsMode();

        try {
            // Case A: local tombstone for canonical generation asset -> skips creation even when /assets/batch returns empty.
            setActiveUserScope("b3-tombstone-local-scope");
            const deletedTaskId = "task-deleted-local-573";
            const deletedCanonicalId = await generationAssetId(materializeEffectKey(deletedTaskId, 0));
            recordAssetStoreDraft(deletedCanonicalId, "delete");

            const putCallsA: string[] = [];
            const batchCallsA: string[] = [];
            const deletedNode: CanvasNodeData = {
                id: "node-deleted-local-573",
                type: CanvasNodeType.Image,
                title: "已删生成图",
                position: { x: 0, y: 0 },
                width: 512,
                height: 512,
                metadata: {
                    content: "/api/resources/res-deleted-local-573/file",
                    storageKey: "resource:res-deleted-local-573",
                    taskId: deletedTaskId,
                    taskOutputIndex: 0,
                    status: "success",
                },
            };

            const resA = await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch")) {
                    batchCallsA.push(url);
                    return envelope({ assets: [] });
                }
                if (method === "PUT" && url.startsWith("/assets/")) {
                    putCallsA.push(url);
                }
                return envelope({});
            }, () => ensureCanvasNodeAsset({
                canvasId: "canvas-tombstone-573",
                node: deletedNode,
                source: "canvas-generation",
                taskId: deletedTaskId,
            }));

            expect(resA).toEqual({ assetId: "", created: false, linkedToProject: false, confirmed: false });
            expect(batchCallsA).toEqual([]);
            expect(putCallsA).toEqual([]);
            expect(useAssetStore.getState().assets).toEqual([]);

            // Case B: no local tombstone yet, /assets/batch returns empty, backend task reports asset_deleted -> must not create Canvas copy.
            setActiveUserScope("b3-tombstone-remote-scope");
            const remoteDeletedTaskId = "task-deleted-remote-573";
            const putCallsB: string[] = [];
            const remoteDeletedNode: CanvasNodeData = {
                ...deletedNode,
                id: "node-deleted-remote-573",
                metadata: { ...deletedNode.metadata, taskId: remoteDeletedTaskId },
            };
            const resB = await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch")) return envelope({ assets: [] });
                if (url.includes(`/tasks/${remoteDeletedTaskId}`)) {
                    return envelope({
                        id: remoteDeletedTaskId,
                        projectId: "canvas-tombstone-573",
                        type: "canvas_image",
                        status: "succeeded",
                        resultState: "FAILED_PERMANENT",
                        outputs: [{ outputIndex: 0, mediaType: "image", materializationErrorCode: "asset_deleted" }],
                        attempts: 1,
                        createdAt: "2026-10-02T10:00:00.000Z",
                        updatedAt: "2026-10-02T10:00:00.000Z",
                    });
                }
                if (method === "PUT" && url.startsWith("/assets/")) putCallsB.push(url);
                return envelope({});
            }, () => ensureCanvasNodeAsset({
                canvasId: "canvas-tombstone-573",
                node: remoteDeletedNode,
                source: "canvas-generation",
                taskId: remoteDeletedTaskId,
            }));

            expect(resB).toEqual({ assetId: "", created: false, linkedToProject: false, confirmed: false });
            expect(putCallsB).toEqual([]);
            expect(useAssetStore.getState().assets).toEqual([]);

            // Case C: canonical still delivering (PENDING_MATERIALIZATION) -> must not mint a duplicate Canvas copy.
            setActiveUserScope("b3-delivering-scope");
            const deliveringTaskId = "task-delivering-573";
            const putCallsC: string[] = [];
            const deliveringNode: CanvasNodeData = {
                ...deletedNode,
                id: "node-delivering-573",
                metadata: { ...deletedNode.metadata, taskId: deliveringTaskId },
            };
            const resC = await withAdapter(async (config) => {
                const method = String(config.method || "get").toUpperCase();
                const url = String(config.url || "");
                if (url.includes("/assets/batch")) return envelope({ assets: [] });
                if (url.includes(`/tasks/${deliveringTaskId}`)) {
                    return envelope({
                        id: deliveringTaskId,
                        projectId: "canvas-tombstone-573",
                        type: "canvas_image",
                        status: "succeeded",
                        resultState: "PENDING_MATERIALIZATION",
                        outputs: [{ outputIndex: 0, mediaType: "image" }],
                        attempts: 1,
                        createdAt: "2026-10-02T10:00:00.000Z",
                        updatedAt: "2026-10-02T10:00:00.000Z",
                    });
                }
                if (method === "PUT" && url.startsWith("/assets/")) putCallsC.push(url);
                return envelope({});
            }, () => ensureCanvasNodeAsset({
                canvasId: "canvas-tombstone-573",
                node: deliveringNode,
                source: "canvas-generation",
                taskId: deliveringTaskId,
            }));

            expect(resC).toEqual({ assetId: "", created: false, linkedToProject: false, confirmed: false });
            expect(putCallsC).toEqual([]);
            expect(useAssetStore.getState().assets).toEqual([]);
        } finally {
            setActiveUserScope(prevScope);
        }
    });

    test("new-project asset management excludes unsaved generated history assets", async () => {
        const prevScope = getActiveUserScope();
        setActiveUserScope("b3-personal-scope");
        const personalImg: Asset = {
            id: "personal-img-573",
            kind: "image",
            title: "个人上传图片",
            coverUrl: "",
            tags: [],
            category: "material",
            status: "confirmed",
            source: "本地上传",
            data: { dataUrl: "data:image/png;base64,AA", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
            createdAt: "2026-10-02T10:00:00.000Z",
            updatedAt: "2026-10-02T10:00:00.000Z",
        };
        const unsavedGenImg: Asset = {
            id: "generation_unsaved_573",
            kind: "image",
            title: "仅生成历史图片",
            coverUrl: "",
            tags: ["生成"],
            category: "material",
            status: "confirmed",
            source: "生成任务",
            data: { dataUrl: "data:image/png;base64,BB", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
            metadata: { generationEffectKey: "materialize:task-573:0", source: "generation-task" },
            createdAt: "2026-10-02T10:01:00.000Z",
            updatedAt: "2026-10-02T10:01:00.000Z",
        };
        useAssetStore.setState({ hydrated: true, assets: [personalImg, unsavedGenImg] });
        const prevUser = useUserStore.getState();
        try {
            // Browser-local personal scope must exclude unsaved generated history assets.
            const localPage = await loadWorkspaceAssetLibraryPage({ page: 1, pageSize: 100, status: "active", personal: true });
            expect(localPage.assets.map((item) => item.id)).toEqual(["personal-img-573"]);

            // Desktop single-source mode: both usePersonalAssetLibrary and AssetLibraryPickerContent must send personal=true to /assets API.
            enterDesktopWailsMode();
            useUserStore.setState({ hydrated: true, user: { id: "user-573" } as never });
            const capturedParams: Array<Record<string, unknown>> = [];
            const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            function LibraryHookProbe() {
                usePersonalAssetLibrary(true);
                return null;
            }
            await withAdapter(async (config) => {
                if (String(config.url || "").startsWith("/assets")) {
                    capturedParams.push({ ...(config.params as Record<string, unknown>) });
                    return envelope({
                        assets: [personalImg],
                        kindCounts: { image: 1 },
                        categoryCounts: { material: 1 },
                        folderCounts: {},
                        favoriteTotal: 0,
                        recentTotal: 1,
                        projectCounts: {},
                        generatedTotal: 1,
                        generatedKindCounts: { image: 1 },
                        page: 1,
                        pageSize: 100,
                        total: 1,
                        hasMore: false,
                    });
                }
                return envelope({});
            }, async () => {
                renderToStaticMarkup(
                    createElement(QueryClientProvider, { client: queryClient }, createElement(LibraryHookProbe)),
                );
                renderToStaticMarkup(
                    createElement(
                        QueryClientProvider,
                        { client: queryClient },
                        createElement(AssetLibraryPickerContent, {
                            open: true,
                            remoteLibrary: true,
                            items: [],
                            categoryLabels: { all: "全部" },
                            onClose: () => {},
                            onConfirm: () => {},
                        }),
                    ),
                );
                const queries = queryClient
                    .getQueryCache()
                    .getAll()
                    .filter((query) => {
                        const head = query.queryKey[0];
                        return typeof query.options.queryFn === "function" && (head === "asset-library" || head === "asset-picker");
                    });
                expect(queries.length).toBeGreaterThanOrEqual(2);
                for (const query of queries) {
                    await queryClient.fetchQuery({
                        queryKey: query.queryKey,
                        queryFn: query.options.queryFn as never,
                    });
                }
            });
            expect(capturedParams.length).toBeGreaterThanOrEqual(2);
            expect(capturedParams.every((params) => params.personal === 1)).toBe(true);
        } finally {
            useUserStore.setState(prevUser);
            setActiveUserScope(prevScope);
        }
    });
});

describe("Bug 2 (#574): multi-angle desktop thumbnail preview and reference image preupload normalization", () => {
    test("desktop Wails runtime resolves uploaded resource images to same-origin preview URLs", () => {
        enterDesktopWailsMode();
        expect(canUseSameOriginResourceAsset()).toBe(true);
        const key = ownedResourceStorageKey("resource:res-upload-574", "/api/resources/res-upload-574/file");
        const resourceId = resourceIdFromStorageKey(key);
        expect(resourceId).toBe("res-upload-574");
        expect(isProtectedResourceFileUrl("/api/resources/res-upload-574/file")).toBe(true);
        const previewUrl = resourcePreviewAssetUrl(resourceId, 512);
        expect(previewUrl).toContain("/api/resources/res-upload-574/asset/preview-512.jpg");
        expect(previewUrl).not.toContain(".mp4");
    });

    test("nodeReferenceImage and prepareBackendGenerationTask normalize owned resource URLs instead of sending loopback URLs or unauthenticated fetch", async () => {
        let fetchCalled = false;
        Object.assign(globalThis, {
            fetch: async () => {
                fetchCalled = true;
                return new Response(JSON.stringify({ code: 401, msg: "Unauthorized" }), {
                    status: 401,
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        const config: AiConfig = {
            baseUrl: "https://relay.example/v1",
            apiKey: "test-key",
            model: "gpt-image-1",
            provider: "openai",
            interfaceType: "openai-image",
            aspectRatio: "1:1",
            resolution: "1K",
            quality: "high",
            count: "1",
        } as unknown as AiConfig;

        const relativeNode: CanvasNodeData = {
            id: "upload-rel-574",
            type: CanvasNodeType.Image,
            title: "上传图片",
            position: { x: 0, y: 0 },
            width: 512,
            height: 512,
            metadata: {
                content: "/api/resources/res-upload-rel-574/file",
            },
        };
        const refRel = nodeReferenceImage(relativeNode);
        expect(refRel?.storageKey).toBe("resource:res-upload-rel-574");

        const preparedRelTask = await prepareBackendGenerationTask({
            projectId: "proj-574",
            mode: "image",
            prompt: "切换右侧视角",
            config,
            referenceImages: [{
                id: "upload-rel-574",
                name: "upload.png",
                type: "image/png",
                dataUrl: "/api/resources/res-upload-rel-574/file",
            }],
        });
        const preparedRel = (preparedRelTask.input?.referenceImages as Array<{ storageKey?: string; url?: string }>)[0];
        expect(preparedRel?.storageKey).toBe("resource:res-upload-rel-574");
        expect(preparedRel?.url).toBeUndefined();
        expect(fetchCalled).toBe(false);

        const loopbackNode: CanvasNodeData = {
            id: "upload-loop-574",
            type: CanvasNodeType.Image,
            title: "上传图片2",
            position: { x: 0, y: 0 },
            width: 512,
            height: 512,
            metadata: {
                content: "http://127.0.0.1:4173/api/resources/res-upload-loop-574/file",
            },
        };
        const refLoop = nodeReferenceImage(loopbackNode);
        expect(refLoop?.storageKey).toBe("resource:res-upload-loop-574");

        const preparedLoopTask = await prepareBackendGenerationTask({
            projectId: "proj-574",
            mode: "image",
            prompt: "切换右侧视角",
            config,
            referenceImages: [{
                id: "upload-loop-574",
                name: "upload.png",
                type: "image/png",
                dataUrl: "http://127.0.0.1:4173/api/resources/res-upload-loop-574/file",
            }],
        });
        const preparedLoop = (preparedLoopTask.input?.referenceImages as Array<{ storageKey?: string; url?: string }>)[0];
        expect(preparedLoop?.storageKey).toBe("resource:res-upload-loop-574");
        expect(preparedLoop?.url).toBeUndefined();
        expect(fetchCalled).toBe(false);

        // Fallback fetch for non-owned relative URLs must fail fast on non-OK HTTP status instead of uploading error JSON as a PNG.
        await expect(
            prepareBackendGenerationTask({
                projectId: "proj-574",
                mode: "image",
                prompt: "切换右侧视角",
                config,
                referenceImages: [{
                    id: "broken-574",
                    name: "broken.png",
                    type: "image/png",
                    dataUrl: "/broken/unowned-image.png",
                }],
            }),
        ).rejects.toThrow();
    });
});

describe("Bug 3: Cloudflare HTTP 524 gateway timeout classification, intermediate state, and backend task.outcome retry", () => {
    test("explainGenerationError classifies HTTP 524 with upstream gateway timeout and keep-alive guidance", () => {
        const explanation = explainGenerationError({
            status: 524,
            body: "<!DOCTYPE html><html><title>524: A timeout occurred</title></html>",
        });
        expect(explanation.category).toBe("timeout");
        expect(explanation.uncertain).toBe(true);
        expect(explanation.reason).toContain("524");
        expect(explanation.reason).toContain("网关");
        expect(explanation.reason).toContain("可能仍在服务端执行");
        expect(explanation.action).toContain("不要立即重新提交");
        expect(explanation.action.includes("keep-alive") || explanation.action.includes("保活")).toBe(true);
    });

    test("failed HTTP 524 node with backend unrecoverable outcome preserves history restore and enables confirm-gated regenerate", () => {
        const backendError = explainGenerationError({
            status: 524,
            body: "<html>524 A Timeout Occurred</html>",
        });
        const node: CanvasNodeData = {
            id: "img-cf524-node",
            type: CanvasNodeType.Image,
            title: "图片",
            position: { x: 0, y: 0 },
            width: 420,
            height: 420,
            metadata: {
                status: "error",
                prompt: "把天空改成极光",
                taskId: "task-cf524-ui",
                taskStatus: "failed",
                taskErrorCode: "timeout",
                generationErrorCode: "timeout",
                errorDetails: backendError.message,
                taskOutcome: { phase: "failed", regenerate: "confirm", reason: "result_unrecoverable" },
                taskFailureDiagnostics: {
                    source: "upstream_http",
                    httpStatus: 524,
                    stage: "上游网关超时",
                    summary: backendError.reason,
                    capturedAt: "2026-10-02T10:00:00.000Z",
                },
                imageHistory: [
                    {
                        id: "hist-prev-1",
                        content: "/api/resources/res-prev-img/file",
                        storageKey: "resource:res-prev-img",
                        prompt: "原始图片",
                        createdAt: "2026-10-02T09:50:00.000Z",
                    },
                ],
            },
        };

        const view = canvasNodeFailureView(node);
        expect(view.canReload).toBe(false);
        expect(view.retryBlocked).toBe(false);
        expect(view.regenerateConfirm).toBe(true);

        const html = renderToStaticMarkup(
            createElement(
                CanvasNodeActionContext.Provider,
                { value: { restorePreviousHistoryImage: async () => true } },
                createElement(CanvasNodeErrorContent, {
                    node,
                    theme: canvasThemes.light,
                    onRetry: () => {},
                    onReloadResource: () => {},
                }),
            ),
        );
        expect(html).toContain("524");
        expect(html).toContain("网关");
        expect(html.includes("keep-alive") || html.includes("保活")).toBe(true);
        expect(html).toContain("重新生成");
        expect(html).toContain("恢复上一版图片");
        expect(html).not.toContain("继续取回");
    });
});
