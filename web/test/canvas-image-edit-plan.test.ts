import { expect, test } from "bun:test";
import { imageEditOutputGroups, imageEditPlan } from "@/lib/canvas/canvas-image-edit-plan";
import { defaultModelCapabilityConfig } from "@/lib/model-capabilities";

test("native mask and local fusion use declared abilities rather than model names", () => {
    const image = defaultModelCapabilityConfig("openai-image", "future-image").image!;
    expect(imageEditPlan(image, 3)).toEqual({ mode: "provider-mask", count: 3, outputsPerRequest: 1 });
    expect(imageEditPlan({ ...image, references: { ...image.references, maskSupported: false } }, 3)).toEqual({ mode: "local-composite", count: 3, outputsPerRequest: 1 });
});

test("fixed-output models create one request per native batch and retain every destination", () => {
    const base = defaultModelCapabilityConfig("openai-image", "future-image").image!;
    const image = { ...base, references: { ...base.references, maskSupported: false }, fixedOutputs: 4, generationOutputs: [4, 8], maxOutputs: 4 };
    expect(imageEditPlan(image, 1)).toEqual({ mode: "local-composite", count: 4, outputsPerRequest: 4 });
    expect(imageEditPlan(image, 8).count).toBe(8);
    expect(imageEditOutputGroups(["a", "b", "c", "d"], 4)).toEqual([["a", "b", "c", "d"]]);
    expect(imageEditOutputGroups(["a", "b"], 1)).toEqual([["a"], ["b"]]);
});
