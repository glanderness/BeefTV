import { describe, expect, test } from "bun:test";

import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { resolveDirectorCameraLocalFraming, resolveDirectorViewFraming } from "../src/lib/canvas/director/director-view-modes";
import { bindDirectorCameraFollow, removeDirectorCameraBindingsForObject } from "../src/lib/canvas/director/director-camera-binding";
import type { DirectorCamera, DirectorVec3 } from "../src/types/director";

const movedScene = () => {
    const scene = createDirectorReproScene();
    const object = scene.objects[0];
    return { ...scene, objects: [{ ...object, keyframes: [
        { id: "k0", time: 0, transform: object.transform },
        { id: "k2", time: 2, transform: { ...object.transform, position: [2, 0.5, 0] as DirectorVec3 } },
    ] }, ...scene.objects.slice(1)] };
};

describe("导演台摄影机跟随与注视", () => {
    test("绑定跟随后当前画面不跳变，角色移动时相机保留相对位置", () => {
        const scene = movedScene();
        const camera = bindDirectorCameraFollow(scene.cameras[0], scene, scene.objects[0].id, 0);
        const next = { ...scene, cameras: [camera] };
        expect(resolveDirectorViewFraming({ scene: next, mode: "camera", playhead: 0 })?.position).toEqual([4.8, 2.7, 6.8]);
        expect(resolveDirectorViewFraming({ scene: next, mode: "camera", playhead: 1 })?.position).toEqual([5.8, 2.7, 6.8]);
    });

    test("注视角色使用当前帧位置，镜头位置不受注视绑定影响", () => {
        const scene = movedScene();
        const camera = { ...scene.cameras[0], lookAtObjectId: scene.objects[0].id };
        const framing = resolveDirectorViewFraming({ scene: { ...scene, cameras: [camera] }, mode: "camera", playhead: 1 });
        expect(framing?.position).toEqual([4.8, 2.7, 6.8]);
        expect(framing?.target).toEqual([1, 0.5, 0]);
    });

    test("手动旋转改变视线方向；目标删除后跟随和注视安全回落", () => {
        const scene = createDirectorReproScene();
        const camera = { ...scene.cameras[0], transform: { ...scene.cameras[0].transform, position: [0, 1, 5] as DirectorVec3, rotation: [0, Math.PI / 2, 0] as DirectorVec3 }, lookAtMode: "rotation" as const };
        const rotation = resolveDirectorViewFraming({ scene: { ...scene, cameras: [camera] }, mode: "camera", playhead: 0 });
        expect(rotation?.target[0]).toBeCloseTo(-1, 5);
        expect(rotation?.target[1]).toBeCloseTo(1, 5);
        expect(rotation?.target[2]).toBeCloseTo(5, 5);
        const deleted = { ...camera, lookAtMode: "object" as const, lookAtObjectId: "deleted", followObjectId: "deleted", followAnchor: [0, 0, 0] as DirectorVec3 };
        const fallback = resolveDirectorViewFraming({ scene: { ...scene, cameras: [deleted] }, mode: "camera", playhead: 0 });
        expect(fallback?.position).toEqual([0, 1, 5]);
        expect(fallback?.target).toEqual(camera.target);
    });

    test("删除被跟随或注视的对象时只清理对应绑定", () => {
        const scene = createDirectorReproScene();
        const camera: DirectorCamera = {
            ...scene.cameras[0],
            followObjectId: "target-a",
            followAnchor: [1, 2, 3],
            lookAtMode: "object",
            lookAtObjectId: "target-b",
        };
        const withoutFollow = removeDirectorCameraBindingsForObject(camera, "target-a");
        expect(withoutFollow).toEqual({ ...camera, followObjectId: undefined, followAnchor: undefined });
        const withoutLookAt = removeDirectorCameraBindingsForObject(withoutFollow, "target-b");
        expect(withoutLookAt).toEqual({ ...withoutFollow, lookAtMode: "coordinates", lookAtObjectId: undefined });
        expect(removeDirectorCameraBindingsForObject(camera, "other")).toBe(camera);
    });

    test("自由视角机位辅助图形与 CAM 共用当前帧取景，且能解算非活动机位", () => {
        const scene = movedScene();
        const first = bindDirectorCameraFollow(scene.cameras[0], scene, scene.objects[0].id, 0);
        const second: DirectorCamera = { ...first, id: "other-camera", transform: { ...first.transform, position: [0, 2, 8] } };
        const withCameras = { ...scene, cameras: [first, second] };
        expect(resolveDirectorCameraLocalFraming(withCameras, first, 1)?.position).toEqual([5.8, 2.7, 6.8]);
        expect(resolveDirectorCameraLocalFraming(withCameras, second, 1)?.position).toEqual([1, 2, 8]);
        expect(resolveDirectorCameraLocalFraming(withCameras, first, 1)?.target).toEqual(resolveDirectorViewFraming({ scene: withCameras, mode: "camera", playhead: 1 })?.target);
    });
});
