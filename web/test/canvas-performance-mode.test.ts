import { describe, expect, test } from "bun:test";

import { shouldReduceCanvasMediaEffects } from "../src/lib/canvas/canvas-performance-mode";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function makeNodes(type: CanvasNodeType, count: number, prefix = type): CanvasNodeData[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        type,
        title: `${prefix}-${index}`,
        position: { x: index * 100, y: 0 },
        width: 320,
        height: 180,
    }));
}

describe("shouldReduceCanvasMediaEffects", () => {
    test("returns false in auto mode when total, media, and video node counts are below thresholds", () => {
        const nodes = [
            ...makeNodes(CanvasNodeType.Video, 5, "v"),
            ...makeNodes(CanvasNodeType.Image, 12, "img"),
            ...makeNodes(CanvasNodeType.Text, 10, "txt"),
        ];
        expect(shouldReduceCanvasMediaEffects("auto", nodes)).toBe(false);
    });

    test("returns true in auto mode when videoCount reaches 6 even if total media < 20", () => {
        const nodes = [
            ...makeNodes(CanvasNodeType.Video, 6, "v"),
            ...makeNodes(CanvasNodeType.Image, 4, "img"),
        ];
        expect(shouldReduceCanvasMediaEffects("auto", nodes)).toBe(true);
    });

    test("returns true in auto mode when mediaCount reaches 20", () => {
        const nodes = [
            ...makeNodes(CanvasNodeType.Image, 16, "img"),
            ...makeNodes(CanvasNodeType.Audio, 4, "aud"),
        ];
        expect(shouldReduceCanvasMediaEffects("auto", nodes)).toBe(true);
    });

    test("returns true in auto mode when total node count reaches 48", () => {
        const nodes = makeNodes(CanvasNodeType.Text, 48, "txt");
        expect(shouldReduceCanvasMediaEffects("auto", nodes)).toBe(true);
    });

    test("honors explicit performance and quality modes regardless of node counts", () => {
        expect(shouldReduceCanvasMediaEffects("performance", [])).toBe(true);
        expect(shouldReduceCanvasMediaEffects("quality", makeNodes(CanvasNodeType.Video, 16, "v"))).toBe(false);
    });
});
