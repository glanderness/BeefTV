import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasTopBar } from "@/pages/canvas/canvas-project-top-bar";

test("CanvasTopBar keeps sync status visible in the compact chrome without redundant view switches", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(<CanvasTopBar
        libtvChrome syncStatus={<button>已保存在本地</button>}
        workspaceView="workflow" onWorkspaceViewChange={noop} versionsOpen={false} onToggleVersions={noop}
        title="未命名工作区" titleDraft="未命名工作区" isTitleEditing={false} onTitleDraftChange={noop} onStartTitleEditing={noop} onFinishTitleEditing={noop} onCancelTitleEditing={noop}
        canUndo={false} canRedo={false} onCreateCanvas={noop} onDeleteProject={noop} onSave={noop} onForceSave={noop} onImportImage={noop} onImportLibTV={noop} onImportTapNow={noop} onUndo={noop} onRedo={noop}
        shortcutRequestNonce={0} mediaPerformanceMode="auto" onMediaPerformanceModeChange={noop} onOpenSearch={noop} onEnterFocusMode={noop}
    />);

    expect(html).not.toContain('aria-label="工作流"');
    expect(html).not.toContain('aria-label="故事板"');
    expect(html).toContain("已保存在本地");
});

test("CanvasTopBar caps and truncates long canvas switch labels with tooltip while preserving compact short labels", () => {
    const noop = () => {};
    const longCanvasTitle = "v241首帧渲染验收长标题测试";
    const longHtml = renderToStaticMarkup(<CanvasTopBar
        syncStatus={<button>已保存在本地</button>}
        workspaceView="workflow" onWorkspaceViewChange={noop} versionsOpen={false} onToggleVersions={noop}
        title={longCanvasTitle} titleDraft={longCanvasTitle} isTitleEditing={false} onTitleDraftChange={noop} onStartTitleEditing={noop} onFinishTitleEditing={noop} onCancelTitleEditing={noop}
        canUndo={false} canRedo={false} onCreateCanvas={noop}
        projectCanvases={[{ id: "canvas-1", title: longCanvasTitle }]} currentCanvasId="canvas-1"
        onDeleteProject={noop} onSave={noop} onForceSave={noop} onImportImage={noop} onImportLibTV={noop} onImportTapNow={noop} onUndo={noop} onRedo={noop}
        shortcutRequestNonce={0} mediaPerformanceMode="auto" onMediaPerformanceModeChange={noop} onOpenSearch={noop} onEnterFocusMode={noop}
    />);

    const switchMatch = longHtml.match(/<button[^>]*aria-label="切换画布"[^>]*>[\s\S]*?<\/button>/);
    expect(switchMatch).not.toBeNull();
    const switchButton = switchMatch![0];
    expect(switchButton).toContain(`title="${longCanvasTitle}"`);
    expect(switchButton).toContain("max-w-[120px]");
    expect(switchButton).toContain("overflow-hidden");
    expect(switchButton).toContain(`class="min-w-0 truncate">${longCanvasTitle}</span>`);
    expect(switchButton).toContain("shrink-0");

    const defaultHtml = renderToStaticMarkup(<CanvasTopBar
        syncStatus={<button>已保存在本地</button>}
        workspaceView="workflow" onWorkspaceViewChange={noop} versionsOpen={false} onToggleVersions={noop}
        title="未命名工作区" titleDraft="未命名工作区" isTitleEditing={false} onTitleDraftChange={noop} onStartTitleEditing={noop} onFinishTitleEditing={noop} onCancelTitleEditing={noop}
        canUndo={false} canRedo={false} onCreateCanvas={noop}
        onDeleteProject={noop} onSave={noop} onForceSave={noop} onImportImage={noop} onImportLibTV={noop} onImportTapNow={noop} onUndo={noop} onRedo={noop}
        shortcutRequestNonce={0} mediaPerformanceMode="auto" onMediaPerformanceModeChange={noop} onOpenSearch={noop} onEnterFocusMode={noop}
    />);
    expect(defaultHtml).toContain('title="画布 1"');
});
