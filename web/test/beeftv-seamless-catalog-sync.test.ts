import { describe, expect, test } from "bun:test";

import { shouldSyncManagedBeefTVRevision } from "../src/components/layout/beeftv-connection-provider";
import { createModelConfigRepository, isApplyingExternalModelConfig, withoutModelConfigAutosave } from "../src/services/model-config-repository";
import { defaultConfig } from "../src/stores/use-config-store";

describe("seamless BeefTV catalog hot-reload rules", () => {
    test("startup race: already connected UI reloads as soon as catalogRevision advances beyond initial observation", () => {
        // Disk hydration loaded file revision 5 (catalogRevision=1, catalogConfigRevision=5).
        expect(shouldSyncManagedBeefTVRevision(undefined, { state: "connected", catalogRevision: 1, catalogConfigRevision: 5 }, null, 5)).toBe(false);
        // Startup sync finishes 1 second later and bumps catalogRevision 1 -> 2 while state stays "connected".
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogRevision: 2, catalogConfigRevision: 6 }, 1, 5)).toBe(true);
        // Subsequent polls with catalogRevision 2 do not re-fetch.
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogRevision: 2, catalogConfigRevision: 6 }, 2, 5)).toBe(false);
    });

    test("startup race: if backend sync finished between hydration (rev 5) and first connection poll (configRev 6), first poll immediately syncs", () => {
        expect(shouldSyncManagedBeefTVRevision(undefined, { state: "connected", catalogRevision: 2, catalogConfigRevision: 6 }, null, 5)).toBe(true);
    });

    test("unrelated user PUT bumping local-model-config revision never masks a background catalog update", () => {
        // Suppose initial hydration was file revision 5, applied catalogRevision was 1.
        // Background sync wrote catalogRevision=2 (file rev 6), then before the next poll
        // user edited settings which committed file rev 7 (or even 10).
        // Because catalogRevision is catalog-only and independent of file revision, 2 > 1 still triggers reload!
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogRevision: 2, catalogConfigRevision: 6 }, 1, 10)).toBe(true);
    });

    test("legacy disk state without catalogVersion (0) still reloads once first sync writes version 1", () => {
        expect(shouldSyncManagedBeefTVRevision(undefined, { state: "connected", catalogRevision: 0, catalogConfigRevision: 0 }, null, 5)).toBe(false);
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "connected", catalogRevision: 1, catalogConfigRevision: 6 }, 0, 5)).toBe(true);
    });

    test("disconnecting from connected still triggers managed channel cleanup", () => {
        expect(shouldSyncManagedBeefTVRevision("connected", { state: "disconnected", catalogRevision: 3, catalogConfigRevision: 7 }, 2, 5)).toBe(true);
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
