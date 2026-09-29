import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createDirectorReproScene } from "../src/lib/canvas/director/director-repro-fixture";
import { DirectorCameraProperties } from "../src/components/canvas/director/director-camera-properties";
import { directorFovToFocalLength } from "../src/lib/canvas/director/director-scene";

describe("导演台摄影机属性", () => {
    test("FOV 编辑同步反算焦距，避免两个取景控件互相矛盾", () => {
        expect(directorFovToFocalLength(90)).toBeCloseTo(18, 6);
        expect(directorFovToFocalLength(50)).toBeCloseTo(38.6015, 3);
    });

    test("首屏呈现真实可编辑的摄影机字段，原镜头能力仍可展开", () => {
        const scene = createDirectorReproScene();
        const html = renderToStaticMarkup(createElement(DirectorCameraProperties, {
            camera: scene.cameras[0], cameras: scene.cameras, shot: scene.shots[0],
            objects: scene.objects, onUpdateCamera: () => {}, onSelectCamera: () => {}, onFollowObject: () => {}, children: createElement("span", null, "镜头参数仍在"),
        }));
        expect(html).toContain("名称");
        expect(html).toContain("切换机位");
        expect(html).toContain("位置");
        expect(html).toContain("注视坐标");
        expect(html).toMatch(/>X<|>X<\/span>/);
        expect(html).toMatch(/>Y<|>Y<\/span>/);
        expect(html).toMatch(/>Z<|>Z<\/span>/);
        expect(html).toContain("视野角度 (FOV)");
        expect(html).toContain("跟随目标");
        expect(html).toContain("不跟随");
        expect(html).toContain("注视目标");
        expect(html).toContain("手动坐标");
        expect(html).toContain('min="15"');
        expect(html).toContain('max="90"');
        expect(html).toContain("镜头参数仍在");
    });

    test("手动旋转模式展示角度输入而不是坐标输入", () => {
        const scene = createDirectorReproScene();
        const html = renderToStaticMarkup(createElement(DirectorCameraProperties, {
            camera: { ...scene.cameras[0], lookAtMode: "rotation" }, cameras: scene.cameras, shot: scene.shots[0], objects: scene.objects,
            onUpdateCamera: () => {}, onSelectCamera: () => {}, onFollowObject: () => {}, children: null,
        }));
        expect(html).toContain("手动旋转");
        expect(html).toContain("旋转 X");
        expect(html).not.toContain("注视坐标 X");
    });
});
