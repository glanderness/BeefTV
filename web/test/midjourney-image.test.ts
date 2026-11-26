import { describe, expect, test } from "bun:test";

import { beefTVImageContract } from "@/lib/beeftv-image-contracts";
import { canvasGenerationRequestFingerprint } from "@/lib/canvas/canvas-generation-submission";
import { canvasNodeCostTarget } from "@/lib/generation-cost-estimate";
import {
    composeMidjourneyPrompt,
    isMidjourneyImageModel,
    midjourneyCustomCount,
    midjourneySettingsSummary,
    parseMidjourneyPrompt,
    resolveMidjourneyEffectiveSize,
    stripUnsupportedMidjourneyFlags,
    syncMidjourneySizeFromPromptChange,
} from "@/lib/midjourney-image";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

const mjPresets = beefTVImageContract("midjourney-v8.2")?.presets || [];

function makeMidjourneyConfig(overrides: Partial<AiConfig> = {}): AiConfig {
    return {
        ...defaultConfig,
        model: "managed::midjourney-v8.2",
        imageModel: "managed::midjourney-v8.2",
        size: "1024x1024",
        count: "4",
        channels: [
            {
                id: "managed",
                name: "BeefTV 官方算力",
                baseUrl: "https://enterprise.beefapi.com/v1",
                apiKey: "test-key",
                apiFormat: "openai",
                interfaceType: "openai-image",
                models: ["midjourney-v8.2"],
            },
        ],
        ...overrides,
    };
}

describe("midjourney-image", () => {
    test("identifies midjourney image models with or without channel prefix", () => {
        expect(isMidjourneyImageModel("midjourney-v8.2")).toBe(true);
        expect(isMidjourneyImageModel("managed::midjourney-v8.2")).toBe(true);
        expect(isMidjourneyImageModel("gpt-image-2")).toBe(false);
        expect(isMidjourneyImageModel("dola-seedream-5-5-261028")).toBe(false);
    });

    test("exposes all 16 1K and 2K presets including 21:9 in fallback contract", () => {
        expect(mjPresets).toHaveLength(16);
        expect(mjPresets.some((p) => p.tier === "1k" && p.ratio === "21:9" && p.size === "1680x720")).toBe(true);
        expect(mjPresets.some((p) => p.tier === "2k" && p.ratio === "16:9" && p.size === "2944x1648")).toBe(true);
        expect(mjPresets.some((p) => p.tier === "2k" && p.ratio === "21:9" && p.size === "3360x1440")).toBe(true);
    });

    test("parses native flags including unicode/em-dash variants and detects unsupported flags", () => {
        const parsed = parseMidjourneyPrompt(
            "cinematic neon rain \u2014ar 16:9 \u2014hd --style raw --q 2 --s 500 --c 20 --sref 4102558034 --p m7284920 --v 6.1 --fast --repeat 4 --no blurry, text",
        );
        expect(parsed.ratio).toBe("16:9");
        expect(parsed.hd).toBe(true);
        expect(parsed.raw).toBe(true);
        expect(parsed.quality).toBe("2");
        expect(parsed.stylize).toBe("500");
        expect(parsed.chaos).toBe("20");
        expect(parsed.sref).toBe(true);
        expect(parsed.personalize).toBe(true);
        expect(parsed.no).toBe("blurry, text");
        expect(parsed.unsupportedFlags).toEqual(["--v 6.1", "--repeat 4", "--fast"]);
    });

    test("strips unsupported community flags without damaging valid MJ parameters", () => {
        const cleaned = stripUnsupportedMidjourneyFlags(
            "minimalist ceramic teapot --ar 16:9 --hd --v 6.1 --fast --repeat 3 --s 350 --p m7284920",
        );
        expect(cleaned).toBe("minimalist ceramic teapot --ar 16:9 --hd --s 350 --p m7284920");
    });

    test("resolves and syncs effective 1K/2K preset size from prompt --ar and --hd changes", () => {
        expect(resolveMidjourneyEffectiveSize("cyberpunk alley --ar 16:9 --hd", "1024x1024", mjPresets)).toBe("2944x1648");
        expect(resolveMidjourneyEffectiveSize("cyberpunk alley --ar 21:9", "1024x1024", mjPresets)).toBe("1680x720");
        expect(resolveMidjourneyEffectiveSize("cyberpunk alley --hd", "1456x816", mjPresets)).toBe("2944x1648");

        expect(syncMidjourneySizeFromPromptChange("cyberpunk alley", "cyberpunk alley --ar 16:9 --hd", "1024x1024", mjPresets)).toBe("2944x1648");
        expect(syncMidjourneySizeFromPromptChange("cyberpunk alley --ar 16:9 --hd", "neon cyberpunk alley --ar 16:9 --hd", "2944x1648", mjPresets)).toBeUndefined();
        expect(syncMidjourneySizeFromPromptChange("cyberpunk alley --ar 16:9 --hd", "cyberpunk alley --ar 16:9", "2944x1648", mjPresets)).toBe("1456x816");
    });

    test("composes non-default MJ UI settings without duplicating prompt flags and places --no last", () => {
        const composed = composeMidjourneyPrompt("studio macro teapot", {
            mjRaw: "true",
            mjQuality: "2",
            mjStylize: "350",
            mjChaos: "15",
            mjNo: "watermark, text",
            mjStyleCode: "4102558034",
        });
        expect(composed).toBe("studio macro teapot --raw --q 2 --s 350 --c 15 --sref 4102558034 --no watermark, text");

        // Personalization code m... maps to --p; prompt-provided --s and --raw take precedence.
        const withUserOverrides = composeMidjourneyPrompt("studio macro teapot --raw --s 800", {
            mjRaw: "true",
            mjQuality: "4",
            mjStylize: "350",
            mjChaos: "0",
            mjStyleCode: "m7284920",
        });
        expect(withUserOverrides).toBe("studio macro teapot --raw --s 800 --q 4 --p m7284920");

        // All defaults leave prompt untouched.
        expect(composeMidjourneyPrompt("studio macro teapot", {
            mjRaw: "false",
            mjQuality: "1",
            mjStylize: "100",
            mjChaos: "0",
        })).toBe("studio macro teapot");
    });

    test("summarizes customized MJ settings cleanly", () => {
        expect(midjourneyCustomCount({ mjRaw: "false", mjQuality: "1", mjStylize: "100", mjChaos: "0" })).toBe(0);
        expect(midjourneySettingsSummary({ mjRaw: "true", mjQuality: "2", mjStylize: "400", mjChaos: "20", mjNo: "blur", mjStyleCode: "m1234" }))
            .toEqual(["Raw", "Q2", "S400", "C20", "排除词", "风格码"]);
    });

    test("upgrades live cost estimate target to 2K when prompt includes --hd", () => {
        const config = makeMidjourneyConfig({ size: "1024x1024", count: "4" });
        const target = canvasNodeCostTarget({
            mode: "image",
            config,
            referenceImages: 0,
            referenceVideos: 0,
            prompt: "dramatic skyline --ar 16:9 --hd",
        });
        expect(target?.parameters.size).toBe("2944x1648");
        expect(target?.parameters.count).toBe("4");
    });

    test("injects composed MJ flags into backend task input.prompt while keeping display prompt clean", async () => {
        const config = makeMidjourneyConfig({
            mjRaw: "true",
            mjQuality: "2",
            mjStylize: "300",
            mjNo: "blurry",
        });
        const task = await prepareBackendGenerationTask({
            mode: "image",
            prompt: "minimalist glass vase",
            config,
        });
        expect(task.prompt).toBe("minimalist glass vase");
        expect(task.input.prompt).toBe("minimalist glass vase --raw --q 2 --s 300 --no blurry");
    });

    test("handles flag boundaries, URLs, prose em-dashes, multiline --no, and combined style codes safely", () => {
        // Standalone --niji before --ar must not eat --ar.
        expect(stripUnsupportedMidjourneyFlags("anime girl --niji --ar 16:9 --hd")).toBe("anime girl --ar 16:9 --hd");

        // URLs containing --fast or --v=2 and prose with em-dash must not false-match.
        const safePrompt = "cityscape\u2014fast motion --sref https://cdn.example.com/style--fast?x=--v=2";
        expect(parseMidjourneyPrompt(safePrompt).unsupportedFlags).toEqual([]);
        expect(stripUnsupportedMidjourneyFlags(safePrompt)).toBe(safePrompt);

        // Multiline --no must be detected so composeMidjourneyPrompt does not append a duplicate --no.
        const multiNo = "portrait --no blurry\nwatermark";
        expect(parseMidjourneyPrompt(multiNo).no).toBe("blurry\nwatermark");
        expect(composeMidjourneyPrompt(multiNo, { mjNo: "extra" })).toBe(multiNo);

        // Combined --sref + --p in mjStyleCode must only append whichever flag is missing, normalizing em-dash.
        expect(composeMidjourneyPrompt("cyberpunk --sref 111", { mjStyleCode: "\u2014sref 222 \u2014p m9999" })).toBe("cyberpunk --sref 111 --p m9999");
    });

    test("changing MJ UI settings changes canvasGenerationRequestFingerprint", () => {
        const emptyContext = {
            referenceImages: [],
            referenceVideos: [],
            referenceAudios: [],
            characterReferences: [],
            resolvedCharacterVersions: [],
            resolvedCharacterVoices: [],
        };
        const baseConfig = makeMidjourneyConfig({ mjRaw: "false", mjStylize: "100" });
        const rawConfig = makeMidjourneyConfig({ mjRaw: "true", mjStylize: "500" });
        const fp1 = canvasGenerationRequestFingerprint({
            nodeId: "node-1",
            mode: "image",
            prompt: composeMidjourneyPrompt("a red cube", baseConfig),
            model: baseConfig.model,
            options: { size: "1024x1024", count: "4" },
            context: emptyContext,
        });
        const fp2 = canvasGenerationRequestFingerprint({
            nodeId: "node-1",
            mode: "image",
            prompt: composeMidjourneyPrompt("a red cube", rawConfig),
            model: rawConfig.model,
            options: { size: "1024x1024", count: "4" },
            context: emptyContext,
        });
        expect(fp1).not.toBe(fp2);
    });
});
