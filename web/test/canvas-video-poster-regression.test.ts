import { afterEach, expect, test } from "bun:test";

import { CANVAS_VIDEO_PREVIEW_VERSION, canvasVideoPreviewNeedsHydration } from "../src/services/canvas-video-preview";
import { capturePresentedVideoPoster } from "../src/lib/video-poster";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = (videoPreview?: CanvasNodeData["metadata"]["videoPreview"]): CanvasNodeData => ({
    id: "video-1",
    type: CanvasNodeType.Video,
    title: "video.mp4",
    position: { x: 0, y: 0 },
    width: 720,
    height: 405,
    metadata: {
        content: "/api/resources/source/file",
        storageKey: "resource:source",
        videoPreview,
    },
});

test("legacy and source-mismatched posters are hydrated again", () => {
    expect(canvasVideoPreviewNeedsHydration(node({ content: "/api/resources/old-poster/file" }))).toBe(true);
    expect(
        canvasVideoPreviewNeedsHydration(
            node({
                content: "/api/resources/poster/file",
                captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
                sourceKey: "resource:other-source",
            }),
        ),
    ).toBe(true);
    expect(
        canvasVideoPreviewNeedsHydration(
            node({
                content: "/api/resources/poster/file",
                captureVersion: CANVAS_VIDEO_PREVIEW_VERSION,
                sourceKey: "resource:source",
            }),
        ),
    ).toBe(false);
});

test("poster capture waits for a presented video frame before drawing", async () => {
    let presented: (() => void) | undefined;
    let drawCount = 0;
    const video = Object.assign(new EventTarget(), {
        videoWidth: 1920,
        videoHeight: 1080,
        duration: 10,
        currentTime: 0.001,
        readyState: 4,
        requestVideoFrameCallback(callback: () => void) {
            presented = callback;
            return 1;
        },
        async play() {},
        pause() {},
    }) as unknown as HTMLVideoElement;
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
            fillStyle: "",
            fillRect() {},
            drawImage() {
                drawCount += 1;
            },
        }),
        toBlob(callback: BlobCallback) {
            callback(new Blob(["poster"], { type: "image/jpeg" }));
        },
    } as unknown as HTMLCanvasElement;

    const resultPromise = capturePresentedVideoPoster(video, canvas, { maxWidth: 400, timeoutMs: 1_000 });
    await Promise.resolve();
    expect(drawCount).toBe(0);
    presented?.();
    const result = await resultPromise;

    expect(drawCount).toBe(1);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.poster?.type).toBe("image/jpeg");
});

afterEach(() => {
    // The production capture queue is serialized; let settled microtasks flush
    // before another test replaces browser primitives.
    return Promise.resolve();
});

type FakeFrame = { pixel: number | number[] } | { throws: true };

function presentedVideo() {
    return Object.assign(new EventTarget(), {
        videoWidth: 1920,
        videoHeight: 1080,
        duration: 10,
        currentTime: 0.001,
        readyState: 4,
        requestVideoFrameCallback(callback: () => void) {
            callback();
            return 1;
        },
        async play() {},
        pause() {},
    }) as unknown as HTMLVideoElement;
}

function canvasReading(frame: FakeFrame, draws: { count: number }) {
    const pixels = "pixel" in frame && Array.isArray(frame.pixel) ? [...frame.pixel] : undefined;
    return {
        width: 0,
        height: 0,
        getContext: () => ({
            fillStyle: "",
            fillRect() {},
            drawImage() {
                draws.count += 1;
            },
            getImageData: (_x: number, _y: number, width: number, height: number) => {
                if ("throws" in frame) throw new DOMException("tainted", "SecurityError");
                const pixel = pixels ? pixels[Math.min(draws.count - 1, pixels.length - 1)] : (frame as { pixel: number }).pixel;
                return { data: new Uint8ClampedArray(width * height * 4).fill(pixel) };
            },
        }),
        toBlob(callback: BlobCallback) {
            callback(new Blob(["poster"], { type: "image/jpeg" }));
        },
    } as unknown as HTMLCanvasElement;
}

test("a first frame that decoded to an all-black surface yields no poster when the caller rejects blank frames", async () => {
    // 刚生成完的视频在部分 WebView 上会先画出一张全黑图，画布预览拿它当首帧就是一个黑框，
    // 所以画布预览这条路径要求重试/退回占位；导出和分享等共用同一段取帧代码的路径不受影响。
    const draws = { count: 0 };
    const blank = await capturePresentedVideoPoster(presentedVideo(), canvasReading({ pixel: 0 }, draws), { maxWidth: 400, timeoutMs: 1_000, rejectBlankFrame: true });
    expect(draws.count).toBe(3);
    expect(blank.poster).toBeUndefined();

    const dark = await capturePresentedVideoPoster(presentedVideo(), canvasReading({ pixel: 24 }, draws), { maxWidth: 400, timeoutMs: 1_000, rejectBlankFrame: true });
    expect(dark.poster).toBeInstanceOf(Blob);
});

test("a blank first draw is redrawn once the next frame arrives", async () => {
    const draws = { count: 0 };
    // 第一次画出来是全黑，下一帧才有画面：这是刚生成完的视频最典型的表现。
    const result = await capturePresentedVideoPoster(presentedVideo(), canvasReading({ pixel: [0, 96] }, draws), { maxWidth: 400, timeoutMs: 1_000, rejectBlankFrame: true });
    expect(draws.count).toBe(2);
    expect(result.poster).toBeInstanceOf(Blob);
});

test("the shared capture path still keeps a black first frame by default", async () => {
    const draws = { count: 0 };
    const result = await capturePresentedVideoPoster(presentedVideo(), canvasReading({ pixel: 0 }, draws), { maxWidth: 400, timeoutMs: 1_000 });
    expect(result.poster).toBeInstanceOf(Blob);
});

test("a poster that cannot be inspected is kept instead of dropped", async () => {
    const draws = { count: 0 };
    const result = await capturePresentedVideoPoster(presentedVideo(), canvasReading({ throws: true }, draws), { maxWidth: 400, timeoutMs: 1_000, rejectBlankFrame: true });
    expect(result.poster).toBeInstanceOf(Blob);
});
