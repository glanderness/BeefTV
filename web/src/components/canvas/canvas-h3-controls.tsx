import { Button, InputNumber, Select } from "antd";
import type {
    VideoCapabilityConfig,
    VideoDamageLevel,
    VideoGenerationControls,
    VideoGenerationControlsCapability,
    VideoPromptExpansionMode,
} from "@/lib/model-capabilities";
import type { CanvasNodeMetadata } from "@/types/canvas";

const videoSettingsText = { fontSize: "var(--fs-caption)", fontWeight: 500 };
const selectStyles = { root: videoSettingsText, popup: { listItem: videoSettingsText } };

const PROMPT_EXPANSION_LABELS: Record<VideoPromptExpansionMode, string> = {
    balanced: "均衡",
    quality: "高质量",
    fast: "快速",
    disabled: "关闭",
};

const DAMAGE_LEVEL_LABELS: Record<VideoDamageLevel, string> = {
    light: "轻度",
    medium: "中度",
    heavy: "重度",
};

export function CanvasH3UnsupportedFrames({
    metadata,
    middleFrameSupported = false,
    endFrameSupported = true,
    onChange,
}: {
    metadata?: CanvasNodeMetadata;
    middleFrameSupported?: boolean;
    endFrameSupported?: boolean;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const endUnsupported = !endFrameSupported && Boolean(metadata?.videoEndFrameNodeId);
    const middleUnsupported = !middleFrameSupported && Boolean(metadata?.videoMiddleFrameNodeId || metadata?.videoMiddleFrameTime !== undefined);
    if (!endUnsupported && !middleUnsupported) return null;
    return <div className="mt-2 flex flex-col gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium"><span>当前模型不支持此前选择的尾帧或中间帧。</span><Button size="small" style={videoSettingsText} onClick={() => onChange({ ...(endUnsupported ? { videoEndFrameNodeId: undefined } : {}), ...(middleUnsupported ? { videoMiddleFrameNodeId: undefined, videoMiddleFrameTime: undefined } : {}) })}>清除不支持的帧设置</Button></div>;
}

export function CanvasH3Controls({
    controls,
    durationConfig,
    value = {},
    onChange,
    duration,
    onDurationChange,
}: {
    controls?: VideoGenerationControlsCapability;
    durationConfig?: VideoCapabilityConfig["duration"];
    value?: VideoGenerationControls;
    onChange: (value: VideoGenerationControls) => void;
    duration?: string;
    onDurationChange?: (value: string) => void;
}) {
    const showDuration = Boolean(durationConfig?.continuous && onDurationChange);
    const expansionModes = controls?.promptExpansionModes?.length ? controls.promptExpansionModes : undefined;
    const showSeed = Boolean(controls?.seed);
    const damageLevels = controls?.damageLevels?.length ? controls.damageLevels : undefined;
    if (!showDuration && !expansionModes && !showSeed && !damageLevels) return null;

    const selectedExpansion = expansionModes
        ? value.prompt_expansion_mode && expansionModes.includes(value.prompt_expansion_mode)
            ? value.prompt_expansion_mode
            : expansionModes.includes("balanced")
              ? "balanced"
              : expansionModes[0]
        : undefined;
    const selectedDamage = damageLevels
        ? value.damage_level && damageLevels.includes(value.damage_level)
            ? value.damage_level
            : damageLevels.includes("medium")
              ? "medium"
              : damageLevels[0]
        : undefined;
    const durationMin = durationConfig?.fractionalMin ?? durationConfig?.min ?? 0.92;
    const durationMax = durationConfig?.max ?? 15;

    return (
        <details className="rounded-lg px-3 py-2" data-canvas-no-zoom>
            <summary className="cursor-pointer text-xs font-medium">高级参数</summary>
            <div className="mt-3 flex flex-col gap-3 text-xs font-medium">
                {showDuration ? (
                    <label className="flex min-w-0 items-center justify-between gap-3">
                        <span>时长（秒）</span>
                        <InputNumber
                            aria-label="精确时长（秒）"
                            styles={{ input: videoSettingsText }}
                            size="small"
                            min={durationMin}
                            max={durationMax}
                            step={0.01}
                            value={Number(duration || durationConfig?.default || 5)}
                            onChange={(v) => {
                                if (v != null) onDurationChange!(String(v));
                            }}
                        />
                    </label>
                ) : null}
                {expansionModes ? (
                    <label className="flex min-w-0 items-center justify-between gap-3">
                        <span>提示词增强</span>
                        <Select
                            aria-label="提示词增强"
                            size="small"
                            className="w-28"
                            styles={selectStyles}
                            classNames={{ popup: { root: "canvas-h3-option-popup" } }}
                            value={selectedExpansion}
                            options={expansionModes.map((mode) => ({ value: mode, label: PROMPT_EXPANSION_LABELS[mode] }))}
                            onChange={(prompt_expansion_mode) => onChange({ ...value, prompt_expansion_mode })}
                        />
                    </label>
                ) : null}
                {showSeed ? (
                    <label className="flex min-w-0 items-center justify-between gap-3">
                        <span>随机种子</span>
                        <InputNumber
                            aria-label="随机种子"
                            styles={{ input: videoSettingsText }}
                            size="small"
                            className="!w-28"
                            precision={0}
                            min={-Number.MAX_SAFE_INTEGER}
                            max={Number.MAX_SAFE_INTEGER}
                            value={value.seed}
                            placeholder="留空随机"
                            onChange={(seed) => onChange({ ...value, seed: seed == null ? undefined : seed })}
                        />
                    </label>
                ) : null}
                {damageLevels ? (
                    <label className="flex min-w-0 items-center justify-between gap-3">
                        <span>磁带磨损</span>
                        <Select
                            aria-label="磁带磨损"
                            classNames={{ popup: { root: "canvas-h3-option-popup" } }}
                            styles={selectStyles}
                            size="small"
                            value={selectedDamage}
                            options={damageLevels.map((level) => ({ value: level, label: DAMAGE_LEVEL_LABELS[level] }))}
                            onChange={(damage_level) => onChange({ ...value, damage_level })}
                        />
                    </label>
                ) : null}
            </div>
        </details>
    );
}
