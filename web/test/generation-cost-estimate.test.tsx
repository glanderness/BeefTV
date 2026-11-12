import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GenerationCostLabel } from "../src/components/generation/generation-cost-badge";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-config";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import {
    batchTableCostTargets,
    canvasNodeCostTarget,
    creationComposerCostTarget,
    formatInlineCostEstimate,
} from "../src/lib/generation-cost-estimate";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasBatchRow } from "../src/types/canvas";

const fixtureConfig: AiConfig = {
    ...defaultConfig,
    channels: [
        {
            id: "beeftv",
            name: "BeefTV 官方算力",
            baseUrl: "https://beeftv.example",
            apiKey: "fixture",
            apiFormat: "openai",
            models: ["fixture-image", "fixture-video", "fixture-audio"],
            modelProfiles: [
                { model: "fixture-image", capability: "image", capabilityConfig: defaultModelCapabilityConfig("image"), capabilitySource: "user" },
                { model: "fixture-video", capability: "video", capabilityConfig: defaultModelCapabilityConfig("video"), capabilitySource: "user" },
                { model: "fixture-audio", capability: "audio", capabilityConfig: defaultModelCapabilityConfig("audio"), capabilitySource: "user" },
            ],
        },
    ],
    imageModel: "beeftv::fixture-image",
    videoModel: "beeftv::fixture-video",
    audioModel: "beeftv::fixture-audio",
};

describe("formatInlineCostEstimate", () => {
    test("官方算力已知价格与预扣价格提取紧凑主文案并保留完整依据", () => {
        expect(
            formatInlineCostEstimate({
                amount: 0.4,
                basis: "1K 中质量 ¥0.4/张 × 1 张",
                text: "预计 ¥0.4（1K 中质量 ¥0.4/张 × 1 张）",
            }),
        ).toEqual({
            label: "预计 ¥0.4",
            tooltip: "预计 ¥0.4（1K 中质量 ¥0.4/张 × 1 张）",
        });

        expect(
            formatInlineCostEstimate({
                amount: 3.9744,
                approx: true,
                basis: "720p ¥0.9936/秒 × 4 秒，按 Token 折算",
                text: "约 ¥3.97（720p ¥0.9936/秒 × 4 秒，按 Token 折算）",
            }),
        ).toEqual({
            label: "约 ¥3.97",
            tooltip: "约 ¥3.97（720p ¥0.9936/秒 × 4 秒，按 Token 折算）",
        });

        expect(
            formatInlineCostEstimate({
                amount: null,
                reserve: 15.98,
                basis: "参考生成先扣 ¥15.98，出账后按官网价 × 汇率结算",
                text: "参考生成先扣 ¥15.98，出账后按官网价 × 汇率结算",
            }),
        ).toEqual({
            label: "先扣 ¥15.98",
            tooltip: "参考生成先扣 ¥15.98，出账后按官网价 × 汇率结算",
        });
    });

    test("按量结算保留单价提示，自带 Key 与暂无价格保持静默", () => {
        expect(
            formatInlineCostEstimate({
                amount: null,
                basis: "含参考视频，按实际视频 Token 结算（720p ¥28/百万 Token）",
                text: "含参考视频，按实际视频 Token 结算（720p ¥28/百万 Token）",
            }),
        ).toEqual({
            label: "按量结算",
            tooltip: "含参考视频，按实际视频 Token 结算（720p ¥28/百万 Token）",
        });

        expect(
            formatInlineCostEstimate({
                amount: null,
                basis: "图层拆分按实际拆出的图层数计费，每层 ¥0.0366",
                text: "图层拆分按实际拆出的图层数计费，每层 ¥0.0366",
            }),
        ).toEqual({
            label: "每层 ¥0.0366",
            tooltip: "图层拆分按实际拆出的图层数计费，每层 ¥0.0366",
        });

        expect(
            formatInlineCostEstimate({
                amount: null,
                basis: "自带 Key 的渠道暂无价格，按该渠道实际计费",
                text: "自带 Key 的渠道暂无价格，按该渠道实际计费",
            }),
        ).toBeNull();

        expect(
            formatInlineCostEstimate({
                amount: null,
                basis: "台词为空，暂无价格",
                text: "台词为空，暂无价格",
            }),
        ).toBeNull();
    });
});

describe("generation cost targets", () => {
    test("画布视频与图片节点在未输入提示词前就能按当前秒数与参数构造估算请求", () => {
        const videoNode = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { seconds: "4", vquality: "720p" });
        const videoConfig = buildGenerationConfig(fixtureConfig, videoNode, "video");
        expect(
            canvasNodeCostTarget({
                mode: "video",
                config: videoConfig,
                referenceImages: 1,
                referenceVideos: 0,
                prompt: "",
            }),
        ).toEqual({
            modelKey: "beeftv::fixture-video",
            kind: "video",
            parameters: { vquality: "720", seconds: "4", count: "1" },
            referenceImages: 1,
            referenceVideos: 0,
        });

        const audioConfig = buildGenerationConfig(fixtureConfig, createCanvasNode(CanvasNodeType.Audio, { x: 0, y: 0 }), "audio");
        expect(canvasNodeCostTarget({ mode: "audio", config: audioConfig, referenceImages: 0, referenceVideos: 0, prompt: "   " })).toBeNull();
        expect(canvasNodeCostTarget({ mode: "audio", config: audioConfig, referenceImages: 0, referenceVideos: 0, prompt: " 欢迎收看牛肉粉 " })).toEqual({
            modelKey: "beeftv::fixture-audio",
            kind: "audio",
            parameters: { count: "1" },
            text: "欢迎收看牛肉粉",
        });
    });

    test("独立创作页与批量创作表按实际提交参数生成估算目标", () => {
        const imageProfile = defaultModelCapabilityConfig("image").image!;
        const videoProfile = defaultModelCapabilityConfig("video").video!;
        expect(
            creationComposerCostTarget({
                mode: "video",
                model: "beeftv::fixture-video",
                imageProfile,
                videoProfile,
                ratio: "16:9",
                quality: "auto",
                count: "1",
                seconds: "10",
                videoQuality: "720p",
                referenceImages: 2,
                referenceVideos: 0,
            }),
        ).toEqual({
            modelKey: "beeftv::fixture-video",
            kind: "video",
            parameters: { vquality: "720", seconds: "10", count: "1" },
            referenceImages: 2,
            referenceVideos: 0,
        });
        expect(
            creationComposerCostTarget({
                mode: "text",
                model: "beeftv::fixture-video",
                imageProfile,
                videoProfile,
                ratio: "16:9",
                quality: "auto",
                count: "1",
                seconds: "10",
                videoQuality: "720p",
                referenceImages: 0,
                referenceVideos: 0,
            }),
        ).toBeNull();

        const existingOutput = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, { size: "1536x1024", quality: "high", count: 2 });
        const rows: CanvasBatchRow[] = [
            { id: "r1", enabled: true, inputNodeIds: ["in-1", "in-2"], prompt: "换装 1", outputNodeId: existingOutput.id },
            { id: "r2", enabled: true, inputNodeIds: ["in-1"], prompt: "换装 2" },
        ];
        expect(batchTableCostTargets(fixtureConfig, rows, [existingOutput])).toEqual([
            {
                modelKey: "beeftv::fixture-image",
                kind: "image",
                parameters: { size: "1536x1024", quality: "high", count: "2" },
                referenceImages: 2,
            },
            {
                modelKey: "beeftv::fixture-image",
                kind: "image",
                parameters: { size: "1:1", quality: "auto", count: "1" },
                referenceImages: 1,
            },
        ]);
    });

    test("价格标签输出等宽数字、可聚焦角色与无障碍完整计价说明", () => {
        const html = renderToStaticMarkup(
            <GenerationCostLabel
                display={{
                    label: "约 ¥3.97",
                    tooltip: "约 ¥3.97（720p ¥0.9936/秒 × 4 秒，按 Token 折算）",
                }}
            />,
        );
        expect(html).toContain("约 ¥3.97");
        expect(html).toContain('role="button"');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain("tabular-nums");
        expect(html).toContain("价格预估：约 ¥3.97（720p ¥0.9936/秒 × 4 秒，按 Token 折算）");
    });
});
