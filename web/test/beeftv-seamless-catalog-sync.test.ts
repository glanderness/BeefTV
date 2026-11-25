import { describe, expect, test } from "bun:test";

import { shouldSyncManagedBeefTVRevision } from "../src/components/layout/beeftv-connection-provider";
import { createModelConfigRepository, isApplyingExternalModelConfig, withoutModelConfigAutosave } from "../src/services/model-config-repository";
import { defaultConfig } from "../src/stores/use-config-store";

describe("seamless BeefTV catalog hot-reload rules", () => {
    test("startup race: already connected UI reloads as soon as catalogConfigRevision advances beyond initial hydration", () => {
        // Disk hydration loaded file revision 5 (catalogConfigRevision=5).
        expect(shouldSyncManagedBeefTVRevision(undefined, { state: "connected", catalogConfigRevision: 5 }, null, 5)).toBe(false);
        // Startup sync finishes 1 second later and bumps catalogConfigRevision 5 -> 6 while state stays "connected".
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogConfigRevision: 6 }, 5, 5)).toBe(true);
        // Subsequent polls with catalogConfigRevision 6 do not re-fetch.
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogConfigRevision: 6 }, 6, 5)).toBe(false);
    });

    test("startup race: if backend sync finished between hydration (rev 5) and first connection poll (configRev 6), first poll immediately syncs", () => {
        expect(shouldSyncManagedBeefTVRevision(undefined, { state: "connected", catalogConfigRevision: 6 }, null, 5)).toBe(true);
    });

    test("unrelated user PUT bumping local-model-config revision never masks a background catalog update", () => {
        // Initial hydration was file revision 5 (applied catalogConfigRevision=5).
        // Background sync wrote catalogConfigRevision=6, then user edited settings to file rev 10.
        // Because appliedCatalogRevision tracks only catalog writes (5), 6 > 5 still triggers reload!
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogConfigRevision: 6 }, 5, 10)).toBe(true);
    });

    test("legacy disk state without catalogConfigRevision (0) still reloads once first sync writes revision > initial", () => {
        expect(shouldSyncManagedBeefTVRevision(undefined, { state: "connected", catalogConfigRevision: 0 }, null, 5)).toBe(false);
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogConfigRevision: 6 }, 5, 5)).toBe(true);
    });

    test("manual refresh-all noting server.revision stays in the same revision space and never blocks later catalog updates", () => {
        // After refreshAllModels merges server.revision=21, the next catalog write advances to 22 (> 21).
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogConfigRevision: 21 }, 21, 20)).toBe(false);
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogConfigRevision: 22 }, 21, 20)).toBe(true);
    });

    test("disconnecting from connected still triggers managed channel cleanup", () => {
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "disconnected", catalogConfigRevision: 7 }, 6, 5)).toBe(true);
    });

    test("acceptExternalSnapshot advances repository revision silently without marking dirty or triggering PUT writeback", async () => {
        let writes = 0;
        const repo = createModelConfigRepository({
            read: async () => ({ config: defaultConfig, revision: 5, health: "ready", source: "builtin+local" }),
            write: async () => {
                writes += 1;
                return { saved: true, revision: 6 };
            },
        });
        await repo.hydrate();
        expect(repo.getState()).toMatchObject({ revision: 5, dirty: false });

        const updatedConfig = { ...defaultConfig, imageModel: "beeftv::gpt-image-2.5" };
        let insideGuard = false;
        withoutModelConfigAutosave(() => {
            insideGuard = isApplyingExternalModelConfig();
            repo.acceptExternalSnapshot(updatedConfig, 6);
        });

        expect(insideGuard).toBe(true);
        expect(isApplyingExternalModelConfig()).toBe(false);
        expect(writes).toBe(0);
        expect(repo.getState()).toMatchObject({ revision: 6, dirty: false });
        expect(repo.getCanonicalConfig()?.imageModel).toBe("beeftv::gpt-image-2.5");
    });
});
