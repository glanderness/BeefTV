import { mergeFetchedChannelModelProfiles } from "../../src/lib/channel-model-catalog";
import type { VideoCapabilityConfig } from "../../src/lib/model-capabilities";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot } from "../../src/stores/use-config-store";

export const h3Models = ["minimax-h3", "minimax-h3-max", "minimax-h3-max-turbo"];
export const h3StyleModels = [
    "minimax-h3-max-style-hand-drawn",
    "minimax-h3-max-style-16bit-pixel",
    "minimax-h3-max-style-low-poly",
    "minimax-h3-max-style-retro-toon-70s",
    "minimax-h3-max-style-vhs",
];

function isStyleFixture(id: string): boolean {
    return h3StyleModels.includes(id);
}

function fixtureVideoCapabilities(id: string, includeServerControls: boolean): VideoCapabilityConfig {
    const style = isStyleFixture(id);
    const continuous = id !== "minimax-h3" && !style;
    return {
        references: {
            promptMaxChars: 50000,
            minImages: 0,
            maxImages: style ? 1 : 9,
            maxImageBytes: 31457280,
            maxVideos: style ? 0 : 3,
            maxVideoBytes: 52428800,
            maxVideoDurationSeconds: 15,
            maxAudios: style ? 0 : 3,
            maxAudioBytes: 15000000,
            maxAudioDurationSeconds: 15,
        },
        duration: {
            selection: "range",
            min: continuous ? 1 : 5,
            max: 15,
            step: 1,
            default: 5,
            ...(continuous ? { fractionalMin: 0.92, continuous: true } : {}),
        },
        ratios: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4", ...(!style ? ["adaptive"] : [])],
        defaultRatio: "16:9",
        resolutions: style ? ["768p"] : ["768p", "480p", ...(id === "minimax-h3" ? ["2k", "4k"] : ["1080p"])],
        defaultResolution: "768p",
        generateAudio: { supported: false, default: true },
        watermark: { supported: false, default: false },
        operations: style ? ["text_to_video", "image_to_video"] : ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
        ...(includeServerControls
            ? {
                  operationReferences: {
                      image_to_video: style
                          ? { maxImages: 1, maxVideos: 0, maxAudios: 0 }
                          : { maxImages: 2, maxVideos: 0, maxAudios: 1 },
                  },
                  middleFrame: id === "minimax-h3-max",
                  referenceOrder: id === "minimax-h3-max" || id === "minimax-h3-max-turbo",
                  ...(id === "minimax-h3" ? { preferReferenceMode: true } : {}),
                  controls: style
                      ? {
                            seed: true,
                            ...(id === "minimax-h3-max-style-vhs" ? { damageLevels: ["light", "medium", "heavy"] as const } : {}),
                        }
                      : {
                            seed: true,
                            promptExpansionModes: id === "minimax-h3" ? ["balanced", "quality", "fast", "disabled"] : ["balanced", "quality", "disabled"],
                        },
              }
            : {}),
    };
}

export function h3AspectConfig(model = "minimax-h3-max-turbo", baseUrl = "https://beeftv.app") {
    const models = [...h3Models, ...h3StyleModels];
    const includeServerControls = baseUrl === "https://beeftv.app";
    const channel = createModelChannel({ id: "beeftv", baseUrl, models });
    channel.modelProfiles = mergeFetchedChannelModelProfiles(
        channel,
        models.map((id) => ({
            id,
            supportedEndpointTypes: ["openai-video"],
            videoCapabilitiesVersion: "aspect-hint-fixture",
            videoCapabilities: fixtureVideoCapabilities(id, includeServerControls),
        })),
    );
    return normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [channel], model: `beeftv::${model}`, videoModel: `beeftv::${model}`, size: "9:16", vquality: "768p", videoSeconds: "15" } }).config;
}
