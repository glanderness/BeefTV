import { describe, expect, test } from "bun:test";

import { buildImageGenerationNodeTitle } from "@/lib/canvas/canvas-generation-title";
import { buildBatchDownloadFilename } from "@/lib/canvas/canvas-batch-download";
import { buildCanvasMediaDownloadFileName, canvasMediaFileExtension, firstKnownMediaMimeType, mediaFileExtension, sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function mediaNode(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "image-1",
        type: CanvasNodeType.Image,
        title: "女明星角色三视图",
        position: { x: 0, y: 0 },
        width: 1024,
        height: 1024,
        metadata: { content: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png", status: "success" },
        ...overrides,
    };
}

describe("canvas media download", () => {
    test("素材库 MIME 别名经过文件名清理后仍保留真实格式后缀", () => {
        for (const [mime, extension] of [["video/quicktime", "mov"], ["image/svg+xml", "svg"], ["audio/x-wav", "wav"], ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"], ["image/jpeg; charset=utf-8", "jpg"]]) {
            const name = sanitizeDownloadFileName(`中文素材.${mediaFileExtension(mime)}`);
            expect(name).toBe(`中文素材.${extension}`);
        }
        expect(mediaFileExtension("application/octet-stream", "https://example.com/clip.webm?token=hidden")).toBe("webm");
        expect(mediaFileExtension("application/octet-stream", "blob:unknown")).toBeUndefined();
    });

    test("图片和视频按节点名及实际格式命名，兼容已带扩展名的节点", () => {
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "场景1.v2" }))).toBe("场景1.v2.png");
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "场景1.PNG" }))).toBe("场景1.png");
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "封面.JPEG", metadata: { mimeType: "image/jpeg" } }))).toBe("封面.jpg");
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "photo.jfif", metadata: { mimeType: "image/jpeg" } }))).toBe("photo.jpg");
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "photo.tif", metadata: { mimeType: "image/tiff" } }))).toBe("photo.tiff");
        const video = mediaNode({ type: CanvasNodeType.Video, title: "镜头1", metadata: { mimeType: "video/quicktime" } });
        expect(buildCanvasMediaDownloadFileName(video)).toBe("镜头1.mov");
    });

    test("清理跨平台非法字符且保留中文可读名称", () => {
        const node = mediaNode({ title: "女明星/角色:三视图?" });
        expect(buildCanvasMediaDownloadFileName(node)).toBe("女明星_角色_三视图.png");
    });

    test("截断长名称后不会留下 Windows 不接受的结尾句点", () => {
        const node = mediaNode({ title: `${"a".repeat(79)}.extra` });
        expect(buildCanvasMediaDownloadFileName(node)).toBe(`${"a".repeat(79)}.png`);
    });

    test("优先按媒体 MIME 类型确定视频扩展名", () => {
        expect(canvasMediaFileExtension(mediaNode({ type: CanvasNodeType.Video, metadata: { content: "https://example.com/video", mimeType: "video/webm" } }))).toBe("webm");
        expect(canvasMediaFileExtension(mediaNode({ type: CanvasNodeType.Video, metadata: { content: "https://example.com/video", mimeType: "video/quicktime" } }))).toBe("mov");
    });

    test("MIME 类型不明确时从远程资源 URL 识别扩展名", () => {
        expect(canvasMediaFileExtension(mediaNode({ metadata: { content: "https://example.com/result.jpeg?token=hidden", mimeType: "image/*" } }))).toBe("jpg");
    });

    test("导出文件名去掉路径和非法字符", () => {
        expect(sanitizeDownloadFileName("../角色:三视图?.png")).toBe("角色_三视图.png");
    });

    test("audio/wave 与其它 WAV 别名下载为 .wav，不回落到 mp3", () => {
        for (const mimeType of ["audio/wave", "audio/wav", "audio/x-wav", "audio/vnd.wave"]) {
            const node = mediaNode({
                type: CanvasNodeType.Audio,
                title: "旁白",
                metadata: { content: "blob:http://localhost/tts", mimeType, status: "success" },
            });
            expect(canvasMediaFileExtension(node)).toBe("wav");
            expect(buildCanvasMediaDownloadFileName(node)).toBe("旁白.wav");
        }
    });

    test("支持 video/x-m4v、image/jpg、image/heic，并优先选首个可识别的 MIME 候选", () => {
        expect(buildCanvasMediaDownloadFileName(mediaNode({ type: CanvasNodeType.Video, title: "clip.v2", metadata: { mimeType: "video/x-m4v" } }))).toBe("clip.v2.m4v");
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "照片", metadata: { mimeType: "image/jpg" } }))).toBe("照片.jpg");
        expect(buildCanvasMediaDownloadFileName(mediaNode({ title: "实况", metadata: { mimeType: "image/heic" } }))).toBe("实况.heic");
        expect(firstKnownMediaMimeType("image/jpeg", "image/*", "image/png")).toBe("image/jpeg");
        expect(firstKnownMediaMimeType("application/octet-stream", "image/*", "image/webp")).toBe("image/webp");
        expect(buildCanvasMediaDownloadFileName(mediaNode({
            title: "照片",
            metadata: { mimeType: firstKnownMediaMimeType("image/jpeg", "image/*"), content: "/api/resources/res-1/file" },
        }))).toBe("照片.jpg");
    });

    test("单张下载与批量下载共用同一扩展名剥离和清理规则", () => {
        const jpegNode = mediaNode({ title: "封面.jpeg", metadata: { content: "/api/resources/res-1/file", mimeType: "image/jpeg" } });
        expect(buildCanvasMediaDownloadFileName(jpegNode)).toBe("封面.jpg");
        expect(buildBatchDownloadFilename(jpegNode)).toBe("封面.jpg");
    });
});

describe("generated image title", () => {
    test("普通节点继续使用提示词摘要", () => {
        expect(buildImageGenerationNodeTitle("一座云层中的未来城市", mediaNode({ title: "原图" }))).toBe("一座云层中的未来城市");
    });

    test("快捷键复制节点生成后保留 copy 序号", () => {
        const source = mediaNode({ title: "未来城市_copy2", metadata: { copiedFromNodeId: "source" } });
        expect(buildImageGenerationNodeTitle("未来城市", source)).toBe("未来城市_copy2");
    });

    test("参数变体生成后保留版本字母", () => {
        const source = mediaNode({ title: "未来城市 · C", metadata: { versionOfNodeId: "source", versionLabel: "C" } });
        expect(buildImageGenerationNodeTitle("未来城市", source)).toBe("未来城市 · C");
    });

    test("复制变体和批量输出使用互不重复的标题", () => {
        const source = mediaNode({ title: "未来城市_copy1 · B", metadata: { copiedFromNodeId: "source", versionOfNodeId: "source", versionLabel: "B" } });
        expect([0, 1].map((index) => buildImageGenerationNodeTitle("未来城市", source, index, 2))).toEqual(["未来城市_copy1 · B · 1", "未来城市_copy1 · B · 2"]);
    });

    test("下载文件名继承 copy 和版本标识，不再互相重复", () => {
        const copy = mediaNode({ title: buildImageGenerationNodeTitle("未来城市", mediaNode({ title: "未来城市_copy1", metadata: { copiedFromNodeId: "source" } })) });
        const variant = mediaNode({ title: buildImageGenerationNodeTitle("未来城市", mediaNode({ title: "未来城市 · C", metadata: { versionOfNodeId: "source", versionLabel: "C" } })) });
        expect(buildCanvasMediaDownloadFileName(copy)).toBe("未来城市_copy1.png");
        expect(buildCanvasMediaDownloadFileName(variant)).toBe("未来城市 · C.png");
    });
});
