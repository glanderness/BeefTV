import assert from "node:assert/strict";
import test from "node:test";

// Bun 直接执行 TypeScript 测试时需要保留扩展名；生产 tsconfig 不包含 test/。
import { DEFAULT_VIDEO_PROMPT_MAX_CHARS, defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeVideoValue, videoDurationAllowed, videoSupportsTaskTypeConstraints } from "../src/lib/model-capabilities.ts";
import { modelCompatibilityError } from "../src/lib/model-selection.ts";
import type { AiConfig } from "../src/stores/use-config-store.ts";
import { seedanceTaskOptions, seedanceOmniTaskType } from "../src/lib/seedance-task-constraints.ts";

test("image transport does not depend on model names and server capabilities replace local defaults", () => {
    for (const model of ["opaque-future-2030", "gpt-image-2", "gpt-image-2.5-flare"]) {
        const stored = defaultModelCapabilityConfig("openai-image", model);
        for (const baseUrl of ["https://beeftv.app", "https://enterprise.beefapi.com/v1", "https://beefapi.com", "https://third-party.example", "http://beeftv.app", "https://beeftv.app.evil.example"]) {
            for (const cached of [false, true]) {
                const config = { channels: [{ id: "selected", baseUrl, models: [model], interfaceType: "openai-image", ...(cached ? { modelProfiles: [{ model, protocol: "openai-image", capabilityConfig: stored }] } : {}) }] } as AiConfig;
                const image = modelCapabilityConfigFor(config, `selected::${model}`).image!;
                assert.equal(image.references.maxImageBytes, 30 * 1024 * 1024);
                assert.equal(image.responseFormat.value, undefined);
            }
        }
        assert.equal(stored.image!.references.maxImageBytes, 30 * 1024 * 1024);
        assert.equal(stored.image!.responseFormat.value, undefined);
        const sourced = structuredClone(stored);
        sourced.image!.references.maxImageBytes = 0;
        sourced.image!.references.maxImages = 7;
        sourced.image!.quality = { supported: true, values: ["ultra"], default: "ultra" };
        sourced.image!.fixedOutputs = 4;
        const config = { channels: [{ id: "beefapi", baseUrl: "https://beeftv.app", models: [model], modelProfiles: [{ model, protocol: "openai-image", capabilityConfig: sourced, imageCapabilitiesVersion: "server-v2" }] }] } as AiConfig;
        assert.deepEqual(modelCapabilityConfigFor(config, `beefapi::${model}`), sourced);
    }
    const model = "dola-seedream-5-0-pro-260628";
    const config = { channels: [{ id: "beefapi", baseUrl: "https://beeftv.app", models: [model], interfaceType: "openai-image" }] } as AiConfig;
    assert.equal(modelCapabilityConfigFor(config, `beefapi::${model}`).image!.references.maxImageBytes, 30 * 1024 * 1024);
});

test("backend-normalized Dreamina profile preserves editing, duration choices, and taskTypeConstraints", () => {
    const model = "dreamina-seedance-2-5-260628";
    const base = defaultModelCapabilityConfig("volcengine-ark-video", model).video!;
    const backendVideo = {
        ...base,
        taskTypeConstraints: true,
        operations: ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video", "inpaint", "extend"] as const,
        ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
        duration: { selection: "enum" as const, min: 4, max: 30, step: 1, default: 5, values: [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)] },
        references: { ...base.references, maxImages: 30, maxVideos: 10, maxAudios: 10 },
    };
    const config = {
        channels: [{
            id: "custom",
            models: [model],
            modelProfiles: [{ model, protocol: "volcengine-ark-video", capability: "video", capabilityConfig: { version: 1, video: [...backendVideo.operations] ? { ...backendVideo, operations: [...backendVideo.operations] } : backendVideo } }],
        }],
    } as AiConfig;
    const profile = modelCapabilityConfigFor(config, `custom::${model}`).video!;
    assert.equal(videoSupportsTaskTypeConstraints(profile), true);
    assert.ok(profile.operations.includes("inpaint") && profile.operations.includes("extend") && profile.operations.includes("audio_to_video"));
    assert.ok(profile.ratios.includes("adaptive"));
    assert.equal(profile.duration.selection, "enum");
    for (const value of [-1, 4, 30]) assert.ok(videoDurationAllowed(profile, value));
    for (const value of [1, 3, 31]) assert.equal(videoDurationAllowed(profile, value), false);
    for (const operation of ["inpaint", "extend"]) assert.equal(modelCompatibilityError(config, `custom::${model}`, { capability: "video", videoSeconds: "6", videoOperation: operation as "inpaint" | "extend", input: { textCount: 1, imageCount: 0, characterCount: 0, videoCount: 1, audioCount: 0 } }), "");
    assert.deepEqual(seedanceTaskOptions(profile, "16:9", 6, [], 1, "inpaint"), { ratio: "adaptive", duration: -1 });
    assert.equal(seedanceOmniTaskType(profile, "extend", 1), "extend");
    assert.deepEqual(seedanceTaskOptions(profile, "16:9", 6, ["first_frame"], 0), { ratio: "adaptive", duration: 6 });
});

test("FullVideo full models accept one or two image references as well as mixed video references", () => {
    for (const name of ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"]) {
        const config = { channels: [{ id: "fullvideo", baseUrl: "https://video.example.com/v1", models: [name], modelProfiles: [{ model: name, capability: "video", protocol: "full-video" }] }] } as AiConfig;
        for (const [imageCount, videoCount] of [[1, 0], [2, 0], [0, 1], [2, 1]]) {
            assert.equal(modelCompatibilityError(config, `fullvideo::${name}`, {
                capability: "video", videoSeconds: "5",
                input: { textCount: 1, imageCount, videoCount, audioCount: 0, characterCount: 0 },
            }), "");
        }
    }
});

test("switching to MiniMax H3 replaces an unsupported 720p value with 768P", () => {
    const profile = defaultModelCapabilityConfig("minimax-video", "MiniMax-H3").video!;

    assert.deepEqual(normalizeVideoValue(profile, { seconds: "11", ratio: "16:9", resolution: "720" }), {
        seconds: "11",
        ratio: "16:9",
        resolution: "768P",
    });
});

test("undocumented video prompt ceilings are left to the provider", () => {
    assert.equal(DEFAULT_VIDEO_PROMPT_MAX_CHARS, 0);
    for (const protocol of [undefined, "seedance-videos-compatible", "agnes-video", "volcengine-ark-video"]) {
        const profile = defaultModelCapabilityConfig(protocol, "test-model");
        assert.equal(profile.video!.references.promptMaxChars, DEFAULT_VIDEO_PROMPT_MAX_CHARS);
    }
});

test("raising the video default leaves text and image limits untouched", () => {
    // 只放宽视频默认值，避免顺带改变其它能力的判定口径。
    const profile = defaultModelCapabilityConfig("seedance-videos-compatible", "sd-2.5");
    assert.equal(profile.text!.references.promptMaxChars, 32000);
    assert.equal(profile.image!.references.promptMaxChars, 32000);
});

test("Seedance does not infer a native ceiling from a shared tool schema", () => {
    for (const model of ["seedance-2.0", "seedance-2.0-fast", "doubao-seedance-2-0-260128"]) {
        assert.equal(defaultModelCapabilityConfig("newapi", model).video!.references.promptMaxChars, 0);
    }
    assert.equal(defaultModelCapabilityConfig("newapi", "other-video").video!.references.promptMaxChars, 0);
});

test("video prompt defaults do not invent local ceilings", () => {
    for (const [protocol, model] of [
        ["minimax-video", "MiniMax-H3"],
        ["minimax-video", "MiniMax-Hailuo-2.3"],
        ["dashscope-wan-video", "wan2.1-t2v-turbo"],
        ["dashscope-wan-video", "wan2.6-i2v"],
        ["dashscope-wan-video", "wan2.7-r2v"],
        ["dashscope-wan-video", "wan3.0-t2v"],
        ["openai-videos", "sora-2-pro"],
        ["full-video", "sd-native-full-2.0"],
        ["kling-video", "kling-v3"],
        ["luma-dream-machine", "ray-2"],
        ["pixverse-video", "v6-max"],
        ["zhipu-cogvideox", "cogvideox-3"],
        ["volcengine-jimeng-video", "jimeng_t2v_v30"],
        ["gemini-veo", "veo-3.1-generate-preview"],
        ["newapi", "MiniMax-H3"],
        ["custom-workflow", "wan3.0-t2v"],
    ] as const) {
        assert.equal(defaultModelCapabilityConfig(protocol, model).video!.references.promptMaxChars, 0, `${protocol}/${model}`);
    }
});

test("persisted video prompt limits do not inherit new UTF-16 defaults after reload", () => {
    const model = "gen4_turbo";
    assert.equal(defaultModelCapabilityConfig("runway-video", model).video!.references.promptMaxUtf16Units ?? 0, 0);
    for (const chars of [8000, 0]) {
        for (const utf16Units of [undefined, 0]) {
            const capabilityConfig = defaultModelCapabilityConfig("runway-video", model);
            capabilityConfig.video!.references.promptMaxChars = chars;
            if (utf16Units === undefined) delete capabilityConfig.video!.references.promptMaxUtf16Units;
            else capabilityConfig.video!.references.promptMaxUtf16Units = utf16Units;
            const persisted = JSON.stringify({ channels: [{ id: "runway", models: [model], modelProfiles: [{ model, protocol: "runway-video", capabilityConfig }] }] });
            const reloaded = JSON.parse(persisted) as AiConfig;
            const resolved = modelCapabilityConfigFor(reloaded, `runway::${model}`).video!;
            assert.equal(resolved.references.promptMaxChars, chars);
            assert.equal(resolved.references.promptMaxUtf16Units ?? 0, 0);
            assert.equal(JSON.stringify(reloaded), persisted, "resolving saved limits must not mutate the profile");
        }
    }
});

test("APIMart NewAPI channel exposes Seedance multimodal reference operations", () => {
    const profile = defaultModelCapabilityConfig("newapi-channel-2", "seedance-2.0-fast").video!;
    assert.deepEqual(profile.references.maxVideos, 3);
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(!profile.operations.includes("audio_to_video"));
});

test("BeefAPI generic newapi Seedance accepts mixed image and video references when backend capability profile is present", () => {
    const model = "beefapi::seedance-2.0-fast";
    const base = defaultModelCapabilityConfig("newapi", "seedance-2.0-fast");
    base.video!.operations = ["text_to_video", "image_to_video", "reference_to_video"];
    base.video!.references.maxVideos = 3;
    base.video!.references.maxAudios = 3;
    const config = {
        channels: [{
            id: "beefapi",
            name: "BeefAPI",
            baseUrl: "https://enterprise.beefapi.com",
            apiKey: "test",
            apiFormat: "openai",
            models: ["seedance-2.0-fast"],
            modelProfiles: [{
                model: "seedance-2.0-fast",
                capability: "video",
                protocol: "newapi",
                capabilityConfig: base,
                videoCapabilitiesVersion: "server-v1",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 0,
            }],
        }],
    } as AiConfig;

    const profile = modelCapabilityConfigFor(config, model).video!;
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(profile.references.maxVideos >= 1);
    assert.equal(modelCompatibilityError(config, model, {
        capability: "video",
        input: { textCount: 1, imageCount: 1, videoCount: 1, audioCount: 0, characterCount: 0 },
        videoSeconds: "5",
    }), "");
});
