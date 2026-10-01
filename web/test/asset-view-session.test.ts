import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    assetFolderQueryKey,
    assetLibraryQueryKey,
    assetPickerQueryKey,
    dropStaleAssetViewQueries,
    expectedScopeFromQueryKey,
    keepAssetViewPlaceholder,
    mergeHistoryLibraryAssets,
    runAssetViewAction,
    subscribeAssetViewScope,
} from "@/components/assets/asset-view-session";
import { getActiveUserScope, getActiveUserScopeEpoch, setActiveUserScope } from "@/lib/user-scope";
import { assertUserScope, captureUserScope, userScopeMatches } from "@/lib/user-scope-guard";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function switchScope(userId: string) {
    const previous = getActiveUserScope();
    setActiveUserScope(userId);
    return () => setActiveUserScope(previous);
}

function read(path: string) {
    return readFileSync(resolve(import.meta.dir, path), "utf8");
}

describe("asset view session controller", () => {
    test("query keys carry the captured epoch and delayed reads reuse that identity", async () => {
        const restore = switchScope("owner-a");
        try {
            const entry = captureUserScope();
            const key = assetLibraryQueryKey(entry, "history", 2, "image");
            expect(key[0]).toBe("asset-library");
            expect(key[1]).toBe("owner-a");
            expect(key[2]).toBe(entry.epoch);
            expect(expectedScopeFromQueryKey(key)).toEqual(entry);
            expect(expectedScopeFromQueryKey(assetFolderQueryKey(entry))).toEqual(entry);
            expect(expectedScopeFromQueryKey(assetPickerQueryKey(entry, 1, 40))).toEqual(entry);

            const started = deferred();
            const gate = deferred();
            let capturedAtDispatch: ReturnType<typeof captureUserScope> | undefined;
            const pending = (async () => {
                started.resolve();
                await gate.promise;
                capturedAtDispatch = expectedScopeFromQueryKey(key);
                return capturedAtDispatch;
            })();
            await started.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            const dispatched = await pending;
            expect(dispatched).toEqual(entry);
            expect(userScopeMatches(dispatched!)).toBe(false);
            expect(getActiveUserScope()).toBe("owner-a");
            expect(getActiveUserScopeEpoch()).toBeGreaterThan(entry.epoch);
        } finally {
            restore();
        }
    });

    test("placeholder data stays only inside the same epoch", () => {
        const restore = switchScope("owner-a");
        try {
            const entry = captureUserScope();
            const previous = [{ id: "a-private" }];
            const same = keepAssetViewPlaceholder(previous, { queryKey: assetLibraryQueryKey(entry, 1) }, entry);
            expect(same).toBe(previous);
            setActiveUserScope("owner-b");
            const next = captureUserScope();
            expect(keepAssetViewPlaceholder(previous, { queryKey: assetLibraryQueryKey(entry, 1) }, next)).toBeUndefined();
        } finally {
            restore();
        }
    });

    test("history load-more appends, first page replaces, and A→B→A starts empty", () => {
        const page1 = [
            { id: "hist-a", status: "confirmed" },
            { id: "hist-archived", status: "archived" },
        ];
        const page2 = [
            { id: "hist-a", status: "confirmed" },
            { id: "hist-b", status: "confirmed" },
        ];
        const first = mergeHistoryLibraryAssets([], page1, 1);
        expect(first.map((asset) => asset.id)).toEqual(["hist-a"]);
        const more = mergeHistoryLibraryAssets(first, page2, 2);
        expect(more.map((asset) => asset.id)).toEqual(["hist-a", "hist-b"]);
        const replaced = mergeHistoryLibraryAssets(more, page2, 1);
        expect(replaced.map((asset) => asset.id)).toEqual(["hist-a", "hist-b"]);

        const afterRemount = mergeHistoryLibraryAssets([], [{ id: "hist-a2", status: "confirmed" }], 1);
        expect(afterRemount.map((asset) => asset.id)).toEqual(["hist-a2"]);
        expect(afterRemount.some((asset) => asset.id === "hist-b")).toBe(false);
    });

    test("deferred upload after A→B→A does not persist or toast", async () => {
        const restore = switchScope("owner-a");
        const started = deferred();
        const gate = deferred();
        const events: string[] = [];
        try {
            const entry = captureUserScope();
            const pending = runAssetViewAction(entry, async (expected) => {
                started.resolve();
                await gate.promise;
                assertUserScope(expected);
                events.push("persist");
                events.push("toast");
                return "saved";
            });
            await started.promise;
            setActiveUserScope("owner-b");
            setActiveUserScope("owner-a");
            gate.resolve();
            expect(await pending).toBeUndefined();
            expect(events).toEqual([]);
            expect(userScopeMatches(entry)).toBe(false);
        } finally {
            restore();
        }
    });

    test("generation change drops cached library, folder, and picker queries before the next view", () => {
        const restore = switchScope("owner-a");
        const removed: string[] = [];
        const queryClient = {
            removeQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
                removed.push(String(queryKey[0]));
            },
        };
        let notified = 0;
        const unsubscribe = subscribeAssetViewScope(queryClient, () => {
            notified += 1;
        });
        try {
            dropStaleAssetViewQueries(queryClient);
            expect(removed.splice(0)).toEqual(["asset-library", "asset-folders", "asset-picker"]);
            setActiveUserScope("owner-b");
            expect(removed).toEqual(["asset-library", "asset-folders", "asset-picker"]);
            expect(notified).toBe(1);
        } finally {
            unsubscribe();
            restore();
        }
    });
});

describe("asset page and picker wiring", () => {
    test("assets page remounts on generation and binds library reads to the query-key epoch", () => {
        const page = read("../src/pages/assets/index.tsx");
        expect(page).toContain("useAssetViewGeneration(queryClient)");
        expect(page).toContain("key={generation}");
        expect(page).toContain("useState(() => captureUserScope())");
        expect(page).toContain("assetLibraryQueryKey(entryScope");
        expect(page).toContain("assetFolderQueryKey(entryScope)");
        expect(page).toContain("expectedScope: expectedScopeFromQueryKey(queryKey)");
        expect(page).toContain("keepAssetViewPlaceholder(previousData, previousQuery, entryScope)");
        expect(page).toContain("mergeHistoryLibraryAssets(current, next, historyPage)");
        expect(page).toContain("uploadImage(imageFile, undefined, scope)");
        expect(page).toContain("persistWorkspaceAssetChanges(scope)");
        expect(page).toContain("listWorkspaceAssetFolders(expectedScopeFromQueryKey(queryKey))");
        expect(page).toContain("canonicalHasMore");
        expect(page).toContain("generated: true");
        expect(page).toContain("加载更多");
        expect(page).toContain("清空回收站");
        expect(page).not.toContain("keepPreviousData");
        expect(page).not.toContain('queryKey: [...ASSET_LIBRARY_QUERY_KEY');
    });

    test("picker remounts on generation and does not recapture live identity in queryFn", () => {
        const picker = read("../src/components/assets/asset-library-picker-modal.tsx");
        expect(picker).toContain("useAssetViewGeneration(queryClient)");
        expect(picker).toContain("key={generation}");
        expect(picker).toContain("assetPickerQueryKey(entryScope");
        expect(picker).toContain("expectedScope: expectedScopeFromQueryKey(queryKey)");
        expect(picker).toContain("persistWorkspaceAssetChanges(scope)");
        expect(picker).toContain("deleteWorkspaceAsset(id, scope)");
        expect(picker).toContain("clearWorkspaceArchivedAssets({ expectedScope: scope })");
        expect(picker).toContain("清空回收站");
        expect(picker).not.toContain('queryKey: ["asset-picker", userId');
        expect(picker).not.toContain("isLocalWorkspaceMode");
    });

    test("batch upload captures entry scope before media APIs and persist", () => {
        const modal = read("../src/pages/assets/asset-batch-upload-modal.tsx");
        expect(modal).toContain("const expected = captureUserScope()");
        expect(modal).toContain("uploadMediaFile(item.file, \"video\"");
        expect(modal).toContain("expected);");
        expect(modal).toContain("uploadImage(item.file, undefined, expected)");
        expect(modal).toContain("persistWorkspaceAssetChanges(expected)");
        expect(modal).toContain("if (!userScopeMatches(expected)) return");
        expect(modal).toContain("isUserScopeAbandonedError");
    });
});
