import { describe, expect, test } from "bun:test";

import { isUsableVideoPosterPixels, videoPosterCandidateTimes } from "../src/lib/video-poster";

describe("video poster frame quality", () => {
    test("rejects an all-black decoded frame instead of persisting it as the inactive preview", () => {
        const blackFrame = new Uint8ClampedArray(16 * 16 * 4);
        for (let offset = 3; offset < blackFrame.length; offset += 4) blackFrame[offset] = 255;

        expect(isUsableVideoPosterPixels(blackFrame)).toBe(false);
    });

    test("falls forward to later frames when the first presented frame is unusable", () => {
        expect(videoPosterCandidateTimes(10_000)).toEqual([0, 100, 500]);
    });
});
