import { describe, expect, test } from "bun:test";

import { DIRECTOR_ASPECT_RATIOS, isDirectorAspectRatio, resolveDirectorFrameRect, resolveDirectorPixelCrop } from "@/lib/canvas/director/director-aspect-ratio";

describe("导演台画幅取景与导出", () => {
    test("提供 LibTV 七个选项并拒绝损坏的持久化值", () => {
        expect(DIRECTOR_ASPECT_RATIOS).toEqual(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
        expect(isDirectorAspectRatio("9:16")).toBe(true);
        expect(isDirectorAspectRatio("0:0")).toBe(false);
    });

    test("自适应使用完整视口；竖幅预览与像素裁切都居中且比例一致", () => {
        expect(resolveDirectorFrameRect(1200, 800, "adaptive")).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
        const preview = resolveDirectorFrameRect(1200, 800, "9:16");
        const crop = resolveDirectorPixelCrop(1200, 800, "9:16");
        expect(preview.width / preview.height).toBeCloseTo(9 / 16);
        expect(crop.width / crop.height).toBeCloseTo(9 / 16, 2);
        expect(preview.x).toBeCloseTo((1200 - preview.width) / 2);
        expect(crop.y).toBeCloseTo((800 - crop.height) / 2, 0);
    });

    test("横幅和方幅均保持在视口内", () => {
        for (const ratio of ["21:9", "1:1", "3:4"] as const) {
            const frame = resolveDirectorFrameRect(900, 500, ratio);
            expect(frame.x).toBeGreaterThanOrEqual(0);
            expect(frame.y).toBeGreaterThanOrEqual(0);
            expect(frame.x + frame.width).toBeLessThanOrEqual(900);
            expect(frame.y + frame.height).toBeLessThanOrEqual(500);
        }
    });
});
