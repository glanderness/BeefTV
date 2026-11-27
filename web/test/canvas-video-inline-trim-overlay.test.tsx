import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasVideoInlineTrim, CanvasVideoInlineTrimOverlay } from "../src/components/canvas/canvas-video-inline-trim";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const videoNode: CanvasNodeData = {
    id: "video-1",
    type: CanvasNodeType.Video,
    title: "街采替换",
    position: { x: 0, y: 0 },
    width: 720,
    height: 1280,
    metadata: { content: "blob:video", durationMs: 12_000, naturalWidth: 720, naturalHeight: 1280, hasAudio: true },
};

describe("CanvasVideoInlineTrim", () => {
    test("retake combines the same range selector with an instruction and an explicit generation action", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onRetake={() => {}} />,
        );
        expect(html).toContain('aria-label="片段重拍"');
        expect(html).not.toContain(">片段重拍<");
        expect(html).toContain('aria-label="调整片段起点"');
        expect(html).toContain('aria-label="重拍要求"');
        expect(html).toContain('00:00.000–00:12.000');
        expect(html).toContain('disabled=""><span>生成重拍</span>');
        expect(html).not.toContain('aria-label="确认剪辑"');
    });

    test("renders a LibTV-style filmstrip range editor with editable start, end, and duration chips", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onConfirm={() => {}} />,
        );

        expect(html).toContain('role="dialog"');
        expect(html).toContain('data-canvas-keyboard-scope="true"');
        expect(html).toContain('aria-label="视频片段剪辑"');
        expect(html).toContain('data-video-trim-filmstrip="true"');
        expect(html).toContain('aria-label="调整片段起点"');
        expect(html).toContain('aria-label="调整片段终点"');
        expect(html).toContain('aria-label="取消剪辑"');
        expect(html).toContain('aria-label="确认剪辑"');
        expect(html).toContain('aria-label="播放片段预览"');
        expect(html).toContain('aria-label="片段起点 00:00.00，点击手动输入"');
        expect(html).toContain('aria-label="片段终点 00:12.00，点击手动输入"');
        expect(html).toContain('aria-label="所选片段时长 12.00 s，点击手动输入"');
        expect(html).toContain("00:00.00");
        expect(html).toContain("00:12.00");
        expect(html).toContain("12.00 s");
    });

    test("never mounts the video source as a thumbnail while frames are loading", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onConfirm={() => {}} />,
        );
        const filmstrip = html.split('class="canvas-video-trim-frames"')[1]?.split("</div>")[0] || "";

        expect(filmstrip).not.toContain("<img");
        expect(filmstrip).not.toContain("blob:video");
        expect(filmstrip.match(/<span/g)).toHaveLength(14);
    });

    test("places the time bar inside the timeline column above the filmstrip", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrim node={videoNode} busy={false} onCancel={() => {}} onConfirm={() => {}} />,
        );
        const trackIndex = html.indexOf('class="canvas-video-trim-track"');
        const timebarIndex = html.indexOf('class="canvas-video-trim-timebar"');
        const filmstripIndex = html.indexOf('data-video-trim-filmstrip="true"');
        const confirmIndex = html.indexOf('aria-label="确认剪辑"');

        expect(trackIndex).toBeGreaterThan(-1);
        expect(timebarIndex).toBeGreaterThan(trackIndex);
        expect(filmstripIndex).toBeGreaterThan(timebarIndex);
        expect(confirmIndex).toBeGreaterThan(filmstripIndex);
    });

    test("renders inside the target node panel and sizes from the rendered video width", () => {
        const html = renderToStaticMarkup(
            <CanvasVideoInlineTrimOverlay
                node={videoNode}
                viewport={{ x: 0, y: 0, k: 0.5 }}
                containerRef={createRef<HTMLDivElement>()}
                busy={false}
                onCancel={() => {}}
                onConfirm={() => {}}
            />,
        );

        expect(html).toContain("data-canvas-node-panel");
        expect(html).toContain("canvas-video-trim-overlay");
        expect(html).toContain('style="left:0;top:0;transform:translate3d(');
        expect(html).toContain("width:540px");
        expect(html).toContain('aria-label="视频片段剪辑"');
        expect(html).toContain('aria-label="确认剪辑"');
    });
});
