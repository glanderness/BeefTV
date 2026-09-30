import { createDirectorObject, DIRECTOR_ACTOR_COLORS } from "@/lib/canvas/director/director-scene";
import type { DirectorActorPresetId, DirectorObject, DirectorVec3 } from "@/types/director";

export const DIRECTOR_ACTOR_PRESET_OPTIONS: ReadonlyArray<{ id: DirectorActorPresetId; label: string }> = [
    { id: "standard_male", label: "标准男性" },
    { id: "standard_female", label: "标准女性" },
    { id: "athletic", label: "健硕" },
    { id: "slim", label: "纤细" },
    { id: "teen", label: "少年" },
    { id: "child", label: "儿童" },
    { id: "broad", label: "宽厚" },
    { id: "chibi", label: "二头身" },
    { id: "geometric", label: "几何模型" },
];

export const DIRECTOR_ACTOR_CROWD_LABEL = "群众 (3x3)";

const LABEL_BY_PRESET = Object.fromEntries(DIRECTOR_ACTOR_PRESET_OPTIONS.map(({ id, label }) => [id, label])) as Record<DirectorActorPresetId, string>;

/** Keep rounded capsule limbs inside their skeleton endpoints, including short neck/forearm segments. */
export function resolveDirectorCapsuleShape(length: number, desiredRadius: number): { radius: number; cylinderHeight: number } {
    const radius = Math.min(Math.max(0, desiredRadius), Math.max(0, length) / 2);
    return { radius, cylinderHeight: Math.max(0, length - radius * 2) };
}

/** Creates a locally-rendered actor preset; unlike the generic production actor, it carries no remote GLB URL. */
export function createDirectorActorPreset(preset: DirectorActorPresetId, name = LABEL_BY_PRESET[preset], position: DirectorVec3 = [0, 0, 0], color: string = DIRECTOR_ACTOR_COLORS[2]): DirectorObject {
    return {
        ...createDirectorObject("box", name, position, color),
        kind: "actor",
        primitive: undefined,
        pose: "stand",
        actorPreset: preset,
        rig: { status: "unmapped", boneMap: {}, animationNames: [] },
        motionClips: [],
        boneOverrides: {},
        boneTracks: [],
    };
}

/** 3x3 crowd option is one logical creation action with nine distinct actor records. */
export function createDirectorActorCrowd(group = 1, rows = 3, columns = 3, spacing = 1.2): DirectorObject[] {
    const safeRows = Math.max(1, Math.min(10, Math.round(rows)));
    const safeColumns = Math.max(1, Math.min(10, Math.round(columns)));
    const safeSpacing = Math.max(0.5, Math.min(5, spacing));
    return Array.from({ length: safeRows * safeColumns }, (_, index) => {
        const row = Math.floor(index / safeColumns);
        const column = index % safeColumns;
        const position: DirectorVec3 = [(column - (safeColumns - 1) / 2) * safeSpacing, 0, (row - (safeRows - 1) / 2) * safeSpacing];
        return createDirectorActorPreset("standard_male", `群众 ${group}-${index + 1}`, position);
    });
}
