import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { readStyleSheet } from "./helpers/app-styles";

const canvasStylesSource = readStyleSheet("../src/styles/globals.css");
const liveViewportSource = readFileSync(resolve(import.meta.dir, "../src/lib/canvas/canvas-live-viewport.ts"), "utf8");

describe("canvas node title interaction", () => {
    test("disables iframe hit testing only during node dragging", () => {
        expect(canvasStylesSource).toMatch(/\[data-canvas-node-dragging="true"\] \.node-element iframe\s*\{\s*pointer-events: none;/);
        expect(liveViewportSource).toContain('if (preview) container.dataset.canvasNodeDragging = "true"');
        expect(liveViewportSource).toContain('else delete container.dataset.canvasNodeDragging');
    });
    test("keeps the toolbar hover bridge from intercepting the external title", () => {
        const hoverBridge = canvasStylesSource.match(/\.canvas-node-toolbar::after\s*\{([\s\S]*?)\}/)?.[1] || "";

        expect(hoverBridge).toContain("pointer-events: none;");
    });
});
