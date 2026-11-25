import type { Dispatch, SetStateAction } from "react";
import type { App } from "antd";

import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildFullImageEmotionEdit } from "@/lib/canvas/canvas-emotion";
import {
    evaluateCreativeRetryBaseline,
    resolveCanvasPromptEditTarget,
} from "@/lib/canvas/canvas-generation-failure-ux";
import { reconcileImageBatchRoot } from "@/lib/canvas/canvas-image-batch-retry";
import { formatMaskEditPrompt, imageEditPlan } from "@/lib/canvas/canvas-image-edit-plan";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import {
    buildGenerationConfig,
    buildImageGenerationMetadata,
    buildVideoGenerationMetadata,
    createGenerationRetryContext,
    generationReferenceUrls,
    isGenerationCanceled,
    resetGenerationTaskMetadata,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-project-generation";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { createClientId } from "@/lib/client-id";
import type { GenerationErrorCategory } from "@/lib/generation-error";
import { buildUnchangedModerationConfirmDialog } from "@/lib/generation-failure-ux";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import {
    audioSubmissionCompatibilityError,
    defaultImageParamsForModel,
    normalizeMaskEditQuality,
    normalizeMaskEditSize,
} from "@/lib/model-selection";
import {
    isRegenerateAllowed,
    isRegenerateBlocked,
    isTaskOutcomeReady,
    isTaskOutcomeSubmissionUncertain,
    isTaskOutcomeWorking,
    nodeRequiresFreshSubmission,
    nodeRequiresRegenerateConfirmation,
    readNodeTaskOutcome,
    taskOutcomeCopy,
    type TaskOutcome,
} from "@/lib/task-outcome";
import type { GenerationTask } from "@/services/api/task-center";
import { retryStoredCanvasVideo } from "@/services/canvas-video-retry";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { useEffectiveConfig } from "@/stores/use-config-store";
import {
    CanvasNodeType,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
} from "@/types/canvas";
import { canvasGenerationFailureMetadata, type submittedReferences } from "./canvas-generation-failure";
import { confirmCanvasGeneration } from "./canvas-generation-preflight";

export const NODE_STATUS_LOADING = "loading" as const;
export const NODE_STATUS_ERROR = "error" as const;

export type EffectiveConfig = ReturnType<typeof useEffectiveConfig>;
export type ReferenceImageItem = ReturnType<typeof sourceNodeReferenceImages>[number];
export type HydratedCanvasContext = Awaited<ReturnType<typeof hydrateNodeGenerationContext>>;

export type RetryGateDeps = {
    node: CanvasNodeData;
    modal: ReturnType<typeof App.useApp>["modal"];
    readOnly: boolean;
    onEditGenerationInput?: (node: CanvasNodeData) => void;
    pageUi?: CanvasPageUiStoreHook;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
};

// 生成类型必须由明确的节点契约决定，未知节点不能降级成图片任务。
export function retryModeForNode(type: CanvasNodeTypeId): CanvasNodeGenerationMode | null {
    if (type === CanvasNodeType.Text) return "text";
    if (type === CanvasNodeType.Image) return "image";
    if (type === CanvasNodeType.Video) return "video";
    if (type === CanvasNodeType.Audio) return "audio";
    return null;
}

export function nodeTaskTypeForRetry(type: CanvasNodeTypeId) {
    if (type === CanvasNodeType.Image) return "canvas_image" as const;
    if (type === CanvasNodeType.Video) return "canvas_video" as const;
    if (type === CanvasNodeType.Audio) return "canvas_audio" as const;
    return undefined;
}

export function blockedOutcomeReason(node: CanvasNodeData, outcome?: TaskOutcome | null): string {
    return (
        node.metadata?.errorDetails ||
        taskOutcomeCopy(outcome, undefined, { providerCancelStatus: node.metadata?.taskProviderCancelStatus }).message
    );
}

// 复用单源 readNodeTaskOutcome + isCanvasNodeGenerating 判定批次成员是否仍在生成或结果待确认。
export function isBatchNodeLiveOrUncertain(item: CanvasNodeData): boolean {
    const outcome = readNodeTaskOutcome(item.metadata);
    const hasMedia = Boolean(item.metadata?.content || item.metadata?.storageKey);
    return (
        isCanvasNodeGenerating(item) ||
        isTaskOutcomeWorking(outcome) ||
        isTaskOutcomeSubmissionUncertain(outcome) ||
        (isTaskOutcomeReady(outcome) && !hasMedia)
    );
}

export async function confirmCanvasRetryGate(
    deps: RetryGateDeps,
    targetNode: CanvasNodeData,
    category: GenerationErrorCategory,
    submittedPrompt: string,
    submittedRefs: ReturnType<typeof submittedReferences>,
    signal: AbortSignal,
) {
    const targetOutcome = readNodeTaskOutcome(targetNode.metadata);
    const baseline = evaluateCreativeRetryBaseline(targetNode.metadata, category, submittedPrompt, submittedRefs);
    const needsOutcomeConfirm = nodeRequiresRegenerateConfirmation(targetNode.metadata, targetOutcome);
    if ((!needsOutcomeConfirm && !baseline.unchangedModeration) || !deps.modal?.confirm) {
        return { confirmed: true, prompted: false, baseline };
    }
    const targetCopy = taskOutcomeCopy(targetOutcome, undefined, { providerCancelStatus: targetNode.metadata?.taskProviderCancelStatus });
    const latestNode = deps.nodesRef.current.find((item) => item.id === deps.node.id) || deps.node;
    const promptTarget = !deps.readOnly
        ? resolveCanvasPromptEditTarget(latestNode, deps.nodesRef.current, deps.connectionsRef.current)
        : undefined;
    const editAction =
        !deps.readOnly && baseline.unchangedModeration && promptTarget
            ? deps.onEditGenerationInput
                ? () => deps.onEditGenerationInput!(latestNode)
                : deps.pageUi
                  ? () => {
                        deps.pageUi!.getState().setSelectedNodeIds(new Set([promptTarget.id]));
                        deps.pageUi!.getState().setDialogNodeId(promptTarget.id);
                    }
                  : undefined
            : undefined;
    const costWarning = needsOutcomeConfirm ? targetCopy.confirmContent || targetCopy.message : undefined;
    const confirmed = await confirmCanvasGeneration(
        (callbacks) =>
            deps.modal.confirm(
                baseline.unchangedModeration
                    ? { ...buildUnchangedModerationConfirmDialog({ onEditInput: editAction, costWarning }), ...callbacks }
                    : {
                          title: targetCopy.confirmTitle || "确认重新生成？",
                          content: targetCopy.confirmContent || targetCopy.message,
                          okText: "确认重新生成",
                          cancelText: "取消",
                          centered: true,
                          ...callbacks,
                      },
            ),
        signal,
        editAction ? { onUserCancel: editAction } : undefined,
    );
    return { confirmed, prompted: true, baseline };
}

export function resolveImageRetryConfig(
    effectiveConfig: EffectiveConfig,
    sourceGenerationConfig: ReturnType<typeof buildGenerationConfig>,
    savedImageMetadata?: CanvasNodeMetadata,
) {
    if (!savedImageMetadata?.generationType) {
        return { ...sourceGenerationConfig, count: "1" };
    }
    return {
        ...sourceGenerationConfig,
        model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model || sourceGenerationConfig.model,
        quality: savedImageMetadata.quality || effectiveConfig.quality || sourceGenerationConfig.quality,
        size: savedImageMetadata.size || effectiveConfig.size || sourceGenerationConfig.size,
        transparentBackground:
            (savedImageMetadata.transparentBackground || effectiveConfig.transparentBackground || sourceGenerationConfig.transparentBackground) === "true"
                ? "true"
                : "false",
        count: "1",
    };
}

export type RetryTargetPlan =
    | { error: string }
    | {
          retryTargets: CanvasNodeData[];
          retryTargetIds: string[];
          retryTargetIdSet: Set<string>;
          structuredBatchRootId?: string;
          primaryTarget: CanvasNodeData;
      };

export function resolveRetryTargetPlan(params: {
    node: CanvasNodeData;
    batchRoot?: CanvasNodeData;
    groupRoot: CanvasNodeData;
    nativeOutputs: number;
    multipleNativeBatches: boolean;
    isStructuredMaskEditRetry: boolean;
    nodes: CanvasNodeData[];
}): RetryTargetPlan {
    const { node, batchRoot, groupRoot, nativeOutputs, multipleNativeBatches, isStructuredMaskEditRetry, nodes } = params;
    if (multipleNativeBatches && !batchRoot) {
        return { error: "请使用重试失败批次，或选择失败图片重试；已完成的批次将保留" };
    }
    const nativeRetryTargets = multipleNativeBatches
        ? nodes.filter(
              (item) =>
                  item.metadata?.batchRootId === batchRoot?.id &&
                  Boolean(node.metadata?.taskId) &&
                  item.metadata?.taskId === node.metadata?.taskId,
          )
        : [];
    if (
        multipleNativeBatches &&
        (nativeRetryTargets.length !== nativeOutputs || nativeRetryTargets.some((item) => item.metadata?.content || item.metadata?.storageKey))
    ) {
        return { error: "该批次已有结果或任务状态不完整，请先取回原任务，避免重复生成" };
    }

    const structuredBatchChildren =
        isStructuredMaskEditRetry && nativeOutputs > 1 && !multipleNativeBatches && groupRoot.metadata?.batchChildIds?.length
            ? groupRoot.metadata.batchChildIds
                  .map((id) => nodes.find((item) => item.id === id))
                  .filter((item): item is CanvasNodeData =>
                      Boolean(item && item.type === CanvasNodeType.Image && item.metadata?.batchRootId === groupRoot.id),
                  )
            : [];

    if (isStructuredMaskEditRetry && nativeOutputs > 1 && !multipleNativeBatches) {
        if (!groupRoot.metadata?.isBatchRoot && !groupRoot.metadata?.batchChildIds?.length) {
            return { error: "当前模型固定输出多张图片，请在原图重新发起编辑以创建完整批次" };
        }
        const batchNodes = [groupRoot, ...structuredBatchChildren];
        if (batchNodes.some(isBatchNodeLiveOrUncertain)) {
            return { error: "该批次仍在生成或结果待确认，请稍候或先查询原任务" };
        }
        const blockedNode = batchNodes.find((item) => isRegenerateBlocked(readNodeTaskOutcome(item.metadata)));
        if (blockedNode) {
            return { error: blockedOutcomeReason(blockedNode, readNodeTaskOutcome(blockedNode.metadata)) };
        }
        if (
            structuredBatchChildren.length !== nativeOutputs ||
            structuredBatchChildren.some((item) => Boolean(item.metadata?.content || item.metadata?.storageKey))
        ) {
            return { error: "该批次已有结果或任务状态不完整，请先取回原任务，避免重复生成" };
        }
    }

    const retryTargets = nativeRetryTargets.length
        ? nativeRetryTargets
        : structuredBatchChildren.length === nativeOutputs
          ? structuredBatchChildren
          : [];
    const structuredBatchRootId =
        isStructuredMaskEditRetry && structuredBatchChildren.length === nativeOutputs && groupRoot.metadata?.isBatchRoot
            ? groupRoot.id
            : undefined;
    const retryTargetIds = retryTargets.length ? retryTargets.map((item) => item.id) : [node.id];
    const retryTargetIdSet = new Set(retryTargetIds);
    const primaryTarget =
        retryTargets.find((item) => Boolean(item.metadata?.taskId || readNodeTaskOutcome(item.metadata))) ||
        retryTargets[0] ||
        node;
    return { retryTargets, retryTargetIds, retryTargetIdSet, structuredBatchRootId, primaryTarget };
}

export async function resolveRetrySubmissionContext(params: {
    nodeType: CanvasNodeTypeId;
    primaryTarget: CanvasNodeData;
    outcome?: TaskOutcome | null;
    storedVideoFallbackError: unknown;
    skipStoredVideoRetry: boolean;
}) {
    const { nodeType, primaryTarget, outcome, storedVideoFallbackError, skipStoredVideoRetry } = params;
    const nodeTaskType = nodeTaskTypeForRetry(nodeType);
    const requiresFreshSubmission = nodeRequiresFreshSubmission(primaryTarget.metadata, { nodeTaskType, outcome });
    // Edited input after a non-retryable failure or unconfirmed/submitted task is a new submission, not replay of the old retry operation.
    if (!storedVideoFallbackError && !skipStoredVideoRetry && !requiresFreshSubmission && primaryTarget.metadata?.taskId && isRegenerateAllowed(outcome)) {
        return createGenerationRetryContext(primaryTarget.metadata.taskId, primaryTarget.metadata.attemptGroupId);
    }
    if (primaryTarget.metadata?.taskClientOperationId && !primaryTarget.metadata?.taskId) {
        return { clientOperationId: primaryTarget.metadata.taskClientOperationId };
    }
    return { clientOperationId: createClientId() };
}

export function prepareAudioRetryConfig(params: {
    effectiveConfig: EffectiveConfig;
    generationSourceNode: CanvasNodeData;
    generationConfig: ReturnType<typeof buildGenerationConfig>;
    context: HydratedCanvasContext;
}): { error: string } | { config: ReturnType<typeof buildGenerationConfig> } {
    const { effectiveConfig, generationSourceNode, context } = params;
    const hydratedAudioInput = {
        textCount: context.textCount,
        imageCount: context.imageCount,
        videoCount: context.videoCount,
        audioCount: context.audioCount,
        characterCount: 0,
    };
    let nextConfig = {
        ...buildGenerationConfig(effectiveConfig, generationSourceNode, "audio", { capability: "audio", input: hydratedAudioInput }),
        count: "1",
    };
    const compatibilityError = audioSubmissionCompatibilityError(effectiveConfig, nextConfig.model, hydratedAudioInput);
    if (compatibilityError) return { error: compatibilityError };

    if (context.characterReferences.length) {
        if (context.characterReferences.length !== 1) {
            return { error: "角色配音一次只能引用一个角色卡" };
        }
        const voice = context.resolvedCharacterVoices[0];
        const hasReferenceMedia = context.referenceImages.length > 0 || context.referenceAudios.length > 0;
        if (!voice && !hasReferenceMedia) {
            return { error: "角色尚未绑定可用声音，无法重试角色配音任务" };
        }
        if (voice) {
            nextConfig = {
                ...nextConfig,
                audioVoice: voice.voiceKey || nextConfig.audioVoice,
                audioInstructions: [voice.instructions, nextConfig.audioInstructions].filter(Boolean).join("；"),
            };
        }
    }
    return { config: nextConfig };
}

export function buildVideoRetryMetadataPatch(params: {
    node: CanvasNodeData;
    mediaPrompt: string;
    generationConfig: ReturnType<typeof buildGenerationConfig>;
    videoContext?: Parameters<typeof buildVideoGenerationMetadata>[1];
    styleMetadata: Record<string, unknown>;
    skillMetadata: Record<string, unknown>;
}) {
    const { node, mediaPrompt, generationConfig, videoContext, styleMetadata, skillMetadata } = params;
    const videoGenerationMetadata = buildVideoGenerationMetadata(node, videoContext, generationConfig);
    return {
        videoGenerationMetadata,
        patch: {
            prompt: mediaPrompt,
            model: generationConfig.model,
            size: generationConfig.size,
            seconds: generationConfig.videoSeconds,
            vquality: generationConfig.vquality,
            generateAudio: generationConfig.videoGenerateAudio,
            watermark: generationConfig.videoWatermark,
            draft: generationConfig.videoDraft,
            ...videoGenerationMetadata,
            ...styleMetadata,
            ...skillMetadata,
            ...(videoContext ? { references: generationReferenceUrls(videoContext) } : {}),
        },
    };
}

export type StructuredImageEditPlan = {
    sourceNodeId: string;
    sourceReference: ReferenceImageItem;
    config: ReturnType<typeof buildGenerationConfig>;
    providerPrompt: string;
    localComposite: boolean;
    mask: ReferenceImageItem;
    generationMetadata: ReturnType<typeof buildImageGenerationMetadata>;
    nodeMetadataPatch: Partial<CanvasNodeMetadata>;
    taskMetadataExtra: Record<string, unknown>;
};

export type StructuredImageEditInput =
    | { kind: "emotion"; edit: NonNullable<CanvasNodeMetadata["emotionEdit"]> }
    | { kind: "mask"; edit: NonNullable<CanvasNodeMetadata["maskEdit"]> };

// 统一 emotionEdit 与 maskEdit 的模型重绘能力校验、尺寸/质量归一化、本地蒙版融合配置与提交载荷构建。
export async function prepareStructuredImageEditRetry(params: {
    structuredEdit: StructuredImageEditInput;
    nodes: CanvasNodeData[];
    sourceNode: CanvasNodeData;
    savedImageMetadata?: CanvasNodeMetadata;
    generationConfig: ReturnType<typeof buildGenerationConfig>;
    mediaPrompt: string;
}): Promise<StructuredImageEditPlan> {
    const { structuredEdit, nodes, sourceNode, savedImageMetadata, generationConfig, mediaPrompt } = params;
    const imageProfile = modelCapabilityConfigFor(generationConfig, generationConfig.model).image!;
    const editPlan = imageEditPlan(imageProfile, 1);
    const localComposite = editPlan.mode === "local-composite";
    const modelDefaults = defaultImageParamsForModel(generationConfig, generationConfig.model);

    const buildEditConfig = (rawSize: string) => ({
        ...generationConfig,
        count: String(editPlan.outputsPerRequest),
        size: normalizeMaskEditSize(rawSize, imageProfile.size?.values ?? [], modelDefaults.size, Boolean(imageProfile.size?.allowCustom)),
        quality: normalizeMaskEditQuality(
            generationConfig.quality || modelDefaults.quality,
            rawSize,
            imageProfile.quality?.supported ? imageProfile.quality.values : [],
            modelDefaults.quality,
        ),
    });

    if (structuredEdit.kind === "emotion") {
        const emotionEdit = structuredEdit.edit;
        const emotionSource = nodes.find((item) => item.id === emotionEdit.sourceNodeId);
        if (!emotionSource || (!emotionSource.metadata?.content && !emotionSource.metadata?.storageKey)) {
            throw new Error("情绪编辑源图片已删除，无法重试");
        }
        if (imageProfile.references.maxImages === 0) throw new Error("当前图片模型仅支持文生图，不支持图片重绘");
        const sourceReference = sourceNodeReferenceImages(emotionSource)[0];
        if (!sourceReference) throw new Error("情绪编辑源图片不可用");
        const sourceWidth = emotionSource.metadata.naturalWidth || emotionEdit.sourceWidth || emotionSource.width;
        const sourceHeight = emotionSource.metadata.naturalHeight || emotionEdit.sourceHeight || emotionSource.height;
        if (!sourceWidth || !sourceHeight) throw new Error("无法读取情绪编辑源图片尺寸");

        const editConfig = buildEditConfig(emotionSource.metadata.size || modelDefaults.size);
        const edit = buildFullImageEmotionEdit({
            presetId: emotionEdit.presetId,
            intimacy: emotionEdit.intimacy,
            arousal: emotionEdit.arousal,
            characterName: emotionEdit.characterName,
            faceBox: emotionEdit.faceBox,
            imageWidth: sourceWidth,
            imageHeight: sourceHeight,
        });
        const baseEmotionPrompt = emotionEdit.fullImage
            ? mediaPrompt
            : (resolveCanvasStyleExecution(nodes, sourceNode, edit.prompt, editConfig, "image")?.prompt ?? edit.prompt);
        const providerPrompt = formatMaskEditPrompt(baseEmotionPrompt, localComposite);
        const nextEmotionEdit = {
            ...emotionEdit,
            editRegion: undefined,
            sourceWidth,
            sourceHeight,
            editMode: editPlan.mode,
            fullImage: true,
        };
        return {
            sourceNodeId: emotionSource.id,
            sourceReference,
            config: editConfig,
            providerPrompt,
            localComposite,
            mask: { id: `${emotionSource.id}-emotion-mask`, name: "emotion-mask.png", type: "image/png", dataUrl: edit.maskDataUrl },
            generationMetadata: buildImageGenerationMetadata("edit", editConfig, editPlan.outputsPerRequest, [sourceReference]),
            nodeMetadataPatch: { emotionEdit: nextEmotionEdit },
            taskMetadataExtra: { edit: "emotion", emotion: nextEmotionEdit },
        };
    }

    const activeMaskEdit = structuredEdit.edit;
    const maskSource = nodes.find((item) => item.id === activeMaskEdit.sourceNodeId);
    const storedReferences = !maskSource && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : null;
    const sourceReference = (maskSource ? sourceNodeReferenceImages(maskSource)[0] : undefined) || storedReferences?.[0];
    if (!sourceReference) throw new Error("局部重绘源图片已删除，无法重试");
    if (imageProfile.references.maxImages === 0) throw new Error("当前图片模型仅支持文生图，不支持图片重绘");
    const maskStorageKey = activeMaskEdit.maskStorageKey?.trim() || "";
    if (!maskStorageKey) throw new Error("局部重绘蒙版已丢失，请重新在原图上涂抹后再生成");

    const editConfig = buildEditConfig(generationConfig.size || maskSource?.metadata?.size || modelDefaults.size);
    const providerPrompt = formatMaskEditPrompt(mediaPrompt, localComposite);
    const nextMaskEdit = {
        ...activeMaskEdit,
        editMode: editPlan.mode,
        maskStorageKey,
    };
    return {
        sourceNodeId: activeMaskEdit.sourceNodeId,
        sourceReference,
        config: editConfig,
        providerPrompt,
        localComposite,
        mask: {
            id: `${activeMaskEdit.sourceNodeId}-mask`,
            name: "mask.png",
            type: "image/png",
            dataUrl: "",
            storageKey: maskStorageKey,
        },
        generationMetadata: buildImageGenerationMetadata("edit", editConfig, editPlan.outputsPerRequest, [sourceReference]),
        nodeMetadataPatch: { maskEdit: nextMaskEdit },
        taskMetadataExtra: { edit: "mask" },
    };
}

export function buildRetryLoadingNodes(
    current: CanvasNodeData[],
    targetIds: string[],
    structuredBatchRootId: string | undefined,
    clientOperationId?: string,
): CanvasNodeData[] {
    return current.map((item) => {
        const outputIndex = targetIds.indexOf(item.id);
        if (outputIndex >= 0) {
            return {
                ...item,
                metadata: {
                    ...resetGenerationTaskMetadata(item.metadata, NODE_STATUS_LOADING),
                    ...(targetIds.length > 1 ? { taskOutputIndex: outputIndex } : {}),
                    taskClientOperationId: clientOperationId,
                },
            };
        }
        if (structuredBatchRootId && item.id === structuredBatchRootId) {
            return {
                ...item,
                metadata: {
                    ...resetGenerationTaskMetadata(item.metadata, NODE_STATUS_LOADING),
                    batchFailedCount: 0,
                    primaryImageId: undefined,
                },
            };
        }
        return item;
    });
}

export function applyRetryFailureToNodes(
    current: CanvasNodeData[],
    retryTargetIdSet: Set<string>,
    completedRetryTargetIds: Set<string>,
    structuredBatchRootId: string | undefined,
    failure: Partial<CanvasNodeMetadata>,
): CanvasNodeData[] {
    const updated = current.map((item) =>
        retryTargetIdSet.has(item.id) && !completedRetryTargetIds.has(item.id)
            ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } }
            : item,
    );
    if (!structuredBatchRootId || retryTargetIdSet.has(structuredBatchRootId)) return updated;
    return updated.map((item) => (item.id === structuredBatchRootId ? reconcileImageBatchRoot(item, updated) : item));
}

export function surfaceRetryFailure(nodeId: string, reason: string, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    setNodes((current) =>
        current.map((item) =>
            item.id === nodeId
                ? {
                      ...item,
                      metadata: {
                          ...item.metadata,
                          status: NODE_STATUS_ERROR,
                          errorDetails: reason,
                          generationErrorSummary: reason,
                          generationFailure: undefined,
                      },
                  }
                : item,
        ),
    );
}

export function markMissingReferences(nodeId: string, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    surfaceRetryFailure(nodeId, "参考图片已丢失，无法继续重试", setNodes);
}

export async function executeStoredVideoReplay(params: {
    node: CanvasNodeData;
    taskId: string;
    signal: AbortSignal;
    projectId: string;
    projectIdRef: { current: string };
    retryingVideos: { current: Set<string> };
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (targetNodeId: string, task: GenerationTask) => Promise<void>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    message: ReturnType<typeof App.useApp>["message"];
}): Promise<{ handled: true } | { handled: false; fallbackError: unknown }> {
    const { node, taskId, signal, projectId, projectIdRef, retryingVideos, bindGenerationTask, applyGenerationTaskResult, setNodes, message } = params;
    if (retryingVideos.current.has(taskId)) return { handled: true };
    retryingVideos.current.add(taskId);
    let taskUpdated = false;
    try {
        const task = await retryStoredCanvasVideo(taskId, signal, (update) => {
            taskUpdated = true;
            if (projectIdRef.current === projectId) bindGenerationTask(node.id, update);
        });
        if (projectIdRef.current === projectId && !signal.aborted) await applyGenerationTaskResult(node.id, task);
        return { handled: true };
    } catch (error) {
        if (isGenerationCanceled(error) || projectIdRef.current !== projectId) return { handled: true };
        if (!taskUpdated) return { handled: false, fallbackError: error };
        const reason = error instanceof Error ? error.message : "原视频任务重试失败";
        const failure = canvasGenerationFailureMetadata(error, { mode: "video", prompt: node.metadata?.prompt || "" });
        message?.error?.(reason);
        setNodes((current) =>
            current.map((item) =>
                item.id === node.id
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              status: NODE_STATUS_ERROR,
                              ...failure,
                              generationErrorSummary: failure.generationErrorSummary || reason,
                              generationFailure: undefined,
                          },
                      }
                    : item,
            ),
        );
        return { handled: true };
    } finally {
        retryingVideos.current.delete(taskId);
    }
}
