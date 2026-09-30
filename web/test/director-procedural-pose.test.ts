import { describe, expect, test } from "bun:test";

import { DIRECTOR_PROCEDURAL_ACTOR_BONES, DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES, resolveDirectorProceduralActorPose } from "../src/lib/canvas/director/director-procedural-pose";

function distance(left: [number, number, number], right: [number, number, number]) {
    return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

describe("离线程序角色姿态", () => {
    test("20 个姿势数据能驱动人偶关节位置，而不是只改变检查器标签", () => {
        const stand = resolveDirectorProceduralActorPose("stand");
        const wave = resolveDirectorProceduralActorPose("wave");

        expect(distance(stand.joints.rightHand, wave.joints.rightHand)).toBeGreaterThan(0.25);
        expect(wave.joints.leftHand).toEqual(stand.joints.leftHand);
        expect(DIRECTOR_PROCEDURAL_ACTOR_BONES).toContain("head");
        expect(DIRECTOR_PROCEDURAL_ACTOR_BONES).toContain("leftUpperArm");
    });

    test("局部骨骼覆盖沿层级传递到末端关节", () => {
        const stand = resolveDirectorProceduralActorPose("stand");
        const rotated = resolveDirectorProceduralActorPose("stand", { leftUpperArm: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });

        expect(distance(stand.joints.leftHand, rotated.joints.leftHand)).toBeGreaterThan(0.15);
        expect(distance(stand.joints.rightHand, rotated.joints.rightHand)).toBeLessThan(0.001);
    });

    test("选中人偶的骨架拓扑覆盖躯干、双臂和双腿，且每条边都连接有效关节", () => {
        const joints = resolveDirectorProceduralActorPose("stand").joints;
        const edges = DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES;

        expect(edges).toContainEqual(["spine", "chest"]);
        expect(edges).toContainEqual(["leftUpperArm", "leftLowerArm"]);
        expect(edges).toContainEqual(["rightUpperArm", "rightLowerArm"]);
        expect(edges).toContainEqual(["leftUpperLeg", "leftLowerLeg"]);
        expect(edges).toContainEqual(["rightUpperLeg", "rightLowerLeg"]);
        expect(edges.length).toBeGreaterThanOrEqual(18);
        expect(edges.every(([from, to]) => Boolean(joints[from] && joints[to]))).toBe(true);
    });
});
