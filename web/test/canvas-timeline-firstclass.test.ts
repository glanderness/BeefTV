import { describe, expect, test } from "bun:test";

import {
    buildBrowserRenderSources,
    canUseNativeTimelineRender,
    shouldFallbackToBrowserWasm,
} from "@/components/canvas/canvas-timeline-export";
import {
    applyOutputPreset,
    getOutputPresetKey,
    resolveEffectiveOutputOptions,
} from "@/lib/timeline/timeline-output-presets";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient, ApiError } from "@/services/api/request";
import { beginLocalExecutorSession, runOwnedTimelineRender } from "@/services/local-executor-session";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { TimelineProject } from "@/types/timeline";

function envelope(data: unknown) {
    return { data: { code: 0, data, msg: "" }, status: 200, statusText: "OK", headers: {}, config: {} as never };
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

describe("timeline output presets and native render eligibility", () => {
    test("output preset helpers round-trip auto, 16:9, 9:16, 1:1 and auto-resolve first visual node size", () => {
        expect(getOutputPresetKey(undefined)).toBe("auto");
        const portrait = applyOutputPreset({ fps: 24, burnSubtitles: false }, "9:16");
        expect(portrait).toEqual({ width: 1080, height: 1920, fps: 24, burnSubtitles: false });
        expect(getOutputPresetKey(portrait)).toBe("9:16");

        const square = applyOutputPreset(portrait, "1:1");
        expect(square).toEqual({ width: 1080, height: 1080, fps: 24, burnSubtitles: false });
        expect(getOutputPresetKey(square)).toBe("1:1");

        const auto = applyOutputPreset(square, "auto");
        expect(auto).toEqual({ fps: 24, burnSubtitles: false });
        expect(getOutputPresetKey(auto)).toBe("auto");

        const nodes: CanvasNodeData[] = [{
            id: "node-portrait",
            type: CanvasNodeType.Video,
            title: "竖屏源",
            position: { x: 0, y: 0 },
            width: 300,
            height: 500,
            metadata: { storageKey: "resource:res-p", naturalWidth: 721, naturalHeight: 1281 },
        }];
        const draft: TimelineProject = {
            version: 2,
            durationMs: 3000,
            tracks: [{ id: "v1", kind: "video", label: "视频 1", order: 0 }],
            clips: [{ id: "c1", kind: "video", nodeId: "node-portrait", trackId: "v1", startMs: 0, durationMs: 3000 }],
            output: auto,
        };
        expect(resolveEffectiveOutputOptions(draft, nodes)).toEqual({
            width: 720,
            height: 1280,
            fps: 24,
            burnSubtitles: false,
        });
    });

    test("canUseNativeTimelineRender accepts owned canvas nodes & resource directMedia, rejects inline data URLs", () => {
        const nodes: CanvasNodeData[] = [{
            id: "n-video",
            type: CanvasNodeType.Video,
            title: "视频",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: { storageKey: "resource:res-v1" },
        }];
        const nodeOnlyDraft: TimelineProject = {
            version: 2,
            durationMs: 2000,
            tracks: [{ id: "v1", kind: "video", label: "视频 1", order: 0 }],
            clips: [{ id: "c1", kind: "video", nodeId: "n-video", trackId: "v1", startMs: 0, durationMs: 2000 }],
        };
        expect(canUseNativeTimelineRender("canvas-1", nodeOnlyDraft, nodes)).toBe(true);
        expect(canUseNativeTimelineRender("", nodeOnlyDraft, nodes)).toBe(false);

        const directResourceDraft: TimelineProject = {
            version: 2,
            durationMs: 3000,
            tracks: [{ id: "v1", kind: "video", label: "视频 1", order: 0 }],
            clips: [{
                id: "c-img",
                kind: "image",
                nodeId: "timeline-media-img-1",
                trackId: "v1",
                startMs: 0,
                durationMs: 3000,
                directMedia: { id: "img-1", kind: "image", title: "封面", storageKey: "resource:res-img-1", mimeType: "image/png" },
            }],
        };
        expect(canUseNativeTimelineRender("canvas-empty", directResourceDraft, [])).toBe(true);

        const dataUrlDraft: TimelineProject = {
            ...directResourceDraft,
            clips: [{
                id: "c-data",
                kind: "video",
                nodeId: "data-only",
                trackId: "v1",
                startMs: 0,
                durationMs: 2000,
                directMedia: { id: "d1", kind: "video", title: "inline", content: "data:video/mp4;base64,AA==" },
            }],
        };
        expect(canUseNativeTimelineRender("canvas-1", dataUrlDraft, [])).toBe(false);
    });

    test("shouldFallbackToBrowserWasm falls back only when native local executor is unavailable", () => {
        expect(shouldFallbackToBrowserWasm(new ApiError("不可用", { status: 503, reason: "local_executor_unavailable" }))).toBe(true);
        expect(shouldFallbackToBrowserWasm(new ApiError("不可用", { status: 503, reason: "timeline_render_unavailable" }))).toBe(true);
        expect(shouldFallbackToBrowserWasm(new ApiError("未实现", { status: 501 }))).toBe(true);
        expect(shouldFallbackToBrowserWasm(new ApiError("404", { status: 404 }))).toBe(true);
        expect(shouldFallbackToBrowserWasm(new ApiError("参数错误", { status: 400 }))).toBe(false);
        expect(shouldFallbackToBrowserWasm(new ApiError("无权限", { status: 403 }))).toBe(false);
        expect(shouldFallbackToBrowserWasm(new ApiError("素材未就绪", { status: 412 }))).toBe(false);
        expect(shouldFallbackToBrowserWasm(new Error("ffmpeg 渲染失败"))).toBe(false);
        expect(shouldFallbackToBrowserWasm(new DOMException("Aborted", "AbortError"))).toBe(false);
    });

    test("buildBrowserRenderSources maps MIME extensions for PNG image, M4A audio, and MP4 video", () => {
        const draft: TimelineProject = {
            version: 2,
            durationMs: 5000,
            tracks: [
                { id: "v1", kind: "video", label: "视频 1", order: 0 },
                { id: "a1", kind: "audio", label: "音频 1", order: 1 },
            ],
            clips: [
                { id: "c1", kind: "video", nodeId: "v", trackId: "v1", startMs: 0, durationMs: 2000, directMedia: { id: "v", kind: "video", title: "v", storageKey: "resource:rv", mimeType: "video/mp4" } },
                { id: "c2", kind: "image", nodeId: "i", trackId: "v1", startMs: 2000, durationMs: 3000, directMedia: { id: "i", kind: "image", title: "i", storageKey: "resource:ri", mimeType: "image/png" } },
                { id: "c3", kind: "audio", nodeId: "a", trackId: "a1", startMs: 0, durationMs: 5000, directMedia: { id: "a", kind: "audio", title: "a", storageKey: "resource:ra", mimeType: "audio/mp4" } },
            ],
        };
        const sources = buildBrowserRenderSources(draft, []);
        expect(sources.map((s) => s.fileName)).toEqual(["input-0.mp4", "input-1.png", "input-2.m4a"]);
    });

    test("runOwnedTimelineRender forwards options and resolves canonical task outputs resourceId", async () => {
        const previousScope = getActiveUserScope();
        setActiveUserScope("owner-render");
        let capturedBody: Record<string, unknown> | undefined;
        try {
            await withAdapter(async (config) => {
                const doneTask = {
                    id: "task-native-9x16",
                    type: "timeline_render",
                    status: "succeeded",
                    prompt: "时间线渲染",
                    attempts: 1,
                    createdAt: "2026-11-28T00:00:00.000Z",
                    updatedAt: "2026-11-28T00:00:00.000Z",
                    resultJson: JSON.stringify({ fileName: "timeline-render.mp4", durationMs: 4000 }),
                    outputs: [{ outputIndex: 0, mediaType: "video", resourceId: "res-output-9x16" }],
                };
                if (config.url === "/timeline/renders") {
                    capturedBody = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
                    return envelope(doneTask);
                }
                if (config.url === "/tasks/task-native-9x16") {
                    return envelope(doneTask);
                }
                throw new Error(`unexpected ${config.url}`);
            }, async () => {
                const session = beginLocalExecutorSession("canvas-9x16", {
                    controller: new AbortController(),
                    getLiveProjectId: () => "canvas-9x16",
                });
                const { result } = await runOwnedTimelineRender({
                    session,
                    projectId: "canvas-9x16",
                    timeline: { version: 2, tracks: [], clips: [], durationMs: 4000 },
                    options: { width: 1080, height: 1920, fps: 24, burnSubtitles: false },
                    clientOperationId: "op-9x16",
                    intervalMs: 1,
                    timeoutMs: 1000,
                });
                expect(result.resourceId).toBe("res-output-9x16");
                expect(capturedBody?.projectId).toBe("canvas-9x16");
                expect(capturedBody?.options).toEqual({ width: 1080, height: 1920, fps: 24, burnSubtitles: false });
            });
        } finally {
            setActiveUserScope(previousScope);
        }
    });
});
