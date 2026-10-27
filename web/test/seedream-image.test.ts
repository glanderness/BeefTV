import { describe, expect, test } from "bun:test";
import { seedreamFamily, seedreamImageCapability } from "../src/lib/seedream-image";
import { backendProviderConfig } from "../src/services/api/generation-task";
import { defaultConfig } from "../src/stores/use-config-store";

describe("Seedream model capabilities", () => {
    test("domestic doubao- models keep their own family", () => {
        expect(seedreamFamily("doubao-seedream-5-0-pro-260628")).toBe("pro");
        expect(seedreamFamily("doubao-seedream-5-0-flash-260915")).toBe("flash");
        expect(seedreamFamily("doubao-seedream-5-0-260128")).toBe("lite");
        expect(seedreamFamily("doubao-seedream-4-5-251128")).toBe("4.5");
        expect(seedreamFamily("doubao-seedream-4-0-250828")).toBe("4.0");
        expect(seedreamFamily("channel::doubao-seedream-5-0-pro-260628")).toBe("pro");
        expect(seedreamFamily("doubao-seedream-test")).toBe("");
        const domestic = seedreamImageCapability("doubao-seedream-5-0-pro-260628")!;
        expect(domestic.size.values).toEqual(["1K", "1.5K", "2K"]);
        expect(domestic.references.maxImages).toBe(10);
        expect(domestic.transparentBackground.supported).toBe(true);
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
    test("task serialization preserves the chosen Seedream operation", () => {
        const config = { ...defaultConfig, model: "dola-seedream-5-0-pro-260628", seedreamMode: "layers", seedreamMaxImages: "1", seedreamOutputFormat: "png", seedreamOptimize: "fast", seedreamWatermark: "false" };
        const wire = backendProviderConfig(config);
        expect(wire.seedreamMode).toBe("layers");
        expect(wire.seedreamOutputFormat).toBe("png");
        expect(wire.seedreamWatermark).toBe("false");
    });
});
