import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorCameraProperties } from "@/components/canvas/director/director-camera-properties";
import { createDirectorScene } from "@/lib/canvas/director/director-scene";

describe("导演台摄影机属性预览", () => {
    test("属性区先展示当前机位的 16:9 预览和 FOV", () => {
        const scene = createDirectorScene();
        const html = renderToStaticMarkup(createElement(DirectorCameraProperties, {
            camera: scene.cameras[0],
            cameras: scene.cameras,
            shot: scene.shots[0],
            objects: scene.objects,
            onUpdateCamera: () => {},
            onSelectCamera: () => {},
            onFollowObject: () => {},
            children: createElement("span", null, "镜头高级参数"),
        }));

        expect(html).toContain('aria-label="摄影机预览"');
        expect(html).toContain("FOV 50°");
        expect(html).toContain('aria-label="放大摄影机预览"');
    });
});
