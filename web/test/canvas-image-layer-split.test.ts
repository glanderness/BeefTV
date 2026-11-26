import { expect, test } from "bun:test";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-config";
import { createImageLayerSplit } from "@/pages/canvas/canvas-generation-orchestration";
import { backendProviderConfig } from "@/services/api/generation-task";
import { createModelChannel, defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const model = "local-test::dola-seedream-5-5-261028";
const pro = "local-test::dola-seedream-5-0-pro-260628";
const source: CanvasNodeData = {
    id: "photo", type: CanvasNodeType.Image, title: "猫", position: { x: 20, y: 30 },
    width: 340, height: 340, metadata: { storageKey: "resource:photo", model: "local-test::gpt-image-2" },
};
const config = {
    ...defaultConfig,
    imageModel: "local-test::gpt-image-2",
    count: "4",
    channels: [createModelChannel({
        id: "local-test", enabled: true, interfaceType: "openai-image",
        models: ["gpt-image-2", "dola-seedream-5-0-pro-260628", "dola-seedream-5-5-261028"],
    })],
};

test("layer split uses exactly the selected image and one Seedream request", () => {
    const result = createImageLayerSplit(source, config, [source], () => true);
    if (!result) throw new Error("layer split should be available");
    const wire = backendProviderConfig(buildGenerationConfig(config, result.node, "image"));
    expect(result.connection).toMatchObject({ fromNodeId: source.id, toNodeId: result.node.id });
    expect(result.node.id).not.toBe(source.id);
    expect(result.node.metadata?.content).toBeFalsy();
    expect(result.node.metadata?.seedreamMode).toBe("layers");
    expect(result.node.metadata?.model).toBe(model);
    expect(wire).toMatchObject({ seedreamMode: "layers", size: "auto", count: "1", transparentBackground: "false" });
});

test("layer split prefers a ready selected Seedream and skips unavailable channels", () => {
    expect(createImageLayerSplit(source, { ...config, imageModel: pro }, [source], () => true)?.node.metadata?.model).toBe(pro);
    expect(createImageLayerSplit(source, config, [source], key => key === pro)?.node.metadata?.model).toBe(pro);
    expect(createImageLayerSplit(source, config, [source], () => false)).toBeNull();
});
