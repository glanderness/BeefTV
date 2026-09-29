import { describe, expect, test } from "bun:test";

import { DIRECTOR_PANORAMA_PROMPT, generateDirectorPanorama } from "../src/lib/canvas/director/director-panorama-generation";
import { defaultConfig } from "../src/stores/use-config-store";
import type { UploadedImage } from "../src/services/image-storage";

const uploaded = (url: string, key: string): UploadedImage => ({ url, storageKey: key, width: 800, height: 400, bytes: 100, mimeType: "image/png" });
const input = () => ({ file: new File(["test"], "参考图.png", { type: "image/png" }), config: defaultConfig, sceneId: "scene-1", projectId: "project-1" });

describe("导演台 AI 全景图", () => {
    test("没有图片模型时不上传也不创建付费任务", async () => {
        let uploadCount = 0;
        await expect(generateDirectorPanorama(input(), {
            selectModel: () => "",
            upload: async () => { uploadCount++; return uploaded("blob:source", "image:source"); },
            generate: async () => { throw new Error("不应生成"); },
            resolve: async () => "",
            addAsset: () => "asset-1",
        })).rejects.toThrow("选择可用的图片模型");
        expect(uploadCount).toBe(0);
    });

    test("上传参考图、提交图片任务、保存结果到历史；任务更新可上报", async () => {
        const uploads: Array<string | Blob> = [];
        const assets: unknown[] = [];
        const taskIds: string[] = [];
        const result = await generateDirectorPanorama({ ...input(), onTaskUpdate: (task) => taskIds.push(task.id) }, {
            selectModel: () => "image-model",
            upload: async (value) => { uploads.push(value); return uploads.length === 1 ? uploaded("blob:source", "image:source") : uploaded("blob:output", "image:output"); },
            generate: async (options) => {
                expect(options.projectId).toBe("project-1");
                expect(options.mode).toBe("image");
                expect(options.config.model).toBe("image-model");
                expect(options.config.count).toBe("1");
                expect(options.referenceImages?.[0]?.storageKey).toBe("image:source");
                expect(options.prompt).toBe(DIRECTOR_PANORAMA_PROMPT);
                options.onTaskUpdate?.({ id: "task-1" } as never);
                return { images: [{ dataUrl: "data:image/png;base64,AAA" }] };
            },
            resolve: async () => "",
            addAsset: (asset) => { assets.push(asset); return "asset-1"; },
        });
        expect(uploads).toHaveLength(2);
        expect(uploads[1]).toBe("data:image/png;base64,AAA");
        expect(taskIds).toEqual(["task-1"]);
        expect(result).toEqual({ id: "asset-1", name: "AI 全景图 · 参考图.png", url: "blob:output", storageKey: "image:output", width: 800, height: 400 });
        expect(assets).toMatchObject([{ kind: "image", metadata: { source: "director-panorama-ai", sceneId: "scene-1", taskId: "task-1" } }]);
    });

    test("任务没有图片结果时不写入历史", async () => {
        let assetCount = 0;
        await expect(generateDirectorPanorama(input(), {
            selectModel: () => "image-model",
            upload: async () => uploaded("blob:source", "image:source"),
            generate: async () => ({ images: [] }),
            resolve: async () => "",
            addAsset: () => { assetCount++; return "asset-1"; },
        })).rejects.toThrow("没有返回全景图");
        expect(assetCount).toBe(0);
    });
});
