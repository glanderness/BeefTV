import { describe, expect, test } from "bun:test";

import { createDirectorActorCrowd, createDirectorActorPreset, DIRECTOR_ACTOR_PRESET_OPTIONS, resolveDirectorCapsuleShape } from "../src/lib/canvas/director/director-actor-presets";

describe("导演台角色预设", () => {
    test("exposes the same named built-in actor choices as the reference panel", () => {
        expect(DIRECTOR_ACTOR_PRESET_OPTIONS.map((option) => option.label)).toEqual([
            "标准男性",
            "标准女性",
            "健硕",
            "纤细",
            "少年",
            "儿童",
            "宽厚",
            "二头身",
            "几何模型",
        ]);
    });

    test("creates a renderable actor preset without a remote model asset", () => {
        const actor = createDirectorActorPreset("standard_female", "标准女性 1");

        expect(actor).toMatchObject({ kind: "actor", actorPreset: "standard_female", name: "标准女性 1", color: "#2f7de1", visible: true, pose: "stand" });
        expect(actor.url).toBeUndefined();
        expect(actor.storageKey).toBeUndefined();
        expect(actor.assetId).toBeUndefined();
        expect(actor.rig).toEqual({ status: "unmapped", boneMap: {}, animationNames: [] });
    });

    test("builds one named 3-by-3 crowd with nine distinct offline actors", () => {
        const crowd = createDirectorActorCrowd();

        expect(crowd).toHaveLength(9);
        expect(new Set(crowd.map((actor) => actor.id)).size).toBe(9);
        expect(crowd.map((actor) => actor.name)).toEqual([
            "群众 1-1", "群众 1-2", "群众 1-3", "群众 1-4", "群众 1-5",
            "群众 1-6", "群众 1-7", "群众 1-8", "群众 1-9",
        ]);
        expect(crowd.every((actor) => actor.kind === "actor" && actor.actorPreset === "standard_male" && actor.color === "#2f7de1" && !actor.url)).toBe(true);
    });

    test("builds a centered crowd using the requested row, column, and spacing values", () => {
        const crowd = createDirectorActorCrowd(2, 2, 3, 2);

        expect(crowd).toHaveLength(6);
        expect(crowd.map((actor) => actor.transform.position)).toEqual([
            [-2, 0, -1], [0, 0, -1], [2, 0, -1],
            [-2, 0, 1], [0, 0, 1], [2, 0, 1],
        ]);
        expect(crowd.map((actor) => actor.name)).toEqual([
            "群众 2-1", "群众 2-2", "群众 2-3", "群众 2-4", "群众 2-5", "群众 2-6",
        ]);
    });

    test("fits rounded limb caps inside both short and long skeleton segments", () => {
        const shortSegment = resolveDirectorCapsuleShape(0.16, 0.09);
        const longSegment = resolveDirectorCapsuleShape(0.35, 0.09);

        expect(shortSegment.radius).toBe(0.08);
        expect(shortSegment.cylinderHeight).toBe(0);
        expect(shortSegment.cylinderHeight + 2 * shortSegment.radius).toBeCloseTo(0.16);
        expect(longSegment.radius).toBe(0.09);
        expect(longSegment.cylinderHeight + 2 * longSegment.radius).toBeCloseTo(0.35);
    });
});
