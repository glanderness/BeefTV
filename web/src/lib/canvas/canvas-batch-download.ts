import { useSyncExternalStore } from "react";

import { buildCanvasMediaDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { getResourceBlob, ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import {
    chooseOwnedNativeMediaBatchDirectory,
    isSafeDirectBrowserDownloadUrl,
    isSafeExternalFetchUrl,
    isWailsNativeShell,
    MAX_OWNED_ARTIFACT_BYTES,
    saveOwnedNativeMediaBatch,
    type NativeMediaBatchFailure,
    type NativeMediaBatchSaveOutcome,
} from "@/services/desktop-media-save";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId } from "@/types/canvas";

const ROW_BAND_THRESHOLD_PX = 48;
const DEFAULT_BATCH_DOWNLOAD_STAGGER_MS = 120;
const OBJECT_URL_REVOKE_DELAY_MS = 1_000;
const EXTERNAL_FETCH_TIMEOUT_MS = 10_000;
const EXTERNAL_FETCH_CONCURRENCY = 4;
const BATCH_DOWNLOAD_TOAST_KEY = "canvas-batch-download";

export type BatchDownloadFailure = NativeMediaBatchFailure;

export type BatchDownloadResult = {
    downloaded: number;
    failed: number;
    cancelled?: boolean;
    failures?: BatchDownloadFailure[];
};

export type BatchDownloadOptions = {
    fetchImpl?: typeof fetch;
    triggerDownload?: (href: string, filename: string) => void;
    loadResourceBlob?: (storageKey: string) => Promise<Blob | null>;
    chooseNativeBatchDir?: () => Promise<string | undefined>;
    saveNativeBatch?: (
        items: Array<{ fileName: string; resourceId?: string; blob?: Blob }>,
        dirToken?: string,
    ) => Promise<NativeMediaBatchSaveOutcome | undefined>;
    staggerMs?: number;
};

type ResolvedBatchItem = {
    node: CanvasNodeData;
    content: string;
    resourceId: string;
    fileName: string;
    valid: boolean;
};

type BatchDownloadMessageApi = {
    loading?: (config: { key: string; content: string; duration: number }) => unknown;
    destroy?: (key?: string) => void;
    info?: (content: string) => unknown;
    success: (content: string | { key: string; content: string }) => unknown;
    warning: (content: string | { key: string; content: string }) => unknown;
    error: (content: string | { key: string; content: string }) => unknown;
};

let activeBatchDownloadCount = 0;
const batchPendingListeners = new Set<() => void>();

function notifyBatchPendingListeners() {
    for (const listener of batchPendingListeners) {
        listener();
    }
}

function subscribeBatchPending(listener: () => void) {
    batchPendingListeners.add(listener);
    return () => {
        batchPendingListeners.delete(listener);
    };
}

export function isCanvasBatchDownloadPending(): boolean {
    return activeBatchDownloadCount > 0;
}

export function useCanvasBatchDownloadPending(): boolean {
    return useSyncExternalStore(subscribeBatchPending, isCanvasBatchDownloadPending, () => false);
}

function resolveBatchDownloadItem(node: CanvasNodeData): ResolvedBatchItem {
    const content = node?.metadata?.content?.trim() || "";
    const resourceId = ownedResourceIdFromMediaRef(node?.metadata?.storageKey, content);
    const valid = Boolean((content || resourceId) && isDownloadableMediaNodeType(node.type));
    return {
        node,
        content,
        resourceId,
        fileName: buildBatchDownloadFilename(node),
        valid,
    };
}

export function collectDownloadableMediaNodes(
    nodes: CanvasNodeData[],
    selectedIds: Iterable<string>,
): CanvasNodeData[] {
    const selectedSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
    if (selectedSet.size === 0) return [];
    const selected = nodes
        .filter((node) => selectedSet.has(node.id) && resolveBatchDownloadItem(node).valid)
        .sort((a, b) => a.position.y - b.position.y);

    const rows: CanvasNodeData[][] = [];
    let row: CanvasNodeData[] | undefined;
    for (const node of selected) {
        // Anchor each row to its topmost node so overlapping pairs cannot change the row boundaries.
        if (!row || node.position.y - row[0].position.y > ROW_BAND_THRESHOLD_PX) {
            row = [];
            rows.push(row);
        }
        row.push(node);
    }
    return rows.flatMap((row) => row.sort((a, b) => a.position.x - b.position.x || a.id.localeCompare(b.id)));
}

export function buildBatchDownloadFilename(node: CanvasNodeData): string {
    return buildCanvasMediaDownloadFileName(node, { fallbackName: defaultBatchMediaLabel(node.type) });
}

function deduplicateBatchDownloadFilename(fileName: string, usedLower: Set<string>): string {
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : "";
    for (let suffix = 0; ; suffix += 1) {
        const candidate = suffix === 0 ? fileName : `${stem} (${suffix})${ext}`;
        const lower = candidate.toLowerCase();
        if (!usedLower.has(lower)) {
            usedLower.add(lower);
            return candidate;
        }
    }
}

export async function batchDownloadCanvasMediaNodes(
    nodes: CanvasNodeData[],
    options: BatchDownloadOptions = {},
): Promise<BatchDownloadResult> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const triggerDownload = options.triggerDownload ?? triggerAnchorDownload;
    const staggerMs = options.staggerMs ?? DEFAULT_BATCH_DOWNLOAD_STAGGER_MS;
    const nativeShell = isWailsNativeShell();
    const useDefaultNative = !options.fetchImpl && !options.triggerDownload && nativeShell;
    const nativeSaver = options.saveNativeBatch ?? (useDefaultNative ? saveOwnedNativeMediaBatch : undefined);
    const nativeDirChooser = options.chooseNativeBatchDir ?? (useDefaultNative ? chooseOwnedNativeMediaBatchDirectory : undefined);
    const resolved = nodes.map((node) => resolveBatchDownloadItem(node));

    if (nativeSaver) {
        const nativeResult = await tryDesktopNativeBatchDownload(resolved, fetchImpl, nativeDirChooser, nativeSaver);
        if (nativeResult) {
            return nativeResult;
        }
    }

    let downloaded = 0;
    const failures: BatchDownloadFailure[] = [];
    const usedBrowserNamesLower = new Set<string>();

    for (let index = 0; index < resolved.length; index += 1) {
        const item = resolved[index];
        if (!item.valid) {
            failures.push({ fileName: item.fileName, reason: "缺少可下载的媒体内容" });
            continue;
        }
        const filename = deduplicateBatchDownloadFilename(item.fileName, usedBrowserNamesLower);
        const reason = await downloadSingleNodeMedia({
            content: item.content,
            resourceId: item.resourceId,
            filename,
            fetchImpl,
            hasCustomFetch: Boolean(options.fetchImpl),
            loadResourceBlob: options.loadResourceBlob ?? getResourceBlob,
            triggerDownload,
            nativeShell,
        });
        if (!reason) {
            downloaded += 1;
        } else {
            failures.push({ fileName: filename, reason });
        }
        if (index < resolved.length - 1 && staggerMs > 0) {
            await delay(staggerMs);
        }
    }

    return {
        downloaded,
        failed: failures.length,
        ...(failures.length > 0 ? { failures } : {}),
    };
}

export function formatBatchDownloadFailureSummary(failures?: BatchDownloadFailure[]): string {
    if (!failures || failures.length === 0) return "";
    const preview = failures
        .slice(0, 2)
        .map((item) => `${item.fileName}（${item.reason}）`)
        .join("、");
    return failures.length > 2 ? `${preview} 等 ${failures.length} 项` : preview;
}

export function reportBatchDownloadOutcome(message: BatchDownloadMessageApi, result: BatchDownloadResult): void {
    if (result.cancelled) {
        message.destroy?.(BATCH_DOWNLOAD_TOAST_KEY);
        return;
    }
    const detail = formatBatchDownloadFailureSummary(result.failures);
    if (result.failed === 0) {
        message.success({ key: BATCH_DOWNLOAD_TOAST_KEY, content: `已批量下载 ${result.downloaded} 个素材` });
        return;
    }
    if (result.downloaded > 0) {
        message.warning({
            key: BATCH_DOWNLOAD_TOAST_KEY,
            content: detail
                ? `已下载 ${result.downloaded} 个素材，${result.failed} 个失败：${detail}`
                : `已下载 ${result.downloaded} 个素材，${result.failed} 个下载失败`,
        });
        return;
    }
    message.warning({
        key: BATCH_DOWNLOAD_TOAST_KEY,
        content: detail ? `素材下载失败：${detail}` : "素材下载失败，请稍后重试",
    });
}

export async function runCanvasBatchDownloadWithFeedback(
    nodes: CanvasNodeData[],
    message: BatchDownloadMessageApi,
    options?: BatchDownloadOptions,
): Promise<BatchDownloadResult | null> {
    if (!nodes.length) {
        message.warning("所选节点中没有可下载的媒体素材");
        return null;
    }
    if (activeBatchDownloadCount > 0) {
        message.info?.("正在批量下载中，请稍候完成");
        return null;
    }
    activeBatchDownloadCount += 1;
    notifyBatchPendingListeners();
    try {
        return await executeBatchDownloadWithFeedback(nodes, message, options);
    } finally {
        activeBatchDownloadCount = Math.max(0, activeBatchDownloadCount - 1);
        notifyBatchPendingListeners();
    }
}

export async function downloadCanvasProjectsMediaByIds(
    canvasIds: readonly string[],
    loadProject: (id: string) => Promise<{ nodes?: CanvasNodeData[] } | undefined>,
    message: BatchDownloadMessageApi,
    options?: BatchDownloadOptions & { emptyMessage?: string },
): Promise<BatchDownloadResult | null> {
    const validIds = [...new Set(canvasIds.filter(Boolean))];
    if (!validIds.length) {
        message.info?.(options?.emptyMessage || "当前项目暂无可下载的图片、视频或音频素材");
        return null;
    }
    if (activeBatchDownloadCount > 0) {
        message.info?.("正在批量下载中，请稍候完成");
        return null;
    }
    activeBatchDownloadCount += 1;
    notifyBatchPendingListeners();
    message.loading?.({
        key: BATCH_DOWNLOAD_TOAST_KEY,
        content: "正在读取画布素材...",
        duration: 0,
    });
    try {
        const collected: CanvasNodeData[] = [];
        for (const id of validIds) {
            const project = await loadProject(id);
            const projectNodes = Array.isArray(project?.nodes) ? project.nodes : [];
            if (!projectNodes.length) continue;
            collected.push(
                ...collectDownloadableMediaNodes(
                    projectNodes,
                    projectNodes.map((node) => node.id),
                ),
            );
        }
        if (!collected.length) {
            message.destroy?.(BATCH_DOWNLOAD_TOAST_KEY);
            message.info?.(options?.emptyMessage || "当前项目暂无可下载的图片、视频或音频素材");
            return null;
        }
        return await executeBatchDownloadWithFeedback(collected, message, options);
    } catch (error) {
        message.error({
            key: BATCH_DOWNLOAD_TOAST_KEY,
            content: error instanceof Error && error.message.trim() ? error.message : "读取画布素材失败，请稍后重试",
        });
        return null;
    } finally {
        activeBatchDownloadCount = Math.max(0, activeBatchDownloadCount - 1);
        notifyBatchPendingListeners();
    }
}

async function executeBatchDownloadWithFeedback(
    nodes: CanvasNodeData[],
    message: BatchDownloadMessageApi,
    options?: BatchDownloadOptions,
): Promise<BatchDownloadResult | null> {
    message.loading?.({
        key: BATCH_DOWNLOAD_TOAST_KEY,
        content: `正在批量保存 ${nodes.length} 个素材...`,
        duration: 0,
    });
    try {
        const result = await batchDownloadCanvasMediaNodes(nodes, options);
        reportBatchDownloadOutcome(message, result);
        return result;
    } catch (error) {
        message.error({
            key: BATCH_DOWNLOAD_TOAST_KEY,
            content: error instanceof Error && error.message.trim() ? error.message : "素材下载失败，请稍后重试",
        });
        return null;
    }
}

async function tryDesktopNativeBatchDownload(
    resolved: ResolvedBatchItem[],
    fetchImpl: typeof fetch | undefined,
    chooseNativeBatchDir: (() => Promise<string | undefined>) | undefined,
    saveNativeBatch: (
        items: Array<{ fileName: string; resourceId?: string; blob?: Blob }>,
        dirToken?: string,
    ) => Promise<NativeMediaBatchSaveOutcome | undefined>,
): Promise<BatchDownloadResult | undefined> {
    const validItems = resolved.filter((item) => item.valid);
    const hasExternalItems = validItems.some((item) => !item.resourceId);

    // Prompt for the target directory BEFORE fetching any external URLs so slow
    // or unreachable legacy links never freeze the UI before the folder dialog.
    let dirToken = "";
    if (hasExternalItems && chooseNativeBatchDir) {
        const chosen = await chooseNativeBatchDir();
        if (chosen === "") {
            return { downloaded: 0, failed: 0, cancelled: true };
        }
        if (typeof chosen === "string") {
            dirToken = chosen;
        }
    }

    const externalBlobs = new Map<number, { blob?: Blob; failureReason?: string }>();
    let reservedInlineBytes = 0;
    if (hasExternalItems) {
        const externalTasks = resolved
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.valid && !item.resourceId);
        await mapWithConcurrency(externalTasks, EXTERNAL_FETCH_CONCURRENCY, async ({ item, index }) => {
            if (!isSafeExternalFetchUrl(item.content)) {
                externalBlobs.set(index, { failureReason: "本地临时地址不可直接下载" });
                return;
            }
            const remainingBudget = MAX_OWNED_ARTIFACT_BYTES - reservedInlineBytes;
            if (remainingBudget <= 0) {
                externalBlobs.set(index, { failureReason: "超过 32MB 批量限制，请单独打开保存" });
                return;
            }
            const fetched = await fetchExternalBlobBestEffort(item.content, fetchImpl, remainingBudget);
            if (fetched.oversized) {
                externalBlobs.set(index, { failureReason: "超过 32MB 批量限制，请单独打开保存" });
                return;
            }
            const blob = fetched.blob;
            if (!blob || blob.size === 0) {
                externalBlobs.set(index, { failureReason: "外部链接无法访问" });
                return;
            }
            if (reservedInlineBytes + blob.size > MAX_OWNED_ARTIFACT_BYTES) {
                externalBlobs.set(index, { failureReason: "超过 32MB 批量限制，请单独打开保存" });
                return;
            }
            reservedInlineBytes += blob.size;
            externalBlobs.set(index, { blob });
        });
    }

    const prepared: Array<{ fileName: string; resourceId?: string; blob?: Blob }> = [];
    const preFailures: BatchDownloadFailure[] = [];

    for (let index = 0; index < resolved.length; index += 1) {
        const item = resolved[index];
        if (!item.valid) {
            preFailures.push({ fileName: item.fileName, reason: "缺少可下载的媒体内容" });
            continue;
        }
        if (item.resourceId) {
            prepared.push({ fileName: item.fileName, resourceId: item.resourceId });
            continue;
        }
        const fetched = externalBlobs.get(index);
        if (!fetched?.blob) {
            preFailures.push({ fileName: item.fileName, reason: fetched?.failureReason || "外部链接无法访问" });
            continue;
        }
        prepared.push({ fileName: item.fileName, blob: fetched.blob });
    }
    externalBlobs.clear();

    if (prepared.length === 0) {
        return {
            downloaded: 0,
            failed: preFailures.length,
            ...(preFailures.length > 0 ? { failures: preFailures } : {}),
        };
    }

    const outcome = await saveNativeBatch(prepared, dirToken);
    if (!outcome) {
        return undefined;
    }
    if (outcome.cancelled) {
        return { downloaded: 0, failed: 0, cancelled: true };
    }
    const failures = [...preFailures, ...(outcome.failures ?? [])];
    return {
        downloaded: outcome.saved,
        failed: preFailures.length + outcome.failed,
        cancelled: false,
        ...(failures.length > 0 ? { failures } : {}),
    };
}

async function fetchExternalBlobBestEffort(
    content: string,
    fetchImpl: typeof fetch | undefined,
    maxBytes: number,
): Promise<{ blob: Blob | null; oversized?: boolean }> {
    if (typeof fetchImpl !== "function") return { blob: null };
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS) : undefined;
    try {
        const response = await fetchImpl(content, controller ? { signal: controller.signal } : undefined);
        if (!response.ok) return { blob: null };
        const declaredLength = Number(response.headers?.get("content-length") || "");
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            controller?.abort();
            return { blob: null, oversized: true };
        }
        if (response.body && typeof response.body.getReader === "function") {
            const reader = response.body.getReader();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let total = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value || value.byteLength === 0) continue;
                    total += value.byteLength;
                    if (total > maxBytes) {
                        await reader.cancel().catch(() => {});
                        controller?.abort();
                        return { blob: null, oversized: true };
                    }
                    const copy = new Uint8Array(value.byteLength);
                    copy.set(value);
                    chunks.push(copy);
                }
            } finally {
                reader.releaseLock();
            }
            return {
                blob: new Blob(chunks, { type: response.headers?.get("content-type") || "" }),
            };
        }
        const blob = await response.blob();
        if (blob.size > maxBytes) {
            return { blob: null, oversized: true };
        }
        return { blob };
    } catch {
        return { blob: null };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const current = items[cursor];
            cursor += 1;
            await worker(current);
        }
    });
    await Promise.all(runners);
}

async function downloadSingleNodeMedia(input: {
    content: string;
    resourceId: string;
    filename: string;
    fetchImpl: typeof fetch | undefined;
    hasCustomFetch: boolean;
    loadResourceBlob: (storageKey: string) => Promise<Blob | null>;
    triggerDownload: (href: string, filename: string) => void;
    nativeShell: boolean;
}): Promise<string | null> {
    const { content, resourceId, filename, fetchImpl, hasCustomFetch, loadResourceBlob, triggerDownload, nativeShell } = input;

    if (resourceId && !hasCustomFetch) {
        try {
            const blob = await loadResourceBlob(resourceStorageKey(resourceId));
            if (!blob) return "本地文件不可用";
            return triggerBlobDownload(blob, filename, triggerDownload) ? null : "浏览器不支持保存文件";
        } catch {
            return "本地文件读取失败";
        }
    }

    if (typeof fetchImpl === "function" && content) {
        try {
            const response = await fetchImpl(content);
            if (!response.ok) {
                return `链接返回 ${response.status}`;
            }
            const blob = await response.blob();
            if (triggerBlobDownload(blob, filename, triggerDownload)) {
                return null;
            }
            if (!nativeShell && isSafeDirectBrowserDownloadUrl(content)) {
                triggerDownload(content, filename);
                return null;
            }
            return "当前链接无法直接下载";
        } catch {
            // Fall through to browser anchor download only for safe public URLs outside Wails.
        }
    }

    // Never navigate the desktop WebView or click a raw loopback/local/protected URL via <a download>.
    if (nativeShell || !content || !isSafeDirectBrowserDownloadUrl(content)) {
        return "本地临时地址不可直接下载";
    }
    try {
        triggerDownload(content, filename);
        return null;
    } catch {
        return "下载触发失败";
    }
}

function triggerBlobDownload(blob: Blob, filename: string, triggerDownload: (href: string, filename: string) => void): boolean {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        return false;
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
        triggerDownload(objectUrl, filename);
    } finally {
        setTimeout(() => {
            try {
                URL.revokeObjectURL?.(objectUrl);
            } catch {
                // Ignore revoke errors in test environments
            }
        }, OBJECT_URL_REVOKE_DELAY_MS);
    }
    return true;
}

function triggerAnchorDownload(href: string, filename: string) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
        return;
    }
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = "noopener noreferrer";
    if (/^https?:\/\//i.test(href)) {
        anchor.target = "_blank";
    }
    anchor.style.display = "none";
    document.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

function isDownloadableMediaNodeType(type: CanvasNodeTypeId): boolean {
    return (
        type === CanvasNodeType.Image
        || type === CanvasNodeType.Video
        || type === CanvasNodeType.Audio
    );
}

function defaultBatchMediaLabel(type: CanvasNodeTypeId): string {
    if (type === CanvasNodeType.Video) return "视频";
    if (type === CanvasNodeType.Audio) return "音频";
    return "图片";
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
