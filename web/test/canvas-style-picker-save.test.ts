import { describe, expect, test } from "bun:test";

import {
    saveLocalStyleProfileEntry,
    touchLocalStyleProfileUsed,
    type UserStyleProfile,
} from "@/components/canvas/canvas-style-picker-modal";
import { createStyleProfileSnapshot, parseStyleProfile } from "@/lib/canvas/style-profile";
import { canvasStylePresets } from "@/lib/canvas/canvas-style-catalog";

describe("local style picker save and apply", () => {
    const baseSnapshot = createStyleProfileSnapshot(canvasStylePresets[0]);

    test("saving and immediately applying a new style keeps the newly created style and marks lastUsedAt", () => {
        const existing: UserStyleProfile[] = [];
        const saved = saveLocalStyleProfileEntry(existing, {
            id: "style-new-1",
            profile: { ...baseSnapshot, title: "赛博雨夜", description: "霓虹冷色调" },
            now: "2026-11-21T06:00:00.000Z",
            apply: true,
        });
        const afterApply = touchLocalStyleProfileUsed(saved.profiles, saved.entity.id, "2026-11-21T06:00:01.000Z");

        expect(afterApply).toHaveLength(1);
        expect(afterApply[0]?.id).toBe("style-new-1");
        expect(afterApply[0]?.name).toBe("赛博雨夜");
        expect(afterApply[0]?.description).toBe("霓虹冷色调");
        expect(afterApply[0]?.lastUsedAt).toBe("2026-11-21T06:00:01.000Z");
        expect(parseStyleProfile(afterApply[0]?.profileJson)?.title).toBe("赛博雨夜");
    });

    test("editing and immediately applying an existing style preserves the edited fields without reverting", () => {
        const initial = saveLocalStyleProfileEntry([], {
            id: "style-edit-1",
            profile: { ...baseSnapshot, title: "初版画风", description: "旧描述" },
            now: "2026-11-20T01:00:00.000Z",
            apply: false,
        });
        const edited = saveLocalStyleProfileEntry(initial.profiles, {
            id: "style-edit-1",
            profile: { ...baseSnapshot, title: "修订版画风", description: "新描述" },
            now: "2026-11-21T06:10:00.000Z",
            apply: true,
        });
        const afterApply = touchLocalStyleProfileUsed(edited.profiles, edited.entity.id, "2026-11-21T06:10:01.000Z");

        expect(afterApply).toHaveLength(1);
        expect(afterApply[0]?.name).toBe("修订版画风");
        expect(afterApply[0]?.description).toBe("新描述");
        expect(afterApply[0]?.revision).toBe(2);
        expect(afterApply[0]?.createdAt).toBe("2026-11-20T01:00:00.000Z");
        expect(afterApply[0]?.lastUsedAt).toBe("2026-11-21T06:10:01.000Z");
        expect(parseStyleProfile(afterApply[0]?.profileJson)?.description).toBe("新描述");
    });
});
