import { ChoiceBrowser, type BrowserChoice } from "./choice-browser";
import { builtinPresetForProtocol } from "@/lib/builtin-service-presets";
import { cleanChannelBaseUrl, isRawChannelBaseUrl } from "@/lib/channel-url";
import { STANDARD_PROTOCOLS, type ModelProtocolDefinition, type ProtocolCapability } from "@/lib/model-protocols";
import { protocolSignatureAuth } from "@/lib/service-credentials";

type ProtocolGroupKey = "matched" | "generic" | "local" | "partner" | "vendor";

const GROUP_META: Record<ProtocolGroupKey, { order: number; label: string; hint: string }> = {
    matched: { order: 0, label: "匹配当前服务地址", hint: "与当前渠道 Base URL 对应" },
    generic: { order: 1, label: "常用与通用兼容", hint: "OpenAI 兼容与中转站首选" },
    local: { order: 2, label: "本地与工作流接口", hint: "本机服务或工作流 API" },
    partner: { order: 3, label: "预置合作渠道专用", hint: "对应内置合作服务，一般无需改选" },
    vendor: { order: 4, label: "官方与厂商专用接口", hint: "直连平台官方 API 时按厂商选择" },
};

const STANDARD_PROTOCOL_IDS = new Set(Object.values(STANDARD_PROTOCOLS).flat());

const BOILERPLATE_VENDORS = new Set([
    "影策 / Open AI Canvas contributors",
    "BeefTV Contributors",
    "BeefTV",
    "内置协议",
]);

function extractEndpointHost(rawUrl?: string): { host: string; hostname: string } | null {
    const trimmed = rawUrl?.trim();
    if (!trimmed) return null;
    const cleaned = isRawChannelBaseUrl(trimmed) ? cleanChannelBaseUrl(trimmed) : trimmed;
    const match = /^https?:\/\/([^/?#]+)/i.exec(cleaned);
    if (!match) return null;
    const host = match[1].toLowerCase();
    const hostname = host.replace(/:\d+$/, "");
    return hostname ? { host, hostname } : null;
}

function isLoopbackHost(hostname: string): boolean {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function isLoopbackBaseUrl(rawUrl?: string): boolean {
    const parsed = extractEndpointHost(rawUrl);
    return Boolean(parsed && isLoopbackHost(parsed.hostname));
}

function isStandardProtocol(protocol: ModelProtocolDefinition): boolean {
    return STANDARD_PROTOCOL_IDS.has(protocol.value) || Boolean(protocol.aliases?.some((alias) => STANDARD_PROTOCOL_IDS.has(alias)));
}

function isLocalOrWorkflowProtocol(protocol: ModelProtocolDefinition): boolean {
    if (protocol.module || (protocol.workflows && protocol.workflows.length > 0)) return true;
    if (protocol.presets && protocol.presets.length > 0) return false;
    if (isStandardProtocol(protocol)) return false;
    return protocol.authType === "none";
}

function isLoopbackPlaceholderBaseUrl(protocol: ModelProtocolDefinition): boolean {
    return isLoopbackBaseUrl(protocol.baseUrl) && !isLocalOrWorkflowProtocol(protocol);
}

function readableHostLabel(rawUrl?: string): string {
    const parsed = extractEndpointHost(rawUrl);
    if (!parsed || isLoopbackHost(parsed.hostname)) return "";
    // 去掉 {region} / {location} / {resource} 占位前缀，保留易认的主域名。
    return parsed.hostname.replace(/^\{[^}]+\}[.-]?/g, "");
}

function matchingProtocolPreset(protocol: ModelProtocolDefinition, channelBaseUrl?: string) {
    const channel = extractEndpointHost(channelBaseUrl);
    if (!channel) return undefined;
    return protocol.presets?.find((preset) => {
        const endpoint = extractEndpointHost(preset.baseUrl);
        if (!endpoint) return false;
        return isLoopbackHost(channel.hostname) ? endpoint.host === channel.host : endpoint.hostname === channel.hostname;
    });
}

function matchesChannelBaseUrl(protocol: ModelProtocolDefinition, channelBaseUrl?: string): boolean {
    const channelHost = extractEndpointHost(channelBaseUrl);
    if (!channelHost) return false;

    const protocolHost = extractEndpointHost(protocol.baseUrl);
    if (protocolHost) {
        if (isLoopbackHost(protocolHost.hostname) || isLoopbackHost(channelHost.hostname)) {
            if (isLocalOrWorkflowProtocol(protocol) && isLoopbackHost(protocolHost.hostname) && protocolHost.host === channelHost.host) {
                return true;
            }
        } else if (protocolHost.hostname === channelHost.hostname) {
            return true;
        } else {
            const suffix = readableHostLabel(protocol.baseUrl);
            if (suffix && protocolHost.hostname.includes("{") && channelHost.hostname.endsWith(`.${suffix}`)) {
                return true;
            }
        }
    }

    if (isLoopbackHost(channelHost.hostname)) return false;
    const preset = builtinPresetForProtocol(protocol.value);
    if (preset) {
        if (preset.hosts.some((host) => host.toLowerCase() === channelHost.hostname)) return true;
        if (preset.hostSuffixes.some((suffix) => channelHost.hostname.endsWith(suffix.toLowerCase()))) return true;
    }
    return false;
}

function isGenericProtocol(protocol: ModelProtocolDefinition): boolean {
    if (isStandardProtocol(protocol)) return true;
    if (protocol.presets && protocol.presets.length > 0) return true;
    if (isLocalOrWorkflowProtocol(protocol)) return false;
    if (!protocol.baseUrl?.trim()) return true;
    if (isLoopbackPlaceholderBaseUrl(protocol)) return true;
    return false;
}

function protocolGroupKey(protocol: ModelProtocolDefinition, channelBaseUrl?: string): ProtocolGroupKey {
    if (matchesChannelBaseUrl(protocol, channelBaseUrl)) return "matched";
    if (isLocalOrWorkflowProtocol(protocol)) return "local";
    if (isGenericProtocol(protocol)) return "generic";
    if (builtinPresetForProtocol(protocol.value)) return "partner";
    return "vendor";
}

function protocolVendorTag(protocol: ModelProtocolDefinition, group: ProtocolGroupKey): string {
    const preset = builtinPresetForProtocol(protocol.value);
    if (preset) return preset.name;
    const host = readableHostLabel(protocol.baseUrl);
    if (host) return host;
    const vendor = protocol.vendor?.trim() || "";
    if (vendor && !BOILERPLATE_VENDORS.has(vendor)) return vendor;
    if (group === "local") return "本地 / 工作流";
    if (group === "generic") return "通用兼容";
    return "";
}

function protocolDescription(protocol: ModelProtocolDefinition, group: ProtocolGroupKey): string {
    const raw = protocol.description?.trim() || "";
    if (raw && raw !== protocol.label && !/独立请求协议插件[。.]?$/.test(raw)) return raw;
    const preset = builtinPresetForProtocol(protocol.value);
    if (preset) return `适用于「${preset.name}」渠道的专用接口。`;
    if (protocol.workflows?.length) return "工作流接口，模型 ID 请填写服务商提供的工作流标识。";
    if (protocol.authType === "none") return "本地服务接口，通常无需填写 API Key。";
    if (protocolSignatureAuth(protocol.value, protocol.authType)) return "官方签名接口，需成对填写 Access Key 与 Secret Key。";
    if (group === "generic" || (group === "matched" && isGenericProtocol(protocol))) {
        if (protocol.presets?.length) return "标准兼容接口，适用于多数中转站与 OpenAI 兼容服务商。";
        return "通用兼容接口，适用于 OpenAI 兼容或中转站服务。";
    }
    const host = readableHostLabel(protocol.baseUrl);
    return host ? `适用于 ${host} 官方直连接口。` : "按服务商接口文档核对请求路径与字段。";
}

function protocolAuthLabel(protocol: ModelProtocolDefinition): string {
    if (protocol.authType === "none") return "无需密钥";
    if (protocolSignatureAuth(protocol.value, protocol.authType)) return "双密钥签名（AK/SK）";
    if (protocol.authType === "google-api-key") return "Google API Key";
    if (protocol.authType === "anthropic") return "Anthropic API Key";
    return "";
}

function protocolEndpointHint(protocol: ModelProtocolDefinition): string | undefined {
    const baseUrl = protocol.baseUrl?.trim() || "";
    if (baseUrl.includes("{")) {
        return "建议地址中的花括号占位符请替换为你的实际区域或资源名，Base URL 无需拼接请求路径。";
    }
    return undefined;
}

export function buildProtocolBrowserOptions(
    protocols: ModelProtocolDefinition[],
    capability?: ProtocolCapability,
    channelBaseUrl?: string,
): BrowserChoice[] {
    const filtered = protocols.filter((protocol) => (!capability || protocol.capability === capability) && protocol.enabled !== false);
    const preferredOrder = capability ? STANDARD_PROTOCOLS[capability] || [] : [];

    const ranked = filtered.map((protocol) => {
        const endpointPreset = matchingProtocolPreset(protocol, channelBaseUrl);
        const group = endpointPreset ? "matched" : protocolGroupKey(protocol, channelBaseUrl);
        const preferredIndex = preferredOrder.indexOf(protocol.value);
        const familyKey = builtinPresetForProtocol(protocol.value)?.name || readableHostLabel(protocol.baseUrl) || protocol.label;
        return { protocol, group, preferredIndex, familyKey, endpointPreset };
    });

    ranked.sort((left, right) => {
        const groupDiff = GROUP_META[left.group].order - GROUP_META[right.group].order;
        if (groupDiff !== 0) return groupDiff;
        if (left.group === "generic" || left.group === "matched") {
            const leftRank = left.preferredIndex >= 0 ? left.preferredIndex : Number.MAX_SAFE_INTEGER;
            const rightRank = right.preferredIndex >= 0 ? right.preferredIndex : Number.MAX_SAFE_INTEGER;
            if (leftRank !== rightRank) return leftRank - rightRank;
        }
        const familyDiff = left.familyKey.localeCompare(right.familyKey, "zh-CN");
        if (familyDiff !== 0) return familyDiff;
        return left.protocol.label.localeCompare(right.protocol.label, "zh-CN");
    });

    return ranked.map(({ protocol, group, endpointPreset }) => {
        const meta = GROUP_META[group];
        const preset = builtinPresetForProtocol(protocol.value);
        const authLabel = protocolAuthLabel(protocol);
        const suggestedBaseUrl = endpointPreset?.baseUrl.trim() || (!isLoopbackPlaceholderBaseUrl(protocol) ? protocol.baseUrl?.trim() : "");
        const details: BrowserChoice["details"] = [
            ...(suggestedBaseUrl ? [{ label: "建议地址", value: <code>{suggestedBaseUrl}</code> }] : []),
            { label: "请求", value: <code>{protocol.create}</code> },
            ...(protocol.poll ? [{ label: "轮询", value: <code>{protocol.poll}</code> }] : []),
            { label: "请求体", value: protocol.contentType },
            { label: "响应", value: protocol.poll ? "异步轮询" : "同步响应" },
            ...(authLabel ? [{ label: "鉴权", value: authLabel }] : []),
            { label: "来源", value: protocol.media },
        ];
        const searchTerms = [
            protocol.value,
            protocol.vendor,
            protocol.baseUrl,
            preset?.name,
            ...(protocol.presets?.map((item) => item.label) || []),
        ].filter(Boolean);

        return {
            value: protocol.value,
            label: protocol.label,
            subtitle: protocol.create,
            vendor: endpointPreset?.label || protocolVendorTag(protocol, group),
            group: meta.label,
            groupHint: meta.hint,
            description: protocolDescription(protocol, group),
            hint: protocolEndpointHint(protocol),
            searchText: searchTerms.join(" "),
            details,
        };
    });
}

export function ModelProtocolBrowser({
    capability,
    protocols,
    channelBaseUrl,
    ...props
}: {
    capability?: ProtocolCapability;
    protocols: ModelProtocolDefinition[];
    channelBaseUrl?: string;
    value?: string;
    onChange?: (value: string) => void;
    loading?: boolean;
    error?: string;
    disabled?: boolean;
    id?: string;
}) {
    const options = buildProtocolBrowserOptions(protocols, capability, channelBaseUrl);

    return <ChoiceBrowser key={capability || "all"} {...props} label="接口格式" placeholder="搜索接口名称、服务商域名或请求路径" options={options} />;
}
