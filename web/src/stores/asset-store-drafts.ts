import { parseAssetRecord } from "@/lib/asset-record";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import type { Asset, AssetStoreDraft, AssetStoreDraftKind, AssetStoreDraftRecord } from "./asset-types";

type AssetStoreDraftDocument = {
    drafts: Record<string, AssetStoreDraft>;
    clocks: Record<string, number>;
};

type AssetDraftStoreHooks = {
    readAssets: () => Asset[];
    applyDrafts: (updater: (assets: Asset[]) => Asset[]) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    clearDesktopLegacyScopes?: () => void;
};

export const ASSET_STORE_DRAFTS_KEY = "infinite-canvas:asset_store_drafts";

let suppressAssetStoreDraftTracking = 0;
let hooks: AssetDraftStoreHooks = {
    readAssets: () => [],
    applyDrafts: () => {},
    trackOperation: (operation) => operation,
};

/** Uncommitted commit-intent, keyed by userScope so A→B→A can recover without auto-dispatch. */
const assetStoreDrafts = new Map<string, Map<string, AssetStoreDraft>>();
/** Per-asset high-water version; survives ack so an older ack cannot match a new edit. */
const assetStoreDraftClocks = new Map<string, Map<string, number>>();
const hydratedAssetDraftScopes = new Set<string>();
const hydratingAssetDraftScopes = new Map<string, Promise<void>>();
const assetDraftWriteChains = new Map<string, Promise<unknown>>();
const assetDraftWriteFailures = new Map<string, unknown>();

export function bindAssetDraftStoreHooks(nextHooks: AssetDraftStoreHooks) {
    hooks = nextHooks;
}

function cloneAssetSnapshot(asset: Asset): Asset {
    return parseAssetRecord(JSON.parse(JSON.stringify(asset)));
}

function cloneAssetStoreDraft(draft: AssetStoreDraft): AssetStoreDraft {
    return {
        kind: draft.kind,
        version: draft.version,
        ...(draft.kind === "upsert" && draft.asset ? { asset: cloneAssetSnapshot(draft.asset) } : {}),
    };
}

function parsePersistedAssetStoreDraftDocument(raw: string | null): { drafts: Map<string, AssetStoreDraft>; clocks: Map<string, number> } {
    const drafts = new Map<string, AssetStoreDraft>();
    const clocks = new Map<string, number>();
    if (!raw) return { drafts, clocks };
    try {
        const parsed = JSON.parse(raw) as { drafts?: Record<string, { kind?: unknown; version?: unknown; asset?: unknown }>; clocks?: Record<string, unknown> };
        if (!parsed || typeof parsed !== "object") return { drafts, clocks };
        if (parsed.clocks && typeof parsed.clocks === "object") {
            for (const [id, value] of Object.entries(parsed.clocks)) {
                const version = Number(value);
                if (!id || !Number.isInteger(version) || version < 1) continue;
                clocks.set(id, version);
            }
        }
        if (!parsed.drafts || typeof parsed.drafts !== "object") return { drafts, clocks };
        for (const [id, value] of Object.entries(parsed.drafts)) {
            if (!id || (value?.kind !== "upsert" && value?.kind !== "delete")) continue;
            const version = Number(value.version);
            if (!Number.isInteger(version) || version < 1) continue;
            const draft: AssetStoreDraft = { kind: value.kind, version };
            if (value.kind === "upsert" && value.asset !== undefined) {
                try {
                    draft.asset = parseAssetRecord(value.asset);
                } catch {
                    // Keep the upsert intent even if a historical snapshot is unreadable.
                }
            }
            drafts.set(id, draft);
            const clock = clocks.get(id) ?? 0;
            if (version > clock) clocks.set(id, version);
        }
    } catch {
        // Recoverable commit-intent only; a bad cache must not block the asset library.
    }
    return { drafts, clocks };
}

function snapshotAssetStoreDraftDocument(userScope: string): AssetStoreDraftDocument {
    const drafts: Record<string, AssetStoreDraft> = {};
    const source = assetStoreDrafts.get(userScope);
    if (source) {
        for (const [id, draft] of source) drafts[id] = cloneAssetStoreDraft(draft);
    }
    const clocks: Record<string, number> = {};
    const clockSource = assetStoreDraftClocks.get(userScope);
    if (clockSource) {
        for (const [id, version] of clockSource) clocks[id] = version;
    }
    return { drafts, clocks };
}

function isEmptyAssetStoreDraftDocument(serialized: string) {
    try {
        const parsed = JSON.parse(serialized) as AssetStoreDraftDocument;
        const draftCount = parsed?.drafts && typeof parsed.drafts === "object" ? Object.keys(parsed.drafts).length : 0;
        const clockCount = parsed?.clocks && typeof parsed.clocks === "object" ? Object.keys(parsed.clocks).length : 0;
        return draftCount === 0 && clockCount === 0;
    } catch {
        return true;
    }
}

async function writeSerializedAssetStoreDrafts(userScope: string, serialized: string) {
    const storage = localForageStorageForScope(userScope);
    if (isEmptyAssetStoreDraftDocument(serialized)) {
        await storage.removeItem(ASSET_STORE_DRAFTS_KEY);
        return;
    }
    await storage.setItem(ASSET_STORE_DRAFTS_KEY, serialized);
}

function scheduleAssetStoreDraftPersist(userScope: string) {
    const serialized = JSON.stringify(snapshotAssetStoreDraftDocument(userScope));
    const previous = assetDraftWriteChains.get(userScope) ?? Promise.resolve();
    const run = previous.then(undefined, () => undefined).then(async () => {
        try {
            await writeSerializedAssetStoreDrafts(userScope, serialized);
            assetDraftWriteFailures.delete(userScope);
        } catch (error) {
            assetDraftWriteFailures.set(userScope, error);
            throw error;
        }
    });
    const tail = run.then(() => undefined, () => undefined);
    assetDraftWriteChains.set(userScope, tail);
    void tail.then(() => {
        if (assetDraftWriteChains.get(userScope) === tail) assetDraftWriteChains.delete(userScope);
    });
    if (userScope === getActiveUserScope()) return hooks.trackOperation(run);
    void run.then(undefined, () => undefined);
    return run;
}

function nextAssetStoreDraftVersion(userScope: string, id: string) {
    const clocks = assetStoreDraftClocks.get(userScope) ?? new Map<string, number>();
    const current = Math.max(clocks.get(id) ?? 0, assetStoreDrafts.get(userScope)?.get(id)?.version ?? 0);
    const version = current + 1;
    clocks.set(id, version);
    assetStoreDraftClocks.set(userScope, clocks);
    return version;
}

/**
 * Hydration merge order:
 * 1. Read durable drafts and clocks.
 * 2. In-process memory drafts win every overlapping id. An edit made while
 *    getItem awaited is newer than that durable snapshot, even when the
 *    durable counter is larger.
 * 3. Durable fills ids that memory does not have.
 * 4. clocks[id] = max(durable clocks, durable draft versions, memory clocks,
 *    memory draft versions).
 * 5. If a memory-winning draft is at or below that high-water, bump it to
 *    high-water + 1 so an older ack cannot match the new edit.
 * Upsert snapshots project into effective assets without a backend save.
 * Delete drafts stay tombstones and drop matching effective assets.
 */
function mergeHydratedAssetStoreDrafts(
    durableDrafts: Map<string, AssetStoreDraft>,
    durableClocks: Map<string, number>,
    memoryDrafts: Map<string, AssetStoreDraft>,
    memoryClocks: Map<string, number>,
) {
    const clocks = new Map<string, number>();
    const ids = new Set([...durableDrafts.keys(), ...durableClocks.keys(), ...memoryDrafts.keys(), ...memoryClocks.keys()]);
    for (const id of ids) {
        clocks.set(
            id,
            Math.max(durableClocks.get(id) ?? 0, durableDrafts.get(id)?.version ?? 0, memoryClocks.get(id) ?? 0, memoryDrafts.get(id)?.version ?? 0),
        );
    }

    const merged = new Map<string, AssetStoreDraft>();
    for (const [id, draft] of durableDrafts) merged.set(id, cloneAssetStoreDraft(draft));
    let bumped = false;
    for (const [id, draft] of memoryDrafts) {
        const highWater = clocks.get(id) ?? draft.version;
        if (highWater > draft.version) {
            const version = highWater + 1;
            clocks.set(id, version);
            merged.set(id, { ...cloneAssetStoreDraft(draft), version });
            bumped = true;
        } else {
            merged.set(id, cloneAssetStoreDraft(draft));
        }
    }
    return { merged, clocks, bumped };
}

function applyAssetStoreDraftsToEffectiveAssets(drafts: Map<string, AssetStoreDraft>) {
    runAssetStoreProjection(() => {
        hooks.applyDrafts((assets) => {
            const upserts = new Map<string, Asset>();
            const deleted = new Set<string>();
            for (const [id, draft] of drafts) {
                if (draft.kind === "delete") deleted.add(id);
                else if (draft.asset) upserts.set(id, cloneAssetSnapshot(draft.asset));
            }
            const next: Asset[] = [];
            const seen = new Set<string>();
            for (const asset of assets) {
                if (deleted.has(asset.id)) continue;
                next.push(upserts.get(asset.id) ?? asset);
                seen.add(asset.id);
            }
            for (const [id, asset] of upserts) {
                if (seen.has(id) || deleted.has(id)) continue;
                next.unshift(asset);
            }
            return next;
        });
    });
}

export async function hydrateAssetStoreDrafts(userScope = getActiveUserScope()) {
    if (hydratedAssetDraftScopes.has(userScope)) return;
    const pending = hydratingAssetDraftScopes.get(userScope);
    if (pending) return pending;

    const done = (async () => {
        const durable = parsePersistedAssetStoreDraftDocument(await localForageStorageForScope(userScope).getItem(ASSET_STORE_DRAFTS_KEY));
        const memoryDrafts = assetStoreDrafts.get(userScope) ?? new Map<string, AssetStoreDraft>();
        const memoryClocks = assetStoreDraftClocks.get(userScope) ?? new Map<string, number>();
        const { merged, clocks, bumped } = mergeHydratedAssetStoreDrafts(durable.drafts, durable.clocks, memoryDrafts, memoryClocks);
        if (merged.size) assetStoreDrafts.set(userScope, merged);
        else assetStoreDrafts.delete(userScope);
        if (clocks.size) assetStoreDraftClocks.set(userScope, clocks);
        else assetStoreDraftClocks.delete(userScope);
        hydratedAssetDraftScopes.add(userScope);
        if (userScope === getActiveUserScope()) applyAssetStoreDraftsToEffectiveAssets(merged);
        if (memoryDrafts.size > 0 || bumped) scheduleAssetStoreDraftPersist(userScope);
    })();

    hydratingAssetDraftScopes.set(userScope, done);
    try {
        await done;
    } finally {
        if (hydratingAssetDraftScopes.get(userScope) === done) hydratingAssetDraftScopes.delete(userScope);
    }
}

export function markAssetStoreDraftForScope(userScope: string, id: string, kind: AssetStoreDraftKind, explicitAsset?: Asset) {
    if (suppressAssetStoreDraftTracking) return;
    const drafts = assetStoreDrafts.get(userScope) ?? new Map<string, AssetStoreDraft>();
    const version = nextAssetStoreDraftVersion(userScope, id);
    if (kind === "delete") {
        drafts.set(id, { kind, version });
    } else {
        const asset = explicitAsset ?? hooks.readAssets().find((item) => item.id === id);
        drafts.set(id, { kind, version, ...(asset ? { asset: cloneAssetSnapshot(asset) } : {}) });
    }
    assetStoreDrafts.set(userScope, drafts);
    return scheduleAssetStoreDraftPersist(userScope);
}

export function markAssetStoreDraft(id: string, kind: AssetStoreDraftKind) {
    markAssetStoreDraftForScope(getActiveUserScope(), id, kind);
}

/** Record an explicit delete intent without waiting for removeAsset. 404 is idempotent. */
export function recordAssetStoreDraft(id: string, kind: AssetStoreDraftKind) {
    markAssetStoreDraft(id, kind);
}

export function peekAssetStoreDraft(userScope: string, id: string) {
    return assetStoreDrafts.get(userScope)?.get(id);
}

/** Apply a server projection without treating the local patch as a new uncommitted write. */
export function runAssetStoreProjection<T>(operation: () => T): T {
    suppressAssetStoreDraftTracking += 1;
    try {
        return operation();
    } finally {
        suppressAssetStoreDraftTracking -= 1;
    }
}

export function readAssetStoreDrafts() {
    const drafts = assetStoreDrafts.get(getActiveUserScope()) ?? new Map<string, AssetStoreDraft>();
    const upserts: AssetStoreDraftRecord[] = [];
    const deletes: AssetStoreDraftRecord[] = [];
    for (const [id, draft] of drafts) {
        if (draft.kind === "upsert") upserts.push({ id, ...draft });
        else deletes.push({ id, ...draft });
    }
    return { upserts, deletes };
}

/** Ack only the submitted version. A later local edit keeps its draft. Clocks stay. */
export function ackAssetStoreDraft(id: string, version: number) {
    const userScope = getActiveUserScope();
    const drafts = assetStoreDrafts.get(userScope);
    if (!drafts) return;
    const current = drafts.get(id);
    if (!current || current.version !== version) return;
    drafts.delete(id);
    if (drafts.size) assetStoreDrafts.set(userScope, drafts);
    else assetStoreDrafts.delete(userScope);
    scheduleAssetStoreDraftPersist(userScope);
}

export async function flushAssetStoreDraftWrites(scope = getActiveUserScope()) {
    const draftWrites = assetDraftWriteChains.get(scope);
    if (draftWrites) await draftWrites;

    const draftFailure = assetDraftWriteFailures.get(scope);
    if (draftFailure !== undefined) throw draftFailure;
}

export function hasActiveAssetStoreDraftWrites() {
    return assetDraftWriteChains.size > 0;
}

export function unloadAssetStoreDraftsForTests() {
    assetStoreDrafts.clear();
    assetStoreDraftClocks.clear();
    hydratedAssetDraftScopes.clear();
    hydratingAssetDraftScopes.clear();
    assetDraftWriteChains.clear();
    assetDraftWriteFailures.clear();
    hooks.clearDesktopLegacyScopes?.();
}

export async function resetAssetStoreDraftsForTests() {
    const scopes = new Set([...assetStoreDrafts.keys(), ...assetStoreDraftClocks.keys(), ...hydratedAssetDraftScopes, ...assetDraftWriteChains.keys(), getActiveUserScope()]);
    const pending = [...assetDraftWriteChains.values()];
    await Promise.all(pending);
    unloadAssetStoreDraftsForTests();
    await Promise.all([...scopes].map((scope) => localForageStorageForScope(scope).removeItem(ASSET_STORE_DRAFTS_KEY)));
}
