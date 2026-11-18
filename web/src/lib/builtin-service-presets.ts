import type { ModelCapability } from "@/stores/use-config-store";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import {
    clearInMemoryPartnerCatalogForReloadTest,
    clearPartnerCatalogStoreForTest,
    getRememberedPartnerPresetId,
    getRemotePartnerMetaByPlugin,
    isBuiltinPartnerLiveAt,
    listRemotePartnerMeta,
    livePartnerSyncIssues,
    nextPartnerWindowBoundaryDelayMs,
    readNoticedPartnerSet,
    recordPartnersNoticed,
    rememberInstalledPartnerPreset,
    updatePartnerCatalogStore,
    type PartnerSyncIssue,
} from "@/lib/partner-catalog-store";
import type { PartnerCatalogItem } from "@/services/api/plugins";
import {
    DEFAULT_BASE_URL as LL2_DEFAULT_BASE_URL,
    LL2_CHANNEL_ID,
    LL2_CHANNEL_NAME,
    LL2_PRESET_MODELS,
    buildLL2ModelChannel,
    upgradeLL2ModelProfile,
} from "../../../plugin-packages/beeftv-plugin-ll2/client/index.js";
import {
    DEFAULT_BASE_URL as YSDUI_DEFAULT_BASE_URL,
    YSDUI_CHANNEL_ICON,
    YSDUI_CHANNEL_ID,
    YSDUI_CHANNEL_NAME,
    YSDUI_PRESET_MODELS,
    YSDUI_PROVIDER_INTRO,
    buildYsduiModelChannel,
    upgradeYsduiModelProfile,
} from "../../../plugin-packages/beeftv-plugin-ysdui/client/index.js";

export { LL2_CHANNEL_ID, YSDUI_CHANNEL_ID, isBuiltinPartnerLiveAt, livePartnerSyncIssues, type PartnerSyncIssue };

export type BuiltinPresetModel = {
    model: string;
    displayName: string;
    capability: string;
    protocol: string;
    defaultOptions?: Record<string, unknown>;
    capabilityConfig?: unknown;
};

export type BuiltinModelProfile = {
    model: string;
    displayName?: string;
    capability?: string;
    protocol?: string;
    authType?: string;
    defaultOptions?: Record<string, unknown>;
    capabilityConfig?: unknown;
};

export type BuiltinPresetChannelLike = {
    id?: string;
    baseUrl?: string;
};

export type BuiltinPresetPlugin = {
    pluginId: string;
    name: string;
    subtitle: string;
    icon: string;
    baseUrl: string;
    partner?: boolean;
    live?: boolean;
    from?: string;
    until?: string;
    keysUrl?: string;
    websiteUrl?: string;
    promoText?: string;
    order?: number;
    /** 这个插件的协议都以这些前缀开头。 */
    protocolPrefixes: string[];
    hosts: string[];
    hostSuffixes: string[];
    /** 没有显式声明接口时，按能力给的默认协议。 */
    candidates: Partial<Record<ModelCapability, string>>;
    models: readonly BuiltinPresetModel[];
    /** 用在「已预置 N 款…模型及协议」的说明里。 */
    presetDescription: string;
    /** 服务商或平台简介（可选），展示在连接表单标题下方。 */
    providerIntro?: string;
    /** 插件自己在 manifest 里声明了素材怎么传时，设置页不再显示手填字段。 */
    declaresReferenceMediaTransport: boolean;
    buildChannel: (args: { apiKey: string; baseUrl: string; selectedModels?: string[]; existingChannel?: unknown }) => { models: string[]; modelProfiles: BuiltinModelProfile[] };
    upgradeProfile: <T>(profile: T, channel?: BuiltinPresetChannelLike) => T;
};

/** 没有显式声明接口时按能力补的默认协议；ll2 和 compatible 共用同一组。 */
export const TEXT_AUDIO_CANDIDATES: Partial<Record<ModelCapability, string>> = { text: "chat-completion", audio: "openai-audio" };
export const COMPATIBLE_CANDIDATES: Partial<Record<ModelCapability, string>> = { ...TEXT_AUDIO_CANDIDATES, image: "openai-image" };

const RESERVED_CORE_PRESET_IDS = new Set(["compatible", "openai", "gemini", "ark", "beeftv"]);
const STATIC_SHIPPED_PLUGIN_PRESET: Readonly<Record<string, string>> = {
    "beeftv-plugin-ll2": LL2_CHANNEL_ID,
    "beeftv-plugin-ysdui": YSDUI_CHANNEL_ID,
};
const STATIC_PRESET_IDS = new Set([LL2_CHANNEL_ID, YSDUI_CHANNEL_ID]);
const VALID_PARTNER_PLUGIN_ID = /^beeftv-plugin-[a-z0-9][a-z0-9-]{0,49}$/;
const VALID_PRESET_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** 宿主已知的官方内置与动态合作伙伴预设表；新增合作方经权威注册表同步后在此生效。 */
export const BUILTIN_PRESETS: Record<string, BuiltinPresetPlugin> = {
    [LL2_CHANNEL_ID]: {
        pluginId: "beeftv-plugin-ll2",
        name: LL2_CHANNEL_NAME,
        subtitle: "文本 · 多款主流视频 · 视频超分",
        icon: "OpenAI",
        baseUrl: LL2_DEFAULT_BASE_URL,
        partner: true,
        live: true,
        from: "2026-11-03T00:00:00+08:00",
        until: "2026-12-04T00:00:00+08:00",
        keysUrl: "https://hub.ll2.cn?p=rw6t",
        websiteUrl: "https://hub.ll2.cn",
        order: 0,
        protocolPrefixes: ["ll2-"],
        hosts: [new URL(LL2_DEFAULT_BASE_URL).hostname],
        hostSuffixes: [".ll2.cn"],
        candidates: COMPATIBLE_CANDIDATES,
        models: LL2_PRESET_MODELS,
        presetDescription: "文本、视频与超分",
        declaresReferenceMediaTransport: false,
        buildChannel: (args) => buildLL2ModelChannel({ apiKey: args.apiKey, baseUrl: args.baseUrl, selectedModels: args.selectedModels, existingChannel: args.existingChannel }),
        upgradeProfile: (profile, channel) => upgradeLL2ModelProfile(profile, channel),
    },
    [YSDUI_CHANNEL_ID]: {
        pluginId: "beeftv-plugin-ysdui",
        name: YSDUI_CHANNEL_NAME,
        subtitle: "文本 · 多款主流图片 · 多款主流视频",
        icon: YSDUI_CHANNEL_ICON,
        baseUrl: YSDUI_DEFAULT_BASE_URL,
        partner: true,
        live: true,
        from: "2026-11-14T00:00:00+08:00",
        until: "2027-01-14T00:00:00+08:00",
        keysUrl: "https://www.ysdui.cn/",
        websiteUrl: "https://www.ysdui.cn/",
        order: 1,
        protocolPrefixes: ["ysdui-"],
        hosts: [new URL(YSDUI_DEFAULT_BASE_URL).hostname, "ysdui.cn"],
        hostSuffixes: [".ysdui.cn"],
        candidates: TEXT_AUDIO_CANDIDATES,
        models: YSDUI_PRESET_MODELS,
        presetDescription: "文本、图像与视频",
        providerIntro: YSDUI_PROVIDER_INTRO,
        declaresReferenceMediaTransport: true,
        buildChannel: (args) => buildYsduiModelChannel({ apiKey: args.apiKey, baseUrl: args.baseUrl, selectedModels: args.selectedModels, existingChannel: args.existingChannel }),
        upgradeProfile: (profile) => upgradeYsduiModelProfile(profile),
    },
};

/** 已被权威注册表移除但本机已安装加载过的动态伙伴预设：从新建列表隐藏，保留给已存渠道编辑与档案迁移。 */
const RETIRED_DYNAMIC_PRESETS: Record<string, BuiltinPresetPlugin> = {};
const loadedPartnerModules = new Map<string, unknown>();
const loadedModuleFnRefs = new Map<string, { buildChannel: unknown; upgradeProfile: unknown }>();
const presetListeners = new Set<() => void>();
const indicatorListeners = new Set<() => void>();
let builtinPresetsVersion = 0;
let partnerIndicatorVersion = 0;

function emitBuiltinPresetsChanged() {
    builtinPresetsVersion += 1;
    partnerIndicatorVersion += 1;
    for (const listener of presetListeners) {
        listener();
    }
    for (const listener of indicatorListeners) {
        listener();
    }
}

function emitNoticedPartnersChanged() {
    partnerIndicatorVersion += 1;
    for (const listener of indicatorListeners) {
        listener();
    }
}

export function notifyPartnerWindowBoundaryCrossed(): void {
    emitBuiltinPresetsChanged();
}

export function nextActivePartnerWindowDelayMs(nowMs = Date.now()): number | null {
    return nextPartnerWindowBoundaryDelayMs(Object.values(BUILTIN_PRESETS), nowMs);
}

export function subscribeBuiltinPresets(listener: () => void): () => void {
    presetListeners.add(listener);
    return () => {
        presetListeners.delete(listener);
    };
}

export function getBuiltinPresetsVersion(): number {
    return builtinPresetsVersion;
}

export function subscribePartnerIndicator(listener: () => void): () => void {
    indicatorListeners.add(listener);
    return () => {
        indicatorListeners.delete(listener);
    };
}

export function getPartnerIndicatorVersion(): number {
    return partnerIndicatorVersion;
}

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((item, idx) => item === b[idx]);
}

function builtinPresetDataEqual(a: BuiltinPresetPlugin, b: BuiltinPresetPlugin): boolean {
    return (
        a.pluginId === b.pluginId &&
        a.name === b.name &&
        a.subtitle === b.subtitle &&
        a.icon === b.icon &&
        a.baseUrl === b.baseUrl &&
        a.partner === b.partner &&
        a.live === b.live &&
        a.from === b.from &&
        a.until === b.until &&
        a.keysUrl === b.keysUrl &&
        a.websiteUrl === b.websiteUrl &&
        a.promoText === b.promoText &&
        a.order === b.order &&
        a.presetDescription === b.presetDescription &&
        a.providerIntro === b.providerIntro &&
        a.declaresReferenceMediaTransport === b.declaresReferenceMediaTransport &&
        stringArrayEqual(a.protocolPrefixes, b.protocolPrefixes) &&
        stringArrayEqual(a.hosts, b.hosts) &&
        stringArrayEqual(a.hostSuffixes, b.hostSuffixes) &&
        JSON.stringify(a.candidates) === JSON.stringify(b.candidates) &&
        JSON.stringify(a.models) === JSON.stringify(b.models)
    );
}

function materializeBuiltinPresetModule(pluginId: string, mod: unknown): boolean {
    if (!mod || typeof mod !== "object" || !VALID_PARTNER_PLUGIN_ID.test(pluginId)) return false;
    const record = mod as Record<string, unknown>;
    const defaultExport = record.default && typeof record.default === "object" ? (record.default as Record<string, unknown>) : undefined;
    const raw = (record.BUILTIN_SERVICE_PRESET ?? defaultExport?.BUILTIN_SERVICE_PRESET) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return false;

    const staticPresetId = STATIC_SHIPPED_PLUGIN_PRESET[pluginId];
    const remoteMeta = getRemotePartnerMetaByPlugin(pluginId);
    const rememberedPresetId = !staticPresetId && !remoteMeta ? getRememberedPartnerPresetId(pluginId) : undefined;
    if (!staticPresetId && !remoteMeta && !rememberedPresetId) {
        return false;
    }
    const presetId = remoteMeta?.presetId ?? staticPresetId ?? rememberedPresetId!;
    if (!VALID_PRESET_ID.test(presetId) || RESERVED_CORE_PRESET_IDS.has(presetId)) return false;
    const rawExplicit = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
    if (rawExplicit && rawExplicit !== presetId) return false;

    const isRetiredReloadOnly = Boolean(rememberedPresetId && !remoteMeta && !staticPresetId);
    const isRetiredTarget = Boolean(isRetiredReloadOnly || remoteMeta?.retired);
    const current = isRetiredTarget ? RETIRED_DYNAMIC_PRESETS[presetId] : BUILTIN_PRESETS[presetId];
    if (current && current.pluginId !== pluginId) return false;
    if (!isRetiredTarget && BUILTIN_PRESETS[presetId] && BUILTIN_PRESETS[presetId].pluginId !== pluginId) return false;
    if (isRetiredReloadOnly && BUILTIN_PRESETS[presetId]) return false;

    const models = Array.isArray(raw.models) ? (raw.models as BuiltinPresetModel[]) : undefined;
    const buildChannel = typeof raw.buildChannel === "function" ? (raw.buildChannel as BuiltinPresetPlugin["buildChannel"]) : undefined;
    const upgradeProfile = typeof raw.upgradeProfile === "function" ? (raw.upgradeProfile as BuiltinPresetPlugin["upgradeProfile"]) : undefined;
    if (!models || !buildChannel || !upgradeProfile) return false;

    const nextBaseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : current?.baseUrl ?? "";
    if (!nextBaseUrl) return false;
    const baseHosts = Array.isArray(raw.hosts) ? [...(raw.hosts as string[])] : [...(current?.hosts ?? [])];
    try {
        const nextHostname = new URL(nextBaseUrl).hostname;
        if (nextHostname && !baseHosts.includes(nextHostname)) baseHosts.push(nextHostname);
    } catch {
        if (!current) return false;
    }

    const defaultOrder = current?.order ?? Object.keys(BUILTIN_PRESETS).length;
    const rawIcon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : current?.icon ?? "OpenAI";

    const nextEntry: BuiltinPresetPlugin = {
        pluginId,
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : current?.name ?? presetId,
        subtitle: typeof raw.subtitle === "string" && raw.subtitle.trim() ? raw.subtitle.trim() : current?.subtitle ?? "多模态算力服务",
        icon: !isRetiredTarget ? (remoteMeta?.iconUrl || rawIcon) : rawIcon,
        baseUrl: nextBaseUrl,
        partner: remoteMeta ? true : (typeof raw.partner === "boolean" ? raw.partner : current?.partner ?? true),
        live: isRetiredTarget ? false : (remoteMeta ? remoteMeta.live : (current?.live ?? true)),
        from: isRetiredTarget ? undefined : (remoteMeta ? remoteMeta.from : current?.from),
        until: isRetiredTarget ? undefined : (remoteMeta ? remoteMeta.until : current?.until),
        keysUrl: isRetiredTarget ? undefined : (remoteMeta ? remoteMeta.keysUrl : current?.keysUrl),
        websiteUrl: isRetiredTarget ? undefined : (remoteMeta ? remoteMeta.websiteUrl : current?.websiteUrl),
        promoText: isRetiredTarget ? undefined : (remoteMeta ? remoteMeta.promoText : current?.promoText),
        order: remoteMeta ? remoteMeta.order : defaultOrder,
        protocolPrefixes: Array.isArray(raw.protocolPrefixes) ? (raw.protocolPrefixes as string[]) : current?.protocolPrefixes ?? [`${presetId}-`],
        hosts: baseHosts,
        hostSuffixes: Array.isArray(raw.hostSuffixes) ? (raw.hostSuffixes as string[]) : current?.hostSuffixes ?? [],
        candidates: raw.candidates && typeof raw.candidates === "object" ? (raw.candidates as Partial<Record<ModelCapability, string>>) : current?.candidates ?? COMPATIBLE_CANDIDATES,
        models,
        presetDescription: typeof raw.presetDescription === "string" ? raw.presetDescription : current?.presetDescription ?? "多模态",
        providerIntro: typeof raw.providerIntro === "string" ? raw.providerIntro : current?.providerIntro,
        declaresReferenceMediaTransport:
            typeof raw.declaresReferenceMediaTransport === "boolean" ? raw.declaresReferenceMediaTransport : current?.declaresReferenceMediaTransport ?? false,
        buildChannel: (args) => buildChannel.call(BUILTIN_PRESETS[presetId] ?? RETIRED_DYNAMIC_PRESETS[presetId], args),
        upgradeProfile: <T>(profile: T, channel?: BuiltinPresetChannelLike): T =>
            upgradeProfile.call(BUILTIN_PRESETS[presetId] ?? RETIRED_DYNAMIC_PRESETS[presetId], profile, channel) as T,
    };

    const prevFns = loadedModuleFnRefs.get(presetId);
    if (
        current &&
        prevFns &&
        prevFns.buildChannel === buildChannel &&
        prevFns.upgradeProfile === upgradeProfile &&
        builtinPresetDataEqual(current, nextEntry)
    ) {
        return false;
    }

    if (isRetiredTarget) {
        delete BUILTIN_PRESETS[presetId];
        RETIRED_DYNAMIC_PRESETS[presetId] = nextEntry;
        loadedModuleFnRefs.set(presetId, { buildChannel, upgradeProfile });
        return true;
    }

    if (remoteMeta && !staticPresetId) {
        rememberInstalledPartnerPreset(pluginId, presetId);
    }
    delete RETIRED_DYNAMIC_PRESETS[presetId];
    BUILTIN_PRESETS[presetId] = nextEntry;
    loadedModuleFnRefs.set(presetId, { buildChannel, upgradeProfile });
    return true;
}

export function syncBuiltinPresetFromModule(pluginId: string, mod: unknown): boolean {
    if (!mod || typeof mod !== "object" || !VALID_PARTNER_PLUGIN_ID.test(pluginId)) return false;
    loadedPartnerModules.set(pluginId, mod);
    const updated = materializeBuiltinPresetModule(pluginId, mod);
    if (updated) emitBuiltinPresetsChanged();
    return updated;
}

/** 同步后端 `/api/plugins/partners` 目录：仅当 complete!==false 时裁剪已下线动态项，并将其保留在已装退役表供旧渠道编辑。 */
export function applyPartnerCatalogMetadata(
    items: readonly PartnerCatalogItem[],
    options?: { complete?: boolean },
): void {
    const complete = options?.complete !== false;
    const { issuesChanged } = updatePartnerCatalogStore(items, RESERVED_CORE_PRESET_IDS, complete);
    let changed = issuesChanged;

    if (complete) {
        for (const [key, entry] of Object.entries(BUILTIN_PRESETS)) {
            if (STATIC_PRESET_IDS.has(key)) continue;
            const authoritative = getRemotePartnerMetaByPlugin(entry.pluginId);
            if (!authoritative || authoritative.retired || authoritative.presetId !== key) {
                if (loadedPartnerModules.has(entry.pluginId)) {
                    RETIRED_DYNAMIC_PRESETS[key] = {
                        ...entry,
                        live: false,
                        keysUrl: undefined,
                        websiteUrl: undefined,
                        promoText: undefined,
                    };
                }
                delete BUILTIN_PRESETS[key];
                loadedModuleFnRefs.delete(key);
                changed = true;
            }
        }
    }

    for (const [pluginId, mod] of loadedPartnerModules.entries()) {
        if (getRemotePartnerMetaByPlugin(pluginId)) {
            if (materializeBuiltinPresetModule(pluginId, mod)) {
                changed = true;
            }
        }
    }

    for (const meta of listRemotePartnerMeta()) {
        const existing = BUILTIN_PRESETS[meta.presetId];
        if (!existing || existing.pluginId !== meta.pluginId) continue;
        const nextIcon = meta.iconUrl || existing.icon;
        if (
            existing.live !== meta.live ||
            existing.from !== meta.from ||
            existing.until !== meta.until ||
            existing.keysUrl !== meta.keysUrl ||
            existing.websiteUrl !== meta.websiteUrl ||
            existing.promoText !== meta.promoText ||
            existing.icon !== nextIcon ||
            existing.order !== meta.order
        ) {
            BUILTIN_PRESETS[meta.presetId] = {
                ...existing,
                partner: true,
                live: meta.live,
                from: meta.from,
                until: meta.until,
                keysUrl: meta.keysUrl,
                websiteUrl: meta.websiteUrl,
                promoText: meta.promoText,
                icon: nextIcon,
                order: meta.order,
            };
            changed = true;
        }
    }

    if (changed) emitBuiltinPresetsChanged();
}

export function resetDynamicPartnersInMemoryForReloadTest(): void {
    for (const key of Object.keys(BUILTIN_PRESETS)) {
        if (!STATIC_PRESET_IDS.has(key)) {
            delete BUILTIN_PRESETS[key];
        }
    }
    for (const pluginId of [...loadedPartnerModules.keys()]) {
        if (!STATIC_SHIPPED_PLUGIN_PRESET[pluginId]) {
            loadedPartnerModules.delete(pluginId);
        }
    }
    for (const presetId of [...loadedModuleFnRefs.keys()]) {
        if (!STATIC_PRESET_IDS.has(presetId)) {
            loadedModuleFnRefs.delete(presetId);
        }
    }
    for (const retiredKey of Object.keys(RETIRED_DYNAMIC_PRESETS)) {
        delete RETIRED_DYNAMIC_PRESETS[retiredKey];
    }
    clearInMemoryPartnerCatalogForReloadTest();
    emitBuiltinPresetsChanged();
}

export function clearDynamicPartnerModulesForTest(): void {
    for (const pluginId of [...loadedPartnerModules.keys()]) {
        if (!STATIC_SHIPPED_PLUGIN_PRESET[pluginId]) {
            loadedPartnerModules.delete(pluginId);
        }
    }
    for (const presetId of [...loadedModuleFnRefs.keys()]) {
        if (!STATIC_PRESET_IDS.has(presetId)) {
            loadedModuleFnRefs.delete(presetId);
        }
    }
    for (const retiredKey of Object.keys(RETIRED_DYNAMIC_PRESETS)) {
        delete RETIRED_DYNAMIC_PRESETS[retiredKey];
    }
    clearPartnerCatalogStoreForTest();
}

export function markPartnersNoticed(ids: readonly string[]): void {
    if (recordPartnersNoticed(ids)) {
        emitNoticedPartnersChanged();
    }
}

function channelMatchesBuiltinPreset(channel: BuiltinPresetChannelLike, presetId: string, plugin: BuiltinPresetPlugin): boolean {
    if (channel.id === presetId) return true;
    try {
        const host = new URL(String(channel.baseUrl || "")).hostname;
        return Boolean(host) && (plugin.hosts.includes(host) || plugin.hostSuffixes.some((suffix) => host.endsWith(suffix)));
    } catch {
        return false;
    }
}

export function unnoticedLivePartners(
    channels: readonly BuiltinPresetChannelLike[] | undefined,
    nowMs = Date.now(),
): Array<{ id: string; name: string }> {
    const noticed = readNoticedPartnerSet();
    const list = channels ?? [];
    return Object.entries(BUILTIN_PRESETS)
        .filter(([id, plugin]) =>
            isBuiltinPartnerLiveAt(plugin, nowMs) &&
            !noticed.has(id) &&
            !list.some((ch) => channelMatchesBuiltinPreset(ch, id, plugin)),
        )
        .sort((a, b) => (a[1].order ?? 999) - (b[1].order ?? 999))
        .map(([id, plugin]) => ({ id, name: plugin.name }));
}

export function builtinPreset(id: string): BuiltinPresetPlugin | undefined {
    return BUILTIN_PRESETS[id] ?? RETIRED_DYNAMIC_PRESETS[id];
}

export function allKnownBuiltinPresets(): Array<[string, BuiltinPresetPlugin]> {
    return [...Object.entries(BUILTIN_PRESETS), ...Object.entries(RETIRED_DYNAMIC_PRESETS)];
}

/** 按协议反查它属于哪个内置插件（含已从目录退役但本机仍保留的合作伙伴协议）。 */
export function builtinPresetForProtocol(protocol?: string): BuiltinPresetPlugin | undefined {
    if (!protocol) return undefined;
    return allKnownBuiltinPresets()
        .map(([, plugin]) => plugin)
        .find((plugin) => plugin.protocolPrefixes.some((prefix) => protocol.startsWith(prefix)));
}

/** 把旧档案依次交给每个内置插件升级；不属于自己的档案原样返回。 */
export function upgradeBuiltinModelProfile<T>(profile: T, channel?: BuiltinPresetChannelLike): T {
    return allKnownBuiltinPresets().reduce((next, [, plugin]) => plugin.upgradeProfile(next, channel), profile);
}

/** 判断一组渠道中是否存在需要由内置渠道插件升级修复的本地模型档案（与对象键顺序无关）。 */
export function hasBuiltinChannelProfileUpgrade(
    channels: readonly (BuiltinPresetChannelLike & { scope?: string; modelProfiles?: readonly BuiltinModelProfile[] })[] | undefined,
): boolean {
    if (!Array.isArray(channels)) return false;
    return channels.some(
        (channel) =>
            channel &&
            channel.scope !== "system" &&
            (channel.modelProfiles ?? []).some((raw: BuiltinModelProfile) => upgradeBuiltinModelProfile(raw, channel) !== raw),
    );
}

/** 插件声明的协议是否都已经加载；没加载时不让「一键保存并启用」。 */
export function builtinProtocolsAvailable(id: string, protocols: ModelProtocolDefinition[]): boolean {
    const models = builtinPreset(id)?.models;
    if (!models) return true;
    return models.every((item) =>
        protocols.some((protocol) => protocol.value === item.protocol && protocol.capability === item.capability && protocol.enabled !== false),
    );
}
