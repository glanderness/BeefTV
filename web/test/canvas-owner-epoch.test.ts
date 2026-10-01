import { expect, test } from "bun:test";

import { captureCanvasOwnerEpoch, canvasOwnerEpochMatches, readOwnedCanvasNodes } from "@/pages/canvas/canvas-owner-epoch";

test("matches exact canvas and user, and reads stored nodes after a switch", () => {
    const owner = captureCanvasOwnerEpoch("canvas-a", "user-a");
    expect(canvasOwnerEpochMatches(owner, "canvas-a", "user-a")).toBe(true);
    expect(canvasOwnerEpochMatches(owner, "canvas-a", "user-b")).toBe(false);
    expect(canvasOwnerEpochMatches(owner, "canvas-b", "user-a")).toBe(false);
    expect(readOwnedCanvasNodes({
        owner,
        liveCanvasId: "canvas-b",
        liveUserScope: "user-a",
        pageNodes: [{ id: "new" }],
        storedNodes: [{ id: "original" }],
    })).toEqual([{ id: "original" }]);
    expect(readOwnedCanvasNodes({
        owner,
        liveCanvasId: "canvas-a",
        liveUserScope: "user-a",
        pageNodes: [{ id: "page" }],
        storedNodes: [{ id: "original" }],
    })).toEqual([{ id: "page" }]);
});
