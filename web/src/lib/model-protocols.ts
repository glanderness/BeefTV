import type { ModelChannel } from "@/stores/use-config-store";

export type ModelProtocol = string;
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ModelProtocolWorkflow = { id: string; label: string; providerId: string; capability: ProtocolCapability; parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; min?: number; max?: number; mapping?: string }>; defaults?: Record<string, string | number | boolean> };
// module：生成接口由插件 JS 实现，模型服务里单列成一个服务商，模型列表由插件提供。
// presets：说同一种接口的服务商（名字和默认地址），在「选择服务商」里一键带出。
// aliases：旧版本里这个接口用过的 ID，已保存的模型可能还写着它们。
export type ModelProtocolPreset = { id: string; label: string; baseUrl: string };
export type ModelProtocolDefinition = { value: ModelProtocol; label: string; vendor?: string; description?: string; capability: ProtocolCapability; create: string; contentType: string; poll?: string; media: string; enabled?: boolean; baseUrl?: string; authType?: string; workflows?: ModelProtocolWorkflow[]; module?: boolean; aliases?: string[]; presets?: ModelProtocolPreset[] };

export function protocolGroups(protocols: ModelProtocolDefinition[]) {
    return (["text", "image", "video", "audio"] as ProtocolCapability[]).map((capability) => ({ label: { text: "文本", image: "图片", video: "视频", audio: "音频" }[capability], options: protocols.filter((item) => item.capability === capability && item.enabled !== false).map((item) => ({ label: `${item.label} · ${item.create.replace(/^POST /, "")}`, value: item.value })) }));
}
export function modelProtocolDefinition(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return definitions.find((item) => item.value === value) || (value ? definitions.find((item) => item.aliases?.includes(value)) : undefined); }
// 一个接口能做几种生成时（如 ComfyUI），目录里同一个 ID 会按能力各列一项，要连能力一起找。
export function modelProtocolDefinitionFor(value: string | undefined, capability: ProtocolCapability | string | undefined, definitions: ModelProtocolDefinition[] = []) {
    if (!value) return undefined;
    const matches = (item: ModelProtocolDefinition) => item.capability === capability && item.enabled !== false;
    return definitions.find((item) => item.value === value && matches(item)) || definitions.find((item) => Boolean(item.aliases?.includes(value)) && matches(item));
}
// 旧 ID 换成现在的 ID；不认识的 ID 原样保留，不替用户改掉自定义的接口。
export function canonicalModelProtocol(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.value || value; }
export function modelProtocolLabel(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.label || (value ? value : "还没选接口格式"); }
// Protocol → capability for the protocols the host ships without a plugin
// catalog. Runtime definitions win; unknown/custom ids stay unresolved so a
// user's own contract is never silently rewritten.
const BUILTIN_PROTOCOL_CAPABILITIES: Record<ModelProtocol, ProtocolCapability> = {
    "chat-completion": "text",
    "openai-response": "text",
    responses: "text",
    "claude-api": "text",
    "gemini-generate-content": "text",
    "openai-image": "image",
    "openai-videos": "video",
    "gemini-image": "image",
    "grok-image": "image",
    "volcengine-ark-image": "image",
    "volcengine-ark-agent-plan-image": "image",
    "volcengine-jimeng-image": "image",
    newapi: "video",
    "newapi-channel-1": "video",
    "newapi-channel-2": "video",
    "video-generations-json": "video",
    "openai-videos-media-json": "video",
    "vllm-omni-videos": "video",
    "xai-video": "video",
    "volcengine-ark-video": "video",
    "volcengine-ark-agent-plan-video": "video",
    "volcengine-jimeng-video": "video",
    "gemini-veo": "video",
    "novita-video": "video",
    "minimax-video": "video",
    "agnes-video": "video",
    "full-video": "video",
    "openai-audio": "audio",
    "async-audio": "audio",
};
export function modelProtocolCapability(value: string | undefined, definitions: ModelProtocolDefinition[] = []) {
    const normalized = normalizeModelProtocol(value);
    const definition = modelProtocolDefinition(normalized, definitions);
    if (definition) return definition.capability;
    return normalized ? BUILTIN_PROTOCOL_CAPABILITIES[normalized] : undefined;
}
export function isVolcengineArkImageProtocol(protocol?: string) {
    return protocol === "volcengine-ark-image" || protocol === "volcengine-ark-agent-plan-image";
}
export function isVolcengineArkVideoProtocol(protocol?: string) {
    return protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video";
}
export function protocolForModelCatalog(_endpointTypes: string[] = []): ModelProtocol | undefined {
    // A provider catalog cannot invent a protocol ID. The channel's selected
    // plugin or an explicit model configuration must supply it.
    return undefined;
}
const EXPLICIT_ENDPOINT_PROTOCOLS: Record<string, ModelProtocol> = {
    "image-generation": "openai-image",
    images: "openai-image",
    "images.generations": "openai-image",
    "openai-video": "openai-videos",
    "openai-videos": "openai-videos",
    videos: "openai-videos",
    "videos.generations": "openai-videos",
    "audio.speech": "openai-audio",
    "audio-speech": "openai-audio",
    "openai-response": "openai-response",
    "openai-responses": "openai-response",
    "openai-response-compact": "openai-response",
    responses: "openai-response",
    anthropic: "claude-api",
    "anthropic-messages": "claude-api",
    "claude-messages": "claude-api",
    messages: "claude-api",
    gemini: "gemini-generate-content",
    "gemini-generate-content": "gemini-generate-content",
    "chat.completions": "chat-completion",
    "chat-completions": "chat-completion",
};
export function protocolForEndpointHint(endpointTypes: string[] = [], overrides?: Record<string, ModelProtocol>): ModelProtocol | undefined {
    for (const raw of endpointTypes) {
        const key = raw.trim().toLowerCase();
        const mapped = overrides?.[key] ?? EXPLICIT_ENDPOINT_PROTOCOLS[key];
        if (mapped) return mapped;
    }
    return undefined;
}
export function protocolForBeefTVCatalog(endpointTypes: string[] = []): ModelProtocol | undefined {
    // Only explicit wire contracts map to host protocol IDs; generic "openai"
    // metadata cannot replace a user's configured protocol.
    return protocolForEndpointHint(endpointTypes);
}
export function modelProtocolSummary(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { const protocol = modelProtocolDefinition(value, definitions); return protocol ? [protocol.create, protocol.contentType, protocol.poll, protocol.media].filter(Boolean).join(" · ") : "还没选接口格式，或这个接口已不可用。"; }
const PROTOCOL_ALIASES: Record<string, ModelProtocol> = {
    "google-gemini-generate-content": "gemini-generate-content",
    "anthropic-messages": "claude-api",
    "claude-messages": "claude-api",
    "openai-responses": "openai-response",
};
export function normalizeModelProtocol(value: unknown): ModelProtocol | undefined {
    const protocol = typeof value === "string" && value.trim() ? value.trim() : undefined;
    return protocol ? (PROTOCOL_ALIASES[protocol] ?? protocol) : undefined;
}

export const STANDARD_PROTOCOLS: Record<ProtocolCapability, ModelProtocol[]> = {
    text: ["chat-completion", "openai-response"],
    image: ["openai-image"],
    video: ["newapi-channel-2", "newapi"],
    audio: ["openai-audio"],
};

const FALLBACK_PROTOCOLS: Record<ProtocolCapability, ModelProtocol> = {
    text: "chat-completion",
    image: "openai-image",
    video: "newapi-channel-2",
    audio: "openai-audio",
};

export function isMiniMaxVideoModelName(model: string): boolean {
    return /minimax[-/](?:video|h3)/i.test(model);
}

export function inferProtocolCapabilityFromModel(model: string): ProtocolCapability {
    const lower = model.toLowerCase();
    if (
        lower.includes("audio") ||
        lower.includes("tts") ||
        lower.includes("voice") ||
        lower.includes("speech") ||
        lower.includes("sound") ||
        lower.includes("music")
    ) {
        return "audio";
    }
    if (
        lower.includes("seedream") ||
        lower.includes("gpt-image") ||
        lower.includes("image") ||
        lower.includes("dall-e") ||
        lower.includes("dalle") ||
        lower.includes("flux") ||
        lower.includes("imagen") ||
        lower.includes("banana") ||
        lower.includes("midjourney") ||
        lower.includes("sdxl") ||
        lower.includes("stable-diffusion")
    ) {
        return "image";
    }
    if (
        lower.includes("video") ||
        lower.includes("sora") ||
        lower.includes("veo") ||
        lower.includes("kling") ||
        lower.includes("seedance") ||
        isMiniMaxVideoModelName(lower) ||
        lower.includes("hailuo") ||
        lower.includes("pika") ||
        lower.includes("runway") ||
        lower.includes("omni") ||
        lower.includes("cogvideo") ||
        lower.includes("wan")
    ) {
        return "video";
    }
    return "text";
}

export function defaultProtocolForCapability(capability: ProtocolCapability, availableProtocols: ModelProtocolDefinition[] = []): ModelProtocol {
    for (const id of STANDARD_PROTOCOLS[capability] || []) {
        if (!availableProtocols.length || availableProtocols.some((item) => item.value === id && item.enabled !== false)) return id;
    }
    const matched = availableProtocols.find((item) => item.capability === capability && item.enabled !== false);
    return matched?.value || FALLBACK_PROTOCOLS[capability] || "chat-completion";
}

export function defaultProtocolForModel(model: string, availableProtocols: ModelProtocolDefinition[] = []): ModelProtocol {
    return defaultProtocolForCapability(inferProtocolCapabilityFromModel(model), availableProtocols);
}

export function usesOpenAICompatibleProtocolDefault(apiFormat?: string) {
    return apiFormat !== "gemini" && apiFormat !== "claude";
}

type ChannelModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

export function ensureModelProfilesWithUiDefaults(
    models: string[],
    profiles: Array<Omit<ChannelModelProfile, "capability"> & { capability?: ProtocolCapability }> | undefined,
    availableProtocols: ModelProtocolDefinition[] = [],
    apiFormat?: string,
): ChannelModelProfile[] {
    const byModel = new Map((profiles || []).filter((item) => models.includes(item.model)).map((item) => [item.model, item]));
    return models.map((model) => {
        const current = byModel.get(model);
        if (current?.protocol && current.capability) return { ...current, capability: current.capability, protocol: current.protocol };
        const capability = current?.capability || modelProtocolCapability(current?.protocol, availableProtocols) || inferProtocolCapabilityFromModel(model);
        const protocol = current?.protocol || (capability !== "video" && usesOpenAICompatibleProtocolDefault(apiFormat) ? defaultProtocolForCapability(capability, availableProtocols) : undefined);
        return { ...current, model, capability, protocol };
    });
}
