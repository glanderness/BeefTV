import type { ModelChannel, ModelCapability } from "@/stores/use-config-store";
import { buildApiUrl } from "@/stores/use-config-store";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { inferProtocolCapabilityFromModel, modelProtocolCapability, newModelProtocol, protocolPending, protocolSelectableForNewModel, savedModelProtocol, type ModelProtocolDefinition, type ProtocolCatalog } from "@/lib/model-protocols";
import { catalogEndpointCapability, type ChannelModelCatalogItem } from "@/lib/channel-model-catalog";

export const MODEL_SERVICE_PRESETS = [
    { id: "compatible", name: "第三方模型服务", subtitle: "OpenAI 兼容 API · 中转服务", icon: "OpenAI", baseUrl: "", apiFormat: "openai" },
    { id: "openai", name: "OpenAI", subtitle: "文本 · 图片 · 视频", icon: "OpenAI", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" },
    { id: "gemini", name: "Google Gemini", subtitle: "文本 · 图片 · Veo 视频", icon: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini" },
    { id: "ark", name: "火山方舟", subtitle: "文本 · 即梦图片 · Seedance 视频", icon: "Volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiFormat: "openai" },
] as const;
export type ModelServicePresetId = typeof MODEL_SERVICE_PRESETS[number]["id"];
export const CAPABILITY_LABELS: Record<ModelCapability, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

export function isTopazUpscaleChannel(channel: Pick<ModelChannel, "id" | "models">): boolean {
    return channel.id === "fal-topaz-upscale" || channel.models.some(model => model.replace(/^\/+/, "").startsWith("topaz/upscale/"));
}

export function servicePresetFor(channel: ModelChannel): ModelServicePresetId {
    try {
        const host = new URL(channel.baseUrl).hostname;
        if (host === "api.openai.com") return "openai";
        if (host === "generativelanguage.googleapis.com") return "gemini";
        if (/^ark\.[a-z0-9-]+\.volces\.com$/.test(host) || host === "ark.ap-southeast.bytepluses.com") return "ark";
    } catch { /* An unfinished connection has no provider identity yet. */ }
    return "compatible";
}

// Endpoint metadata is a hint, only resolve to protocols the host actually offers.
// The protocol of a model being added is decided by newModelProtocol, so a
// retired protocol or an unproven fallback list is never assigned automatically.
type ServiceModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

export function serviceModelProfile(channel: ModelChannel, item: ChannelModelCatalogItem, catalog: ProtocolCatalog | ModelProtocolDefinition[], explicitCapability?: ModelCapability): ServiceModelProfile {
    const protocols = Array.isArray(catalog) ? catalog : catalog.protocols;
    const existing = channel.modelProfiles?.find((profile) => profile.model === item.id);
    // A model the channel already has keeps what it runs with: an explicit
    // protocol, the legacy default a profile without the field has always used,
    // or a deliberate "left unconfigured" mark. Only a model without any saved
    // protocol is decided anew below.
    if (!explicitCapability && existing && protocolPending(existing)) return existing;
    const saved = !explicitCapability && (existing || channel.models.includes(item.id)) ? savedModelProtocol(channel, existing, item.id) : undefined;
    // What savedModelProtocol returns is what the request runs with, so the
    // model name never overrules it and a failed catalog request proves nothing
    // against it. An explicit profile protocol is always kept. A protocol the
    // model only inherits (channel protocol or legacy default) is not kept when
    // it could never have run: the profile states a different capability, or a
    // loaded catalog shows the host does not install or enable it. Then the user
    // is asked, as before. A retired protocol is still installed and stays.
    const savedCapability = saved ? modelProtocolCapability(saved, protocols) : undefined;
    const savedInherited = Boolean(saved && !existing?.protocol);
    const mismatched = savedInherited && Boolean(existing?.capability && savedCapability && savedCapability !== existing!.capability);
    const loadedCatalog = Array.isArray(catalog) ? catalog.length > 0 : catalog.status === "loaded";
    const notInstalled = savedInherited && loadedCatalog && !protocols.some((protocol) => protocol.value === saved && protocol.enabled !== false);
    if (saved && !mismatched && !notInstalled) {
        const current: ServiceModelProfile = existing
            ? { ...existing, protocol: saved }
            : { model: item.id, capability: savedCapability || inferProtocolCapabilityFromModel(item.id), protocol: saved };
        const definition = protocols.find((protocol) => protocol.value === saved && protocol.enabled !== false);
        return definition && definition.authType !== current.authType ? { ...current, authType: definition.authType } : current;
    }
    const fullvideoFull = ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"].includes(item.id);
    const capability = explicitCapability || existing?.capability || item.modelType || catalogEndpointCapability(item) || (fullvideoFull ? "video" : inferProtocolCapabilityFromModel(item.id));
    const preset = channel.apiFormat === "gemini" ? "gemini" : servicePresetFor(channel);
    const candidates: Record<ModelServicePresetId, Partial<Record<ModelCapability, string>>> = {
        compatible: { text: "chat-completion", image: "openai-image", audio: "openai-audio" },
        openai: { text: "openai-response", image: "openai-image", video: "newapi" },
        gemini: { text: "gemini-generate-content", image: "gemini-image", video: "gemini-veo" },
        ark: { text: "chat-completion", image: "volcengine-ark-image", video: "volcengine-ark-video" },
    };
    const endpoints: Record<string, string> = { "responses": "openai-response", "openai-responses": "openai-response", "chat.completions": "chat-completion", "chat-completions": "chat-completion", "images.generations": "openai-image", "image-generation": "openai-image", "audio.speech": "openai-audio", "openai-video": "newapi", "openai-videos": "newapi", "video-generations-json": "video-generations-json", "volcengine-ark-video": "volcengine-ark-video" };
    const endpoint = item.supportedEndpointTypes?.map((value) => endpoints[value.trim().toLowerCase()]).find((id) => protocolSelectableForNewModel(id, capability, catalog));
    const inherited = protocolSelectableForNewModel(channel.interfaceType, capability, catalog) ? channel.interfaceType : undefined;
    let proposed = inherited || endpoint || candidates[preset][capability];
    // Model names identify a family, not a provider's wire protocol. Ask the
    // user to select its contract unless the catalog explicitly declares it.
    if (fullvideoFull && capability === "video" && !inherited) proposed = item.supportedEndpointTypes?.includes("full-video") ? "full-video" : undefined;
    const decision = newModelProtocol(capability, catalog, [proposed]);
    const protocol = decision.protocol;
    const definition = protocols.find((p) => p.value === protocol);
    // Keep the whole decision: without the mark, savedModelProtocol would later
    // give this profile the legacy default the catalog just refused.
    const protocolPendingMark = protocol ? undefined : decision.pending || undefined;
    return { ...existing, model: item.id, displayName: existing?.displayName || item.displayName, capability, protocol, protocolPending: protocolPendingMark, authType: definition ? definition.authType : existing?.authType, capabilityConfig: existing?.capability === capability && existing.capabilityConfig ? existing.capabilityConfig : (capability === "image" || capability === "video") && protocol ? defaultModelCapabilityConfig(protocol, item.id) : undefined };
}

export function channelAllowsEmptyAPIKey(channel: Pick<ModelChannel, "models" | "modelProfiles" | "interfaceType">, protocols?: ModelProtocolDefinition[]) {
    const models = (channel.models || []).map((model) => model.trim()).filter(Boolean);
    if (!models.length) return false;
    return models.every((model) => {
        const profile = channel.modelProfiles?.find((item) => item.model === model);
        const protocolId = profile?.protocol || channel.interfaceType;
        if (!protocolId) return false;
        const listed = protocols?.find((item) => item.value === protocolId);
        const auth = listed ? listed.authType : profile?.authType;
        return auth === "none";
    });
}

export function serviceConnectionError(channel: ModelChannel, options?: { protocols?: ModelProtocolDefinition[]; requireCredential?: boolean }): string {
    if (channel.referenceAssetOrigin?.trim()) {
        try {
            const origin = new URL(channel.referenceAssetOrigin.trim());
            if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return "素材服务地址只填写源站，不包含路径、账号或查询参数。公网请使用 HTTPS；本机、局域网或 CGNAT 可使用 HTTP 和端口";
        } catch { return "请填写完整的素材服务地址"; }
    }
    try {
        const url = new URL(channel.baseUrl.trim());
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "请填写不含账号、查询参数或片段的 HTTP(S) 服务地址";
        if (/\/(chat\/completions|responses|images\/generations|models)\/?$/i.test(url.pathname)) return "请填写服务的基础地址，不要包含模型或生成接口路径";
    } catch { return "请填写完整的服务地址，例如 https://api.example.com/v1"; }
    if (options?.requireCredential !== false && !channel.apiKey.trim() && !channel.hasApiKey && !channelAllowsEmptyAPIKey(channel, options?.protocols)) return "请填写 API Key";
    return "";
}

export function modelCatalogRequestURL(channel: ModelChannel) {
    if (!channel.baseUrl.trim()) return "";
    try {
        if (channel.apiFormat === "gemini") return `${channel.baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "")}/v1beta/models`;
        return buildApiUrl(channel.baseUrl, "/models");
    } catch { return ""; }
}
