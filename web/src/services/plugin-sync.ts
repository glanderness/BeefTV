import { applyPartnerCatalogMetadata } from "@/lib/builtin-service-presets";
import { reconcileLocalChannelsAfterPresetSync } from "@/lib/plugins/plugin-client-loader";
import { fetchPartnerCatalog, fetchPlugins, setPluginPlatformEnabled, setUserPluginEnabled, syncPartnerBuiltins, type PluginManagement } from "@/services/api/plugins";
import { usePluginStore } from "@/stores/use-plugin-store";

let partnerSyncInFlight: Promise<void> | null = null;
let transientRetryTimer: ReturnType<typeof setTimeout> | null = null;
const transientPartnerRetryAfter = new Map<string, number>();
export const TRANSIENT_PARTNER_RETRY_BACKOFF_MS = 120_000;

export function nextTransientPartnerRetryDelayMs(now = Date.now()): number | null {
    let earliest: number | null = null;
    for (const retryAt of transientPartnerRetryAfter.values()) {
        const wait = Math.max(0, retryAt - now);
        if (earliest === null || wait < earliest) {
            earliest = wait;
        }
    }
    return earliest;
}

function scheduleNextTransientPartnerRetry(onFire: () => void = () => { void syncPartnerCatalogFromBackend().catch(() => undefined); }): void {
    if (transientRetryTimer !== null) {
        clearTimeout(transientRetryTimer);
        transientRetryTimer = null;
    }
    const delay = nextTransientPartnerRetryDelayMs();
    if (delay === null) return;
    transientRetryTimer = setTimeout(() => {
        transientRetryTimer = null;
        onFire();
    }, Math.max(50, delay));
    if (typeof transientRetryTimer === "object" && transientRetryTimer && "unref" in transientRetryTimer && typeof transientRetryTimer.unref === "function") {
        transientRetryTimer.unref();
    }
}

export function recordTransientPartnerRetryForTest(pluginId: string, delayMs: number, onFire: () => void): void {
    transientPartnerRetryAfter.set(pluginId, Date.now() + delayMs);
    scheduleNextTransientPartnerRetry(onFire);
}

export function clearTransientPartnerRetryForTest(): void {
    if (transientRetryTimer !== null) {
        clearTimeout(transientRetryTimer);
        transientRetryTimer = null;
    }
    transientPartnerRetryAfter.clear();
}

export async function setPluginActivation(pluginId: string, enabled: boolean, scope: PluginManagement["activationScope"] = "user") {
    const next = scope === "system"
        ? await setPluginPlatformEnabled(pluginId, enabled)
        : await setUserPluginEnabled(pluginId, enabled);
    const store = usePluginStore.getState();
    store.setPluginStates({ ...store.pluginStates, [next.pluginId]: next });
    store.setEnabled(pluginId, next.effectiveEnabled);
    return next;
}

// The backend registry decides which plugins are installed and enabled. Every
// route follows it through the plugin store, so plugin canvas nodes render even
// when the plugin center was never opened in this window.
export async function syncPluginsFromBackend() {
    const result = await fetchPlugins();
    const plugins = (result.plugins || []).map((item) => ({
        manifest: {
            ...item.manifest,
            trusted: item.manifest.trusted ?? (item.source === "official" || item.source === "bundled" || item.source === "system"),
        },
        enabled: result.states?.[item.manifest.id]?.effectiveEnabled ?? item.status === "enabled",
    }));
    usePluginStore.getState().syncBackendPlugins(plugins, result.states || {});
    return result;
}

export type PartnerSyncTransportDeps = {
    fetchCatalog?: typeof fetchPartnerCatalog;
    syncBuiltins?: typeof syncPartnerBuiltins;
    syncPlugins?: () => Promise<unknown>;
};

export async function syncPartnerCatalogFromBackend(options?: { retryFailed?: boolean; deps?: PartnerSyncTransportDeps }) {
    const fetchCatalog = options?.deps?.fetchCatalog ?? fetchPartnerCatalog;
    const syncBuiltins = options?.deps?.syncBuiltins ?? syncPartnerBuiltins;
    const syncPlugins = options?.deps?.syncPlugins ?? syncPluginsFromBackend;
    const result = await fetchCatalog();
    const partners = result.partners || [];
    const complete = Boolean(result.complete);
    applyPartnerCatalogMetadata(partners, { complete });
    reconcileLocalChannelsAfterPresetSync();
    const now = Date.now();
    const needsSync = partners.some((item) => {
        if (!item.live && !item.repairNeeded) return false;
        if (item.live && item.iconPending) return true;
        if (item.installed) return false;
        if (options?.retryFailed) return true;
        if (item.installErrorKind === "conflict") return false;
        const retryAfter = transientPartnerRetryAfter.get(item.id) ?? 0;
        return now >= retryAfter;
    });
    if (needsSync && !partnerSyncInFlight) {
        partnerSyncInFlight = (async () => {
            try {
                const synced = await syncBuiltins();
                const nextPartners = synced.partners || [];
                const nextComplete = synced.complete ?? complete;
                for (const item of nextPartners) {
                    if (item.installed || !item.installError) {
                        transientPartnerRetryAfter.delete(item.id);
                    } else if (item.installErrorKind !== "conflict") {
                        transientPartnerRetryAfter.set(item.id, Date.now() + TRANSIENT_PARTNER_RETRY_BACKOFF_MS);
                    }
                }
                scheduleNextTransientPartnerRetry();
                applyPartnerCatalogMetadata(nextPartners, { complete: Boolean(nextComplete) });
                reconcileLocalChannelsAfterPresetSync();
                if (synced.errors && Object.keys(synced.errors).length > 0) {
                    console.warn("[partner-sync] 同步合作伙伴扩展存在错误：", synced.errors);
                }
                if (nextPartners.some((item) => item.installed)) {
                    await syncPlugins();
                }
            } catch (err) {
                console.warn("[partner-sync] 触发合作伙伴同步跳过或失败：", err);
            } finally {
                partnerSyncInFlight = null;
            }
        })();
        await partnerSyncInFlight;
    }
    return partners;
}
