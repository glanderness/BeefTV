import { describe, expect, test } from "bun:test";

import { buildImageGenerationNodeTitle, renameCanvasNodeTitle, resolvePromptNodeTitle } from "@/lib/canvas/canvas-generation-title";
import { saveCanvasTextNode } from "@/lib/canvas/canvas-node-prompt";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(title: string, autoTitle?: string, type: CanvasNodeData["type"] = CanvasNodeType.Text): CanvasNodeData {
    return { id: "node-1", type, title, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: autoTitle ? { autoTitle } : {} };
}

function generated(node: CanvasNodeData, prompt: string): CanvasNodeData {
    const resolved = resolvePromptNodeTitle(node, prompt);
    return { ...node, title: resolved.title, metadata: resolved.autoTitle ? { ...node.metadata, autoTitle: resolved.autoTitle } : node.metadata };
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

    test("stops following prompts after the user renames the node", () => {
        const renamed = renameCanvasNodeTitle(generated(node("文本节点"), "第一版提示词"), "分镜 1 - 清晨街角");
        expect(renamed.title).toBe("分镜 1 - 清晨街角");
        expect(renamed.metadata?.autoTitle).toBeUndefined();
        expect(resolvePromptNodeTitle(renamed, "第二版提示词")).toEqual({ title: "分镜 1 - 清晨街角", autoTitle: undefined });
    });

    test("keeps the user's name when it matches an earlier automatic name", () => {
        const automatic = generated(node("文本节点"), "第一版提示词");
        const renamed = renameCanvasNodeTitle(renameCanvasNodeTitle(automatic, "分镜 1"), automatic.title);
        expect(renamed.title).toBe("第一版提示词");
        expect(resolvePromptNodeTitle(renamed, "第二版提示词")).toEqual({ title: "第一版提示词", autoTitle: undefined });
    });

    test("stops following prompts after a rename saved from the text editor", () => {
        const automatic = generated(node("文本节点"), "第一版提示词");
        const renamed = saveCanvasTextNode(automatic, { title: "分镜 1", content: "正文" });
        const reverted = saveCanvasTextNode(renamed, { title: automatic.title, content: "正文" });
        expect(reverted.title).toBe("第一版提示词");
        expect(reverted.metadata?.autoTitle).toBeUndefined();
        expect(resolvePromptNodeTitle(reverted, "第二版提示词")).toEqual({ title: "第一版提示词", autoTitle: undefined });
    });

    test("keeps following prompts when the text editor only changes content", () => {
        const automatic = generated(node("文本节点"), "第一版提示词");
        const saved = saveCanvasTextNode(automatic, { title: automatic.title, content: "改写后的正文" });
        expect(saved.metadata?.autoTitle).toBe("第一版提示词");
        expect(resolvePromptNodeTitle(saved, "第二版提示词")).toEqual({ title: "第二版提示词", autoTitle: "第二版提示词" });
    });
});
