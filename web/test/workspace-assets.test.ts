import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { http } from "@/services/api/request";
import { lookupWorkspaceAssetsByIds } from "@/services/api/workspace-assets";

describe("lookupWorkspaceAssetsByIds coalescing", () => {
    const spies: Array<{ mockRestore: () => void }> = [];

    afterEach(() => {
        while (spies.length) spies.pop()?.mockRestore();
    });

    test("returns empty without HTTP when ids are empty or blank", async () => {
        const postSpy = spyOn(http, "post");
        spies.push(postSpy);
        await expect(lookupWorkspaceAssetsByIds([])).resolves.toEqual({ assets: [] });
        await expect(lookupWorkspaceAssetsByIds(["  ", ""])).resolves.toEqual({ assets: [] });
        expect(postSpy).not.toHaveBeenCalled();
    });

    test("coalesces 20 concurrent lookups into 1 deduplicated /assets/batch POST and routes results back per caller", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            const ids = (body as { ids: string[] }).ids;
            return {
                assets: ids.filter((id) => id !== "missing").map((id) => ({ id, title: `asset-${id}` })),
            };
        }) as typeof http.post);
        spies.push(postSpy);

        const calls = [
            ...Array.from({ length: 18 }, (_, i) => lookupWorkspaceAssetsByIds([`asset-${i % 10}`])),
            lookupWorkspaceAssetsByIds(["asset-1", "missing"]),
            lookupWorkspaceAssetsByIds(["asset-9", "asset-2"]),
        ];
        const results = await Promise.all(calls);

        expect(postSpy).toHaveBeenCalledTimes(1);
        const sentIds = (postSpy.mock.calls[0]?.[1] as { ids: string[] }).ids;
        expect(sentIds).toHaveLength(11);
        expect(results[0]).toEqual({ assets: [{ id: "asset-0", title: "asset-asset-0" }] });
        expect(results[18]).toEqual({ assets: [{ id: "asset-1", title: "asset-asset-1" }] });
        expect(results[19]).toEqual({
            assets: [
                { id: "asset-9", title: "asset-asset-9" },
                { id: "asset-2", title: "asset-asset-2" },
            ],
        });
    });

    test("aborts only the cancelled caller while sibling callers still succeed", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            const ids = (body as { ids: string[] }).ids;
            return { assets: ids.map((id) => ({ id })) };
        }) as typeof http.post);
        spies.push(postSpy);

        const abortController = new AbortController();
        const abortedPromise = lookupWorkspaceAssetsByIds(["a1"], { signal: abortController.signal });
        const alivePromise = lookupWorkspaceAssetsByIds(["a2"]);
        abortController.abort();

        await expect(abortedPromise).rejects.toMatchObject({ name: "AbortError" });
        await expect(alivePromise).resolves.toEqual({ assets: [{ id: "a2" }] });
        expect(postSpy).toHaveBeenCalledTimes(1);
        expect((postSpy.mock.calls[0]?.[1] as { ids: string[] }).ids).toEqual(["a2"]);
    });

    test("cancels queued batch without firing HTTP when every caller aborts before flush", async () => {
        const postSpy = spyOn(http, "post");
        spies.push(postSpy);
        const controller = new AbortController();
        const p1 = lookupWorkspaceAssetsByIds(["x1"], { signal: controller.signal });
        const p2 = lookupWorkspaceAssetsByIds(["x2"], { signal: controller.signal });
        controller.abort();

        await expect(p1).rejects.toMatchObject({ name: "AbortError" });
        await expect(p2).rejects.toMatchObject({ name: "AbortError" });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(postSpy).not.toHaveBeenCalled();
    });

    test("chunks merged batches at 100 ids per HTTP request", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            const ids = (body as { ids: string[] }).ids;
            return { assets: ids.map((id) => ({ id })) };
        }) as typeof http.post);
        spies.push(postSpy);

        const results = await Promise.all([
            lookupWorkspaceAssetsByIds(Array.from({ length: 60 }, (_, i) => `id-${i}`)),
            lookupWorkspaceAssetsByIds(Array.from({ length: 60 }, (_, i) => `id-${i + 50}`)),
        ]);

        expect(postSpy).toHaveBeenCalledTimes(2);
        expect((postSpy.mock.calls[0]?.[1] as { ids: string[] }).ids).toHaveLength(100);
        expect((postSpy.mock.calls[1]?.[1] as { ids: string[] }).ids).toHaveLength(10);
        expect(results[0].assets).toHaveLength(60);
        expect(results[1].assets).toHaveLength(60);
    });

    test("isolates chunk failures so callers whose IDs succeeded still resolve", async () => {
        let callIndex = 0;
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            callIndex += 1;
            const ids = (body as { ids: string[] }).ids;
            if (callIndex === 2) {
                throw new Error("chunk-2-boom");
            }
            return { assets: ids.map((id) => ({ id })) };
        }) as typeof http.post);
        spies.push(postSpy);

        const caller1 = lookupWorkspaceAssetsByIds(Array.from({ length: 60 }, (_, i) => `ok-${i}`));
        const caller2 = lookupWorkspaceAssetsByIds(Array.from({ length: 60 }, (_, i) => `bad-${i}`));

        const res1 = await caller1;
        expect(res1.assets).toHaveLength(60);
        await expect(caller2).rejects.toThrow("chunk-2-boom");
        expect(postSpy).toHaveBeenCalledTimes(2);
    });

    test("auto-chunks a single caller passing >100 IDs into <=100-id requests", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            const ids = (body as { ids: string[] }).ids;
            return { assets: ids.map((id) => ({ id })) };
        }) as typeof http.post);
        spies.push(postSpy);

        const res = await lookupWorkspaceAssetsByIds(Array.from({ length: 120 }, (_, i) => `single-${i}`));
        expect(postSpy).toHaveBeenCalledTimes(2);
        expect((postSpy.mock.calls[0]?.[1] as { ids: string[] }).ids).toHaveLength(100);
        expect((postSpy.mock.calls[1]?.[1] as { ids: string[] }).ids).toHaveLength(20);
        expect(res.assets).toHaveLength(120);
    });

    test("rejects cleanly on malformed non-array assets response instead of hanging", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async () => ({ assets: {} })) as unknown as typeof http.post);
        spies.push(postSpy);

        await expect(lookupWorkspaceAssetsByIds(["malformed-1"])).rejects.toThrow("Invalid /assets/batch response");
    });

    test("rejects cleanly when http.post throws synchronously", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((() => {
            throw new Error("sync-post-boom");
        }) as unknown as typeof http.post);
        spies.push(postSpy);

        await expect(lookupWorkspaceAssetsByIds(["sync-1"])).rejects.toThrow("sync-post-boom");
    });
});
