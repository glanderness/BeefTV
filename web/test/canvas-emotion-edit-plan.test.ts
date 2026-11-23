import { describe, expect, test } from "bun:test";

import { buildEmotionPrompt } from "../src/lib/canvas/canvas-emotion";
import { formatMaskEditPrompt, imageEditPlan } from "../src/lib/canvas/canvas-image-edit-plan";
import { defaultImageCapabilityConfig } from "../src/lib/model-capabilities";

const faceBox = { id: "face-1", x: 120, y: 80, width: 160, height: 180, source: "detected" as const };

describe("emotion edit prompt and mask plan", () => {
    test("uses full-image original wording without provider mask promises, crop, or second-image references", () => {
        const prompt = buildEmotionPrompt(
            { presetId: "emotion-0-0", intimacy: 0, arousal: 0, characterName: "角色1", faceBox },
            { x: 0, y: 0, width: 512, height: 512 },
        );

        expect(prompt).toContain("目标人脸框（相对于原图）");
        expect(prompt).not.toContain("透明蒙版");
        expect(prompt).not.toContain("白色蒙版");
        expect(prompt).not.toContain("第二张输入图");
        expect(prompt).not.toContain("裁切");
    });

    test("selects native provider-mask or local-composite through imageEditPlan", () => {
        const nativeProfile = {
            ...defaultImageCapabilityConfig("openai-image", "gpt-image-1"),
            references: { maxImages: 4, maskSupported: true },
        };
        const compositeProfile = {
            ...defaultImageCapabilityConfig("gemini-image", "gemini-edit"),
            references: { maxImages: 1, maskSupported: false },
            fixedOutputs: 4,
            maxOutputs: 4,
        };
        expect(imageEditPlan(nativeProfile, 1)).toEqual({ mode: "provider-mask", count: 1, outputsPerRequest: 1 });
        expect(imageEditPlan(compositeProfile, 1)).toEqual({ mode: "local-composite", count: 4, outputsPerRequest: 4 });
    });

    test("formats native-mask prompt prefix idempotently and strips it for local-composite", () => {
        const nativePrompt = formatMaskEditPrompt("给人物加上温和微笑", false);
        expect(nativePrompt).toBe("只修改蒙版透明区域，其他区域保持不变。给人物加上温和微笑");
        expect(formatMaskEditPrompt(nativePrompt, false)).toBe(nativePrompt);
        expect(formatMaskEditPrompt(nativePrompt, true)).toBe("给人物加上温和微笑");
    });
});
