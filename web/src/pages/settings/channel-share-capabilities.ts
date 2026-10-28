import type { ModelCapabilityConfig } from "@/lib/model-capabilities";

type Shape = "string" | "number" | "boolean" | { list: Shape } | { fields: Record<string, Shape>; optional?: string[] } | { choices: readonly string[] };
const strings: Shape = { list: "string" };
const numbers: Shape = { list: "number" };
const toggle: Shape = { fields: { supported: "boolean", default: "boolean" } };

// Explicit shapes keep credentials and arbitrary extension data out of nested profiles too.
const capabilityShape: Shape = {
    fields: {
        version: "number",
        text: { fields: {
            streaming: "boolean", thinking: "boolean",
            references: { fields: { promptMaxChars: "number", maxImages: "number", maxImageBytes: "number", maxVideos: "number", maxVideoBytes: "number" } },
        }, optional: ["streaming", "thinking"] },
        image: { fields: {
            references: { fields: { promptMaxChars: "number", maxImages: "number", maxImageBytes: "number", maskSupported: "boolean" } },
            size: { fields: {
                parameter: { choices: ["none", "size", "aspect_ratio"] }, values: strings, default: "string", allowCustom: "boolean",
                presets: { list: { fields: { size: "string", tier: { choices: ["1k", "2k", "4k"] }, ratio: "string", width: "number", height: "number" } } },
            }, optional: ["presets"] },
            quality: { fields: { supported: "boolean", values: strings, default: "string" } },
            transparentBackground: toggle,
            responseFormat: { fields: { supported: "boolean", value: { choices: ["b64_json", "url"] } }, optional: ["value"] },
            outputFormat: { fields: { supported: "boolean" } },
            maxOutputs: "number", fixedOutputs: "number", generationOutputs: numbers,
        }, optional: ["fixedOutputs", "generationOutputs"] },
        video: { fields: {
            references: { fields: {
                promptMaxChars: "number", promptMaxUtf16Units: "number", minImages: "number", maxImages: "number", maxImageBytes: "number",
                minImageWidth: "number", maxImageWidth: "number", minImageHeight: "number", maxImageHeight: "number",
                minImageAspect: "number", maxImageAspect: "number", minImagePixels: "number", maxImagePixels: "number",
                maxVideos: "number", maxVideoBytes: "number", maxVideoDurationSeconds: "number", minVideoDurationSeconds: "number", maxVideoTotalDurationSeconds: "number",
                minVideoWidth: "number", maxVideoWidth: "number", minVideoHeight: "number", maxVideoHeight: "number",
                minVideoAspect: "number", maxVideoAspect: "number", minVideoPixels: "number", maxVideoPixels: "number",
                maxAudios: "number", maxAudioBytes: "number", maxAudioDurationSeconds: "number", minAudioDurationSeconds: "number", maxAudioTotalDurationSeconds: "number",
            }, optional: [
                "promptMaxUtf16Units", "minImageWidth", "maxImageWidth", "minImageHeight", "maxImageHeight", "minImageAspect", "maxImageAspect", "minImagePixels", "maxImagePixels",
                "minVideoDurationSeconds", "maxVideoTotalDurationSeconds", "minVideoWidth", "maxVideoWidth", "minVideoHeight", "maxVideoHeight", "minVideoAspect", "maxVideoAspect", "minVideoPixels", "maxVideoPixels",
                "minAudioDurationSeconds", "maxAudioTotalDurationSeconds",
            ] },
            duration: { fields: {
                selection: { choices: ["range", "enum"] }, default: "number", continuous: "boolean", fractionalMin: "number", min: "number", max: "number", step: "number", values: numbers,
            }, optional: ["continuous", "fractionalMin", "min", "max", "step", "values"] },
            durationSupported: "boolean", ratios: strings, defaultRatio: "string", resolutions: strings, defaultResolution: "string",
            generateAudio: toggle, watermark: toggle, operations: strings, defaultOperation: "string",
        }, optional: ["durationSupported"] },
    }, optional: ["text", "image", "video"],
};

function readShape(value: unknown, shape: Shape, path: string): unknown {
    const invalid = () => new Error(`渠道配置字段格式不正确：${path}`);
    if (typeof shape === "string") {
        if (typeof value !== shape || (typeof value === "number" && !Number.isFinite(value))) throw invalid();
        return value;
    }
    if ("choices" in shape) {
        if (typeof value !== "string" || !shape.choices.includes(value)) throw invalid();
        return value;
    }
    if ("list" in shape) {
        if (!Array.isArray(value)) throw invalid();
        return value.map((item, index) => readShape(item, shape.list, `${path}[${index}]`));
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(shape.fields)) {
        if (input[key] === undefined && shape.optional?.includes(key)) continue;
        output[key] = readShape(input[key], child, `${path}.${key}`);
    }
    return output;
}

export function readSharedCapabilityConfig(value: unknown, path: string): ModelCapabilityConfig | undefined {
    if (value === undefined) return undefined;
    return readShape(value, capabilityShape, path) as ModelCapabilityConfig;
}
