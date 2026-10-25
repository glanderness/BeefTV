import { describe, expect, test } from "bun:test";

import { buildImageGenerationNodeTitle, resolvePromptNodeTitle } from "@/lib/canvas/canvas-generation-title";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(title: string, autoTitle?: string, type: CanvasNodeData["type"] = CanvasNodeType.Text): CanvasNodeData {
    return { id: "node-1", type, title, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: autoTitle ? { autoTitle } : {} };
}

describe("canvas generation node title", () => {
    test("keeps a title the user gave the node (飞书 #66)", () => {
        expect(resolvePromptNodeTitle(node("分镜 1 - 清晨街角"), "一只猫在草地上打滚，阳光很好")).toEqual({
            title: "分镜 1 - 清晨街角",
            autoTitle: undefined,
        });
    });

    test("reuses the prompt title for a node that still carries the type default", () => {
        expect(resolvePromptNodeTitle(node("文本节点"), "一只猫在草地上打滚")).toEqual({
            title: "一只猫在草地上打滚",
            autoTitle: "一只猫在草地上打滚",
        });
    });

    test("refreshes a title this feature generated for an earlier prompt", () => {
        expect(resolvePromptNodeTitle(node("第一版提示词", "第一版提示词"), "第二版提示词")).toEqual({
            title: "第二版提示词",
            autoTitle: "第二版提示词",
        });
    });

    test("falls back to a prompt title when the node has no title at all", () => {
        expect(resolvePromptNodeTitle(node(""), "  ")).toEqual({ title: "Prompt", autoTitle: "Prompt" });
    });

    test("keeps generation result nodes named after the prompt", () => {
        expect(buildImageGenerationNodeTitle("一只猫", undefined)).toBe("一只猫");
    });
});
