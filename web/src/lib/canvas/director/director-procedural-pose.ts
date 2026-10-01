import { Quaternion, Vector3 } from "three";

import { directorPoseBoneDeltas } from "@/lib/canvas/director/director-scene";
import type { DirectorActorShape } from "@/lib/canvas/director/director-actor-presets";
import type { DirectorHumanoidBone, DirectorPose, DirectorQuat, DirectorVec3 } from "@/types/director";

type JointDefinition = { bone: DirectorHumanoidBone; parent: DirectorHumanoidBone | null; offset: DirectorVec3 };

const JOINTS: JointDefinition[] = [
    { bone: "root", parent: null, offset: [0, 0, 0] },
    { bone: "hips", parent: "root", offset: [0, 0.78, 0] },
    { bone: "spine", parent: "hips", offset: [0, 0.22, 0] },
    { bone: "chest", parent: "spine", offset: [0, 0.16, 0] },
    { bone: "neck", parent: "chest", offset: [0, 0.24, 0] },
    { bone: "head", parent: "neck", offset: [0, 0.22, 0] },
    { bone: "leftShoulder", parent: "chest", offset: [-0.2, 0.08, 0] },
    { bone: "leftUpperArm", parent: "leftShoulder", offset: [-0.04, -0.02, 0] },
    { bone: "leftLowerArm", parent: "leftUpperArm", offset: [-0.07, -0.3, 0] },
    { bone: "leftHand", parent: "leftLowerArm", offset: [-0.02, -0.3, 0] },
    { bone: "rightShoulder", parent: "chest", offset: [0.2, 0.08, 0] },
    { bone: "rightUpperArm", parent: "rightShoulder", offset: [0.04, -0.02, 0] },
    { bone: "rightLowerArm", parent: "rightUpperArm", offset: [0.07, -0.3, 0] },
    { bone: "rightHand", parent: "rightLowerArm", offset: [0.02, -0.3, 0] },
    { bone: "leftUpperLeg", parent: "hips", offset: [-0.11, -0.02, 0] },
    { bone: "leftLowerLeg", parent: "leftUpperLeg", offset: [-0.03, -0.35, 0] },
    { bone: "leftFoot", parent: "leftLowerLeg", offset: [0, -0.35, 0.08] },
    { bone: "rightUpperLeg", parent: "hips", offset: [0.11, -0.02, 0] },
    { bone: "rightLowerLeg", parent: "rightUpperLeg", offset: [0.03, -0.35, 0] },
    { bone: "rightFoot", parent: "rightLowerLeg", offset: [0, -0.35, 0.08] },
];

export const DIRECTOR_PROCEDURAL_ACTOR_BONES = JOINTS.map(({ bone }) => bone);
/** Parent-child links shared by the lightweight mannequin's visible rig overlay. */
export const DIRECTOR_PROCEDURAL_ACTOR_SKELETON_EDGES = JOINTS.flatMap(({ bone, parent }) => parent ? [[parent, bone] as const] : []);

/** Evaluate the lightweight local mannequin from the same pose and bone-override data as imported rigs. */
export function resolveDirectorProceduralActorPose(pose: DirectorPose, overrides: Partial<Record<DirectorHumanoidBone, DirectorQuat>> = {}, shape?: DirectorActorShape) {
    const poseDeltas = { ...directorPoseBoneDeltas(pose) };
    // This mannequin's rest geometry already has naturally hanging arms. The external Soldier
    // rig's shared "stand" delta is designed to lower T-posed arms, so strip that baseline from
    // every pose before applying only pose-specific arm motion to this different rest geometry.
    const soldierStand = directorPoseBoneDeltas("stand");
    for (const bone of ["leftUpperArm", "rightUpperArm"] as const) {
        const poseRotation = poseDeltas[bone];
        const standRotation = soldierStand[bone];
        if (poseRotation && standRotation && poseRotation.every((value, index) => Math.abs(value - standRotation[index]) < 1e-6)) delete poseDeltas[bone];
    }
    const joints = {} as Record<DirectorHumanoidBone, DirectorVec3>;
    const rotations = {} as Record<DirectorHumanoidBone, DirectorQuat>;
    const worldRotations = {} as Record<DirectorHumanoidBone, Quaternion>;
    const identity: DirectorQuat = [0, 0, 0, 1];

    JOINTS.forEach(({ bone, parent, offset }) => {
        const rotation = overrides[bone] || poseDeltas[bone] || identity;
        const localRotation = new Quaternion(...rotation);
        const parentRotation = parent ? worldRotations[parent] : new Quaternion();
        const parentPosition = parent ? new Vector3(...joints[parent]) : new Vector3();
        const adjustedOffset = [...offset] as DirectorVec3;
        if (shape) {
            if (bone === "hips") adjustedOffset[1] *= shape.legLength;
            else if (bone === "spine" || bone === "chest" || bone === "neck" || bone === "head") adjustedOffset[1] *= shape.torsoLength;
            else if (bone.includes("Shoulder") || bone.includes("Arm") || bone.includes("Hand")) {
                adjustedOffset[0] *= shape.armSpan;
                adjustedOffset[1] *= bone.includes("Shoulder") ? shape.torsoLength : shape.armLength;
            } else if (bone.includes("Leg") || bone.includes("Foot")) {
                adjustedOffset[0] *= shape.stance;
                adjustedOffset[1] *= shape.legLength;
                if (bone.includes("Foot")) adjustedOffset[2] *= shape.footLength;
            }
        }
        const position = parentPosition.add(new Vector3(...adjustedOffset).applyQuaternion(parentRotation));
        const worldRotation = parentRotation.clone().multiply(localRotation);
        joints[bone] = position.toArray() as DirectorVec3;
        rotations[bone] = rotation;
        worldRotations[bone] = worldRotation;
    });

    return {
        joints,
        rotations,
        worldRotations: Object.fromEntries(Object.entries(worldRotations).map(([bone, rotation]) => [bone, rotation.toArray() as DirectorQuat])) as Record<DirectorHumanoidBone, DirectorQuat>,
    };
}
