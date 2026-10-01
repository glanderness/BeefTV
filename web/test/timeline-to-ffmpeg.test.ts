import { describe, expect, test } from "bun:test";

import { buildTimelineRenderPlan, formatSrtTimestamp, type TimelineRenderSource } from "../src/lib/timeline/timeline-to-ffmpeg";
import type { TimelineClip, TimelineProject } from "../src/types/timeline";

function videoClip(id: string, nodeId: string, startMs: number, durationMs: number): TimelineClip {
    return { id, kind: "video", nodeId, trackId: "video", startMs, durationMs, title: id, sourceStartMs: 0, sourceDurationMs: durationMs };
}

function timeline(clips: TimelineClip[]): TimelineProject {
    return { version: 2, tracks: [], clips, durationMs: clips.reduce((max, clip) => Math.max(max, clip.startMs + clip.durationMs), 0) };
}

function source(nodeId: string): TimelineRenderSource {
    return { nodeId, fileName: `input-${nodeId}.mp4`, durationMs: 15_000, url: `file:///${nodeId}.mp4` };
}

/** 从导出计划推导 concat 后的总时长：trim 用 -t，gap 用 lavfi 黑场 d=。 */
function concatTotalSeconds(plan: ReturnType<typeof buildTimelineRenderPlan>): number {
    let total = 0;
    for (const entry of plan.concatEntries) {
        const step = plan.steps.find((item) => item.output === entry);
        if (step?.kind === "trim") total += Number(step.args[step.args.indexOf("-t") + 1]);
        if (step?.kind === "gap") {
            const lavfi = step.args.find((arg) => arg.startsWith("color=c=black")) || "";
            total += Number(lavfi.split("d=")[1]);
        }
    }
    return total;
}

/** 按 concat 顺序逐段累加，校验每个片段/黑场在成片中的实际起点与时间线期望一致。 */
function concatStartOffsetsMs(plan: ReturnType<typeof buildTimelineRenderPlan>): number[] {
    const offsets: number[] = [];
    let cursor = 0;
    for (const entry of plan.concatEntries) {
        const step = plan.steps.find((item) => item.output === entry);
        if (!step) continue;
        offsets.push(cursor);
        if (step.kind === "trim") cursor += Number(step.args[step.args.indexOf("-t") + 1]) * 1000;
        if (step.kind === "gap") {
            const lavfi = step.args.find((arg) => arg.startsWith("color=c=black")) || "";
            cursor += Number(lavfi.split("d=")[1]) * 1000;
        }
    }
    return offsets;
}

describe("buildTimelineRenderPlan 片段与黑场对齐", () => {
    test("全部片段有源素材且首尾相接：无黑场、concat 顺序=片段顺序、总长等于时间线", () => {
        const project = timeline([videoClip("a", "node-a", 0, 15_000), videoClip("b", "node-b", 15_000, 4_000), videoClip("c", "node-c", 19_000, 15_000)]);
        const plan = buildTimelineRenderPlan(project, [source("node-a"), source("node-b"), source("node-c")], { width: 1280, height: 720, fps: 30, outputName: "out.mp4" });
        expect(plan.steps.filter((step) => step.kind === "gap")).toHaveLength(0);
        expect(concatTotalSeconds(plan)).toBe(34);
        expect(plan.concatEntries).toEqual(["trim-0.mp4", "trim-1.mp4", "trim-2.mp4"]);
    });

    test("全部有源但中间有空隙：黑场必须插在片段之间，而不是追加到片尾", () => {
        // A(0-15s) 与 B(25-40s) 之间有 10s 空隙：修复前 concat=[trim-0,trim-1,gap-1]（黑场在片尾，字幕错位）。
        const project = timeline([videoClip("a", "node-a", 0, 15_000), videoClip("b", "node-b", 25_000, 15_000)]);
        const plan = buildTimelineRenderPlan(project, [source("node-a"), source("node-b")], { width: 1280, height: 720, fps: 30, outputName: "out.mp4" });
        expect(plan.concatEntries).toEqual(["trim-0.mp4", "gap-1.mp4", "trim-1.mp4"]);
        const gaps = plan.steps.filter((step) => step.kind === "gap");
        expect(gaps).toHaveLength(1);
        expect(gaps[0].args.join(" ")).toContain("d=10");
        expect(concatTotalSeconds(plan)).toBe(40);
        // B 在成片中的起点 = 15s + 10s 黑场 = 25s，与时间线一致。
        expect(concatStartOffsetsMs(plan)).toEqual([0, 15_000, 25_000]);
    });

    test("缺少任何媒体源必须明确失败", () => {
        const project = timeline([videoClip("a", "node-a", 0, 1000), videoClip("b", "node-b", 1000, 1000)]);
        expect(() => buildTimelineRenderPlan(project, [source("node-a")])).toThrow("找不到素材");
    });

    test("重叠视频必须明确失败", () => {
        expect(() => buildTimelineRenderPlan(timeline([videoClip("a", "a", 0, 2000), videoClip("b", "b", 1000, 1000)]), [source("a"), source("b")])).toThrow("重叠");
    });

    test("独立配音与BGM包含裁剪、延迟、音量和淡入淡出", () => {
        const project = timeline([videoClip("v", "v", 0, 3000), { ...videoClip("voice", "voice", 500, 1500), kind: "audio", sourceStartMs: 100, volume: 0, fadeInMs: 100, fadeOutMs: 200 }, { ...videoClip("bgm", "bgm", 0, 3000), kind: "audio" }]);
        const plan = buildTimelineRenderPlan(project, [source("v"), source("voice"), source("bgm")]);
        const mix = plan.steps.find((step) => step.kind === "mix")!;
        expect(mix.args.join(" ")).toContain("atrim=start=0.1:duration=1.5");
        expect(mix.args.join(" ")).toContain("volume=0,afade=t=in:d=0.1,afade=t=out:st=1.3:d=0.2,adelay=500:all=1");
        expect(mix.args.join(" ")).toContain("amix=inputs=3:normalize=0");
    });

    test("隐藏与静音音轨无需加载源", () => {
        const project = timeline([videoClip("v", "v", 0, 1000), { ...videoClip("a", "a", 0, 1000), kind: "audio", trackId: "muted" }]);
        project.tracks = [{ id: "muted", kind: "audio", label: "BGM", order: 1, muted: true }];
        expect(buildTimelineRenderPlan(project, [source("v")]).steps.some((step) => step.kind === "mix")).toBe(false);
    });

    test("未探测音轨时默认保留源音频，探测失败才改静音", () => {
        const project = timeline([videoClip("a", "node-a", 0, 1000)]);
        const keep = buildTimelineRenderPlan(project, [source("node-a")]);
        expect(keep.steps.find((step) => step.kind === "trim")!.args.join(" ")).toContain("-map 0:a:0");
        const silent = buildTimelineRenderPlan(project, [{ ...source("node-a"), hasAudio: false }]);
        expect(silent.steps.find((step) => step.kind === "trim")!.args.join(" ")).toContain("-map 1:a:0");
    });

    test("请求清单包含视频、独立音轨和字幕，且计划必须包含对应步骤", () => {
        const project = timeline([
            videoClip("v", "v", 0, 3000),
            { ...videoClip("voice", "voice", 0, 3000), kind: "audio" },
            { id: "s", kind: "subtitle", nodeId: "s", trackId: "s", startMs: 0, durationMs: 3000, text: "中文" },
        ]);
        const plan = buildTimelineRenderPlan(project, [source("v"), source("voice")]);
        expect(plan.request).toEqual({
            videoClipIds: ["v"],
            audioClipIds: ["voice"],
            subtitleClipIds: ["s"],
            durationMs: 3000,
            burnSubtitles: true,
        });
        expect(plan.steps.some((step) => step.kind === "mix")).toBe(true);
        expect(plan.steps.some((step) => step.kind === "burn")).toBe(true);
    });
});

describe("trim 步骤输出 seek（-ss 在 -i 之后）", () => {
    test("裁切参数必须把 -ss 放在 -i 之后：输入 seek 会按关键帧对齐导致切点偏移", () => {
        const project = timeline([videoClip("a", "node-a", 0, 15_000)]);
        const plan = buildTimelineRenderPlan(project, [source("node-a")], { width: 1280, height: 720, fps: 30, outputName: "out.mp4" });
        const trims = plan.steps.filter((step) => step.kind === "trim");
        expect(trims).toHaveLength(1);
        const args = trims[0].args;
        const inputIndex = args.indexOf("-i");
        const ssIndex = args.indexOf("-ss");
        expect(inputIndex).toBeGreaterThan(-1);
        expect(ssIndex).toBeGreaterThan(-1);
        // -ss 必须在 -i 之后（输出 seek，帧精确）；在 -i 之前是输入 seek，MP4/H.264 只对齐关键帧。
        expect(ssIndex).toBeGreaterThan(inputIndex);
    });
});

describe("formatSrtTimestamp", () => {
    test("SRT 时间码毫秒对齐三位", () => {
        expect(formatSrtTimestamp(3_600_000 + 60_000 + 1_234)).toBe("01:01:01,234");
        expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    });
});
