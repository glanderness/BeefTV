export type VideoPriceQuote = {
    currency?: "CNY";
    mode?: "tokens" | "seconds";
    rates?: Record<string, { output: number; reference_video: number }>;
    reference_image?: number;
    free_reference_images?: number;
    reference_invoice?: { usd_cny: number; reserve_usd: number };
    display_lines?: string[];
};

const MAX_DISPLAY_LINES = 20;
const LEGACY_RATE_RESOLUTIONS = new Set(["480p", "720p", "768p", "1080p", "2k", "4k"]);

function sanitizeDisplayLines(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const lines = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, MAX_DISPLAY_LINES);
    return lines.length ? lines : undefined;
}

function sanitizeLegacyStructuredQuote(quote: VideoPriceQuote): VideoPriceQuote | null {
    if (quote.currency !== "CNY" || !quote.mode || !["tokens", "seconds"].includes(quote.mode) || !quote.rates || typeof quote.rates !== "object" || !Object.keys(quote.rates).length) return null;
    const entries = Object.entries(quote.rates);
    if (!entries.every(([resolution, rate]) => LEGACY_RATE_RESOLUTIONS.has(resolution) && Number.isFinite(rate?.output) && rate.output > 0 && Number.isFinite(rate?.reference_video) && (quote.mode === "seconds" ? rate.reference_video === 0 : rate.reference_video > 0))) return null;
    const referencePrice = quote.reference_image !== undefined || quote.free_reference_images !== undefined;
    if (referencePrice && (quote.mode !== "seconds" || !Number.isFinite(quote.reference_image) || quote.reference_image! < 0 || !Number.isInteger(quote.free_reference_images) || quote.free_reference_images! < 0 || quote.free_reference_images! > 12)) return null;
    const invoice = quote.reference_invoice;
    if (invoice && (quote.mode !== "seconds" || !Number.isFinite(invoice.usd_cny) || invoice.usd_cny < 5 || invoice.usd_cny > 10 || !Number.isFinite(invoice.reserve_usd) || invoice.reserve_usd <= 0 || invoice.reserve_usd > 100)) return null;
    return {
        currency: "CNY",
        mode: quote.mode,
        rates: Object.fromEntries(entries.map(([resolution, rate]) => [resolution, { output: rate.output, reference_video: rate.reference_video }])),
        ...(referencePrice ? { reference_image: quote.reference_image, free_reference_images: quote.free_reference_images } : {}),
        ...(invoice ? { reference_invoice: { usd_cny: invoice.usd_cny, reserve_usd: invoice.reserve_usd } } : {}),
    };
}

export function sanitizeVideoPriceQuote(value: unknown): VideoPriceQuote | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const quote = value as VideoPriceQuote;
    const displayLines = sanitizeDisplayLines(quote.display_lines);
    const structured = sanitizeLegacyStructuredQuote(quote);
    if (structured) {
        return {
            ...structured,
            ...(displayLines ? { display_lines: displayLines } : {}),
        };
    }
    if (displayLines) {
        return { display_lines: displayLines };
    }
    return null;
}

export function videoPricingDisplayLines(value: unknown): string[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const directLines = sanitizeDisplayLines((value as VideoPriceQuote).display_lines);
    if (directLines) return directLines;
    const quote = sanitizeLegacyStructuredQuote(value as VideoPriceQuote);
    if (!quote || !quote.rates || !quote.mode) return [];
    if (quote.mode === "seconds") {
        return [
            ...Object.entries(quote.rates).map(([resolution, rate]) => `${resolution}：${quote.reference_invoice ? "普通生成 " : ""}¥${Number(rate.output.toFixed(4))} / 秒`),
            ...(quote.reference_image ? [`前 ${quote.free_reference_images} 张参考图免费，之后 ¥${Number(quote.reference_image.toFixed(4))} / 张`] : []),
            ...(quote.reference_invoice ? [`参考生成：实际美元账单 × ${quote.reference_invoice.usd_cny} × 1.5；预留 ¥${Number((quote.reference_invoice.reserve_usd * quote.reference_invoice.usd_cny * 1.5).toFixed(4))}，出账后结算`] : []),
        ];
    }
    return Object.entries(quote.rates).map(([resolution, rate]) => `${resolution}：无视频输入 ¥${rate.output}，含视频输入 ¥${rate.reference_video} / 百万视频 Token`);
}
