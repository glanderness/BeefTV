import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "playwright";

import { CanvasNodeContent } from "@/components/canvas/canvas-node-content";
import { CanvasVideoCropEditor } from "@/components/canvas/canvas-video-crop-dialog";
import { CanvasImageCropEditor } from "@/components/canvas/canvas-node-crop-dialog";
import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
}, 30_000);

afterAll(async () => { await browser?.close(); }, 30_000);

const layout = `
    <style>
        body { margin: 0; background: #111; color: white; }
        #world { position: absolute; top: 80px; left: 100px; transform-origin: top left; }
        #node { position: relative; display: flex; align-items: center; justify-content: center; width: 700px; height: 400px; overflow: visible; }
        .absolute { position: absolute; }
        .relative { position: relative; }
        .inset-0 { inset: 0; }
        .left-1\\/2 { left: 50%; }
        .bottom-3 { bottom: 12px; }
        .top-1\\.5 { top: 6px; }
        .left-1\\.5 { left: 6px; }
        .size-3 { width: 12px; height: 12px; }
        .size-5 { width: 20px; height: 20px; }
        .size-8 { width: 32px; height: 32px; }
        .h-11 { height: 44px; }
        .flex { display: flex; }
        .items-center { align-items: center; }
        .grid { display: grid; }
        .place-items-center { place-items: center; }
        .gap-2 { gap: 8px; }
        .px-1\\.5 { padding-left: 6px; padding-right: 6px; }
        .py-0\\.5 { padding-top: 2px; padding-bottom: 2px; }
        .text-\\[10px\\] { font-size: 10px; }
        .text-xs { font-size: 12px; }
        .-translate-x-1\\/2 { transform: translateX(-50%); }
        .-translate-y-1\\/2 { transform: translateY(-50%); }
        .generation-failure-notice { display: flex; flex-direction: column; gap: 6px; }
        .generation-failure-reason, .generation-failure-action { margin: 0; font-size: 10px; line-height: 1.55; }
        .generation-failure-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .generation-failure-button { min-height: 32px; font-size: 11px; }
        .overflow-hidden { overflow: hidden; }
        .overflow-visible { overflow: visible; }
        .overflow-y-auto { overflow-y: auto; }
        .pointer-events-none { pointer-events: none; }
        .px-3 { padding-left: 12px; padding-right: 12px; }
        .py-2 { padding-top: 8px; padding-bottom: 8px; }
    </style>
`;

async function setZoom(zoom: number) {
    await page.locator("#world").evaluate((element, scale) => {
        const world = element as HTMLElement;
        world.style.transform = `scale(${scale})`;
        world.style.setProperty("--canvas-live-scale", String(scale));
        world.style.setProperty("--canvas-live-inverse-scale", String(1 / scale));
    }, zoom);
}

test("video crop controls stay legible and clickable at 20% zoom", async () => {
    const markup = renderToStaticMarkup(<CanvasVideoCropEditor videoUrl="data:video/mp4;base64,AAAA" videoDimensions={{ width: 1920, height: 1080 }} onCancel={() => {}} onConfirm={() => {}} />);
    await page.setContent(`${layout}<div id="world"><div id="node">${markup}</div></div>`);
    await setZoom(1);
    const fullSizeSelection = await page.locator(".cursor-move").boundingBox();
    await setZoom(0.2);

    const toolbar = await page.getByRole("button", { name: "取消裁切" }).boundingBox();
    const handle = await page.getByRole("button", { name: "resize-nw" }).boundingBox();
    const zoomedSelection = await page.locator(".cursor-move").boundingBox();
    const label = page.locator("[data-video-crop-inline] span").first();
    expect(toolbar?.height).toBeGreaterThanOrEqual(30);
    expect(handle?.width).toBeGreaterThanOrEqual(16);
    expect(await label.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(12);
    expect(zoomedSelection!.width / fullSizeSelection!.width).toBeCloseTo(0.2, 2);
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 });
    expect(hit).toBe("resize-nw");
    const nodeBox = await page.locator("#node").boundingBox();
    expect(toolbar!.y).toBeGreaterThanOrEqual(nodeBox!.y + nodeBox!.height + 8);
    const confirm = await page.getByRole("button", { name: "确认裁切" }).boundingBox();
    const toolbarHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"), { x: confirm!.x + confirm!.width / 2, y: confirm!.y + confirm!.height / 2 });
    expect(toolbarHit).toBe("确认裁切");
});

test("image crop controls remain screen-sized and outside the image at 20% zoom", async () => {
    const markup = renderToStaticMarkup(<CanvasImageCropEditor imageUrl="data:image/png;base64,AAAA" imageDimensions={{ width: 1200, height: 800 }} onCancel={() => {}} onConfirm={() => {}} />);
    await page.setContent(`${layout}<div id="world"><div id="node">${markup}</div></div>`);
    await setZoom(0.2);

    const nodeBox = await page.locator("#node").boundingBox();
    const cancel = await page.getByRole("button", { name: "取消裁切" }).boundingBox();
    const confirm = await page.getByRole("button", { name: "确认裁切" }).boundingBox();
    const handle = await page.getByRole("button", { name: "resize-nw" }).boundingBox();
    const label = page.locator("[data-image-crop-inline] span").first();
    expect(cancel!.height).toBeGreaterThanOrEqual(30);
    expect(handle!.width).toBeGreaterThanOrEqual(16);
    expect(await label.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(12);
    expect(cancel!.y).toBeGreaterThanOrEqual(nodeBox!.y + nodeBox!.height + 8);
    expect(confirm!.y).toBeGreaterThanOrEqual(nodeBox!.y + nodeBox!.height + 8);
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 });
    expect(hit).toBe("resize-nw");
    const toolbarHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"), { x: confirm!.x + confirm!.width / 2, y: confirm!.y + confirm!.height / 2 });
    expect(toolbarHit).toBe("确认裁切");
});

test("failed node notice stays readable without overflowing its node at 20% zoom", async () => {
    const node = {
        id: "failed-video", type: CanvasNodeType.Video, title: "视频 2", position: { x: 0, y: 0 }, width: 700, height: 400,
        metadata: { status: "error", errorDetails: "模型服务请求失败，请检查账户余额后重试" },
    } as CanvasNodeData;
    const markup = renderToStaticMarkup(<CanvasNodeContent node={node} theme={canvasThemes.dark} isEditingContent={false} textareaRef={createRef<HTMLTextAreaElement>()} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} onContentChange={() => {}} onStopEditing={() => {}} mentionReferences={[]} onRetry={() => {}} />);
    await page.setContent(`${layout}<div id="world"><div id="node">${markup}</div></div>`);
    await setZoom(0.2);

    const reason = page.locator(".generation-failure-reason");
    const textHeight = await reason.evaluate((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return element.getBoundingClientRect().height / Math.max(1, element.clientHeight / lineHeight);
    });
    const nodeBox = await page.locator("#node").boundingBox();
    expect(await page.locator(".canvas-node-error-content").count()).toBe(1);
    const noticeBox = await page.locator(".canvas-node-error-content").boundingBox();
    expect(textHeight).toBeGreaterThanOrEqual(12);
    expect(noticeBox).not.toBeNull();
    expect(noticeBox!.width).toBeLessThanOrEqual(nodeBox!.width + 1);
    expect(noticeBox!.height).toBeLessThanOrEqual(nodeBox!.height + 1);
    const scroll = await page.locator(".canvas-node-error-content").evaluate((element) => {
        element.scrollTop = 100;
        return { visibleHeight: element.clientHeight, totalHeight: element.scrollHeight, top: element.scrollTop };
    });
    expect(scroll.totalHeight).toBeGreaterThan(scroll.visibleHeight);
    expect(scroll.top).toBeGreaterThan(0);
});

test("crop toolbar remains inside a narrow viewport at 20% zoom", async () => {
    await page.setViewportSize({ width: 360, height: 480 });
    const markup = renderToStaticMarkup(<CanvasVideoCropEditor videoUrl="data:video/mp4;base64,AAAA" videoDimensions={{ width: 1920, height: 1080 }} onCancel={() => {}} onConfirm={() => {}} />);
    await page.setContent(`${layout}<div id="world"><div id="node">${markup}</div></div>`);
    await setZoom(0.2);
    const cancel = await page.getByRole("button", { name: "取消裁切" }).boundingBox();
    const confirm = await page.getByRole("button", { name: "确认裁切" }).boundingBox();
    expect(cancel!.x).toBeGreaterThanOrEqual(0);
    expect(confirm!.x + confirm!.width).toBeLessThanOrEqual(360);
    await page.setViewportSize({ width: 1100, height: 700 });
});
