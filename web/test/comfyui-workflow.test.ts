import { expect, test } from "bun:test";

import { comfyUIWorkflowClassTypes, comfyUIWorkflowFields, inferComfyUIPromptField, inferComfyUIReferenceImageFields, isComfyUILinkValue } from "@/lib/comfyui-workflow";
import type { ComfyUIObjectInfo } from "@/services/api/comfyui";

// 复刻真实 API 格式工作流的形状：连线值是 [nodeId, outputIndex]。
const workflow = {
    "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20, model: ["4", 0], positive: ["6", 0], negative: ["7", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "worst quality, low quality", clip: ["4", 1] } },
};

const objectInfo: ComfyUIObjectInfo = {
    baseUrl: "http://127.0.0.1:8188",
    nodes: [
        {
            classType: "KSampler",
            inputs: [
                { name: "seed", type: "INT", required: true, min: 0, max: 18446744073709551615 },
                { name: "steps", type: "INT", required: true, min: 1, max: 10000 },
                { name: "model", type: "MODEL", required: true, link: true },
                { name: "positive", type: "CONDITIONING", required: true, link: true },
                { name: "negative", type: "CONDITIONING", required: true, link: true },
            ],
        },
        {
            classType: "CheckpointLoaderSimple",
            inputs: [{ name: "ckpt_name", type: "COMBO", required: true, options: ["sd.safetensors", "flux.safetensors"] }],
        },
        {
            classType: "CLIPTextEncode",
            inputs: [
                { name: "text", type: "STRING", required: true, multiline: true },
                { name: "clip", type: "CLIP", required: true, link: true },
            ],
        },
    ],
};

test("comfyUIWorkflowClassTypes 提取去重并排序节点类型", () => {
    expect(comfyUIWorkflowClassTypes(workflow)).toEqual(["CLIPTextEncode", "CheckpointLoaderSimple", "KSampler"]);
    expect(comfyUIWorkflowClassTypes({})).toEqual([]);
});

test("isComfyUILinkValue 只识别 [nodeId, index] 形态", () => {
    expect(isComfyUILinkValue(["4", 0])).toBe(true);
    // 与后端 isWorkflowLinkValue 保持一致：nodeId 只要非空即视为连线，
    // 宁可宽松跳过，也不能把连线当字面量写回。
    expect(isComfyUILinkValue([1, 2])).toBe(true);
    expect(isComfyUILinkValue(["4", 0, 1])).toBe(false);
    expect(isComfyUILinkValue("text")).toBe(false);
    expect(isComfyUILinkValue([[], 0])).toBe(false);
});

test("comfyUIWorkflowFields 排除连线输入并透传枚举与数值范围", () => {
    const fields = comfyUIWorkflowFields(workflow, objectInfo);
    const ids = fields.map((field) => field.id);

    // 连线输入必须排除，否则会把工作流拓扑写成字面量并让 /prompt 校验失败。
    expect(ids).not.toContain("3::model");
    expect(ids).not.toContain("3::positive");
    expect(ids).not.toContain("3::negative");
    expect(ids).not.toContain("6::clip");

    const seed = fields.find((field) => field.id === "3::seed");
    expect(seed?.fieldType).toBe("INT");
    expect(seed?.required).toBe(true);
    // seed 的声明上限是 uint64 最大值，必须原样保留给界面做范围提示。
    expect(seed?.max).toBe(18446744073709551615);

    const checkpoint = fields.find((field) => field.id === "4::ckpt_name");
    expect(checkpoint?.fieldType).toBe("COMBO");
    expect(checkpoint?.options).toEqual(["sd.safetensors", "flux.safetensors"]);
});

test("comfyUIWorkflowFields 在上游定义缺失时仍按连线形态排除", () => {
    const ids = comfyUIWorkflowFields(workflow, undefined).map((field) => field.id);
    expect(ids).not.toContain("3::model");
    expect(ids).not.toContain("6::clip");
    expect(ids).toContain("3::seed");
    expect(ids).toContain("6::text");
});

test("inferComfyUIPromptField 选中正向提示词而不是负向模板", () => {
    const fields = inferComfyUIPromptField(comfyUIWorkflowFields(workflow, objectInfo));
    const promptFields = fields.filter((field) => field.source === "prompt");
    expect(promptFields).toHaveLength(1);
    expect(promptFields[0].id).toBe("6::text");
    expect(promptFields[0].required).toBe(true);
});

test("inferComfyUIPromptField 在只有负向模板时不强行绑定", () => {
    const negativeOnly = { "7": workflow["7"] };
    const fields = inferComfyUIPromptField(comfyUIWorkflowFields(negativeOnly, objectInfo));
    expect(fields.filter((field) => field.source === "prompt")).toHaveLength(0);
});

test("inferComfyUIPromptField 对空文本槽位降级", () => {
    const emptyText = { "6": { class_type: "CLIPTextEncode", inputs: { text: "" } } };
    const fields = inferComfyUIPromptField(comfyUIWorkflowFields(emptyText, objectInfo));
    expect(fields.filter((field) => field.source === "prompt")).toHaveLength(0);
});

test("inferComfyUIReferenceImageFields 把 LoadImage.image 识别为参考图槽位", () => {
    // 图生图工作流：LoadImage 提供参考图，CLIPTextEncode 提供提示词。
    const img2img = {
        "10": { class_type: "LoadImage", inputs: { image: "example.png" } },
        "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
    };
    const info: ComfyUIObjectInfo = {
        baseUrl: "http://127.0.0.1:8188",
        nodes: [
            { classType: "LoadImage", inputs: [{ name: "image", type: "COMBO", required: true, options: ["example.png"] }] },
            {
                classType: "CLIPTextEncode",
                inputs: [
                    { name: "text", type: "STRING", required: true },
                    { name: "clip", type: "CLIP", required: true, link: true },
                ],
            },
        ],
    };
    const fields = inferComfyUIPromptField(inferComfyUIReferenceImageFields(comfyUIWorkflowFields(img2img, info)));
    const references = fields.filter((field) => field.source === "referenceImage");
    // LoadImage.image 的类型是 COMBO 而非 IMAGE，必须按节点类型显式识别。
    expect(references).toHaveLength(1);
    expect(references[0].nodeId).toBe("10");
    expect(references[0].fieldName).toBe("image");
    expect(references[0].imageOrder).toBe(1);
    expect(references[0].required).toBe(true);
    // 参考图槽位与提示词槽位互不干扰。
    expect(fields.filter((field) => field.source === "prompt")).toHaveLength(1);
});

test("多个 LoadImage 依次分配图片槽位", () => {
    const twoImages = {
        "10": { class_type: "LoadImage", inputs: { image: "first.png" } },
        "12": { class_type: "LoadImage", inputs: { image: "last.png" } },
    };
    // 上游节点定义缺失时也要给出槽位，否则用户无法把参考图接上。
    const fields = inferComfyUIReferenceImageFields(comfyUIWorkflowFields(twoImages, undefined));
    expect(fields.filter((field) => field.source === "referenceImage").map((field) => field.imageOrder)).toEqual([1, 2]);
});
