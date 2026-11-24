import { createClientId } from "@/lib/client-id";
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";

import { compileNodeGenerationReferences, buildNodeGenerationContext, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { buildFullImageEmotionEdit } from "@/lib/canvas/canvas-emotion";
import { reconcileImageBatchRoot } from "@/lib/canvas/canvas-image-batch-retry";
import { formatMaskEditPrompt, imageEditPlan } from "@/lib/canvas/canvas-image-edit-plan";
import { nodeFailureExplanation } from "@/lib/canvas/canvas-node-failure-state";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { buildAudioGenerationMetadata, buildGenerationConfig, buildImageGenerationMetadata, buildVideoGenerationMetadata, createGenerationRetryContext, generationReferenceUrls, isGenerationCanceled, resolveMetadataReferences, resolveStoredReferenceImages, resetGenerationTaskMetadata, runBackendCanvasGenerationTask, runCanvasGenerationTaskToConsumer, sourceNodeReferenceImages, supportsVideoReferenceAudio } from "@/lib/canvas/canvas-project-generation";
import { isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import {
    evaluateCreativeRetryBaseline,
    resolveCanvasGenerationInputSource,
    resolveCanvasPromptEditTarget,
} from "@/lib/canvas/canvas-generation-failure-ux";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { generationFailureMetadata, type GenerationErrorCategory } from "@/lib/generation-error";
import {
    buildUnchangedModerationConfirmDialog,
    isCreativeInputFailureCategory,
    shouldConfirmUnchangedModerationRetry,
} from "@/lib/generation-failure-ux";
import { isRegenerateAllowed, isRegenerateBlocked, isTaskOutcomeSubmissionUncertain, isTaskOutcomeWorking, nodeRequiresFreshSubmission, nodeRequiresRegenerateConfirmation, readNodeTaskOutcome, taskOutcomeCopy } from "@/lib/task-outcome";
import { audioSubmissionCompatibilityError, defaultImageParamsForModel, normalizeMaskEditQuality, normalizeMaskEditSize } from "@/lib/model-selection";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { navigateToSettings } from "@/lib/settings-navigation";
import type { Skill } from "@/services/api/skills";
import { skillRuntime, type SkillRuntimeMetadata } from "@/services/skill-runtime";
import type { GenerationTask } from "@/services/api/task-center";
import { retryStoredCanvasVideo } from "@/services/canvas-video-retry";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";
import { canvasGenerationFailureMetadata, submittedReferences, type CanvasGenerationFailureInput } from "./canvas-generation-failure";
import { confirmCanvasGeneration } from "./canvas-generation-preflight";

type UseCanvasGenerationRetryOptions = {
    pageUi?: CanvasPageUiStoreHook;
    readOnly?: boolean;
    onEditGenerationInput?: (node: CanvasNodeData) => void;
    projectId: string;
    domainProjectId?: string;
    addedSkills: Skill[];
    assets: Asset[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (targetNodeId: string, task: GenerationTask) => Promise<void>;
    regenerateImageBatch: (nodeId: string, prompt: string, options?: { skipDuplicateConfirmation?: boolean }) => Promise<void>;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function useCanvasGenerationRetry({
    pageUi,
    readOnly = false,
    onEditGenerationInput,
    projectId,
    domainProjectId,
    addedSkills,
    assets,
    nodesRef,
    connectionsRef,
    setNodes,
    setRunningNodeId,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
    regenerateImageBatch,
}: UseCanvasGenerationRetryOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const retryingVideos = useRef(new Set<string>());

    return useCallback(
        async (node: CanvasNodeData) => {
            if (isDepthCaptureResultNode(node)) {
                const reason = "深度动作捕捉节点必须使用本地深度任务重试";
                message?.warning?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
                return;
            }
            const retryMode = retryModeForNode(node.type);
            if (!retryMode) {
                const reason = "当前节点不能使用通用生成重试";
                message?.warning?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
                return;
            }
            let storedVideoFallbackError: unknown;
            let confirmedUnchangedModeration = false;
            let skipStoredVideoRetry = false;
            const resolvedSource = resolveCanvasGenerationInputSource(node, nodesRef.current, connectionsRef.current);
            const failureExplanation = nodeFailureExplanation(node.metadata);
            const creativeInputFailure = isCreativeInputFailureCategory(failureExplanation.category);
            const runVideoStoredReplay = async (taskId: string, signal: AbortSignal) => {
                if (retryingVideos.current.has(taskId)) return true;
                retryingVideos.current.add(taskId);
                const requestProjectId = projectId;
                let taskUpdated = false;
                try {
                    const task = await retryStoredCanvasVideo(taskId, signal, (update) => {
                        taskUpdated = true;
                        if (projectIdRef.current === requestProjectId) bindGenerationTask(node.id, update);
                    });
                    if (projectIdRef.current === requestProjectId && !signal.aborted) await applyGenerationTaskResult(node.id, task);
                    return true;
                } catch (error) {
                    if (isGenerationCanceled(error) || projectIdRef.current !== requestProjectId) return true;
                    if (!taskUpdated) {
                        storedVideoFallbackError = error;
                        return false;
                    }
                    const reason = error instanceof Error ? error.message : "原视频任务重试失败";
                    const failure = canvasGenerationFailureMetadata(error, { mode: "video", prompt: node.metadata?.prompt || "" });
                    message?.error?.(reason);
                    setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure, generationErrorSummary: failure.generationErrorSummary || reason, generationFailure: undefined } } : item)));
                    return true;
                } finally {
                    retryingVideos.current.delete(taskId);
                }
            };
            const confirmRetryGate = async (
                targetNode: CanvasNodeData,
                category: GenerationErrorCategory,
                submittedPrompt: string,
                submittedRefs: ReturnType<typeof submittedReferences>,
                signal: AbortSignal,
            ) => {
                const targetOutcome = readNodeTaskOutcome(targetNode.metadata);
                const baseline = evaluateCreativeRetryBaseline(targetNode.metadata, category, submittedPrompt, submittedRefs);
                const needsOutcomeConfirm = nodeRequiresRegenerateConfirmation(targetNode.metadata, targetOutcome);
                if (!needsOutcomeConfirm && !baseline.unchangedModeration) {
                    return { confirmed: true, prompted: false, baseline };
                }
                if (!modal?.confirm) {
                    return { confirmed: true, prompted: false, baseline };
                }
                const targetCopy = taskOutcomeCopy(targetOutcome, undefined, { providerCancelStatus: targetNode.metadata?.taskProviderCancelStatus });
                const latestNode = nodesRef.current.find((item) => item.id === node.id) || node;
                const promptTarget = !readOnly
                    ? resolveCanvasPromptEditTarget(latestNode, nodesRef.current, connectionsRef.current)
                    : undefined;
                const editAction =
                    !readOnly && baseline.unchangedModeration && promptTarget
                        ? onEditGenerationInput
                            ? () => onEditGenerationInput(latestNode)
                            : pageUi
                              ? () => {
                                    pageUi.getState().setSelectedNodeIds(new Set([promptTarget.id]));
                                    pageUi.getState().setDialogNodeId(promptTarget.id);
                                }
                              : undefined
                        : undefined;
                const costWarning = needsOutcomeConfirm ? targetCopy.confirmContent || targetCopy.message : undefined;
                const confirmed = await confirmCanvasGeneration(
                    (callbacks) =>
                        modal.confirm(
                            baseline.unchangedModeration
                                ? {
                                      ...buildUnchangedModerationConfirmDialog({
                                          onEditInput: editAction,
                                          costWarning,
                                      }),
                                      ...callbacks,
                                  }
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
            };
            if (!creativeInputFailure && retryMode === "video" && node.metadata?.taskId && node.metadata.status === "error") {
                const outcome = readNodeTaskOutcome(node.metadata);
                if (isRegenerateBlocked(outcome)) {
                    const reason = node.metadata?.errorDetails || taskOutcomeCopy(outcome, undefined, { providerCancelStatus: node.metadata?.taskProviderCancelStatus }).message;
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                if (nodeRequiresFreshSubmission(node.metadata, { nodeTaskType: "canvas_video", outcome })) {
                    skipStoredVideoRetry = true;
                } else {
                    const requestProjectId = projectId;
                    const controller = startGenerationRequest(node.id, node.id);
                    setRunningNodeId(node.id);
                    try {
                        const handled = await runVideoStoredReplay(node.metadata.taskId, controller.signal);
                        if (handled) return;
                    } finally {
                        finishGenerationRequest(node.id, controller);
                        if (projectIdRef.current === requestProjectId) setRunningNodeId(null);
                    }
                }
            }
            const { batchRoot, originalSourceId, originalSource, hasOwnMediaGenerationSetup, sourceNode } = resolvedSource;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const useStoredSource = hasSavedImageMetadata && !connectionsRef.current.some((connection) => connection.toNodeId === sourceNode.id) && (!originalSourceId || !originalSource);
            const generationSourceNode = node.metadata?.workflowProvider === "model" ? node : sourceNode;
            const sourceGenerationConfig = buildGenerationConfig(effectiveConfig, generationSourceNode, retryMode);
            let generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...sourceGenerationConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model || sourceGenerationConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality || sourceGenerationConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size || sourceGenerationConfig.size,
                          transparentBackground: (savedImageMetadata.transparentBackground || effectiveConfig.transparentBackground || sourceGenerationConfig.transparentBackground) === "true" ? "true" : "false",
                          count: "1",
                      }
                    : { ...sourceGenerationConfig, count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                surfaceRetryFailure(node.id, "当前模型尚未完成算力连接配置，请先在设置中完成连接后再重试", setNodes);
                navigateToSettings({ continueCreation: true });
                return;
            }

            const retryPromptSource = sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? node.metadata?.prompt ?? "";
            const nativeOutputs = retryMode === "image" ? modelCapabilityConfigFor(generationConfig, generationConfig.model).image?.fixedOutputs || 0 : 0;
            const groupRoot = batchRoot || node;
            const multipleNativeBatches = nativeOutputs > 0 && (groupRoot.metadata?.batchChildIds?.length || 0) > nativeOutputs;
            const emotionEdit = retryMode === "image" ? (node.metadata?.emotionEdit || batchRoot?.metadata?.emotionEdit) : undefined;
            const maskEdit = retryMode === "image" && !emotionEdit ? (node.metadata?.maskEdit || batchRoot?.metadata?.maskEdit) : undefined;
            const isStructuredMaskEditRetry = Boolean(emotionEdit || maskEdit);
            if (nativeOutputs && !multipleNativeBatches && !isStructuredMaskEditRetry) {
                const batchTarget =
                    node.metadata?.failedInputFingerprint || node.metadata?.failedPromptFingerprint || nodeFailureExplanation(node.metadata).category !== "unknown"
                        ? node
                        : groupRoot;
                const batchExplanation = nodeFailureExplanation(batchTarget.metadata);
                const batchOutcome = readNodeTaskOutcome(batchTarget.metadata);
                if (isRegenerateBlocked(batchOutcome)) {
                    const reason = batchTarget.metadata?.errorDetails || taskOutcomeCopy(batchOutcome, undefined, { providerCancelStatus: batchTarget.metadata?.taskProviderCancelStatus }).message;
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                let batchPrompted = false;
                if (shouldConfirmUnchangedModerationRetry(batchExplanation.category) || nodeRequiresRegenerateConfirmation(batchTarget.metadata, batchOutcome)) {
                    let batchContextPrompt = retryPromptSource;
                    let batchRefs: ReturnType<typeof submittedReferences> = [];
                    try {
                        const baseBatchContext = buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retryPromptSource, assets, false);
                        batchContextPrompt = baseBatchContext.prompt.trim();
                        batchRefs = submittedReferences({ mode: "image", prompt: batchContextPrompt, referenceImages: baseBatchContext.referenceImages });
                    } catch (error) {
                        const failure = generationFailureMetadata(error, retryPromptSource, sourceNodeReferenceImages(generationSourceNode));
                        message?.error?.(failure.errorDetails);
                        setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item)));
                        return;
                    }
                    const gate = await confirmRetryGate(batchTarget, batchExplanation.category, batchContextPrompt, batchRefs, new AbortController().signal);
                    if (!gate.confirmed) return;
                    batchPrompted = gate.prompted;
                }
                await regenerateImageBatch(groupRoot.id, retryPromptSource, batchPrompted ? { skipDuplicateConfirmation: true } : undefined);
                return;
            }
            if (multipleNativeBatches && !batchRoot) {
                const reason = "请使用重试失败批次，或选择失败图片重试；已完成的批次将保留";
                message?.warning?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
                return;
            }
            const nativeRetryTargets = multipleNativeBatches ? nodesRef.current.filter((item) => item.metadata?.batchRootId === batchRoot?.id && Boolean(node.metadata?.taskId) && item.metadata?.taskId === node.metadata?.taskId) : [];
            if (multipleNativeBatches && (nativeRetryTargets.length !== nativeOutputs || nativeRetryTargets.some((item) => item.metadata?.content || item.metadata?.storageKey))) {
                const reason = "该批次已有结果或任务状态不完整，请先取回原任务，避免重复生成";
                message?.warning?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
                return;
            }
            const structuredBatchChildren =
                isStructuredMaskEditRetry && nativeOutputs > 1 && !multipleNativeBatches && groupRoot.metadata?.batchChildIds?.length
                    ? groupRoot.metadata.batchChildIds
                          .map((id) => nodesRef.current.find((item) => item.id === id))
                          .filter((item): item is CanvasNodeData => Boolean(item && item.type === CanvasNodeType.Image && item.metadata?.batchRootId === groupRoot.id))
                    : [];
            if (isStructuredMaskEditRetry && nativeOutputs > 1 && !multipleNativeBatches) {
                if (!groupRoot.metadata?.isBatchRoot && !groupRoot.metadata?.batchChildIds?.length) {
                    const reason = "当前模型固定输出多张图片，请在原图重新发起编辑以创建完整批次";
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                const batchNodes = [groupRoot, ...structuredBatchChildren];
                const isLiveOrUncertain = (item: CanvasNodeData) => {
                    const itemOutcome = readNodeTaskOutcome(item.metadata);
                    const hasMedia = Boolean(item.metadata?.content || item.metadata?.storageKey);
                    return (
                        isCanvasNodeGenerating(item) ||
                        isTaskOutcomeWorking(itemOutcome) ||
                        isTaskOutcomeSubmissionUncertain(itemOutcome) ||
                        item.metadata?.taskStatus === "queued" ||
                        item.metadata?.taskStatus === "running" ||
                        ((itemOutcome?.phase === "ready" || item.metadata?.taskStatus === "succeeded") && !hasMedia) ||
                        item.metadata?.generationSubmissionState === "submitting" ||
                        item.metadata?.generationSubmissionState === "unknown"
                    );
                };
                if (batchNodes.some(isLiveOrUncertain)) {
                    const reason = "该批次仍在生成或结果待确认，请稍候或先查询原任务";
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                const blockedNode = batchNodes.find((item) => isRegenerateBlocked(readNodeTaskOutcome(item.metadata)));
                if (blockedNode) {
                    const blockedOutcome = readNodeTaskOutcome(blockedNode.metadata);
                    const reason = blockedNode.metadata?.errorDetails || taskOutcomeCopy(blockedOutcome, undefined, { providerCancelStatus: blockedNode.metadata?.taskProviderCancelStatus }).message;
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                if (
                    structuredBatchChildren.length !== nativeOutputs ||
                    structuredBatchChildren.some((item) => Boolean(item.metadata?.content || item.metadata?.storageKey))
                ) {
                    const reason = "该批次已有结果或任务状态不完整，请先取回原任务，避免重复生成";
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
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
            const primaryTarget = retryTargets.find((item) => Boolean(item.metadata?.taskId || readNodeTaskOutcome(item.metadata))) || retryTargets[0] || node;
            const retryContextPrompt = retryMode === "image" && sourceNode.metadata?.portraitTexture ? buildPortraitTexturePrompt(retryPromptSource, sourceNode.metadata.portraitTexture) : retryPromptSource;
            let rawContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>> | null;
            try {
                const promptOnly = retryMode === "video";
                if (useStoredSource) rawContext = null;
                else {
                    const baseContext = buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retryContextPrompt, assets, promptOnly, { preserveMediaBindings: retryMode === "video" });
                    rawContext = await hydrateNodeGenerationContext(baseContext, projectId, domainProjectId, retryMode, retryMode === "video" && supportsVideoReferenceAudio(generationConfig), !promptOnly && retryMode !== "audio");
                }
            } catch (error) {
                const failure = generationFailureMetadata(error, retryPromptSource, sourceNodeReferenceImages(generationSourceNode));
                message?.error?.(failure.errorDetails);
                setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item)));
                return;
            }
            let skillMetadata: SkillRuntimeMetadata = {
                skillIds: node.metadata?.skillIds || [],
                skillVersions: node.metadata?.skillVersions || [],
                skillFiles: node.metadata?.skillFiles || [],
            };
            let context = rawContext;
            if (rawContext) {
                try {
                    const skillExecution = await skillRuntime.prepare({ profile: "canvas", prompt: rawContext.prompt, skills: addedSkills });
                    context = { ...rawContext, prompt: skillExecution.prompt };
                    if (retryMode === "video") context = compileNodeGenerationReferences(context, generationConfig, buildVideoGenerationMetadata(node, context, generationConfig).videoEditOperation);
                    skillMetadata = skillExecution.metadata;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "技能上下文加载失败";
                    message?.error?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
            }
            const prompt = (context?.prompt || savedImageMetadata?.prompt || "").trim();
            if (!prompt) {
                const reason = storedVideoFallbackError instanceof Error ? storedVideoFallbackError.message : "找不到提示词，无法重试";
                if (storedVideoFallbackError) message?.error?.(reason);
                else message?.warning?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
                return;
            }
            let mediaPrompt = prompt;
            let styleMetadata = {};
            if (node.type === CanvasNodeType.Image) {
                try {
                    const runtime = resolveCanvasStyleExecution(nodesRef.current, sourceNode, prompt, generationConfig, "image");
                    if (runtime) {
                        mediaPrompt = runtime.prompt;
                        styleMetadata = { styleProfileJson: runtime.profileJson, styleExecutionPlan: runtime.plan };
                    }
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "项目画风与当前模型不兼容";
                    message?.error?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
            }
            if (retryMode === "audio" && context) {
                const hydratedAudioInput = {
                    textCount: context.textCount,
                    imageCount: context.imageCount,
                    videoCount: context.videoCount,
                    audioCount: context.audioCount,
                    characterCount: 0,
                };
                generationConfig = {
                    ...buildGenerationConfig(effectiveConfig, generationSourceNode, "audio", { capability: "audio", input: hydratedAudioInput }),
                    count: "1",
                };
                const compatibilityError = audioSubmissionCompatibilityError(effectiveConfig, generationConfig.model, hydratedAudioInput);
                if (compatibilityError) {
                    message?.error?.(compatibilityError);
                    surfaceRetryFailure(node.id, compatibilityError, setNodes);
                    return;
                }
            }
            if (retryMode === "audio" && context?.characterReferences.length) {
                if (context.characterReferences.length !== 1) {
                    const reason = "角色配音一次只能引用一个角色卡";
                    message?.error?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                const voice = context.resolvedCharacterVoices[0];
                const hasReferenceMedia = context.referenceImages.length > 0 || context.referenceAudios.length > 0;
                if (!voice && !hasReferenceMedia) {
                    const reason = "角色尚未绑定可用声音，无法重试角色配音任务";
                    message?.error?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                if (voice) {
                    generationConfig = { ...generationConfig, audioVoice: voice.voiceKey || generationConfig.audioVoice, audioInstructions: [voice.instructions, generationConfig.audioInstructions].filter(Boolean).join("；") };
                }
            }
            const useReferenceImages = !isStructuredMaskEditRetry && (Boolean(context?.referenceImages.length) || (useStoredSource && savedImageMetadata?.generationType === "edit"));
            const retryReferenceImages = isStructuredMaskEditRetry
                ? []
                : useStoredSource && savedImageMetadata
                    ? await resolveMetadataReferences(savedImageMetadata)
                    : context?.referenceImages || [];
            if (useReferenceImages && !retryReferenceImages) {
                markMissingReferences(node.id, setNodes);
                message?.error?.("参考图片已丢失，无法继续重试");
                return;
            }
            const retryImages = retryReferenceImages || [];
            const storedVideoImages = node.type === CanvasNodeType.Video && !context?.referenceImages.length ? await resolveStoredReferenceImages(node.metadata?.references) : [];
            if (storedVideoImages === null) {
                markMissingReferences(node.id, setNodes);
                message?.error?.("参考图片已丢失，无法继续重试");
                return;
            }
            const videoReferenceImages = context?.referenceImages.length ? context.referenceImages : storedVideoImages;
            const videoContext =
                node.type === CanvasNodeType.Video
                    ? {
                          prompt,
                          referenceImages: videoReferenceImages,
                          referenceVideos: context?.referenceVideos || [],
                          referenceAudios: context?.referenceAudios || [],
                          textCount: context?.textCount || 0,
                          imageCount: videoReferenceImages.length,
                          videoCount: context?.referenceVideos.length || 0,
                          audioCount: context?.referenceAudios.length || 0,
                      }
                    : undefined;

            const runningId = structuredBatchRootId || node.id;
            setRunningNodeId(runningId);
            const controller = startGenerationRequest(retryTargetIds[0]!, sourceNode.id, runningId);
            retryTargetIds.slice(1).forEach((id) => startGenerationRequest(id, sourceNode.id, runningId, controller));
            if (structuredBatchRootId && !retryTargetIdSet.has(structuredBatchRootId)) {
                startGenerationRequest(structuredBatchRootId, sourceNode.id, runningId, controller);
            }
            const capturedProjectId = projectId;
            const isCurrent = () => projectIdRef.current === capturedProjectId && !controller.signal.aborted;
            let submittedInput: CanvasGenerationFailureInput = { ...context, prompt: mediaPrompt };
            const completedRetryTargetIds = new Set<string>();
            const runAndConsumeRetry = async (input: Parameters<typeof runBackendCanvasGenerationTask>[0]) => {
                submittedInput = input;
                const outcome = readNodeTaskOutcome(primaryTarget.metadata);
                if (isRegenerateBlocked(outcome)) {
                    const reason = primaryTarget.metadata?.errorDetails || taskOutcomeCopy(outcome, undefined, { providerCancelStatus: primaryTarget.metadata?.taskProviderCancelStatus }).message;
                    message?.warning?.(reason);
                    surfaceRetryFailure(node.id, reason, setNodes);
                    return;
                }
                if (!confirmedUnchangedModeration) {
                    const targetExplanation = nodeFailureExplanation(primaryTarget.metadata);
                    const gate = await confirmRetryGate(primaryTarget, targetExplanation.category !== "unknown" ? targetExplanation.category : failureExplanation.category, input.prompt, submittedReferences(input), controller.signal);
                    if (!gate.confirmed) return;
                    confirmedUnchangedModeration = gate.prompted;
                }
                const nodeTaskType =
                    node.type === CanvasNodeType.Image
                        ? "canvas_image"
                        : node.type === CanvasNodeType.Video
                          ? "canvas_video"
                          : node.type === CanvasNodeType.Audio
                            ? "canvas_audio"
                            : undefined;
                const requiresFreshSubmission = nodeRequiresFreshSubmission(primaryTarget.metadata, { nodeTaskType, outcome });
                // Edited input after a non-retryable failure or unconfirmed/submitted task is a new submission, not replay of the old retry operation.
                const retryContext = !storedVideoFallbackError && !skipStoredVideoRetry && !requiresFreshSubmission && primaryTarget.metadata?.taskId && isRegenerateAllowed(outcome)
                    ? await createGenerationRetryContext(primaryTarget.metadata.taskId, primaryTarget.metadata.attemptGroupId)
                    : primaryTarget.metadata?.taskClientOperationId && !primaryTarget.metadata?.taskId
                      ? { clientOperationId: primaryTarget.metadata.taskClientOperationId }
                      : { clientOperationId: createClientId() };
                const targetIds = retryTargetIds;
                const targetIdSet = retryTargetIdSet;
                setNodes((current) => current.map((item) => {
                    const outputIndex = targetIds.indexOf(item.id);
                    if (outputIndex >= 0) {
                        return {
                            ...item,
                            metadata: {
                                ...resetGenerationTaskMetadata(item.metadata, NODE_STATUS_LOADING),
                                ...(targetIds.length > 1 ? { taskOutputIndex: outputIndex } : {}),
                                taskClientOperationId: retryContext.clientOperationId,
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
                }));
                await runCanvasGenerationTaskToConsumer(
                    {
                        ...input,
                        ...(targetIds.length > 1
                            ? {
                                  config: { ...input.config, count: String(nativeOutputs || targetIds.length) },
                                  metadata: { ...input.metadata, outputNodeIds: targetIds },
                              }
                            : {}),
                        ...retryContext,
                    },
                    {
                        onSubmission: (metadata) => setNodes((current) => current.map((item) => targetIdSet.has(item.id) ? { ...item, metadata: { ...item.metadata, ...metadata } } : item)),
                        bindTask: (task) => targetIds.forEach((id) => bindGenerationTask(id, task)),
                        consumeTask: async (task) => {
                            for (const id of targetIds) {
                                await applyGenerationTaskResult(id, task);
                                completedRetryTargetIds.add(id);
                            }
                            if (structuredBatchRootId && !targetIdSet.has(structuredBatchRootId)) {
                                setNodes((current) => current.map((item) => (item.id === structuredBatchRootId ? reconcileImageBatchRoot(item, current) : item)));
                            }
                        },
                        isCurrent,
                    },
                );
            };

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "text",
                        prompt,
                        config: generationConfig,
                        referenceImages: context.referenceImages,
                        referenceVideos: context.referenceVideos,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: sourceNode.id, resolvedCharacterVersions: context.resolvedCharacterVersions },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    if (creativeInputFailure && node.metadata?.taskId && node.metadata.status === "error") {
                        const outcome = readNodeTaskOutcome(node.metadata);
                        if (isRegenerateBlocked(outcome)) {
                            const reason = node.metadata?.errorDetails || taskOutcomeCopy(outcome, undefined, { providerCancelStatus: node.metadata?.taskProviderCancelStatus }).message;
                            message?.warning?.(reason);
                            surfaceRetryFailure(node.id, reason, setNodes);
                            return;
                        }
                        const videoRefs = submittedReferences({
                            mode: "video",
                            prompt: mediaPrompt,
                            referenceImages: videoContext?.referenceImages || [],
                            referenceVideos: videoContext?.referenceVideos || [],
                            referenceAudios: videoContext?.referenceAudios || [],
                        });
                        const gate = await confirmRetryGate(node, failureExplanation.category, mediaPrompt, videoRefs, controller.signal);
                        if (!gate.confirmed) return;
                        confirmedUnchangedModeration = gate.prompted;
                        if (gate.baseline.canReplayStoredTask && !nodeRequiresFreshSubmission(node.metadata, { nodeTaskType: "canvas_video", outcome })) {
                            const handled = await runVideoStoredReplay(node.metadata.taskId, controller.signal);
                            if (handled) return;
                        } else {
                            skipStoredVideoRetry = true;
                        }
                    }
                    const videoGenerationMetadata = buildVideoGenerationMetadata(node, videoContext, generationConfig);
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
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
                                          references: videoContext ? generationReferenceUrls(videoContext) : item.metadata?.references,
                                      },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "video",
                        prompt: mediaPrompt,
                        config: generationConfig,
                        referenceImages: videoContext?.referenceImages || [],
                        referenceVideos: videoContext?.referenceVideos || [],
                        referenceAudios: videoContext?.referenceAudios || [],
                        signal: controller.signal,
                        metadata: {
                            retry: true,
                            sourceNodeId: sourceNode.id,
                            resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                            resolvedCharacterVoices: context?.resolvedCharacterVoices || [],
                            promptTemplateOperation: node.metadata?.promptTemplateOperation,
                            promptTemplateVariables: node.metadata?.promptTemplateVariables,
                            ...videoGenerationMetadata,
                            ...styleMetadata,
                            ...skillMetadata,
                        },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "audio",
                        prompt,
                        config: generationConfig,
                        referenceImages: context?.referenceImages || [],
                        referenceAudios: context?.referenceAudios || [],
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: sourceNode.id, resolvedCharacterVersions: context?.resolvedCharacterVersions || [], resolvedCharacterVoiceKey: context?.resolvedCharacterVoices[0]?.voiceKey },
                    });
                    return;
                }

                if (emotionEdit) {
                    const emotionSource = nodesRef.current.find((item) => item.id === emotionEdit.sourceNodeId);
                    if (!emotionSource || (!emotionSource.metadata?.content && !emotionSource.metadata?.storageKey)) throw new Error("情绪编辑源图片已删除，无法重试");
                    const imageProfile = modelCapabilityConfigFor(generationConfig, generationConfig.model).image!;
                    if (imageProfile.references.maxImages === 0) throw new Error("当前图片模型仅支持文生图，不支持图片重绘");
                    const sourceReference = sourceNodeReferenceImages(emotionSource)[0];
                    if (!sourceReference) throw new Error("情绪编辑源图片不可用");
                    const sourceWidth = emotionSource.metadata.naturalWidth || emotionEdit.sourceWidth || emotionSource.width;
                    const sourceHeight = emotionSource.metadata.naturalHeight || emotionEdit.sourceHeight || emotionSource.height;
                    if (!sourceWidth || !sourceHeight) throw new Error("无法读取情绪编辑源图片尺寸");
                    const editPlan = imageEditPlan(imageProfile, 1);
                    const localComposite = editPlan.mode === "local-composite";
                    const modelDefaults = defaultImageParamsForModel(generationConfig, generationConfig.model);
                    const rawSize = emotionSource.metadata.size || modelDefaults.size;
                    const emotionConfig = {
                        ...generationConfig,
                        count: String(editPlan.outputsPerRequest),
                        size: normalizeMaskEditSize(rawSize, imageProfile.size?.values ?? [], modelDefaults.size, Boolean(imageProfile.size?.allowCustom)),
                        quality: normalizeMaskEditQuality(generationConfig.quality || modelDefaults.quality, rawSize, imageProfile.quality?.supported ? imageProfile.quality.values : [], modelDefaults.quality),
                    };
                    const edit = buildFullImageEmotionEdit({
                        presetId: emotionEdit.presetId,
                        intimacy: emotionEdit.intimacy,
                        arousal: emotionEdit.arousal,
                        characterName: emotionEdit.characterName,
                        faceBox: emotionEdit.faceBox,
                        imageWidth: sourceWidth,
                        imageHeight: sourceHeight,
                    });
                    const baseEmotionPrompt = emotionEdit.fullImage ? mediaPrompt : (resolveCanvasStyleExecution(nodesRef.current, sourceNode, edit.prompt, emotionConfig, "image")?.prompt ?? edit.prompt);
                    const providerPrompt = formatMaskEditPrompt(baseEmotionPrompt, localComposite);
                    const nextEmotionEdit = {
                        ...emotionEdit,
                        editRegion: undefined,
                        sourceWidth,
                        sourceHeight,
                        editMode: editPlan.mode,
                        fullImage: true,
                    };
                    if (localComposite) message?.info?.("当前模型使用选区标记与本地蒙版融合，未选区域保留原图");
                    const generationMetadata = buildImageGenerationMetadata("edit", emotionConfig, editPlan.outputsPerRequest, [sourceReference]);
                    const updateIds = new Set([...retryTargetIds, ...(structuredBatchRootId ? [structuredBatchRootId] : [])]);
                    setNodes((current) =>
                        current.map((item) =>
                            updateIds.has(item.id)
                                ? {
                                      ...item,
                                      metadata: { ...item.metadata, prompt: providerPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata, emotionEdit: nextEmotionEdit },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: retryTargetIds[0]!,
                        mode: "image",
                        prompt: providerPrompt,
                        config: emotionConfig,
                        referenceImages: [sourceReference],
                        mask: { id: `${emotionSource.id}-emotion-mask`, name: "emotion-mask.png", type: "image/png", dataUrl: edit.maskDataUrl },
                        signal: controller.signal,
                        metadata: {
                            retry: true,
                            sourceNodeId: emotionSource.id,
                            edit: "emotion",
                            ...(localComposite ? { maskEditMode: "local-composite" } : {}),
                            emotion: nextEmotionEdit,
                            resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                            ...styleMetadata,
                            ...skillMetadata,
                        },
                    });
                    return;
                }

                if (maskEdit) {
                    const maskSource = nodesRef.current.find((item) => item.id === maskEdit.sourceNodeId);
                    const storedReferences = !maskSource && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : null;
                    const sourceReference = (maskSource ? sourceNodeReferenceImages(maskSource)[0] : undefined) || storedReferences?.[0];
                    if (!sourceReference) throw new Error("局部重绘源图片已删除，无法重试");
                    const imageProfile = modelCapabilityConfigFor(generationConfig, generationConfig.model).image!;
                    if (imageProfile.references.maxImages === 0) throw new Error("当前图片模型仅支持文生图，不支持图片重绘");
                    const maskStorageKey = maskEdit.maskStorageKey?.trim() || "";
                    if (!maskStorageKey) throw new Error("局部重绘蒙版已丢失，请重新在原图上涂抹后再生成");
                    const editPlan = imageEditPlan(imageProfile, 1);
                    const localComposite = editPlan.mode === "local-composite";
                    const modelDefaults = defaultImageParamsForModel(generationConfig, generationConfig.model);
                    const rawSize = generationConfig.size || maskSource?.metadata?.size || modelDefaults.size;
                    const maskConfig = {
                        ...generationConfig,
                        count: String(editPlan.outputsPerRequest),
                        size: normalizeMaskEditSize(rawSize, imageProfile.size?.values ?? [], modelDefaults.size, Boolean(imageProfile.size?.allowCustom)),
                        quality: normalizeMaskEditQuality(generationConfig.quality || modelDefaults.quality, rawSize, imageProfile.quality?.supported ? imageProfile.quality.values : [], modelDefaults.quality),
                    };
                    const providerPrompt = formatMaskEditPrompt(mediaPrompt, localComposite);
                    const nextMaskEdit = {
                        ...maskEdit,
                        editMode: editPlan.mode,
                        maskStorageKey,
                    };
                    if (localComposite) message?.info?.("当前模型使用选区标记与本地蒙版融合，未选区域保留原图");
                    const generationMetadata = buildImageGenerationMetadata("edit", maskConfig, editPlan.outputsPerRequest, [sourceReference]);
                    const updateIds = new Set([...retryTargetIds, ...(structuredBatchRootId ? [structuredBatchRootId] : [])]);
                    setNodes((current) =>
                        current.map((item) =>
                            updateIds.has(item.id)
                                ? {
                                      ...item,
                                      metadata: { ...item.metadata, prompt: providerPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata, maskEdit: nextMaskEdit },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: retryTargetIds[0]!,
                        mode: "image",
                        prompt: providerPrompt,
                        config: maskConfig,
                        referenceImages: [sourceReference],
                        mask: {
                            id: `${maskEdit.sourceNodeId}-mask`,
                            name: "mask.png",
                            type: "image/png",
                            dataUrl: "",
                            storageKey: maskStorageKey,
                        },
                        signal: controller.signal,
                        metadata: {
                            retry: true,
                            sourceNodeId: maskEdit.sourceNodeId,
                            edit: "mask",
                            ...(localComposite ? { maskEditMode: "local-composite" } : {}),
                            resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                            ...styleMetadata,
                            ...skillMetadata,
                        },
                    });
                    return;
                }

                const generationMetadata = buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((current) =>
                    current.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: { ...item.metadata, prompt: mediaPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata },
                              }
                            : item,
                    ),
                );
                await runAndConsumeRetry({
                    projectId,
                    nodeId: node.id,
                    mode: "image",
                    prompt: mediaPrompt,
                    config: generationConfig,
                    referenceImages: useReferenceImages ? retryImages : [],
                    signal: controller.signal,
                    metadata: {
                        retry: true,
                        sourceNodeId: sourceNode.id,
                        resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                        promptTemplateOperation: node.metadata?.promptTemplateOperation,
                        promptTemplateVariables: node.metadata?.promptTemplateVariables,
                        ...styleMetadata,
                        ...skillMetadata,
                    },
                });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const failure = canvasGenerationFailureMetadata(error, submittedInput);
                message?.error?.(failure.errorDetails);
                setNodes((current) => {
                    const updated = current.map((item) =>
                        retryTargetIdSet.has(item.id) && !completedRetryTargetIds.has(item.id)
                            ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } }
                            : item,
                    );
                    if (!structuredBatchRootId || retryTargetIdSet.has(structuredBatchRootId)) return updated;
                    return updated.map((item) => (item.id === structuredBatchRootId ? reconcileImageBatchRoot(item, updated) : item));
                });
            } finally {
                retryTargetIds.forEach((id) => finishGenerationRequest(id, controller));
                if (structuredBatchRootId && !retryTargetIdSet.has(structuredBatchRootId)) {
                    finishGenerationRequest(structuredBatchRootId, controller);
                }
                setRunningNodeId(null);
            }
        },
        [addedSkills, applyGenerationTaskResult, assets, bindGenerationTask, connectionsRef, domainProjectId, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, modal, nodesRef, onEditGenerationInput, pageUi, projectId, readOnly, regenerateImageBatch, setNodes, setRunningNodeId, startGenerationRequest],
    );
}

// 生成类型必须由明确的节点契约决定，未知节点不能降级成图片任务。
function retryModeForNode(type: CanvasNodeTypeId): CanvasNodeGenerationMode | null {
    if (type === CanvasNodeType.Text) return "text";
    if (type === CanvasNodeType.Image) return "image";
    if (type === CanvasNodeType.Video) return "video";
    if (type === CanvasNodeType.Audio) return "audio";
    return null;
}

function surfaceRetryFailure(nodeId: string, reason: string, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
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

function markMissingReferences(nodeId: string, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    surfaceRetryFailure(nodeId, "参考图片已丢失，无法继续重试", setNodes);
}
