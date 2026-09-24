import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectPreview } from "../src/components/canvas/canvas-project-card";

describe("asset library category sidebar", () => {
    test("keeps type, business and folder filters in the product asset workspace", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/workspace-product.css"), "utf8");
        expect(page).toContain("assets-collection-layout");
        expect(page).toContain('aria-label="素材分类"');
        expect(page).toContain('title="素材类型"');
        expect(page).toContain('title="标签与分类"');
        expect(page).toContain("我的分类");
        expect(page).not.toContain("全部自定义分类");
        expect(css).toContain(".assets-library-source-rail");
        expect(css).toContain(".assets-library-source-rail");
    });
});

describe("asset upload entry points", () => {
    test("empty state opens regular image/video upload instead of the ZIP importer", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const modal = readFileSync(resolve(import.meta.dir, "../src/pages/assets/asset-batch-upload-modal.tsx"), "utf8");
        expect(page).toContain("<AssetsEmptyState onImport={() => setBatchUploadOpen(true)} />");
        expect(modal).toContain('accept="image/*,video/*"');
        expect(modal).toContain("uploadMediaFile");
        expect(modal).toContain('message.warning(\"请选择图片或视频文件\")');
        expect(modal).not.toContain('title="批量上传图片"');
    });

    test("matches LibTV personal-library new menu", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        expect(page).toContain('label: "上传资产"');
        expect(page).toContain('label: "新建文件夹"');
        expect(page).not.toContain('label: "新建文本素材"');
    });
});

describe("project card actions", () => {
    test("project cards expose the LibTV-style overflow actions", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/projects/index.tsx"), "utf8");
        expect(page).toContain('aria-label={`${row.project.name} 更多操作`}');
        expect(page).toContain('label: "打开"');
        expect(page).toContain('label: "重命名"');
        expect(page).toContain('label: "修改封面"');
        expect(page).toContain('label: "创建副本"');
        expect(page).toContain('label: "移动至文件夹"');
        expect(page).toContain("duplicateProject");
        expect(page).toContain("moveProjectToFolder");
        expect(page).toContain('label: row.project.status === "archived" ? "恢复项目" : "归档项目"');
        expect(page).toContain('label: "删除项目"');
        expect(page).toContain("updateProject");
        const canvasCard = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-folder-card.tsx"), "utf8");
        expect(canvasCard).toContain('label: "打开"');
        expect(canvasCard).toContain('label: "重命名"');
        expect(canvasCard).toContain('label: "移动至文件夹"');
        expect(canvasCard).toContain("<LibraryCardShell");
        expect(canvasCard).toContain('label: "创建副本"');
        expect(canvasCard).toContain('label: "修改封面"');
        expect(canvasCard).toContain("beeftv-project-cover:");
        expect(canvasCard).toContain('toDataURL("image/jpeg", 0.84)');
        expect(canvasCard).toContain("onDuplicate");
        expect(canvasCard).not.toContain("summarizePreviewNodeTypes");
        expect(canvasCard).not.toContain("canvas-collection-node-types");
        const previewCard = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-project-card.tsx"), "utf8");
        expect(previewCard).toContain('preload="auto"');
        expect(previewCard).toContain("firstVideo || firstImage");
        const canvasPage = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/index.tsx"), "utf8");
        expect(canvasPage).toContain("<LibraryCardShell");
        expect(canvasPage).toContain("maxSize = 1280");
        expect(canvasPage).toContain('toDataURL("image/jpeg", 0.84)');
        expect(canvasPage).toContain("封面图片不能超过 12MB");
        expect(canvasPage).toContain("封面请选择图片文件");
        expect(canvasPage).toContain("onOpen={() => setFolderFilter(folder.id)}");
        expect(canvasPage).toContain('label: "更换封面"');
        expect(canvasPage).not.toContain('icon: <ImageIcon className="size-3.5" />');
        expect(canvasPage).toContain('label: "删除文件夹"');
        expect(canvasPage).not.toContain('icon: <Pencil className="size-3.5" />');
        const historyDrawer = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-history-drawer.tsx"), "utf8");
        expect(historyDrawer).toContain("restoreProject");
        expect(historyDrawer).toContain("恢复到项目列表");
        expect(historyDrawer).toContain("已删除");
        const styles = readFileSync(resolve(import.meta.dir, "../src/styles/workspace-product.css"), "utf8");
        expect(canvasCard).not.toContain("canvas-collection-rename");
        expect(styles).toContain(".app-user-workspace .lib-tv-project-page .canvas-collection-select");
        expect(styles).toContain("top: auto; right: 8px; bottom: 24px");
        expect(styles).toContain("canvas-collection-preview");
        expect(styles).toContain(".libtv-folder-card-more { position: absolute; top: auto;");
        expect(styles).toContain(".libtv-folder-card-body { display: flex; flex-direction: column; align-items: flex-start;");
        expect(styles).toContain("gap: 2px; padding: 10px 12px;");
        expect(styles).toContain("libtv-folder-card-body { min-height: 58px; padding: 8px 40px 8px 8px;");
        const globalStyles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");
        expect(globalStyles).toContain("min-height: 230.8px");
        expect(globalStyles).toContain("height: 34.8px !important");
        expect(page).toContain('label: "打开"');
    });
});

describe("empty project cover", () => {
    test("centers the visible default icon without an invisible spacer", () => {
        const html = renderToStaticMarkup(React.createElement(ProjectPreview, { project: { id: "empty-project", nodes: [] }, emptyVariant: "libtv" }));

        expect(html).toContain("canvas-project-empty-icon");
        expect(html).not.toContain("canvas-project-empty-image");
    });
});

describe("asset card actions", () => {
    test("asset overflow menu supports tag editing for every asset kind", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        expect(page).toContain('label: "编辑标签"');
        expect(page).toContain('label: asset.metadata?.favorite === true ? "取消收藏" : "收藏"');
        expect(page).toContain("openTagEditor");
        expect(page).toContain("标签已更新");
    });

    test("asset overflow trigger behaves as an isolated menu control", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        expect(page).toContain('aria-haspopup="menu"');
        expect(page).toContain('onClick={(event) => event.stopPropagation()}');
    });
});

describe("generation history card actions", () => {
    test("matches LibTV hover controls for download and recycle", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/assets-reference-baseline.css"), "utf8");
        expect(page).toContain('aria-label="生成结果操作"');
        expect(page).toContain('aria-label={`下载 ${asset.title}`}');
        expect(page).toContain('aria-label={`移入回收站 ${asset.title}`}');
        expect(css).toContain(".generation-history-hover-actions");
        expect(css).toContain(".generation-history-card:hover .generation-history-hover-actions");
    });

    test("supports selecting history cards for batch actions", () => {
        const page = readFileSync(resolve(import.meta.dir, "../src/pages/assets/index.tsx"), "utf8");
        const css = readFileSync(resolve(import.meta.dir, "../src/styles/assets-reference-baseline.css"), "utf8");
        expect(page).toContain('aria-label={`选择 ${asset.title}`}');
        expect(page).toContain('aria-label="生成历史批量操作"');
        expect(page).toContain("已选择");
        expect(page).toContain("selectedHistoryIds");
        expect(css).toContain(".generation-history-select");
        expect(css).toContain(".generation-history-batch-bar");
    });
});
