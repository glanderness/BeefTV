import { afterEach, describe, expect, test } from "bun:test";

import { restoreCanvasArchive, type CanvasArchiveRestoreHost } from "@/lib/canvas/canvas-archive-restore";
import { uploadNodeTitle } from "@/lib/canvas/canvas-file-upload";
import { ensureMediaNodeMinimumSize, fitImageNodeToDecodedSize, fitNodeSize, MEDIA_NODE_MIN_SIZE, mediaNodeMinSizeForRatio } from "@/lib/canvas/canvas-node-size";
import { isVideoSpaceShortcutIgnoredTarget } from "@/lib/video-player-policy";
import { createZip } from "@/lib/zip";
import { useOperationProgress } from "@/stores/use-operation-progress";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

afterEach(() => {
    useOperationProgress.setState({ entries: {} });
});

describe("portrait media node minimum sizing", () => {
    test("uses symmetric short-edge minimum (236x420) for portrait ratios while keeping landscape 420x236", () => {
        expect(mediaNodeMinSizeForRatio(16 / 9)).toEqual(MEDIA_NODE_MIN_SIZE);
        expect(mediaNodeMinSizeForRatio(1)).toEqual(MEDIA_NODE_MIN_SIZE);
        expect(mediaNodeMinSizeForRatio(9 / 16)).toEqual({ width: 236, height: 420 });
        expect(mediaNodeMinSizeForRatio(3 / 4)).toEqual({ width: 236, height: 420 });
    });

    test("fits 9:16 portrait images within maxHeight without inflating to ~747px tall", () => {
        const fitted = fitNodeSize(900, 1600);
        expect(fitted.height).toBeCloseTo(520, 1);
        expect(fitted.width).toBeCloseTo(292.5, 1);
        expect(fitted.width).toBeLessThan(420);
    });

    test("ensureMediaNodeMinimumSize scales small portrait placeholders to 236x420 instead of 420x747", () => {
        const portrait: CanvasNodeData = {
            id: "portrait-1",
            type: CanvasNodeType.Image,
            title: "竖图",
            position: { x: 100, y: 100 },
            width: 118,
            height: 210,
            metadata: {},
        };
        const resized = ensureMediaNodeMinimumSize(portrait);
        expect(resized.width).toBeCloseTo(236, 1);
        expect(resized.height).toBeCloseTo(420, 1);
    });

    test("fitImageNodeToDecodedSize preserves legacy saved 420x747 portrait nodes without silently shrinking them", () => {
        const legacyPortrait: CanvasNodeData = {
            id: "portrait-legacy",
            type: CanvasNodeType.Image,
            title: "历史竖图",
            position: { x: 200, y: 120 },
            width: 420,
            height: 746.67,
            metadata: { content: "portrait.png", status: "success" },
        };
        const decoded = fitImageNodeToDecodedSize(legacyPortrait, 1080, 1920);
        expect(decoded.width).toBe(420);
        expect(decoded.height).toBe(746.67);
        expect(decoded.metadata?.naturalWidth).toBe(1080);
        expect(decoded.metadata?.naturalHeight).toBe(1920);
    });
});

describe("uploadNodeTitle extension stripping", () => {
    test("strips known media and document extensions while preserving ordinary dots", () => {
        expect(uploadNodeTitle("小五参考音频.wav")).toBe("小五参考音频");
        expect(uploadNodeTitle("成片_01.MP4")).toBe("成片_01");
        expect(uploadNodeTitle("分镜稿.docx")).toBe("分镜稿");
        expect(uploadNodeTitle("v2.4.shot")).toBe("v2.4.shot");
    });
});

describe("video space shortcut target guard", () => {
    test("ignores interactive and editable elements while allowing non-interactive containers", () => {
        const makeEl = (matchedSelector: string | null) =>
            Object.assign(Object.create(Element.prototype), {
                closest: (selector: string) => (matchedSelector && selector.includes(matchedSelector) ? {} : null),
            }) as Element;

        const origElement = globalThis.Element;
        if (typeof origElement === "undefined") {
            class FakeElement {
                closest(_selector: string): Element | null {
                    return null;
                }
            }
            (globalThis as { Element?: unknown }).Element = FakeElement;
        }
        try {
            const inputLike = makeEl("input");
            const buttonLike = makeEl("button");
            const stageLike = makeEl(null);
            expect(isVideoSpaceShortcutIgnoredTarget(inputLike)).toBe(true);
            expect(isVideoSpaceShortcutIgnoredTarget(buttonLike)).toBe(true);
            expect(isVideoSpaceShortcutIgnoredTarget(stageLike)).toBe(false);
            expect(isVideoSpaceShortcutIgnoredTarget(null)).toBe(false);
        } finally {
            if (typeof origElement === "undefined") {
                Reflect.deleteProperty(globalThis, "Element");
            }
        }
    });
});

describe("canvas archive restore concrete failure reporting", () => {
    test("surfaces the failing filename and underlying error in both thrown error and progress detail", async () => {
        const archive = {
            app: "infinite-canvas",
            version: 4,
            exportedAt: "2026-11-24T00:00:00.000Z",
            folders: [],
            projects: [{
                project: {
                    id: "old-canvas",
                    title: "测试画布",
                    nodes: [{
                        id: "n-video",
                        type: "video",
                        title: "镜头",
                        position: { x: 0, y: 0 },
                        width: 320,
                        height: 180,
                        metadata: { storageKey: "video:clip", content: "blob:expired" },
                    }],
                    connections: [],
                },
                files: [
                    { storageKey: "video:clip", path: "projects/old-canvas/files/scene_07.mp4", mimeType: "video/mp4", bytes: 4 },
                ],
                drawingDocuments: [],
            }],
        };
        const zip = await createZip([
            { name: "projects.json", data: JSON.stringify(archive) },
            { name: "projects/old-canvas/files/scene_07.mp4", data: new Uint8Array([1, 2, 3, 4]) },
        ]);

        const host: Partial<CanvasArchiveRestoreHost> = {
            usesCanonicalBackend: false,
            createFolder: async () => "f1",
            uploadMedia: async () => {
                throw new Error("磁盘空间不足");
            },
            createProject: async () => ({ id: "p1", saved: Promise.resolve() }),
            rollbackProjects: async () => undefined,
            rollbackFolders: async () => undefined,
            rollbackResources: async () => undefined,
        };

        await expect(restoreCanvasArchive(zip, host)).rejects.toThrow("文件「scene_07.mp4」恢复失败：磁盘空间不足");
        const entries = Object.values(useOperationProgress.getState().entries);
        expect(entries.length).toBeGreaterThan(0);
        expect(entries[0].detail).toContain("scene_07.mp4");
        expect(entries[0].detail).toContain("磁盘空间不足");
    });
});
