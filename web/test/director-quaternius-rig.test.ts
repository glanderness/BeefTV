import { expect, test } from "bun:test";
import { Bone, Group, Quaternion } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { readFileSync } from "node:fs";

import { inferDirectorRig, resolveDirectorActorPoseDeltas, resolveDirectorActorVisualUrl } from "../src/components/canvas/director/director-viewport";
import { createDirectorActor } from "../src/lib/canvas/director/director-scene";
import { DIRECTOR_QUATERNIUS_FEMALE_URL, DIRECTOR_QUATERNIUS_MALE_URL } from "../src/lib/canvas/director/director-actor-assets";

test("Quaternius 的下划线骨骼名称能映射到导演台四肢控制", () => {
    const root = new Group();
    for (const name of [
        "root", "pelvis", "spine_01", "spine_02", "neck_01", "Head",
        "upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r",
        "thigh_l", "calf_l", "foot_l", "thigh_r", "calf_r", "foot_r",
    ]) {
        const bone = new Bone();
        bone.name = name;
        root.add(bone);
    }
    const rig = inferDirectorRig(root, []);
    expect(rig.status).toBe("ready");
    expect(rig.boneMap.leftUpperArm).toBe("upperarm_l");
    expect(rig.boneMap.rightUpperArm).toBe("upperarm_r");
    expect(rig.boneMap.leftLowerArm).toBe("lowerarm_l");
    expect(rig.boneMap.rightLowerArm).toBe("lowerarm_r");
    expect(rig.boneMap.leftUpperLeg).toBe("thigh_l");
    expect(rig.boneMap.rightUpperLeg).toBe("thigh_r");
    expect(rig.boneMap.leftFoot).toBe("foot_l");
    expect(rig.boneMap.rightFoot).toBe("foot_r");
});

test("旧场景无 URL 人体演员显示内置模型，几何模型和显式 URL 保持原样", () => {
    const oldMale = { ...createDirectorActor(), url: undefined };
    expect(resolveDirectorActorVisualUrl(oldMale)).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
    expect(resolveDirectorActorVisualUrl({ ...oldMale, actorPreset: "standard_female" })).toBe(DIRECTOR_QUATERNIUS_FEMALE_URL);
    expect(resolveDirectorActorVisualUrl({ ...oldMale, actorPreset: "slim" })).toBe(DIRECTOR_QUATERNIUS_MALE_URL);
    expect(resolveDirectorActorVisualUrl({ ...oldMale, actorPreset: "geometric" })).toBeNull();
    expect(resolveDirectorActorVisualUrl({ ...oldMale, url: "/my-own-actor.glb" })).toBe("/my-own-actor.glb");
});

test("Quaternius 的站立姿势镜像左上臂局部旋转，旧演员保持原逻辑", () => {
    const original = { ...createDirectorActor(), url: "/my-own-actor.glb" };
    const model = { ...original, url: "/canvas/models/quaternius-standard-male.glb" };
    const standard = resolveDirectorActorPoseDeltas(original);
    const adapted = resolveDirectorActorPoseDeltas(model);
    expect(adapted.leftUpperArm).toEqual(new Quaternion(...standard.leftUpperArm!).invert().toArray());
    expect(adapted.rightUpperArm).toEqual(standard.rightUpperArm);
    expect(adapted.leftUpperArm).not.toEqual(standard.leftUpperArm);
});

for (const body of ["male", "female"] as const) test(`实际 Quaternius ${body} 网格的站立姿势使两只手都低于肩`, async () => {
    const source = readFileSync(new URL(`../public/canvas/models/quaternius-standard-${body}.glb`, import.meta.url));
    const parsed = await new Promise<{ scene: Group }>((resolve, reject) => {
        new GLTFLoader().parse(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), "", resolve, reject);
    });
    const root = parsed.scene;
    const pose = resolveDirectorActorPoseDeltas({ ...createDirectorActor(), url: body === "male" ? DIRECTOR_QUATERNIUS_MALE_URL : DIRECTOR_QUATERNIUS_FEMALE_URL });
    for (const [side, delta] of [["l", pose.leftUpperArm], ["r", pose.rightUpperArm]] as const) {
        const shoulder = root.getObjectByName(`upperarm_${side}`)!;
        const hand = root.getObjectByName(`hand_${side}`)!;
        shoulder.quaternion.multiply(new Quaternion(...delta!));
        root.updateMatrixWorld(true);
        expect(hand.getWorldPosition(new Bone().position).y).toBeLessThan(shoulder.getWorldPosition(new Bone().position).y);
    }
});
