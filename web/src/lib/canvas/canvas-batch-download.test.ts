import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import {
    batchDownloadCanvasMediaNodes,
    buildBatchDownloadFilename,
    collectDownloadableMediaNodes,
    downloadCanvasProjectsMediaByIds,
    runCanvasBatchDownloadWithFeedback,
} from "./canvas-batch-download";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function makeNode(overrides: Partial<CanvasNodeData> & { id: string; type: CanvasNodeData["type"] }): CanvasNodeData {
    return {
        title: overrides.id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        ...overrides,
    };
}

describe("canvas-batch-download", () => {
    test("collectDownloadableMediaNodes filters non-media or empty nodes and sorts in storyboard order", () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "shot-row2-right",
                type: CanvasNodeType.Video,
                title: "镜头4",
                position: { x: 600, y: 400 },
                metadata: { content: "https://example.com/4.mp4" },
            }),
            makeNode({
                id: "shot-row1-right",
                type: CanvasNodeType.Image,
                title: "镜头2",
                position: { x: 500, y: 120 },
                metadata: { content: "https://example.com/2.png" },
            }),
            makeNode({
                id: "shot-row1-left",
                type: CanvasNodeType.Video,
                title: "镜头1",
                position: { x: 100, y: 100 },
                metadata: { content: "https://example.com/1.mp4" },
            }),
            makeNode({
                id: "shot-row2-left",
                type: CanvasNodeType.Audio,
                title: "旁白3",
                position: { x: 120, y: 380 },
                metadata: { content: "https://example.com/3.mp3" },
            }),
            makeNode({
                id: "text-node",
                type: CanvasNodeType.Text,
                title: "文本",
                position: { x: 0, y: 0 },
                metadata: { content: "分镜脚本" },
            }),
            makeNode({
                id: "empty-video",
                type: CanvasNodeType.Video,
                title: "空视频",
                position: { x: 50, y: 50 },
                metadata: { content: "   " },
            }),
        ];

        const selected = collectDownloadableMediaNodes(
            nodes,
            ["shot-row2-right", "shot-row1-right", "shot-row1-left", "shot-row2-left", "text-node", "empty-video"],
        );
        assert.deepEqual(selected.map((n) => n.id), [
            "shot-row1-left",
            "shot-row1-right",
            "shot-row2-left",
            "shot-row2-right",
        ]);
    });

    test("batch order follows canvas rows regardless of node storage order and preserves node titles", () => {
        const firstRowRight = makeNode({ id: "right", type: CanvasNodeType.Image, position: { x: 300, y: 0 }, metadata: { content: "/right.png" } });
        const firstRowLeft = makeNode({ id: "left", type: CanvasNodeType.Image, position: { x: 200, y: 48 }, metadata: { content: "/left.png" } });
        const secondRow = makeNode({ id: "next", type: CanvasNodeType.Image, position: { x: 100, y: 49 }, metadata: { content: "/next.png" } });
        const nodes = [firstRowRight, firstRowLeft, secondRow];
        const selectedIds = nodes.map((node) => node.id);

        for (const [first, second, third] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
            const sorted = collectDownloadableMediaNodes([nodes[first], nodes[second], nodes[third]], selectedIds);
            assert.deepEqual(sorted.map((node) => buildBatchDownloadFilename(node)), [
                "left.png", "right.png", "next.png",
            ]);
        }
    });

    test("buildBatchDownloadFilename preserves canvas node title, sanitizes invalid chars, and infers extension", () => {
        const numberedVideo = makeNode({
            id: "v0",
            type: CanvasNodeType.Video,
            title: "1",
            metadata: { content: "https://example.com/1.mp4", mimeType: "video/mp4" },
        });
        assert.equal(buildBatchDownloadFilename(numberedVideo), "1.mp4");

        const videoNode = makeNode({
            id: "v1",
            type: CanvasNodeType.Video,
            title: "镜头1:开场/雨夜?",
            metadata: { content: "https://example.com/shot1.mp4", mimeType: "video/mp4" },
        });
        assert.equal(buildBatchDownloadFilename(videoNode), "镜头1_开场_雨夜.mp4");

        const untitledImage = makeNode({
            id: "img2",
            type: CanvasNodeType.Image,
            title: "   ",
            metadata: { content: "https://example.com/frame.webp?token=1" },
        });
        assert.equal(buildBatchDownloadFilename(untitledImage), "图片.webp");

        const audioNode = makeNode({
            id: "aud3",
            type: CanvasNodeType.Audio,
            title: "角色对白.wav",
            metadata: { content: "blob:http://localhost/audio-1", mimeType: "audio/wav" },
        });
        assert.equal(buildBatchDownloadFilename(audioNode), "角色对白.wav");
    });

    test("batchDownloadCanvasMediaNodes deduplicates colliding node titles in browser mode while keeping unique names untouched", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({ id: "v1", type: CanvasNodeType.Video, title: "1", metadata: { storageKey: "resource:r1", mimeType: "video/mp4" } }),
            makeNode({ id: "v2", type: CanvasNodeType.Video, title: "16", metadata: { storageKey: "resource:r2", mimeType: "video/mp4" } }),
            makeNode({ id: "v3", type: CanvasNodeType.Video, title: "Shot", metadata: { storageKey: "resource:r3", mimeType: "video/mp4" } }),
            makeNode({ id: "v4", type: CanvasNodeType.Video, title: "shot", metadata: { storageKey: "resource:r4", mimeType: "video/mp4" } }),
            makeNode({ id: "v5", type: CanvasNodeType.Video, title: "Shot (1)", metadata: { storageKey: "resource:r5", mimeType: "video/mp4" } }),
            makeNode({ id: "v6", type: CanvasNodeType.Video, title: "Shot", metadata: { storageKey: "resource:r6", mimeType: "video/mp4" } }),
        ];

        const triggered: string[] = [];
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            loadResourceBlob: async () => new Blob(["mp4"], { type: "video/mp4" }),
            triggerDownload: (_href, filename) => {
                triggered.push(filename);
            },
        });

        assert.deepEqual(result, { downloaded: 6, failed: 0 });
        assert.deepEqual(triggered, [
            "1.mp4",
            "16.mp4",
            "Shot.mp4",
            "shot (1).mp4",
            "Shot (1) (1).mp4",
            "Shot (2).mp4",
        ]);
    });

    test("batchDownloadCanvasMediaNodes downloads sequentially with fetch or CORS anchor fallback", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "v1",
                type: CanvasNodeType.Video,
                title: "镜头1视频",
                metadata: { content: "https://example.com/1.mp4", mimeType: "video/mp4" },
            }),
            makeNode({
                id: "v2",
                type: CanvasNodeType.Image,
                title: "镜头2分镜",
                metadata: { content: "https://cdn.example.com/2.png", mimeType: "image/png" },
            }),
            makeNode({
                id: "v3",
                type: CanvasNodeType.Video,
                title: "缺失视频",
                metadata: { content: "https://example.com/404.mp4", mimeType: "video/mp4" },
            }),
        ];

        const triggered: Array<{ href: string; filename: string }> = [];
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            fetchImpl: (async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes("1.mp4")) {
                    return new Response(new Blob(["video-bytes"], { type: "video/mp4" }), { status: 200 });
                }
                if (url.includes("2.png")) {
                    throw new TypeError("Failed to fetch (CORS)");
                }
                return new Response(null, { status: 404 });
            }) as typeof fetch,
            triggerDownload: (href, filename) => {
                triggered.push({ href, filename });
            },
        });

        assert.equal(result.downloaded, 2);
        assert.equal(result.failed, 1);
        assert.equal(result.failures?.length, 1);
        assert.equal(result.failures?.[0]?.fileName, "缺失视频.mp4");
        assert.deepEqual(triggered.map((item) => item.filename), [
            "镜头1视频.mp4",
            "镜头2分镜.png",
        ]);
        assert.equal(triggered[1]?.href, "https://cdn.example.com/2.png");
    });

    test("collectDownloadableMediaNodes accepts owned storageKey nodes even without hydrated content", () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "owned-only",
                type: CanvasNodeType.Video,
                title: "已入库视频",
                metadata: { storageKey: "resource:res-owned-1", mimeType: "video/mp4" },
            }),
        ];
        const collected = collectDownloadableMediaNodes(nodes, ["owned-only"]);
        assert.deepEqual(collected.map((node) => node.id), ["owned-only"]);
    });

    test("batchDownloadCanvasMediaNodes uses desktop native batch save for owned resources without fetch or anchor navigation", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "v1",
                type: CanvasNodeType.Video,
                title: "镜头1",
                metadata: {
                    storageKey: "resource:res-video-1",
                    content: "http://127.0.0.1:54321/api/resources/res-video-1/file",
                    mimeType: "video/mp4",
                },
            }),
            makeNode({
                id: "v2",
                type: CanvasNodeType.Image,
                title: "镜头2",
                metadata: {
                    content: "/api/resources/res-img-2/file",
                    mimeType: "image/png",
                },
            }),
            makeNode({
                id: "v3",
                type: CanvasNodeType.Video,
                title: "镜头1",
                metadata: {
                    storageKey: "resource:res-video-3",
                    mimeType: "video/mp4",
                },
            }),
        ];

        let fetchCalls = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            throw new Error("desktop owned batch must not fetch over loopback HTTP");
        }) as typeof fetch;

        const savedBatches: Array<Array<{ fileName: string; resourceId?: string; blob?: Blob }>> = [];
        try {
            const result = await batchDownloadCanvasMediaNodes(nodes, {
                staggerMs: 0,
                saveNativeBatch: async (items) => {
                    savedBatches.push(items);
                    return { saved: items.length, failed: 0, cancelled: false };
                },
            });
            assert.deepEqual(result, { downloaded: 3, failed: 0, cancelled: false });
            assert.equal(fetchCalls, 0);
            assert.deepEqual(savedBatches, [[
                { fileName: "镜头1.mp4", resourceId: "res-video-1" },
                { fileName: "镜头2.png", resourceId: "res-img-2" },
                { fileName: "镜头1.mp4", resourceId: "res-video-3" },
            ]]);

            const cancelled = await batchDownloadCanvasMediaNodes(nodes, {
                staggerMs: 0,
                saveNativeBatch: async () => ({ saved: 0, failed: 0, cancelled: true }),
            });
            assert.deepEqual(cancelled, { downloaded: 0, failed: 0, cancelled: true });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("batchDownloadCanvasMediaNodes never falls back to raw anchor click on loopback or protected API URLs", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "stale-loopback",
                type: CanvasNodeType.Video,
                title: "旧端口视频",
                metadata: {
                    content: "http://127.0.0.1:59999/api/resources/res-stale/file",
                    mimeType: "video/mp4",
                },
            }),
            makeNode({
                id: "raw-loopback",
                type: CanvasNodeType.Video,
                title: "本地回环地址",
                metadata: {
                    content: "http://127.0.0.1:59999/raw/video.mp4",
                    mimeType: "video/mp4",
                },
            }),
            makeNode({
                id: "relative-api",
                type: CanvasNodeType.Image,
                title: "相对资源路径",
                metadata: {
                    content: "/api/resources/res-rel/file",
                    mimeType: "image/png",
                },
            }),
        ];

        const triggered: Array<{ href: string; filename: string }> = [];
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            fetchImpl: (async () => {
                throw new TypeError("Failed to fetch (ERR_CONNECTION_REFUSED)");
            }) as typeof fetch,
            triggerDownload: (href, filename) => {
                triggered.push({ href, filename });
            },
        });

        assert.equal(result.downloaded, 0);
        assert.equal(result.failed, 3);
        assert.equal(result.failures?.length, 3);
        assert.equal(triggered.length, 0);
    });

    test("desktop native batch prompts for directory before fetching external URLs and cancels with zero fetches", async () => {
        const events: string[] = [];
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "ext-1",
                type: CanvasNodeType.Image,
                title: "外链图",
                metadata: { content: "https://cdn.example.com/a.png", mimeType: "image/png" },
            }),
        ];

        const cancelled = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            chooseNativeBatchDir: async () => {
                events.push("choose-dir");
                return "";
            },
            fetchImpl: (async () => {
                events.push("fetch");
                return new Response(new Blob(["img"]), { status: 200 });
            }) as typeof fetch,
            saveNativeBatch: async () => {
                events.push("save");
                return { saved: 1, failed: 0, cancelled: false };
            },
        });
        assert.deepEqual(cancelled, { downloaded: 0, failed: 0, cancelled: true });
        assert.deepEqual(events, ["choose-dir"]);

        events.length = 0;
        let receivedToken = "";
        const saved = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            chooseNativeBatchDir: async () => {
                events.push("choose-dir");
                return "tok-42";
            },
            fetchImpl: (async () => {
                events.push("fetch");
                return new Response(new Blob(["img"]), { status: 200 });
            }) as typeof fetch,
            saveNativeBatch: async (items, token) => {
                events.push("save");
                receivedToken = token ?? "";
                return { saved: items.length, failed: 0, cancelled: false };
            },
        });
        assert.equal(saved.downloaded, 1);
        assert.equal(receivedToken, "tok-42");
        assert.deepEqual(events, ["choose-dir", "fetch", "save"]);
    });

    test("desktop native external prep enforces 32MB budget, blocks unsafe hosts, and bounds concurrency to 4", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({ id: "unsafe-local", type: CanvasNodeType.Image, title: "回环图", metadata: { content: "http://localhost.:8080/x.png" } }),
            makeNode({ id: "oversized-hdr", type: CanvasNodeType.Video, title: "大视频", metadata: { content: "https://cdn.example.com/huge.mp4" } }),
            ...Array.from({ length: 6 }, (_, i) => makeNode({
                id: `ok-${i}`,
                type: CanvasNodeType.Image,
                title: `图${i}`,
                metadata: { content: `https://cdn.example.com/ok-${i}.png` },
            })),
        ];

        let inFlight = 0;
        let maxInFlight = 0;
        const fetchedUrls: string[] = [];
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            chooseNativeBatchDir: async () => "tok-budget",
            fetchImpl: (async (input: RequestInfo | URL) => {
                const url = String(input);
                fetchedUrls.push(url);
                if (url.includes("huge.mp4")) {
                    return new Response(new Blob(["tiny"]), {
                        status: 200,
                        headers: { "content-length": String(40 * 1024 * 1024) },
                    });
                }
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 10));
                inFlight -= 1;
                return new Response(new Blob(["ok-bytes"]), { status: 200 });
            }) as typeof fetch,
            saveNativeBatch: async (items) => ({ saved: items.length, failed: 0, cancelled: false }),
        });

        assert.equal(result.downloaded, 6);
        assert.equal(result.failed, 2);
        assert.equal(maxInFlight <= 4, true);
        assert.equal(fetchedUrls.some((url) => url.includes("localhost")), false);
        assert.equal(
            result.failures?.some((f) => f.fileName.includes("大视频") && f.reason.includes("32MB")),
            true,
        );
        assert.equal(
            result.failures?.some((f) => f.fileName.includes("回环图") && f.reason.includes("本地临时地址")),
            true,
        );
    });

    test("desktop native external prep streams and aborts chunked bodies without Content-Length past 32MB", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "chunked-huge",
                type: CanvasNodeType.Video,
                title: "无头大视频",
                metadata: { content: "https://cdn.example.com/chunked-huge.mp4", mimeType: "video/mp4" },
            }),
        ];

        let pulledChunks = 0;
        let cancelled = false;
        const chunkSize = 8 * 1024 * 1024;
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            chooseNativeBatchDir: async () => "tok-stream",
            fetchImpl: (async () => {
                const stream = new ReadableStream<Uint8Array>({
                    pull(controller) {
                        pulledChunks += 1;
                        if (pulledChunks > 20) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(new Uint8Array(chunkSize));
                    },
                    cancel() {
                        cancelled = true;
                    },
                });
                return new Response(stream, { status: 200 });
            }) as typeof fetch,
            saveNativeBatch: async () => ({ saved: 0, failed: 0, cancelled: false }),
        });

        assert.equal(result.downloaded, 0);
        assert.equal(result.failed, 1);
        assert.equal(cancelled, true);
        assert.equal(pulledChunks <= 6, true);
        assert.equal(
            result.failures?.some((f) => f.fileName.includes("无头大视频") && f.reason.includes("32MB")),
            true,
        );
    });

    test("runCanvasBatchDownloadWithFeedback guards concurrent double-trigger and reports per-file failure reasons", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "v1",
                type: CanvasNodeType.Video,
                title: "镜头1",
                metadata: { storageKey: "resource:res-1", mimeType: "video/mp4" },
            }),
        ];
        const logs: string[] = [];
        const msg = {
            loading: (cfg: { content: string }) => logs.push(`loading:${cfg.content}`),
            destroy: () => logs.push("destroy"),
            info: (text: string) => logs.push(`info:${text}`),
            success: (arg: string | { content: string }) => logs.push(`success:${typeof arg === "string" ? arg : arg.content}`),
            warning: (arg: string | { content: string }) => logs.push(`warning:${typeof arg === "string" ? arg : arg.content}`),
            error: (arg: string | { content: string }) => logs.push(`error:${typeof arg === "string" ? arg : arg.content}`),
        };

        let releaseSave!: () => void;
        const waitSave = new Promise<void>((resolve) => {
            releaseSave = resolve;
        });

        const firstRun = runCanvasBatchDownloadWithFeedback(nodes, msg, {
            saveNativeBatch: async () => {
                await waitSave;
                return {
                    saved: 1,
                    failed: 1,
                    cancelled: false,
                    failures: [{ fileName: "02_坏镜头.mp4", reason: "超过 32MB 批量限制，请单独打开保存" }],
                };
            },
        });

        // Second click while first batch is still copying must be ignored with an info hint.
        const secondRun = await runCanvasBatchDownloadWithFeedback(nodes, msg, {
            saveNativeBatch: async () => {
                throw new Error("second concurrent batch must not invoke native save");
            },
        });
        assert.equal(secondRun, null);

        releaseSave();
        await firstRun;

        assert.equal(logs.some((entry) => entry.startsWith("loading:")), true);
        assert.equal(logs.some((entry) => entry === "info:正在批量下载中，请稍候完成"), true);
        assert.equal(
            logs.some((entry) => entry.includes("02_坏镜头.mp4") && entry.includes("超过 32MB 批量限制")),
            true,
        );
    });

    test("batchDownloadCanvasMediaNodes uses authenticated resource blob loader in browser mode", async () => {
        const nodes: CanvasNodeData[] = [
            makeNode({
                id: "owned-browser",
                type: CanvasNodeType.Video,
                title: "本地视频",
                metadata: {
                    storageKey: "resource:res-auth-1",
                    content: "http://127.0.0.1:51234/api/resources/res-auth-1/file",
                    mimeType: "video/mp4",
                },
            }),
        ];

        const loadedKeys: string[] = [];
        const triggered: Array<{ href: string; filename: string }> = [];
        const result = await batchDownloadCanvasMediaNodes(nodes, {
            staggerMs: 0,
            loadResourceBlob: async (storageKey) => {
                loadedKeys.push(storageKey);
                return new Blob(["mp4-bytes"], { type: "video/mp4" });
            },
            triggerDownload: (href, filename) => {
                triggered.push({ href, filename });
            },
        });

        assert.deepEqual(result, { downloaded: 1, failed: 0 });
        assert.deepEqual(loadedKeys, ["resource:res-auth-1"]);
        assert.equal(triggered.length, 1);
        assert.equal(triggered[0]?.filename, "本地视频.mp4");
        assert.equal(triggered[0]?.href.startsWith("blob:"), true);
    });

    test("CanvasNodeContextMenu renders batch download action for multi-selection on node and canvas menus", () => {
        const noop = () => {};
        const baseProps = {
            canUndo: false,
            canRedo: false,
            canPaste: false,
            selectedCount: 3,
            downloadableSelectionCount: 2,
            onClose: noop,
            onAddNode: noop,
            onAddFolder: noop,
            onChooseStyle: noop,
            onOpenDirector: noop,
            onUpload: noop,
            onOpenAssets: noop,
            onOpenProjectCharacters: noop,
            onOpenGenerationHistory: noop,
            onUndo: noop,
            onRedo: noop,
            onPaste: noop,
            onCopyNode: noop,
            onCreateGenerationCopy: noop,
            onDuplicate: noop,
            onDelete: noop,
            onSaveAsset: noop,
            onViewMedia: noop,
            onEditText: noop,
            onOpenDrawing: noop,
            onGenerateImage: noop,
            onCopyContent: noop,
            onCopyMediaUrl: noop,
            onUploadToArkPrivateAsset: noop,
            onSetAssetCategory: noop,
            onToggleFrame: noop,
            onSpreadSelection: noop,
            onCopySelection: noop,
            onDeleteSelection: noop,
            onBatchDownloadSelection: noop,
        };

        const nodeMenuMarkup = renderToStaticMarkup(
            createElement(CanvasNodeContextMenu, {
                ...baseProps,
                menu: { type: "node", x: 100, y: 100, nodeId: "v1" },
            }),
        );
        assert.equal(nodeMenuMarkup.includes("批量下载素材 (2)"), true);

        const canvasMenuMarkup = renderToStaticMarkup(
            createElement(CanvasNodeContextMenu, {
                ...baseProps,
                menu: { type: "canvas", x: 100, y: 100, position: { x: 0, y: 0 } },
            }),
        );
        assert.equal(canvasMenuMarkup.includes("批量下载素材 (2)"), true);
    });

    test("downloadCanvasProjectsMediaByIds aggregates media across canvases, handles empty projects, and guards concurrency", async () => {
        const logs: string[] = [];
        const msg = {
            loading: (cfg: { key: string; content: string }) => logs.push(`loading:${cfg.content}`),
            destroy: (key?: string) => logs.push(`destroy:${key ?? ""}`),
            info: (content: string) => logs.push(`info:${content}`),
            success: (content: string | { content: string }) => logs.push(`success:${typeof content === "string" ? content : content.content}`),
            warning: (content: string | { content: string }) => logs.push(`warning:${typeof content === "string" ? content : content.content}`),
            error: (content: string | { content: string }) => logs.push(`error:${typeof content === "string" ? content : content.content}`),
        };

        // Empty project reports info without opening save dialog.
        let saveCalled = false;
        const emptyResult = await downloadCanvasProjectsMediaByIds(
            ["c-empty"],
            async () => ({ nodes: [makeNode({ id: "t1", type: CanvasNodeType.Text, metadata: { content: "hello" } })] }),
            msg,
            {
                saveNativeBatch: async () => {
                    saveCalled = true;
                    return { saved: 0, failed: 0 };
                },
            },
        );
        assert.equal(emptyResult, null);
        assert.equal(saveCalled, false);
        assert.equal(logs.some((entry) => entry === "info:当前项目暂无可下载的图片、视频或音频素材"), true);

        // Multi-canvas aggregation downloads only valid media nodes and blocks concurrent re-entry while loading.
        let releaseFirstLoad!: () => void;
        const firstLoadGate = new Promise<void>((resolve) => {
            releaseFirstLoad = resolve;
        });
        const downloadedNames: string[] = [];
        const projects: Record<string, CanvasNodeData[]> = {
            "c-1": [
                makeNode({ id: "img-1", type: CanvasNodeType.Image, title: "首帧", metadata: { storageKey: "resource:r1", content: "/api/resources/r1/file", mimeType: "image/png" } }),
                makeNode({ id: "txt-1", type: CanvasNodeType.Text, metadata: { content: "ignored" } }),
            ],
            "c-2": [
                makeNode({ id: "vid-1", type: CanvasNodeType.Video, title: "镜头一", metadata: { storageKey: "resource:r2", content: "/api/resources/r2/file", mimeType: "video/mp4" } }),
            ],
        };

        const run1 = downloadCanvasProjectsMediaByIds(
            ["c-1", "c-2", "c-1"],
            async (id) => {
                if (id === "c-1") await firstLoadGate;
                return { nodes: projects[id] };
            },
            msg,
            {
                loadResourceBlob: async () => new Blob(["ok"], { type: "application/octet-stream" }),
                triggerDownload: (_href, filename) => downloadedNames.push(filename),
                staggerMs: 0,
            },
        );

        const run2 = await downloadCanvasProjectsMediaByIds(
            ["c-1"],
            async () => ({ nodes: projects["c-1"] }),
            msg,
        );
        assert.equal(run2, null);
        assert.equal(logs.some((entry) => entry === "info:正在批量下载中，请稍候完成"), true);

        releaseFirstLoad();
        const outcome = await run1;
        assert.equal(outcome?.downloaded, 2);
        assert.equal(outcome?.failed, 0);
        assert.deepEqual(downloadedNames, ["首帧.png", "镜头一.mp4"]);

        // Load error must surface via message.error instead of looking like an empty project.
        const errLogs: string[] = [];
        const errMsg = {
            loading: (cfg: { key: string; content: string }) => errLogs.push(`loading:${cfg.content}`),
            destroy: (key?: string) => errLogs.push(`destroy:${key ?? ""}`),
            info: (content: string) => errLogs.push(`info:${content}`),
            success: (content: string | { content: string }) => errLogs.push(`success:${typeof content === "string" ? content : content.content}`),
            warning: (content: string | { content: string }) => errLogs.push(`warning:${typeof content === "string" ? content : content.content}`),
            error: (content: string | { content: string }) => errLogs.push(`error:${typeof content === "string" ? content : content.content}`),
        };
        const failedLoad = await downloadCanvasProjectsMediaByIds(
            ["c-broken"],
            async () => {
                throw new Error("画布读取失败（后端不可达）");
            },
            errMsg,
        );
        assert.equal(failedLoad, null);
        assert.equal(errLogs.some((entry) => entry === "error:画布读取失败（后端不可达）"), true);
        assert.equal(errLogs.some((entry) => entry.startsWith("info:当前项目暂无")), false);
    });
});
