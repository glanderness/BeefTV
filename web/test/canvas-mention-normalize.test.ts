import { expect, test } from "bun:test";

import { normalizeCanvasNodesMentionTokens } from "@/pages/canvas/use-canvas-mention-normalize";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("rewrites saved @[node:] tokens beside the render-model mention map", () => {
    const nodes: CanvasNodeData[] = [
        {
            id: "text-1",
            type: CanvasNodeType.Text,
            title: "文本",
            position: { x: 0, y: 0 },
            width: 350,
            height: 350,
            metadata: { composerContent: "参考 @[node:img-1] 出图" },
        },
        {
            id: "plain",
            type: CanvasNodeType.Text,
            title: "其它",
            position: { x: 0, y: 0 },
            width: 350,
            height: 350,
            metadata: { prompt: "没有引用" },
        },
    ];
    const references: CanvasResourceReference[] = [{
        id: "ref-1",
        nodeId: "img-1",
        kind: "image",
        label: "图片1",
        title: "图片1",
        active: true,
    }];
    const next = normalizeCanvasNodesMentionTokens(nodes, new Map([["text-1", references]]));
    expect(next[0]?.metadata?.composerContent).toBe("参考 @图片1 出图");
    expect(next[1]).toBe(nodes[1]);
});
