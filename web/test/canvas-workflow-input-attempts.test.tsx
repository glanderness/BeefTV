import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as resources from "@/services/api/resources";
import * as assets from "@/services/project-asset-sync";
import { useCanvasWorkflowInstances } from "@/pages/canvas/use-canvas-workflow-instances";
import { createWorkflowInstance } from "@/lib/canvas/reusable-workflow-instance";
import type { CanvasWorkflow } from "@/services/api/canvas-workflows";

test("an old offscreen upload cannot clear or overwrite a newer input attempt", async () => {
    const template: CanvasWorkflow = { id: "template", name: "replace", description: "", createdAt: "", updatedAt: "", definition: { version: 1, nodes: [{ id: "input", title: "人物", role: "input", mediaType: "image" }], edges: [], outputNodeIds: ["input"] } };
    const graph = createWorkflowInstance(template, { x: 0, y: 0 });
    const nodesRef = { current: graph.nodes };
    let api!: ReturnType<typeof useCanvasWorkflowInstances>;
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const get = spyOn(resources, "getResource").mockImplementation(async id => {
        if (id === "slow") await delayed;
        return { id, kind: "image", status: "ready", mimeType: "image/png", width: 300, height: 300, size: 1 } as Awaited<ReturnType<typeof resources.getResource>>;
    });
    const asset = spyOn(assets, "ensureCanvasNodeAsset").mockImplementation(async () => ({ assetId: "asset" }) as Awaited<ReturnType<typeof assets.ensureCanvasNodeAsset>>);
    try {
        function Harness() {
            api = useCanvasWorkflowInstances({ canvasId: "canvas", readOnly: false, nodes: nodesRef.current, nodesRef, setNodes: () => {}, connectionsRef: { current: [] }, setConnections: () => {}, getCanvasCenter: () => ({ x: 0, y: 0 }), focusNode: () => {}, persist: async () => true, onError: () => {} });
            return null;
        }
        renderToStaticMarkup(<Harness />);
        const id = graph.nodes.find(node => node.metadata?.workflowSlot?.role === "input")!.id;
        const old = api.uploadBusy(id, true)!;
        const current = api.uploadBusy(id, true)!;
        api.uploadBusy(id, false, old);
        await api.setValue(id, { resourceId: "newer" }, current);
        await api.setValue(id, { resourceId: "older" }, old);
        expect(nodesRef.current.find(node => node.id === id)?.metadata?.storageKey).toBe("resource:newer");
        api.uploadBusy(id, false, current);
        const slow = api.uploadBusy(id, true)!;
        const pending = api.setValue(id, { resourceId: "slow" }, slow);
        await api.setValue(id, { resourceId: "manual" });
        release(); await pending;
        expect(nodesRef.current.find(node => node.id === id)?.metadata?.storageKey).toBe("resource:manual");
    } finally { release(); get.mockRestore(); asset.mockRestore(); }
});
