import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ModelPicker } from "../src/components/model-picker";
import { costEstimateLines, costLineForNode, costLineText, modelPriceLines, sanitizeCostEstimate, sanitizeModelPricing } from "../src/lib/generation-cost";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";

// 渠道协议决定能力归属（newapi 是视频协议），模型必须配上与自己能力相符的协议才能进选择器。
const PROTOCOLS = { text: "chat-completion", image: "openai-image", video: "newapi", audio: "openai-audio" } as const;

function configWith(profiles: Array<{ model: string; capability: "text" | "image" | "video" | "audio"; pricing?: unknown }>): AiConfig {
    const models = profiles.map((profile) => `beefapi::${profile.model}`);
    return {
        ...defaultConfig,
        channels: [{
            id: "beefapi",
            name: "BeefAPI",
            apiFormat: "openai",
            baseUrl: "https://beefapi.com",
            apiKey: "",
            models: profiles.map((profile) => profile.model),
            modelProfiles: profiles.map((profile) => {
                const protocol = PROTOCOLS[profile.capability];
                return {
                    model: profile.model,
                    capability: profile.capability,
                    protocol,
                    capabilityConfig: defaultModelCapabilityConfig(protocol, profile.model),
                    ...(profile.pricing !== undefined ? { pricing: profile.pricing } : {}),
                };
            }),
        }],
        models,
    };
}

const imagePricing = {
    currency: "CNY",
    kind: "image",
    mode: "per_request",
    image_price_table: {
        output: { high: { "1K": 0.35, "2K": 0.6 }, low: { "1K": 0.2 } },
        reference: 0.15,
        default_quality: "high",
        default_size: "1K",
        auto_quality: "high",
    },
    free_reference_images: 0,
    pricing_note: "内部备注不外泄",
    pricebook_id: "pb-1",
};

test("目录单价只翻译成用户看得懂的单价行", () => {
    expect(modelPriceLines(imagePricing)).toEqual(["高质量：1K ¥0.35 / 2K ¥0.6", "低质量：1K ¥0.2", "参考图 ¥0.15 / 张"]);
    expect(modelPriceLines({ currency: "CNY", kind: "video", per_second_cny: { "1080p": 0.43 }, reference_image_cny: 0.215, free_reference_images: 5 }))
        .toEqual(["1080p：¥0.43 / 秒", "前 5 张参考图免费，之后 ¥0.215 / 张"]);
    expect(modelPriceLines({ currency: "CNY", kind: "audio", input_cny: 350 })).toEqual(["约 ¥350 / 百万字"]);
    // 没有价格的行、非 CNY、非生成类模型都不能编出价格。
    expect(modelPriceLines({ currency: "CNY", kind: "image" })).toEqual([]);
    expect(modelPriceLines({ currency: "USD", kind: "image", per_request_cny: 1 })).toEqual([]);
    expect(modelPriceLines({ currency: "CNY", kind: "text", per_request_cny: 1 })).toEqual([]);
    expect(modelPriceLines(null)).toEqual([]);
});

test("目录单价收敛只保留展示字段", () => {
    const pricing = sanitizeModelPricing(imagePricing);
    expect(pricing?.image_price_table?.output).toEqual({ high: { "1K": 0.35, "2K": 0.6 }, low: { "1K": 0.2 } });
    expect(pricing?.free_reference_images).toBe(0);
    expect(Object.keys(pricing || {})).not.toContain("pricing_note");
    expect(Object.keys(pricing || {})).not.toContain("pricebook_id");
    expect(sanitizeModelPricing({ currency: "CNY", kind: "image" })).toBeNull();
});

test("后端费用估算形状不对时宁可不显示金额", () => {
    expect(sanitizeCostEstimate(null)).toBeNull();
    expect(sanitizeCostEstimate({ items: [], total: 0 })).toBeNull();
    expect(sanitizeCostEstimate({ text: "预计费用 ¥1", items: [{ kind: "image", amount: 1 }] })).toBeNull();
    const estimate = sanitizeCostEstimate({
        currency: "CNY", total: 2.58, known: true, unknownCount: 1,
        items: [
            { nodeId: "vid-1", title: "分镜1", kind: "video", model: "minimax-h3", amount: 2.58, basis: "1080p ¥0.43/秒 × 6秒" },
            { nodeId: "tts-1", kind: "audio", amount: null, basis: "缺少台词文本" },
        ],
        text: "预计费用 ¥2.58（已知部分），另有 1 项暂无价格",
    });
    expect(estimate?.total).toBe(2.58);
    expect(costLineText(costLineForNode(estimate, "vid-1")!)).toBe("预计费用 ¥2.58（1080p ¥0.43/秒 × 6秒）");
    // 算不出的项只说原因，不显示 0 元。
    expect(costLineText(costLineForNode(estimate, "tts-1")!)).toBe("缺少台词文本");
    expect(costLineForNode(estimate, "missing")).toBeNull();
});

test("确认框明细逐项列出金额与依据，同价项合并计数", () => {
    const estimate = sanitizeCostEstimate({
        currency: "CNY", total: 1.15, known: true, unknownCount: 0,
        items: [
            { kind: "image", amount: 0.65, basis: "1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张" },
            { kind: "image", amount: 0.5, basis: "1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 1 张" },
            { kind: "image", amount: 0.65, basis: "1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张" },
        ],
        text: "预计费用 ¥1.8",
    });
    expect(costEstimateLines(estimate)).toEqual([
        "预计费用 ¥1.8",
        "¥0.65（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 2 张） × 2 项",
        "¥0.5（1K 低质量 ¥0.35 × 1 张 + 参考图 ¥0.15 × 1 张）",
    ]);

    // 单个节点也要有自己的一行：算不出的项逐项说明原因，不是只给一句通用提示。
    const single = sanitizeCostEstimate({
        currency: "CNY", total: 0, known: false, unknownCount: 1,
        items: [{ nodeId: "v1", title: "镜头1 · 视频", kind: "video", amount: null, basis: "分辨率没有对应报价" }],
        text: "暂无可用价格，按所选渠道实际标准计费",
    });
    expect(costEstimateLines(single)).toEqual(["暂无可用价格，按所选渠道实际标准计费", "镜头1 · 视频 · 分辨率没有对应报价"]);
    expect(costEstimateLines(null)).toEqual([]);
});

test("模型选择器对图片和视频模型显示目录单价，文本模型不显示", () => {
    const config = configWith([
        { model: "gpt-image-2", capability: "image", pricing: imagePricing },
        { model: "minimax-h3", capability: "video", pricing: { currency: "CNY", kind: "video", per_second_cny: { "1080p": 0.43 } } },
        { model: "text-model", capability: "text", pricing: null },
    ]);
    const imageHtml = renderToStaticMarkup(createElement(ModelPicker, { config, value: "beefapi::gpt-image-2", capability: "image", onChange() {} }));
    expect(imageHtml).toContain('aria-label="参考单价"');
    expect(imageHtml).toContain("高质量：1K ¥0.35 / 2K ¥0.6");
    const videoHtml = renderToStaticMarkup(createElement(ModelPicker, { config, value: "beefapi::minimax-h3", capability: "video", onChange() {} }));
    expect(videoHtml).toContain("1080p：¥0.43 / 秒");
    // 刷新后价格被清空的文本模型不该出现价格入口（目录里也没有文字模型的单价）。
    const textHtml = renderToStaticMarkup(createElement(ModelPicker, { config, value: "beefapi::text-model", capability: "text", onChange() {} }));
    expect(textHtml).not.toContain('aria-label="参考单价"');
});

test("目录刷新没带回价格的模型照实说价格暂不可用", () => {
    const config = configWith([{ model: "gpt-image-2", capability: "image", pricing: null }]);
    const html = renderToStaticMarkup(createElement(ModelPicker, { config, value: "beefapi::gpt-image-2", capability: "image", onChange() {} }));
    expect(html).toContain("价格暂不可用");
    expect(html).not.toContain("¥0");
});
