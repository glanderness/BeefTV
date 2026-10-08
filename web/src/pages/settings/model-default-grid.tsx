import { AudioLines, Bot, Film, Image, MessageSquareText } from "lucide-react";
import { Button, Select } from "antd";

import { assistantModelOptions, normalizeAssistantModel } from "@/lib/assistant-model";
import { groupModelsByDisplayName } from "@/lib/model-selection";
import {
    filterModelsByCapability,
    isBuiltinBeefAPIChannel,
    modelDisplayName,
    resolveModelChannel,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";
import { workspaceCapabilities } from "@/services/workspace-mode";

export type DefaultModelKey = "imageModel" | "videoModel" | "textModel" | "audioModel" | "assistantModel";

type CapabilityRow = {
    kind: "capability";
    id: string;
    capability: ModelCapability;
    modelKey: DefaultModelKey;
    title: string;
    icon: typeof Image;
};

type AssistantRow = {
    kind: "assistant";
    id: string;
    modelKey: DefaultModelKey;
    title: string;
    icon: typeof Image;
};

const rows: Array<CapabilityRow | AssistantRow> = [
    { kind: "capability", id: "image", capability: "image", modelKey: "imageModel", title: "默认生图模型", icon: Image },
    { kind: "capability", id: "video", capability: "video", modelKey: "videoModel", title: "默认视频模型", icon: Film },
    { kind: "capability", id: "text", capability: "text", modelKey: "textModel", title: "默认文本模型", icon: MessageSquareText },
    { kind: "assistant", id: "assistant", modelKey: "assistantModel", title: "助手模型", icon: Bot },
    { kind: "capability", id: "audio", capability: "audio", modelKey: "audioModel", title: "默认音频模型", icon: AudioLines },
];

export function ModelDefaultGrid({ config, onChange, onOpenChannels }: { config: AiConfig; onChange: (key: DefaultModelKey, model: string) => void; onOpenChannels?: () => void }) {
    const localMode = workspaceCapabilities().local;
    const assistantModel = normalizeAssistantModel(config, config.assistantModel);
    const assistantOptions = assistantModelOptions(config);
    return (
        <div className="model-default-settings">
            {rows.map((row) => {
                const isAssistant = row.kind === "assistant";
                const models = isAssistant ? assistantOptions : filterModelsByCapability(config.models, row.capability, config.channels);
                const selected = isAssistant ? assistantModel : config[row.modelKey];
                const groups = !isAssistant && row.capability === "video"
                    ? groupModelsByDisplayName(config, models)
                    : models.map((model) => ({ key: model, models: [model] }));
                const options = groups.map((group) => {
                    const model = group.models.includes(selected) ? selected : group.models[0];
                    const label = modelDisplayName(config, model);
                    const modelChannel = resolveModelChannel(config, model);
                    const channel = isBuiltinBeefAPIChannel(modelChannel) ? "BeefTV" : modelChannel.name || "未命名渠道";
                    return { value: model, label, searchLabel: `${label} ${channel}`, channel };
                });
                if (isAssistant) options.unshift({ value: "", label: "跟随默认文本模型", searchLabel: "跟随默认文本模型", channel: "" });
                const unavailable = isAssistant ? Boolean(config.assistantModel && !selected) : Boolean(selected && !options.some((option) => option.value === selected));
                const value = unavailable ? undefined : isAssistant && !config.assistantModel ? "" : options.some((option) => option.value === selected) ? selected : undefined;
                const Icon = row.icon;
                return (
                    <section key={row.id} className="model-default-setting-row" aria-labelledby={`default-${row.id}-title`}>
                        <div className="model-default-setting-label">
                            <Icon className="size-4 shrink-0 text-foreground/50" />
                            <h3 id={`default-${row.id}-title`}>{row.title}</h3>
                        </div>
                        <div className="model-default-setting-control">
                            <Select
                                aria-label={row.title}
                                className="model-default-select"
                                value={value}
                                options={options}
                                placeholder={unavailable ? "已选模型不可用，请重新选择" : options.length ? "选择模型" : "暂无可用模型"}
                                disabled={!options.length}
                                showSearch={{ optionFilterProp: "searchLabel" }}
                                listHeight={256}
                                popupMatchSelectWidth
                                classNames={{ popup: { root: "model-default-select-popup" } }}
                                optionRender={(option) => (
                                    <div className="model-default-select-option">
                                        <span>{option.data.label}</span>
                                        {option.data.channel ? <span className="model-default-select-channel">{option.data.channel}</span> : null}
                                    </div>
                                )}
                                onChange={(model) => onChange(row.modelKey, model)}
                            />
                            {!options.length && localMode && onOpenChannels ? <Button type="link" size="small" onClick={onOpenChannels}>添加模型渠道</Button> : null}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
