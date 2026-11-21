import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasH3Controls } from "../src/components/canvas/canvas-h3-controls";
import { CanvasH3ReferenceOrder } from "../src/components/canvas/canvas-h3-reference-order";
import { CanvasConfigNodePanel } from "../src/components/canvas/canvas-config-node-panel";
import { buildGenerationConfig, canvasVideoOperationPreference } from "../src/lib/canvas/canvas-generation-config";
import { buildVideoGenerationMetadata } from "../src/lib/canvas/canvas-project-generation";
import { resolveVideoReferenceCapabilities, resolveVideoReferenceOrder } from "../src/lib/canvas/video-reference-mode";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import {
    isVideoReferenceMode,
    normalizeVideoGenerationControls,
    normalizeVideoValue,
    sanitizeServerVideoCapability,
    videoDurationAllowed,
    videoPrefersReferenceMode,
    videoSupportsAdvancedControls,
    videoSupportsMiddleFrame,
    videoSupportsReferenceOrder,
    type VideoCapabilityConfig,
} from "../src/lib/model-capabilities";
import { resolveVideoOperation } from "../src/lib/model-selection";
import { videoSettingsConstraints } from "../src/lib/video-settings-constraints";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../src/stores/use-config-store";
import { CanvasNodeType } from "../src/types/canvas";

const baseCapabilityPayload = {
    references: { promptMaxChars: 50000, minImages: 0, maxImages: 9, maxImageBytes: 31457280, maxVideos: 3, maxAudios: 3 },
    duration: { selection: "range" as const, min: 1, fractionalMin: 0.92, max: 15, step: 1, default: 5, continuous: true },
    ratios: ["16:9", "9:16"],
    defaultRatio: "16:9",
    resolutions: ["768p"],
    defaultResolution: "768p",
    generateAudio: { supported: false, default: true },
    watermark: { supported: false, default: false },
    operations: ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video"],
    defaultOperation: "text_to_video",
};

describe("declarative videoCapabilities wire parsing & helpers", () => {
    test("sanitizeServerVideoCapability preserves middleFrame, referenceOrder, preferReferenceMode, controls, and continuous duration", () => {
        const parsed = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            middleFrame: true,
            referenceOrder: true,
            preferReferenceMode: true,
            operationReferences: { image_to_video: { maxImages: 2, maxVideos: 0, maxAudios: 1 } },
            controls: {
                seed: true,
                promptExpansionModes: ["balanced", "quality", "fast", "disabled"],
                damageLevels: ["light", "medium", "heavy"],
            },
        });
        expect(parsed).not.toBeNull();
        expect(videoSupportsMiddleFrame(parsed)).toBe(true);
        expect(videoSupportsReferenceOrder(parsed)).toBe(true);
        expect(videoPrefersReferenceMode(parsed)).toBe(true);
        expect(videoSupportsAdvancedControls(parsed)).toBe(true);
        expect(parsed!.controls).toEqual({
            seed: true,
            promptExpansionModes: ["balanced", "quality", "fast", "disabled"],
            damageLevels: ["light", "medium", "heavy"],
        });
        expect(normalizeVideoValue(parsed!, { seconds: "0.925", ratio: "16:9", resolution: "768p" }).seconds).toBe("0.925");
        expect(videoDurationAllowed(parsed!, 0.925)).toBe(true);

        const emptyControls = sanitizeServerVideoCapability({ ...baseCapabilityPayload, controls: { seed: false, promptExpansionModes: [], damageLevels: [] } });
        expect(emptyControls).not.toBeNull();
        expect(videoSupportsAdvancedControls(emptyControls)).toBe(false);
    });

    test("sanitizeServerVideoCapability rejects malformed referenceOrder, preferReferenceMode, and controls", () => {
        for (const bad of [
            { referenceOrder: "yes" },
            { preferReferenceMode: 1 },
            { controls: "seed" },
            { controls: null },
            { controls: { seed: "true" } },
            { controls: { promptExpansionModes: ["turbo"] } },
            { controls: { promptExpansionModes: "balanced" } },
            { controls: { damageLevels: ["extreme"] } },
            { controls: { damageLevels: [123] } },
        ]) {
            expect(sanitizeServerVideoCapability({ ...baseCapabilityPayload, ...bad })).toBeNull();
        }
    });

    test("isVideoReferenceMode respects preferReferenceMode, middleFrame, and operationReferences without model-name checks", () => {
        const preferRefCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            preferReferenceMode: true,
            operationReferences: { image_to_video: { maxImages: 2, maxVideos: 0, maxAudios: 1 } },
        })!;
        expect(isVideoReferenceMode(preferRefCap, { imageCount: 1, videoCount: 0, audioCount: 0 }, {})).toBe(true);
        expect(isVideoReferenceMode(preferRefCap, { imageCount: 1, videoCount: 0, audioCount: 0 }, { videoStartFrameNodeId: "img-1" })).toBe(false);
        expect(isVideoReferenceMode(preferRefCap, { imageCount: 1, videoCount: 0, audioCount: 0 }, { videoEditOperation: "image_to_video" })).toBe(false);
        expect(isVideoReferenceMode(preferRefCap, { imageCount: 1, videoCount: 0, audioCount: 1 }, { videoEditOperation: "image_to_video" })).toBe(false);
        expect(isVideoReferenceMode(preferRefCap, { imageCount: 1, videoCount: 0, audioCount: 2 }, { videoEditOperation: "image_to_video" })).toBe(true);

        const middleFrameCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            middleFrame: true,
        })!;
        expect(isVideoReferenceMode(middleFrameCap, { imageCount: 1, videoCount: 0, audioCount: 0 }, {})).toBe(false);
        expect(isVideoReferenceMode(middleFrameCap, { imageCount: 2, videoCount: 0, audioCount: 0 }, { videoMiddleFrameNodeId: "mid" })).toBe(true);

        const frameOnlyCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            operations: ["text_to_video", "image_to_video"],
            preferReferenceMode: true,
        })!;
        expect(isVideoReferenceMode(frameOnlyCap, { imageCount: 1, videoCount: 0, audioCount: 0 }, { videoEditOperation: "reference_to_video" })).toBe(false);
    });

    test("resolveVideoReferenceOrder expands character card groups while preserving explicit order and appending unmentioned media", () => {
        const media = [
            { id: "scene" },
            { id: "character-reference-1", sourceNodeId: "card" },
            { id: "character-reference-2", sourceNodeId: "card" },
            { id: "motion" },
            { id: "character-voice-asset", sourceNodeId: "card" },
            { id: "extra" },
        ];
        expect(resolveVideoReferenceOrder(["motion", "card", "scene", "missing"], media)).toEqual([
            "motion",
            "character-reference-1",
            "character-reference-2",
            "character-voice-asset",
            "scene",
            "extra",
        ]);
        expect(resolveVideoReferenceOrder(undefined, media)).toBeUndefined();
    });
});

describe("capability-driven video UI controls for opaque model IDs", () => {
    test("CanvasH3Controls renders only declared controls and continuous duration bounds", () => {
        const fullHtml = renderToStaticMarkup(
            <CanvasH3Controls
                controls={{ seed: true, promptExpansionModes: ["balanced", "fast", "disabled"], damageLevels: ["light", "medium", "heavy"] }}
                durationConfig={{ selection: "range", min: 1, fractionalMin: 0.92, max: 12, step: 1, default: 5, continuous: true }}
                duration="2.5"
                onDurationChange={() => {}}
                onChange={() => {}}
            />,
        );
        expect(fullHtml).toContain("高级参数");
        expect(fullHtml).toContain("时长（秒）");
        expect(fullHtml).toContain("提示词增强");
        expect(fullHtml).toContain("随机种子");
        expect(fullHtml).toContain("磁带磨损");

        const damageOnlyHtml = renderToStaticMarkup(
            <CanvasH3Controls
                controls={{ seed: true, damageLevels: ["light", "heavy"] }}
                durationConfig={{ selection: "range", min: 5, max: 15, step: 1, default: 5 }}
                onDurationChange={() => {}}
                onChange={() => {}}
            />,
        );
        expect(damageOnlyHtml).toContain("随机种子");
        expect(damageOnlyHtml).toContain("磁带磨损");
        expect(damageOnlyHtml).not.toContain("提示词增强");
        expect(damageOnlyHtml).not.toContain("时长（秒）");

        expect(renderToStaticMarkup(<CanvasH3Controls controls={{}} onChange={() => {}} />)).toBe("");
    });

    test("CanvasH3ReferenceOrder toggles purely via declarative supported flag", () => {
        const inputs = [
            { nodeId: "img-1", type: "image" as const, title: "场景图" },
            { nodeId: "aud-1", type: "audio" as const, title: "对白音频" },
        ];
        expect(renderToStaticMarkup(<CanvasH3ReferenceOrder supported={false} inputs={inputs} onChange={() => {}} />)).toBe("");
        const html = renderToStaticMarkup(<CanvasH3ReferenceOrder supported inputs={inputs} onChange={() => {}} />);
        expect(html).toContain("参考素材顺序");
        expect(html).toContain("场景图");
        expect(html).toContain("对白音频");
    });

    test("CanvasConfigNodePanel and buildGenerationConfig honor opaque model controls and continuous duration", () => {
        const opaqueCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            middleFrame: false,
            referenceOrder: true,
            controls: { seed: true, promptExpansionModes: ["balanced", "quality"], damageLevels: ["light", "medium", "heavy"] },
        }) as VideoCapabilityConfig;
        const channel = createModelChannel({
            id: "beeftv",
            scope: "system",
            baseUrl: "https://beeftv.app/v1",
            models: ["opaque-future-video"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            {
                id: "opaque-future-video",
                supportedEndpointTypes: ["openai-video"],
                videoCapabilitiesVersion: "v-opaque-1",
                videoCapabilities: opaqueCap,
            },
        ]);
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [channel], model: "beeftv::opaque-future-video", videoModel: "beeftv::opaque-future-video" },
        }).config;
        const node = {
            id: "cfg-opaque",
            type: CanvasNodeType.Config,
            title: "Opaque",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: {
                generationMode: "video" as const,
                model: "beeftv::opaque-future-video",
                seconds: "1.75",
                videoMiddleFrameNodeId: "mid-1",
                videoMiddleFrameTime: 1.0,
            },
        };
        expect(buildGenerationConfig(config, node, "video").videoSeconds).toBe("1.75");
        const html = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={config}
                node={node}
                isRunning={false}
                inputSummary={{ textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 }}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(html).toContain("高级参数");
        expect(html).toContain("提示词增强");
        expect(html).toContain("磁带磨损");
        expect(html).toContain("时长（秒）");
        expect(html).toContain("清除不支持的帧设置");
    });

    test("canvasVideoOperationPreference honors declarative preferReferenceMode for opaque models", () => {
        const opaqueCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            preferReferenceMode: true,
        })!;
        const channel = createModelChannel({
            id: "studio",
            name: "Studio",
            baseUrl: "https://studio.example/v1",
            models: ["opaque-prefer-ref"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            {
                id: "opaque-prefer-ref",
                supportedEndpointTypes: ["openai-video"],
                videoCapabilitiesVersion: "v-prefer-1",
                videoCapabilities: opaqueCap,
            },
        ]);
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [channel], model: "studio::opaque-prefer-ref", videoModel: "studio::opaque-prefer-ref" },
        }).config;
        const baseNode = {
            id: "vid-1",
            type: CanvasNodeType.Video,
            title: "Video",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: { model: "studio::opaque-prefer-ref" },
        };
        const oneImage = { textCount: 0, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 };
        // Even with preferredMode="frames" or omitted, untagged image defaults to reference_to_video.
        expect(canvasVideoOperationPreference(config, baseNode, oneImage, "frames")).toBe("reference_to_video");
        expect(canvasVideoOperationPreference(config, baseNode, oneImage)).toBe("reference_to_video");
        // Explicit frame role or explicit image_to_video stays out of reference_to_video.
        expect(canvasVideoOperationPreference(config, { ...baseNode, metadata: { ...baseNode.metadata, videoStartFrameNodeId: "img-1" } }, oneImage, "frames")).toBeUndefined();
        expect(canvasVideoOperationPreference(config, { ...baseNode, metadata: { ...baseNode.metadata, videoEditOperation: "image_to_video" } }, oneImage, "frames")).toBe("image_to_video");
    });

    test("resolveVideoOperation unifies preferReferenceMode across create, config panel, and settings constraints", () => {
        const opaqueCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            preferReferenceMode: true,
            operationReferences: { image_to_video: { maxImages: 2, maxVideos: 0, maxAudios: 1 } },
            controls: { seed: true, promptExpansionModes: ["disabled", "balanced", "quality"] },
        })!;
        const oneImage = { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 };
        // Direct caller (e.g. /create submit) & untagged node resolve to reference_to_video
        expect(resolveVideoOperation(oneImage, undefined, opaqueCap)).toBe("reference_to_video");
        // Explicit frame or explicit image_to_video stays image_to_video
        expect(resolveVideoOperation(oneImage, undefined, opaqueCap, { hasExplicitFrame: true })).toBe("image_to_video");
        expect(resolveVideoOperation(oneImage, "image_to_video", opaqueCap)).toBe("image_to_video");

        const channel = createModelChannel({
            id: "studio",
            name: "Studio",
            baseUrl: "https://studio.example/v1",
            models: ["opaque-prefer-ref"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            {
                id: "opaque-prefer-ref",
                supportedEndpointTypes: ["openai-video"],
                videoCapabilitiesVersion: "v-prefer-unified",
                videoCapabilities: opaqueCap,
            },
        ]);
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [channel], model: "studio::opaque-prefer-ref", videoModel: "studio::opaque-prefer-ref" },
        }).config;

        // Settings constraints agree with resolveVideoOperation: untagged -> editable ratio; explicit frame -> locked ratio
        expect(videoSettingsConstraints(config, { imageCount: 1 })).toEqual({});
        expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoStartFrameNodeId: "img-1" }).ratioLabel).toBe("随首帧图片");
        expect(videoSettingsConstraints(config, { imageCount: 1 }, { videoEditOperation: "image_to_video" }).ratioLabel).toBe("随首帧图片");

        // Config node panel select agrees: untagged shows 全能参考 (reference_to_video)
        const untaggedConfigNode = {
            id: "cfg-prefer-ref",
            type: CanvasNodeType.Config,
            title: "Config",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: { generationMode: "video" as const, model: "studio::opaque-prefer-ref" },
        };
        const htmlUntagged = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={config}
                node={untaggedConfigNode}
                isRunning={false}
                inputSummary={oneImage}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(htmlUntagged).toContain("参考生成");
        const explicitFrameHtml = renderToStaticMarkup(
            <CanvasConfigNodePanel
                config={config}
                node={{ ...untaggedConfigNode, metadata: { ...untaggedConfigNode.metadata, videoStartFrameNodeId: "img-1" } }}
                isRunning={false}
                inputSummary={oneImage}
                onConfigChange={() => {}}
                onGenerate={() => {}}
                onComposerToggle={() => {}}
            />,
        );
        expect(explicitFrameHtml).toContain("首帧 / 首尾帧");
    });

    test("omitted declarative flags stay opaque (preserving cached saved settings) while explicit false/empty cleans them", () => {
        const omittedCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
        })!;
        const explicitOffCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            middleFrame: false,
            referenceOrder: false,
            controls: {},
        })!;

        // Omitted flags -> opaque even when hasDeclaredCapability = true; UI stays hidden (supported = false)
        const omittedSupport = resolveVideoReferenceCapabilities("beeftv::opaque-legacy-cache", omittedCap, true);
        expect(omittedSupport.middleFrameSupport).toBe("opaque");
        expect(omittedSupport.middleFrameSupported).toBe(false);
        expect(omittedSupport.referenceOrderSupport).toBe("opaque");
        expect(omittedSupport.referenceOrderSupported).toBe(false);
        expect(omittedSupport.controlsSupport).toBe("opaque");
        expect(omittedSupport.controlsSupported).toBe(false);

        // Explicit false / empty controls -> unsupported
        const offSupport = resolveVideoReferenceCapabilities("beeftv::opaque-explicit-off", explicitOffCap, true);
        expect(offSupport.middleFrameSupport).toBe("unsupported");
        expect(offSupport.referenceOrderSupport).toBe("unsupported");
        expect(offSupport.controlsSupport).toBe("unsupported");

        const channel = createModelChannel({
            id: "beeftv",
            name: "BeefTV",
            baseUrl: "https://beeftv.app/v1",
            models: ["opaque-legacy-cache", "opaque-explicit-off"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            { id: "opaque-legacy-cache", supportedEndpointTypes: ["openai-video"], videoCapabilitiesVersion: "v1", videoCapabilities: omittedCap },
            { id: "opaque-explicit-off", supportedEndpointTypes: ["openai-video"], videoCapabilitiesVersion: "v2", videoCapabilities: explicitOffCap },
        ]);
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [channel], model: "beeftv::opaque-legacy-cache", videoModel: "beeftv::opaque-legacy-cache" },
        }).config;
        const images = [
            { id: "img-1", name: "1.png", type: "image/png", dataUrl: "https://example.com/1.png", position: { x: 0, y: 0 } },
            { id: "img-2", name: "2.png", type: "image/png", dataUrl: "https://example.com/2.png", position: { x: 10, y: 0 } },
        ];
        const savedNode = {
            id: "vid-saved",
            type: CanvasNodeType.Video,
            title: "Saved",
            position: { x: 0, y: 0 },
            width: 240,
            height: 180,
            metadata: {
                model: "beeftv::opaque-legacy-cache",
                videoEditOperation: "reference_to_video" as const,
                videoMiddleFrameNodeId: "img-2",
                videoMiddleFrameTime: 1.5,
                videoReferenceOrder: ["img-2", "img-1"],
                videoH3Options: { seed: 42, prompt_expansion_mode: "balanced" as const },
            },
        };
        const legacyMeta = buildVideoGenerationMetadata(savedNode, { referenceImages: images, referenceVideos: [], referenceAudios: [] }, config);
        expect(legacyMeta.videoMiddleFrameNodeId).toBe("img-2");
        expect(legacyMeta.videoMiddleFrameTime).toBe(1.5);
        expect(legacyMeta.videoReferenceOrder).toEqual(["img-2", "img-1"]);
        expect(legacyMeta.videoH3Options).toEqual({ seed: 42, prompt_expansion_mode: "balanced" });

        const offConfig = { ...config, model: "beeftv::opaque-explicit-off", videoModel: "beeftv::opaque-explicit-off" };
        const offMeta = buildVideoGenerationMetadata(
            { ...savedNode, metadata: { ...savedNode.metadata, model: "beeftv::opaque-explicit-off" } },
            { referenceImages: images, referenceVideos: [], referenceAudios: [] },
            offConfig,
        );
        expect(offMeta.videoMiddleFrameNodeId).toBeUndefined();
        expect(offMeta.videoMiddleFrameTime).toBeUndefined();
        expect(offMeta.videoReferenceOrder).toBeUndefined();
        expect(offMeta.videoH3Options).toBeUndefined();
    });

    test("normalizeVideoGenerationControls and buildVideoGenerationMetadata strip unsupported persisted videoH3Options", () => {
        const cap = { seed: true, promptExpansionModes: ["disabled", "balanced", "quality"] as const };
        expect(normalizeVideoGenerationControls(cap, { seed: 7, prompt_expansion_mode: "fast", damage_level: "heavy" })).toEqual({ seed: 7 });
        expect(normalizeVideoGenerationControls(cap, { prompt_expansion_mode: "fast", damage_level: "light" })).toBeUndefined();
        expect(normalizeVideoGenerationControls({ seed: false, promptExpansionModes: ["balanced"] }, { seed: 7, prompt_expansion_mode: "balanced" })).toEqual({ prompt_expansion_mode: "balanced" });
        expect(normalizeVideoGenerationControls({ seed: true }, { seed: 1.5 })).toBeUndefined();

        const serverCap = sanitizeServerVideoCapability({
            ...baseCapabilityPayload,
            controls: { seed: true, promptExpansionModes: ["disabled", "balanced", "quality"] },
        })!;
        const channel = createModelChannel({
            id: "studio",
            name: "Studio",
            baseUrl: "https://studio.example/v1",
            models: ["opaque-controls-strict"],
        });
        channel.modelProfiles = mergeFetchedChannelModelProfiles(channel, [
            { id: "opaque-controls-strict", supportedEndpointTypes: ["openai-video"], videoCapabilitiesVersion: "v1", videoCapabilities: serverCap },
        ]);
        const config = normalizeConfigSnapshot({
            config: { ...defaultConfig, channels: [channel], model: "studio::opaque-controls-strict", videoModel: "studio::opaque-controls-strict" },
        }).config;
        const node = {
            id: "vid-stale-opts",
            type: CanvasNodeType.Video,
            title: "Stale Controls",
            position: { x: 0, y: 0 },
            width: 240,
            height: 180,
            metadata: {
                model: "studio::opaque-controls-strict",
                videoH3Options: { seed: 99, prompt_expansion_mode: "fast" as const, damage_level: "medium" as const },
            },
        };
        const built = buildVideoGenerationMetadata(node, { referenceImages: [], referenceVideos: [], referenceAudios: [] }, config);
        expect(built.videoH3Options).toEqual({ seed: 99 });
    });
});
