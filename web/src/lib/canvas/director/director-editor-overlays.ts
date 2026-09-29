import type { Object3D } from "three";

/** Editor aids are visible in the workbench, never in captured frames or video. */
export function suspendDirectorEditorOverlays(scene: Object3D): () => void {
    const previous: Array<{ object: Object3D; visible: boolean }> = [];
    scene.traverse((object) => {
        if (object.userData.directorEditorOnly !== true) return;
        previous.push({ object, visible: object.visible });
        object.visible = false;
    });
    return () => {
        for (const item of previous) item.object.visible = item.visible;
    };
}
