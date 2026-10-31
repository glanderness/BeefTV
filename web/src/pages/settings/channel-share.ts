import { isTopazUpscaleChannel, serviceConnectionError } from "@/lib/model-service-presets";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import { createModelChannel, isBuiltinBeefAPIChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { readSharedCapabilityConfig } from "./channel-share-capabilities";

type SharedProfile = Pick<NonNullable<ModelChannel["modelProfiles"]>[number], "model" | "capability" | "protocol" | "capabilityConfig" | "displayName">;
export type SharedChannel = Pick<ModelChannel, "id" | "name" | "baseUrl" | "referenceAssetOrigin" | "apiFormat" | "interfaceType" | "models"> & { modelProfiles?: SharedProfile[] };

function object(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`渠道配置字段格式不正确：${path}`);
    return value as Record<string, unknown>;
}

function text(value: unknown, path: string, optional = false): string | undefined {
    if (value === undefined && optional) return undefined;
    if (typeof value !== "string" || (!optional && !value.trim())) throw new Error(`渠道配置字段格式不正确：${path}`);
    return value.trim();
}

function sharedFields(channel: ModelChannel): SharedChannel {
    return {
        id: channel.id, name: channel.name, baseUrl: channel.baseUrl, referenceAssetOrigin: channel.referenceAssetOrigin,
        apiFormat: channel.apiFormat, interfaceType: channel.interfaceType, models: [...channel.models],
        modelProfiles: channel.modelProfiles?.map((profile, index) => ({
            model: profile.model, capability: profile.capability, protocol: profile.protocol, displayName: profile.displayName,
            capabilityConfig: readSharedCapabilityConfig(profile.capabilityConfig, `modelProfiles[${index}].capabilityConfig`),
        })),
    };
}

export function canShareChannel(channel: ModelChannel): boolean {
    return channel.scope !== "system" && !isBuiltinBeefAPIChannel(channel) && channel.id !== "beefapi" && !isTopazUpscaleChannel(channel);
}

export function serializeChannel(channel: ModelChannel): string {
    if (!canShareChannel(channel)) throw new Error("内置、系统和 Topaz 渠道不支持导入或导出");
    return JSON.stringify({ type: "beeftv.channel", version: 1, channel: sharedFields(channel) }, null, 2);
}

export function channelShareFileName(channel: Pick<ModelChannel, "name">): string {
    const name = channel.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 50) || "channel";
    return `${name}.beeftv-channel.json`;
}

export function parseSharedChannel(json: string, protocols: ModelProtocolDefinition[]): SharedChannel {
    let decoded: unknown;
    try { decoded = JSON.parse(json.replace(/^\uFEFF/, "")); }
    catch { throw new Error("JSON 格式不正确，请检查后重试"); }
    const envelope = object(decoded, "JSON");
    if (envelope.type !== "beeftv.channel") throw new Error("不是 BeefTV 单渠道配置文件");
    if (envelope.version !== 1) throw new Error("不支持此渠道配置版本，请使用 version 1");
    const input = object(envelope.channel, "channel");
    const id = text(input.id, "id")!;
    const name = text(input.name, "name")!;
    const baseUrl = text(input.baseUrl, "baseUrl")!;
    if (id.includes("::")) throw new Error("渠道 ID 不能包含双冒号");
    if (typeof input.apiFormat !== "string" || !["openai", "gemini", "claude"].includes(input.apiFormat)) throw new Error("渠道接口格式必须是 openai、gemini 或 claude");
    if (!Array.isArray(input.models)) throw new Error("models 必须是模型名称数组");
    const models = input.models.map((model, index) => text(model, `models[${index}]`)!);
    if (models.some((model) => model.includes("::") || model === "null" || model === "undefined")) throw new Error("模型名称必须是原始模型 ID");
    if (new Set(models).size !== models.length) throw new Error("模型名称不能重复");
    const interfaceType = text(input.interfaceType, "interfaceType", true) || undefined;
    const checkProtocol = (protocol: string, capability?: ModelCapability) => {
        const definition = protocols.find((item) => item.value === protocol && item.enabled !== false);
        if (!definition) throw new Error(`当前环境没有可用的请求协议：${protocol}`);
        if (capability && definition.capability !== capability) throw new Error(`请求协议与模型能力不匹配：${protocol}`);
    };
    if (interfaceType) checkProtocol(interfaceType);
    let modelProfiles: SharedProfile[] | undefined;
    if (input.modelProfiles !== undefined) {
        if (!Array.isArray(input.modelProfiles)) throw new Error("modelProfiles 必须是模型配置数组");
        const seen = new Set<string>();
        modelProfiles = input.modelProfiles.map((raw, index) => {
            const path = `modelProfiles[${index}]`;
            const profile = object(raw, path);
            const model = text(profile.model, `${path}.model`)!;
            if (!models.includes(model) || seen.has(model)) throw new Error(`模型配置重复或不在模型列表中：${model}`);
            seen.add(model);
            if (typeof profile.capability !== "string" || !["text", "image", "video", "audio"].includes(profile.capability)) throw new Error(`模型能力无效：${model}`);
            const capability = profile.capability as ModelCapability;
            const protocol = text(profile.protocol, `${path}.protocol`, true) || undefined;
            if (protocol) checkProtocol(protocol, capability);
            else if (interfaceType) checkProtocol(interfaceType, capability);
            return {
                model, capability, protocol, displayName: text(profile.displayName, `${path}.displayName`, true),
                capabilityConfig: readSharedCapabilityConfig(profile.capabilityConfig, `${path}.capabilityConfig`),
            };
        });
    }
    // Construct from the whitelist before normalization: untrusted credential flags never enter a draft.
    const shared: SharedChannel = {
        id, name, baseUrl, apiFormat: input.apiFormat as ModelChannel["apiFormat"], interfaceType, models, modelProfiles,
        referenceAssetOrigin: text(input.referenceAssetOrigin, "referenceAssetOrigin", true),
    };
    const normalized = createModelChannel(shared);
    if (!canShareChannel(normalized)) throw new Error("内置、系统和 Topaz 渠道不支持导入或导出");
    const error = serviceConnectionError(normalized, { protocols, requireCredential: false });
    if (error) throw new Error(error);
    return sharedFields(normalized);
}

export function prepareImportedChannel(shared: SharedChannel, channels: ModelChannel[]): ModelChannel {
    const existing = channels.find((channel) => channel.id === shared.id);
    if (existing && !canShareChannel(existing)) throw new Error("内置、系统和 Topaz 渠道不支持导入或导出");
    // Local credentials and UI metadata survive; only shareable fields come from the file.
    return { ...existing, ...createModelChannel({ ...existing, ...shared }) };
}
