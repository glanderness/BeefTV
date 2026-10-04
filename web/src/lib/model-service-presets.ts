import type { ModelChannel, ModelCapability } from "@/stores/use-config-store";
import { buildApiUrl } from "@/stores/use-config-store";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";
import { inferProtocolCapabilityFromModel, type ModelProtocolDefinition } from "@/lib/model-protocols";
import type { ChannelModelCatalogItem } from "@/lib/channel-model-catalog";

export const MODEL_SERVICE_PRESETS = [
    { id: "compatible", name: "自定义服务", subtitle: "OpenAI 兼容 API · 中转服务", icon: "OpenAI", baseUrl: "", apiFormat: "openai" },
    { id: "openai", name: "OpenAI", subtitle: "文本 · 图片 · 视频", icon: "OpenAI", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" },
    { id: "gemini", name: "Google Gemini", subtitle: "文本 · 图片 · Veo 视频", icon: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini" },
    { id: "ark", name: "火山方舟", subtitle: "文本 · 即梦图片 · Seedance 视频", icon: "Volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiFormat: "openai" },
] as const;
export type ModelServicePresetId = typeof MODEL_SERVICE_PRESETS[number]["id"];
export const CAPABILITY_LABELS: Record<ModelCapability, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

export function servicePresetFor(channel: ModelChannel): ModelServicePresetId {
    try {
        const host = new URL(channel.baseUrl).hostname;
        if (host === "api.openai.com") return "openai";
        if (host === "generativelanguage.googleapis.com") return "gemini";
        if (/^ark\.[a-z0-9-]+\.volces\.com$/.test(host)) return "ark";
    } catch { /* An unfinished connection has no provider identity yet. */ }
    return "compatible";
}

// Endpoint metadata is a hint, only resolve to protocols the host actually offers.
export function serviceModelProfile(channel: ModelChannel, item: ChannelModelCatalogItem, protocols: ModelProtocolDefinition[], explicitCapability?: ModelCapability): NonNullable<ModelChannel["modelProfiles"]>[number] {
    const existing = channel.modelProfiles?.find((profile) => profile.model === item.id);
    if (existing?.protocol && !explicitCapability) return existing;
    const capability = explicitCapability || existing?.capability || item.modelType || inferProtocolCapabilityFromModel(item.id);
    const preset = channel.apiFormat === "gemini" ? "gemini" : servicePresetFor(channel);
    const candidates: Record<ModelServicePresetId, Partial<Record<ModelCapability, string>>> = {
        compatible: { text: "chat-completion", image: "openai-image", video: "newapi", audio: "openai-audio" },
        openai: { text: "openai-response", image: "openai-image", video: "newapi" },
        gemini: { text: "gemini-generate-content", image: "gemini-image", video: "gemini-veo" },
        ark: { text: "chat-completion", image: "volcengine-ark-image", video: "volcengine-ark-video" },
    };
    const endpoints: Record<string, string> = { "responses": "openai-response", "openai-responses": "openai-response", "chat.completions": "chat-completion", "chat-completions": "chat-completion", "images.generations": "openai-image", "image-generation": "openai-image", "audio.speech": "openai-audio" };
    const endpoint = item.supportedEndpointTypes?.map((value) => endpoints[value.toLowerCase()]).find((id) => protocols.some((p) => p.value === id && p.capability === capability));
    const proposed = endpoint || candidates[preset][capability];
    const protocol = protocols.find((p) => p.value === proposed && p.capability === capability && p.enabled !== false)?.value;
    return { ...existing, model: item.id, displayName: existing?.displayName || item.displayName, capability, protocol, capabilityConfig: existing?.capability === capability && existing.capabilityConfig ? existing.capabilityConfig : (capability === "image" || capability === "video") && protocol ? defaultModelCapabilityConfig(protocol, item.id) : undefined };
}

export function serviceConnectionError(channel: ModelChannel): string {
    try {
        const url = new URL(channel.baseUrl.trim());
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "请填写不含账号、查询参数或片段的 HTTP(S) 服务地址";
        if (/\/(chat\/completions|responses|images\/generations|models)\/?$/i.test(url.pathname)) return "请填写服务的基础地址，不要包含模型或生成接口路径";
    } catch { return "请填写完整的服务地址，例如 https://api.example.com/v1"; }
    if (!channel.apiKey.trim() && !channel.hasApiKey) return "请填写 API Key";
    return "";
}

export function modelCatalogRequestURL(channel: ModelChannel) {
    if (!channel.baseUrl.trim()) return "";
    try {
        if (channel.apiFormat === "gemini") return `${channel.baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "")}/v1beta/models`;
        return buildApiUrl(channel.baseUrl, "/models");
    } catch { return ""; }
}
