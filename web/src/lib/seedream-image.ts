import type { ImageCapabilityConfig } from "./model-capabilities";

export function seedreamFamily(model = "") {
    // 国内渠道带 doubao- 前缀、国际渠道带 dola- 前缀；Pro / Flash 必须先于通用 5.0 匹配，
    // 否则国内 Pro / Flash 会被当成 Lite，能力与后端判定不一致。
    const name = (model.split("::").pop() || "").trim().toLowerCase().replace(/^doubao-/, "");
    if (/^(dola-)?seedream-5-0-pro-/.test(name)) return "pro";
    if (/^(dola-)?seedream-5-0-flash-/.test(name)) return "flash";
    if (/^seedream-5-0-/.test(name)) return "lite";
    if (/^seedream-4-5-/.test(name)) return "4.5";
    if (/^seedream-4-0-/.test(name)) return "4.0";
    return "";
}

export function seedreamImageCapability(model: string): ImageCapabilityConfig | undefined {
    const family = seedreamFamily(model);
    if (!family) return;
    const modern = family === "pro" || family === "flash";
    return {
        references: { promptMaxChars: 32000, maxImages: modern ? 10 : 14, maxImageBytes: 30 * 1024 * 1024, maskSupported: false },
        size: { parameter: "size", values: modern ? ["1K", "1.5K", "2K"] : family === "lite" ? ["2K", "3K", "4K"] : family === "4.0" ? ["1K", "2K", "4K"] : ["2K", "4K"], default: "2K", allowCustom: true },
        quality: { supported: false, values: [], default: "auto" },
        transparentBackground: { supported: modern, default: false },
        responseFormat: { supported: true }, outputFormat: { supported: modern || family === "lite" }, maxOutputs: 15,
    };
}
