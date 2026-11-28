import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { defaultConfig } from "@/stores/use-config-store";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasStageOverlayProps, makeCanvasNode } from "./helpers/canvas-stage-overlays-fixture";

const panelOverlayCalls: Array<Record<string, unknown>> = [];
const toolbarCalls: Array<Record<string, unknown>> = [];

mock.module("@/components/canvas/canvas-workspace-overlays", () => ({
    CanvasNodePanelOverlay: (props: Record<string, unknown> & { children?: ReactNode }) => {
        panelOverlayCalls.push(props);
        return createElement("div", null, props.children);
    },
    CanvasConnectionCreateMenu: () => null,
    CanvasSelectionToolbar: () => null,
}));
mock.module("@/components/canvas/canvas-node-toolbar", () => ({
    CanvasNodeToolbar: (props: Record<string, unknown>) => {
        toolbarCalls.push(props);
        return null;
    },
}));
mock.module("@/components/canvas/canvas-overlay-layer", () => ({ CanvasOverlayLayerContainer: () => null }));
mock.module("@/components/canvas/canvas-asset-tray", () => ({ CanvasAssetTray: () => null }));
mock.module("@/components/canvas/canvas-zoom-controls", () => ({ CanvasZoomControls: () => null }));

const { CanvasImageMaskEditor } = await import("@/components/canvas/canvas-node-mask-edit-dialog");
const { CanvasProjectStageOverlays } = await import("@/pages/canvas/canvas-project-overlays");

beforeEach(() => {
    panelOverlayCalls.length = 0;
    toolbarCalls.length = 0;
    useCreationPreferencesStore.setState({ preferences: {} });
});

describe("inline canvas mask editing", () => {
    test("shows the text-only configuration notice before a repaint can be submitted", () => {
        const model = "custom::moss-image-sft";
        const html = renderToStaticMarkup(createElement(CanvasImageMaskEditor, {
            imageDimensions: { width: 512, height: 512 }, scale: 1,
            config: {
                ...defaultConfig,
                model,
                imageModel: model,
                imageModels: [model],
                channels: [{
                    id: "custom",
                    name: "Custom",
                    models: ["moss-image-sft"],
                    interfaceType: "openai-image",
                    modelProfiles: [{
                        model: "moss-image-sft",
                        protocol: "openai-image",
                        capabilityConfig: {
                            version: 1,
                            image: {
                                references: { promptMaxChars: 4000, maxImages: 0, maxImageBytes: 0, maskSupported: false },
                                size: { parameter: "size", values: ["1:1", "1024x1024"], default: "1:1", allowCustom: true },
                                quality: { supported: false, values: [], default: "auto" },
                                transparentBackground: { supported: false, default: false },
                                responseFormat: { supported: true, value: "url" },
                                outputFormat: { supported: false },
                                maxOutputs: 1,
                            },
                        },
                    }],
                }],
            },
            onCancel: () => undefined, onConfirm: () => undefined,
        }));
        expect(html).toContain("当前模型配置仅支持文生图，不支持图片重绘");
        expect(html).toContain('role="status"');
        expect(html).toContain("disabled:cursor-not-allowed");
        expect(html).not.toContain("disabled:cursor-wait");
    });

    test("renders inline mask editor with prompt input, settings, and semantic theme tokens", () => {
        const html = renderToStaticMarkup(
            createElement(CanvasImageMaskEditor, {
                imageDimensions: { width: 512, height: 512 },
                scale: 1,
                config: defaultConfig,
                onCancel: () => undefined,
                onConfirm: () => undefined,
            }),
        );
        expect(html).toContain('data-image-mask-edit-inline="true"');
        expect(html).toContain("<input");
        expect(html).toContain('aria-label="局部重绘要求"');
        expect(html).not.toContain('<textarea aria-label="局部重绘要求"');
        expect(html).toContain('aria-label="局部重绘设置"');
        expect(html).toContain('data-mask-edit-model-selector="true"');
        expect(html).toContain('aria-label="AI 修改"');
        expect(html).not.toContain("#242424");
    });

    test("surfaces active model selector in the bottom bar and honors remembered mask-edit preference with fallback", () => {
        const config = {
            ...defaultConfig,
            model: "custom::gpt-image-2",
            imageModel: "custom::gpt-image-2",
            imageModels: ["custom::gpt-image-2", "custom::doubao-seedream-5-0-260128"],
            channels: [{
                id: "custom",
                name: "Custom",
                models: ["gpt-image-2", "doubao-seedream-5-0-260128"],
                interfaceType: "openai-image" as const,
                modelProfiles: [
                    { model: "gpt-image-2", displayName: "GPT Image 2" },
                    { model: "doubao-seedream-5-0-260128", displayName: "Seedream 5.0" },
                ],
            }],
        };

        // No remembered preference -> shows node's model directly in the bottom bar
        const defaultHtml = renderToStaticMarkup(createElement(CanvasImageMaskEditor, {
            imageDimensions: { width: 512, height: 512 }, scale: 1, config,
            onCancel: () => undefined, onConfirm: () => undefined,
        }));
        expect(defaultHtml).toContain("GPT Image 2");

        // Remembered preference -> overrides node model directly in the bottom bar
        useCreationPreferencesStore.getState().rememberMaskEditModel("custom::doubao-seedream-5-0-260128");
        const rememberedHtml = renderToStaticMarkup(createElement(CanvasImageMaskEditor, {
            imageDimensions: { width: 512, height: 512 }, scale: 1, config,
            onCancel: () => undefined, onConfirm: () => undefined,
        }));
        expect(rememberedHtml).toContain("Seedream 5.0");

        // Unavailable remembered preference -> falls back cleanly to node model
        useCreationPreferencesStore.getState().rememberMaskEditModel("deleted::unavailable-model");
        const fallbackHtml = renderToStaticMarkup(createElement(CanvasImageMaskEditor, {
            imageDimensions: { width: 512, height: 512 }, scale: 1, config,
            onCancel: () => undefined, onConfirm: () => undefined,
        }));
        expect(fallbackHtml).toContain("GPT Image 2");
    });

    test("hides the ordinary node toolbar and prompt panel while mask editing", () => {
        const toolbarNode = makeCanvasNode("img-1", CanvasNodeType.Image, { content: "data:image/png;base64,a" });
        const dialogNode = makeCanvasNode("text-1", CanvasNodeType.Text);

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    toolbarNode,
                    dialogNode,
                    maskEditNodeId: "img-1",
                }),
            ),
        );

        expect(toolbarCalls).toHaveLength(1);
        expect(toolbarCalls[0]?.node).toBeNull();
        expect(panelOverlayCalls).toHaveLength(0);
    });

    test("closes prompt dialog when triggering mask editing from the node toolbar", () => {
        const imgNode = makeCanvasNode("img-2", CanvasNodeType.Image, { content: "data:image/png;base64,b", status: "success" });
        const dialogChanges: Array<string | null> = [];
        const maskChanges: Array<string | null> = [];

        renderToStaticMarkup(
            createElement(
                CanvasProjectStageOverlays,
                createCanvasStageOverlayProps({
                    toolbarNode: imgNode,
                    setDialogNodeId: (next) => {
                        dialogChanges.push(typeof next === "function" ? next(imgNode.id) : next);
                    },
                    setMaskEditNodeId: (next) => {
                        maskChanges.push(next);
                    },
                }),
            ),
        );

        expect(toolbarCalls).toHaveLength(1);
        (toolbarCalls[0]?.onMaskEdit as (node: CanvasNodeData) => void)(imgNode);
        expect(dialogChanges).toEqual([null]);
        expect(maskChanges).toEqual(["img-2"]);
    });
});
