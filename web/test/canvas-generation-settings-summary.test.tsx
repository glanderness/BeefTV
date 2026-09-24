import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasNodePromptPanel } from "../src/components/canvas/canvas-node-prompt-panel";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function renderPromptPanel(node: CanvasNodeData) {
    return renderToStaticMarkup(
        React.createElement(CanvasNodePromptPanel, {
            projectId: "summary-test-project",
            node,
            isRunning: false,
            onPromptChange: () => undefined,
            onConfigChange: () => undefined,
            onGenerate: () => undefined,
        }),
    );
}

describe("Canvas generation settings summary", () => {
    test("shows the current image size instead of a fixed local-mode image summary", () => {
        const html = renderPromptPanel({
            id: "image-node",
            type: CanvasNodeType.Image,
            title: "图片",
            position: { x: 0, y: 0 },
            width: 512,
            height: 512,
            metadata: {
                prompt: "测试图片",
                size: "9:16",
                quality: "high",
                count: 2,
            },
        });

        expect(html).toContain("9:16");
        expect(html).not.toContain("16:9 · 标准画质 · 2K · 1张");
    });

    test("shows the current video resolution instead of a fixed local-mode resolution", () => {
        const html = renderPromptPanel({
            id: "video-node",
            type: CanvasNodeType.Video,
            title: "视频",
            position: { x: 0, y: 0 },
            width: 640,
            height: 360,
            metadata: {
                prompt: "测试视频",
                size: "16:9",
                seconds: "6",
                vquality: "480p",
            },
        });

        expect(html).toContain("480P");
        expect(html).not.toContain("720P · 5s · 1个");
    });

    test("shows the current audio format and voice instead of a fixed local-mode audio summary", () => {
        const html = renderPromptPanel({
            id: "audio-node",
            type: CanvasNodeType.Audio,
            title: "音频",
            position: { x: 0, y: 0 },
            width: 420,
            height: 240,
            metadata: {
                prompt: "测试音频",
                audioVoice: "nova",
                audioFormat: "flac",
                audioSpeed: "1.25",
                audioPitch: "2",
                audioVolume: "0.8",
            },
        });

        expect(html).toContain("Nova · FLAC · 1.25x · 音调+2 · 音量80%");
        expect(html).not.toContain("中文 · 24k · wav");
    });
});
