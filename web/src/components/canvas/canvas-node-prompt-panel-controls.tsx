import { Button, InputNumber } from "antd";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";

import { GenerationCostLabel, useGenerationCostEstimateState } from "@/components/generation/generation-cost-badge";
import { ModelPicker } from "@/components/model-picker";
import { Tooltip } from "@/components/ui/base/tooltip";
import { buildCanvasGenerationRequirements, buildGenerationConfig as buildNodeConfig, videoModelSelectionPatch } from "@/lib/canvas/canvas-generation-config";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { canvasNodeCostTarget, formatInlineCostEstimate, type InlineCostDisplay } from "@/lib/generation-cost-estimate";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import {
    configuredModelDisplayName,
    defaultImageParamsForModel,
    modelCompatibilityError,
    modelRequestOptions,
    type ModelRequirements,
} from "@/lib/model-selection";
import { navigateToSettings } from "@/lib/settings-navigation";
import { videoSettingsConstraints } from "@/lib/video-settings-constraints";
import type { Asset } from "@/stores/use-asset-store";
import { resolveModelChannel, selectableModelsByCapability, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import type { CanvasConnection, CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasCameraControlPopover } from "./canvas-camera-control-popover";
import { CanvasH3Controls, CanvasH3UnsupportedFrames } from "./canvas-h3-controls";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { resolveCanvasNodeGenerationPreview } from "./canvas-node-generation";
import { ReferenceToolsPopover } from "./canvas-node-reference-shelf";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";

export type CanvasNodeGenerationPanelPreview = {
    config: AiConfig;
    requirements: ModelRequirements;
    availableModels: string[];
    resolvedRequirements: ModelRequirements;
    priceChannel: ModelChannel;
    costDisplay: InlineCostDisplay | null;
    costRefreshing: boolean;
    currentModelCompatibilityError: string;
    livePreflightError: string;
    isSubmitDisabled: boolean;
};

export function useCanvasNodeGenerationPreview({
    globalConfig,
    node,
    mode,
    prompt,
    referenceNodes,
    referenceConnections,
    assets,
    simpleMode,
    isRunning,
}: {
    globalConfig: AiConfig;
    node: CanvasNodeData;
    mode: CanvasGenerationMode;
    prompt: string;
    referenceNodes: CanvasNodeData[];
    referenceConnections: CanvasConnection[];
    assets: Asset[];
    simpleMode: boolean;
    isRunning: boolean;
}): CanvasNodeGenerationPanelPreview {
    const { inputSummary, preflightError: livePreflightError } = useMemo(
        () => resolveCanvasNodeGenerationPreview(node, mode, prompt, referenceNodes, referenceConnections, assets),
        [assets, mode, node, prompt, referenceConnections, referenceNodes],
    );
    const preferredReferenceMode = useCreationPreferencesStore((state) => state.preferences.videoReferenceMode ?? "all");
    const requirements = buildCanvasGenerationRequirements(globalConfig, node, mode, inputSummary, preferredReferenceMode);
    const config = buildNodeConfig(globalConfig, node, mode, requirements);
    const availableModels = selectableModelsByCapability(config, mode);
    const resolvedRequirements: ModelRequirements = {
        ...requirements,
        options: modelRequestOptions(config, mode),
        videoSeconds: mode === "video" ? config.videoSeconds : undefined,
    };
    const currentModelCompatibilityError = !simpleMode && availableModels.length && config.model
        ? modelCompatibilityError(config, config.model, { ...requirements, videoSeconds: undefined, imageSize: undefined, options: undefined })
        : "";
    const priceChannel = resolveModelChannel(config, config.model);
    const costTarget = useMemo(
        () => canvasNodeCostTarget({
            mode,
            config,
            referenceImages: (requirements.input?.imageCount || 0) + (requirements.input?.characterCount || 0),
            referenceVideos: requirements.input?.videoCount || 0,
            prompt,
        }),
        [config, mode, prompt, requirements.input?.characterCount, requirements.input?.imageCount, requirements.input?.videoCount],
    );
    const { estimate, previousEstimate } = useGenerationCostEstimateState(costTarget, { refreshKey: priceChannel.modelProfiles?.length || 0 });
    const previousImagePrice = mode === "image" ? previousEstimate : null;
    const costRefreshing = Boolean(previousImagePrice?.label);
    const costDisplay = useMemo(() => {
        const display = formatInlineCostEstimate(estimate || previousImagePrice);
        return display && costRefreshing ? { ...display, tooltip: `正在更新，上一笔预估为 ${display.label}` } : display;
    }, [estimate, previousImagePrice, costRefreshing]);
    const isSubmitDisabled = !isRunning && (!prompt.trim() || Boolean(currentModelCompatibilityError) || Boolean(livePreflightError));
    return {
        config,
        requirements,
        availableModels,
        resolvedRequirements,
        priceChannel,
        costDisplay,
        costRefreshing,
        currentModelCompatibilityError,
        livePreflightError,
        isSubmitDisabled,
    };
}

export function CanvasNodePromptWarnings({
    config,
    currentModelCompatibilityError,
    livePreflightError,
    persistedPreflightError,
    needsRecoverySection,
    theme,
    onOpenGenerationHistory,
    onCreateGenerationReplacement,
}: {
    config: AiConfig;
    currentModelCompatibilityError: string;
    livePreflightError: string;
    persistedPreflightError?: string;
    needsRecoverySection: boolean;
    theme: CanvasTheme;
    onOpenGenerationHistory?: () => void;
    onCreateGenerationReplacement?: () => void;
}) {
    return (
        <>
            {currentModelCompatibilityError ? (
                <p role="status" className="mx-2.5 my-2 whitespace-pre-wrap break-words" style={{ color: "var(--status-warning)" }}>
                    当前模型（{configuredModelDisplayName(config, config.model)}）{currentModelCompatibilityError}，请切换兼容模型或调整已连接的参考素材。
                </p>
            ) : livePreflightError ? (
                <p role="status" className="mx-2.5 my-2 whitespace-pre-wrap break-words" style={{ color: "var(--status-warning)" }}>
                    {livePreflightError}
                </p>
            ) : null}
            {persistedPreflightError && persistedPreflightError !== livePreflightError ? (
                <p role="alert" className="mx-2.5 my-2 whitespace-pre-wrap break-words" style={{ color: theme.accent.danger }}>
                    未开始生成：{persistedPreflightError}
                </p>
            ) : null}
            {needsRecoverySection && (onOpenGenerationHistory || onCreateGenerationReplacement) ? (
                <section aria-label="生成恢复" className="mx-2.5 my-2">
                    <p style={{ color: theme.node.muted }}>可以取回已有结果，或保留原节点、新建节点继续。</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {onOpenGenerationHistory ? <Button className="min-h-10" onClick={onOpenGenerationHistory}>查看生成历史</Button> : null}
                        {onCreateGenerationReplacement ? <Button className="min-h-10" onClick={onCreateGenerationReplacement}>新建节点继续</Button> : null}
                    </div>
                </section>
            ) : null}
        </>
    );
}

export function CanvasNodePromptFooterControls({
    expanded,
    simpleMode,
    mode,
    node,
    globalConfig,
    preview,
    presetControl,
    activeReferenceCount,
    canAutoMention,
    autoLinkEnabled,
    autoLinkLabel,
    pickConnectActive,
    isRunning,
    controlsSupported,
    middleFrameSupported,
    endFrameSupported,
    theme,
    onAutoMention,
    onAutoLinkEnabledChange,
    onTogglePickConnect,
    onConfigChange,
    onImageSettingsOpenChange,
    onSubmit,
}: {
    expanded: boolean;
    simpleMode: boolean;
    mode: CanvasGenerationMode;
    node: CanvasNodeData;
    globalConfig: AiConfig;
    preview: CanvasNodeGenerationPanelPreview;
    presetControl: ReactNode;
    activeReferenceCount: number;
    canAutoMention: boolean;
    autoLinkEnabled: boolean;
    autoLinkLabel: string;
    pickConnectActive: boolean;
    isRunning: boolean;
    controlsSupported: boolean;
    middleFrameSupported: boolean;
    endFrameSupported: boolean;
    theme: CanvasTheme;
    onAutoMention: () => void;
    onAutoLinkEnabledChange: (enabled: boolean) => void;
    onTogglePickConnect: () => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    onSubmit: () => void;
}) {
    const rememberImageSettings = useCreationPreferencesStore((state) => state.rememberImageSettings);
    const { config, requirements, availableModels, resolvedRequirements, costDisplay, isSubmitDisabled } = preview;
    const monochromeAccent = theme.node.activeStroke;
    const actionLabel = isRunning ? "生成中" : "生成";

    const submitControl = (() => {
        const button = (
            <Button
                type="text"
                className="canvas-node-composer-submit canvas-node-composer-submit-canvas"
                disabled={isRunning || isSubmitDisabled}
                style={
                    {
                        color: isSubmitDisabled ? theme.node.faint : theme.node.text,
                        "--canvas-composer-submit-action": isSubmitDisabled ? theme.toolbar.itemHover : monochromeAccent,
                        "--canvas-composer-submit-action-fg": isSubmitDisabled ? theme.node.faint : theme.canvas.background,
                    } as CSSProperties
                }
                onClick={onSubmit}
                aria-label={actionLabel}
                title={actionLabel}
            >
                <span className="canvas-node-composer-submit-action" aria-hidden>
                    {isRunning ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <ArrowUp className="size-3.5" strokeWidth={2.4} />}
                </span>
            </Button>
        );
        return (
            <div
                aria-busy={preview.costRefreshing || undefined}
                className={costDisplay ? "inline-flex h-8 shrink-0 items-center rounded-full pl-2.5" : "inline-flex h-8 shrink-0 items-center"}
                style={costDisplay ? { background: "var(--canvas-composer-control-surface)" } : undefined}
            >
                {costDisplay ? (
                    <GenerationCostLabel
                        display={costDisplay}
                        className={`canvas-node-composer-submit-cost pr-1 font-medium${mode === "image" ? " canvas-image-submit-cost" : ""}`}
                        style={{ color: isSubmitDisabled ? theme.node.muted : theme.node.text }}
                    />
                ) : null}
                {button}
            </div>
        );
    })();

    const videoCapabilities = mode === "video" ? modelCapabilityConfigFor(config, config.model).video : undefined;

    const settingsControl = simpleMode ? null : mode === "text" ? (
        <Tooltip title="文本生成份数（默认 1，可在生成配置中调整）">
            <InputNumber
                size="small"
                variant="borderless"
                min={1}
                max={15}
                value={Math.max(1, Math.min(15, Math.floor(Math.abs(Number(node.metadata?.textCount) || 1))))}
                onChange={(value) => onConfigChange(node.id, { textCount: Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1))) })}
                aria-label="文本生成份数"
                className="!w-14 !h-7 [&_.ant-input-number-input]:!text-[length:var(--canvas-composer-ui-fs)] [&_.ant-input-number-input]:!leading-[var(--canvas-composer-ui-lh)]"
            />
        </Tooltip>
    ) : mode === "image" ? (
        <CanvasImageSettingsPopover
            config={config}
            buttonClassName="canvas-node-composer-settings-trigger [&>span]:min-w-0 [&_.lucide]:!size-3"
            onConfigChange={(key, value) => {
                rememberImageSettings(imagePreferencePatch(key, value));
                onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value });
            }}
            onMissingConfig={() => navigateToSettings({ continueCreation: true })}
            onOpenChange={expanded ? undefined : onImageSettingsOpenChange}
        />
    ) : mode === "video" ? (
        <CanvasVideoSettingsPopover
            config={config}
            taskConstraints={videoSettingsConstraints(config, {
                imageCount: requirements.input?.imageCount,
                characterCount: requirements.input?.characterCount,
                videoCount: requirements.input?.videoCount,
                audioCount: requirements.input?.audioCount,
            }, node.metadata)}
            buttonClassName="canvas-node-composer-settings-trigger [&>span]:min-w-0 [&_.lucide]:!size-3"
            onConfigChange={(key, value) => {
                onConfigChange(node.id, videoConfigPatch(key, value));
            }}
        >
            {controlsSupported ? (
                <CanvasH3Controls
                    controls={videoCapabilities?.controls}
                    durationConfig={videoCapabilities?.duration}
                    value={node.metadata?.videoH3Options}
                    onChange={(videoH3Options) => onConfigChange(node.id, { videoH3Options })}
                />
            ) : null}
            {(requirements.input?.videoCount || 0) > 0 && (videoCapabilities?.operations.includes("extend") || videoCapabilities?.operations.includes("inpaint")) ? (
                <div className="space-y-1.5 border-t pt-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <div style={{ color: theme.node.muted }}>参考视频模式</div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {([
                            { value: undefined, label: "参考生成" },
                            { value: "extend", label: "视频续写" },
                            { value: "inpaint", label: "视频局部修改" },
                        ] as const).map((item) => {
                            const active = (node.metadata?.videoEditOperation || undefined) === item.value;
                            return (
                                <button
                                    key={item.label}
                                    type="button"
                                    className="h-8 cursor-pointer rounded-md px-1.5 transition-colors"
                                    style={{ background: active ? theme.toolbar.activeBg : theme.toolbar.itemHover, color: theme.node.text }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => onConfigChange(node.id, { videoEditOperation: item.value, size: item.value ? "adaptive" : node.metadata?.size })}
                                >
                                    {item.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
            <CanvasH3UnsupportedFrames
                metadata={node.metadata}
                middleFrameSupported={middleFrameSupported}
                endFrameSupported={endFrameSupported}
                onChange={(patch) => onConfigChange(node.id, patch)}
            />
        </CanvasVideoSettingsPopover>
    ) : mode === "audio" ? (
        <CanvasAudioSettingsPopover
            config={config}
            buttonClassName="canvas-node-composer-settings-trigger [&>span]:min-w-0 [&_.lucide]:!size-3"
            onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))}
        />
    ) : null;

    const actions = (
        <div className="canvas-node-composer-actions ml-auto flex min-w-0 items-center gap-1">
            {presetControl}
            <ReferenceToolsPopover
                canAutoMention={canAutoMention}
                autoLinkEnabled={autoLinkEnabled}
                onAutoMention={onAutoMention}
                onAutoLinkEnabledChange={onAutoLinkEnabledChange}
                pickConnectActive={pickConnectActive}
                onTogglePickConnect={onTogglePickConnect}
                accent={monochromeAccent}
                compact={simpleMode || !expanded}
                label={autoLinkLabel}
            />
            {!simpleMode && (mode === "image" || mode === "video") ? (
                <CanvasCameraControlPopover
                    cameraControl={node.metadata?.cameraControl}
                    onCameraControlChange={(cameraControl) => onConfigChange(node.id, { cameraControl })}
                    theme={theme}
                    compact={!expanded}
                    label={mode === "video" ? "运镜" : undefined}
                />
            ) : null}
            {settingsControl}
            {submitControl}
        </div>
    );

    if (simpleMode) {
        return (
            <div className="canvas-node-composer-footer">
                <span className="min-w-0 truncate px-2" style={{ color: theme.node.muted }}>
                    {activeReferenceCount ? `已连接 ${activeReferenceCount} 个素材` : "将使用默认模型与参数"}
                </span>
                {actions}
            </div>
        );
    }

    return (
        <div className="canvas-node-composer-footer">
            <div className="canvas-node-composer-model">
                {availableModels.length ? (
                    <ModelPicker
                        className="!h-7 !min-w-0 !font-normal [&_img]:!size-3 [&_.lucide]:!size-3"
                        config={config}
                        value={config.model}
                        onChange={(model) => {
                            if (mode === "video") {
                                if (model !== config.model) onConfigChange(node.id, videoModelSelectionPatch(globalConfig, model));
                                return;
                            }
                            const patch = mode === "image" ? { model, ...defaultImageParamsForModel(config, model) } : { model };
                            if (mode === "image") {
                                const nextConfig = buildNodeConfig(globalConfig, { ...node, metadata: { ...node.metadata, ...patch } }, mode, { ...requirements, options: undefined });
                                rememberImageSettings({ model: nextConfig.model, ratio: nextConfig.size, quality: nextConfig.quality, count: nextConfig.count, transparentBackground: nextConfig.transparentBackground });
                            }
                            onConfigChange(node.id, patch);
                        }}
                        capability={mode}
                        requirements={resolvedRequirements}
                        onMissingConfig={() => navigateToSettings({ section: "channels", continueCreation: true })}
                        variant="canvas"
                        showConfiguredModelName
                        showVideoPriceDetails={false}
                    />
                ) : (
                    <button
                        type="button"
                        className="canvas-composer-model-picker flex !h-7 min-w-0 items-center px-2 text-left !font-normal"
                        aria-label="暂无模型可用，连接内置算力"
                        title="暂无模型可用，连接内置算力"
                        onClick={() => navigateToSettings({ section: "channels", continueCreation: true })}
                    >
                        <span className="truncate">暂无模型可用，连接内置算力</span>
                    </button>
                )}
            </div>
            {actions}
        </div>
    );
}

function imagePreferencePatch(key: keyof AiConfig, value: string) {
    if (key === "size") return { ratio: value };
    if (key === "quality") return { quality: value };
    if (key === "count") return { count: String(Number(value) || 1) };
    if (key === "transparentBackground") return { transparentBackground: value };
    return {};
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoDraft") return { draft: value };
    if (key === "videoReturnLastFrame") return { returnLastFrame: value };
    if (key === "videoArkPrivateAssetUpload") return { arkPrivateAssetUpload: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    if (key === "audioPitch") return { audioPitch: value };
    if (key === "audioVolume") return { audioVolume: value };
    return { audioInstructions: value };
}
