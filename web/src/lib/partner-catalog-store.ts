import { scopedStorageKey } from "@/lib/user-scope";
import type { PartnerCatalogItem } from "@/services/api/plugins";

export type PartnerSyncIssue = {
    id: string;
    presetId: string;
    name: string;
    error: string;
    kind: "conflict" | "transient";
};

export type RemotePartnerMeta = {
    pluginId: string;
    presetId: string;
    live: boolean;
    retired?: boolean;
    from?: string;
    until?: string;
    keysUrl?: string;
    websiteUrl?: string;
    iconUrl?: string;
    promoText?: string;
    order: number;
};

const NOTICED_PARTNERS_STORAGE_KEY = "beeftv:noticed-partner-presets:v1";
const REMEMBERED_PARTNERS_STORAGE_KEY = "beeftv:installed-partner-presets:v1";
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_PARTNER_PLUGIN_ID = /^beeftv-plugin-[a-z0-9][a-z0-9-]{0,49}$/;
const VALID_PRESET_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

const metaByPluginId = new Map<string, RemotePartnerMeta>();
const issuesByPluginId = new Map<string, PartnerSyncIssue>();
const fallbackNoticedIds = new Set<string>();
const fallbackRememberedPresets = new Map<string, string>();
let syncIssuesList: PartnerSyncIssue[] = [];

export function sanitizeClientPartnerUrl(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 2048) return undefined;
    if (trimmed.startsWith("/api/plugins/partners/")) return trimmed;
    try {
        const parsed = new URL(trimmed);
        if (parsed.username || parsed.password || parsed.hash) return undefined;
        if (parsed.protocol === "https:") return parsed.toString();
        if (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1")) {
            return parsed.toString();
        }
    } catch {
        return undefined;
    }
    return undefined;
}

export function parsePartnerWindowBoundMs(raw: string | undefined, endOfDay: boolean): { ok: boolean; ms: number | null } {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return { ok: true, ms: null };
    if (DATE_ONLY_PATTERN.test(trimmed)) {
        const baseMs = Date.parse(`${trimmed}T00:00:00+08:00`);
        if (Number.isNaN(baseMs)) return { ok: false, ms: null };
        return { ok: true, ms: endOfDay ? baseMs + 86_400_000 : baseMs };
    }
    const parsedMs = Date.parse(trimmed);
    if (Number.isNaN(parsedMs)) return { ok: false, ms: null };
    return { ok: true, ms: parsedMs };
}

export function isPartnerWindowLiveAt(from?: string, until?: string, nowMs = Date.now()): boolean {
    const start = parsePartnerWindowBoundMs(from, false);
    const end = parsePartnerWindowBoundMs(until, true);
    if (!start.ok || !end.ok) return false;
    if (start.ms !== null && nowMs < start.ms) return false;
    if (end.ms !== null && nowMs >= end.ms) return false;
    return true;
}

export function isBuiltinPartnerLiveAt(
    plugin: { partner?: boolean; live?: boolean; from?: string; until?: string },
    nowMs = Date.now(),
): boolean {
    if (plugin.partner === false) return false;
    const hasWindow = Boolean((plugin.from ?? "").trim() || (plugin.until ?? "").trim());
    if (hasWindow) {
        return isPartnerWindowLiveAt(plugin.from, plugin.until, nowMs);
    }
    return plugin.live !== false;
}

export function nextPartnerWindowBoundaryDelayMs(
    entries: Iterable<{ from?: string; until?: string }>,
    nowMs = Date.now(),
): number | null {
    let earliest: number | null = null;
    for (const entry of entries) {
        for (const [raw, endOfDay] of [[entry.from, false], [entry.until, true]] as const) {
            const bound = parsePartnerWindowBoundMs(raw, endOfDay);
            if (bound.ok && bound.ms !== null && bound.ms > nowMs) {
                const wait = Math.min(6 * 3_600_000, Math.max(250, bound.ms - nowMs + 250));
                if (earliest === null || wait < earliest) {
                    earliest = wait;
                }
            }
        }
    }
    return earliest;
}

export function getRemotePartnerMetaByPlugin(pluginId: string): RemotePartnerMeta | undefined {
    return metaByPluginId.get(pluginId);
}

export function listRemotePartnerMeta(): RemotePartnerMeta[] {
    return [...metaByPluginId.values()];
}

export function livePartnerSyncIssues(): readonly PartnerSyncIssue[] {
    return syncIssuesList;
}

function readRememberedPresetMap(): Map<string, string> {
    const out = new Map(fallbackRememberedPresets);
    if (typeof window !== "undefined") {
        try {
            const raw = window.localStorage?.getItem(scopedStorageKey(REMEMBERED_PARTNERS_STORAGE_KEY));
            if (raw) {
                const parsed: unknown = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                        if (VALID_PARTNER_PLUGIN_ID.test(k) && typeof v === "string" && VALID_PRESET_ID.test(v)) {
                            out.set(k, v);
                        }
                    }
                }
            }
        } catch {
            // ignore storage errors
        }
    }
    return out;
}

export function rememberInstalledPartnerPreset(pluginId: string, presetId: string): void {
    if (!VALID_PARTNER_PLUGIN_ID.test(pluginId) || !VALID_PRESET_ID.test(presetId)) return;
    const current = readRememberedPresetMap();
    if (current.get(pluginId) === presetId) {
        fallbackRememberedPresets.set(pluginId, presetId);
        return;
    }
    current.set(pluginId, presetId);
    fallbackRememberedPresets.set(pluginId, presetId);
    if (typeof window !== "undefined") {
        try {
            window.localStorage?.setItem(
                scopedStorageKey(REMEMBERED_PARTNERS_STORAGE_KEY),
                JSON.stringify(Object.fromEntries(current.entries())),
            );
        } catch {
            // ignore storage errors
        }
    }
}

export function getRememberedPartnerPresetId(pluginId: string): string | undefined {
    return readRememberedPresetMap().get(pluginId);
}

export function clearInMemoryPartnerCatalogForReloadTest(): void {
    metaByPluginId.clear();
    issuesByPluginId.clear();
    syncIssuesList = [];
}

export function clearPartnerCatalogStoreForTest(): void {
    metaByPluginId.clear();
    issuesByPluginId.clear();
    fallbackRememberedPresets.clear();
    syncIssuesList = [];
    if (typeof window !== "undefined") {
        try {
            window.localStorage?.removeItem(scopedStorageKey(REMEMBERED_PARTNERS_STORAGE_KEY));
        } catch {
            // ignore storage errors
        }
    }
}

/** 更新远端合作伙伴权威目录；complete=false（离线或本地缓存降级）时保留未出现的已存元数据与告警。 */
export function updatePartnerCatalogStore(
    items: readonly PartnerCatalogItem[],
    reservedCorePresetIds: ReadonlySet<string>,
    complete: boolean,
): { issuesChanged: boolean } {
    if (complete) {
        metaByPluginId.clear();
        issuesByPluginId.clear();
    }
    const seenPresets = new Set<string>();
    if (!complete) {
        for (const existing of metaByPluginId.values()) {
            seenPresets.add(existing.presetId);
        }
    }

    items.forEach((item, index) => {
        const rememberedPreset = getRememberedPartnerPresetId(item.id);
        const rawPresetId = (item.presetId || "").trim();
        const presetId = item.retired && rememberedPreset ? rememberedPreset : rawPresetId;
        if (!VALID_PARTNER_PLUGIN_ID.test(item.id) || !VALID_PRESET_ID.test(presetId) || reservedCorePresetIds.has(presetId)) return;
        const prevForPlugin = metaByPluginId.get(item.id);
        // 在不完整离线快照（complete=false）中，绝不用合成退役项（retired=true, live=false）覆盖已在内存中激活的合作伙伴元数据。
        if (!complete && item.retired && prevForPlugin) {
            return;
        }
        if (seenPresets.has(presetId) && prevForPlugin?.presetId !== presetId) return;
        seenPresets.add(presetId);

        const from = typeof item.from === "string" && item.from.trim() ? item.from.trim() : undefined;
        const until = typeof item.until === "string" && item.until.trim() ? item.until.trim() : undefined;
        const live = item.retired ? false : (from || until ? isPartnerWindowLiveAt(from, until) : Boolean(item.live));
        metaByPluginId.set(item.id, {
            pluginId: item.id,
            presetId,
            live,
            retired: Boolean(item.retired),
            from,
            until,
            keysUrl: item.retired ? undefined : sanitizeClientPartnerUrl(item.keysUrl),
            websiteUrl: item.retired ? undefined : sanitizeClientPartnerUrl(item.websiteUrl),
            iconUrl: item.retired ? undefined : sanitizeClientPartnerUrl(item.iconUrl),
            promoText: !item.retired && typeof item.promoText === "string" && item.promoText.trim() ? item.promoText.trim() : undefined,
            order: index,
        });
        if (item.installed && !item.retired) {
            rememberInstalledPartnerPreset(item.id, presetId);
        }

        const installError = typeof item.installError === "string" ? item.installError.trim() : "";
        if (live && installError) {
            issuesByPluginId.set(item.id, {
                id: item.id,
                presetId,
                name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : presetId,
                error: installError,
                kind: item.installErrorKind === "conflict" ? "conflict" : "transient",
            });
        } else {
            issuesByPluginId.delete(item.id);
        }
    });

    const nextIssues = [...issuesByPluginId.values()];
    const issuesChanged = JSON.stringify(syncIssuesList) !== JSON.stringify(nextIssues);
    if (issuesChanged) {
        syncIssuesList = nextIssues;
    }
    return { issuesChanged };
}

export function readNoticedPartnerSet(): Set<string> {
    if (typeof window !== "undefined") {
        try {
            const raw = window.localStorage?.getItem(scopedStorageKey(NOTICED_PARTNERS_STORAGE_KEY));
            if (raw) {
                const parsed: unknown = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return new Set(parsed.filter((item): item is string => typeof item === "string" && Boolean(item)));
                }
            }
        } catch {
            // ignore storage errors
        }
    }
    return new Set(fallbackNoticedIds);
}

export function recordPartnersNoticed(ids: readonly string[]): boolean {
    const clean = ids.map((item) => item.trim()).filter(Boolean);
    if (!clean.length) return false;
    const current = readNoticedPartnerSet();
    let added = false;
    for (const id of clean) {
        if (!current.has(id)) {
            current.add(id);
            fallbackNoticedIds.add(id);
            added = true;
        }
    }
    if (!added) return false;
    if (typeof window !== "undefined") {
        try {
            window.localStorage?.setItem(scopedStorageKey(NOTICED_PARTNERS_STORAGE_KEY), JSON.stringify([...current]));
        } catch {
            // ignore storage errors
        }
    }
    return true;
}
