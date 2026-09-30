import { describe, expect, test } from "bun:test";

import { createDirectorCameraFromPreset, DIRECTOR_CAMERA_PRESETS } from "@/lib/canvas/director/director-camera-presets";

describe("导演台机位预设", () => {
    test("面板提供 LibTV 的全部机位入口且名称不重复", () => {
        expect(DIRECTOR_CAMERA_PRESETS.map((item) => item.label)).toEqual([
            "当前视角", "正面中景", "正面特写", "正面全景", "侧面跟拍", "侧面近景", "背面中景", "俯拍全景",
            "45° 俯拍", "低角度仰拍", "低角度广角", "过肩镜头", "过肩镜头（右）", "鸟瞰", "荷兰角",
        ]);
    });

    test("预设写入不同的实际机位和光学参数", () => {
        const medium = createDirectorCameraFromPreset({ presetId: "front-medium", name: "测试", target: [1, 1, 2] });
        const close = createDirectorCameraFromPreset({ presetId: "front-close", name: "测试", target: [1, 1, 2] });
        expect(medium.transform.position).not.toEqual(close.transform.position);
        expect(medium.fov).not.toBe(close.fov);
        expect(medium.target).toEqual([1, 1, 2]);
        expect(close.target).toEqual([1, 1, 2]);
    });

    test("当前视角记录当前位置与朝向；鸟瞰和荷兰角均可安全取景", () => {
        const current = createDirectorCameraFromPreset({ presetId: "current", name: "当前", target: [0, 1, 0], currentView: { position: [3, 2, 4], rotation: [0, 0, 0], scale: [1, 1, 1] } });
        expect(current.transform.position).toEqual([3, 2, 4]);
        expect(current.target).toEqual([3, 2, -1]);
        const birdEye = createDirectorCameraFromPreset({ presetId: "bird-eye", name: "鸟瞰", target: [0, 1, 0] });
        expect(birdEye.transform.position[1]).toBeGreaterThan(birdEye.target[1]);
        const dutch = createDirectorCameraFromPreset({ presetId: "dutch", name: "荷兰角", target: [0, 1, 0] });
        expect(dutch.transform.rotation[2]).not.toBe(0);
    });
});
