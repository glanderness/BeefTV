import { linkProjectAsset, moveProjectAsset, updateProjectAssetCategory } from "@/services/api/projects";
import { ApiError } from "@/services/api/request";
import { listWorkspaceAssetsPage } from "@/services/api/workspace-assets";
import { deleteWorkspaceAssetRecord, putWorkspaceAsset } from "@/services/api/workspace-data";
import { normalizeAssetCategory } from "@/lib/asset-category";
import { assertUserScope, captureUserScope, userScopeMatches, UserScopeAbandonedError, type CapturedUserScope } from "@/lib/user-scope-guard";
import { usesBrowserLocalResourceStore, workspaceAssetHasCanonicalMediaPersist } from "@/services/workspace-resource-storage";
import { loadWorkspaceAssetsForUse } from "@/services/workspace-asset-read";
import {
    ackAssetStoreDraft,
    flushAssetStorePersistence,
    hydrateAssetStoreDrafts,
    peekAssetStoreDraft,
    readAssetStoreDrafts,
    recordAssetStoreDraft,
    runAssetStoreProjection,
    useAssetStore,
    type Asset,
    type AssetCategory,
    type AssetStatus,
} from "@/stores/use-asset-store";

export type WorkspaceAssetLinkOptions = {
    asset: Asset;
    domainProjectId?: string;
    category?: AssetCategory;
    folderId?: string;
    source?: "uploaded" | "canvas";
    signal?: AbortSignal;
    expectedScope?: CapturedUserScope;
};

const assetCommitChains = new Map<string, Promise<unknown>>();

export class WorkspaceAssetMediaPendingError extends Error {
    constructor() {
        super("素材文件尚未保存到工作区，修改已保留在本机");
        this.name = "WorkspaceAssetMediaPendingError";
    }
}

function assertAssetWriteReceipt(receipt: AssetWriteReceipt | undefined, id: string): asserts receipt is AssetWriteReceipt {
    if (!receipt || receipt.id !== id) throw new Error("素材保存回执无效，修改已保留在本机");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function isNotFoundAssetError(error: unknown) {
    return error instanceof ApiError && (error.status === 404 || error.code === 404);
}

function assetCommitKey(userScope: string, assetId: string) {
    return `${userScope}\0${assetId}`;
}

function enqueueAssetCommit<T>(userScope: string, assetId: string, epoch: number, job: () => Promise<T>): Promise<T> {
    const key = assetCommitKey(userScope, assetId);
    const previous = assetCommitChains.get(key) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(async () => {
        const live = captureUserScope();
        if (live.userScope !== userScope || live.epoch !== epoch) throw new UserScopeAbandonedError();
        return job();
    });
    assetCommitChains.set(key, run.then(() => undefined, () => undefined));
    return run;
}

export function resetWorkspaceAssetCommitStateForTests() {
    assetCommitChains.clear();
}

function linkedProjectIds(asset: Asset, domainProjectId?: string) {
    const projectIds = Array.isArray(asset.metadata?.projectIds) ? asset.metadata.projectIds.filter((id): id is string => typeof id === "string") : [];
    return domainProjectId ? [...new Set([...projectIds, domainProjectId])] : projectIds;
}

/** Keep later local edits. Only copy receipt fields the user has not changed since submit. */
type AssetWriteReceipt = {
    id?: string;
    title?: string;
    category?: string;
    status?: string;
    folderId?: string;
    primaryVersionId?: string;
    createdAt?: string;
    updatedAt?: string;
};

export function mergeWorkspaceAssetReceipt(submitted: Asset, live: Asset, receipt: AssetWriteReceipt) {
    const patch: Partial<Asset> = {};
    if (live.title === submitted.title && receipt.title && receipt.title !== live.title) patch.title = receipt.title;
    if ((live.category || "other") === (submitted.category || "other") && receipt.category) {
        const category = normalizeAssetCategory(receipt.category);
        if (category !== live.category) patch.category = category;
    }
    if ((live.status || "confirmed") === (submitted.status || "confirmed") && receipt.status && receipt.status !== live.status) {
        patch.status = receipt.status as AssetStatus;
    }
    if ((live.folderId || "") === (submitted.folderId || "") && receipt.folderId !== undefined && (receipt.folderId || "") !== (live.folderId || "")) {
        patch.folderId = receipt.folderId || undefined;
    }
    if ((live.primaryVersionId || "") === (submitted.primaryVersionId || "") && receipt.primaryVersionId && receipt.primaryVersionId !== live.primaryVersionId) {
        patch.primaryVersionId = receipt.primaryVersionId;
    }
    return patch;
}

function projectLinkedMetadata(live: Asset, domainProjectId: string | undefined) {
    if (!domainProjectId) return live.metadata;
    return { ...live.metadata, projectIds: linkedProjectIds(live, domainProjectId) };
}

function applyReceiptProjection(id: string, submitted: Asset, receipt: AssetWriteReceipt, domainProjectId?: string) {
    const live = useAssetStore.getState().assets.find((item) => item.id === id);
    if (!live) return false;
    const patch = mergeWorkspaceAssetReceipt(submitted, live, receipt);
    const metadata = projectLinkedMetadata(live, domainProjectId);
    const metadataChanged = JSON.stringify(metadata ?? null) !== JSON.stringify(live.metadata ?? null);
    if (!Object.keys(patch).length && !metadataChanged) return true;
    runAssetStoreProjection(() => {
        useAssetStore.getState().updateAsset(id, metadataChanged ? { ...patch, metadata } : patch);
    });
    return true;
}

async function commitTrackedAssetDraft(id: string, expected: CapturedUserScope, signal?: AbortSignal) {
    throwIfAborted(signal);
    assertUserScope(expected);
    const draft = peekAssetStoreDraft(expected.userScope, id);
    if (!draft) return;
    const submittedVersion = draft.version;
    if (draft.kind === "delete") {
        try {
            await deleteWorkspaceAssetRecord(id, { signal, expectedScope: expected });
        } catch (error) {
            if (!isNotFoundAssetError(error)) throw error;
        }
        throwIfAborted(signal);
        if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
        ackAssetStoreDraft(expected, id, submittedVersion);
        const later = peekAssetStoreDraft(expected.userScope, id);
        if (later?.kind === "upsert") return;
        if (useAssetStore.getState().assets.some((item) => item.id === id)) {
            await runAssetStoreProjection(() => useAssetStore.getState().removeAsset(id));
        }
        return;
    }

    const asset = useAssetStore.getState().assets.find((item) => item.id === id) ?? draft.asset;
    if (!asset) return;
    if (!workspaceAssetHasCanonicalMediaPersist(asset)) {
        await flushAssetStorePersistence(expected);
        throw new WorkspaceAssetMediaPendingError();
    }
    const submitted = asset;
    const saved = await putWorkspaceAsset(id, submitted, { signal, expectedScope: expected });
    throwIfAborted(signal);
    if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
    assertAssetWriteReceipt(saved?.asset, id);
    ackAssetStoreDraft(expected, id, submittedVersion);
    applyReceiptProjection(id, submitted, saved.asset);
}

/** Single boundary for local asset persistence and optional project linking. */
export async function persistWorkspaceAssetLink({ asset, domainProjectId, category, folderId, source, signal, expectedScope }: WorkspaceAssetLinkOptions) {
    const expected = expectedScope ?? captureUserScope();
    throwIfAborted(signal);
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    if (!workspaceAssetHasCanonicalMediaPersist(asset)) {
        await flushAssetStorePersistence(expected);
        throw new WorkspaceAssetMediaPendingError();
    }

    if (usesBrowserLocalResourceStore()) {
        if (domainProjectId) {
            const projectIds = linkedProjectIds(asset, domainProjectId);
            useAssetStore.getState().updateAsset(asset.id, { metadata: { ...asset.metadata, projectIds } });
        }
        const submittedVersion = peekAssetStoreDraft(expected.userScope, asset.id)?.version;
        await flushAssetStorePersistence(expected);
        assertUserScope(expected);
        if (submittedVersion) ackAssetStoreDraft(expected, asset.id, submittedVersion);
        return;
    }

    await enqueueAssetCommit(expected.userScope, asset.id, expected.epoch, async () => {
        throwIfAborted(signal);
        assertUserScope(expected);
        const live = useAssetStore.getState().assets.find((item) => item.id === asset.id) ?? peekAssetStoreDraft(expected.userScope, asset.id)?.asset ?? asset;
        const draft = peekAssetStoreDraft(expected.userScope, live.id);
        const submittedVersion = draft?.version;
        if (draft?.kind === "delete") {
            await commitTrackedAssetDraft(live.id, expected, signal);
            return;
        }
        const submitted = live;
        const saved = await putWorkspaceAsset(live.id, submitted, { signal, expectedScope: expected });
        throwIfAborted(signal);
        if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
        assertAssetWriteReceipt(saved?.asset, live.id);
        if (submittedVersion) ackAssetStoreDraft(expected, live.id, submittedVersion);
        const afterPut = peekAssetStoreDraft(expected.userScope, live.id);
        if (afterPut?.kind === "delete") {
            await commitTrackedAssetDraft(live.id, expected, signal);
            return;
        }
        if (!useAssetStore.getState().assets.some((item) => item.id === live.id)) return;

        let receipt: AssetWriteReceipt = saved.asset;
        if (domainProjectId) {
            const { asset: linkedAsset } = await linkProjectAsset(
                domainProjectId,
                { assetId: live.id, category: normalizeAssetCategory(category || live.category), folderId, source },
                signal,
                expected,
            );
            throwIfAborted(signal);
            assertUserScope(expected);
            let linked = category && linkedAsset.category !== category ? (await updateProjectAssetCategory(domainProjectId, live.id, category, signal, expected)).asset : linkedAsset;
            throwIfAborted(signal);
            assertUserScope(expected);
            if (folderId !== undefined && (linked.folderId || "") !== folderId) linked = (await moveProjectAsset(domainProjectId, live.id, folderId, signal, expected)).asset;
            throwIfAborted(signal);
            assertUserScope(expected);
            receipt = linked;
        }
        if (peekAssetStoreDraft(expected.userScope, live.id)?.kind === "delete") {
            await commitTrackedAssetDraft(live.id, expected, signal);
            return;
        }
        applyReceiptProjection(live.id, submitted, receipt, domainProjectId);
    });
}

export type DeleteWorkspaceAssetOptions = {
    expectedStatus?: "archived";
    onDraftRecorded?: (version: number) => void;
};

export async function deleteWorkspaceAsset(id: string, expectedScope?: CapturedUserScope, options?: DeleteWorkspaceAssetOptions) {
    const expected = expectedScope ?? captureUserScope();
    const assetId = id.trim();
    if (!assetId) throw new Error("素材 ID 不能为空");
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);

    if (usesBrowserLocalResourceStore()) {
        if (options?.expectedStatus) {
            const live = useAssetStore.getState().assets.find((item) => item.id === assetId);
            if (live && live.status !== options.expectedStatus) {
                throw new ApiError("素材已不在回收站，未删除", { status: 409, code: 409 });
            }
        }
        await useAssetStore.getState().removeAsset(assetId);
        await flushAssetStorePersistence(expected);
        const draft = peekAssetStoreDraft(expected.userScope, assetId);
        if (draft) ackAssetStoreDraft(expected, assetId, draft.version);
        return;
    }

    recordAssetStoreDraft(assetId, "delete", expected);
    const submittedVersion = peekAssetStoreDraft(expected.userScope, assetId)?.version ?? 0;
    options?.onDraftRecorded?.(submittedVersion);
    await enqueueAssetCommit(expected.userScope, assetId, expected.epoch, async () => {
        assertUserScope(expected);
        const current = peekAssetStoreDraft(expected.userScope, assetId);
        if (current && current.version !== submittedVersion && current.kind === "upsert") return;
        try {
            await deleteWorkspaceAssetRecord(assetId, {
                expectedScope: expected,
                ...(options?.expectedStatus ? { params: { expectedStatus: options.expectedStatus } } : {}),
            });
        } catch (error) {
            if (!isNotFoundAssetError(error)) throw error;
        }
        if (!userScopeMatches(expected)) throw new UserScopeAbandonedError();
        const later = peekAssetStoreDraft(expected.userScope, assetId);
        if (later && later.version !== submittedVersion && later.kind === "upsert") return;
        if (later && later.version === submittedVersion) ackAssetStoreDraft(expected, assetId, submittedVersion);
        if (useAssetStore.getState().assets.some((item) => item.id === assetId)) {
            await runAssetStoreProjection(() => useAssetStore.getState().removeAsset(assetId));
        }
    });
}

export const WORKSPACE_ASSET_CLEAR_TRASH_PAGE_SIZE = 40;

export async function restoreWorkspaceArchivedAsset(id: string, expected: CapturedUserScope) {
    assertUserScope(expected);
    await loadWorkspaceAssetsForUse([id], expected);
    assertUserScope(expected);
    if (usesBrowserLocalResourceStore()) {
        useAssetStore.getState().updateAsset(id, { status: "confirmed" });
        await persistWorkspaceAssetChanges(expected);
        return;
    }
    await enqueueAssetCommit(expected.userScope, id, expected.epoch, async () => {
        assertUserScope(expected);
        const live = useAssetStore.getState().assets.find((asset) => asset.id === id);
        if (!live) throw new Error("素材不存在，请刷新后重试");
        const draft = peekAssetStoreDraft(expected.userScope, id);
        if (draft?.kind === "delete") throw new Error("素材正在删除，无法恢复");
        // Keep it in the recovery list until the backend confirms the restore.
        const saved = await putWorkspaceAsset(id, { ...live, status: "confirmed" }, { expectedScope: expected });
        assertUserScope(expected);
        assertAssetWriteReceipt(saved?.asset, id);
        if (draft) ackAssetStoreDraft(expected, id, draft.version);
        applyReceiptProjection(id, live, saved.asset);
    });
}

export type ClearWorkspaceArchivedAssetsResult = {
    deleted: number;
    remaining: number;
    error?: Error;
};

export async function clearWorkspaceArchivedAssets(options?: {
    expectedScope?: CapturedUserScope;
    signal?: AbortSignal;
    pageSize?: number;
}): Promise<ClearWorkspaceArchivedAssetsResult> {
    const expected = options?.expectedScope ?? captureUserScope();
    const pageSize = Math.min(120, Math.max(1, options?.pageSize ?? WORKSPACE_ASSET_CLEAR_TRASH_PAGE_SIZE));
    throwIfAborted(options?.signal);
    assertUserScope(expected);

    if (usesBrowserLocalResourceStore()) {
        const trash = useAssetStore.getState().assets.filter((asset) => asset.kind !== "entity" && asset.status === "archived");
        for (const asset of trash) {
            throwIfAborted(options?.signal);
            assertUserScope(expected);
            await deleteWorkspaceAsset(asset.id, expected, { expectedStatus: "archived" });
        }
        const remaining = useAssetStore.getState().assets.filter((asset) => asset.kind !== "entity" && asset.status === "archived").length;
        return { deleted: trash.length - remaining, remaining };
    }

    let deleted = 0;
    const attempted = new Set<string>();
    while (true) {
        throwIfAborted(options?.signal);
        assertUserScope(expected);
        const page = await loadCanonicalArchivedPage(1, pageSize, expected, options?.signal);
        const batch = page.ids.filter((id) => !attempted.has(id));
        if (!batch.length) {
            return { deleted, remaining: page.total };
        }
        for (const id of batch) {
            throwIfAborted(options?.signal);
            assertUserScope(expected);
            attempted.add(id);
            let attemptVersion: number | undefined;
            try {
                await deleteWorkspaceAsset(id, expected, {
                    expectedStatus: "archived",
                    onDraftRecorded: (version) => {
                        attemptVersion = version;
                    },
                });
                deleted += 1;
            } catch (error) {
                if (error instanceof UserScopeAbandonedError || (error instanceof DOMException && error.name === "AbortError")) throw error;
                if (attemptVersion !== undefined) {
                    const latest = peekAssetStoreDraft(expected.userScope, id);
                    if (latest?.kind === "delete" && latest.version === attemptVersion) ackAssetStoreDraft(expected, id, attemptVersion);
                }
                const remainingPage = await loadCanonicalArchivedPage(1, 1, expected, options?.signal);
                return {
                    deleted,
                    remaining: remainingPage.total,
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
        }
    }
}

export function workspaceClearTrashMessage(result: ClearWorkspaceArchivedAssetsResult) {
    if (!result.error && result.remaining <= 0) {
        return { type: "success" as const, text: `已彻底清空回收站 ${result.deleted} 个素材` };
    }
    const remaining = `已删除 ${result.deleted} 个素材，回收站还剩 ${result.remaining} 个。`;
    const detail = result.error?.message?.trim();
    return { type: "error" as const, text: detail ? `${remaining}${detail}` : remaining };
}

async function loadCanonicalArchivedPage(page: number, pageSize: number, expected: CapturedUserScope, signal?: AbortSignal) {
    const remote = await listWorkspaceAssetsPage({ page, pageSize, status: "archived" }, { signal, expectedScope: expected });
    assertUserScope(expected);
    if (!remote || !Array.isArray(remote.assets)) throw new Error("素材列表无效");
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of remote.assets) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const kind = typeof record.kind === "string" ? record.kind : "";
        const status = typeof record.status === "string" ? record.status : "";
        if (!id || seen.has(id) || kind === "entity" || status !== "archived") continue;
        seen.add(id);
        ids.push(id);
    }
    return { ids, total: Math.max(0, Number(remote.total) || 0) };
}

export async function persistWorkspaceAssetChanges(expectedScope?: CapturedUserScope) {
    const expected = expectedScope ?? captureUserScope();
    assertUserScope(expected);
    await hydrateAssetStoreDrafts(expected.userScope);
    assertUserScope(expected);
    if (usesBrowserLocalResourceStore()) {
        const snapshot = readAssetStoreDrafts(expected);
        await flushAssetStorePersistence(expected);
        assertUserScope(expected);
        for (const draft of [...snapshot.upserts, ...snapshot.deletes]) ackAssetStoreDraft(expected, draft.id, draft.version);
        return;
    }

    const drafts = readAssetStoreDrafts(expected);
    const ids = [...new Set([...drafts.upserts, ...drafts.deletes].map((draft) => draft.id))];
    await Promise.all(ids.map((id) => enqueueAssetCommit(expected.userScope, id, expected.epoch, () => commitTrackedAssetDraft(id, expected))));
}
