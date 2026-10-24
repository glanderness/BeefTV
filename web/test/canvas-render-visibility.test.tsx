import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { useCanvasRenderModel } from "@/pages/canvas/use-canvas-render-model";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

type RenderOptions = { selectedNodeIds?: Set<string>; pinned?: Set<string>; viewport?: ViewportTransform };

function renderModel(nodes: CanvasNodeData[], { selectedNodeIds = new Set<string>(), pinned, viewport = { x: 20, y: 20, k: 0.05 } }: RenderOptions = {}) {
    let result = { dom: [] as string[], lod: [] as string[], lodActive: false };
    function Probe() {
        const model = useCanvasRenderModel({
            nodes, connections: [], assets: [], viewport,
            viewportSize: { width: 1440, height: 900 }, mediaPerformanceMode: "auto",
            selectedNodeIds, hoveredNodeId: null, dragPreview: null,
            collapsingBatchIds: new Set(), addedSkills: [], infoNodeId: null,
            maskEditNodeId: null, annotationNodeId: null, splitNodeId: null,
            upscaleNodeId: null, angleNodeId: null, lightingNodeId: null,
            emotionNodeId: null, previewNodeId: null, contextMenu: null,
            versionCompareRootId: null, directorNodeId: null, scriptEditorNodeId: null,
            dialogNodeId: null, lodPinnedNodeIds: pinned,
        });
        result = { dom: model.visibleNodes.map(node => node.id), lod: model.lodNodes.map(node => node.id), lodActive: model.lodActive };
        return null;
    }
    renderToStaticMarkup(<Probe />);
    return result;
}

/** Everything the user sees: DOM cards plus overview-canvas nodes. */
function displayedIds(nodes: CanvasNodeData[], options?: RenderOptions) {
    const { dom, lod } = renderModel(nodes, options);
    return new Set([...dom, ...lod]);
}

function nodes(count: number): CanvasNodeData[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `node-${i}`, type: i % 5 ? CanvasNodeType.Image : CanvasNodeType.Video,
        title: `Media ${i}`, width: 320, height: 180,
        position: { x: i % 32 * 360, y: Math.floor(i / 32) * 240 },
    }));
}

for (const count of [80, 512]) {
    test(`overview displays every one of ${count} visible media nodes`, () => {
        const fixture = nodes(count);
        expect(displayedIds(fixture)).toEqual(new Set(fixture.map(node => node.id)));
    });
}

test("offscreen selection is retained without displacing visible nodes", () => {
    const fixture = nodes(512);
    const offscreen = { ...fixture[0], id: "selected-offscreen", position: { x: 100000, y: 100000 } };
    expect(displayedIds([...fixture, offscreen], { selectedNodeIds: new Set([offscreen.id]) }))
        .toEqual(new Set([...fixture, offscreen].map(node => node.id)));
});

test("readable zoom culls offscreen DOM cards", () => {
    const fixture = nodes(12);
    const offscreen = { ...fixture[0], id: "offscreen", position: { x: 100000, y: 100000 } };
    const model = renderModel([...fixture, offscreen], { viewport: { x: 0, y: 0, k: 1 } });
    expect(model.dom).not.toContain("offscreen");
});

test("overview canvas receives offscreen nodes so camera previews need no React refresh", () => {
    const fixture = nodes(80);
    const offscreen = { ...fixture[0], id: "offscreen", position: { x: 100000, y: 100000 } };
    const model = renderModel([...fixture, offscreen]);
    expect(model.lodActive).toBe(true);
    expect(model.lod).toContain("offscreen");
    expect(model.dom).not.toContain("offscreen");
});

test("far zoom draws cards in the overview canvas and mounts only pinned DOM cards", () => {
    const fixture = nodes(512);
    const model = renderModel(fixture, { pinned: new Set(["node-3", "node-7"]) });
    expect(model.lodActive).toBe(true);
    expect(model.lod).toHaveLength(512);
    expect(new Set(model.dom)).toEqual(new Set(["node-3", "node-7"]));
});

test("readable zoom keeps full DOM cards and no overview canvas", () => {
    const fixture = nodes(12);
    const model = renderModel(fixture, { viewport: { x: 0, y: 0, k: 1 } });
    expect(model.lodActive).toBe(false);
    expect(model.lod).toHaveLength(0);
    expect(model.dom.length).toBeGreaterThan(0);
});

test("frames stay DOM in the overview so their titles and controls remain", () => {
    const frame: CanvasNodeData = { id: "frame", type: CanvasNodeType.Frame, title: "Group", width: 2000, height: 1200, position: { x: 0, y: 0 } };
    const model = renderModel([frame, ...nodes(80)]);
    expect(model.lodActive).toBe(true);
    expect(model.dom).toContain("frame");
    expect(model.lod).not.toContain("frame");
});
