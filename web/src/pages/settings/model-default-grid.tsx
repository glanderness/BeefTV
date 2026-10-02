import { AudioLines, Bot, Check, Film, Image, MessageSquareText } from "lucide-react";
import { Button } from "antd";
import type { ReactNode } from "react";

import { ModelIcon } from "@/components/model-picker";
import { assistantModelOptions, normalizeAssistantModel } from "@/lib/assistant-model";
import { cn } from "@/lib/utils";
import {
    filterModelsByCapability,
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
    helper: string;
};

const rows: Array<CapabilityRow | AssistantRow> = [
    { kind: "capability", id: "image", capability: "image", modelKey: "imageModel", title: "默认生图模型", icon: Image },
    { kind: "capability", id: "video", capability: "video", modelKey: "videoModel", title: "默认视频模型", icon: Film },
    { kind: "capability", id: "text", capability: "text", modelKey: "textModel", title: "默认文本模型", icon: MessageSquareText },
    { kind: "assistant", id: "assistant", modelKey: "assistantModel", title: "助手模型", icon: Bot, helper: "画布助手用这个模型理解你的要求并修改画布。" },
    { kind: "capability", id: "audio", capability: "audio", modelKey: "audioModel", title: "默认音频模型", icon: AudioLines },
];

export function ModelDefaultGrid({ config, onChange, onOpenChannels }: { config: AiConfig; onChange: (key: DefaultModelKey, model: string) => void; onOpenChannels?: () => void }) {
    const localMode = workspaceCapabilities().local;
    const assistantModel = normalizeAssistantModel(config, config.assistantModel);
    const assistantOptions = assistantModelOptions(config);
    const followsDefaultText = config.textModel ? modelDisplayName(config, config.textModel) : "尚未选择默认文本模型";

    return (
        <div className="space-y-1">
            {rows.map((row) => {
                const isAssistant = row.kind === "assistant";
                const models = isAssistant ? assistantOptions : filterModelsByCapability(config.models, row.capability, config.channels);
                const selected = isAssistant ? assistantModel : config[row.modelKey];
                const Icon = row.icon;
                return (
                    <section key={row.id} className="py-5 first:pt-0 last:pb-0" aria-labelledby={`default-${row.id}-title`}>
                        <div className="mb-3 flex items-start gap-3">
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-active text-foreground/65"><Icon className="size-4" /></span>
                            <div className="min-w-0">
                                <h3 id={`default-${row.id}-title`} className="text-sm font-semibold">{row.title}</h3>
                                {isAssistant ? <p className="mt-1 text-xs leading-5 text-foreground/50">{row.helper}</p> : null}
                            </div>
                        </div>
                        {models.length || isAssistant ? (
                            <div role="radiogroup" aria-label={row.title} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {isAssistant ? (
                                    <ModelOptionButton
                                        selected={!config.assistantModel}
                                        onSelect={() => onChange(row.modelKey, "")}
                                        icon={<MessageSquareText className="size-4 text-foreground/55" />}
                                        title="跟随默认文本模型"
                                        subtitle={followsDefaultText}
                                    />
                                ) : null}
                                {isAssistant && config.assistantModel && !selected ? <p role="status" className="text-xs text-foreground/50">已选模型不可用，请重新选择</p> : null}
                                {models.map((model) => (
                                    <ModelOptionButton
                                        key={model}
                                        selected={selected === model}
                                        onSelect={() => onChange(row.modelKey, model)}
                                        icon={<ModelIcon config={config} model={model} />}
                                        title={modelDisplayName(config, model)}
                                        subtitle={resolveModelChannel(config, model).name || "未命名渠道"}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="px-1 py-3 text-xs text-foreground/45">
                                <p>{localMode ? `尚未配置${capabilityLabel(row.capability)}模型` : `暂无${capabilityLabel(row.capability)}模型`}</p>
                                {localMode && onOpenChannels ? <Button type="link" size="small" className="mt-1 h-auto p-0 text-xs" onClick={onOpenChannels}>前往添加本地模型渠道</Button> : null}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

function ModelOptionButton({ selected, onSelect, icon, title, subtitle }: { selected: boolean; onSelect: () => void; icon: ReactNode; title: string; subtitle: string }) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            className={cn(
                "model-default-option group relative overflow-hidden rounded-md px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                selected && "is-selected",
            )}
            onClick={onSelect}
        >
            <span className="flex min-w-0 items-start gap-2.5">
                <span className="model-default-option-icon grid size-8 shrink-0 place-items-center rounded-md">{icon}</span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">{title}</span>
                    <span className="mt-1 block max-w-full truncate text-[var(--fs-tiny)] text-foreground/45">{subtitle}</span>
                </span>
                <span className={cn("model-default-option-check grid size-5 shrink-0 place-items-center rounded-full", selected ? "is-selected" : "text-transparent")}>
                    <Check className="size-3" strokeWidth={2.5} />
                </span>
            </span>
        </button>
    );
}

function capabilityLabel(capability: ModelCapability) {
    return { image: "图片", video: "视频", text: "文本", audio: "音频" }[capability];
}
