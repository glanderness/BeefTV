import { afterEach, describe, expect, test } from "bun:test";

import { defaultToolbarPrefs, resolveToolbarEntries, type ToolbarHandlers, type ToolContext } from "@/lib/canvas/tool-registry";
import {
    createEmbeddedAskResultHandler,
    embeddedAskResultNotice,
    parseEmbeddedAskResult,
    publishSelectionAsk,
} from "../src/lib/embedded-runtime";
import {
    createEmbeddedCanvasNoticeGate,
    createEmbeddedWorkspaceSyncHandler,
    currentCanvasIdFromPath,
    EMBEDDED_CANVAS_NOTICE_INTERVAL_MS,
    embeddedCanvasNoticeText,
    type EmbeddedCanvasNotice,
} from "../src/lib/embedded-workspace-sync";

type FakeParent = {
    location: { origin: string };
    postMessage: (message: unknown, targetOrigin: string) => void;
};

function installBrowserWindow(options: { embedded?: boolean; parentOrigin?: string } = {}) {
    const posted: { message: unknown; targetOrigin: string }[] = [];
    const parent: FakeParent = {
        location: { origin: options.parentOrigin ?? "https://host.test" },
        postMessage: (message, targetOrigin) => { posted.push({ message, targetOrigin }); },
    };
    const fakeWindow = {
        __BEEFTV_HARNESS__: options.embedded === false ? undefined : {
            embedded: true,
            apiBase: "/beeftv/app/api",
            basePath: "/beeftv/app",
            parentOrigin: options.parentOrigin ?? "https://host.test",
        },
        location: { origin: "https://app.test" },
        parent,
    };
    (globalThis as { window?: unknown }).window = fakeWindow;
    return { posted, parent, fakeWindow };
}

function flushAsyncWork() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

describe("问助手交接", () => {
    function selectionToolbarIds(onAskAssistant?: () => void) {
        const ctx = {
            selectedCount: 2,
            selectedNodeTypes: new Set(),
            selectedVideoCount: 0,
            canvasTool: "move",
            workspaceMode: "professional",
            isProjectLinked: false,
            canUndo: false,
            canRedo: false,
            extractingVideoFrames: false,
            extractingAudio: false,
            trimmingVideo: false,
            mergingVideos: false,
            addPanelOpen: false,
            appearancePanelOpen: false,
            settingsPanelOpen: false,
            handlers: { onAskAssistant } as unknown as ToolbarHandlers,
        } as ToolContext;
        return resolveToolbarEntries("selection", ctx, defaultToolbarPrefs("selection"))
            .flatMap((entry) => entry.kind === "separator" || entry.kind === "switch" ? [] : [entry.id]);
    }

    test("画布页装配问助手回调时按钮出现", () => {
        expect(selectionToolbarIds(() => {})).toContain("selection-ask-assistant");
        expect(selectionToolbarIds()).not.toContain("selection-ask-assistant");
    });

    test("嵌入模式把选中节点按协议发给父窗口，最多 20 个、标题截到 80 字", () => {
        const { posted } = installBrowserWindow();
        const longTitle = "主".repeat(90);
        const nodes = Array.from({ length: 22 }, (_, index) => ({ id: `n${index + 1}`, title: index === 0 ? longTitle : `节点 ${index + 1}`, type: "image" }));
        const selectedNodeIds = new Set([...nodes.map((node) => node.id), "not-on-canvas"]);
        selectedNodeIds.delete("n21");

        expect(publishSelectionAsk({ canvasId: "canvas-1", canvasTitle: "第一场", nodes, selectedNodeIds })).toBe(true);
        expect(posted).toHaveLength(1);
        expect(posted[0].targetOrigin).toBe("https://host.test");
        const message = posted[0].message as { type: string; ask: { source: string; canvasId: string; canvasTitle: string; nodes: { id: string; title: string; type: string }[] } };
        expect(message.type).toBe("beeftv:ask");
        expect(message.ask.source).toBe("selection-toolbar");
        expect(message.ask.canvasId).toBe("canvas-1");
        expect(message.ask.canvasTitle).toBe("第一场");
        expect(message.ask.nodes).toHaveLength(20);
        expect(message.ask.nodes[0]).toEqual({ id: "n1", title: "主".repeat(80), type: "image" });
        expect(message.ask.nodes.map((node) => node.id)).not.toContain("n21");
        expect(message.ask.nodes.at(-1)?.id).toBe("n20");
    });

    test("单独打开 BeefTV 时不发消息，页面继续走内置助手", () => {
        const { posted } = installBrowserWindow({ embedded: false });
        expect(publishSelectionAsk({ canvasId: "canvas-1", canvasTitle: "第一场", nodes: [{ id: "n1", title: "节点", type: "image" }], selectedNodeIds: ["n1"] })).toBe(false);
        expect(posted).toHaveLength(0);
    });

    test("右侧只提示 blocked 和 unavailable", () => {
        const { parent } = installBrowserWindow();
        const notices: string[] = [];
        const handler = createEmbeddedAskResultHandler((text) => notices.push(text));
        const event = (status: unknown, source: unknown = parent) => handler({ source, data: { type: "beeftv:ask-result", status } } as MessageEvent);

        event("applied");
        event("preserved");
        event("blocked");
        event("unavailable");
        event("blocked", {});
        expect(notices).toEqual(["右侧正在发送，稍后再点", "右侧对话还没准备好，稍后再点"]);
        expect(parseEmbeddedAskResult({ type: "beeftv:ask-result", status: "blocked" })).toBe("blocked");
        expect(parseEmbeddedAskResult({ type: "beeftv:ask-result", status: "unknown" })).toBeNull();
        expect(embeddedAskResultNotice("applied")).toBeNull();
        expect(embeddedAskResultNotice("preserved")).toBeNull();
    });
});

describe("工作区同步不拉走页面", () => {
    function syncWindow() {
        return installBrowserWindow().parent;
    }

    test("刷新目标画布并提示，但不自动跳转，点「打开」才进入", async () => {
        const parent = syncWindow();
        const calls: string[] = [];
        const notices: EmbeddedCanvasNotice[] = [];
        const handler = createEmbeddedWorkspaceSyncHandler({
            getPathname: () => "/assets",
            hydrateProjects: () => { calls.push("hydrate"); },
            syncExtensions: () => { calls.push("extensions"); },
            openCanvas: async (canvasId) => { calls.push(`open:${canvasId}`); },
            refreshCanvas: async (canvasId) => { calls.push(`refresh:${canvasId}`); },
            markExternalChange: (canvasId) => { calls.push(`external:${canvasId}`); },
            findCanvasTitle: () => "雨夜街道",
            canNotify: () => true,
            openCanvasInUi: (canvasId) => { calls.push(`navigate:${canvasId}`); },
            notifyCanvasChange: (notice) => { notices.push(notice); },
        });

        handler({ source: parent, data: { type: "beeftv:workspace-sync", activity: { kind: "canvas-created", canvasId: "canvas-1" } } } as MessageEvent);
        await flushAsyncWork();

        expect(calls).not.toContain("navigate:canvas-1");
        expect(calls).toEqual(["hydrate", "open:canvas-1", "refresh:canvas-1", "external:canvas-1"]);
        expect(notices).toHaveLength(1);
        expect(notices[0].text).toBe("DSH 新建了画布「雨夜街道」");
        notices[0].onOpen();
        expect(calls).toContain("navigate:canvas-1");
    });

    test("正在打开的同一张画布不提示", async () => {
        const parent = syncWindow();
        const notices: EmbeddedCanvasNotice[] = [];
        const handler = createEmbeddedWorkspaceSyncHandler({
            getPathname: () => "/canvas/canvas-1",
            hydrateProjects: () => {},
            syncExtensions: () => {},
            openCanvas: async () => {},
            refreshCanvas: async () => {},
            markExternalChange: () => {},
            findCanvasTitle: () => "雨夜街道",
            canNotify: () => true,
            openCanvasInUi: () => {},
            notifyCanvasChange: (notice) => { notices.push(notice); },
        });
        handler({ source: parent, data: { type: "beeftv:workspace-sync", activity: { kind: "canvas-updated", canvasId: "canvas-1" } } } as MessageEvent);
        await flushAsyncWork();
        expect(notices).toHaveLength(0);
    });

    test("找不到画布名称时用通用文案", () => {
        expect(embeddedCanvasNoticeText("canvas-created", undefined)).toBe("DSH 新建了一张画布");
        expect(embeddedCanvasNoticeText("canvas-updated", "  ")).toBe("DSH 修改了一张画布");
        expect(embeddedCanvasNoticeText("canvas-updated", "第二场")).toBe("DSH 修改了画布「第二场」");
        expect(embeddedCanvasNoticeText("workspace-updated", "第二场")).toBeNull();
        expect(currentCanvasIdFromPath("/canvas/a%20b")).toBe("a b");
        expect(currentCanvasIdFromPath("/assets")).toBeNull();
    });

    test("同一张画布 30 秒内只提示一次", () => {
        let now = 1_000;
        const gate = createEmbeddedCanvasNoticeGate(EMBEDDED_CANVAS_NOTICE_INTERVAL_MS, () => now);
        expect(gate.allow("canvas-1")).toBe(true);
        now += 29_999;
        expect(gate.allow("canvas-1")).toBe(false);
        expect(gate.allow("canvas-2")).toBe(true);
        now += 1;
        expect(gate.allow("canvas-1")).toBe(true);
    });
});
