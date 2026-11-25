import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";

import {
    buildNodeGenerationContext,
    compileNodeGenerationReferences,
    hydrateNodeGenerationContext,
} from "@/components/canvas/canvas-node-generation";
import { isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { resolveCanvasGenerationInputSource } from "@/lib/canvas/canvas-generation-failure-ux";
import { reconcileImageBatchRoot } from "@/lib/canvas/canvas-image-batch-retry";
import { nodeFailureExplanation } from "@/lib/canvas/canvas-node-failure-state";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import {
    buildAudioGenerationMetadata,
    buildGenerationConfig,
    buildImageGenerationMetadata,
    buildVideoGenerationMetadata,
    isGenerationCanceled,
    resolveMetadataReferences,
    resolveStoredReferenceImages,
    runBackendCanvasGenerationTask,
    runCanvasGenerationTaskToConsumer,
    sourceNodeReferenceImages,
    supportsVideoReferenceAudio,
} from "@/lib/canvas/canvas-project-generation";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { generationFailureMetadata } from "@/lib/generation-error";
import { isCreativeInputFailureCategory, shouldConfirmUnchangedModerationRetry } from "@/lib/generation-failure-ux";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { navigateToSettings } from "@/lib/settings-navigation";
import {
    isRegenerateBlocked,
    nodeRequiresFreshSubmission,
    nodeRequiresRegenerateConfirmation,
    readNodeTaskOutcome,
} from "@/lib/task-outcome";
import type { Skill } from "@/services/api/skills";
import type { GenerationTask } from "@/services/api/task-center";
import { skillRuntime, type SkillRuntimeMetadata } from "@/services/skill-runtime";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";
import type { Asset } from "@/stores/use-asset-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { canvasGenerationFailureMetadata, submittedReferences, type CanvasGenerationFailureInput } from "./canvas-generation-failure";
import {
    applyRetryFailureToNodes,
    blockedOutcomeReason,
    buildRetryLoadingNodes,
    buildVideoRetryMetadataPatch,
    confirmCanvasRetryGate,
    executeStoredVideoReplay,
    markMissingReferences,
    NODE_STATUS_ERROR,
    prepareAudioRetryConfig,
    prepareStructuredImageEditRetry,
    resolveImageRetryConfig,
    resolveRetrySubmissionContext,
    resolveRetryTargetPlan,
    retryModeForNode,
    surfaceRetryFailure,
    type HydratedCanvasContext,
    type RetryGateDeps,
    type StructuredImageEditInput,
} from "./canvas-generation-retry-plan";

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
            const warnFailure = (reason: string) => {
                message?.warning?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
            };
            const errorFailure = (reason: string) => {
                message?.error?.(reason);
                surfaceRetryFailure(node.id, reason, setNodes);
            };

            if (isDepthCaptureResultNode(node)) {
                warnFailure("深度动作捕捉节点必须使用本地深度任务重试");
                return;
            }
            const retryMode = retryModeForNode(node.type);
            if (!retryMode) {
                warnFailure("当前节点不能使用通用生成重试");
                return;
            }

            let storedVideoFallbackError: unknown;
            let confirmedUnchangedModeration = false;
            let skipStoredVideoRetry = false;
            const resolvedSource = resolveCanvasGenerationInputSource(node, nodesRef.current, connectionsRef.current);
            const failureExplanation = nodeFailureExplanation(node.metadata);
            const creativeInputFailure = isCreativeInputFailureCategory(failureExplanation.category);
            const gateDeps: RetryGateDeps = { node, modal, readOnly, onEditGenerationInput, pageUi, nodesRef, connectionsRef };

            const runVideoStoredReplay = async (taskId: string, signal: AbortSignal) => {
                const replay = await executeStoredVideoReplay({
                    node,
                    taskId,
                    signal,
                    projectId,
                    projectIdRef,
                    retryingVideos,
                    bindGenerationTask,
                    applyGenerationTaskResult,
                    setNodes,
                    message,
                });
                if (!replay.handled) {
                    storedVideoFallbackError = replay.fallbackError;
                    return false;
                }
                return true;
            };

            if (!creativeInputFailure && retryMode === "video" && node.metadata?.taskId && node.metadata.status === "error") {
                const outcome = readNodeTaskOutcome(node.metadata);
                if (isRegenerateBlocked(outcome)) {
                    warnFailure(blockedOutcomeReason(node, outcome));
                    return;
                }
                if (nodeRequiresFreshSubmission(node.metadata, { nodeTaskType: "canvas_video", outcome })) {
                    skipStoredVideoRetry = true;
                } else {
                    const requestProjectId = projectId;
                    const controller = startGenerationRequest(node.id, node.id);
                    setRunningNodeId(node.id);
                    try {
                        if (await runVideoStoredReplay(node.metadata.taskId, controller.signal)) return;
                    } finally {
                        finishGenerationRequest(node.id, controller);
                        if (projectIdRef.current === requestProjectId) setRunningNodeId(null);
                    }
                }
            }

            const { batchRoot, originalSourceId, originalSource, sourceNode } = resolvedSource;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const useStoredSource =
                Boolean(savedImageMetadata?.generationType) &&
                !connectionsRef.current.some((connection) => connection.toNodeId === sourceNode.id) &&
                (!originalSourceId || !originalSource);
            const generationSourceNode = node.metadata?.workflowProvider === "model" ? node : sourceNode;
            let generationConfig = resolveImageRetryConfig(
                effectiveConfig,
                buildGenerationConfig(effectiveConfig, generationSourceNode, retryMode),
                savedImageMetadata,
            );
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
                    warnFailure(blockedOutcomeReason(batchTarget, batchOutcome));
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
                    const gate = await confirmCanvasRetryGate(gateDeps, batchTarget, batchExplanation.category, batchContextPrompt, batchRefs, new AbortController().signal);
                    if (!gate.confirmed) return;
                    batchPrompted = gate.prompted;
                }
                await regenerateImageBatch(groupRoot.id, retryPromptSource, batchPrompted ? { skipDuplicateConfirmation: true } : undefined);
                return;
            }

            const targetPlan = resolveRetryTargetPlan({
                node,
                batchRoot,
                groupRoot,
                nativeOutputs,
                multipleNativeBatches,
                isStructuredMaskEditRetry,
                nodes: nodesRef.current,
            });
            if ("error" in targetPlan) {
                warnFailure(targetPlan.error);
                return;
            }
            const { retryTargetIds, retryTargetIdSet, structuredBatchRootId, primaryTarget } = targetPlan;

            const retryContextPrompt =
                retryMode === "image" && sourceNode.metadata?.portraitTexture
                    ? buildPortraitTexturePrompt(retryPromptSource, sourceNode.metadata.portraitTexture)
                    : retryPromptSource;
            let rawContext: HydratedCanvasContext | null;
            try {
                const promptOnly = retryMode === "video";
                rawContext = useStoredSource
                    ? null
                    : await hydrateNodeGenerationContext(
                          buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retryContextPrompt, assets, promptOnly, {
                              preserveMediaBindings: retryMode === "video",
                          }),
                          projectId,
                          domainProjectId,
                          retryMode,
                          retryMode === "video" && supportsVideoReferenceAudio(generationConfig),
                          !promptOnly && retryMode !== "audio",
                      );
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
                    if (retryMode === "video") {
                        context = compileNodeGenerationReferences(context, generationConfig, buildVideoGenerationMetadata(node, context, generationConfig).videoEditOperation);
                    }
                    skillMetadata = skillExecution.metadata;
                } catch (error) {
                    errorFailure(error instanceof Error ? error.message : "技能上下文加载失败");
                    return;
                }
            }

            const prompt = (context?.prompt || savedImageMetadata?.prompt || "").trim();
            if (!prompt) {
                const reason = storedVideoFallbackError instanceof Error ? storedVideoFallbackError.message : "找不到提示词，无法重试";
                if (storedVideoFallbackError) errorFailure(reason);
                else warnFailure(reason);
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
                    errorFailure(error instanceof Error ? error.message : "项目画风与当前模型不兼容");
                    return;
                }
            }

            if (retryMode === "audio" && context) {
                const preparedAudio = prepareAudioRetryConfig({ effectiveConfig, generationSourceNode, generationConfig, context });
                if ("error" in preparedAudio) {
                    errorFailure(preparedAudio.error);
                    return;
                }
                generationConfig = preparedAudio.config;
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
                    warnFailure(blockedOutcomeReason(primaryTarget, outcome));
                    return;
                }
                if (!confirmedUnchangedModeration) {
                    const targetExplanation = nodeFailureExplanation(primaryTarget.metadata);
                    const category = targetExplanation.category !== "unknown" ? targetExplanation.category : failureExplanation.category;
                    const gate = await confirmCanvasRetryGate(gateDeps, primaryTarget, category, input.prompt, submittedReferences(input), controller.signal);
                    if (!gate.confirmed) return;
                    confirmedUnchangedModeration = gate.prompted;
                }
                const retryContext = await resolveRetrySubmissionContext({
                    nodeType: node.type,
                    primaryTarget,
                    outcome,
                    storedVideoFallbackError,
                    skipStoredVideoRetry,
                });
                setNodes((current) => buildRetryLoadingNodes(current, retryTargetIds, structuredBatchRootId, retryContext.clientOperationId));
                await runCanvasGenerationTaskToConsumer(
                    {
                        ...input,
                        ...(retryTargetIds.length > 1
                            ? {
                                  config: { ...input.config, count: String(nativeOutputs || retryTargetIds.length) },
                                  metadata: { ...input.metadata, outputNodeIds: retryTargetIds },
                              }
                            : {}),
                        ...retryContext,
                    },
                    {
                        onSubmission: (metadata) =>
                            setNodes((current) => current.map((item) => (retryTargetIdSet.has(item.id) ? { ...item, metadata: { ...item.metadata, ...metadata } } : item))),
                        bindTask: (task) => retryTargetIds.forEach((id) => bindGenerationTask(id, task)),
                        consumeTask: async (task) => {
                            for (const id of retryTargetIds) {
                                await applyGenerationTaskResult(id, task);
                                completedRetryTargetIds.add(id);
                            }
                            if (structuredBatchRootId && !retryTargetIdSet.has(structuredBatchRootId)) {
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
                            warnFailure(blockedOutcomeReason(node, outcome));
                            return;
                        }
                        const videoRefs = submittedReferences({
                            mode: "video",
                            prompt: mediaPrompt,
                            referenceImages: videoContext?.referenceImages || [],
                            referenceVideos: videoContext?.referenceVideos || [],
                            referenceAudios: videoContext?.referenceAudios || [],
                        });
                        const gate = await confirmCanvasRetryGate(gateDeps, node, failureExplanation.category, mediaPrompt, videoRefs, controller.signal);
                        if (!gate.confirmed) return;
                        confirmedUnchangedModeration = gate.prompted;
                        if (gate.baseline.canReplayStoredTask && !nodeRequiresFreshSubmission(node.metadata, { nodeTaskType: "canvas_video", outcome })) {
                            if (await runVideoStoredReplay(node.metadata.taskId, controller.signal)) return;
                        } else {
                            skipStoredVideoRetry = true;
                        }
                    }
                    const { videoGenerationMetadata, patch } = buildVideoRetryMetadataPatch({
                        node,
                        mediaPrompt,
                        generationConfig,
                        videoContext,
                        styleMetadata,
                        skillMetadata,
                    });
                    setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...patch } } : item)));
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
                        metadata: {
                            retry: true,
                            sourceNodeId: sourceNode.id,
                            resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                            resolvedCharacterVoiceKey: context?.resolvedCharacterVoices[0]?.voiceKey,
                        },
                    });
                    return;
                }
                const structuredEdit: StructuredImageEditInput | undefined = emotionEdit
                    ? { kind: "emotion", edit: emotionEdit }
                    : maskEdit
                      ? { kind: "mask", edit: maskEdit }
                      : undefined;
                if (structuredEdit) {
                    const editPlan = await prepareStructuredImageEditRetry({
                        structuredEdit,
                        nodes: nodesRef.current,
                        sourceNode,
                        savedImageMetadata,
                        generationConfig,
                        mediaPrompt,
                    });
                    if (editPlan.localComposite) message?.info?.("当前模型使用选区标记与本地蒙版融合，未选区域保留原图");
                    const updateIds = new Set([...retryTargetIds, ...(structuredBatchRootId ? [structuredBatchRootId] : [])]);
                    setNodes((current) =>
                        current.map((item) =>
                            updateIds.has(item.id)
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          prompt: editPlan.providerPrompt,
                                          ...editPlan.generationMetadata,
                                          ...styleMetadata,
                                          ...skillMetadata,
                                          ...editPlan.nodeMetadataPatch,
                                      },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: retryTargetIds[0]!,
                        mode: "image",
                        prompt: editPlan.providerPrompt,
                        config: editPlan.config,
                        referenceImages: [editPlan.sourceReference],
                        mask: editPlan.mask,
                        signal: controller.signal,
                        metadata: {
                            retry: true,
                            sourceNodeId: editPlan.sourceNodeId,
                            ...editPlan.taskMetadataExtra,
                            ...(editPlan.localComposite ? { maskEditMode: "local-composite" } : {}),
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
                            ? { ...item, metadata: { ...item.metadata, prompt: mediaPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata } }
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
                setNodes((current) => applyRetryFailureToNodes(current, retryTargetIdSet, completedRetryTargetIds, structuredBatchRootId, failure));
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
