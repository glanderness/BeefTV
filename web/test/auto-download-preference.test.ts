import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    copyPromptToClipboard,
    resolveAssetGenerationAspectRatio,
    resolveAssetGenerationModel,
    resolveAssetGenerationPrompt,
    type LibraryAsset,
} from "@/components/assets/asset-detail-drawer";
import { setActiveUserScope } from "@/lib/user-scope";
import {
    AUTO_DOWNLOAD_GENERATED_MEDIA_KEY,
    AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY,
    buildAutoDownloadFileName,
    getAutoDownloadGeneratedMedia,
    hasTaskBeenAutoDownloaded,
    resetAutoDownloadedTasksForTests,
    setAutoDownloadGeneratedMedia,
    triggerAutoDownloadForCompletedTask,
} from "@/lib/auto-download-preference";
import { resolveCanvasWorkspaceProjectTitle } from "@/lib/canvas/canvas-workspace-project";

function createMemoryStorage(): Storage {
    const store = new Map<string, string>();
    return {
        get length() {
            return store.size;
        },
        clear() {
            store.clear();
        },
        getItem(key: string) {
            return store.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key: string) {
            store.delete(key);
        },
        setItem(key: string, value: string) {
            store.set(key, String(value));
        },
    };
}

describe("auto-download-preference", () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;

    beforeEach(() => {
        const localStorage = createMemoryStorage();
        const sessionStorage = createMemoryStorage();
        Object.assign(globalThis, {
            window: {
                localStorage,
                sessionStorage,
                location: { protocol: "http:" },
            },
        });
        setActiveUserScope("workspace-test");
        resetAutoDownloadedTasksForTests();
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            delete (globalThis as Record<string, unknown>).window;
        } else {
            (globalThis as Record<string, unknown>).window = originalWindow;
        }
    });

    it("reads and persists boolean preference in scopedLocalStorage", () => {
        expect(getAutoDownloadGeneratedMedia()).toBe(false);

        setAutoDownloadGeneratedMedia(true);
        expect(getAutoDownloadGeneratedMedia()).toBe(true);
        expect(window.localStorage.getItem(`${AUTO_DOWNLOAD_GENERATED_MEDIA_KEY}:user:workspace-test`)).toBe("true");

        setAutoDownloadGeneratedMedia(false);
        expect(getAutoDownloadGeneratedMedia()).toBe(false);
    });

    it("downloads completed task media at most once per taskId across repeated triggers", async () => {
        setAutoDownloadGeneratedMedia(true);
        const downloads: Array<{ fileName: string; resourceId?: string; browserUrl?: string }> = [];

        const first = await triggerAutoDownloadForCompletedTask({
            taskId: "task-vid-1001",
            url: "https://cdn.example.com/outputs/scene-01.mp4",
            title: "第一镜：雨夜街角",
            mediaType: "video",
            mimeType: "video/mp4",
            download: async (options) => {
                downloads.push(options);
            },
        });

        const second = await triggerAutoDownloadForCompletedTask({
            taskId: "task-vid-1001",
            url: "https://cdn.example.com/outputs/scene-01.mp4",
            title: "第一镜：雨夜街角",
            mediaType: "video",
            mimeType: "video/mp4",
            download: async (options) => {
                downloads.push(options);
            },
        });

        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(downloads).toHaveLength(1);
        expect(downloads[0]?.fileName).toBe("第一镜：雨夜街角_vid-1001.mp4");
        expect(hasTaskBeenAutoDownloaded("task-vid-1001")).toBe(true);

        const storedSession = JSON.parse(window.sessionStorage.getItem(AUTO_DOWNLOADED_TASK_IDS_SESSION_KEY) || "[]") as string[];
        expect(storedSession).toContain("task-vid-1001");
    });

    it("does not trigger download when preference is disabled", async () => {
        setAutoDownloadGeneratedMedia(false);
        let called = false;

        const triggered = await triggerAutoDownloadForCompletedTask({
            taskId: "task-img-2002",
            url: "https://cdn.example.com/outputs/frame.png",
            title: "分镜首帧",
            mediaType: "image",
            download: async () => {
                called = true;
            },
        });

        expect(triggered).toBe(false);
        expect(called).toBe(false);
        expect(hasTaskBeenAutoDownloaded("task-img-2002")).toBe(false);
    });

    it("builds clean filenames for image, video, and audio tasks", () => {
        expect(
            buildAutoDownloadFileName({
                taskId: "task_abcdef12",
                url: "https://example.com/file.webp?token=1",
                title: "角色立绘/女主",
                mediaType: "image",
            }),
        ).toBe("角色立绘_女主_abcdef12.webp");

        expect(
            buildAutoDownloadFileName({
                taskId: "task_audio99",
                url: "https://example.com/stream",
                mediaType: "audio",
                mimeType: "audio/wav",
            }),
        ).toBe("生成音频_audio99.wav");
    });

    it("uses native DesktopApp.SaveAutoDownloadedMedia with projectName inside Wails desktop shell", async () => {
        setAutoDownloadGeneratedMedia(true);
        const nativeCalls: Array<{ fileName: string; resourceId: string; projectName: string }> = [];
        Object.assign(window, {
            location: { protocol: "wails:", hostname: "wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        SaveAutoDownloadedMedia: async (fileName: string, resourceId: string, projectName: string) => {
                            nativeCalls.push({ fileName, resourceId, projectName });
                            return {
                                directory: `/Users/demo/Downloads/BeefTV/${projectName}`,
                                savedPath: `/Users/demo/Downloads/BeefTV/${projectName}/${fileName}`,
                            };
                        },
                    },
                },
            },
        });

        const ok = await triggerAutoDownloadForCompletedTask({
            taskId: "task-native-1",
            url: "/api/resources/res-native-99/file",
            storageKey: "resource:res-native-99",
            title: "第一镜：雨夜街角",
            projectName: "赛博短剧",
            mediaType: "video",
            mimeType: "video/mp4",
        });

        expect(ok).toBe(true);
        expect(nativeCalls).toEqual([
            {
                fileName: "第一镜：雨夜街角_native-1.mp4",
                resourceId: "res-native-99",
                projectName: "赛博短剧",
            },
        ]);
        expect(hasTaskBeenAutoDownloaded("task-native-1")).toBe(true);
    });

    it("rolls back taskId and notifies onError when native auto-download fails", async () => {
        setAutoDownloadGeneratedMedia(true);
        const errors: string[] = [];
        Object.assign(window, {
            location: { protocol: "wails:", hostname: "wails.localhost" },
            go: {
                main: {
                    DesktopApp: {
                        SaveAutoDownloadedMedia: async () => {
                            throw new Error("自动下载目录当前不可用，请检查磁盘连接");
                        },
                    },
                },
            },
        });

        const ok = await triggerAutoDownloadForCompletedTask({
            taskId: "task-native-fail",
            url: "/api/resources/res-native-100/file",
            storageKey: "resource:res-native-100",
            title: "分镜二",
            projectName: "赛博短剧",
            mediaType: "image",
            mimeType: "image/png",
            onError: (err) => {
                errors.push(err instanceof Error ? err.message : String(err));
            },
        });

        expect(ok).toBe(false);
        expect(hasTaskBeenAutoDownloaded("task-native-fail")).toBe(false);
        expect(errors).toEqual(["自动下载目录当前不可用，请检查磁盘连接"]);
    });

    it("resolves workspace root project title for secondary canvases in the same project", () => {
        const canvases = [
            { id: "proj-root", title: "雨夜侦探", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" },
            { id: "canvas-2", workspaceProjectId: "proj-root", title: "画布 2", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
        ];
        expect(resolveCanvasWorkspaceProjectTitle(canvases, "proj-root")).toBe("雨夜侦探");
        expect(resolveCanvasWorkspaceProjectTitle(canvases, "canvas-2")).toBe("雨夜侦探");
        expect(resolveCanvasWorkspaceProjectTitle(canvases, "missing-id")).toBe("未命名项目");

        // When the original root canvas has been deleted, align with project library root ordering (earliest remaining canvas).
        const orphaned = [
            { id: "canvas-3", workspaceProjectId: "deleted-root", title: "画布 3", createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" },
            { id: "canvas-2", workspaceProjectId: "deleted-root", title: "首集分镜", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
        ];
        expect(resolveCanvasWorkspaceProjectTitle(orphaned, "canvas-3")).toBe("首集分镜");
    });
});

describe("asset-detail-drawer prompt helpers", () => {
    it("resolves prompt, model, and aspect ratio from asset metadata and copies prompt", async () => {
        const asset = {
            id: "asset-1",
            kind: "image",
            title: "赛博朋克街景",
            category: "environment",
            tags: [],
            createdAt: "2026-11-04T00:00:00.000Z",
            updatedAt: "2026-11-04T00:00:00.000Z",
            data: {
                dataUrl: "/api/resources/res-1/file",
                width: 1920,
                height: 1080,
                bytes: 1024,
                mimeType: "image/png",
            },
            metadata: {
                prompt: "  Neon-lit rainy alley, cinematic wide shot, 35mm lens  ",
                model: "doubao-seedream-4-0",
                aspectRatio: "16:9",
            },
        } as unknown as LibraryAsset;

        expect(resolveAssetGenerationPrompt(asset)).toBe("Neon-lit rainy alley, cinematic wide shot, 35mm lens");
        expect(resolveAssetGenerationModel(asset)).toBe("doubao-seedream-4-0");
        expect(resolveAssetGenerationAspectRatio(asset)).toBe("16:9");

        let copiedText = "";
        let toastText = "";
        Object.assign(globalThis, {
            navigator: {
                clipboard: {
                    writeText: async (text: string) => {
                        copiedText = text;
                    },
                },
            },
        });

        const ok = await copyPromptToClipboard(resolveAssetGenerationPrompt(asset), {
            success: (msg) => {
                toastText = msg;
            },
        });
        expect(ok).toBe(true);
        expect(copiedText).toBe("Neon-lit rainy alley, cinematic wide shot, 35mm lens");
        expect(toastText).toBe("已复制生成提示词");
    });
});
