export type VideoPriceQuote = {
    currency: "CNY";
    mode: "tokens";
    rates: Record<string, { output: number; reference_video: number }>;
};

export function seedancePortraitModel(value: string): string {
    const id = value.split("::").at(-1) || "";
    return id === "seedance-2.0-portrait" || id === "seedance-2.5-portrait" ? id : "";
}

export function seedancePortraitLabel(value: string): string {
    const id = seedancePortraitModel(value);
    return id ? `Seedance ${id.includes("2.5") ? "2.5" : "2.0"}-真人` : "";
}

export function portraitTaskRetryError(inputJson?: string, model?: string): string {
    let input: { videoParameters?: { model?: string }; config?: { model?: string } } = {};
    try { input = inputJson ? JSON.parse(inputJson) || {} : {}; } catch { /* The task model can still identify the tier. */ }
    const portrait = [model, input.videoParameters?.model, input.config?.model].some((value) => typeof value === "string" && seedancePortraitModel(value));
    // Sanitized task detail contains no unique provider or account identity.
    // A current channel with the same bare model ID cannot establish its price.
    return portrait ? "请回到原画布重新选择真人素材版，确认当前价格后重新生成" : "";
}

export function sanitizeVideoPriceQuote(value: unknown): VideoPriceQuote | null {
    const quote = value as VideoPriceQuote | undefined;
    if (!quote || quote.currency !== "CNY" || quote.mode !== "tokens" || !quote.rates || typeof quote.rates !== "object" || !Object.keys(quote.rates).length) return null;
    const entries = Object.entries(quote.rates);
    if (!entries.every(([resolution, rate]) => ["480p", "720p", "1080p", "4k"].includes(resolution) && Number.isFinite(rate?.output) && rate.output > 0 && Number.isFinite(rate?.reference_video) && rate.reference_video > 0)) return null;
    return { currency: "CNY", mode: "tokens", rates: Object.fromEntries(entries.map(([resolution, rate]) => [resolution, { output: rate.output, reference_video: rate.reference_video }])) };
}

export function portraitPriceLines(value: unknown): string[] {
    const quote = sanitizeVideoPriceQuote(value);
    if (!quote) return [];
    return Object.entries(quote.rates)
        .map(([resolution, rate]) => `${resolution}：无视频输入 ¥${rate.output}，含视频输入 ¥${rate.reference_video} / 百万视频 Token`);
}
