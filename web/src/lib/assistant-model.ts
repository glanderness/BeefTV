import type { ModelProtocol } from "@/lib/model-protocols";
import { decodeChannelModel, encodeChannelModel, normalizeModelOptionValue, type AiConfig, type ModelChannel } from "@/stores/use-config-store";

/**
 * 画布助手只能走这三种对话协议：它需要多轮工具调用，
 * 生图/视频/音频协议和单轮补全协议都无法承载这个回路。
 */
export const ASSISTANT_MODEL_PROTOCOLS: ModelProtocol[] = ["chat-completion", "claude-api", "responses"];

/** 文本能力未显式声明协议时，渠道层按 chat-completion 发起请求，因此同样可选。 */
const DEFAULT_TEXT_PROTOCOL: ModelProtocol = "chat-completion";

function protocolSupported(protocol: ModelProtocol | undefined) {
    return ASSISTANT_MODEL_PROTOCOLS.includes(protocol?.trim() || DEFAULT_TEXT_PROTOCOL);
}

function channelAssistantModels(channel: ModelChannel) {
    if (channel.enabled === false) return [];
    return (channel.modelProfiles || [])
        .filter((profile) => profile.capability === "text" && protocolSupported(profile.protocol))
        .map((profile) => profile.model.trim())
        .filter((model) => model && channel.models.includes(model))
        .map((model) => encodeChannelModel(channel.id, model));
}

/** 助手可选模型：已启用渠道里声明为文本能力且协议受支持的模型，值形如 `channelId::modelId`。 */
export function assistantModelOptions(config: AiConfig): string[] {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const channel of config.channels) {
        for (const option of channelAssistantModels(channel)) {
            if (seen.has(option)) continue;
            seen.add(option);
            options.push(option);
        }
    }
    return options;
}

/**
 * 归一化已保存的助手模型：空值表示跟随默认文本模型，
 * 指向已删除渠道或已不受支持的协议时同样回落到空值。
 */
export function normalizeAssistantModel(config: AiConfig, value: unknown): string {
    const candidate = normalizeModelOptionValue(value, config.channels);
    if (!candidate || !decodeChannelModel(candidate)) return "";
    return assistantModelOptions(config).includes(candidate) ? candidate : "";
}

/** 助手实际使用的模型：未单独选择时跟随默认文本模型。 */
export function resolveAssistantModel(config: AiConfig): string {
    return normalizeAssistantModel(config, config.assistantModel) || config.textModel || "";
}
