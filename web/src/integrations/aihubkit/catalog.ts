import { protocolForBeefAPICatalog, type ModelProtocolDefinition } from "@/lib/model-protocols";
import type { AiConfig, ModelChannel } from "@/stores/use-config-store";
import type { HubModel } from "./api";

export const hubOrigin = "https://apimodel.aihubkit.com";

export function hubModelProtocol(model: HubModel) {
    const endpoints = (model.supported_endpoint_types || []).map((value) => value.toLowerCase());
    if (endpoints.includes("openai-video") || endpoints.includes("aihubkit-video")) return "aihubkit-video";
    return protocolForBeefAPICatalog(endpoints) || (endpoints.includes("openai") ? "chat-completion" : undefined);
}

// Import is additive: a refresh cannot discard custom models, protocol choices
// or the user's existing defaults. Unknown contracts require an explicit choice.
export function importHubModels(config: AiConfig, group: string, models: HubModel[], overrides: Record<string, string>, definitions: ModelProtocolDefinition[]): AiConfig {
    if (!group || models.length === 0) throw new Error("请选择分组和需要导入的模型");
    const id = "aihubkit-" + group;
    const previous = config.channels.find((channel) => channel.id === id);
    const profiles = new Map((previous?.modelProfiles || []).map((profile) => [profile.model, profile]));
    for (const model of models) {
        const protocol = overrides[model.id] || profiles.get(model.id)?.protocol || hubModelProtocol(model);
        const definition = definitions.find((item) => item.value === protocol && item.enabled !== false);
        if (!definition) throw new Error(`请为 ${model.id} 选择已安装的协议`);
        profiles.set(model.id, { ...profiles.get(model.id), model: model.id, capability: definition.capability, protocol });
    }
    const channel: ModelChannel = {
        ...previous, id, name: previous?.name || `aihubkit · ${group}`, scope: "user", enabled: true,
        pinned: true, apiFormat: "openai", interfaceType: "chat-completion", baseUrl: hubOrigin,
        apiKey: "", secretKey: "", headers: [], hasApiKey: true, credentialRef: "aihubkit:" + group,
        models: [...new Set([...(previous?.models || []), ...models.map((model) => model.id)])],
        modelProfiles: [...profiles.values()],
    };
    const next = { ...config, channels: [...config.channels.filter((item) => item.id !== id), channel] };
    for (const profile of channel.modelProfiles || []) {
        const field = `${profile.capability}Model` as "textModel" | "imageModel" | "videoModel" | "audioModel";
        if (!next[field]) next[field] = `${id}::${profile.model}`;
    }
    return next;
}
