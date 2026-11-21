import { http } from "@/services/api/request";
import type { RegisteredPlugin } from "@/lib/plugins/plugin-types";

export type BackendPlugin = {
    manifest: RegisteredPlugin["manifest"];
    source: "bundled" | "uploaded" | "package" | "local" | string;
    fileName: string;
    package: string;
    sha256: string;
    installedAt: string;
    updatedAt: string;
    status: "enabled" | "disabled" | "invalid" | string;
    error?: string;
    packageSpec?: string;
    management: PluginManagement;
};


export type PluginManagement = {
    origin: "official" | "system" | "uploaded" | "package";
    kind: "protocol" | "application";
    activationScope: "system" | "user";
    configurationScope: "none" | "system" | "user";
    /** 随应用发布的接口格式：在模型设置里选，不当作插件管理。 */
    builtInInterface?: boolean;
};

export type PluginState = {
    pluginId: string;
    platformAvailable: boolean;
    userEnabled: boolean;
    userConfigured: boolean;
    effectiveEnabled: boolean;
    canToggle: boolean;
    canConfigure: boolean;
    blockedReason?: string;
};

export async function fetchPlugins() {
    return http.get<{ plugins: BackendPlugin[]; states: Record<string, PluginState> }>("/plugins");
}

// npm downloads a package and its dependencies; the backend allows up to three minutes.
const PACKAGE_INSTALL_TIMEOUT_MS = 200_000;

export async function uploadPlugin(file: File) {
    const body = new FormData();
    body.append("file", file);
    const result = await http.post<{ plugin: BackendPlugin }>("/plugins", body, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    return result.plugin;
}

/** source is an npm spec, a local package directory or a sample name shipped with BeefTV. */
export async function installPluginPackage(payload: { source: string; registry?: string }) {
    const result = await http.post<{ plugin: BackendPlugin }>("/plugins/install", payload, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    return result.plugin;
}

export async function updatePluginPackage(id: string, registry?: string) {
    const result = await http.post<{ plugin: BackendPlugin }>(`/plugins/${encodeURIComponent(id)}/update`, { registry }, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    return result.plugin;
}

export type PartnerCatalogItem = {
    id: string;
    presetId: string;
    name: string;
    live: boolean;
    retired?: boolean;
    installed: boolean;
    repairNeeded?: boolean;
    enabled: boolean;
    iconPending?: boolean;
    installError?: string;
    installErrorKind?: "conflict" | "transient" | string;
    from?: string;
    until?: string;
    keysUrl?: string;
    websiteUrl?: string;
    iconUrl?: string;
    promoText?: string;
};

export async function fetchPartnerCatalog(signal?: AbortSignal) {
    return http.get<{ partners: PartnerCatalogItem[]; complete?: boolean }>("/plugins/partners", { signal, timeout: 10_000 });
}

export async function syncPartnerBuiltins(registry?: string) {
    return http.post<{ partners: PartnerCatalogItem[]; complete?: boolean; errors?: Record<string, string> }>("/plugins/partners/sync", { registry }, { timeout: PACKAGE_INSTALL_TIMEOUT_MS });
}

export type PluginUpdateNotice = { id: string; version: string; latest: string; official?: boolean };
/** updates 是有新版本的插件，upToDate 是确认已是最新的插件；两边都不在的插件没法比较版本。 */
export type PluginUpdateCheck = { updates: PluginUpdateNotice[]; upToDate: string[] };

export async function fetchPluginUpdates(signal?: AbortSignal) {
    return http.get<PluginUpdateCheck>("/plugins/updates", { signal, timeout: 15_000 });
}

export type PluginLoadErrorStage = "import" | "activate";

export async function reportPluginLoadError(
    id: string,
    error: string,
    stage?: PluginLoadErrorStage,
    revision?: string,
) {
    const body: { error: string; stage?: PluginLoadErrorStage; revision?: string } = { error };
    if (stage) body.stage = stage;
    if (revision) body.revision = revision;
    return http.post<{ plugin?: BackendPlugin; status?: string }>(
        `/plugins/${encodeURIComponent(id)}/load-error`,
        body,
    );
}

export async function setUserPluginEnabled(id: string, enabled: boolean) {
    const result = await http.put<{ state: PluginState }>(`/plugins/${encodeURIComponent(id)}/activation`, { enabled });
    return result.state;
}

/** System-scoped plugins (protocols, packages) are switched for the whole workspace. */
export async function setPluginPlatformEnabled(id: string, enabled: boolean) {
    const result = await http.post<{ state: PluginState }>(`/plugins/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`);
    return result.state;
}

export async function uninstallPlugin(id: string) {
    await http.delete<{ deleted: boolean }>(`/plugins/${encodeURIComponent(id)}`);
}
