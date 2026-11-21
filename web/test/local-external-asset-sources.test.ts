import { describe, expect, test } from "bun:test";

import { externalAssetSyncFailures, uploadGeneratedAssetToConfiguredSources } from "@/services/external-asset-sources";
import type { Asset } from "@/stores/use-asset-store";

describe("local external asset sources", () => {
    test("uploadGeneratedAssetToConfiguredSources never uploads generated assets and preserves historical sync records", async () => {
        const asset = {
            id: "asset-1",
            kind: "image",
            title: "镜头",
            coverUrl: "",
            tags: [],
            status: "confirmed",
            source: "生成任务",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            data: { dataUrl: "", width: 100, height: 100 },
            metadata: {
                externalSync: [
                    { sourceId: "legacy-cloud", sourceName: "Legacy", status: "failed", error: "offline", updatedAt: "2026-10-01T00:00:00.000Z" },
                ],
            },
        } as Asset;

        const result = await uploadGeneratedAssetToConfiguredSources(asset);
        expect(result.uploaded).toEqual([]);
        expect(result.failures).toEqual([]);
        expect(result.records).toHaveLength(1);
        expect(externalAssetSyncFailures(asset)).toHaveLength(1);
    });
});
