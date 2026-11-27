import { describe, expect, test } from "bun:test";

import {
    applyInlineVideoTrimMetadata,
    formatInlineVideoTrimDuration,
    formatInlineVideoTrimDurationInput,
    formatInlineVideoTrimPoint,
    inlineVideoTrimKeyboardStepMs,
    moveInlineVideoTrimRange,
    normalizeInlineVideoTrimRange,
    parseInlineVideoTrimTimeMs,
    snapInlineVideoTrimHandleMs,
    updateInlineVideoTrimDuration,
    updateInlineVideoTrimEnd,
    updateInlineVideoTrimStart,
} from "../src/lib/canvas/canvas-video-inline-trim";

describe("inline video trim range", () => {
    test("keeps a 100ms minimum selection while clamping both handles to the source", () => {
        expect(normalizeInlineVideoTrimRange({ startMs: -500, endMs: 40 }, 12_000)).toEqual({ startMs: 0, endMs: 100 });
        expect(normalizeInlineVideoTrimRange({ startMs: 11_980, endMs: 15_000 }, 12_000)).toEqual({ startMs: 11_900, endMs: 12_000 });
    });

    test("moves the whole selection without changing its duration or crossing source bounds", () => {
        expect(moveInlineVideoTrimRange({ startMs: 2_000, endMs: 5_000 }, -4_000, 12_000)).toEqual({ startMs: 0, endMs: 3_000 });
        expect(moveInlineVideoTrimRange({ startMs: 8_000, endMs: 11_000 }, 4_000, 12_000)).toEqual({ startMs: 9_000, endMs: 12_000 });
    });

    test("updates start, end, and duration with three-way linkage and clamping", () => {
        // Exact customer workflow: trim 30.08s video down to 30.00s.
        expect(updateInlineVideoTrimDuration({ startMs: 0, endMs: 30_080 }, 30_000, 30_080)).toEqual({ startMs: 0, endMs: 30_000 });
        // If start + target duration exceeds source end, shift start left so duration is still honored.
        expect(updateInlineVideoTrimDuration({ startMs: 5_000, endMs: 30_080 }, 30_000, 30_080)).toEqual({ startMs: 80, endMs: 30_080 });
        expect(updateInlineVideoTrimDuration({ startMs: 2_000, endMs: 10_000 }, 15_000, 30_080)).toEqual({ startMs: 2_000, endMs: 17_000 });
        expect(updateInlineVideoTrimDuration({ startMs: 2_000, endMs: 10_000 }, 99_000, 30_080)).toEqual({ startMs: 0, endMs: 30_080 });

        expect(updateInlineVideoTrimStart({ startMs: 0, endMs: 30_000 }, 1_500, 30_080)).toEqual({ startMs: 1_500, endMs: 30_000 });
        expect(updateInlineVideoTrimStart({ startMs: 0, endMs: 2_000 }, 2_500, 30_080)).toEqual({ startMs: 2_500, endMs: 2_600 });
        expect(updateInlineVideoTrimEnd({ startMs: 5_000, endMs: 30_080 }, 30_000, 30_080)).toEqual({ startMs: 5_000, endMs: 30_000 });
        expect(updateInlineVideoTrimEnd({ startMs: 5_000, endMs: 30_080 }, 2_000, 30_080)).toEqual({ startMs: 1_900, endMs: 2_000 });
    });
});

describe("inline video trim time formatting and parsing", () => {
    test("formats points and durations with carry-safe centisecond rounding", () => {
        expect(formatInlineVideoTrimPoint(0)).toBe("00:00.00");
        expect(formatInlineVideoTrimPoint(30_080)).toBe("00:30.08");
        expect(formatInlineVideoTrimPoint(59_996)).toBe("01:00.00");
        expect(formatInlineVideoTrimPoint(3_661_250)).toBe("1:01:01.25");
        expect(formatInlineVideoTrimDuration(30_080)).toBe("30.08 s");
        expect(formatInlineVideoTrimDuration(30_000)).toBe("30.00 s");
        expect(formatInlineVideoTrimDurationInput(30_080)).toBe("30.08");
    });

    test("parses loose seconds and colon timecodes while rejecting invalid inputs", () => {
        expect(parseInlineVideoTrimTimeMs("30")).toBe(30_000);
        expect(parseInlineVideoTrimTimeMs("30s")).toBe(30_000);
        expect(parseInlineVideoTrimTimeMs("30 秒")).toBe(30_000);
        expect(parseInlineVideoTrimTimeMs("30.08")).toBe(30_080);
        expect(parseInlineVideoTrimTimeMs(".5")).toBe(500);
        expect(parseInlineVideoTrimTimeMs("0:30")).toBe(30_000);
        expect(parseInlineVideoTrimTimeMs("00:30.08")).toBe(30_080);
        expect(parseInlineVideoTrimTimeMs("00：30。08")).toBe(30_080);
        expect(parseInlineVideoTrimTimeMs("1:02:03.45")).toBe(3_723_450);

        expect(parseInlineVideoTrimTimeMs("")).toBeNull();
        expect(parseInlineVideoTrimTimeMs("-5")).toBeNull();
        expect(parseInlineVideoTrimTimeMs("abc")).toBeNull();
        expect(parseInlineVideoTrimTimeMs("1:2:3:4")).toBeNull();
        expect(parseInlineVideoTrimTimeMs("00:30.08.1")).toBeNull();
        expect(parseInlineVideoTrimTimeMs(`${"9".repeat(400)}:00`)).toBeNull();
    });
});

describe("inline video trim snapping and keyboard step", () => {
    test("snaps a 30.08s video end handle to exact 30.00s on a compact 300px track", () => {
        // 1px left on a 300px track for a 30.08s video lands at ~29.98s, which snaps to 30.00s.
        expect(snapInlineVideoTrimHandleMs("end", 29_980, 0, 30_080, 300)).toEqual({ valueMs: 30_000, snapped: true });
        // Moving far enough away breaks free cleanly.
        expect(snapInlineVideoTrimHandleMs("end", 29_600, 0, 30_080, 300)).toEqual({ valueMs: 29_600, snapped: false });
        // Holding Shift/Alt disables snapping for exact frame adjustments.
        expect(snapInlineVideoTrimHandleMs("end", 29_980, 0, 30_080, 300, { disableSnap: true })).toEqual({ valueMs: 29_980, snapped: false });
        // Also snaps selected span duration to whole seconds when start is non-integer.
        expect(snapInlineVideoTrimHandleMs("end", 31_460, 1_500, 35_000, 300)).toEqual({ valueMs: 31_500, snapped: true });
    });

    test("resolves default, Shift coarse, and Alt fine keyboard steps", () => {
        expect(inlineVideoTrimKeyboardStepMs({})).toBe(100);
        expect(inlineVideoTrimKeyboardStepMs({ shiftKey: true })).toBe(1000);
        expect(inlineVideoTrimKeyboardStepMs({ altKey: true })).toBe(10);
    });
});

describe("inline video trim metadata", () => {
    test("replaces the current media while retaining the original source and selected range", () => {
        const metadata = applyInlineVideoTrimMetadata(
            {
                content: "blob:original",
                storageKey: "resources/original",
                durationMs: 12_000,
                naturalWidth: 1920,
                naturalHeight: 1080,
                assetId: "old-asset",
                prompt: "uploaded clip",
            },
            {
                content: "blob:trimmed",
                storageKey: "resources/trimmed",
                durationMs: 3_000,
                naturalWidth: 1920,
                naturalHeight: 1080,
            },
            { startMs: 2_000, endMs: 5_000 },
        );

        expect(metadata).toMatchObject({
            content: "blob:trimmed",
            storageKey: "resources/trimmed",
            durationMs: 3_000,
            assetId: undefined,
            prompt: "uploaded clip",
            videoTrimStartMs: 2_000,
            videoTrimEndMs: 5_000,
            videoTrimSource: {
                content: "blob:original",
                storageKey: "resources/original",
                durationMs: 12_000,
                naturalWidth: 1920,
                naturalHeight: 1080,
            },
        });
    });
});
