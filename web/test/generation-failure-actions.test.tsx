import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNodeContent } from "../src/components/canvas/canvas-node-content";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { canvasThemes } from "../src/lib/canvas-theme";
import { explainGenerationError } from "../src/lib/generation-error";
import { CanvasNodeType } from "../src/types/canvas";

test("uncertain submission offers original task instead of resubmitting", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError({ code: "video_submission_unknown" })} onRetry={() => {}} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("重新生成");
});

test("invalid reference explains limits without repeating unchanged input", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError("第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交")} onRetry={() => {}} />);
    expect(html).toContain("第 2 段参考音频");
    expect(html).toContain("2–30 秒");
    expect(html).not.toContain("重新生成");
});

test("shared batch outputs keep task details without duplicating the full diagnostic controls", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice summaryOnly explanation={explainGenerationError({ code: "submission_uncertain" })} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("复制排查信息");
    expect(html).not.toContain("generation-failure-action\"");
});

test("failed canvas nodes render in-place retry action for non-uncertain failures", () => {
    for (const code of ["async_failed", "timeout", "results_missing", "invalid_params"]) {
        const html = renderToStaticMarkup(
            <CanvasNodeContent
                node={{
                    id: "failed-node",
                    type: CanvasNodeType.Video,
                    title: "视频节点",
                    position: { x: 0, y: 0 },
                    width: 320,
                    height: 200,
                    metadata: { status: "error", taskId: "task-123", taskStatus: "failed", generationErrorCode: code, errorDetails: explainGenerationError({ code }).message },
                }}
                theme={canvasThemes.dark}
                onRetry={() => {}}
                onOpenTaskDetails={() => {}}
            />,
        );
        expect(html).toContain("</svg>重新生成</button>");
        expect(html).toContain("查看详情");
    }

    const retainedHtml = renderToStaticMarkup(
        <CanvasNodeContent
            node={{
                id: "retained-node",
                type: CanvasNodeType.Image,
                title: "图片节点",
                position: { x: 0, y: 0 },
                width: 320,
                height: 200,
                metadata: { status: "error", taskId: "task-123", taskStatus: "succeeded", generationErrorCode: "canvas_conflict", resourceReloadAvailable: true, errorDetails: "生成结果已保留" },
            }}
            theme={canvasThemes.dark}
            onRetry={() => {}}
            onReloadResource={() => {}}
        />,
    );
    expect(retainedHtml).toContain("继续取回");
    expect(retainedHtml).not.toContain("</svg>重新生成</button>");
});
