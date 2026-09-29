import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorViewportDock } from "../src/components/canvas/director/director-viewport-dock";

describe("导演台视口变换菜单", () => {
    test("静止状态只有一个与当前模式一致的变换入口，并暴露菜单语义", () => {
        for (const [mode, label] of [["translate", "移动"], ["rotate", "旋转"], ["scale", "缩放"]] as const) {
            const html = renderToStaticMarkup(createElement(DirectorViewportDock, {
                transformMode: mode,
                renderMode: "beauty",
                renderModes: ["beauty"],
                onTransformModeChange: () => {},
                onRenderModeChange: () => {},
                onAddActor: () => {},
                onAddBox: () => {},
                onAddLight: () => {},
                onAddCamera: () => {},
                onAlignCamera: () => {},
                timelineOpen: false,
                onToggleTimeline: () => {},
            }));
            expect(html).toContain(`aria-label="${label}"`);
            expect(html).toContain('aria-haspopup="menu"');
            expect(html).not.toContain('aria-label="移动对象"');
            expect(html).not.toContain('aria-label="旋转对象"');
            expect(html).not.toContain('aria-label="缩放对象"');
            expect(html).toContain('aria-label="添加演员"');
        }
    });

    test("底部时间轴按钮随展开状态呈现按下态", () => {
        for (const timelineOpen of [false, true]) {
            const html = renderToStaticMarkup(createElement(DirectorViewportDock, {
                transformMode: "translate", renderMode: "beauty", renderModes: ["beauty"],
                onTransformModeChange: () => {}, onRenderModeChange: () => {},
                onAddActor: () => {}, onAddBox: () => {}, onAddLight: () => {}, onAddCamera: () => {}, onAlignCamera: () => {},
                timelineOpen, onToggleTimeline: () => {},
            }));
            expect(html).toContain(`aria-label="动画时间轴" aria-pressed="${timelineOpen}"`);
        }
    });
});
