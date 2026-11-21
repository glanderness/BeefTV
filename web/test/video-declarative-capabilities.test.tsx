import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasH3Controls } from "../src/components/canvas/canvas-h3-controls";
import { CanvasH3ReferenceOrder } from "../src/components/canvas/canvas-h3-reference-order";
import { CanvasConfigNodePanel } from "../src/components/canvas/canvas-config-node-panel";
import { buildGenerationConfig, canvasVideoOperationPreference } from "../src/lib/canvas/canvas-generation-config";
import { resolveVideoReferenceOrder } from "../src/lib/canvas/video-reference-mode";
import { mergeFetchedChannelModelProfiles } from "../src/lib/channel-model-catalog";
import {
    isVideoReferenceMode,
    normalizeVideoValue,
    sanitizeServerVideoCapability,
    videoDurationAllowed,
    videoPrefersReferenceMode,
    videoSupportsAdvancedControls,
    videoSupportsMiddleFrame,
    videoSupportsReferenceOrder,
    type VideoCapabilityConfig,
} from "../src/lib/model-capabilities";
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
});
