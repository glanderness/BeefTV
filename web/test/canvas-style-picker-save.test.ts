import { describe, expect, test } from "bun:test";

import {
    createLocalStyleProfileStore,
    LOCAL_STYLE_PROFILES_KEY,
    readLocalStyleProfiles,
} from "@/lib/canvas/local-style-profiles";
import { createStyleProfileSnapshot, parseStyleProfile } from "@/lib/canvas/style-profile";
import { canvasStylePresets } from "@/lib/canvas/canvas-style-catalog";

function createMemoryStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, value);
        },
    };
}

describe("local style profile store save and apply", () => {
    const baseSnapshot = createStyleProfileSnapshot(canvasStylePresets[0]);

    test("saving and immediately applying a new style persists both the profile and lastUsedAt without a stale snapshot", () => {
        const storage = createMemoryStorage();
        const store = createLocalStyleProfileStore(storage);

        // Mirrors saveMutation.mutationFn -> saveMutation.onSuccess -> selectItem -> markUsed
        // within the same tick before React re-renders.
        const saved = store.save({
            id: "style-new-1",
            profile: { ...baseSnapshot, title: "赛博雨夜", description: "霓虹冷色调" },
            now: "2026-11-21T06:00:00.000Z",
            apply: true,
        });
        const afterApply = store.markUsed(saved.entity.id, "2026-11-21T06:00:01.000Z");

        expect(afterApply).toHaveLength(1);
        expect(afterApply[0]?.id).toBe("style-new-1");
        expect(afterApply[0]?.name).toBe("赛博雨夜");
        expect(afterApply[0]?.lastUsedAt).toBe("2026-11-21T06:00:01.000Z");

        // Reopen/reload from persisted storage to ensure nothing was dropped.
        const reloaded = readLocalStyleProfiles(storage);
        expect(storage.getItem(LOCAL_STYLE_PROFILES_KEY)).toBeTruthy();
        expect(reloaded).toHaveLength(1);
        expect(reloaded[0]?.name).toBe("赛博雨夜");
        expect(reloaded[0]?.lastUsedAt).toBe("2026-11-21T06:00:01.000Z");
        expect(parseStyleProfile(reloaded[0]?.profileJson)?.description).toBe("霓虹冷色调");
    });

    test("editing and immediately applying an existing style keeps edited fields across storage reload", () => {
        const storage = createMemoryStorage();
        const store = createLocalStyleProfileStore(storage);

        store.save({
            id: "style-edit-1",
            profile: { ...baseSnapshot, title: "初版画风", description: "旧描述" },
            now: "2026-11-20T01:00:00.000Z",
            apply: false,
        });

        const edited = store.save({
            id: "style-edit-1",
            profile: { ...baseSnapshot, title: "修订版画风", description: "新描述" },
            now: "2026-11-21T06:10:00.000Z",
            apply: true,
        });
        store.markUsed(edited.entity.id, "2026-11-21T06:10:01.000Z");

        const reloaded = store.reload();
        expect(reloaded).toHaveLength(1);
        expect(reloaded[0]?.name).toBe("修订版画风");
        expect(reloaded[0]?.description).toBe("新描述");
        expect(reloaded[0]?.revision).toBe(2);
        expect(reloaded[0]?.createdAt).toBe("2026-11-20T01:00:00.000Z");
        expect(reloaded[0]?.lastUsedAt).toBe("2026-11-21T06:10:01.000Z");
        expect(parseStyleProfile(reloaded[0]?.profileJson)?.description).toBe("新描述");
    });

    test("tolerates a throwing localStorage getter without breaking store creation or save/apply", () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get() {
                throw new DOMException("blocked storage", "SecurityError");
            },
        });
        try {
            const store = createLocalStyleProfileStore();
            expect(store.getAll()).toEqual([]);
            const saved = store.save({
                id: "style-private-1",
                profile: { ...baseSnapshot, title: "隐私模式画风", description: "仅内存态" },
                now: "2026-11-21T06:20:00.000Z",
                apply: true,
            });
            const used = store.markUsed(saved.entity.id, "2026-11-21T06:20:01.000Z");
            expect(used).toHaveLength(1);
            expect(used[0]?.name).toBe("隐私模式画风");
            expect(used[0]?.lastUsedAt).toBe("2026-11-21T06:20:01.000Z");
        } finally {
            if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
            else delete (globalThis as { localStorage?: unknown }).localStorage;
        }
    });
});
