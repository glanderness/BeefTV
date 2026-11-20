import { isDesktopShellOrigin } from "@/lib/desktop-shell";
import { normalizeCanvasPreviewTier, type CanvasPreviewTier } from "@/lib/canvas/canvas-memory-policy";
import { apiBaseURL, http, type HttpRequestConfig } from "@/services/api/request";
import { getDesktopBootSnapshot } from "@/services/workspace-startup-state";

export type MediaTicketResponse = {
    ticket: string;
    path: string;
    expiresAt: string;
    mimeType: string;
    size: number;
    variant: "original" | "playback" | string;
};

export type ResolvedMediaStream = {
    url: string;
    compatible: boolean;
    mode: "loopback-ticket" | "same-origin-fallback";
    mimeType?: string;
    expiresAtMs?: number;
};

type CachedTicket = {
    url: string;
    compatible: boolean;
    mimeType: string;
    expiresAtMs: number;
};

const ticketCache = new Map<string, CachedTicket>();
const ticketInFlight = new Map<string, Promise<ResolvedMediaStream>>();
export const MEDIA_TICKET_REFRESH_MARGIN_MS = 120_000;
let directMediaAssetsOverride: boolean | null = null;

export function setDirectMediaAssetsEnabled(enabled: boolean | null) {
    directMediaAssetsOverride = enabled;
}

/**
 * Returns true when native `<img>` elements can load `/api/resources/:id/asset/...`
 * directly without attaching an `X-Desktop-Token` header via JavaScript fetch.
 *
 * Inside the Wails desktop shell (`wails://` or `wails.localhost`), Go's
 * same-origin `desktopAssetHandler` transparently injects the launch token.
 */
export function canUseSameOriginResourceAsset(): boolean {
    if (directMediaAssetsOverride !== null) return directMediaAssetsOverride;
    if (typeof window === "undefined") return false;
    return isDesktopShellOrigin(window.location);
}

export function canUseLoopbackMediaTicket(): boolean {
    if (directMediaAssetsOverride !== null) return directMediaAssetsOverride;
    if (typeof window === "undefined") return false;
    if (isDesktopShellOrigin(window.location)) return true;
    const mode = getDesktopBootSnapshot().transportMode;
    return mode === "loopback" || mode === "same-origin-fallback";
}

function sameOriginAssetApiPrefix(): string {
    if (typeof window !== "undefined" && isDesktopShellOrigin(window.location)) {
        return "/api";
    }
    return String(apiBaseURL || "/api").replace(/\/+$/u, "");
}

/**
 * Canonical same-origin URL for server-generated, disk-cached image previews.
 * Never persisted into canvas JSON (`metadata.content` stays `/api/resources/:id/file`).
 */
export function resourcePreviewAssetUrl(resourceId: string, requestedSize?: number, color: "preserve" | "srgb" = "preserve", cacheBust?: number): string {
    const id = resourceId.trim();
    if (!id) return "";
    const tier: CanvasPreviewTier = normalizeCanvasPreviewTier(requestedSize);
    const prefix = sameOriginAssetApiPrefix();
    const bust = cacheBust ? `&r=${cacheBust}` : "";
    return `${prefix}/resources/${encodeURIComponent(id)}/asset/preview-${tier}.jpg?variant=preview&w=${tier}&color=${color}${bust}`;
}

/**
 * Canonical same-origin URL for server-extracted, disk-cached video posters.
 */
export function resourcePosterAssetUrl(resourceId: string, cacheBust?: number): string {
    const id = resourceId.trim();
    if (!id) return "";
    const prefix = sameOriginAssetApiPrefix();
    const bust = cacheBust ? `&r=${cacheBust}` : "";
    return `${prefix}/resources/${encodeURIComponent(id)}/asset/poster.jpg?variant=poster${bust}`;
}

/**
 * Clamped same-origin Range fallback URL used only when loopback TCP is blocked.
 */
export function resourceFallbackStreamAssetUrl(resourceId: string, variant: "original" | "playback" = "original"): string {
    const id = resourceId.trim();
    if (!id) return "";
    const prefix = sameOriginAssetApiPrefix();
    return `${prefix}/resources/${encodeURIComponent(id)}/asset/${encodeURIComponent(id)}.mp4?variant=${variant}`;
}

function resolveLoopbackMediaOrigin(): string {
    const base = String(apiBaseURL || "").trim();
    if (/^https?:\/\//iu.test(base)) {
        try {
            const parsed = new URL(base);
            const host = parsed.hostname.toLowerCase();
            if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
                return parsed.origin;
            }
        } catch {
            return "";
        }
    }
    if (typeof window !== "undefined") {
        const host = String(window.location?.hostname || "").toLowerCase();
        if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
            return window.location.origin;
        }
    }
    return "";
}

export function invalidateResourceMediaTicket(resourceId: string, variant?: "original" | "playback") {
    const id = resourceId.trim();
    if (!id) return;
    if (variant) {
        ticketCache.delete(`${id}:${variant}`);
        return;
    }
    ticketCache.delete(`${id}:original`);
    ticketCache.delete(`${id}:playback`);
}

export function clearMediaTicketCache() {
    ticketCache.clear();
    ticketInFlight.clear();
}

/**
 * Requests a short-lived loopback media ticket (`POST /api/resources/:id/media-ticket`)
 * so `<video>` / `<audio>` stream directly from Go `http.ServeContent` with native
 * HTTP Range seeking and zero JS Blob RAM. Falls back to same-origin clamped Range
 * when loopback transport is unavailable.
 */
export async function resolveResourceMediaStream(
    resourceId: string,
    variant: "original" | "playback" = "original",
    config?: HttpRequestConfig,
): Promise<ResolvedMediaStream> {
    const id = resourceId.trim();
    const bootSnapshot = getDesktopBootSnapshot();
    if (bootSnapshot.transportMode === "same-origin-fallback" && canUseSameOriginResourceAsset()) {
        return {
            url: resourceFallbackStreamAssetUrl(id, variant),
            compatible: variant === "playback",
            mode: "same-origin-fallback",
        };
    }

    const cacheKey = `${id}:${variant}`;
    const cached = ticketCache.get(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > MEDIA_TICKET_REFRESH_MARGIN_MS) {
        return {
            url: cached.url,
            compatible: cached.compatible,
            mode: "loopback-ticket",
            mimeType: cached.mimeType,
            expiresAtMs: cached.expiresAtMs,
        };
    }

    const existing = !config?.signal ? ticketInFlight.get(cacheKey) : undefined;
    if (existing) return existing;

    const task = (async (): Promise<ResolvedMediaStream> => {
        const res = await http.post<MediaTicketResponse>(
            `/resources/${encodeURIComponent(id)}/media-ticket`,
            { variant },
            config,
        );
        if (!res?.ticket || !res.path) {
            throw new Error("媒体流票据无效");
        }
        const origin = resolveLoopbackMediaOrigin();
        const url = origin ? `${origin}${res.path}` : res.path;
        const expiresAtMs = Date.parse(res.expiresAt) || Date.now() + 15 * 60 * 1000;
        const compatible = res.variant === "playback";
        ticketCache.set(cacheKey, {
            url,
            compatible,
            mimeType: res.mimeType || "",
            expiresAtMs,
        });
        return {
            url,
            compatible,
            mode: "loopback-ticket",
            mimeType: res.mimeType,
            expiresAtMs,
        };
    })().finally(() => {
        if (ticketInFlight.get(cacheKey) === task) {
            ticketInFlight.delete(cacheKey);
        }
    });

    if (!config?.signal) {
        ticketInFlight.set(cacheKey, task);
    }
    return task;
}
