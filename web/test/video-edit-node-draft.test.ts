import { describe, expect, test } from "bun:test";
import { resolveVideoEditNodeDraft } from "../src/pages/canvas/canvas-generation-orchestration";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function configWithVideoModel(modelId: string, taskTypeConstraints: boolean): AiConfig {
    return {
        ...defaultConfig,
        videoModel: `beeftv::${modelId}`,
        channels: [
            {
                id: "beeftv",
                name: "BeefTV 官方算力",
                baseUrl: "https://api.beeftv.app/v1",
                apiKey: "",
                apiFormat: "openai",
                enabled: true,
                models: [modelId],
                modelProfiles: [
                    {
                        model: modelId,
                        capability: "video",
                        protocol: "beeftv-managed-media",
                        enabled: true,
                        capabilityConfig: {
                            video: {
                                operations: ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend"],
                                defaultOperation: "text_to_video",
                                taskTypeConstraints,
                                ratios: ["adaptive", "16:9", "9:16"],
                                defaultRatio: "16:9",
                                resolutions: ["480p", "720p", "1080p"],
                                defaultResolution: "720p",
                                duration: {
                                    selection: "enum",
                                    values: [-1, 4, 5, 6, 7, 8],
                                    default: 5,
                                },
                                generateAudio: { supported: true, default: true },
                                watermark: { supported: true, default: false },
                                draft: { supported: true, default: false },
                                returnLastFrame: { supported: true, default: false },
                                references: {
                                    promptMaxChars: 0,
                                    promptMaxUtf16Units: 0,
                                    minImages: 0,
                                    maxImages: 9,
                                    maxImageBytes: 30 << 20,
                                    maxVideos: 3,
                                    maxVideoBytes: 50 << 20,
                                    maxVideoDurationSeconds: 15,
                                    maxAudios: 3,
                                    maxAudioBytes: 15 << 20,
                                    maxAudioDurationSeconds: 15,
                                },
                            },
                        },
                    },
                ],
            },
        ],
    };
}

describe("resolveVideoEditNodeDraft", () => {
    test("sets seconds to -1 for inpaint when the target video model declares taskTypeConstraints", () => {
        const config = configWithVideoModel("constrained-video", true);
        const sourceNode: CanvasNodeData = {
            id: "video-1",
            type: CanvasNodeType.Video,
            title: "原始视频",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: {
                content: "https://example.invalid/source.mp4",
                model: "beeftv::constrained-video",
                seconds: "5",
                vquality: "720p",
            },
        };

        const inpaintDraft = resolveVideoEditNodeDraft(config, sourceNode, "inpaint");
        expect(inpaintDraft.model).toBe("beeftv::constrained-video");
        expect(inpaintDraft.size).toBe("adaptive");
        expect(inpaintDraft.seconds).toBe("-1");

        const extendDraft = resolveVideoEditNodeDraft(config, sourceNode, "extend");
        expect(extendDraft.model).toBe("beeftv::constrained-video");
        expect(extendDraft.size).toBe("adaptive");
        expect(extendDraft.seconds).toBe("5");
    });

    test("preserves source seconds for inpaint when model does not declare taskTypeConstraints", () => {
        const config = configWithVideoModel("unconstrained-video", false);
        const sourceNode: CanvasNodeData = {
            id: "video-2",
            type: CanvasNodeType.Video,
            title: "原始视频",
            position: { x: 0, y: 0 },
            width: 320,
            height: 240,
            metadata: {
                content: "https://example.invalid/source.mp4",
                model: "beeftv::unconstrained-video",
                seconds: "5",
                vquality: "720p",
            },
        };

        const inpaintDraft = resolveVideoEditNodeDraft(config, sourceNode, "inpaint");
        expect(inpaintDraft.model).toBe("beeftv::unconstrained-video");
        expect(inpaintDraft.seconds).toBe("5");
    });
});
