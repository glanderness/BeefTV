import { requestAudioGeneration } from "@/services/api/audio";
import { requestGeneration, requestToolResponse } from "@/services/api/image";
import { createVideoGenerationTask } from "@/services/api/video";
import { channelHasGenerationCredential, defaultConfig, encodeChannelModel, isBuiltinBeefAPIChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import type { ModelProtocol } from "@/lib/model-protocols";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";

export type ModelConnectionTestResult = {
    stage: "submitted" | "response" | "downloaded";
    detail: string;
    canvasWritebackVerified: false;
};

export async function testChannelModelConnection(channel: ModelChannel, model: string, capability: ModelCapability, protocol: ModelProtocol): Promise<ModelConnectionTestResult> {
    if (!channel.baseUrl.trim()) throw new Error("请先填写 Base URL");
    if (!channelHasGenerationCredential(channel)) {
        throw new Error(isBuiltinBeefAPIChannel(channel) ? "请先连接 BeefAPI" : "请先填写 API Key");
    }
    const selectedModel = encodeChannelModel(channel.id, model);
    const modelProfile = channel.modelProfiles?.find((item) => item.model === model);
    const testProtocol = channel.apiFormat === "gemini" && !modelProfile?.protocol ? undefined : protocol;
    const profile = modelProfile?.capabilityConfig || defaultModelCapabilityConfig(testProtocol, model);
    const testChannel: ModelChannel = {
        ...channel,
        models: channel.models.includes(model) ? channel.models : [...channel.models, model],
        modelProfiles: [
            {
                model,
                displayName: modelProfile?.displayName,
                capability,
                protocol: testProtocol,
                capabilityConfig: modelProfile?.capabilityConfig,
            },
            ...(channel.modelProfiles || []).filter((item) => item.model !== model),
        ],
    };
    const config = {
        ...defaultConfig,
        channelMode: "remote" as const,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        channels: [testChannel],
        model: selectedModel,
        imageModel: selectedModel,
        videoModel: selectedModel,
        textModel: selectedModel,
        audioModel: selectedModel,
        models: [selectedModel],
        imageModels: capability === "image" ? [selectedModel] : [],
        videoModels: capability === "video" ? [selectedModel] : [],
        textModels: capability === "text" ? [selectedModel] : [],
        audioModels: capability === "audio" ? [selectedModel] : [],
        count: "1",
        size: capability === "image" ? profile.image?.size.default || "1024x1024" : profile.video?.defaultRatio || "16:9",
        quality: profile.image?.quality.default || defaultConfig.quality,
        videoSeconds: String(profile.video?.duration.default ?? 6),
        vquality: profile.video?.defaultResolution || "720",
        videoGenerateAudio: String(profile.video?.generateAudio.default ?? false),
    };

    switch (capability) {
        case "text": {
            const response = await requestToolResponse(config, [{ role: "user", content: "Reply with OK." }], [], "auto");
            if (!response.content?.trim()) throw new Error("文本测试未返回有效内容");
            return { stage: "response", detail: "已收到文本内容；未验证画布回填", canvasWritebackVerified: false };
        }
        case "image": {
            const images = await requestGeneration(config, "A simple gray circle on a white background.");
            if (!images.length) throw new Error("图片测试未返回图片");
            return { stage: "response", detail: "已收到图片结果；未验证图片下载与画布回填", canvasWritebackVerified: false };
        }
        case "audio": {
            const audio = await requestAudioGeneration(config, "Model test.");
            if (!audio.size) throw new Error("音频测试返回空文件");
            return { stage: "downloaded", detail: "已下载音频文件；未验证播放与画布回填", canvasWritebackVerified: false };
        }
        case "video": {
            const task = await createVideoGenerationTask(config, "A static gray circle on a white background.");
            if (!task.id?.trim()) throw new Error("视频测试未返回任务 ID");
            return { stage: "submitted", detail: `视频任务已提交（${task.id}）；未验证生成完成、下载与画布回填`, canvasWritebackVerified: false };
        }
    }
}
