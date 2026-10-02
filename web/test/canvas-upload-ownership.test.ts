import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvasOwnerLifetime } from "@/pages/canvas/canvas-owner-epoch";
import {
    persistOwnedCanvasUploadNode,
    shouldSuppressOwnedCanvasCallback,
    type PersistOwnedCanvasUploadNodeDeps,
} from "@/pages/canvas/canvas-upload-ownership";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { captureUserScope, UserScopeAbandonedError } from "@/lib/user-scope-guard";
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
    test("confirmed persist writes assetId, invalidates project, and reports saved", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const setNodesCalls: string[][] = [];
        const invalidated: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                setNodes: (updater) => {
                    setNodesCalls.push(updater([imageNode("media-1")]).map((node) => String(node.metadata?.assetId || "")));
                },
                invalidateProject: async (projectId) => { invalidated.push(projectId); },
            }));
            expect(result).toEqual({ applied: true, confirmed: true, assetId: "asset-1" });
            expect(setNodesCalls).toEqual([["asset-1"]]);
            expect(invalidated).toEqual(["project-a"]);
        } finally {
            restore();
        }
    });

    test("unconfirmed result keeps the draft assetId and does not report saved", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const setNodesCalls: string[][] = [];
        let invalidated = 0;
        const warnings: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
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
            expect(result).toEqual({ applied: true, confirmed: false, assetId: "draft-1" });
            expect(setNodesCalls).toEqual([["draft-1"]]);
            expect(invalidated).toBe(0);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("A to B to A while ensure is awaiting does not setNodes, invalidate, or warn", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        const setNodesCalls: unknown[] = [];
        const warnings: string[] = [];
        let invalidated = 0;
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                domainProjectId: "project-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    return { assetId: "asset-1", created: true, linkedToProject: true, confirmed: true };
                },
                setNodes: (updater) => { setNodesCalls.push(updater([imageNode("live-b")])); },
                invalidateProject: async () => { invalidated += 1; },
                warn: (text) => warnings.push(text),
            }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            const result = await pending;
            expect(result.applied).toBe(false);
            expect(result.confirmed).toBe(false);
            expect(setNodesCalls).toEqual([]);
            expect(invalidated).toBe(0);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("canvas switch while ensure is awaiting does not overlay live nodes", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        let liveCanvasId = "canvas-a";
        const setNodesCalls: unknown[] = [];
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
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

    test("ordinary ensure error after account switch does not write a replacement error", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const entered = deferred();
        const gate = deferred();
        const warnings: string[] = [];
        const setNodesCalls: unknown[] = [];
        try {
            const pending = persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => {
                    entered.resolve();
                    await gate.promise;
                    throw new Error("网络中断");
                },
                setNodes: (updater) => { setNodesCalls.push(updater([imageNode("live-b")])); },
                warn: (text) => warnings.push(text),
            }));
            await entered.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            const result = await pending;
            expect(result).toEqual({ applied: false, confirmed: false });
            expect(setNodesCalls).toEqual([]);
            expect(warnings).toEqual([]);
        } finally {
            restore();
        }
    });

    test("ordinary ensure error while still owned still warns", async () => {
        const restore = switchScope("owner-a");
        const lifetime = createCanvasOwnerLifetime();
        const expectedScope = captureUserScope();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const warnings: string[] = [];
        try {
            const result = await persistOwnedCanvasUploadNode({
                owner,
                expectedScope,
                getLiveCanvasId: () => "canvas-a",
                getLiveLifetime: () => lifetime.current(),
                canvasId: "canvas-a",
                node: imageNode("media-1"),
            }, persistDeps({
                ensureCanvasNodeAsset: async () => { throw new Error("素材库不可用"); },
                warn: (text) => warnings.push(text),
            }));
            expect(result).toEqual({ applied: false, confirmed: false });
            expect(warnings.some((text) => text.includes("素材库不可用"))).toBe(true);
        } finally {
            restore();
        }
    });
});

describe("shouldSuppressOwnedCanvasCallback", () => {
    test("ordinary rejected upload after canvas lifetime change is suppressed", () => {
        const lifetime = createCanvasOwnerLifetime();
        const owner = lifetime.capture("canvas-a", "owner-a");
        const expectedScope = { userScope: "owner-a", epoch: 1 };
        lifetime.invalidate();
        expect(shouldSuppressOwnedCanvasCallback(new Error("网络中断"), {
            owner,
            liveCanvasId: "canvas-a",
            expectedScope,
            liveLifetime: lifetime.current(),
        })).toBe(true);
    });

    test("ordinary error on the captured canvas is not suppressed", () => {
        const lifetime = createCanvasOwnerLifetime();
        const restore = switchScope("owner-a");
        try {
            const expectedScope = captureUserScope();
            const owner = lifetime.capture("canvas-a");
            expect(shouldSuppressOwnedCanvasCallback(new Error("网络中断"), {
                owner,
                liveCanvasId: "canvas-a",
                expectedScope,
                liveLifetime: lifetime.current(),
            })).toBe(false);
            expect(shouldSuppressOwnedCanvasCallback(new UserScopeAbandonedError(), {
                owner,
                liveCanvasId: "canvas-a",
                expectedScope,
                liveLifetime: lifetime.current(),
            })).toBe(true);
        } finally {
            restore();
        }
    });
});

test("upload hook threads owner scope through persist, file, image, chapter and timeline waits", () => {
    const hook = read("pages/canvas/use-canvas-upload.ts");
    const persist = hook.slice(hook.indexOf("const persistMediaNode"), hook.indexOf("const persistTimelineMedia"));
    expect(persist).toContain("persistOwnedCanvasUploadNode");
    expect(persist).toContain("return result.confirmed");
    expect(persist).not.toContain("return true");

    const create = hook.slice(hook.indexOf("const createFileNode"), hook.indexOf("const createImageAssetNode"));
    expect(create).toContain("uploadImage(file, onProgress, guard.expectedScope)");
    expect(create).toContain("uploadMediaFile(file, \"file\", onProgress, guard.expectedScope)");
    expect(create).toContain("shouldSuppressOwnedCanvasCallback(error,");
    expect(create.indexOf("shouldSuppressOwnedCanvasCallback")).toBeLessThan(create.indexOf("message.error(details)"));

    const image = hook.slice(hook.indexOf("const createImageAssetNode"), hook.indexOf("const createTextNodeFromClipboard"));
    expect(image).toContain("uploadImage(content, undefined, guard.expectedScope)");
    expect(image).toContain("if (guard.suppress(error)) return");

    const chapter = hook.slice(hook.indexOf("const handleProjectChapterInsert"), hook.indexOf("const handleUploadRequest"));
    expect(chapter).toContain("getProjectUnit(chapter.projectId, chapter.id, guard.expectedScope, guard.signal)");
    expect(chapter).toContain("if (!guard.alive()) return");

    const timeline = hook.slice(hook.indexOf("const uploadTimelineMedia"), hook.indexOf("const createVideoNodeFromBlob"));
    expect(timeline).toContain("uploadMediaFile(file, \"audio\", undefined, guard.expectedScope)");
    expect(timeline).toContain("persistTimelineMedia(media, guard.expectedScope, guard.signal)");
    expect(timeline).toContain("if (guard.suppress(error)) return []");
});
