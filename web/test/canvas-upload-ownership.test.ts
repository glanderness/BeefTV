import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvasOwnerLifetime } from "@/pages/canvas/canvas-owner-epoch";
import {
    createCanvasVideoNodeFromResource,
    uploadTimelineLocalMediaFiles,
} from "@/pages/canvas/canvas-timeline-media-upload";
import {
    createOwnedCanvasUploadGuard,
    persistOwnedCanvasUploadNode,
    shouldSuppressOwnedCanvasCallback,
    type PersistOwnedCanvasUploadNodeDeps,
} from "@/pages/canvas/canvas-upload-ownership";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

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

function imageNode(id: string, extra: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 8,
        height: 8,
        metadata: { content: "data:image/png;base64,xx", ...extra },
    };
}

function persistDeps(overrides: Partial<PersistOwnedCanvasUploadNodeDeps> = {}): PersistOwnedCanvasUploadNodeDeps {
    return {
        ensureCanvasNodeAsset: async () => ({ assetId: "asset-1", created: true, linkedToProject: true, confirmed: true }),
        setNodes: () => {},
        invalidateProject: async () => {},
        warn: () => {},
        ...overrides,
    };
}

const read = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src", path), "utf8");

describe("persistOwnedCanvasUploadNode", () => {
    test("deferred React updater does not modify replacement canvas nodes", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        let queued: ((current: CanvasNodeData[]) => CanvasNodeData[]) | undefined;
        try {
            await persistOwnedCanvasUploadNode({
                owner: lifetime.capture("canvas-a"),
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({ setNodes: (updater) => { queued = updater; } }));
            expect(queued).toBeDefined();
            lifetime.invalidate();
            const replacement = [imageNode("media-1")];
            expect(queued!(replacement)).toBe(replacement);
            expect(replacement[0].metadata?.assetId).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("confirmed persist writes assetId synchronously to nodesRef and setNodes, invalidates project, and reports saved", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const nodesRef = { current: [imageNode("media-1")] };
        const setNodesCalls: string[][] = [];
        const invalidated: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                nodesRef,
                setNodes: (updater) => {
                    setNodesCalls.push(updater([imageNode("media-1")]).map((node) => String(node.metadata?.assetId || "")));
                },
                invalidateProject: async (projectId) => { invalidated.push(projectId); },
            }));
            expect(result).toEqual({ applied: true, confirmed: true, assetId: "asset-1", linkedToProject: true });
            expect(nodesRef.current[0]?.metadata?.assetId).toBe("asset-1");
            expect(setNodesCalls).toEqual([["asset-1"]]);
            expect(invalidated).toEqual(["project-a"]);
        } finally {
            restore();
        }
    });

    test("unconfirmed result keeps the draft assetId and does not report saved", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const setNodesCalls: string[][] = [];
        let invalidated = 0;
        const warnings: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => ({ assetId: "draft-1", created: true, linkedToProject: false, confirmed: false }),
                setNodes: (updater) => {
                    setNodesCalls.push(updater([imageNode("media-1")]).map((node) => String(node.metadata?.assetId || "")));
                },
                invalidateProject: async () => { invalidated += 1; },
                warn: (text) => warnings.push(text),
            }));
            expect(result).toEqual({ applied: true, confirmed: false, assetId: "draft-1", linkedToProject: false });
            expect(setNodesCalls).toEqual([["draft-1"]]);
            expect(invalidated).toBe(0);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("canvas switch while ensure is awaiting does not overlay live nodes", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        let liveCanvasId = "canvas-a";
        const setNodesCalls: unknown[] = [];
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                getLiveCanvasId: () => liveCanvasId,
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
                setNodes: (updater) => { setNodesCalls.push(updater([imageNode("live-b")])); },
            }));
            await entered.promise;
            liveCanvasId = "canvas-b";
            gate.resolve();
            const result = await pending;
            expect(result.applied).toBe(false);
            expect(result.confirmed).toBe(false);
            expect(setNodesCalls).toEqual([]);
        } finally {
            restore();
        }
    });

    test("ordinary ensure error while still owned still warns", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const warnings: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => { throw new Error("素材库不可用"); },
                warn: (text) => warnings.push(text),
            }));
            expect(result.applied).toBe(false);
            expect(result.confirmed).toBe(false);
            expect(result.error).toBeInstanceOf(Error);
            expect((result.error as Error).message).toBe("素材库不可用");
            expect(warnings.some((text) => text.includes("素材库不可用"))).toBe(true);
        } finally {
            restore();
        }
    });

    test("default source stays canvas-upload; editor source and category are forwarded", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const received: Array<{ source?: string; category?: string; hasSignal: boolean }> = [];
        try {
            await persistOwnedCanvasUploadNode({
                owner,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async (options) => {
                    received.push({ source: options.source, category: options.category, hasSignal: Boolean(options.signal) });
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
            }));
            const controller = new AbortController();
            await persistOwnedCanvasUploadNode({
                owner,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
                signal: controller.signal,
                source: "canvas-manual",
                category: "character",
            }, persistDeps({
                ensureCanvasNodeAsset: async (options) => {
                    received.push({ source: options.source, category: options.category, hasSignal: options.signal === controller.signal });
                    return { assetId: "asset-2", created: true, linkedToProject: false, confirmed: true };
                },
            }));
            expect(received).toEqual([
                { source: "canvas-upload", category: undefined, hasSignal: false },
                { source: "canvas-manual", category: "character", hasSignal: true },
            ]);
        } finally {
            restore();
        }
    });

});

describe("shouldSuppressOwnedCanvasCallback", () => {
    test("ordinary rejected upload after canvas lifetime change is suppressed", () => {
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        lifetime.invalidate();
        expect(shouldSuppressOwnedCanvasCallback(new Error("网络中断"), {
            owner,
            liveCanvasId: "canvas-a",
            liveLifetime: lifetime.current(),
        })).toBe(true);
    });

    test("ordinary error on the captured canvas is not suppressed", () => {
        const lifetime = createCanvasOwnerLifetime();
        const restore = switchScope("owner-a");
        try {
                const owner = lifetime.capture("canvas-a");
            expect(shouldSuppressOwnedCanvasCallback(new Error("网络中断"), {
                owner,
                liveCanvasId: "canvas-a",
                liveLifetime: lifetime.current(),
            })).toBe(false);
        } finally {
            restore();
        }
    });
});

test("upload hook threads the canvas owner through persist, file, image, chapter and timeline waits", () => {
    const hook = read("pages/canvas/use-canvas-upload.ts");
    const persist = hook.slice(hook.indexOf("const persistMediaNode"), hook.indexOf("const persistTimelineMedia"));
    expect(persist).toContain("persistOwnedCanvasUploadNode");
    expect(persist).toContain("return result.confirmed");
    expect(persist).not.toContain("return true");

    const create = hook.slice(hook.indexOf("const createFileNode"), hook.indexOf("const createImageAssetNode"));
    expect(create).toContain("uploadImage(file, onProgress)");
    expect(create).toContain("uploadMediaFile(file, \"file\", onProgress)");
    expect(create).toContain("shouldSuppressOwnedCanvasCallback(error,");
    expect(create.indexOf("shouldSuppressOwnedCanvasCallback")).toBeLessThan(create.indexOf("message.error(details)"));

    const image = hook.slice(hook.indexOf("const createImageAssetNode"), hook.indexOf("const createTextNodeFromClipboard"));
    expect(image).toContain("uploadImage(content)");
    expect(image).toContain("if (guard.suppress(error)) return");

    const chapter = hook.slice(hook.indexOf("const handleProjectChapterInsert"), hook.indexOf("const handleUploadRequest"));
    expect(chapter).toContain("getProjectUnit(chapter.projectId, chapter.id, guard.signal)");
    expect(chapter).toContain("if (!guard.alive()) return");
});

describe("timeline local upload and native resource binding ownership", () => {
    test("uploadTimelineLocalMediaFiles threads guard.signal across audio/image/video and drops stale canvas callbacks", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        try {
            let liveCanvasId = "canvas-a";
            const persistedSignals: Array<AbortSignal | undefined> = [];
            const messages: string[] = [];
            const guard = createOwnedCanvasUploadGuard({
                lifetime,
                canvasId: "canvas-a",
                getLiveCanvasId: () => liveCanvasId,
            });
            const uploaded = await uploadTimelineLocalMediaFiles({
                files: [
                    new File([new Uint8Array([1])], "bgm.m4a", { type: "audio/mp4" }),
                    new File([new Uint8Array([2])], "cover.png", { type: "image/png" }),
                    new File([new Uint8Array([3])], "shot.mp4", { type: "video/mp4" }),
                ],
                guard,
                message: {
                    warning: (text) => messages.push(`warn:${text}`),
                    success: (text) => messages.push(`ok:${text}`),
                    error: (text) => messages.push(`err:${text}`),
                },
                uploadMedia: async (_file, kind) => ({
                    storageKey: `resource:res-${kind}`,
                    url: `/api/resources/res-${kind}/file`,
                    durationMs: 4000,
                    bytes: 128,
                    mimeType: kind === "audio" ? "audio/mp4" : "video/mp4",
                    width: kind === "video" ? 1080 : undefined,
                    height: kind === "video" ? 1920 : undefined,
                }),
                uploadImageFile: async () => ({
                    storageKey: "resource:res-image",
                    url: "/api/resources/res-image/file",
                    width: 1080,
                    height: 1920,
                    bytes: 64,
                    mimeType: "image/png",
                }),
                persistTimelineMedia: async (_media, signal) => {
                    persistedSignals.push(signal);
                    return "asset-persisted";
                },
            });
            expect(uploaded.map((item) => item.kind)).toEqual(["audio", "image", "video"]);
            expect(persistedSignals).toEqual([guard.signal, guard.signal, guard.signal]);
            expect(messages).toEqual(["ok:已上传 3 个素材到时间线"]);

            const failedMessages: string[] = [];
            const staleGuard = createOwnedCanvasUploadGuard({
                lifetime,
                canvasId: "canvas-a",
                getLiveCanvasId: () => liveCanvasId,
            });
            const abandoned = await uploadTimelineLocalMediaFiles({
                files: [new File([new Uint8Array([1])], "voice.m4a", { type: "audio/mp4" })],
                guard: staleGuard,
                message: {
                    warning: (text) => failedMessages.push(`warn:${text}`),
                    success: (text) => failedMessages.push(`ok:${text}`),
                    error: (text) => failedMessages.push(`err:${text}`),
                },
                uploadMedia: async () => {
                    liveCanvasId = "canvas-b";
                    throw new Error("网络断开");
                },
                persistTimelineMedia: async () => "should-not-run",
            });
            expect(abandoned).toEqual([]);
            expect(failedMessages).toEqual([]);
        } finally {
            restore();
        }
    });

    test("createCanvasVideoNodeFromResource binds resourceId directly and aborts cleanly on canvas switch", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        try {
            let liveCanvasId = "canvas-a";
            let nodes: CanvasNodeData[] = [];
            const persisted: Array<{ storageKey?: string; signal?: AbortSignal }> = [];
            const errors: string[] = [];
            const guard = createOwnedCanvasUploadGuard({
                lifetime,
                canvasId: "canvas-a",
                getLiveCanvasId: () => liveCanvasId,
            });
            const created = await createCanvasVideoNodeFromResource({
                input: { resourceId: "res-native-9x16", title: "9:16 竖屏成片", durationMs: 4200, width: 1080, height: 1920 },
                guard,
                domainProjectId: "project-1",
                getCanvasCenter: () => ({ x: 400, y: 300 }),
                setNodes: (updater) => {
                    nodes = typeof updater === "function" ? updater(nodes) : updater;
                },
                selectInsertedNode: () => {},
                persistMediaNode: async (node, signal) => {
                    persisted.push({ storageKey: node.metadata?.storageKey, signal });
                    return true;
                },
                startUploadStatus: () => ({ update: () => {}, done: () => {}, fail: () => {} }),
                message: { warning: () => {}, success: () => {}, error: (text) => errors.push(text) },
                fetchResource: async (id) => ({
                    id,
                    mimeType: "video/mp4",
                    width: 1080,
                    height: 1920,
                    durationMs: 4200,
                    size: 4096,
                    publicUrl: `/api/resources/${id}/file`,
                } as never),
            });
            expect(created?.metadata?.storageKey).toBe("resource:res-native-9x16");
            expect(nodes).toHaveLength(1);
            expect(persisted).toEqual([{ storageKey: "resource:res-native-9x16", signal: guard.signal }]);
            expect(errors).toEqual([]);

            let switchedNodes: CanvasNodeData[] = [];
            const switchedGuard = createOwnedCanvasUploadGuard({
                lifetime,
                canvasId: "canvas-a",
                getLiveCanvasId: () => liveCanvasId,
            });
            const abandoned = await createCanvasVideoNodeFromResource({
                input: { resourceId: "res-stale", title: "已切换画布成片" },
                guard: switchedGuard,
                getCanvasCenter: () => ({ x: 0, y: 0 }),
                setNodes: (updater) => {
                    switchedNodes = typeof updater === "function" ? updater(switchedNodes) : updater;
                },
                selectInsertedNode: () => {},
                persistMediaNode: async () => true,
                startUploadStatus: () => ({ update: () => {}, done: () => {}, fail: () => {} }),
                message: { warning: () => {}, success: () => {}, error: (text) => errors.push(text) },
                fetchResource: async () => {
                    liveCanvasId = "canvas-b";
                    return null as never;
                },
            });
            expect(abandoned).toBeNull();
            expect(switchedNodes).toEqual([]);
            expect(errors).toEqual([]);
        } finally {
            restore();
        }
    });
});

test("node editor threads the canvas owner through category change and save, and keeps confirmed=false draft copy", () => {
    const editor = read("pages/canvas/use-canvas-node-editor.ts");
    expect(editor).toContain("useCanvasOwnerLifetime(canvasId)");
    expect(editor).toContain("createOwnedCanvasUploadGuard");
    expect(editor).toContain("persistOwnedCanvasUploadNode");
    expect(editor).toContain("source: \"canvas-manual\"");
    expect(editor).toContain("category,");

    const persist = editor.slice(editor.indexOf("const persistOwnedEditorNode"), editor.indexOf("const handleConfigNodeChange"));
    expect(persist).toContain("signal: guard.signal");
    expect(persist).not.toContain("warn:");

    const config = editor.slice(editor.indexOf("const handleConfigNodeChange"), editor.indexOf("const downloadNodeImage"));
    expect(config).toContain("applyNodeConfigPatch(node, patch)");
    expect(config).toContain("nodesRef.current = next");
    expect(config).toContain("persistOwnedEditorNode(updatedNode, patch.assetCategory)");
    expect(config).toContain("if (!guard.alive()) return");
    expect(config).toContain("message.success(\"资产分类已更新\")");
    expect(config).toContain("文件目前只在这台设备上");
    expect(config).toContain("资产分类更新失败");
    expect(config.indexOf("if (!guard.alive())")).toBeLessThan(config.indexOf("message.success(\"资产分类已更新\")"));
    expect(config.indexOf("if (!guard.alive())")).toBeLessThan(config.indexOf("资产分类更新失败"));

    const save = editor.slice(editor.indexOf("const saveNodeAsset"), editor.indexOf("const handleFontSizeChange"));
    expect(save).toContain("persistOwnedEditorNode(node)");
    expect(save).toContain("if (!guard.alive()) return");
    expect(save).toContain("if (!result.confirmed) message.warning");
    expect(save).toContain("文件目前只在这台设备上");
    expect(save).toContain("已加入项目资产");
    expect(save).toContain("已加入我的素材");
    expect(save).toContain("素材保存失败");
    expect(save.indexOf("if (!guard.alive())")).toBeLessThan(save.indexOf("if (!result.confirmed) message.warning"));
    expect(save.indexOf("if (!guard.alive())")).toBeLessThan(save.indexOf("素材保存失败"));
});
