import { describe, expect, test } from "bun:test";

import { buildCopyAudioArgs, buildExtractAudioArgs, buildRemoveAudioArgs, buildSegmentTrimArgs, AUDIO_COPY_OUTPUT_NAME, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME, SEGMENT_OUTPUT_NAME } from "../src/lib/canvas/canvas-video-segment-args";

describe("buildSegmentTrimArgs seek 顺序", () => {
    test("-ss 必须放在 -i 之后（输出 seek）：输入 seek 按关键帧对齐，切点会偏移最多一个 GOP", () => {
        const args = buildSegmentTrimArgs("10.5", "4");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual(["-i", SEGMENT_INPUT_NAME, "-ss", "10.5", "-t", "4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", SEGMENT_OUTPUT_NAME]);
    });
});

describe("buildExtractAudioArgs seek 顺序", () => {
    test("整段音轨提取不依赖时长或 seek", () => {
        const args = buildExtractAudioArgs("libmp3lame");
        expect(args).toEqual(["-i", SEGMENT_INPUT_NAME, "-vn", "-c:a", "libmp3lame", "-q:a", "2", SEGMENT_OUTPUT_NAME]);
    });
});

describe("buildCopyAudioArgs", () => {
    test("整段复制源音轨并显式映射第一条音频流", () => {
        expect(buildCopyAudioArgs()).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-map", "0:a:0?", "-vn", "-c:a", "copy", "-movflags", "+faststart", AUDIO_COPY_OUTPUT_NAME,
        ]);
    });
});

describe("buildRemoveAudioArgs", () => {
    test("整段无声视频不做 seek，保留零秒开始的第一组 GOP", () => {
        expect(buildRemoveAudioArgs()).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", MUTED_VIDEO_OUTPUT_NAME,
        ]);
    });
});
