import { expect, test } from "bun:test";
import { videoSettingsConstraints } from "../src/lib/video-settings-constraints";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { h3AspectConfig, h3Models, h3StyleModels } from "./fixtures/h3-aspect-config";

test("H3 base ordinary references retain an independent ratio", () => {
    const config = h3AspectConfig("minimax-h3");
    // preferReferenceMode: true treats untagged 1-image input as reference_to_video (editable ratio)
    expect(videoSettingsConstraints(config, { imageCount: 1 })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoEditOperation: "reference_to_video" })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, videoCount: 1 })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, audioCount: 2 })).toEqual({});
    // Explicit frame role or explicit image_to_video locks ratio to the keyframe
    expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoStartFrameNodeId: "frame" }).ratioLabel).toBe("随首帧图片");
    expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoEditOperation: "image_to_video" }).ratioLabel).toBe("随首帧图片");
});

test("Max and Turbo treat ordinary image inputs as keyframes", () => {
    for (const model of h3Models.slice(1)) expect(videoSettingsConstraints(h3AspectConfig(model), { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
});

test("same-name models on custom endpoints without declared controls keep their own protocol controls", () => {
    for (const model of h3Models) expect(videoSettingsConstraints(h3AspectConfig(model, "https://custom.example.com"), { imageCount: 1 })).toEqual({});
});

test("switching to Seedance preserves its existing settings constraints", () => {
    const base = h3AspectConfig();
    const h3Video = base.channels[0]!.modelProfiles![0]!.capabilityConfig!.video!;
    const channel = {
        ...base.channels[0]!,
        models: [...base.channels[0]!.models, "seedance-2.5"],
        modelProfiles: [
            ...(base.channels[0]!.modelProfiles || []),
            {
                model: "seedance-2.5",
                capability: "video" as const,
                protocol: "newapi" as const,
                capabilityConfig: { version: 1, video: { ...h3Video, controls: undefined, taskTypeConstraints: true } },
                videoCapabilitiesVersion: "fixture-v1",
            },
        ],
    };
    const config = { ...base, channels: [channel], model: "beeftv::seedance-2.5" };
    expect(videoSettingsConstraints(config, { imageCount: 1 }).ratioLabel).toBe("随首帧");
    expect(videoSettingsConstraints(config, { videoCount: 1 }, { videoEditOperation: "inpaint" })).toEqual({ ratioLabel: "随原视频", durationLocked: true });
    expect(videoSettingsConstraints(config, { characterCount: 1 }).ratioLabel).toBeUndefined();
});

test("a character card cover alone does not determine keyframe mode", () => {
    for (const model of h3Models) {
        const config = h3AspectConfig(model);
        expect(videoSettingsConstraints(config, { characterCount: 1 }).ratioLabel).toBeUndefined();
        expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoStartFrameNodeId: "frame" }).ratioLabel).toBeUndefined();
        expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoEndFrameNodeId: "frame" }).ratioLabel).toBeUndefined();
    }
    expect(videoSettingsConstraints(h3AspectConfig(), { characterCount: 1 }).ratioHelp).toContain("多素材参考生成使用所选比例");
    for (const style of h3StyleModels) {
        expect(videoSettingsConstraints(h3AspectConfig(style), { characterCount: 1 }).ratioHelp).toContain("所选比例只在没有参考图时生效");
    }
});

test("opaque non-H3 model IDs with declared controls and middleFrame use capability-driven constraints", () => {
    const base = h3AspectConfig("minimax-h3-max");
    const templateVideo = base.channels[0]!.modelProfiles!.find((p) => p.model === "minimax-h3-max")!.capabilityConfig!.video!;
    const channel = createModelChannel({
        id: "studio",
        baseUrl: "https://studio.example/v1",
        models: ["opaque-cinema-pro", "opaque-style-only"],
        modelProfiles: [
            {
                model: "opaque-cinema-pro",
                capability: "video",
                protocol: "openai-videos",
                videoCapabilitiesVersion: "v1",
                capabilityConfig: { version: 1, video: structuredClone(templateVideo) },
            },
            {
                model: "opaque-style-only",
                capability: "video",
                protocol: "openai-videos",
                videoCapabilitiesVersion: "v1",
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...structuredClone(templateVideo),
                        middleFrame: false,
                        operations: ["text_to_video", "image_to_video"],
                        controls: { seed: true, damageLevels: ["light", "medium", "heavy"] },
                    },
                },
            },
        ],
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], model: "studio::opaque-cinema-pro" } }).config;
    expect(videoSettingsConstraints(config, { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
    expect(videoSettingsConstraints(config, { imageCount: 1, audioCount: 1 }).ratioLabel).toBe("随首帧图片");
    expect(videoSettingsConstraints(config, { imageCount: 1, audioCount: 2 })).toEqual({});
    expect(videoSettingsConstraints(config, { imageCount: 1, characterCount: 1 }, { videoStartFrameNodeId: "frame" }).ratioHelp).toContain("多素材参考生成可组合关键帧与角色参考图");

    const styleConfig = { ...config, model: "studio::opaque-style-only" };
    expect(videoSettingsConstraints(styleConfig, { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
    expect(videoSettingsConstraints(styleConfig, { characterCount: 1 }).ratioHelp).toContain("所选比例只在没有参考图时生效");
});

test("videoSettingsConstraints does not use controls as a proxy for frame ratio semantics", () => {
    const base = h3AspectConfig("minimax-h3-max");
    const templateVideo = base.channels[0]!.modelProfiles!.find((p) => p.model === "minimax-h3-max")!.capabilityConfig!.video!;
    const channel = createModelChannel({
        id: "studio",
        baseUrl: "https://studio.example/v1",
        models: ["seedance-with-seed", "frame-oprefs-no-controls"],
        modelProfiles: [
            {
                model: "seedance-with-seed",
                capability: "video",
                protocol: "newapi",
                videoCapabilitiesVersion: "v1",
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...structuredClone(templateVideo),
                        taskTypeConstraints: true,
                        controls: { seed: true },
                    },
                },
            },
            {
                model: "frame-oprefs-no-controls",
                capability: "video",
                protocol: "openai-videos",
                videoCapabilitiesVersion: "v1",
                capabilityConfig: {
                    version: 1,
                    video: {
                        ...structuredClone(templateVideo),
                        taskTypeConstraints: false,
                        controls: undefined,
                        middleFrame: undefined,
                        preferReferenceMode: undefined,
                        operationReferences: { image_to_video: { maxImages: 2, maxVideos: 0, maxAudios: 1 } },
                    },
                },
            },
        ],
    });
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], model: "studio::seedance-with-seed" } }).config;
    // Seedance-like model with controls.seed still uses Seedance constraints, not H3 keyframe copy.
    expect(videoSettingsConstraints(config, { imageCount: 1 }).ratioLabel).toBe("随首帧");
    expect(videoSettingsConstraints(config, { videoCount: 1 }, { videoEditOperation: "inpaint" })).toEqual({ ratioLabel: "随原视频", durationLocked: true });

    // A model declaring operationReferences.image_to_video without controls still gets keyframe ratio copy.
    const noControlsConfig = { ...config, model: "studio::frame-oprefs-no-controls" };
    expect(videoSettingsConstraints(noControlsConfig, { imageCount: 1 }).ratioLabel).toBe("随首帧图片");
    expect(videoSettingsConstraints(noControlsConfig, { imageCount: 1, audioCount: 2 })).toEqual({});
});
