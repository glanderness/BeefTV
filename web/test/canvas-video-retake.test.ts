import { expect, test } from "bun:test";

import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildCanvasVideoRetake, canvasVideoRetakeModel } from "@/lib/canvas/canvas-video-retake";
import { buildVideoGenerationMetadata } from "@/lib/canvas/canvas-project-generation-metadata";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { buildConfirmedGenerationConfig } from "@/pages/canvas/canvas-assistant-proposal-execution";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const seedanceCapability = defaultModelCapabilityConfig("newapi", "seedance-2.5");
seedanceCapability.video!.duration = { selection: "enum", values: [-1, 4, 5], min: 4, max: 5, step: 1, default: 4 };
const config = {
    ...defaultConfig,
    channels: [createModelChannel({
        id: "beeftv",
        scope: "system",
        pinned: true,
        credentialRef: "beeftv",
        baseUrl: "https://beeftv.app/v1",
        interfaceType: "newapi",
        models: ["seedance-2.5", "seedance-2.0"],
        modelProfiles: [{
            model: "seedance-2.5", capability: "video", protocol: "newapi",
            capabilityConfig: seedanceCapability, videoCapabilitiesVersion: "test",
        }, { model: "seedance-2.0", capability: "video", protocol: "newapi" }],
    })],
};
const video: CanvasNodeData = {
    id: "source", type: CanvasNodeType.Video, title: "镜头",
    width: 640, height: 360, position: { x: 0, y: 0 },
    metadata: { model: "beeftv::seedance-2.5", storageKey: "resource:video", durationMs: 4000, status: "success", vquality: "1080p" },
};

test("offers retake only for a completed Seedance 2.5 video", () => {
    expect(canvasVideoRetakeModel(video, config)).toBe("beeftv::seedance-2.5");
    expect(canvasVideoRetakeModel({ ...video, metadata: { ...video.metadata, model: "beeftv::seedance-2.0" } }, config)).toBeUndefined();
    expect(canvasVideoRetakeModel({ ...video, metadata: { ...video.metadata, status: "loading" } }, config)).toBeUndefined();
    expect(canvasVideoRetakeModel({ ...video, metadata: { ...video.metadata, storageKey: "" } }, config)).toBeUndefined();
});

test("one selected interval becomes the edit prompt and result provenance", () => {
    const range = { startMs: 1234, endMs: 2987 };
    const result = buildCanvasVideoRetake(video, config, range, 4000, "  抬起头  ");
    expect(result?.metadata).toMatchObject({
        model: "beeftv::seedance-2.5", videoEditOperation: "inpaint", size: "adaptive",
        videoRetakeSourceNodeId: video.id, videoRetakeSegments: [range], draft: "false",
    });
    expect(result?.metadata.prompt).toContain("00:01.234–00:02.987");
    expect(result?.metadata.prompt).toContain("抬起头");
    expect(result?.metadata.prompt).toContain("@视频1");
    expect(buildCanvasVideoRetake(video, config, range, 4000, " ")).toBeUndefined();
    expect(buildCanvasVideoRetake(video, config, { ...range, endMs: 5000 }, 4000, "抬起头")).toBeUndefined();
});

test("normal generation compiles a retake into a Seedance edit of the original video", () => {
    const range = { startMs: 500, endMs: 2500 };
    const retake = buildCanvasVideoRetake(video, config, range, 4000, "改变灯光")!;
    const target = { ...video, id: "retake", metadata: retake.metadata };
    const context = buildNodeGenerationContext(target.id, [video, target], [
        { id: "edge", fromNodeId: video.id, toNodeId: target.id },
    ], retake.prompt, []);
    const requestConfig = buildConfirmedGenerationConfig(config, target, "video", {
        capability: "video", videoOperation: "inpaint", input: { videoCount: 1, textCount: 1 },
    }, retake.model);
    expect(context.referenceVideos.map((ref) => ref.storageKey)).toEqual(["resource:video"]);
    expect(context.prompt).toContain("00:00.500–00:02.500");
    expect(requestConfig.videoSeconds).toBe("-1");
    expect(buildVideoGenerationMetadata(target, context, requestConfig).videoEditOperation).toBe("inpaint");
});
