import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workbench = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-workbench.tsx"), "utf8");
const composer = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-preview-composer.tsx"), "utf8");

describe("导演台成片预演输入条", () => {
    test("预演提供当前镜头意图输入并把变更写回当前镜头", () => {
        expect(workbench).toContain("<DirectorPreviewComposer");
        expect(workbench).toContain("prompt={activeShot.prompt}");
        expect(workbench).toContain("onPromptChange={(prompt) => replaceWithoutHistory");
        expect(composer).toContain('aria-label="当前镜头意图"');
    });

    test("预演隐藏导演视角与方向球工具，但视口仍保留已选取景模式", () => {
        expect(workbench).toContain('onViewModeChange={workspaceView === "scene" ? setViewMode : undefined}');
    });
});
