import protocolDefaults from "../../../backend/internal/providerpreset/protocol_defaults.json";
import type { ModelChannel } from "@/stores/use-config-store";

export type ModelProtocol = string;
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ModelProtocolWorkflow = { id: string; label: string; providerId: string; capability: ProtocolCapability; parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>; defaults?: Record<string, string | number | boolean> };
export type ModelProtocolDefinition = { value: ModelProtocol; label: string; vendor?: string; capability: ProtocolCapability; create: string; contentType: string; poll?: string; media: string; enabled?: boolean; baseUrl?: string; authType?: string; workflows?: ModelProtocolWorkflow[]; retired?: boolean; retiredReason?: string };

export function protocolGroups(protocols: ModelProtocolDefinition[]) {
    return (["text", "image", "video", "audio"] as ProtocolCapability[]).map((capability) => ({ label: { text: "文本", image: "图片", video: "视频", audio: "音频" }[capability], options: protocols.filter((item) => item.capability === capability && selectableProtocol(item)).map((item) => ({ label: `${item.label} · ${item.create.replace(/^POST /, "")}`, value: item.value })) }));
}
export function modelProtocolDefinition(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return definitions.find((item) => item.value === value); }
export function modelProtocolLabel(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.label || (value ? value : "未安装协议"); }
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
    const definition = modelProtocolDefinition(value, definitions);
    if (definition) return definition.capability;
    return value ? BUILTIN_PROTOCOL_CAPABILITIES[value] : undefined;
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
export function protocolForBeefAPICatalog(endpointTypes: string[] = []): ModelProtocol | undefined {
    // Only explicit wire contracts map to host protocol IDs; generic "openai"
    // metadata cannot replace a user's configured protocol.
    const endpoints = endpointTypes.map((value) => value.trim().toLowerCase());
    const mappings: Array<[string, string[]]> = [
        ["openai-image", ["image-generation", "images", "images.generations"]],
        ["openai-videos", ["openai-video", "videos", "videos.generations"]],
        ["openai-audio", ["audio.speech", "audio-speech"]],
        ["openai-response", ["openai-response", "openai-response-compact", "responses"]],
        ["claude-api", ["anthropic", "messages"]],
        ["gemini-generate-content", ["gemini"]],
        ["chat-completion", ["chat.completions", "chat-completions"]],
    ];
    return mappings.find(([, aliases]) => aliases.some((alias) => endpoints.includes(alias)))?.[0];
}
export function modelProtocolSummary(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { const protocol = modelProtocolDefinition(value, definitions); return protocol ? [protocol.create, protocol.contentType, protocol.poll, protocol.media].filter(Boolean).join(" · ") : "当前协议未安装或尚未选择。"; }
export function normalizeModelProtocol(value: unknown): ModelProtocol | undefined {
    const protocol = typeof value === "string" && value.trim() ? value.trim() : undefined;
    return protocol === "google-gemini-generate-content" ? "gemini-generate-content" : protocol;
}

// Shared with the backend plugin audit (backend/internal/providerpreset), so the
// protocol a saved model runs with is decided by the same table on both sides.
const PROTOCOL_DEFAULTS = protocolDefaults as {
    legacy: Partial<Record<ProtocolCapability, ModelProtocol>>;
    preferred: Record<ProtocolCapability, ModelProtocol[]>;
    capabilityKeywords: Array<{ capability: ProtocolCapability; keywords: string[] }>;
};

export function inferProtocolCapabilityFromModel(model: string): ProtocolCapability {
    const lower = model.toLowerCase();
    return PROTOCOL_DEFAULTS.capabilityKeywords.find((group) => group.keywords.some((keyword) => lower.includes(keyword)))?.capability || "text";
}

// A retired protocol stays resolvable so saved configuration keeps showing the
// protocol it runs with, but it must never become the protocol of a new model.
export function selectableProtocol(item: ModelProtocolDefinition) {
    return item.enabled !== false && !item.retired;
}

// A profile marked protocolPending was deliberately left without a protocol: when
// it was created no protocol could safely be chosen, so the user must choose one.
// It is a distinct state from a missing protocol field, which older
// configurations use to mean "the legacy default of this capability".
export function protocolPending(profile: { protocolPending?: boolean } | undefined) {
    return profile?.protocolPending === true;
}

export function usesOpenAICompatibleProtocolDefault(apiFormat?: string) {
    return apiFormat !== "gemini" && apiFormat !== "claude";
}

// ---------------------------------------------------------------------------
// Protocol decisions. Every place that has to answer "which protocol" goes
// through one of the two functions below, and nothing else derives a default:
//
//   - savedModelProtocol: the protocol an existing model executes with. It reads
//     saved configuration only and never consults the catalog, so retiring a
//     protocol never rewrites or reroutes a model that already uses it.
//   - newModelProtocol: the protocol a model being added is given. It only
//     offers protocols the catalog proves selectable; when it cannot, the model
//     is recorded as protocolPending instead of guessing.
//
// A task that was already submitted is outside both: recovery uses the protocol
// frozen into the task, never a decision made now.
// ---------------------------------------------------------------------------

// What is known about the host catalog. "loaded" proves which protocols exist
// and which are retired; "unavailable" means the request failed, so nothing can
// be proven (the fallback list is for display and explicit choice only); an
// omitted catalog means the caller has none at hand and the last one this
// session recorded is used.
export type ProtocolCatalog = { status: "loaded" | "unavailable"; protocols: ModelProtocolDefinition[] };
type ProtocolCatalogInput = ProtocolCatalog | ModelProtocolDefinition[] | undefined;

let recordedCatalog: ProtocolCatalog | undefined;
let knownRetired = new Set<ModelProtocol>();

// Called by the catalog loader. A loaded catalog also remembers which protocols
// were retired, so a later fallback list cannot offer them again.
export function recordProtocolCatalog(catalog: ProtocolCatalog | undefined) {
    recordedCatalog = catalog;
    if (catalog?.status === "loaded") knownRetired = new Set(catalog.protocols.filter((item) => item.retired).map((item) => item.value));
    if (!catalog) knownRetired = new Set();
}
export function knownRetiredProtocol(value: ModelProtocol) { return knownRetired.has(value); }

// A plain list is a catalog the caller loaded. An empty list is what callers
// pass when they have none at hand, so it reads like an omitted catalog.
function catalogState(input: ProtocolCatalogInput): { status: "loaded" | "unavailable" | "unknown"; protocols: ModelProtocolDefinition[] } {
    if (Array.isArray(input) && input.length) return { status: "loaded", protocols: input };
    if (input && !Array.isArray(input)) return input;
    return recordedCatalog || { status: "unknown", protocols: [] };
}

export function catalogProtocols(input: ProtocolCatalogInput) { return catalogState(input).protocols; }

// Whether a proposed protocol may be assigned automatically to a new model.
export function protocolSelectableForNewModel(value: ModelProtocol | undefined, capability: ProtocolCapability | undefined, input?: ProtocolCatalogInput): boolean {
    if (!value) return false;
    const catalog = catalogState(input);
    if (catalog.status === "unavailable") return false;
    if (catalog.status === "unknown") return !knownRetired.has(value);
    return catalog.protocols.some((item) => item.value === value && (!capability || item.capability === capability) && selectableProtocol(item));
}

// A protocol a provider contract or endpoint declares for a model being added.
// It is trusted as the provider's own choice (it may be an alias the catalog
// does not list), but it is still a new assignment: not when the host is known
// to have retired it, and not when the catalog request failed, because then
// nothing proves it is still offered.
export function declaredProtocolForNewModel(value: ModelProtocol): NewProtocolDecision {
    if (catalogState(undefined).status === "unavailable" || knownRetired.has(value)) return { protocol: undefined, pending: true };
    return { protocol: value };
}

export type NewProtocolDecision = { protocol: ModelProtocol; pending?: undefined } | { protocol: undefined; pending: boolean };

// The protocol a model being added is given. `proposed` are the candidates a
// caller already knows (a provider contract, an endpoint hint, the channel's
// protocol); without them the shared preferred order applies, then any selectable
// protocol of the capability. pending is true when the catalog was consulted and
// nothing could be proven selectable; it is false only when nothing was proposed
// for a capability that has no default (video).
export function newModelProtocol(capability: ProtocolCapability, input?: ProtocolCatalogInput, proposed?: Array<ModelProtocol | undefined>): NewProtocolDecision {
    const candidates = (proposed || PROTOCOL_DEFAULTS.preferred[capability] || []).filter((item): item is ModelProtocol => Boolean(item));
    const chosen = candidates.find((value) => protocolSelectableForNewModel(value, capability, input));
    if (chosen) return { protocol: chosen };
    const catalog = catalogState(input);
    if (!proposed && catalog.status === "loaded") {
        const any = catalog.protocols.find((item) => item.capability === capability && selectableProtocol(item))?.value;
        if (any) return { protocol: any };
    }
    return { protocol: undefined, pending: candidates.length > 0 || catalog.status !== "unknown" };
}

// The protocol an existing model executes with, read from saved configuration
// only. Mirrors providerpreset.SavedModelProtocol in the backend audit, so a
// protocol a saved model resolves to is always counted as in use.
export function savedModelProtocol(
    channel: { scope?: string; apiFormat?: string; interfaceType?: string },
    profile: { capability?: ProtocolCapability; protocol?: ModelProtocol; protocolPending?: boolean } | undefined,
    model: string,
): ModelProtocol | undefined {
    const explicit = normalizeModelProtocol(profile?.protocol);
    if (explicit) return explicit;
    if (protocolPending(profile)) return undefined;
    const channelProtocol = normalizeModelProtocol(channel.interfaceType);
    if (channelProtocol) return channelProtocol;
    if (channel.scope === "system" || !usesOpenAICompatibleProtocolDefault(channel.apiFormat)) return undefined;
    return PROTOCOL_DEFAULTS.legacy[profile?.capability || inferProtocolCapabilityFromModel(model)];
}

// The protocol a saved profile of this capability without a protocol field has
// always executed with (video has none).
export function legacyDefaultProtocol(capability: ProtocolCapability): ModelProtocol | undefined {
    return PROTOCOL_DEFAULTS.legacy[capability];
}

// Thin views over newModelProtocol for callers that only need the value.
export function defaultProtocolForCapability(capability: ProtocolCapability, catalog?: ProtocolCatalogInput): ModelProtocol | undefined {
    return newModelProtocol(capability, catalog).protocol;
}

export function defaultProtocolForModel(model: string, catalog?: ProtocolCatalogInput): ModelProtocol | undefined {
    return defaultProtocolForCapability(inferProtocolCapabilityFromModel(model), catalog);
}

type ChannelModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

export function ensureModelProfilesWithUiDefaults(
    models: string[],
    profiles: Array<Omit<ChannelModelProfile, "capability"> & { capability?: ProtocolCapability }> | undefined,
    catalog?: ProtocolCatalogInput,
    apiFormat?: string,
): ChannelModelProfile[] {
    const byModel = new Map((profiles || []).filter((item) => models.includes(item.model)).map((item) => [item.model, item]));
    return models.map((model) => {
        const current = byModel.get(model);
        if (current?.protocol && current.capability) return { ...current, capability: current.capability, protocol: current.protocol };
        const capability = current?.capability || modelProtocolCapability(current?.protocol, catalogProtocols(catalog)) || inferProtocolCapabilityFromModel(model);
        // An existing model keeps what it already runs with, including a
        // deliberately unconfigured one; only a model being added is decided anew.
        if (current) {
            if (protocolPending(current)) return { ...current, model, capability, protocol: undefined, protocolPending: true };
            return { ...current, model, capability, protocol: savedModelProtocol({ apiFormat }, { ...current, capability }, model) };
        }
        if (capability === "video" || !usesOpenAICompatibleProtocolDefault(apiFormat)) return { model, capability, protocol: undefined };
        const decision = newModelProtocol(capability, catalog);
        return decision.protocol ? { model, capability, protocol: decision.protocol } : { model, capability, protocol: undefined, protocolPending: true };
    });
}
