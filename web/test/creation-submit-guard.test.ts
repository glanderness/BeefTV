import { expect, test } from "bun:test";
import { defaultModelCapabilityConfig, modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { videoSubmitNotice } from "../src/pages/create/creation-submit-guard";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";

const model = "seedance-2.0";
const capabilityConfig = defaultModelCapabilityConfig("newapi", model);
const channel = createModelChannel({ id: "beefapi", name: "BeefAPI", scope: "user", interfaceType: "newapi", baseUrl: "https://enterprise.beefapi.com", models: [model] });
channel.modelProfiles = [{ model, displayName: model, capability: "video", protocol: "newapi", capabilityConfig }];
const config = { ...defaultConfig, channels: [channel], model: `beefapi::${model}`, videoModel: `beefapi::${model}` };
// 走真实读取路径：能力配置在读取时按官方下限收紧到 2 秒音频、4–15 秒输出。
const video = modelCapabilityConfigFor(config, `beefapi::${model}`).video!;

const image = (id: string) => ({ id, name: id, type: "image/png", dataUrl: "", width: 512, height: 512 });
const audio = (id: string, durationMs?: number, storageKey?: string) => ({ id, name: `${id}.wav`, type: "audio/mpeg", url: `https://example.com/${id}.mp3`, durationMs, storageKey });
// Seedance 2.0 不支持只用音频，带一张图更接近真实请求。
const withImage = (audios: ReturnType<typeof audio>[]) => ({ referenceImages: [image("i0")], referenceVideos: [], referenceAudios: audios });
const none = { referenceImages: [], referenceVideos: [], referenceAudios: [] };

test("只有视频模式做这套核对，文本和图片提交不被视频合同误拦", () => {
    // 文本模式残留 30 秒、还带着 10 张图，也不能报「输出时长为 30 秒」。
    const tenImages = Array.from({ length: 10 }, (_, index) => image(`i${index}`));
    expect(videoSubmitNotice("text", video, "30", { ...none, referenceImages: tenImages })).toBe("");
    // Seedream 这类图片模型允许 14 张，不能被视频默认的 9 张上限拦下。
    expect(videoSubmitNotice("image", video, "30", { ...none, referenceImages: tenImages })).toBe("");
});

test("视频模式下输出时长超范围时给出可照做的提示", () => {
    expect(videoSubmitNotice("video", video, "3", none)).toContain("输出时长为 3 秒");
    expect(videoSubmitNotice("video", video, "5", none)).toBe("");
});

test("素材库音频只有 resource: 标识、浏览器还没读到时长的，交给后端补查而不是判成无法读取", () => {
    // 已有任务准备流程（generation-task.ts）会带 deferResourceMetadataToBackend 让后端读真实时长。
    expect(videoSubmitNotice("video", video, "5", withImage([audio("library", undefined, "resource:voice")]))).toBe("");
    // 本地导入、本来就该有时长却读不到的，仍然要提示重新导入。
    expect(videoSubmitNotice("video", video, "5", withImage([audio("local", undefined)]))).toContain("时长无法读取");
});

test("参考音频过短说换更长，过长说裁短", () => {
    expect(videoSubmitNotice("video", video, "5", withImage([audio("short", 1900)]))).toContain("请换一段更长的音频后再提交");
    expect(videoSubmitNotice("video", video, "5", withImage([audio("long", 16000)]))).toContain("请裁剪或换一段更短的音频后再提交");
    expect(videoSubmitNotice("video", video, "5", withImage([audio("ok", 3000)]))).toBe("");
});