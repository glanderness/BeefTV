import { hasStaleSettledFileUploadFlag } from "@/lib/canvas/canvas-file-upload";
import { stripScriptDocumentExtension } from "@/lib/canvas/script-document-import";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasDocumentRebaseResult = {
    project: CanvasProject;
    conflict: boolean;
};

const VIEW_PREFERENCE_KEYS = new Set(["viewport", "appearance", "backgroundMode", "showImageInfo"]);
const SERVER_OWNED_KEYS = new Set(["revision", "updatedAt", "remoteContentHash", "createdAt"]);
const ENTITY_LIST_KEYS = new Set(["nodes", "connections", "chatSessions"]);
const SKIP_GENERIC_KEYS = new Set(["id", ...VIEW_PREFERENCE_KEYS, ...SERVER_OWNED_KEYS, ...ENTITY_LIST_KEYS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function equal(left: unknown, right: unknown) {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function mergeField(base: unknown, local: unknown, remote: unknown, conflict: { value: boolean }): unknown {
    if (equal(local, base)) return remote;
    if (equal(remote, base) || equal(local, remote)) return local;
    if (isPlainObject(local) && isPlainObject(remote)) {
        return mergeObject(isPlainObject(base) ? base : {}, local, remote, conflict);
    }
    conflict.value = true;
    return local;
}

function hasDefinedProperty(object: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
}

function isClearedProperty(object: Record<string, unknown>, key: string): boolean {
    return !hasDefinedProperty(object, key) || object[key] === null;
}

function mergeObject(
    base: Record<string, unknown>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    conflict: { value: boolean },
): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        const baseHas = hasDefinedProperty(base, key);
        const localHas = hasDefinedProperty(local, key);
        const remoteHas = hasDefinedProperty(remote, key);
        if (!localHas && baseHas) {
            if (remoteHas && !isClearedProperty(remote, key) && !equal(remote[key], base[key])) conflict.value = true;
            continue;
        }
        if (!localHas) {
            if (remoteHas && !isClearedProperty(remote, key)) merged[key] = remote[key];
            continue;
        }
        if (!remoteHas) {
            if (isClearedProperty(local, key)) continue;
            if (baseHas && !equal(local[key], base[key])) {
                conflict.value = true;
                merged[key] = local[key];
            } else if (!baseHas) {
                merged[key] = local[key];
            }
            continue;
        }
        if (!baseHas) {
            merged[key] = mergeField(undefined, local[key], remote[key], conflict);
            continue;
        }
        merged[key] = mergeField(base[key], local[key], remote[key], conflict);
    }
    return merged;
}

const GENERATION_MEDIA_RESULT_KEYS = ["content", "storageKey", "assetId"] as const;
const GENERATION_MEDIA_RESULT_KEY_SET = new Set<string>(GENERATION_MEDIA_RESULT_KEYS);

const GENERATION_BIND_METADATA_KEYS = [
    ...GENERATION_MEDIA_RESULT_KEYS,
    "mimeType",
    "bytes",
    "naturalWidth",
    "naturalHeight",
    "durationMs",
    "nodeRole",
    "resultOrigin",
    "generationEffectKeys",
    "status",
    "taskType",
    "taskClientOperationId",
    "generationSubmissionState",
    "retryOf",
    "attemptGroupId",
    "taskProvider",
    "taskOutcome",
    "taskStatus",
    "taskProgress",
    "taskStage",
    "taskCreatedAt",
    "taskStartedAt",
    "taskCompletedAt",
    "taskDurationMs",
    "taskErrorCode",
    "taskProviderRequestId",
    "taskOfficialStatus",
    "taskReceiptRecorded",
    "taskUpdatedAt",
] as const;

const GENERATION_ERROR_METADATA_KEYS = [
    "errorDetails",
    "generationErrorCode",
    "generationErrorSummary",
    "generationProviderCode",
    "taskFailureDiagnostics",
    "generationFailure",
    "generationPreflightError",
    "taskOutcomeSource",
    "resourceReloadAvailable",
    "failedPromptFingerprint",
    "failedInputFingerprint",
    "processingLabel",
] as const;

function nodeTaskId(node: CanvasNodeData | undefined) {
    const taskId = node?.metadata?.taskId;
    return typeof taskId === "string" ? taskId.trim() : "";
}

function ownMetadataString(metadata: CanvasNodeData["metadata"] | undefined, key: string): string | undefined {
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, key)) return undefined;
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

function nonemptyMediaRef(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function hasInFlightTaskOutcome(value: unknown) {
    if (!isPlainObject(value)) return false;
    return value.phase === "running" || value.phase === "fetching";
}

function isInFlightGenerationOverlay(node: CanvasNodeData) {
    const status = node.metadata?.status;
    if (status === "loading" || status === "error") return true;
    return (
        status === "success"
        && (!node.metadata?.taskStatus || node.metadata.taskStatus === "succeeded")
        && hasInFlightTaskOutcome(node.metadata?.taskOutcome)
    );
}

function remoteHasBoundGenerationResult(node: CanvasNodeData | undefined) {
    const meta = node?.metadata;
    if (!meta || meta.status !== "success") return false;
    return nonemptyMediaRef(meta.content) || nonemptyMediaRef(meta.storageKey) || nonemptyMediaRef(meta.assetId);
}

function hasTrueGenerationContentConflict(base: CanvasNodeData | undefined, local: CanvasNodeData, remote: CanvasNodeData) {
    const localContent = ownMetadataString(local.metadata, "content");
    if (localContent === undefined) return false;
    // loading/error + 空串是恢复 overlay，不是人把已绑定 success 清掉。
    if (!nonemptyMediaRef(localContent) && isInFlightGenerationOverlay(local)) return false;
    const remoteContent = ownMetadataString(remote.metadata, "content") ?? "";
    const baseContent = ownMetadataString(base?.metadata, "content") ?? "";
    return localContent !== remoteContent && localContent !== baseContent;
}

/**
 * 只结算同一任务仍在 loading/error 展示层上的生成字段。
 * 远端必须 status=success 且带有效 media；taskStatus=succeeded 或空 content 不能当已绑定完成。
 * loading/error 上的空 content 是 overlay，不是人类清空，可被远端已绑定 success 结算。
 * 人类写过的非空 content 保留；非 overlay 上的空串按真实编辑保留。
 * 新任务删除 content 键视为正常清旧结果，不同 taskId 不会写回旧 storageKey。
 */
export function settleInFlightGenerationOverlay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasProject {
    const baseById = new Map((input.base.nodes || []).map((node) => [node.id, node]));
    const remoteById = new Map((input.remote.nodes || []).map((node) => [node.id, node]));
    let changed = false;
    const nodes = (input.local.nodes || []).map((localNode) => {
        const remoteNode = remoteById.get(localNode.id);
        const taskId = nodeTaskId(localNode);
        if (!remoteNode || !taskId || nodeTaskId(remoteNode) !== taskId) return localNode;
        if (!isInFlightGenerationOverlay(localNode) || !remoteHasBoundGenerationResult(remoteNode)) return localNode;
        if (hasTrueGenerationContentConflict(baseById.get(localNode.id), localNode, remoteNode)) return localNode;
        const metadata: CanvasNodeData["metadata"] = { ...(localNode.metadata || {}) };
        const remoteMeta = remoteNode.metadata || {};
        for (const key of GENERATION_BIND_METADATA_KEYS) {
            if (GENERATION_MEDIA_RESULT_KEY_SET.has(key)) {
                const value = remoteMeta[key];
                if (nonemptyMediaRef(value)) {
                    (metadata as Record<string, unknown>)[key] = value;
                }
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(remoteMeta, key) && remoteMeta[key] !== undefined && remoteMeta[key] !== null) {
                (metadata as Record<string, unknown>)[key] = remoteMeta[key];
            } else {
                delete (metadata as Record<string, unknown>)[key];
            }
        }
        for (const key of GENERATION_ERROR_METADATA_KEYS) {
            delete (metadata as Record<string, unknown>)[key];
        }
        if (!isPlainObject(metadata.taskOutcome) || hasInFlightTaskOutcome(metadata.taskOutcome)) {
            metadata.taskOutcome = { phase: "ready", regenerate: "allowed", reason: "result_ready" };
        }
        changed = true;
        return { ...localNode, metadata };
    });
    return changed ? { ...input.local, nodes } : input.local;
}

// 节点级 createdAt/updatedAt 由编辑器在打开和编辑时补写，服务端写入的节点常常没有；
// 它们不是用户编辑，远端删掉的节点不能只因为这两个字段不同就被留下。
function stripNodeTimestamps(node: CanvasNodeData | undefined): Record<string, unknown> {
    if (!node) return {};
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = node;
    return rest as unknown as Record<string, unknown>;
}

function sameNodeIgnoringTimestamps(left: CanvasNodeData, right: CanvasNodeData) {
    return equal(stripNodeTimestamps(left), stripNodeTimestamps(right));
}

const IN_FLIGHT_POLL_TELEMETRY_KEYS = [
    "taskProgress",
    "taskStage",
    "taskUpdatedAt",
    "taskDurationMs",
    "taskStartedAt",
    "taskProviderRequestId",
    "taskOfficialStatus",
    "taskReceiptRecorded",
] as const;

const TASK_LIFECYCLE_NON_MEDIA_KEYS = [
    "taskId",
    ...GENERATION_BIND_METADATA_KEYS.filter((key) => !GENERATION_MEDIA_RESULT_KEY_SET.has(key)),
    ...GENERATION_ERROR_METADATA_KEYS,
] as const;

const UPLOAD_SETTLEMENT_METADATA_KEYS = [
    "fileUpload",
    "fileUploadProgress",
    "errorDetails",
    "content",
    "storageKey",
    "assetId",
    "status",
    "bytes",
    "mimeType",
    "naturalWidth",
    "naturalHeight",
    "durationMs",
    "hasAudio",
    "videoPreview",
    "outputParameterWarning",
    "nodeRole",
    "resultOrigin",
] as const;

const UPLOAD_REPLACEMENT_RESET_KEYS = [
    "taskId",
    "freeResize",
    "isBatchRoot",
    "batchRootId",
    "batchChildIds",
    "batchFailedCount",
    "batchUsesReferenceImages",
    "generationType",
    "generationResultPlacement",
    "copiedFromNodeId",
    "versionOfNodeId",
    "model",
    "size",
    "quality",
    "transparentBackground",
    "count",
    "references",
    "primaryImageId",
    "imageBatchExpanded",
    "richText",
    "composerContent",
    "generationErrorCode",
    "generationErrorSummary",
    "generationProviderCode",
    "generationPreflightError",
    "failedPromptFingerprint",
] as const;

const UPLOAD_OWNED_METADATA_KEY_SET = new Set<string>([
    ...UPLOAD_SETTLEMENT_METADATA_KEYS,
    ...UPLOAD_REPLACEMENT_RESET_KEYS,
]);

function stripStaleFileUploadMetadata(node: CanvasNodeData | undefined): CanvasNodeData | undefined {
    if (!node?.metadata || !hasStaleSettledFileUploadFlag(node.metadata)) return node;
    const nextMeta: Record<string, unknown> = { ...(node.metadata as Record<string, unknown>) };
    delete nextMeta.fileUpload;
    delete nextMeta.fileUploadProgress;
    delete nextMeta.errorDetails;
    return { ...node, metadata: nextMeta as CanvasNodeData["metadata"] };
}

function hasSettledUploadMedia(node: CanvasNodeData | undefined): boolean {
    const meta = node?.metadata;
    if (!meta || meta.fileUpload || meta.status === "loading" || meta.status === "error") return false;
    return nonemptyMediaRef(meta.content) || nonemptyMediaRef(meta.storageKey);
}

function sameUploadMediaPayload(left: CanvasNodeData | undefined, right: CanvasNodeData | undefined): boolean {
    return equal(left?.metadata?.content, right?.metadata?.content)
        && equal(left?.metadata?.storageKey, right?.metadata?.storageKey);
}

function hasUploadMediaPayload(node: CanvasNodeData | undefined): boolean {
    const meta = node?.metadata;
    return Boolean(meta && (nonemptyMediaRef(meta.content) || nonemptyMediaRef(meta.storageKey)));
}

function shouldSettleUploadingAgainstSettled(
    baseItem: CanvasNodeData | undefined,
    settledItem: CanvasNodeData,
    uploadingItem: CanvasNodeData,
): boolean {
    if (uploadingItem.metadata?.fileUpload !== "uploading" || !hasSettledUploadMedia(settledItem)) {
        return false;
    }
    if (!hasUploadMediaPayload(uploadingItem)) {
        return true;
    }
    return (
        hasSettledUploadMedia(baseItem)
        && sameUploadMediaPayload(baseItem, uploadingItem)
        && !sameUploadMediaPayload(baseItem, settledItem)
    );
}

function sameNodeCenter(
    left: Pick<CanvasNodeData, "position" | "width" | "height"> | undefined,
    right: Pick<CanvasNodeData, "position" | "width" | "height"> | undefined,
): boolean {
    if (!left || !right) return false;
    const lx = left.position.x + left.width / 2;
    const ly = left.position.y + left.height / 2;
    const rx = right.position.x + right.width / 2;
    const ry = right.position.y + right.height / 2;
    return Math.abs(lx - rx) <= 1e-6 && Math.abs(ly - ry) <= 1e-6;
}

function alignUploadSettlementPair(
    baseItem: CanvasNodeData | undefined,
    uploadingItem: CanvasNodeData,
    settledItem: CanvasNodeData,
): { uploading: CanvasNodeData; settled: CanvasNodeData } {
    // base 已是完成媒体，而对侧仍是缺少媒体的初始上传占位：对侧整体早于当前状态，不能清空字段或回退几何。
    if (baseItem && hasSettledUploadMedia(baseItem) && !hasUploadMediaPayload(uploadingItem)) {
        return {
            uploading: {
                ...baseItem,
                ...(uploadingItem.createdAt ? { createdAt: uploadingItem.createdAt } : {}),
                ...(uploadingItem.updatedAt ? { updatedAt: uploadingItem.updatedAt } : {}),
            },
            settled: settledItem,
        };
    }

    const baseMeta = (baseItem?.metadata || {}) as Record<string, unknown>;
    const settledMeta = (settledItem.metadata || {}) as Record<string, unknown>;
    const uploadingMeta: Record<string, unknown> = { ...((uploadingItem.metadata || {}) as Record<string, unknown>) };
    const keysToCopy: readonly string[] = hasSettledUploadMedia(baseItem)
        ? [...UPLOAD_SETTLEMENT_METADATA_KEYS, ...UPLOAD_REPLACEMENT_RESET_KEYS]
        : UPLOAD_SETTLEMENT_METADATA_KEYS;
    for (const key of keysToCopy) {
        if (hasDefinedProperty(settledMeta, key) && !isClearedProperty(settledMeta, key)) {
            uploadingMeta[key] = settledMeta[key];
        } else {
            delete uploadingMeta[key];
        }
    }
    if (baseItem) {
        for (const key of Object.keys(baseMeta)) {
            if (!UPLOAD_OWNED_METADATA_KEY_SET.has(key) && !hasDefinedProperty(uploadingMeta, key) && hasDefinedProperty(settledMeta, key)) {
                uploadingMeta[key] = baseMeta[key];
            }
        }
    }
    if (
        settledItem.type === "text"
        && !hasDefinedProperty(uploadingMeta, "prompt")
        && hasDefinedProperty(settledMeta, "prompt")
        && settledMeta.prompt === settledMeta.content
    ) {
        uploadingMeta.prompt = settledMeta.prompt;
    }

    let settledNext = settledItem;
    let resolvedUploadingTitle = uploadingItem.title;
    if (!baseItem && settledItem.type === "text" && stripScriptDocumentExtension(uploadingItem.title) === settledItem.title) {
        resolvedUploadingTitle = settledItem.title;
    }

    const keepUploadingManualResize = !hasSettledUploadMedia(baseItem) && Boolean(
        uploadingItem.metadata?.manualSize
        || uploadingItem.metadata?.freeResize
        || (
            baseItem?.metadata?.fileUpload === "uploading"
            && (uploadingItem.width !== baseItem.width || uploadingItem.height !== baseItem.height)
        ),
    );
    const resolvedUploadingSize = keepUploadingManualResize
        ? { width: uploadingItem.width, height: uploadingItem.height }
        : { width: settledItem.width, height: settledItem.height };
    const uploadingCenteredPos = {
        x: uploadingItem.position.x + (uploadingItem.width - resolvedUploadingSize.width) / 2,
        y: uploadingItem.position.y + (uploadingItem.height - resolvedUploadingSize.height) / 2,
    };

    let resolvedUploadingPos = uploadingItem.position;
    if (keepUploadingManualResize) {
        const settledLacksManualSize = (Boolean(uploadingMeta.manualSize) && !settledItem.metadata?.manualSize)
            || (!settledItem.metadata?.manualSize && !settledItem.metadata?.freeResize);
        const settledVideoAutoFitOverManual = settledItem.type === "video"
            && (sameNodeCenter(settledItem, baseItem) || sameNodeCenter(settledItem, uploadingItem));
        if (settledLacksManualSize || settledVideoAutoFitOverManual) {
            const nextSettledMeta: Record<string, unknown> = { ...(settledNext.metadata as Record<string, unknown>) };
            if (uploadingMeta.manualSize !== undefined) nextSettledMeta.manualSize = uploadingMeta.manualSize;
            if (uploadingMeta.freeResize !== undefined) nextSettledMeta.freeResize = uploadingMeta.freeResize;
            settledNext = {
                ...settledNext,
                ...resolvedUploadingSize,
                position: uploadingItem.position,
                metadata: nextSettledMeta as CanvasNodeData["metadata"],
            };
        }
    } else if (!baseItem) {
        resolvedUploadingPos = sameNodeCenter(uploadingItem, settledItem)
            ? settledItem.position
            : uploadingCenteredPos;
    } else {
        const uploadingDragged = !equal(uploadingItem.position, baseItem.position) && !sameNodeCenter(uploadingItem, baseItem);
        const settledAutoCenteredFromBase = equal(settledItem.position, baseItem.position)
            || sameNodeCenter(settledItem, baseItem)
            || sameNodeCenter(settledItem, { position: baseItem.position, width: uploadingItem.width, height: uploadingItem.height });
        if (!uploadingDragged || sameNodeCenter(uploadingItem, settledItem)) {
            resolvedUploadingPos = settledItem.position;
        } else if (settledAutoCenteredFromBase) {
            resolvedUploadingPos = uploadingCenteredPos;
            settledNext = { ...settledNext, position: uploadingCenteredPos };
        } else {
            resolvedUploadingPos = uploadingCenteredPos;
        }
    }

    const uploadingNext: CanvasNodeData = {
        ...uploadingItem,
        type: settledItem.type,
        title: resolvedUploadingTitle,
        ...resolvedUploadingSize,
        position: resolvedUploadingPos,
        metadata: uploadingMeta as CanvasNodeData["metadata"],
    };
    return { uploading: uploadingNext, settled: settledNext };
}

function copyUploadBundleMetadata(source: CanvasNodeData, target: CanvasNodeData, keys: readonly string[]): CanvasNodeData {
    const srcMeta = (source.metadata || {}) as Record<string, unknown>;
    const nextMeta: Record<string, unknown> = { ...((target.metadata || {}) as Record<string, unknown>) };
    for (const key of keys) {
        if (hasDefinedProperty(srcMeta, key) && !isClearedProperty(srcMeta, key)) {
            nextMeta[key] = srcMeta[key];
        } else {
            delete nextMeta[key];
        }
    }
    return { ...target, metadata: nextMeta as CanvasNodeData["metadata"] };
}

function restorePersistedUploadingManualGeometry(
    baseItem: CanvasNodeData | undefined,
    node: CanvasNodeData,
): CanvasNodeData {
    if (!baseItem || hasSettledUploadMedia(baseItem) || node.metadata?.fileUpload !== "uploading") {
        return node;
    }
    const missingManualSize = Boolean(baseItem.metadata?.manualSize)
        && !node.metadata?.manualSize
        && node.metadata?.manualSize !== false;
    const missingFreeResize = Boolean(baseItem.metadata?.freeResize)
        && !node.metadata?.freeResize
        && node.metadata?.freeResize !== false;
    if (!missingManualSize && !missingFreeResize) {
        return node;
    }
    const nextMeta: Record<string, unknown> = { ...((node.metadata || {}) as Record<string, unknown>) };
    if (missingManualSize) nextMeta.manualSize = baseItem.metadata?.manualSize;
    if (missingFreeResize) nextMeta.freeResize = baseItem.metadata?.freeResize;
    const restoreBox = missingManualSize || !node.metadata?.manualSize;
    return {
        ...node,
        ...(restoreBox ? {
            width: baseItem.width,
            height: baseItem.height,
            position: baseItem.position,
        } : {}),
        metadata: nextMeta as CanvasNodeData["metadata"],
    };
}

function mergeCanvasNodeItem(
    baseItem: CanvasNodeData | undefined,
    localItem: CanvasNodeData,
    remoteItem: CanvasNodeData,
    conflict: { value: boolean },
): CanvasNodeData {
    const baseClean = stripStaleFileUploadMetadata(baseItem);
    let localNormalized = restorePersistedUploadingManualGeometry(baseClean, stripStaleFileUploadMetadata(localItem)!);
    let remoteNormalized = restorePersistedUploadingManualGeometry(baseClean, stripStaleFileUploadMetadata(remoteItem)!);
    if (shouldSettleUploadingAgainstSettled(baseClean, localNormalized, remoteNormalized)) {
        const aligned = alignUploadSettlementPair(baseClean, remoteNormalized, localNormalized);
        remoteNormalized = aligned.uploading;
        localNormalized = aligned.settled;
    } else if (shouldSettleUploadingAgainstSettled(baseClean, remoteNormalized, localNormalized)) {
        const aligned = alignUploadSettlementPair(baseClean, localNormalized, remoteNormalized);
        localNormalized = aligned.uploading;
        remoteNormalized = aligned.settled;
    } else if (
        (hasSettledUploadMedia(localNormalized) && remoteNormalized.metadata?.fileUpload === "uploading")
        || (hasSettledUploadMedia(remoteNormalized) && localNormalized.metadata?.fileUpload === "uploading")
    ) {
        const localIsSettled = hasSettledUploadMedia(localNormalized);
        const settledSide = localIsSettled ? localNormalized : remoteNormalized;
        const uploadingSide = localIsSettled ? remoteNormalized : localNormalized;
        if (sameUploadMediaPayload(settledSide, uploadingSide)) {
            const alignedSettled = copyUploadBundleMetadata(uploadingSide, settledSide, ["fileUpload", "fileUploadProgress", "status", "errorDetails"]);
            if (localIsSettled) {
                localNormalized = alignedSettled;
            } else {
                remoteNormalized = alignedSettled;
            }
        } else if (!hasSettledUploadMedia(baseClean) || !sameUploadMediaPayload(baseClean, settledSide)) {
            conflict.value = true;
            remoteNormalized = localNormalized;
        }
    } else if (
        localNormalized.metadata?.fileUpload === "uploading"
        && remoteNormalized.metadata?.fileUpload === "uploading"
        && sameUploadMediaPayload(localNormalized, remoteNormalized)
    ) {
        const baseProgress = baseClean?.metadata?.fileUploadProgress;
        const localProgress = localNormalized.metadata?.fileUploadProgress;
        const remoteProgress = remoteNormalized.metadata?.fileUploadProgress;
        if (!equal(localProgress, remoteProgress) && !equal(localProgress, baseProgress) && !equal(remoteProgress, baseProgress)) {
            const alignedMeta: Record<string, unknown> = { ...(remoteNormalized.metadata as Record<string, unknown>) };
            if (localProgress !== undefined) {
                alignedMeta.fileUploadProgress = localProgress;
            } else {
                delete alignedMeta.fileUploadProgress;
            }
            remoteNormalized = { ...remoteNormalized, metadata: alignedMeta as CanvasNodeData["metadata"] };
        }
    }
    const taskId = nodeTaskId(localNormalized);
    const baseMeta = (baseClean?.metadata || {}) as Record<string, unknown>;
    const localMeta = (localNormalized.metadata || {}) as Record<string, unknown>;
    if (
        TASK_LIFECYCLE_NON_MEDIA_KEYS.some(key => !equal(baseMeta[key], localMeta[key])) &&
        !remoteHasBoundGenerationResult(remoteNormalized) &&
        !hasTrueGenerationContentConflict(baseClean, localNormalized, remoteNormalized) &&
        (localNormalized.metadata?.status === "loading" || localNormalized.metadata?.status === "error") &&
        (remoteNormalized.metadata?.status === "loading" || remoteNormalized.metadata?.status === "error")
    ) {
        const alignedMeta: Record<string, unknown> = { ...(remoteNormalized.metadata || {}) };
        const keysToAlign =
            taskId &&
            nodeTaskId(remoteNormalized) === taskId &&
            localNormalized.metadata?.status === "loading" &&
            remoteNormalized.metadata?.status === "loading" &&
            localNormalized.metadata?.taskStatus === remoteNormalized.metadata?.taskStatus
                ? IN_FLIGHT_POLL_TELEMETRY_KEYS
                : TASK_LIFECYCLE_NON_MEDIA_KEYS;
        for (const key of keysToAlign) {
            if (hasDefinedProperty(localMeta, key)) {
                alignedMeta[key] = localMeta[key];
            } else {
                delete alignedMeta[key];
            }
        }
        remoteNormalized = { ...remoteNormalized, metadata: alignedMeta as CanvasNodeData["metadata"] };
    }
    const merged = mergeObject(
        stripNodeTimestamps(baseClean),
        stripNodeTimestamps(localNormalized),
        stripNodeTimestamps(remoteNormalized),
        conflict,
    ) as unknown as CanvasNodeData;
    const createdAt = localItem.createdAt || remoteItem.createdAt || baseItem?.createdAt;
    const updatedAt = localItem.updatedAt || remoteItem.updatedAt || baseItem?.updatedAt;
    return {
        ...merged,
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
    };
}

function mergeEntityList<T extends { id: string }>(
    base: T[] | undefined,
    local: T[] | undefined,
    remote: T[] | undefined,
    conflict: { value: boolean },
    sameAsBase: (local: T, base: T) => boolean = equal,
    mergeItem?: (baseItem: T | undefined, localItem: T, remoteItem: T, conflict: { value: boolean }) => T,
): T[] {
    const baseItems = Array.isArray(base) ? base : [];
    const localItems = Array.isArray(local) ? local : [];
    const remoteItems = Array.isArray(remote) ? remote : [];
    const baseById = new Map(baseItems.map((item) => [item.id, item]));
    const localById = new Map(localItems.map((item) => [item.id, item]));
    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    const result: T[] = [];
    const seen = new Set<string>();

    const consider = (id: string) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const baseItem = baseById.get(id);
        const localItem = localById.get(id);
        const remoteItem = remoteById.get(id);
        if (baseItem && !localItem) {
            if (remoteItem && !sameAsBase(remoteItem, baseItem)) conflict.value = true;
            return;
        }
        if (baseItem && !remoteItem) {
            if (localItem && !sameAsBase(localItem, baseItem)) {
                conflict.value = true;
                result.push(localItem);
            }
            return;
        }
        if (localItem && remoteItem) {
            result.push(
                mergeItem
                    ? mergeItem(baseItem, localItem, remoteItem, conflict)
                    : (mergeObject(
                          (baseItem || {}) as unknown as Record<string, unknown>,
                          localItem as unknown as Record<string, unknown>,
                          remoteItem as unknown as Record<string, unknown>,
                          conflict,
                      ) as unknown as T),
            );
            return;
        }
        if (localItem) {
            result.push(localItem);
            return;
        }
        if (remoteItem) result.push(remoteItem);
    };

    for (const item of localItems) consider(item.id);
    for (const item of remoteItems) consider(item.id);
    return result;
}

/**
 * 以已确认快照为基线的字段级三路合并。
 *
 * 本地相对基线的删除与未冲突编辑保留；服务端相对基线、本地未改的字段（含生成媒体）采纳。
 * 同一字段双方都改过时保留本地可见值并标冲突，不猜胜者。
 */
export function rebaseCanvasDocumentThreeWay(input: {
    base: CanvasProject;
    local: CanvasProject;
    remote: CanvasProject;
}): CanvasDocumentRebaseResult {
    const conflict = { value: false };
    const generic = mergeObject(
        Object.fromEntries(Object.entries(input.base).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.local).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        Object.fromEntries(Object.entries(input.remote).filter(([key]) => !SKIP_GENERIC_KEYS.has(key))),
        conflict,
    );
    const project: CanvasProject = {
        ...input.remote,
        ...generic,
        id: input.local.id,
        title: (generic.title as string | undefined) ?? input.local.title,
        nodes: mergeEntityList<CanvasNodeData>(
            input.base.nodes?.map((node) => stripStaleFileUploadMetadata(node)!),
            input.local.nodes?.map((node) => stripStaleFileUploadMetadata(node)!),
            input.remote.nodes?.map((node) => stripStaleFileUploadMetadata(node)!),
            conflict,
            sameNodeIgnoringTimestamps,
            mergeCanvasNodeItem,
        ),
        connections: mergeEntityList<CanvasConnection>(input.base.connections, input.local.connections, input.remote.connections, conflict),
        chatSessions: mergeEntityList(input.base.chatSessions, input.local.chatSessions, input.remote.chatSessions, conflict),
        viewport: input.local.viewport || input.remote.viewport,
        appearance: input.local.appearance || input.remote.appearance,
        backgroundMode: input.local.backgroundMode || input.remote.backgroundMode,
        showImageInfo: input.local.showImageInfo,
        revision: input.remote.revision,
        updatedAt: input.remote.updatedAt,
        remoteContentHash: input.remote.remoteContentHash,
        createdAt: input.remote.createdAt || input.local.createdAt,
    };
    return { project, conflict: conflict.value };
}
