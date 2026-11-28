import { encodeChannelModel, normalizeModelOptionValue, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

// Pre-migration official review profile defaults, used ONLY when a saved profile
// has neither explicit inputModalities nor explicit capabilityConfig.text limits.
const LEGACY_OFFICIAL_REVIEW_DEFAULTS: Record<string, readonly ("image" | "video" | "audio")[]> = {
    "wand-vega-vl-1.0-flash": ["image", "video", "audio"],
};

type ReviewModality = "image" | "video" | "audio";
type ChannelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

function normalizeReviewModality(raw: string): ReviewModality | "" {
    const lower = raw.trim().toLowerCase();
    if (lower === "video" || lower === "video/mp4") return "video";
    if (lower === "audio" || lower === "audio/wav") return "audio";
    if (lower === "image" || lower === "vision" || lower.startsWith("image/")) return "image";
    return "";
}

function legacyOfficialReviewModalities(channel: Pick<ModelChannel, "modelAliases">, model: string, profile: ChannelProfile): ReviewModality[] {
    if ((profile.inputModalities && profile.inputModalities.length > 0) || profile.capabilityConfig?.text) {
        return [];
    }
    const direct = LEGACY_OFFICIAL_REVIEW_DEFAULTS[model.trim().toLowerCase()];
    if (direct) return [...direct];
    for (const [canonical, alias] of Object.entries(channel.modelAliases || {})) {
        if (alias.trim() === model.trim()) {
            const mapped = LEGACY_OFFICIAL_REVIEW_DEFAULTS[canonical.trim().toLowerCase()];
            if (mapped) return [...mapped];
        }
    }
    return [];
}

/**
 * Derives supported multimodal review input modalities strictly from
 * `inputModalities ∪ capabilityConfig.text.references.{maxImages,maxVideos,maxAudios}`,
 * with pre-refresh official fallback only when neither capability metadata source is present.
 */
export function mediaReviewModalitiesForProfile(
    channel: Pick<ModelChannel, "modelAliases">,
    profile: ChannelProfile | undefined,
): ReviewModality[] {
    if (!profile || profile.capability !== "text") return [];
    const protocol = (profile.protocol?.trim() || "chat-completion");
    if (protocol !== "chat-completion") return [];

    const modalities = new Set<ReviewModality>();
    for (const raw of profile.inputModalities || []) {
        const normalized = normalizeReviewModality(String(raw || ""));
        if (normalized) modalities.add(normalized);
    }
    const refs = profile.capabilityConfig?.text?.references;
    if (refs) {
        if ((refs.maxImages ?? 0) > 0) modalities.add("image");
        if ((refs.maxVideos ?? 0) > 0) modalities.add("video");
        if ((refs.maxAudios ?? 0) > 0) modalities.add("audio");
    }
    if (modalities.size === 0) {
        for (const fallback of legacyOfficialReviewModalities(channel, profile.model, profile)) {
            modalities.add(fallback);
        }
    }
    return Array.from(modalities);
}

export function mediaReviewModelOptions(config: AiConfig): string[] {
    const options: string[] = [];
    const seen = new Set<string>();
    for (const channel of config.channels) {
        if (channel.enabled === false) continue;
        for (const model of channel.models) {
            const profile = channel.modelProfiles?.find((item) => item.model === model);
            if (mediaReviewModalitiesForProfile(channel, profile).length === 0) continue;
            const encoded = encodeChannelModel(channel.id, model);
            if (!seen.has(encoded)) {
                seen.add(encoded);
                options.push(encoded);
            }
        }
    }
    return options;
}

export function normalizeMediaReviewModel(config: AiConfig, value: unknown): string {
    const candidate = normalizeModelOptionValue(value, config.channels);
    return mediaReviewModelOptions(config).includes(candidate) ? candidate : "";
}
