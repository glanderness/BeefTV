import { ImageSizePicker } from "./image-size-picker";
import { imageResolutionUsesQuality } from "@/lib/image-size-presets";
import { type CSSProperties, type ReactNode } from "react";
import { ConfigProvider } from "antd";
import { Switch } from "@/components/ui/base/switch";

import { type CanvasTheme } from "@/lib/canvas-theme";
import { buildImageResolutionOptions, formatImageResolutionSize } from "@/lib/image-resolution-tiers";
import { normalizeImageValue, type ImageCapabilityConfig } from "@/lib/model-capabilities";
import { mergedImageCapabilityConfig } from "@/lib/model-selection";
import { type AiConfig } from "@/stores/use-config-store";
import { seedreamFamily, seedreamResolutionTiers } from "@/lib/seedream-image";
import { SeedreamSizePicker } from "./seedream-size-picker";
import { SeedreamSettings } from "./seedream-settings";

const qualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "超高" },
    { value: "max", label: "最高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];

type AspectOption = { value: string; label: string; width: number; height: number; icon: string; size?: string };

const aspectOptions: AspectOption[] = [
    { value: "1:1", label: "1:1", width: 1024, height: 1024, icon: "square" },
    { value: "3:2", label: "3:2", width: 1536, height: 1024, icon: "landscape" },
    { value: "2:3", label: "2:3", width: 1024, height: 1536, icon: "portrait" },
    { value: "4:3", label: "4:3", width: 1360, height: 1024, icon: "landscape" },
    { value: "3:4", label: "3:4", width: 1024, height: 1360, icon: "portrait" },
    { value: "16:9", label: "16:9", width: 1824, height: 1024, icon: "landscape" },
    { value: "2:1", label: "2:1", size: "2048x1024", width: 2048, height: 1024, icon: "landscape" },
    { value: "1:2", label: "1:2", size: "1024x2048", width: 1024, height: 2048, icon: "portrait" },
    { value: "21:9", label: "21:9", size: "2352x1008", width: 2352, height: 1008, icon: "landscape" },
    { value: "9:16", label: "9:16", width: 1024, height: 1824, icon: "portrait" },
    { value: "1:1-2k", label: "1:1(2k)", size: "2048x2048", width: 2048, height: 2048, icon: "square" },
    { value: "16:9-2k", label: "16:9(2k)", size: "2048x1152", width: 2048, height: 1152, icon: "landscape" },
    { value: "9:16-2k", label: "9:16(2k)", size: "1152x2048", width: 1152, height: 2048, icon: "portrait" },
    { value: "16:9-4k", label: "16:9(4k)", size: "3840x2160", width: 3840, height: 2160, icon: "landscape" },
    { value: "9:16-4k", label: "9:16(4k)", size: "2160x3840", width: 2160, height: 3840, icon: "portrait" },
    { value: "auto", label: "auto", width: 0, height: 0, icon: "auto" },
];

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "transparentBackground" | "count" | "seedreamMode" | "seedreamMaxImages" | "seedreamOutputFormat" | "seedreamOptimize" | "seedreamWatermark", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    showQuality?: boolean;
    showTransparent?: boolean;
    showSize?: boolean;
    showCount?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, showQuality = true, showTransparent = true, showSize = true, showCount = true, className = "w-[304px] space-y-3 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 3 }: ImageSettingsPanelProps) {
    const profile = mergedImageCapabilityConfig(config, config.model || config.imageModel);
    const seedream = seedreamFamily(config.model || config.imageModel);
    const normalized = normalizeImageValue(profile, config);
    const quality = normalized.quality;
    const transparentBackground = normalized.transparentBackground === "true";
    const countDisplay = imageCountDisplay(config, profile, seedream);
    const batchCounts = profile.generationOutputs?.filter((value) => value <= maxCount);
    const effectiveMaxCount = Math.min(maxCount, batchCounts?.length ? Math.max(...batchCounts) : profile.maxOutputs);
    const count = Math.max(1, Math.min(effectiveMaxCount, Number(normalized.count)));
    const activeSize = normalized.size;
    const activeQualityOptions = profile.quality.values.map((value) => qualityOptions.find((item) => item.value === value) || { value, label: value });

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={`image-settings-panel ${className}`}
                style={{ color: theme.node.text, "--image-active": theme.toolbar.activeBg, "--image-hover": theme.toolbar.itemHover, "--image-muted": theme.node.muted } as CSSProperties}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-base font-semibold">图像设置</div> : null}
                {showSize && (seedream && seedreamResolutionTiers(profile).length > 0
                    ? <SeedreamSizePicker key={config.model} profile={profile} size={activeSize} layers={config.seedreamMode === "layers"} onChange={value => onConfigChange("size", value)} />
                    : <ImageSizePicker presetsOnly key={config.model} profile={profile} size={activeSize} quality={quality} onChange={(size, nextQuality) => applyImageSizeSelection(onConfigChange, size, nextQuality)} />)}
                {showQuality && profile.quality.supported && !imageResolutionUsesQuality(profile) ? <div className="space-y-2">
                    <SettingTitle color={theme.node.muted}>{isGrokResolutionQuality(profile) ? "分辨率" : "质量"}</SettingTitle>
                    <div className="image-quality-grid">
						{activeQualityOptions.map((item) => (
                            <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div> : null}
                {countDisplay.supportsGroups ? (
                    <label className="block space-y-1.5 text-xs">
                        <span>关联组图上限</span>
                        <input
                            aria-label="关联组图上限"
                            type="number"
                            min={1}
                            max={15}
                            className="h-8 w-full rounded-lg border px-2"
                            style={{ background: theme.canvas.background, color: theme.node.text, borderColor: theme.node.stroke }}
                            value={config.seedreamMaxImages || "1"}
                            onChange={(event) => onConfigChange("seedreamMaxImages", event.target.value)}
                        />
                        <span className="block leading-relaxed" style={{ color: theme.node.muted }}>
                            同一次生成中的关联图片，按实际出图收费；参考图与输出图合计最多 15 张。
                        </span>
                    </label>
                ) : null}
                {showCount && profile.fixedOutputs ? (
                    <div className="space-y-2">
                        <SettingTitle color={theme.node.muted}>{countDisplay.title}</SettingTitle>
                        <div className="grid grid-cols-3 gap-1.5">
                            {(batchCounts?.length ? batchCounts : [profile.fixedOutputs]).map((value) => <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>{value}</OptionPill>)}
                        </div>
                        <div style={{ color: theme.node.muted }}>每批 {profile.fixedOutputs} 张，共 {count / profile.fixedOutputs} 批；按实际批次计费</div>
                    </div>
                ) : showCount && effectiveMaxCount > 1 ? (
                    <div className="space-y-2">
                        <SettingTitle color={theme.node.muted}>{countDisplay.title}</SettingTitle>
                        <div className="grid grid-cols-4 gap-1.5">
                            {Array.from({ length: Math.min(quickCount, effectiveMaxCount) }, (_, index) => index + 1).map((value) => (
                                <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                    {value}
                                </OptionPill>
                            ))}
                            <CountInput label={`自定义${countDisplay.title}`} value={count} quickCount={quickCount} max={effectiveMaxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                        </div>
                    </div>
                ) : null}
                {(seedream || (showTransparent && profile.transparentBackground.supported)) && <section className="space-y-1.5">
                    <SettingTitle color={theme.node.muted}>输出</SettingTitle>
                    {showTransparent && profile.transparentBackground.supported && !(seedream && config.seedreamMode === "layers") && <>
                        <div className="image-output-row"><span>透明背景</span>
                            <Switch size="sm" aria-label="透明背景" checked={transparentBackground} onChange={checked => {
                                onConfigChange("transparentBackground", String(checked));
                                if (checked && seedream) onConfigChange("seedreamOutputFormat", "png");
                            }} />
                        </div>
                        {transparentBackground && seedream && seedream !== "5.5" && <p className="image-size-hint">需要连接一张带透明区域的参考图。</p>}
                    </>}
                    {seedream && <SeedreamSettings family={seedream} profile={profile} config={config} onChange={onConfigChange} />}
                </section>}
            </div>
        </ImageSettingsTheme>
    );
}

export function applyImageSizeSelection(onConfigChange: ImageSettingsPanelProps["onConfigChange"], size: string, quality?: string) {
    onConfigChange("size", size);
    if (quality) onConfigChange("quality", quality);
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.canvas.background, colorBgElevated: theme.canvas.background, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: { Button: { defaultBg: theme.canvas.background, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return ({ auto: "自动", high: "高", xhigh: "超高", max: "最高", medium: "中", low: "低", "1k": "1K", "2k": "2K", "4k": "4K" } as Record<string, string>)[value.toLowerCase()] || value || "默认";
}

function isGrokResolutionQuality(profile: ImageCapabilityConfig) {
    const values = profile.quality.values.map((item) => item.toLowerCase());
    return values.some((value) => ["1k", "2k", "4k"].includes(value));
}

export function imageCountDisplay(config: AiConfig, profile: ImageCapabilityConfig, seedream: string) {
    const supportsGroups = profile.sequentialGeneration?.supported ?? Boolean(seedream && !["5.5", "pro", "flash"].includes(seedream));
    if (seedream && config.seedreamMode === "layers") return { title: "拆分次数", unit: "次", supportsGroups: false };
    if (supportsGroups && Number(config.seedreamMaxImages) > 1) {
        return { title: "生成组数", unit: "组", supportsGroups, groupLimit: config.seedreamMaxImages };
    }
    return { title: "生成张数", unit: "张", supportsGroups };
}

export function imageSizeLabel(size: string, profile?: ImageCapabilityConfig) {
    const resolutionLabel = formatImageResolutionSize(size, profile?.size.presets || buildImageResolutionOptions([size]));
    return resolutionLabel !== size ? resolutionLabel : aspectOptions.find((item) => (item.size || item.value) === size || item.value === size)?.label || size;
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            aria-pressed={selected}
            type="button"
			className="h-8 cursor-pointer rounded-md px-2 text-xs transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
			style={{ background: selected ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
			disabled={disabled}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function CountInput({ label, value, quickCount, max, theme, onChange }: { label: string; value: number; quickCount: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Math.max(1, Math.min(max, Math.floor(Number(input.value) || 1)));
        input.value = String(next);
        onChange(next);
    };
    return (
        <label className="flex h-8 overflow-hidden rounded-md text-xs" style={{ background: theme.toolbar.itemHover, color: theme.node.text }}>
            <input
                key={value > quickCount ? `custom-${value}` : "quick"}
                type="number"
                min={1}
                max={max}
                aria-label={label}
                placeholder="输入"
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none placeholder:text-current placeholder:opacity-55 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                defaultValue={value > quickCount ? value : ""}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}
