import { type CSSProperties, type ReactNode } from "react";
import type { VideoSettingsConstraints } from "@/lib/video-settings-constraints";
import { Switch } from "@/components/ui/base/switch";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceRatioOptions } from "@/lib/seedance-video";
import { isVolcengineArkVideoProtocol } from "@/lib/model-protocols";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { formatVideoResolutionLabel, isVideoResolutionMatch, normalizeVideoDuration, sortVideoResolutionOptions } from "@/lib/video-generation-options";
import { modelCapabilityConfigFor, normalizeVideoValue, resolveVideoRatioValue, resolveVideoResolutionValue, videoDurationAllowed, videoDurationOptions, videoSupportsTaskTypeConstraints, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import { modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

const sizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
    { value: "auto", label: "auto", width: 0, height: 0 },
];

type VideoSettingsPanelProps = {
    taskConstraints?: VideoSettingsConstraints;
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoDraft" | "videoReturnLastFrame" | "videoArkPrivateAssetUpload", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[292px] space-y-3", taskConstraints }: VideoSettingsPanelProps) {
    const capabilityConfig = modelCapabilityConfigFor(config, config.model);
    const profile = capabilityConfig.video!;
    const serverOwned = Boolean(resolveModelChannel(config, config.model).modelProfiles?.find((item) => item.model === modelOptionName(config.model))?.videoCapabilitiesVersion?.trim());
    if (!serverOwned && resolveModelRequestConfig(config, config.model).interfaceType === "volcengine-jimeng-video") {
        return <JiMengVideoSettingsPanel config={config} profile={profile} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} />;
    }
    if (!serverOwned && isSeedanceVideoConfig(config)) {
        return <SeedanceVideoSettingsPanel config={config} profile={profile} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} taskConstraints={taskConstraints} />;
    }

    const seconds = normalizeVideoValue(profile, { seconds: config.videoSeconds }).seconds;
    const resolution = resolveVideoResolutionValue(profile, config.vquality);
    const ratio = resolveVideoRatioValue(profile, config.size);
    const sizeSupported = profile.ratios.length > 0;
    const configuredResolutions = sortVideoResolutionOptions(profile.resolutions).map((value) => ({ value, label: formatVideoResolutionLabel(value) }));
    const generateAudio = boolConfig(config.videoGenerateAudio, profile.generateAudio.default);
    const watermark = boolConfig(config.videoWatermark, profile.watermark.default);
    const draftSupported = Boolean(profile.draft?.supported);
    const draft = draftSupported && boolConfig(config.videoDraft, profile.draft?.default ?? false) && (!resolution || isVideoResolutionMatch(resolution, "480p"));
    const returnLastFrameSupported = Boolean(profile.returnLastFrame?.supported);
    const returnLastFrame = returnLastFrameSupported && boolConfig(config.videoReturnLastFrame, profile.returnLastFrame?.default ?? false);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div>视频设置</div> : null}
                {configuredResolutions.length ? (
                    <SettingGroup title="分辨率" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-1.5">
                            {configuredResolutions.map((item) => (
                                <OptionPill key={item.value} selected={isVideoResolutionMatch(resolution, item.value)} theme={theme} onClick={() => {
                                    onConfigChange("vquality", item.value);
                                    if (draft && !isVideoResolutionMatch(item.value, "480p")) onConfigChange("videoDraft", "false");
                                }}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                {sizeSupported ? (
                    <SettingGroup title={taskConstraints?.ratioLabel ? "比例" : "尺寸"} color={theme.node.muted}>
                        {taskConstraints?.ratioLabel ? (
                            <div className="rounded-md px-2.5 py-2" style={{ background: theme.toolbar.itemHover }}>
                                <p>{taskConstraints.ratioLabel}</p>
                                {taskConstraints.ratioHelp ? <p className="mt-1 leading-relaxed" style={{ color: theme.node.muted }}>{taskConstraints.ratioHelp}</p> : null}
                            </div>
                        ) : <>
                        {taskConstraints?.ratioHelp ? <p className="leading-relaxed" style={{ color: theme.node.muted }}>{taskConstraints.ratioHelp}</p> : null}
                        <div className="grid grid-cols-3 gap-1.5">
                            {profile.ratios.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1 transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                                    style={{ background: ratio === value ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", value)}
                                >
                                    <SizePreview width={ratioPreview(value).width} height={ratioPreview(value).height} color={theme.node.text} />
                                    <span>{videoSizeLabel(value)}</span>
                                </button>
                            ))}
                        </div>
                        </>}
                    </SettingGroup>
                ) : null}
                {profile.durationSupported !== false ? <VideoDurationControl profile={profile} value={Number(seconds)} locked={taskConstraints?.durationLocked} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} /> : null}
                {profile.generateAudio.supported || profile.watermark.supported || draftSupported || returnLastFrameSupported ? (
                    <SettingGroup title="输出" color={theme.node.muted}>
                        <div className="grid grid-cols-2 gap-3 rounded-md px-2" style={{ background: theme.toolbar.itemHover }}>
                            {profile.generateAudio.supported ? <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                            {profile.watermark.supported ? <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /> : null}
                            {draftSupported ? <SwitchRow label="样片预览 (480P)" checked={draft} theme={theme} onChange={(checked) => {
                                onConfigChange("videoDraft", String(checked));
                                if (checked && !isVideoResolutionMatch(resolution, "480p")) onConfigChange("vquality", "480p");
                            }} /> : null}
                            {returnLastFrameSupported ? <SwitchRow label="返回无损尾帧" checked={returnLastFrame} theme={theme} onChange={(checked) => onConfigChange("videoReturnLastFrame", String(checked))} /> : null}
                        </div>
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function JiMengVideoSettingsPanel({ config, profile, onConfigChange, theme, showTitle, className }: VideoSettingsPanelProps & { profile: VideoCapabilityConfig }) {
    const seconds = normalizeVideoValue(profile, { seconds: config.videoSeconds }).seconds;
    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div>视频设置</div> : null}
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-1.5">
                        {profile.ratios.map((value) => (
                            <OptionPill key={value} selected={config.size === value} theme={theme} onClick={() => onConfigChange("size", value)}>
                                {videoSizeLabel(value)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {profile.durationSupported !== false ? <VideoDurationControl profile={profile} value={Number(seconds)} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} /> : null}
            </div>
        </ImageSettingsTheme>
    );
}

function SeedanceVideoSettingsPanel({ config, profile, onConfigChange, theme, showTitle, className, taskConstraints }: VideoSettingsPanelProps & { profile: VideoCapabilityConfig }) {
    const model = modelOptionName(config.model || config.videoModel);
    const resolution = normalizeSeedanceResolution(config.vquality, model);
    const ratio = taskConstraints?.ratioLabel ? "adaptive" : normalizeSeedanceRatio(config.size);
    const duration = Number(normalizeVideoValue(profile, { seconds: config.videoSeconds }).seconds);
    const generateAudio = boolConfig(config.videoGenerateAudio, profile.generateAudio.default);
    const watermark = boolConfig(config.videoWatermark, profile.watermark.default);
    const draftSupported = Boolean(profile.draft?.supported);
    const draft = draftSupported && boolConfig(config.videoDraft, profile.draft?.default ?? false) && (!resolution || isVideoResolutionMatch(resolution, "480p"));
    const returnLastFrameSupported = Boolean(profile.returnLastFrame?.supported);
    const returnLastFrame = returnLastFrameSupported && boolConfig(config.videoReturnLastFrame, profile.returnLastFrame?.default ?? false);
    const useArkPrivateAssets = boolConfig(config.videoArkPrivateAssetUpload, true);
    const isArkSeedance = isVolcengineArkVideoProtocol(resolveModelRequestConfig(config, config.model).interfaceType);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div>视频设置</div> : null}
                {videoSupportsTaskTypeConstraints(profile) ? (
                    <p className="leading-relaxed" style={{ color: theme.node.muted }}>
                        首尾帧和延长模式的比例跟随素材；编辑模式还会跟随原视频时长。需要自由设置时，请选择参考生成。
                    </p>
                ) : null}
                <SettingGroup title="分辨率" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-1.5">
                        {sortVideoResolutionOptions(profile.resolutions).map((value) => {
                            const item = { value, label: value.toUpperCase() };
                            return (
                                <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => {
                                    onConfigChange("vquality", item.value);
                                    if (draft && !isVideoResolutionMatch(item.value, "480p")) onConfigChange("videoDraft", "false");
                                }}>
                                    {item.label}
                                </OptionPill>
                            );
                        })}
                    </div>
                </SettingGroup>
                <SettingGroup title="比例" color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-1.5">
                        {(taskConstraints?.ratioLabel ? ["adaptive"] : profile.ratios).map((value) => {
                            const item = { value, label: taskConstraints?.ratioLabel || videoSizeLabel(value) };
                            return (
                                <button
                                    key={item.value}
                                    type="button"
                                    disabled={Boolean(taskConstraints?.ratioLabel)}
                                    className="flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md px-1 leading-none transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                                    style={{ background: ratio === item.value ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange("size", item.value)}
                                >
                                    <span className="grid h-4 place-items-center">
                                        <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                    </span>
                                    <span className="whitespace-nowrap">{item.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </SettingGroup>
                {profile.durationSupported !== false ? <VideoDurationControl profile={profile} value={duration} locked={taskConstraints?.durationLocked} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} /> : null}
                <SettingGroup title="输出" color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-3 rounded-md px-2" style={{ background: theme.toolbar.itemHover }}>
                        {profile.generateAudio.supported ? <SwitchRow label="生成声音" checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /> : null}
                        {profile.watermark.supported ? <SwitchRow label="添加水印" checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /> : null}
                        {draftSupported ? <SwitchRow label="样片预览 (480P)" checked={draft} theme={theme} onChange={(checked) => {
                            onConfigChange("videoDraft", String(checked));
                            if (checked && !isVideoResolutionMatch(resolution, "480p")) onConfigChange("vquality", "480p");
                        }} /> : null}
                        {returnLastFrameSupported ? <SwitchRow label="返回无损尾帧" checked={returnLastFrame} theme={theme} onChange={(checked) => onConfigChange("videoReturnLastFrame", String(checked))} /> : null}
                    </div>
                </SettingGroup>
                {isArkSeedance ? (
                    <SettingGroup title="参考图" color={theme.node.muted}>
                        <div className="rounded-md px-2" style={{ background: theme.toolbar.itemHover }}>
                            <SwitchRow label="自动同步可信素材（确认拥有使用权）" checked={useArkPrivateAssets} theme={theme} onChange={(checked) => onConfigChange("videoArkPrivateAssetUpload", String(checked))} />
                        </div>
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return formatVideoResolutionLabel(value);
}

export function videoSizeLabel(value: string) {
    const ratio = normalizeSeedanceRatio(value);
    if (value === "adaptive" || value === "auto") return "自适应";
    // The compact summary must mirror the selected value (for example 16:9),
    // while the settings panel can still use semantic labels such as 横屏.
    if (ratio === value) return ratio;
    const size = normalizeVideoSizeValue(value);
    return sizeOptions.find((item) => item.value === size)?.label || size;
}

export function videoSecondsLabel(value: string, profile?: VideoCapabilityConfig) {
    const normalized = profile ? normalizeVideoValue(profile, { seconds: value }).seconds : normalizeVideoDuration(value);
    return normalized === "-1" ? "自动" : `${normalized}s`;
}

export function normalizeVideoSizeValue(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            className="h-8 cursor-pointer whitespace-nowrap rounded-md px-1 leading-none transition-colors hover:brightness-110 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: selected ? theme.toolbar.activeBg : "transparent", color: theme.node.text, outlineColor: theme.node.muted }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <div style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function VideoDurationControl({ profile, value, locked, theme, onChange }: { profile: VideoCapabilityConfig; value: number; locked?: boolean; theme: CanvasTheme; onChange: (value: number) => void }) {
    const durations = videoDurationOptions(profile);
    const options = durations.filter((seconds) => Number.isInteger(seconds) && seconds > 0 && videoDurationAllowed(profile, seconds)).sort((a, b) => a - b);
    if (!locked && !options.length && !durations.includes(-1) && !profile.duration.continuous) return null;

    const automatic = value === -1;
    const manualValue = automatic ? profile.duration.default : value;
    // Keep saved fractional durations until the slider is moved to a whole second.
    const index = options.reduce((closest, seconds, i) => Math.abs(seconds - manualValue) < Math.abs(options[closest] - manualValue) ? i : closest, 0);
    const display = locked ? "随原视频" : automatic ? "自动" : `${value} 秒`;
    const canSwitchToAuto = !locked && options.length > 0 && durations.includes(-1);
    const step = options.length > 1 ? options[1] - options[0] : 1;
    const uniform = options.every((seconds, i) => seconds === options[0] + i * step);
    const thumbIndex = automatic ? 0 : index;
    const sliderValue = uniform ? options[thumbIndex] : thumbIndex;
    const fill = automatic ? 0 : (index / Math.max(1, options.length - 1)) * 100;

    return (
        <div className="space-y-1.5">
            <div className="flex min-h-6 items-center justify-between gap-2">
                <span style={{ color: theme.node.muted }}>视频时长</span>
                <div className="flex items-center gap-2">
                    {canSwitchToAuto ? <OptionPill selected={automatic} theme={theme} onClick={() => onChange(automatic ? options[index] : -1)}>自动</OptionPill> : null}
                    {canSwitchToAuto && automatic ? null : <span className="tabular-nums">{display}</span>}
                </div>
            </div>
            {!locked && options.length > 1 ? (
                <input
                    aria-label="视频时长（秒）"
                    aria-valuetext={display}
                    type="range"
                    min={uniform ? options[0] : 0}
                    max={uniform ? options[options.length - 1] : options.length - 1}
                    step={uniform ? step : 1}
                    value={sliderValue}
                    className="video-duration-range block w-full cursor-pointer"
                    style={{
                        "--video-duration-fill": `${fill}%`,
                        "--video-duration-track": theme.toolbar.itemHover,
                        "--video-duration-progress": theme.toolbar.activeBg,
                        "--video-duration-thumb": theme.node.text,
                    } as CSSProperties}
                    onClick={(event) => {
                        if (!automatic || event.detail === 0) return;
                        const selected = event.currentTarget.valueAsNumber;
                        onChange(uniform ? selected : options[selected]);
                    }}
                    onChange={(event) => {
                        const selected = event.currentTarget.valueAsNumber;
                        onChange(uniform ? selected : options[selected]);
                    }}
                />
            ) : null}
        </div>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(7, Math.round((width / longSide) * 16));
    const previewHeight = Math.max(7, Math.round((height / longSide) * 16));
    return <span className="shrink-0 rounded-[2px] border" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive" || ratio === "auto") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-2">
            <span className="min-w-0 whitespace-nowrap" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span className="shrink-0" onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="sm" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}
