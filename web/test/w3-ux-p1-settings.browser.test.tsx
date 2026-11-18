import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { productCss } from "./fixtures/product-css";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const stubs: Record<string, string> = {
        "@/services/model-config-repository": "export const flushModelConfig=async()=>{}; export const getModelConfigPersistenceState=()=>({dirty:false,status:'ready'});",
        "@/services/local-workspace-sync": "export const saveRemoteUserDataNow=async()=>{};",
        "@/components/prompt/prompt-code-editor": "import React from 'react'; export function PromptCodeEditor({ value, ariaLabel, readOnly, onChange }: any) { return React.createElement('textarea', { 'aria-label': ariaLabel, readOnly, value, onChange: (e: any) => onChange?.(e.target.value) }); }",
    };
    const bundle = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/w3-ux-p1-settings-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [{
            name: "source",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) =>
                    args.path in stubs
                        ? { path: args.path, namespace: "stub" }
                        : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) },
                );
                builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
                    contents: stubs[args.path],
                    loader: "tsx",
                    resolveDir: import.meta.dir,
                }));
            },
        }],
    });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = await productCss();

    server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (url.pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (url.pathname === "/api/settings/prompt-templates") {
                return Response.json({ code: 0, data: { preferences: [] } });
            }
            if (url.pathname === "/api/resources/storage-usage") {
                return Response.json({ code: 0, data: { usage: { usedBytes: 0, totalBytes: 1024 ** 3 }, canvasDocumentMB: 64 } });
            }
            if (url.pathname.startsWith("/api/")) {
                return Response.json({ code: 0, data: { items: [] } });
            }
            const isDark = url.searchParams.get("dark") === "1";
            return new Response(
                `<!doctype html><html class="${isDark ? "dark" : ""}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><body class="app-user-overlays app-product-overlays app-spatial-overlays"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`,
                { headers: { "Content-Type": "text/html" } },
            );
        },
    });

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30000);

test("CanvasPresetPicker supports explicit naming on save, inline rename, delete, and keeps action buttons inside popover bounds for long names", async () => {
    const context = await browser.newContext({ viewport: { width: 960, height: 760 } });
    const page = await context.newPage();
    try {
        await page.goto(`${server.url}?view=preset`);
        await page.getByRole("button", { name: "打开提示词预设" }).click();
        const menu = page.locator(".canvas-preset-picker-menu");
        await menu.waitFor();

        // Clicking save opens inline name input pre-filled from first 16 chars of prompt rather than saving immediately
        await menu.getByRole("button", { name: "保存当前提示词为预设" }).click();
        const nameInput = menu.getByRole("textbox", { name: "预设名称" });
        await nameInput.waitFor();
        expect(await nameInput.inputValue()).toBe("柔和侧逆光，35mm电影镜头，雨");

        const ultraLongName = "超长自定义预设名称测试_ABCDEFGHIJKLMNOPQRSTUVWXYZ_连续无空格夜景电影光影构图预设名称一二三四";
        await nameInput.fill(ultraLongName);
        await nameInput.press("Enter");

        const savedName = ultraLongName.slice(0, 40);
        const renameBtn = menu.getByRole("button", { name: `重命名预设 ${savedName}` });
        const deleteBtn = menu.getByRole("button", { name: `删除预设 ${savedName}` });
        await renameBtn.waitFor();
        await deleteBtn.waitFor();

        // Verify neither Pencil nor Trash2 overflows outside the popover menu horizontally
        const geometry = await menu.evaluate((menuEl) => {
            const menuRect = menuEl.getBoundingClientRect();
            const listEl = menuEl.querySelector(".thin-scrollbar") as HTMLElement;
            const buttons = Array.from(menuEl.querySelectorAll('button[aria-label^="重命名预设"], button[aria-label^="删除预设"]'));
            return {
                listOverflowX: listEl.scrollWidth > listEl.clientWidth + 1,
                buttonsInside: buttons.every((btn) => {
                    const rect = btn.getBoundingClientRect();
                    return rect.width >= 20 && rect.left >= menuRect.left && rect.right <= menuRect.right + 1;
                }),
            };
        });
        expect(geometry).toEqual({ listOverflowX: false, buttonsInside: true });

        // Inline rename via Pencil button
        await renameBtn.click();
        const editInput = menu.getByRole("textbox", { name: `编辑预设名称 ${savedName}` });
        await editInput.waitFor();
        await editInput.fill("雨夜霓虹人物近景");
        await menu.getByRole("button", { name: "保存", exact: true }).click();

        const renamedDeleteBtn = menu.getByRole("button", { name: "删除预设 雨夜霓虹人物近景" });
        await renamedDeleteBtn.waitFor();

        // Delete custom preset
        await renamedDeleteBtn.click();
        expect(await renamedDeleteBtn.count()).toBe(0);
    } finally {
        await context.close();
    }
}, 30000);

test("PromptPreferencesPane edits and resets default image and video reverse-prompt instructions", async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 860 } });
    const page = await context.newPage();
    try {
        await page.goto(`${server.url}?view=prompts`);
        const imageTextarea = page.getByRole("textbox", { name: "图片反推指令" });
        const videoTextarea = page.getByRole("textbox", { name: "视频反推指令" });
        await imageTextarea.waitFor();
        await videoTextarea.waitFor();

        const saveBtn = page.getByRole("button", { name: "保存反推指令" });
        const resetBtn = page.getByRole("button", { name: "恢复默认指令" });
        expect(await saveBtn.isDisabled()).toBe(true);
        expect(await resetBtn.isDisabled()).toBe(true);

        await imageTextarea.fill("自定义图片反推模板：输出主体、焦段、光比与材质关键词");
        await videoTextarea.fill("自定义视频反推模板：按镜头顺序输出动作、运镜与环境声");
        expect(await saveBtn.isDisabled()).toBe(false);
        await saveBtn.click();

        await page.getByText("已自定义", { exact: true }).first().waitFor();
        expect(await page.getByText("已自定义", { exact: true }).count()).toBe(2);
        expect(await saveBtn.isDisabled()).toBe(true);
        expect(await resetBtn.isDisabled()).toBe(false);

        // Reload confirms persistence in workspace localStorage
        await page.reload();
        await imageTextarea.waitFor();
        expect(await imageTextarea.inputValue()).toBe("自定义图片反推模板：输出主体、焦段、光比与材质关键词");
        expect(await videoTextarea.inputValue()).toBe("自定义视频反推模板：按镜头顺序输出动作、运镜与环境声");
        expect(await page.getByText("已自定义", { exact: true }).count()).toBe(2);

        // Reset restores built-in defaults
        await resetBtn.click();
        await page.waitForFunction(() => document.querySelectorAll("*").length > 0 && !document.body.textContent?.includes("已自定义"));
        expect(await page.getByText("已自定义", { exact: true }).count()).toBe(0);
        expect(await imageTextarea.inputValue()).toContain("请根据参考图片反推一段适合用于 AI 生图的提示词");
        expect(await videoTextarea.inputValue()).toContain("请根据参考视频拆解并反推一段适合用于 AI 视频生成的结构化提示词");
        expect(await resetBtn.isDisabled()).toBe(true);
    } finally {
        await context.close();
    }
}, 30000);
