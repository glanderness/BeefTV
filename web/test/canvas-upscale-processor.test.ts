import { expect, test } from "bun:test";

import { NODE_DEFAULT_SIZE } from "../src/constant/canvas";
import { createCachedUpscaleResourcePreparer } from "../src/lib/canvas/canvas-upscale";
import { planUpscaleProcessingNode } from "../src/lib/canvas/canvas-upscale-processor";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const media = (id: string, type: CanvasNodeType, x: number, readable = true): CanvasNodeData => ({
    id, type, title: id, position: { x, y: 0 }, width: 100, height: 80,
    metadata: readable ? { content: "data:" } : {},
});

test("connects every selected readable image or video and places the processor to the right", () => {
    const source = media("a", CanvasNodeType.Image, 0);
    const nodes = [source, media("b", CanvasNodeType.Video, 400), media("c", CanvasNodeType.Text, 800), media("d", CanvasNodeType.Image, 1200, false)];
    let nextId = 0;
    const plan = planUpscaleProcessingNode(nodes, [], source, new Set(["a", "b", "c", "d"]), () => `edge-${nextId++}`);
    expect(plan.processor.type).toBe(CanvasNodeType.Upscale);
    expect(plan.processor.width).toBe(NODE_DEFAULT_SIZE[CanvasNodeType.Image].width);
    expect(plan.processor.height).toBe(NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
    expect(plan.processor.position.x).toBeGreaterThan(source.position.x);
    expect(plan.connections.map((edge) => edge.fromNodeId)).toEqual(["a", "b"]);
    expect(plan.connections.every((edge) => edge.toNodeId === plan.processor.id)).toBe(true);
    expect(plan.processor.metadata?.status).toBe("idle");
});

test("uses only the clicked source when it is not part of the selection", () => {
    const source = media("a", CanvasNodeType.Image, 0);
    const plan = planUpscaleProcessingNode([source, media("b", CanvasNodeType.Video, 400)], [], source, new Set(["b"]), () => "edge");
    expect(plan.connections).toEqual([{ id: "edge", fromNodeId: "a", toNodeId: plan.processor.id }]);
});

test("cached upscale resource preparer deduplicates repeated quotes and clears failed entries", async () => {
    let calls = 0;
    let shouldFail = true;
    const preparer = createCachedUpscaleResourcePreparer(async (node) => {
        calls += 1;
        if (shouldFail) throw new Error("upload failed");
        return `res-${node.id}-${calls}`;
    });
    const source = media("v1", CanvasNodeType.Video, 0);
    await expect(preparer.prepare(source)).rejects.toThrow("upload failed");
    shouldFail = false;

    const [first, second] = await Promise.all([preparer.prepare(source), preparer.prepare(source)]);
    expect(first).toBe("res-v1-2");
    expect(second).toBe("res-v1-2");
    expect(await preparer.prepare(source)).toBe("res-v1-2");
    expect(calls).toBe(2);

    const updated = { ...source, metadata: { content: "data:updated" } };
    expect(await preparer.prepare(updated)).toBe("res-v1-3");
    expect(calls).toBe(3);

    preparer.clear();
    expect(await preparer.prepare(updated)).toBe("res-v1-4");
});
