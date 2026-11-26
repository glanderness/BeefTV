import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";

import "./image-size-picker.css";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import {
    MIDJOURNEY_DEFAULTS,
    clampMidjourneyNumber,
    midjourneyCustomCount,
    midjourneyStylizeLabel,
    type MidjourneySettingKey,
} from "@/lib/midjourney-image";

const QUALITY_TIERS = [
    { value: "1", label: "标准" },
    { value: "2", label: "精细" },
    { value: "4", label: "极致" },
] as const;

export function MidjourneySettings({
    config,
    onChange,
}: {
    config: AiConfig;
    onChange: (key: MidjourneySettingKey, value: string) => void;
}) {
    const customCount = midjourneyCustomCount(config);
    const [expanded, setExpanded] = useState(customCount > 0);
    const raw = config.mjRaw === "true";
    const quality = config.mjQuality === "2" || config.mjQuality === "4" ? config.mjQuality : MIDJOURNEY_DEFAULTS.quality;
    const stylize = clampMidjourneyNumber(config.mjStylize, 0, 1000, MIDJOURNEY_DEFAULTS.stylize);
    const chaos = clampMidjourneyNumber(config.mjChaos, 0, 100, MIDJOURNEY_DEFAULTS.chaos);

    const resetDefaults = () => {
        onChange("mjRaw", "false");
        onChange("mjQuality", MIDJOURNEY_DEFAULTS.quality);
        onChange("mjStylize", String(MIDJOURNEY_DEFAULTS.stylize));
        onChange("mjChaos", String(MIDJOURNEY_DEFAULTS.chaos));
        onChange("mjNo", "");
        onChange("mjStyleCode", "");
    };

    return (
        <section className="mj-settings-section space-y-2">
            <button
                type="button"
                className="mj-settings-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
            >
                <span className="mj-settings-toggle-title">
                    <span>Midjourney 风格参数</span>
                    {customCount > 0 ? <span className="mj-settings-badge">已改 {customCount} 项</span> : null}
                </span>
                <ChevronDown className={expanded ? "size-3.5 rotate-180 transition-transform" : "size-3.5 transition-transform"} aria-hidden />
            </button>

            {expanded ? (
                <div className="mj-settings-body space-y-2.5">
                    <div className="image-setting-inline">
                        <span>画面模式</span>
                        <div className="image-size-tiers">
                            <button type="button" aria-pressed={!raw} onClick={() => onChange("mjRaw", "false")}>
                                标准
                            </button>
                            <button type="button" aria-pressed={raw} onClick={() => onChange("mjRaw", "true")}>
                                Raw 直出
                            </button>
                        </div>
                    </div>

                    <div className="space-y-1">
                        <div className="image-setting-inline">
                            <span>渲染精细度</span>
                            <div className="image-size-tiers">
                                {QUALITY_TIERS.map((tier) => (
                                    <button
                                        key={tier.value}
                                        type="button"
                                        aria-pressed={quality === tier.value}
                                        onClick={() => onChange("mjQuality", tier.value)}
                                    >
                                        {tier.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <p className="image-size-hint">对应 --q 1/2/4，提高细节且不额外加价。</p>
                    </div>

                    <label className="mj-slider-field">
                        <span className="mj-slider-header">
                            <span>风格化 (--s)</span>
                            <span className="mj-slider-value">
                                {stylize} · {midjourneyStylizeLabel(stylize)}
                            </span>
                        </span>
                        <input
                            aria-label="风格化"
                            type="range"
                            min={0}
                            max={1000}
                            step={50}
                            value={stylize}
                            className="mj-slider-input"
                            onChange={(event) => onChange("mjStylize", event.target.value)}
                        />
                    </label>

                    <label className="mj-slider-field">
                        <span className="mj-slider-header">
                            <span>构图多样性 (--c)</span>
                            <span className="mj-slider-value">{chaos}</span>
                        </span>
                        <input
                            aria-label="构图多样性"
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={chaos}
                            className="mj-slider-input"
                            onChange={(event) => onChange("mjChaos", event.target.value)}
                        />
                    </label>

                    <label className="mj-text-field">
                        <span>排除元素 (--no)</span>
                        <input
                            aria-label="排除元素"
                            type="text"
                            placeholder="如：水印, 模糊, 多余文字"
                            className="mj-text-input"
                            value={config.mjNo || ""}
                            onChange={(event) => onChange("mjNo", event.target.value)}
                        />
                    </label>

                    <label className="mj-text-field">
                        <span>风格 / 个性化码 (--sref / --p)</span>
                        <input
                            aria-label="风格或个性化码"
                            type="text"
                            placeholder="粘贴风格码如 4102558034 或个性化码 m..."
                            className="mj-text-input"
                            value={config.mjStyleCode || ""}
                            onChange={(event) => onChange("mjStyleCode", event.target.value)}
                        />
                    </label>

                    {customCount > 0 ? (
                        <div className="mj-settings-footer">
                            <span className="image-size-hint">提示词内手写的同名参数优先于面板设置</span>
                            <button type="button" className="mj-reset-btn" onClick={resetDefaults}>
                                <RotateCcw className="size-3" aria-hidden />
                                <span>恢复默认</span>
                            </button>
                        </div>
                    ) : (
                        <p className="image-size-hint">提示词内手写的 --ar、--hd 等后缀会自动优先并同步。</p>
                    )}
                </div>
            ) : null}
        </section>
    );
}

export function MidjourneyPromptNotice({
    unsupportedFlags,
    theme,
    onClean,
}: {
    unsupportedFlags: string[];
    theme: CanvasTheme;
    onClean: () => void;
}) {
    if (!unsupportedFlags.length) return null;
    return (
        <div
            role="status"
            className="mj-prompt-notice mx-2.5 my-1.5"
            style={{ background: theme.accent.warningSoft, color: theme.accent.warningText }}
        >
            <span className="mj-prompt-notice-text">
                检测到不兼容后缀（{unsupportedFlags.join("、")}），当前使用 v8.2 生成
            </span>
            <button type="button" className="mj-prompt-notice-btn" onClick={onClean}>
                一键清理
            </button>
        </div>
    );
}
