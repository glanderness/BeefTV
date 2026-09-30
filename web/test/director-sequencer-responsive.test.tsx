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

    test("成片预演显示紧凑播放底栏与单条片段轨道，隐藏动画编辑工具", () => {
        const scene = createDirectorReproScene();
        const shot = scene.shots.find((item) => item.id === scene.activeShotId)!;
        const html = renderToStaticMarkup(createElement(DirectorSequencer, {
            scene, shot, camera: scene.cameras.find((item) => item.id === shot.cameraId) || null,
            objects: scene.objects, selectedObjectId: null, selectedBone: null,
            playhead: 0, playing: false, autoKey: false, height: 300, visible: true, presentation: "preview",
            onPlayToggle: () => {}, onPlayheadChange: () => {}, onAutoKeyChange: () => {},
            onHeightChange: () => {}, onVisibilityChange: () => {}, onSelectObject: () => {}, onSelectBone: () => {},
            onRecordKeyframe: () => {}, onAddShot: () => {}, onDeleteKeyframe: () => {}, onSetKeyframeEasing: () => {}, onSelectShot: () => {},
        }));

        expect(html).toContain("director-sequencer-preview-time");
        expect(html).toContain('aria-label="时间线缩放"');
        expect(html).toContain('aria-label="预演时间线"');
        expect(html).toContain('aria-label="新增镜头"');
        expect(html).not.toContain('title="自动关键帧"');
        expect(html).not.toContain('title="吸附到帧"');
        expect(html).not.toContain('title="记录当前关键帧"');
        expect(html).not.toContain('aria-label="显示子轨道"');
        expect(html).not.toContain('class="director-sequencer-resizer"');
    });
});
