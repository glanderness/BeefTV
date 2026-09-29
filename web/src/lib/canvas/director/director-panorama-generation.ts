import { nanoid } from "nanoid";

import { resolveCanvasGenerationModel } from "@/lib/canvas/canvas-project-generation";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { runBackendGenerationTask, type BackendGenerationResult } from "@/services/api/generation-task";
import { resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { useAssetStore, type NewAsset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { GenerationTask } from "@/services/api/task-center";

export const DIRECTOR_PANORAMA_PROMPT = "以参考图中的主体、材质和光影为基础，将环境扩展成完整的 360 度等距柱状全景图。输出 2:1 比例的连续单幅画面，左右边缘自然无缝衔接，保持真实空间尺度；不要拼贴、边框、文字、水印或拍摄设备。";

type DirectorPanoramaGenerationInput = {
    file: File;
    config: AiConfig;
    sceneId: string;
    projectId?: string;
    onTaskUpdate?: (task: GenerationTask) => void;
};

type DirectorPanoramaGenerationDependencies = {
    upload: (input: string | Blob) => Promise<UploadedImage>;
    generate: (options: Parameters<typeof runBackendGenerationTask>[0]) => Promise<BackendGenerationResult>;
    resolve: typeof resolveImageUrl;
    addAsset: (asset: NewAsset) => string;
    selectModel: (config: AiConfig) => string;
};

export function selectDirectorPanoramaModel(config: AiConfig): string {
    return resolveCanvasGenerationModel(config, config.imageModel, "image") || resolveCanvasGenerationModel(config, config.model, "image");
}

function directorPanoramaSize(config: AiConfig, model: string): string {
    const image = modelCapabilityConfigFor(config, model).image;
    if (image?.size.allowCustom || image?.size.values.includes("2:1")) return "2:1";
    return image?.size.default && image.size.default !== "*" ? image.size.default : config.size;
}

const defaultDependencies: DirectorPanoramaGenerationDependencies = {
    upload: uploadImage,
    generate: runBackendGenerationTask,
    resolve: resolveImageUrl,
    addAsset: (asset) => useAssetStore.getState().addAsset(asset),
    selectModel: selectDirectorPanoramaModel,
};

/** Task runs independently of the modal. Closing the dialog never aborts it. */
export async function generateDirectorPanorama(input: DirectorPanoramaGenerationInput, dependencies: DirectorPanoramaGenerationDependencies = defaultDependencies): Promise<{ id: string; name: string; url: string; storageKey: string; width: number; height: number }> {
    const { file, config, sceneId, projectId, onTaskUpdate } = input;
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
    const model = dependencies.selectModel(config);
    if (!model) throw new Error("请先在模型设置中选择可用的图片模型");
    if (modelCapabilityConfigFor(config, model).image?.references.maxImages === 0) throw new Error("当前图片模型不支持参考图，请选择支持图生图的模型");

    const source = await dependencies.upload(file);
    const reference: ReferenceImage = {
        id: nanoid(),
        name: file.name,
        type: source.mimeType,
        dataUrl: source.url,
        storageKey: source.storageKey,
        width: source.width,
        height: source.height,
        bytes: source.bytes,
    };
    let taskId: string | undefined;
    const result = await dependencies.generate({
        projectId,
        mode: "image",
        prompt: DIRECTOR_PANORAMA_PROMPT,
        config: { ...config, model, size: directorPanoramaSize(config, model), count: "1" },
        referenceImages: [reference],
        metadata: { source: "director-panorama", sceneId },
        onTaskUpdate: (task) => { taskId = task.id; onTaskUpdate?.(task); },
    });
    const image = result.images?.[0];
    if (!image) throw new Error("图片任务完成，但没有返回全景图");
    const outputUrl = image.dataUrl || image.url || await dependencies.resolve(image.storageKey);
    if (!outputUrl) throw new Error("全景图结果无法读取，请到任务中心检查输出资源");
    const uploaded = await dependencies.upload(outputUrl);
    const name = `AI 全景图 · ${file.name}`;
    const id = dependencies.addAsset({
        kind: "image",
        title: name,
        coverUrl: uploaded.url,
        tags: ["全景图", "AI生成"],
        source: "导演台",
        data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
        metadata: { source: "director-panorama-ai", sceneId, taskId },
    });
    return { id, name, url: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height };
}
