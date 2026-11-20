import { describe, expect, test } from "bun:test";
import { seedreamImageCapability, seedreamSizePresets } from "../src/lib/seedream-image";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { defaultConfig } from "../src/stores/use-config-store";

describe("Seedream model capabilities", () => {
    test("5.5 exposes 1K/1.5K/2K, up to 10 references, transparent background, and no sequential group mode", () => {
        for (const model of ["beeftv::dola-seedream-5-5-261028", "doubao-seedream-5-5-261028", "seedream-5-5-261028"]) {
            const p = seedreamImageCapability(model)!;
            expect(p.size.values).toEqual(["1K", "1.5K", "2K"]);
            expect(p.references.maxImages).toBe(10);
            expect(p.references.maskSupported).toBe(false);
            expect(p.transparentBackground.supported).toBe(true);
            expect(p.sequentialGeneration?.supported).toBe(false);
            expect(p.outputFormat.supported).toBe(true);
        }
    });
    test("Pro and Flash expose their actual sizes and alpha editing", () => {
        const p = seedreamImageCapability("channel::dola-seedream-5-0-pro-260628")!;
        expect(p.size.values).toEqual(["1K", "1.5K", "2K"]);
        expect(p.references.maxImages).toBe(10);
        expect(p.references.maskSupported).toBe(false);
        expect(p.transparentBackground.supported).toBe(true);
        expect(p.quality.supported).toBe(false);
    });
    test("Lite supports 4K and fourteen references", () => {
        const p = seedreamImageCapability("seedream-5-0-260128")!;
        expect(p.size.values).toContain("4K");
        expect(p.references.maxImages).toBe(14);
        expect(p.transparentBackground.supported).toBe(false);
    });
    test("国内 doubao 前缀的 Pro / Flash 不会被当成 Lite", () => {
        const pro = seedreamImageCapability("beeftv::doubao-seedream-5-0-pro-260628")!;
        expect(pro.size.values).toEqual(["1K", "1.5K", "2K"]);
        expect(pro.references.maxImages).toBe(10);
        expect(pro.transparentBackground.supported).toBe(true);
        expect(pro.outputFormat.supported).toBe(true);
        const flash = seedreamImageCapability("doubao-seedream-5-0-flash-260915")!;
        expect(flash.size.values).toEqual(["1K", "1.5K", "2K"]);
        const lite = seedreamImageCapability("doubao-seedream-5-0-260128")!;
        expect(lite.size.values).toEqual(["2K", "3K", "4K"]);
        expect(lite.transparentBackground.supported).toBe(false);
    });
    test("task serialization preserves the chosen Seedream operation", () => {
        const config = { ...defaultConfig, model: "dola-seedream-5-0-pro-260628", seedreamMode: "layers", seedreamMaxImages: "1", seedreamOutputFormat: "png", seedreamOptimize: "fast", seedreamWatermark: "false" };
        const wire = backendProviderConfig(config);
        expect(wire.seedreamMode).toBe("layers");
        expect(wire.seedreamOutputFormat).toBe("png");
        expect(wire.seedreamWatermark).toBe("false");
        expect(backendProviderConfig({ ...defaultConfig, model: "dola-seedream-5-0-pro-260628", seedreamWatermark: undefined }).seedreamWatermark).toBe("false");
        expect(backendProviderConfig({ ...defaultConfig, model: "dola-seedream-5-0-pro-260628", seedreamWatermark: "true" }).seedreamWatermark).toBe("true");
        expect(backendProviderConfig({ ...defaultConfig, model: "gpt-image-2" }).seedreamWatermark).toBeUndefined();
        expect(backendProviderConfig({ ...defaultConfig, model: "gpt-image-2", seedreamWatermark: "true" }).seedreamWatermark).toBeUndefined();
    });
    test("Seedream size presets produce even dimensions within each family's pixel range", () => {
        const families = [
            { tiers: ["1K", "1.5K", "2K"], min: 921_600, max: 4_624_220 },
            { tiers: ["2K", "3K", "4K"], min: 3_686_400, max: 16_777_216 },
            { tiers: ["1K", "2K", "4K"], min: 921_600, max: 16_777_216 },
        ];
        for (const family of families) {
            for (const preset of seedreamSizePresets(family.tiers)) {
                expect(preset.width % 2).toBe(0);
                expect(preset.height % 2).toBe(0);
                expect(preset.width * preset.height).toBeGreaterThanOrEqual(family.min);
                expect(preset.width * preset.height).toBeLessThanOrEqual(family.max);
            }
        }
    });
});
