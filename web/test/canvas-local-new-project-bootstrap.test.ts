import { describe, expect, test } from "bun:test";

import { canAutoOpenCanvasEntry } from "@/pages/canvas";

describe("local new canvas entry bootstrap", () => {
    test("mode=new waits for local-store hydration but proceeds while historical canvases are still loading", () => {
        expect(
            canAutoOpenCanvasEntry({
                hydrated: false,
                alreadyOpened: false,
                mode: "new",
                canvasHealth: { loading: false, error: "" },
            }),
        ).toBe(false);

        expect(
            canAutoOpenCanvasEntry({
                hydrated: true,
                alreadyOpened: false,
                mode: "new",
                canvasHealth: { loading: true, error: "" },
            }),
        ).toBe(true);

        expect(
            canAutoOpenCanvasEntry({
                hydrated: true,
                alreadyOpened: true,
                mode: "new",
                canvasHealth: { loading: false, error: "" },
            }),
        ).toBe(false);
    });

    test("mode=recent and handoff wait for canvas hydration health before auto-opening", () => {
        expect(
            canAutoOpenCanvasEntry({
                hydrated: true,
                alreadyOpened: false,
                mode: "recent",
                canvasHealth: { loading: true, error: "" },
            }),
        ).toBe(false);

        expect(
            canAutoOpenCanvasEntry({
                hydrated: true,
                alreadyOpened: false,
                mode: "recent",
                canvasHealth: { loading: false, error: "load failed" },
            }),
        ).toBe(false);

        expect(
            canAutoOpenCanvasEntry({
                hydrated: true,
                alreadyOpened: false,
                mode: "recent",
                canvasHealth: { loading: false, error: "" },
            }),
        ).toBe(true);

        expect(
            canAutoOpenCanvasEntry({
                hydrated: true,
                alreadyOpened: false,
                mode: null,
                canvasHealth: { loading: false, error: "" },
            }),
        ).toBe(false);
    });
});
