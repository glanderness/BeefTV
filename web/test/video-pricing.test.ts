import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ModelPicker } from "../src/components/model-picker";
import { applyFetchedChannelModelCatalog } from "../src/lib/channel-model-catalog";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { sanitizeVideoPriceQuote, videoPricingDisplayLines, type VideoPriceQuote } from "../src/lib/video-pricing";
import { defaultConfig, normalizeConfigSnapshot, type AiConfig } from "../src/stores/use-config-store";

function videoFixture(videoPricing?: VideoPriceQuote | null): AiConfig {
    const id = "minimax-h3-max-turbo";
    return {
        ...defaultConfig,
        channels: [
            {
                id: "beeftv",
                name: "BeefTV",
                apiFormat: "openai",
                baseUrl: "https://beeftv.app",
                apiKey: "",
                models: [id],
                modelProfiles: [
                    {
                        model: id,
                        displayName: "MiniMax H3 Max Turbo",
                        capability: "video",
                        protocol: "openai-videos",
                        capabilityConfig: defaultModelCapabilityConfig("openai-videos", id),
                        videoCapabilitiesVersion: "fixture-v1",
                        videoPricing,
                    },
                ],
            },
        ],
        models: [`beeftv::${id}`],
        videoModels: [`beeftv::${id}`],
    };
}

test("sanitizeVideoPriceQuote preserves trimmed server display_lines and caps to 20 lines", () => {
    const manyLines = Array.from({ length: 25 }, (_, i) => `  line-${i + 1}  `);
    const quote = sanitizeVideoPriceQuote({
        currency: "CNY",
        mode: "seconds",
        rates: { "768p": { output: 0.2441, reference_video: 0 } },
        display_lines: ["", "   ", ...manyLines],
    });
    expect(quote?.display_lines).toHaveLength(20);
    expect(quote?.display_lines?.[0]).toBe("line-1");
    expect(quote?.display_lines?.[19]).toBe("line-20");

    const withoutLines = sanitizeVideoPriceQuote({
        currency: "CNY",
        mode: "seconds",
        rates: { "768p": { output: 0.2441, reference_video: 0 } },
        display_lines: ["   ", ""],
    });
    expect(withoutLines?.display_lines).toBeUndefined();
});

test("videoPricingDisplayLines renders server display_lines verbatim when present", () => {
    const quote: VideoPriceQuote = {
        currency: "CNY",
        mode: "seconds",
        rates: { "768p": { output: 0.2441, reference_video: 0 } },
        display_lines: ["480p：¥0.1526 / 秒", "768p：¥0.2441 / 秒", "限时优惠按活动价结算"],
    };
    expect(videoPricingDisplayLines(quote)).toEqual([
        "480p：¥0.1526 / 秒",
        "768p：¥0.2441 / 秒",
        "限时优惠按活动价结算",
    ]);
});

test("videoPricingDisplayLines falls back cleanly when server display_lines is absent", () => {
    expect(videoPricingDisplayLines(undefined)).toEqual([]);
    expect(videoPricingDisplayLines(null)).toEqual([]);
    expect(
        videoPricingDisplayLines({
            currency: "CNY",
            mode: "seconds",
            rates: { "480p": { output: 0.1526, reference_video: 0 }, "768p": { output: 0.2441, reference_video: 0 } },
            reference_image: 0.1,
            free_reference_images: 5,
        }),
    ).toEqual(["480p：¥0.1526 / 秒", "768p：¥0.2441 / 秒", "前 5 张参考图免费，之后 ¥0.1 / 张"]);
    expect(
        videoPricingDisplayLines({
            currency: "CNY",
            mode: "tokens",
            rates: { "720p": { output: 46, reference_video: 28 } },
        }),
    ).toEqual(["720p：无视频输入 ¥46，含视频输入 ¥28 / 百万视频 Token"]);
});

test("ModelPicker shows server display_lines verbatim and hides price button when quote is absent", () => {
    const withServerLines = videoFixture({
        currency: "CNY",
        mode: "seconds",
        rates: { "768p": { output: 0.2441, reference_video: 0 } },
        display_lines: ["480p：¥0.1526 / 秒", "768p：¥0.2441 / 秒"],
    });
    const html = renderToStaticMarkup(createElement(ModelPicker, { config: withServerLines, value: withServerLines.models[0], capability: "video", onChange() {} }));
    expect(html).toContain("MiniMax H3 Max Turbo");
    expect(html).toContain('aria-label="视频参考单价"');
    expect(html).toContain("480p：¥0.1526 / 秒");
    expect(html).toContain("768p：¥0.2441 / 秒");

    const withoutQuote = videoFixture(null);
    const htmlNoPrice = renderToStaticMarkup(createElement(ModelPicker, { config: withoutQuote, value: withoutQuote.models[0], capability: "video", onChange() {} }));
    expect(htmlNoPrice).not.toContain('aria-label="视频参考单价"');
    expect(htmlNoPrice).not.toContain("价格暂不可用");
});

test("catalog refresh preserves server display_lines and clears stale videoPricing generically on BYOK channels", () => {
    const config = videoFixture({
        currency: "CNY",
        mode: "seconds",
        rates: { "768p": { output: 0.2441, reference_video: 0 } },
    });
    const channel = { ...config.channels[0]!, id: "byok", baseUrl: "https://provider.example" };
    const original = channel.modelProfiles![0]!;
    const updatedQuote: VideoPriceQuote = {
        currency: "CNY",
        mode: "seconds",
        rates: { "768p": { output: 0.3, reference_video: 0 } },
        display_lines: ["768p：¥0.3 / 秒（渠道价）"],
    };
    const refreshed = applyFetchedChannelModelCatalog(channel, {
        models: [original.model],
        catalog: [{ id: original.model, modelType: "video", videoPricing: updatedQuote }],
    });
    const reloaded = normalizeConfigSnapshot({ config: { ...defaultConfig, channels: [refreshed] } }).config;
    const profile = reloaded.channels[0]!.modelProfiles!.find((item) => item.model === original.model)!;
    expect(profile.videoPricing).toEqual(updatedQuote);
    expect(profile.capabilityConfig).toEqual(original.capabilityConfig);

    for (const catalog of [[{ id: original.model, modelType: "video" as const }], []]) {
        const cleared = applyFetchedChannelModelCatalog(refreshed, { models: catalog.map((item) => item.id), catalog });
        expect(cleared.modelProfiles!.find((item) => item.model === original.model)!.videoPricing).toBeNull();
    }
});

test("display_lines-only and future resolution (1440p) quotes are preserved without failing legacy rates whitelist", () => {
    const displayOnly = sanitizeVideoPriceQuote({
        display_lines: ["  1440p：¥0.88 / 秒  ", "", "按服务端实时档位结算"],
    });
    expect(displayOnly).toEqual({
        display_lines: ["1440p：¥0.88 / 秒", "按服务端实时档位结算"],
    });
    expect(videoPricingDisplayLines(displayOnly)).toEqual(["1440p：¥0.88 / 秒", "按服务端实时档位结算"]);

    const with1440p = {
        currency: "CNY" as const,
        mode: "seconds" as const,
        rates: { "1440p": { output: 0.88, reference_video: 0 } },
        display_lines: ["1440p：¥0.88 / 秒"],
    };
    expect(videoPricingDisplayLines(with1440p)).toEqual(["1440p：¥0.88 / 秒"]);
    expect(sanitizeVideoPriceQuote(with1440p)).toEqual({ display_lines: ["1440p：¥0.88 / 秒"] });
    // Legacy invalid rates WITHOUT display_lines are still rejected.
    expect(sanitizeVideoPriceQuote({ currency: "CNY", mode: "seconds", rates: { "1440p": { output: 0.88, reference_video: 0 } } })).toBeNull();

    const config = videoFixture(displayOnly);
    const reloaded = normalizeConfigSnapshot({ config }).config;
    expect(reloaded.channels[0]!.modelProfiles![0]!.videoPricing).toEqual(displayOnly);
    const html = renderToStaticMarkup(createElement(ModelPicker, { config: reloaded, value: reloaded.models[0], capability: "video", onChange() {} }));
    expect(html).toContain("1440p：¥0.88 / 秒");
    expect(html).toContain("按服务端实时档位结算");
});
