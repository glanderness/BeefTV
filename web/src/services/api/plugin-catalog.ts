import { http } from "@/services/api/request";
import type { ModelProtocolDefinition, ProtocolCapability } from "@/lib/model-protocols";

type PluginProviderCatalogItem = {
    id: string;
    version: string;
    name: string;
    vendor: string;
    categories: string[];
    scopes: string[];
    create?: string;
    poll?: string;
    contentType?: string;
    enabled: boolean;
    unavailableReason?: string;
    baseUrl?: string;
    workflows?: Array<{
        id: string;
        label: string;
        providerId: string;
        capability: ProtocolCapability;
        parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>;
        defaults?: Record<string, string | number | boolean>;
    }>;
};

export async function fetchPluginProviderCatalog(scope: string, capability?: ProtocolCapability) {
    const fallbackProtocols = () => BUILTIN_OPENAI_PROTOCOLS.filter((item) => !capability || item.capability === capability);
    try {
        // 本地与托管共用后端插件目录：音频（openai-audio / async-audio）等官方协议
        // 只存在于插件包里，本地模式短路会让这些协议在选择器中彻底消失。
        const result = await http.get<{ providers: PluginProviderCatalogItem[] }>("/plugins/catalog", { params: { scope, capability } });
        const providers = result.providers.filter((item) => item.enabled && !item.unavailableReason).map(toProviderDefinition);
        if (providers.length) return providers;
    } catch (error) {
        // 桌面 profile 可能在插件中心不可用时启动；保底协议让自定义渠道仍可用。
        if (scope === "user.custom-channel" && fallbackProtocols().length) return fallbackProtocols();
        throw error;
    }
    // 目录可用但没有匹配项时，自定义渠道仍退回保底协议。
    return scope === "user.custom-channel" ? fallbackProtocols() : [];
}

const BUILTIN_OPENAI_PROTOCOLS: ModelProtocolDefinition[] = [
    { value: "chat-completion", label: "OpenAI Chat Completions", vendor: "OpenAI", capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-response", label: "OpenAI Responses", vendor: "OpenAI", capability: "text", create: "POST /v1/responses", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-image", label: "OpenAI Images", vendor: "OpenAI", capability: "image", create: "POST /v1/images/generations", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "newapi", label: "OpenAI Videos", vendor: "OpenAI compatible", capability: "video", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "multipart/form-data", media: "内置协议", enabled: true },
];

function toProviderDefinition(item: PluginProviderCatalogItem): ModelProtocolDefinition {
    return {
        value: item.id,
        label: item.name,
        vendor: item.vendor,
        capability: (item.categories[0] || "text") as ProtocolCapability,
        create: item.create || "",
        poll: item.poll,
        contentType: item.contentType || "application/json",
        media: `${item.vendor} · ${item.version}`,
        enabled: item.enabled && !item.unavailableReason,
        baseUrl: item.baseUrl,
        workflows: item.workflows || [],
    };
}
