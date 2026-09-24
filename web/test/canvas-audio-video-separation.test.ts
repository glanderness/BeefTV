import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("整段音视频分离不等待播放器先提供时长", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-media-tools.ts"), "utf8");
    const start = source.indexOf("const extractAudioFromVideo = useCallback");
    const end = source.indexOf("const mergeVideosByIds", start);
    const handler = source.slice(start, end);
    expect(handler).not.toContain("resolveCanvasVideoDurationMs");
    expect(handler).not.toContain("视频时长尚未就绪");
    expect(source).not.toContain("{ startMs: 0, endMs: 1 }");
});
