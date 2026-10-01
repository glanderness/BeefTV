import type { Object3D } from "three";

/** Editor aids are visible in the workbench, never in captured frames or video. */
export function suspendDirectorEditorOverlays(scene: Object3D): () => void {
    const previous: Array<{ object: Object3D; visible: boolean }> = [];
    scene.traverse((object) => {
        // drei mounts the TransformControls Object3D separately from its JSX group.
        // Its `isTransformControls` flag is therefore the reliable capture-time marker.
        if (object.userData.directorEditorOnly !== true && (object as Object3D & { isTransformControls?: boolean }).isTransformControls !== true) return;
        previous.push({ object, visible: object.visible });
        object.visible = false;
    });
    return () => {
        for (const item of previous) item.object.visible = item.visible;
    };
}
