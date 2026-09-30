import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorSequencer } from "../src/components/canvas/director/director-sequencer";
import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";

describe("导演台时间轴窄窗口布局", () => {
    test("保留用户设置的高度，但不超过视口高度的三分之一", () => {
        const scene = createDirectorReproScene();
        const shot = scene.shots.find((item) => item.id === scene.activeShotId)!;
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera: scene.cameras.find((item) => item.id === shot.cameraId) || null,
            objects: scene.objects, selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height: 300, visible: true,
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {},
            onHeightChange: () => {}, onVisibilityChange: () => {}, onSelectObject: () => {}, onSelectBone: () => {},
            onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));
        expect(html).toContain("height:300px");
        expect(html).toContain("max-height:32vh");
    });
});
