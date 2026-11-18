import type { ModelCapability } from "@/stores/use-config-store";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
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

export { LL2_CHANNEL_ID, YSDUI_CHANNEL_ID };

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

// 内置插件在设置页里的行为都从这里查表：归属判定、预置模型、协议可用性、
// 新建渠道和旧档案升级。热更新后的内置插件在客户端激活时会原地刷新对应条目。
export type BuiltinPresetPlugin = {
    name: string;
    subtitle: string;
    icon: string;
    baseUrl: string;
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

export const BUILTIN_PRESETS: Record<string, BuiltinPresetPlugin> = {
    [LL2_CHANNEL_ID]: {
        name: LL2_CHANNEL_NAME,
        subtitle: "文本 · 多款主流视频 · 视频超分",
        icon: "OpenAI",
        baseUrl: LL2_DEFAULT_BASE_URL,
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
        name: YSDUI_CHANNEL_NAME,
        subtitle: "文本 · 多款主流图片 · 多款主流视频",
        icon: YSDUI_CHANNEL_ICON,
        baseUrl: YSDUI_DEFAULT_BASE_URL,
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

const BUILTIN_PLUGIN_CHANNEL_ID: Record<string, string> = {
    "beeftv-plugin-ll2": LL2_CHANNEL_ID,
    "beeftv-plugin-ysdui": YSDUI_CHANNEL_ID,
};

/**
 * 当内置渠道插件通过在线热更新加载了新版本 client/index.js 时，
 * 把新模块导出的服务元数据、预置模型清单、buildChannel 与 upgradeProfile 同步到宿主预设表。
 */
export function syncBuiltinPresetFromModule(pluginId: string, mod: unknown): boolean {
    if (!mod || typeof mod !== "object") return false;
    const expectedId = BUILTIN_PLUGIN_CHANNEL_ID[pluginId];
    if (!expectedId) return false;
    const record = mod as Record<string, unknown>;
    const defaultExport = record.default && typeof record.default === "object" ? (record.default as Record<string, unknown>) : undefined;
    const raw = (record.BUILTIN_SERVICE_PRESET ?? defaultExport?.BUILTIN_SERVICE_PRESET) as Record<string, unknown> | undefined;
    const current = BUILTIN_PRESETS[expectedId];
    if (!current || !raw || typeof raw !== "object") return false;
    const models = Array.isArray(raw.models) ? (raw.models as BuiltinPresetModel[]) : undefined;
    const buildChannel = typeof raw.buildChannel === "function" ? (raw.buildChannel as BuiltinPresetPlugin["buildChannel"]) : undefined;
    const upgradeProfile = typeof raw.upgradeProfile === "function" ? (raw.upgradeProfile as BuiltinPresetPlugin["upgradeProfile"]) : undefined;
    if (!models || !buildChannel || !upgradeProfile) return false;

    const nextBaseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : current.baseUrl;
    const baseHosts = Array.isArray(raw.hosts) ? [...(raw.hosts as string[])] : [...current.hosts];
    try {
        const nextHostname = new URL(nextBaseUrl).hostname;
        if (nextHostname && !baseHosts.includes(nextHostname)) baseHosts.push(nextHostname);
    } catch {
        // ignore invalid URL; serviceConnectionError validates user input
    }

    BUILTIN_PRESETS[expectedId] = {
        ...current,
        name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : current.name,
        subtitle: typeof raw.subtitle === "string" && raw.subtitle.trim() ? raw.subtitle.trim() : current.subtitle,
        icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : current.icon,
        baseUrl: nextBaseUrl,
        protocolPrefixes: Array.isArray(raw.protocolPrefixes) ? (raw.protocolPrefixes as string[]) : current.protocolPrefixes,
        hosts: baseHosts,
        hostSuffixes: Array.isArray(raw.hostSuffixes) ? (raw.hostSuffixes as string[]) : current.hostSuffixes,
        candidates: raw.candidates && typeof raw.candidates === "object" ? (raw.candidates as Partial<Record<ModelCapability, string>>) : current.candidates,
        models,
        presetDescription: typeof raw.presetDescription === "string" ? raw.presetDescription : current.presetDescription,
        providerIntro: typeof raw.providerIntro === "string" ? raw.providerIntro : current.providerIntro,
        declaresReferenceMediaTransport:
            typeof raw.declaresReferenceMediaTransport === "boolean" ? raw.declaresReferenceMediaTransport : current.declaresReferenceMediaTransport,
        buildChannel,
        upgradeProfile,
    };
    return true;
}

export function builtinPreset(id: string): BuiltinPresetPlugin | undefined {
    return BUILTIN_PRESETS[id];
}

/** 按协议反查它属于哪个内置插件。 */
export function builtinPresetForProtocol(protocol?: string): BuiltinPresetPlugin | undefined {
    if (!protocol) return undefined;
    return Object.values(BUILTIN_PRESETS).find((plugin) => plugin.protocolPrefixes.some((prefix) => protocol.startsWith(prefix)));
}

/** 把旧档案依次交给每个内置插件升级；不属于自己的档案原样返回。 */
export function upgradeBuiltinModelProfile<T>(profile: T, channel?: BuiltinPresetChannelLike): T {
    return Object.values(BUILTIN_PRESETS).reduce((next, plugin) => plugin.upgradeProfile(next, channel), profile);
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
