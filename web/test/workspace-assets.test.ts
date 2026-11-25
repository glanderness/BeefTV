import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { http } from "@/services/api/request";
import { lookupWorkspaceAssetsByIds } from "@/services/api/workspace-assets";

describe("lookupWorkspaceAssetsByIds", () => {
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

    test("deduplicates trimmed ids and forwards request config including AbortSignal directly", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            const ids = (body as { ids: string[] }).ids;
            return { assets: ids.map((id) => ({ id })) };
        }) as typeof http.post);
        spies.push(postSpy);

        const controller = new AbortController();
        const res = await lookupWorkspaceAssetsByIds([" a1 ", "a2", "a1", ""], { signal: controller.signal });

        expect(postSpy).toHaveBeenCalledTimes(1);
        expect(postSpy.mock.calls[0]?.[0]).toBe("/assets/batch");
        expect(postSpy.mock.calls[0]?.[1]).toEqual({ ids: ["a1", "a2"] });
        expect(postSpy.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });
        expect(res).toEqual({ assets: [{ id: "a1" }, { id: "a2" }] });
    });

    test("chunks requests with >100 unique ids into <=100-id requests", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((async (_url: string, body: unknown) => {
            const ids = (body as { ids: string[] }).ids;
            return { assets: ids.map((id) => ({ id })) };
        }) as typeof http.post);
        spies.push(postSpy);

        const controller = new AbortController();
        const res = await lookupWorkspaceAssetsByIds(
            Array.from({ length: 120 }, (_, i) => `single-${i}`),
            { signal: controller.signal },
        );
        expect(postSpy).toHaveBeenCalledTimes(2);
        expect((postSpy.mock.calls[0]?.[1] as { ids: string[] }).ids).toHaveLength(100);
        expect((postSpy.mock.calls[1]?.[1] as { ids: string[] }).ids).toHaveLength(20);
        expect(postSpy.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });
        expect(postSpy.mock.calls[1]?.[2]).toEqual({ signal: controller.signal });
        expect(res.assets).toHaveLength(120);
    });

    test("propagates errors thrown by http.post", async () => {
        const postSpy = spyOn(http, "post").mockImplementation((() => {
            throw new Error("post-boom");
        }) as unknown as typeof http.post);
        spies.push(postSpy);

        await expect(lookupWorkspaceAssetsByIds(["sync-1"])).rejects.toThrow("post-boom");
    });
});
