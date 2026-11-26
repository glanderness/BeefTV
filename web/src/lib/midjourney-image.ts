export type MidjourneySizePreset = {
    tier: string;
    ratio: string;
    size: string;
};

export type MidjourneyImageOptions = {
    mjRaw?: string;
    mjQuality?: string;
    mjStylize?: string;
    mjChaos?: string;
    mjNo?: string;
    mjStyleCode?: string;
};

export type MidjourneySettingKey = keyof MidjourneyImageOptions;

export const MIDJOURNEY_SETTING_KEYS: readonly MidjourneySettingKey[] = [
    "mjRaw",
    "mjQuality",
    "mjStylize",
    "mjChaos",
    "mjNo",
    "mjStyleCode",
] as const;

export const MIDJOURNEY_DEFAULTS = {
    raw: false,
    quality: "1",
    stylize: 100,
    chaos: 0,
} as const;

export type ParsedMidjourneyPrompt = {
    ratio?: string;
    hd: boolean;
    raw: boolean;
    quality?: string;
    stylize?: string;
    chaos?: string;
    no?: string;
    sref: boolean;
    personalize: boolean;
    unsupportedFlags: string[];
};

const DASH_CLASS = "[-\\u2010-\\u2015\\u2212\\uff0d]";
const FLAG_PREFIX = `(?:${DASH_CLASS}{2}|\\u2014)`;
const SPACE_CLASS = "[\\s\\u000B\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\u0085]";
const NON_SPACE = "[^\\s\\u000B\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\u0085]";
const LEADING_BOUNDARY = `(?<=^|${SPACE_CLASS})`;

const AR_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:ar|aspect)(?:${SPACE_CLASS}+|=)([1-9]\\d*:[1-9]\\d*)(?=${SPACE_CLASS}|$)`, "gi");
const HD_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}hd(?=${SPACE_CLASS}|$)`, "i");
const HD_ASSIGN_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}hd=${NON_SPACE}*`, "gi");
const RAW_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:raw|style(?:${SPACE_CLASS}+|=)raw)(?=${SPACE_CLASS}|$)`, "i");
const QUALITY_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:q|quality)(?:=${NON_SPACE}+|${SPACE_CLASS}+(?!${FLAG_PREFIX})(${NON_SPACE}+))`, "i");
const STYLIZE_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:s|stylize)(?:${SPACE_CLASS}+|=)(\\d+)(?=${SPACE_CLASS}|$)`, "i");
const CHAOS_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:c|chaos)(?:${SPACE_CLASS}+|=)(\\d+)(?=${SPACE_CLASS}|$)`, "i");
const NO_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}no(?:${SPACE_CLASS}+|=)([\\s\\S]+?)(?=${SPACE_CLASS}+${FLAG_PREFIX}|$)`, "i");
const SREF_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}sref(?:${SPACE_CLASS}+|=)`, "i");
const PERSONALIZE_FLAG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}p(?=${SPACE_CLASS}|=|$)`, "i");

// Flags with an optional non-flag value argument vs standalone flags unsupported on MJ v8.2 gateway.
const UNSUPPORTED_WITH_ARG_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:version|v|niji|repeat|r)(?:=${NON_SPACE}*|${SPACE_CLASS}+(?!${FLAG_PREFIX})${NON_SPACE}+)?(?=${SPACE_CLASS}|$)`, "gi");
const UNSUPPORTED_STANDALONE_RE = new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}(?:turbo|fast|relax)(?:=${NON_SPACE}*)?(?=${SPACE_CLASS}|$)`, "gi");

export function isMidjourneyImageModel(model = "") {
    const bare = (model.split("::").pop() || "").trim().toLowerCase();
    return bare === "midjourney-v8.2" || bare.startsWith("midjourney-") || bare === "midjourney";
}

function normalizeFlagToken(raw: string) {
    return raw
        .trim()
        .replace(new RegExp(`^${FLAG_PREFIX}`), "--")
        .replace(/\s+/g, " ");
}

export function parseMidjourneyPrompt(prompt = ""): ParsedMidjourneyPrompt {
    const text = String(prompt || "");
    let ratio: string | undefined;
    for (const match of text.matchAll(AR_FLAG_RE)) {
        if (match[1]) ratio = match[1];
    }

    const unsupported: string[] = [];
    const collect = (re: RegExp) => {
        for (const match of text.matchAll(re)) {
            const label = normalizeFlagToken(match[0]);
            if (label && !unsupported.includes(label)) unsupported.push(label);
        }
    };
    collect(UNSUPPORTED_WITH_ARG_RE);
    collect(UNSUPPORTED_STANDALONE_RE);
    collect(HD_ASSIGN_RE);

    const qualityMatch = text.match(QUALITY_FLAG_RE);
    const qualityValue = qualityMatch?.[1] || qualityMatch?.[0]?.split("=")[1];

    return {
        ratio,
        hd: HD_FLAG_RE.test(text),
        raw: RAW_FLAG_RE.test(text),
        quality: qualityValue,
        stylize: text.match(STYLIZE_FLAG_RE)?.[1],
        chaos: text.match(CHAOS_FLAG_RE)?.[1],
        no: text.match(NO_FLAG_RE)?.[1]?.trim(),
        sref: SREF_FLAG_RE.test(text),
        personalize: PERSONALIZE_FLAG_RE.test(text),
        unsupportedFlags: unsupported,
    };
}

export function stripUnsupportedMidjourneyFlags(prompt = ""): string {
    return String(prompt || "")
        .replace(UNSUPPORTED_WITH_ARG_RE, " ")
        .replace(UNSUPPORTED_STANDALONE_RE, " ")
        .replace(HD_ASSIGN_RE, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

export function resolveMidjourneyEffectiveSize(prompt: string, currentSize: string, presets: readonly MidjourneySizePreset[] = []): string | undefined {
    const parsed = parseMidjourneyPrompt(prompt);
    if (!parsed.ratio && !parsed.hd) return undefined;
    if (!presets.length) return parsed.hd ? "2K" : undefined;

    const normalizedCurrent = currentSize.trim().toLowerCase();
    const currentPreset = presets.find((p) => p.size.toLowerCase() === normalizedCurrent || p.ratio.toLowerCase() === normalizedCurrent);
    const targetRatio = parsed.ratio || currentPreset?.ratio || "1:1";
    const targetTier = parsed.hd ? "2k" : (currentPreset?.tier || "1k").toLowerCase();

    const exact = presets.find((p) => p.tier.toLowerCase() === targetTier && p.ratio === targetRatio);
    if (exact) return exact.size;
    if (parsed.hd) {
        return presets.find((p) => p.tier.toLowerCase() === "2k" && p.ratio === "1:1")?.size
            || presets.find((p) => p.tier.toLowerCase() === "2k")?.size
            || "2K";
    }
    return presets.find((p) => p.ratio === targetRatio)?.size;
}

export function syncMidjourneySizeFromPromptChange(
    previousPrompt: string,
    nextPrompt: string,
    currentSize: string,
    presets: readonly MidjourneySizePreset[] = [],
): string | undefined {
    if (!presets.length) return undefined;
    const prev = parseMidjourneyPrompt(previousPrompt);
    const next = parseMidjourneyPrompt(nextPrompt);
    if (prev.ratio === next.ratio && prev.hd === next.hd) return undefined;

    const normalizedCurrent = currentSize.trim().toLowerCase();
    const currentPreset = presets.find((p) => p.size.toLowerCase() === normalizedCurrent || p.ratio.toLowerCase() === normalizedCurrent);
    const targetRatio = next.ratio || currentPreset?.ratio || "1:1";
    const targetTier = next.hd
        ? "2k"
        : prev.hd && !next.hd
            ? "1k"
            : (currentPreset?.tier || "1k").toLowerCase();

    const target = presets.find((p) => p.tier.toLowerCase() === targetTier && p.ratio === targetRatio)
        || (next.hd ? presets.find((p) => p.tier.toLowerCase() === "2k" && p.ratio === "1:1") : presets.find((p) => p.ratio === targetRatio));
    if (!target || target.size.toLowerCase() === normalizedCurrent) return undefined;
    return target.size;
}

export function clampMidjourneyNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

export function midjourneyStylizeLabel(value: number): string {
    if (value <= 50) return "贴合";
    if (value <= 200) return "平衡";
    if (value <= 600) return "艺术";
    return "极致";
}

export function midjourneyCustomCount(options: MidjourneyImageOptions): number {
    let count = 0;
    if (options.mjRaw === "true") count += 1;
    if (options.mjQuality === "2" || options.mjQuality === "4") count += 1;
    if (clampMidjourneyNumber(options.mjStylize, 0, 1000, MIDJOURNEY_DEFAULTS.stylize) !== MIDJOURNEY_DEFAULTS.stylize) count += 1;
    if (clampMidjourneyNumber(options.mjChaos, 0, 100, MIDJOURNEY_DEFAULTS.chaos) !== MIDJOURNEY_DEFAULTS.chaos) count += 1;
    if (options.mjNo?.trim()) count += 1;
    if (options.mjStyleCode?.trim()) count += 1;
    return count;
}

export function midjourneySettingsSummary(options: MidjourneyImageOptions): string[] {
    const parts: string[] = [];
    if (options.mjRaw === "true") parts.push("Raw");
    if (options.mjQuality === "2" || options.mjQuality === "4") parts.push(`Q${options.mjQuality}`);
    const stylize = clampMidjourneyNumber(options.mjStylize, 0, 1000, MIDJOURNEY_DEFAULTS.stylize);
    if (stylize !== MIDJOURNEY_DEFAULTS.stylize) parts.push(`S${stylize}`);
    const chaos = clampMidjourneyNumber(options.mjChaos, 0, 100, MIDJOURNEY_DEFAULTS.chaos);
    if (chaos !== MIDJOURNEY_DEFAULTS.chaos) parts.push(`C${chaos}`);
    if (options.mjNo?.trim()) parts.push("排除词");
    if (options.mjStyleCode?.trim()) parts.push("风格码");
    return parts;
}

export function composeMidjourneyPrompt(prompt: string, options: MidjourneyImageOptions): string {
    const base = String(prompt || "").trim();
    if (!base) return "";
    const parsed = parseMidjourneyPrompt(base);
    const additions: string[] = [];

    if (options.mjRaw === "true" && !parsed.raw) {
        additions.push("--raw");
    }
    if ((options.mjQuality === "2" || options.mjQuality === "4") && !parsed.quality) {
        additions.push(`--q ${options.mjQuality}`);
    }
    const stylize = clampMidjourneyNumber(options.mjStylize, 0, 1000, MIDJOURNEY_DEFAULTS.stylize);
    if (stylize !== MIDJOURNEY_DEFAULTS.stylize && !parsed.stylize) {
        additions.push(`--s ${stylize}`);
    }
    const chaos = clampMidjourneyNumber(options.mjChaos, 0, 100, MIDJOURNEY_DEFAULTS.chaos);
    if (chaos !== MIDJOURNEY_DEFAULTS.chaos && !parsed.chaos) {
        additions.push(`--c ${chaos}`);
    }
    const styleCode = options.mjStyleCode?.trim();
    if (styleCode) {
        const normalizedStyleCode = styleCode.replace(new RegExp(`${LEADING_BOUNDARY}${FLAG_PREFIX}`, "g"), "--");
        if (/^--(?:sref|p)\b/i.test(normalizedStyleCode)) {
            const chunks = normalizedStyleCode.split(/(?=(?:^|\s)--(?:sref|p)\b)/i).map((c) => c.trim()).filter(Boolean);
            for (const chunk of chunks) {
                if (/^--sref\b/i.test(chunk)) {
                    if (!parsed.sref) additions.push(chunk);
                } else if (/^--p\b/i.test(chunk)) {
                    if (!parsed.personalize) additions.push(chunk);
                } else {
                    additions.push(chunk);
                }
            }
        } else if (/^m[a-z0-9_-]{3,}$/i.test(normalizedStyleCode)) {
            if (!parsed.personalize) additions.push(`--p ${normalizedStyleCode}`);
        } else if (!parsed.sref) {
            additions.push(`--sref ${normalizedStyleCode}`);
        }
    }
    // Always append --no last so it never absorbs subsequent flags.
    const noText = options.mjNo?.trim().replace(new RegExp(`^${FLAG_PREFIX}no\\s+`, "i"), "").trim();
    if (noText && !parsed.no) {
        additions.push(`--no ${noText}`);
    }

    return additions.length ? `${base} ${additions.join(" ")}` : base;
}
