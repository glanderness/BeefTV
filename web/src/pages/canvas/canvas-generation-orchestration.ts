import type { Dispatch, SetStateAction } from "react";
import { nanoid } from "nanoid";
import { beefTVImageContract } from "@/lib/beeftv-image-contracts";
import { survivingGenerationHistoryImageOutputs } from "@/lib/canvas/canvas-generation-history";

import { getNodeSpec } from "@/constant/canvas";
import { findAvailableGenerationGroupPosition } from "@/lib/canvas/canvas-generation-layout";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { modelCompatibilityError } from "@/lib/model-selection";
import { seedanceSettingsConstraints } from "@/lib/seedance-task-constraints";
import { seedreamFamily, seedreamSupportsLayerSplit } from "@/lib/seedream-image";
import { applyGenerationTaskResultToNodes, applyMaterializedGenerationTaskResultToNodes, generationTaskMode } from "@/lib/canvas/canvas-generation-task-sync";
import { failedImageBatchChildren, markImageBatchRetrying, reconcileImageBatchRoot, restoreUnsubmittedImageBatchChild } from "@/lib/canvas/canvas-image-batch-retry";
import { bindMissingCanvasResourceAssets, canvasNodesMissingResourceAssetBinding } from "@/lib/canvas/canvas-node-asset";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { getGenerationCount } from "@/lib/canvas/canvas-project-generation";
import { isDepthCaptureResultNode } from "@/lib/canvas/canvas-depth-capture";
import { canvasNodeFailureView } from "@/lib/canvas/canvas-node-failure-view";
import type { GenerationTask } from "@/services/api/task-center";
import type { Asset } from "@/stores/use-asset-store";
import { normalizeModelOptionValue, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

import { CanvasOwnerAbandonedError, canvasOwnerCanPersist, canvasOwnerEpochMatches, canvasOwnerUserMatches, type CanvasOwnerEpoch } from "./canvas-owner-epoch";

const NODE_STATUS_SUCCESS = "success" as const;

export type CanvasNodeRetryPlan =
    | { kind: "history" }
    | { kind: "depth" }
    | { kind: "script"; prompt: string }
    | { kind: "script-empty" }
    | { kind: "image-batch-root"; children: CanvasNodeData[] }
    | { kind: "image-batch-empty" }
    | { kind: "image-batch-child"; rootId: string }
    | { kind: "single" };

export function canvasNodeRetryPlan(node: CanvasNodeData, nodes: CanvasNodeData[]): CanvasNodeRetryPlan {
    if (canvasNodeFailureView(node).recoveryRoute === "history") return { kind: "history" };
    if (isDepthCaptureResultNode(node)) return { kind: "depth" };
    if (node.type === CanvasNodeType.Script) {
        const prompt = (node.metadata?.composerContent || node.metadata?.prompt || "").trim();
        return prompt ? { kind: "script", prompt } : { kind: "script-empty" };
    }
    if (node.type === CanvasNodeType.Image && node.metadata?.isBatchRoot) {
        const children = failedImageBatchChildren(node, nodes);
        return children.length ? { kind: "image-batch-root", children } : { kind: "image-batch-empty" };
    }
    if (node.type === CanvasNodeType.Image && node.metadata?.batchRootId) {
        return { kind: "image-batch-child", rootId: node.metadata.batchRootId };
    }
    return { kind: "single" };
}

export function selectRetryableImageBatchChildren(children: CanvasNodeData[]) {
    // 批量重试没有逐个确认：需要确认（可能再次扣费）的子节点只能单独重新生成。
    const retryable = children.filter((child) => {
        const view = canvasNodeFailureView(child);
        return !view.regenerateBlocked && !view.regenerateConfirm;
    });
    return { retryable, blocked: retryable.length < children.length };
}

export function reconcileImageBatchRootNodes(rootId: string, nodes: CanvasNodeData[]) {
    const root = nodes.find((item) => item.id === rootId);
    if (!root) return nodes;
    const reconciled = reconcileImageBatchRoot(root, nodes);
    return nodes.map((item) => (item.id === root.id ? reconciled : item));
}

export async function runImageBatchChildRetry(input: {
    rootId: string;
    children: CanvasNodeData[];
    retry: (child: CanvasNodeData) => Promise<unknown>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    reconcile: (rootId: string) => void;
}) {
    const childIds = input.children.map((child) => child.id);
    input.setNodes((current) => markImageBatchRetrying(input.rootId, childIds, current));
    await Promise.allSettled(
        input.children.map(async (child) => {
            await input.retry(child);
            input.setNodes((current) => current.map((item) => (item.id === child.id ? restoreUnsubmittedImageBatchChild(item, child) : item)));
        }),
    );
    input.reconcile(input.rootId);
}

export type ImageNodeFromTextConfig = {
    imageModel?: string;
    model?: string;
    size?: string;
    quality?: string;
    transparentBackground?: string;
    canvasImageCount?: string;
    count?: string;
};

export type ImageNodeFromTextResult =
    | { ok: false; reason: "empty-prompt" | "missing-source" }
    | { ok: true; imageNode: CanvasNodeData; connection: CanvasConnection; nextNodes: CanvasNodeData[]; nextConnections: CanvasConnection[] };

export function createImageNodeFromTextSource(input: {
    sourceId: string;
    prompt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    config: ImageNodeFromTextConfig;
    connectionId?: string;
}): ImageNodeFromTextResult {
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, reason: "empty-prompt" };
    const sourceNode = input.nodes.find((item) => item.id === input.sourceId);
    if (!sourceNode) return { ok: false, reason: "missing-source" };
    const nodeSize = getNodeSpec(CanvasNodeType.Image);
    const imageNode = createCanvasNode(
        CanvasNodeType.Image,
        {
            x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
            y: sourceNode.position.y + sourceNode.height / 2,
        },
        {
            prompt: "@文本1",
            composerContent: "@文本1",
            model: input.config.imageModel || input.config.model,
            size: input.config.size,
            quality: input.config.quality,
            transparentBackground: input.config.transparentBackground,
            count: getGenerationCount(input.config.canvasImageCount || input.config.count || ""),
        },
    );
    imageNode.title = "图片生成";
    const connection = { id: input.connectionId || nanoid(), fromNodeId: sourceNode.id, toNodeId: imageNode.id };
    const nextNodes = input.nodes.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, richText: undefined, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(imageNode);
    return { ok: true, imageNode, connection, nextNodes, nextConnections: [...input.connections, connection] };
}

export function createImageLayerSplit(source: CanvasNodeData, config: AiConfig, nodes: CanvasNodeData[], isReady: (model: string) => boolean) {
    const available = selectableModelsByCapability(config, "image").filter((model) =>
        seedreamSupportsLayerSplit(seedreamFamily(model)) && isReady(model));
    const preferred = [source.metadata?.model, config.imageModel]
        .map((model) => normalizeModelOptionValue(model, config.channels));
    const model = preferred.find((key) => available.includes(key))
        || available.find((key) => seedreamFamily(key) === "5.5")
        || available[0];
    if (!model) return null;

    const prompt = "图层拆分：保留原图构图，将主体和其他独立元素拆为透明图层，补齐被遮挡的背景。";
    const node = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, {
        model, prompt, composerContent: prompt, size: "auto", count: 1,
        seedreamMode: "layers", seedreamOutputFormat: "png", transparentBackground: "false",
        generationResultPlacement: "replace-node",
    });
    node.title = "图层拆分";
    node.width = source.width;
    node.height = source.height;
    node.position = findAvailableGenerationGroupPosition(nodes, {
        x: source.position.x + source.width + 96,
        y: source.position.y,
    }, node);
    return { node, model, prompt, connection: { id: nanoid(), fromNodeId: source.id, toNodeId: node.id } };
}

export function createInsertingHistoryGate() {
    let busy = false;
    return {
        tryEnter() {
            if (busy) return false;
            busy = true;
            return true;
        },
        exit() {
            busy = false;
        },
    };
}

export function rebaseInsertedCanvasNode(live: CanvasNodeData[], inserted: CanvasNodeData) {
    const index = live.findIndex((node) => node.id === inserted.id);
    if (index < 0) return [...live, inserted];
    const next = live.slice();
    next[index] = inserted;
    return next;
}

export async function insertCanvasGenerationHistoryTask(input: {
    task: GenerationTask;
    projectId: string;
    domainProjectId?: string;
    center: Position;
    nodes: CanvasNodeData[];
    assets: Asset[];
    persist: (nodes: CanvasNodeData[]) => Promise<void>;
    ensureAsset: (node: CanvasNodeData) => Promise<{ assetId: string }>;
    applyResult?: typeof applyGenerationTaskResultToNodes;
    readLiveNodes: () => CanvasNodeData[];
    canContinueWrite?: () => boolean;
}): Promise<{ node: CanvasNodeData; nextNodes: CanvasNodeData[]; insertedNodes?: CanvasNodeData[]; abandoned?: boolean }> {
    const mode = generationTaskMode(input.task);
    const nodeType = mode === "video" ? CanvasNodeType.Video : mode === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Image;
    const declaredOutputs = input.task.outputs?.length ? Math.max(...input.task.outputs.map((item) => (item.outputIndex ?? 0) + 1), input.task.outputs.length) : 0;
    const count = mode === "image" ? (beefTVImageContract(input.task.model || "")?.fixedOutputs || declaredOutputs || 1) : 1;
    const surviving = mode === "image" ? survivingGenerationHistoryImageOutputs(input.task) : undefined;
    const outputIndexes = surviving?.map((output) => output.outputIndex) ?? Array.from({ length: count }, (_, index) => index);
    if (!outputIndexes.length) throw new Error("该任务没有可插入的生成结果");
    const insertedNodes: CanvasNodeData[] = [];
    for (const [position, index] of outputIndexes.entries()) {
        const node = createCanvasNode(nodeType, { x: input.center.x + (position % 2) * 400, y: input.center.y + Math.floor(position / 2) * 400 }, {
            prompt: input.task.prompt,
            composerContent: input.task.prompt,
            status: "loading",
            taskId: input.task.id,
            taskStatus: input.task.status,
            taskStage: input.task.stage,
            taskProvider: input.task.provider,
            taskCreatedAt: input.task.createdAt,
            taskCompletedAt: input.task.completedAt,
            model: input.task.model,
            ...(outputIndexes.length > 1 || index !== 0 ? { taskOutputIndex: index } : {}),
        });
        node.title = mode === "video" ? "历史视频" : mode === "audio" ? "历史音频" : "历史图片";
        const output = input.task.outputs?.find((output) => output.outputIndex === index && output.materializedAssetId);
        const applied = output && !input.applyResult
            ? await applyMaterializedGenerationTaskResultToNodes([node], input.task, output, `history:${input.task.id}:${node.id}:${index}`, node.id)
            : await (input.applyResult || applyGenerationTaskResultToNodes)([node], input.task, node.id);
        if (!applied.node) throw new Error("生成结果无法定位到画布节点");
        if (input.canContinueWrite && !input.canContinueWrite()) return { node: applied.node, nextNodes: [], abandoned: true };
        const bound = await bindMissingCanvasResourceAssets([applied.node], input.assets, async (item) => {
            if (input.canContinueWrite && !input.canContinueWrite()) throw new CanvasOwnerAbandonedError();
            return input.ensureAsset(item);
        });
        const inserted = bound[0];
        if (!inserted || canvasNodesMissingResourceAssetBinding(bound).length) {
            throw new Error("生成结果尚未进入素材库，无法插入画布");
        }
        if (input.canContinueWrite && !input.canContinueWrite()) return { node: inserted, nextNodes: [], abandoned: true };
        insertedNodes.push(inserted);
    }
    const nextNodes = insertedNodes.reduce((nodes, inserted) => rebaseInsertedCanvasNode(nodes, inserted), input.readLiveNodes());
    await input.persist(nextNodes);
    return { node: insertedNodes[0], nextNodes, insertedNodes };
}

export async function runOwnedCanvasHistoryInsert(input: {
    owner: CanvasOwnerEpoch;
    getLiveCanvasId: () => string;
    getLiveUserScope?: () => string;
    getLiveLifetime?: () => number;
    task: GenerationTask;
    projectId: string;
    domainProjectId?: string;
    center: Position;
    nodes: CanvasNodeData[];
    assets: Asset[];
    persist: (nodes: CanvasNodeData[]) => Promise<void>;
    ensureAsset: (node: CanvasNodeData) => Promise<{ assetId: string }>;
    applyResult?: typeof applyGenerationTaskResultToNodes;
    readLiveNodes: () => CanvasNodeData[];
    onCommit: (node: CanvasNodeData, insertedNodes: CanvasNodeData[]) => void;
}): Promise<"committed" | "abandoned"> {
    const liveUser = () => input.getLiveUserScope?.();
    const liveLifetime = () => input.getLiveLifetime?.();
    const canContinueWrite = () => canvasOwnerCanPersist(input.owner, input.getLiveCanvasId(), liveUser(), liveLifetime());
    try {
        const result = await insertCanvasGenerationHistoryTask({
            ...input,
            canContinueWrite,
            ensureAsset: async (node) => {
                if (!canvasOwnerUserMatches(input.owner, liveUser())) throw new CanvasOwnerAbandonedError();
                return input.ensureAsset(node);
            },
        });
        if (result.abandoned) return "abandoned";
        if (!canvasOwnerEpochMatches(input.owner, input.getLiveCanvasId(), liveUser(), liveLifetime())) return "abandoned";
        input.onCommit(result.node, result.insertedNodes || [result.node]);
        return "committed";
    } catch (error) {
        if (error instanceof CanvasOwnerAbandonedError) return "abandoned";
        throw error;
    }
}

export function resolveVideoEditNodeDraft(effectiveConfig: AiConfig, node: CanvasNodeData, operation: "extend" | "inpaint") {
    const editQuality = node.metadata?.vquality || "720p";
    const candidateModels = [node.metadata?.model, effectiveConfig.videoModel, ...selectableModelsByCapability(effectiveConfig, "video")].filter((item): item is string => Boolean(item));
    const editRequirementsFor = (modelKey: string) => {
        const constraints = seedanceSettingsConstraints(modelCapabilityConfigFor(effectiveConfig, modelKey), 0, 1, 0, operation);
        return {
            capability: "video" as const,
            videoOperation: operation,
            videoSeconds: constraints.durationLocked ? "-1" : node.metadata?.seconds || effectiveConfig.videoSeconds,
            options: { vquality: editQuality },
            input: { textCount: 1, imageCount: 0, videoCount: 1, audioCount: 0, characterCount: 0 },
        };
    };
    const targetModel =
        candidateModels.find((item) => modelCapabilityConfigFor(effectiveConfig, item).video?.operations?.includes(operation) && !modelCompatibilityError(effectiveConfig, item, editRequirementsFor(item))) ||
        candidateModels.find((item) => !modelCompatibilityError(effectiveConfig, item, editRequirementsFor(item))) ||
        node.metadata?.model;
    const constraints = targetModel ? seedanceSettingsConstraints(modelCapabilityConfigFor(effectiveConfig, targetModel), 0, 1, 0, operation) : {};
    return {
        model: targetModel,
        size: "adaptive",
        seconds: constraints.durationLocked ? "-1" : node.metadata?.seconds,
        vquality: editQuality,
    };
}
