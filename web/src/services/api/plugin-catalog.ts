import { http } from "@/services/api/request";
import { knownRetiredProtocol, recordProtocolCatalog, type ModelProtocolDefinition, type ProtocolCapability, type ProtocolCatalog } from "@/lib/model-protocols";

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
    authType?: string;
    workflows?: Array<{
        id: string;
        label: string;
        providerId: string;
        capability: ProtocolCapability;
        parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>;
        defaults?: Record<string, string | number | boolean>;
    }>;
    // A protocol this release no longer ships but that stays executable for
    // configuration saved before the removal.
    retired?: boolean;
    retiredReason?: string;
};

// Loads the host protocol catalog and records it for the protocol decisions in
// model-protocols.ts. A failed request is reported as "unavailable" rather than
// as a list: the built-in fallback keeps a custom channel configurable by hand,
// but it proves nothing about which protocols are still selectable, so no model
// is assigned one of them automatically.
export async function loadProtocolCatalog(scope: string, capability?: ProtocolCapability): Promise<ProtocolCatalog> {
    try {
        const result = await http.get<{ providers: PluginProviderCatalogItem[] }>("/plugins/catalog", { params: { scope, capability } });
        const catalog: ProtocolCatalog = { status: "loaded", protocols: result.providers.filter((item) => item.enabled && !item.unavailableReason).map(providerCatalogDefinition) };
        // A capability-filtered list would make every other capability look empty.
        if (!capability) recordProtocolCatalog(catalog);
        return catalog;
    } catch (error) {
        // The local desktop profile can run without the optional plugin center.
        if (scope === "user.custom-channel") {
            const fallback = BUILTIN_OPENAI_PROTOCOLS.filter((item) => (!capability || item.capability === capability) && !knownRetiredProtocol(item.value));
            if (fallback.length) {
                const catalog: ProtocolCatalog = { status: "unavailable", protocols: fallback };
                if (!capability) recordProtocolCatalog(catalog);
                return catalog;
            }
        }
        throw error;
    }
}

const BUILTIN_OPENAI_PROTOCOLS: ModelProtocolDefinition[] = [
    { value: "chat-completion", label: "OpenAI Chat Completions", vendor: "OpenAI", capability: "text", create: "POST /v1/chat/completions", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-response", label: "OpenAI Responses", vendor: "OpenAI", capability: "text", create: "POST /v1/responses", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "openai-image", label: "OpenAI Images", vendor: "OpenAI", capability: "image", create: "POST /v1/images/generations", contentType: "application/json", media: "内置协议", enabled: true },
    { value: "newapi", label: "OpenAI Videos", vendor: "OpenAI compatible", capability: "video", create: "POST /v1/videos", poll: "GET /v1/videos/{task_id}", contentType: "multipart/form-data", media: "内置协议", enabled: true },
];

// A retired protocol stays in the list so saved configuration keeps showing the
// protocol and request it runs with; the pickers mark it as not selectable for a
// new choice.
export function providerCatalogDefinition(item: PluginProviderCatalogItem): ModelProtocolDefinition {
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
        authType: item.authType,
        workflows: item.workflows || [],
        retired: item.retired,
        retiredReason: item.retiredReason,
    };
}
