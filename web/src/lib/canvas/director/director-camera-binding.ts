import { interpolateDirectorTransform } from "@/lib/canvas/director/director-scene";
import type { DirectorCamera, DirectorScene } from "@/types/director";

/** 选中角色的当前帧作为锚点；绑定瞬间相机不跳动，随后叠加角色位移。 */
export function bindDirectorCameraFollow(camera: DirectorCamera, scene: DirectorScene, objectId: string, time: number): DirectorCamera {
    const object = scene.objects.find((item) => item.id === objectId);
    if (!object) return camera;
    const position = interpolateDirectorTransform(object.transform, object.keyframes, Number.isFinite(time) ? time : 0).position;
    if (!position.every(Number.isFinite)) return camera;
    return { ...camera, followObjectId: objectId, followAnchor: [...position] };
}

/** 删除对象时清除悬空引用，其他机位属性与绑定保持不变。 */
export function removeDirectorCameraBindingsForObject(camera: DirectorCamera, objectId: string): DirectorCamera {
    const followsObject = camera.followObjectId === objectId;
    const looksAtObject = camera.lookAtObjectId === objectId;
    if (!followsObject && !looksAtObject) return camera;
    return {
        ...camera,
        ...(followsObject ? { followObjectId: undefined, followAnchor: undefined } : {}),
        ...(looksAtObject ? { lookAtMode: "coordinates" as const, lookAtObjectId: undefined } : {}),
    };
}
