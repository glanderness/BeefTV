import { describe, expect, test } from "bun:test";
import { Group } from "three";

import { suspendDirectorEditorOverlays } from "@/lib/canvas/director/director-editor-overlays";

describe("导演台编辑辅助层", () => {
    test("截帧期间仅隐藏 editor-only 图形，恢复原始可见性", () => {
        const scene = new Group();
        const content = new Group();
        const visibleAid = new Group();
        const hiddenAid = new Group();
        const transformGizmo = Object.assign(new Group(), { isTransformControls: true });
        visibleAid.userData.directorEditorOnly = true;
        hiddenAid.userData.directorEditorOnly = true;
        hiddenAid.visible = false;
        scene.add(content, visibleAid, hiddenAid, transformGizmo);
        const resume = suspendDirectorEditorOverlays(scene);
        expect(content.visible).toBe(true);
        expect(visibleAid.visible).toBe(false);
        expect(hiddenAid.visible).toBe(false);
        expect(transformGizmo.visible).toBe(false);
        resume();
        expect(content.visible).toBe(true);
        expect(visibleAid.visible).toBe(true);
        expect(hiddenAid.visible).toBe(false);
        expect(transformGizmo.visible).toBe(true);
    });
});
