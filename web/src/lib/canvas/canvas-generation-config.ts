import { configuredModelMatchesCapability, defaultConfig, normalizeModelOptionValue, type AiConfig } from "@/stores/use-config-store";
import { resolveAudioSpeechSettings } from "@/lib/audio-generation";
import { normalizeVideoDuration, normalizeVideoResolution } from "@/lib/video-generation-options";
import { modelCapabilityConfigFor, videoPrefersReferenceMode } from "@/lib/model-capabilities";
import { declaredOrOmniVideoCapability, modelRequestOptions, resolveCompatibleModel, resolveModelGenerationDefaults, resolveModelVideoBooleanOptions, type ModelGenerationDefaults, type ModelInputSummary, type ModelRequirements } from "@/lib/model-selection";
import { mediaGeneratorMetadata } from "@/lib/canvas/canvas-node-semantics";
import { savedVideoSettings, useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasVideoReferenceMode } from "@/types/canvas";

// Preview counts may reserve character images; resolved counts contain the actual
// representations. Callers choose their input summary for each validation stage.
export function buildCanvasGenerationRequirements(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, input: ModelInputSummary, preferredReferenceMode?: CanvasVideoReferenceMode): ModelRequirements {
    const requestedConfig = {
        ...config,
        size: node?.metadata?.size ?? config.size,
        quality: node?.metadata?.quality ?? config.quality,
        count: String(node?.metadata?.count ?? (mode === "image" ? config.canvasImageCount || config.count : config.count)),
        transparentBackground: node?.metadata?.transparentBackground ?? config.transparentBackground,
        videoSeconds: node?.metadata?.seconds ?? config.videoSeconds,
        vquality: node?.metadata?.vquality ?? config.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio ?? config.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark ?? config.videoWatermark,
        videoDraft: node?.metadata?.draft ?? config.videoDraft,
        videoReturnLastFrame: node?.metadata?.returnLastFrame ?? config.videoReturnLastFrame,
        audioVoice: node?.metadata?.audioVoice ?? config.audioVoice,
        audioFormat: node?.metadata?.audioFormat ?? config.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed ?? config.audioSpeed,
        audioPitch: node?.metadata?.audioPitch ?? config.audioPitch,
        audioVolume: node?.metadata?.audioVolume ?? config.audioVolume,
    };
    return resolvedCanvasGenerationRequirements(requestedConfig, node, mode, input, preferredReferenceMode);
}

export function supportsCanvasVideoReferenceModes(config: AiConfig, model: string) {
    const operations = declaredOrOmniVideoCapability(config, model)?.operations;
    return Boolean(operations?.includes("image_to_video") && operations.includes("reference_to_video"));
}

export function canvasVideoOperationPreference(config: AiConfig, node: CanvasNodeData | undefined, input: ModelInputSummary, preferredMode?: CanvasVideoReferenceMode, model = config.model) {
    const metadata = node?.metadata;
    if (metadata?.videoEditOperation) return metadata.videoEditOperation;
    const prefersReference = preferredMode === "all" || videoPrefersReferenceMode(declaredOrOmniVideoCapability(config, model));
    if (node?.type !== CanvasNodeType.Video || !prefersReference
        || metadata?.videoStartFrameNodeId || metadata?.videoEndFrameNodeId
        || !(input.imageCount || input.characterCount || input.videoCount)) return undefined;
    return supportsCanvasVideoReferenceModes(config, model) ? "reference_to_video" : undefined;
}

export function resolvedCanvasGenerationRequirements(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, input: ModelInputSummary, preferredReferenceMode?: CanvasVideoReferenceMode): ModelRequirements {
    const videoOperation = mode === "video"
        ? canvasVideoOperationPreference(config, node, input, preferredReferenceMode,
            resolveCanvasGenerationModel(config, node?.metadata?.model, mode)
            || resolveCanvasGenerationModel(config, config.videoModel, mode)
            || defaultConfig.videoModel)
        : node?.metadata?.videoEditOperation;
    return {
        capability: mode,
        input,
        videoOperation,
        videoSeconds: mode === "video" ? config.videoSeconds : undefined,
        options: modelRequestOptions(config, mode),
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasGenerationMode, requirements?: ModelRequirements): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = mode === "image" ? defaultConfig.imageModel : mode === "video" ? defaultConfig.videoModel : mode === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    const storedModel = resolveCanvasGenerationModel(config, node?.metadata?.model, mode);
    const preferredModel = storedModel || resolveCanvasGenerationModel(config, defaultModel, mode) || fallbackModel;
    // 先合并节点上的实时选择，再做兼容性匹配。否则路由只看到全局默认值，节点改过的时长、分辨率或布尔能力无法参与分流。
    const requestedConfig: AiConfig = {
        ...config,
        quality: node?.metadata?.quality ?? config.quality ?? defaultConfig.quality,
        size: node?.metadata?.size ?? config.size ?? defaultConfig.size,
        transparentBackground: node?.metadata?.transparentBackground ?? config.transparentBackground ?? defaultConfig.transparentBackground,
        seedreamMode: node?.metadata?.seedreamMode ?? config.seedreamMode,
        seedreamMaxImages: node?.metadata?.seedreamMaxImages ?? config.seedreamMaxImages,
        seedreamOutputFormat: node?.metadata?.seedreamOutputFormat ?? config.seedreamOutputFormat,
        seedreamOptimize: node?.metadata?.seedreamOptimize ?? config.seedreamOptimize,
        seedreamWatermark: node?.metadata?.seedreamWatermark ?? config.seedreamWatermark ?? defaultConfig.seedreamWatermark,
        videoSeconds: !modelCapabilityConfigFor(config, preferredModel).video?.duration.continuous
            ? normalizeVideoDuration(node?.metadata?.seconds ?? config.videoSeconds ?? defaultConfig.videoSeconds)
            : String(node?.metadata?.seconds ?? config.videoSeconds ?? defaultConfig.videoSeconds),
        vquality: normalizeVideoResolution(node?.metadata?.vquality ?? config.vquality ?? defaultConfig.vquality),
        videoGenerateAudio: node?.metadata?.generateAudio ?? config.videoGenerateAudio ?? defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark ?? config.videoWatermark ?? defaultConfig.videoWatermark,
        videoDraft: node?.metadata?.draft ?? config.videoDraft ?? defaultConfig.videoDraft,
        videoReturnLastFrame: node?.metadata?.returnLastFrame ?? config.videoReturnLastFrame ?? defaultConfig.videoReturnLastFrame,
        videoArkPrivateAssetUpload: node?.metadata?.arkPrivateAssetUpload ?? config.videoArkPrivateAssetUpload ?? defaultConfig.videoArkPrivateAssetUpload,
        ...resolveAudioSpeechSettings(preferredModel, {
            audioVoice: node?.metadata?.audioVoice ?? config.audioVoice,
            audioFormat: node?.metadata?.audioFormat ?? config.audioFormat,
            audioSpeed: node?.metadata?.audioSpeed ?? config.audioSpeed,
            audioPitch: node?.metadata?.audioPitch ?? config.audioPitch,
            audioVolume: node?.metadata?.audioVolume ?? config.audioVolume,
            audioInstructions: node?.metadata?.audioInstructions ?? config.audioInstructions,
        }),
        count: String(node?.metadata?.count ?? (mode === "image" ? config.canvasImageCount || config.count || defaultConfig.count : config.count || defaultConfig.count)),
    };
    const imageSize = mode === "image" ? requestedConfig.size : undefined;
    // 无 requirements 的调用（重试、媒体工具等）也按当前能力与尺寸路由到组内最低价兼容模型，
    // 避免旧 metadata.model 不支持当前尺寸导致生成时被 normalize 回退。
    const liveOptions = modelRequestOptions(requestedConfig, mode);
    const baseRequirements = requirements?.capability ? { ...requirements, options: { ...liveOptions, ...(requirements.options || {}) } } : { capability: mode, options: liveOptions };
    const model = resolveCompatibleModel(config, preferredModel, imageSize ? { ...baseRequirements, imageSize } : baseRequirements) || preferredModel;
    const generationDefaults: Partial<ModelGenerationDefaults> = resolveModelGenerationDefaults(
        config,
        model,
        mode === "image" ? "image" : mode === "video" ? "video" : undefined,
        mode === "image"
            ? {
                  size: node?.metadata?.size,
                  quality: node?.metadata?.quality,
                  transparentBackground: node?.metadata?.transparentBackground,
                  count: requestedConfig.count,
              }
            : {
                  size: node?.metadata?.size,
                  videoSeconds: node?.metadata?.seconds,
                  vquality: node?.metadata?.vquality,
                  videoGenerateAudio: node?.metadata?.generateAudio,
                  videoWatermark: node?.metadata?.watermark,
              },
        {
            size: requestedConfig.size,
            quality: requestedConfig.quality,
            transparentBackground: requestedConfig.transparentBackground,
            count: requestedConfig.count,
            videoSeconds: requestedConfig.videoSeconds,
            vquality: requestedConfig.vquality,
            videoGenerateAudio: requestedConfig.videoGenerateAudio,
            videoWatermark: requestedConfig.videoWatermark,
        },
    );
    const resolvedVquality = generationDefaults.vquality ?? requestedConfig.vquality;
    return {
        ...requestedConfig,
        model,
        quality: generationDefaults.quality || requestedConfig.quality,
        size: generationDefaults.size ?? requestedConfig.size,
        transparentBackground: generationDefaults.transparentBackground || (requestedConfig.transparentBackground === "true" ? "true" : "false"),
        videoSeconds: generationDefaults.videoSeconds || requestedConfig.videoSeconds,
        vquality: resolvedVquality,
        videoGenerateAudio: generationDefaults.videoGenerateAudio || requestedConfig.videoGenerateAudio,
        videoWatermark: generationDefaults.videoWatermark || requestedConfig.videoWatermark,
        videoDraft: requestedConfig.videoDraft === "true" && (!resolvedVquality || /^480p?$/i.test(String(resolvedVquality))) ? "true" : "false",
        videoReturnLastFrame: requestedConfig.videoReturnLastFrame,
        videoArkPrivateAssetUpload: requestedConfig.videoArkPrivateAssetUpload,
        count: generationDefaults.count || requestedConfig.count,
    };
}

export function resolveCanvasGenerationModel(config: AiConfig, model: string | undefined, mode: CanvasGenerationMode): string {
    if (!model) return "";
    const normalized = normalizeModelOptionValue(model, config.channels);
    if (!normalized) return "";
    return configuredModelMatchesCapability(config, normalized, mode) ? normalized : "";
}

export function preferredMediaGeneratorMetadata(
    config: AiConfig,
    mode: "image" | "video" | "audio",
    overrides: CanvasNodeMetadata = {},
): CanvasNodeMetadata {
    const prefs = useCreationPreferencesStore.getState().preferences;
    if (mode === "image" && prefs.image) {
        const preferredModel =
            overrides.model
            || resolveCanvasGenerationModel(config, prefs.image.model, "image")
            || resolveCanvasGenerationModel(config, config.imageModel, "image")
            || config.imageModel
            || defaultConfig.imageModel;
        const requested = {
            size: overrides.size ?? prefs.image.ratio,
            quality: overrides.quality ?? prefs.image.quality,
            count: overrides.count === undefined ? prefs.image.count : String(overrides.count),
            transparentBackground: overrides.transparentBackground ?? prefs.image.transparentBackground,
        };
        const model = resolveCompatibleModel(config, preferredModel, {
            capability: "image",
            imageSize: requested.size,
            options: requested,
        }) || preferredModel;
        const normalized = resolveModelGenerationDefaults(config, model, "image", requested);
        return mediaGeneratorMetadata({
            generationMode: "image",
            ...((prefs.image.model || model !== preferredModel) && model ? { model } : {}),
            ...(prefs.image.ratio && normalized.size ? { size: normalized.size } : {}),
            ...(prefs.image.quality && normalized.quality ? { quality: normalized.quality } : {}),
            ...(prefs.image.count && normalized.count ? { count: Number(normalized.count) || 1 } : {}),
            ...(prefs.image.transparentBackground && normalized.transparentBackground ? { transparentBackground: normalized.transparentBackground } : {}),
            ...overrides,
        });
    }
    if (mode === "video" && prefs.video) {
        const preferredModel =
            overrides.model
            || resolveCanvasGenerationModel(config, prefs.video.model, "video")
            || resolveCanvasGenerationModel(config, config.videoModel, "video")
            || config.videoModel
            || defaultConfig.videoModel;
        const saved = savedVideoSettings(prefs, preferredModel, config.videoModel);
        const requested = {
            size: overrides.size ?? saved?.ratio,
            videoSeconds: overrides.seconds ?? saved?.seconds,
            vquality: overrides.vquality ?? saved?.videoQuality,
            videoGenerateAudio: overrides.generateAudio ?? saved?.generateAudio,
            videoWatermark: overrides.watermark ?? saved?.watermark,
        };
        const model = resolveCompatibleModel(config, preferredModel, {
            capability: "video",
            videoSeconds: requested.videoSeconds,
            options: requested,
        }) || preferredModel;
        const normalized = resolveModelGenerationDefaults(config, model, "video", requested);
        const booleans = resolveModelVideoBooleanOptions(config, model, requested);
        return mediaGeneratorMetadata({
            generationMode: "video",
            ...((prefs.video.model || model !== preferredModel) && model ? { model } : {}),
            ...(saved?.ratio && normalized.size ? { size: normalized.size } : {}),
            ...(saved?.seconds && normalized.videoSeconds ? { seconds: normalized.videoSeconds } : {}),
            ...(saved?.videoQuality && normalized.vquality ? { vquality: normalized.vquality } : {}),
            ...(saved?.generateAudio !== undefined ? { generateAudio: booleans.videoGenerateAudio } : {}),
            ...(saved?.watermark !== undefined ? { watermark: booleans.videoWatermark } : {}),
            ...(saved?.draft !== undefined ? { draft: saved.draft } : {}),
            ...(saved?.returnLastFrame !== undefined ? { returnLastFrame: saved.returnLastFrame } : {}),
            ...(saved?.arkPrivateAssetUpload !== undefined ? { arkPrivateAssetUpload: saved.arkPrivateAssetUpload } : {}),
            ...(saved?.h3Options ? { videoH3Options: saved.h3Options } : {}),
            ...overrides,
        });
    }
    return mediaGeneratorMetadata({ generationMode: mode, ...overrides });
}



// Replace model-specific fields together so an unsubmitted draft cannot leak into another model.
export function videoModelSelectionPatch(config: AiConfig, model: string): Partial<CanvasNodeMetadata> {
    const settings = preferredMediaGeneratorMetadata(config, "video", { model });
    return {
        model, size: settings.size, seconds: settings.seconds, vquality: settings.vquality,
        generateAudio: settings.generateAudio, watermark: settings.watermark,
        draft: settings.draft, returnLastFrame: settings.returnLastFrame,
        videoH3Options: settings.videoH3Options, arkPrivateAssetUpload: settings.arkPrivateAssetUpload,
    };
}
