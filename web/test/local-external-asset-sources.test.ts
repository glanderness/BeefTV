import { describe, expect, test } from "bun:test";

import { createLocalExternalAssetSourceState } from "@/hooks/use-external-asset-sources";

describe("local external asset sources", () => {
    test("returns empty collections and rejects external import or upload in local workspaces", async () => {
        const state = createLocalExternalAssetSourceState();
        expect(state.items).toEqual([]);
        expect(state.folders).toEqual([]);
        expect(state.categoryLabels).toEqual({});
        expect(state.loading).toBe(false);
        expect(state.error).toBe("");

        await expect(
            state.importExternalAsset({
                sourceId: "plugin:cloud",
                sourceName: "Cloud Drive",
                item: { id: "ext-1", kind: "image", title: "Demo", url: "https://example.com/a.png" },
            } as never),
        ).rejects.toThrow("本地工作区仅支持本地素材");

        await expect(
            state.uploadExternalFiles([new File(["img"], "demo.png", { type: "image/png" })]),
        ).rejects.toThrow("本地工作区仅支持本地素材");
    });
});
