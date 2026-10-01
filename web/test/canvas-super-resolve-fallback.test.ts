import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dialog = readFileSync(new URL("../src/pages/canvas/canvas-project-status-dialogs.tsx", import.meta.url), "utf8");
const project = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const editorDialogs = readFileSync(new URL("../src/pages/canvas/canvas-project-editor-dialogs.tsx", import.meta.url), "utf8");

test("AI super-resolution keeps a usable local upscale fallback", () => {
    expect(dialog).toContain("onUseLocalUpscale: () => void");
    expect(dialog).toContain("使用本地高质量放大");
    expect(dialog).not.toContain("暂未实现");
    expect(project).toContain("onUseLocalUpscale:");
    expect(project).toContain('targetLongEdge: 2048, algorithm: "high"');
    expect(editorDialogs).toContain("onUseLocalUpscale={status.onUseLocalUpscale}");
});
