import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { readAppGlobalsSource } from "./helpers/app-styles";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const appCss = readAppGlobalsSource();

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/model-picker-disabled-reason-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "false",
            "import.meta.env.PROD": "true",
            "import.meta.env.MODE": '"production"',
            "process.env.NODE_ENV": '"production"',
        },
        plugins: [
            {
                name: "source",
                setup(builder) {
                    builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
                    builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
                    builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((o) => o.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find((o) => o.path.endsWith(".css"))?.text()) || "";
    server = Bun.serve({
        port: 0,
        fetch(req) {
            const path = new URL(req.url).pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/harness.css") return new Response(appCss + "\n" + css, { headers: { "Content-Type": "text/css" } });
            return new Response('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', {
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
}, 30_000);

test("canvas provider model picker renders visible disabled reason for text-to-image-only models", async () => {
    const page = await browser.newPage({ viewport: { width: 520, height: 420 } });
    try {
        await page.goto(new URL("/?variant=canvas&theme=dark", server.url).toString());
        await page.locator(".canvas-composer-model-picker").click();
        const disabledOption = page.locator('button[role="option"]', { hasText: "MOSS Image" });
        await disabledOption.waitFor({ state: "visible" });
        expect(await disabledOption.isDisabled()).toBe(true);
        expect(await disabledOption.getAttribute("aria-disabled")).toBe("true");
        expect(await disabledOption.getAttribute("aria-description")).toBe("仅支持文生图，不支持图片重绘");

        const reason = disabledOption.locator(".provider-model-disabled-reason");
        await reason.waitFor({ state: "visible" });
        expect((await reason.innerText()).trim()).toBe("仅支持文生图");
        const box = await reason.boundingBox();
        expect(box?.height || 0).toBeGreaterThan(8);
        expect(box?.width || 0).toBeGreaterThan(20);
        const disabledStyles = await disabledOption.evaluate((el) => {
            const btnStyle = window.getComputedStyle(el);
            const reasonEl = el.querySelector(".provider-model-disabled-reason") as HTMLElement | null;
            const reasonStyle = reasonEl ? window.getComputedStyle(reasonEl) : null;
            return {
                buttonOpacity: btnStyle.opacity,
                reasonColor: reasonStyle?.color || "",
                reasonOverflow: reasonStyle?.overflow || "",
                reasonTextOverflow: reasonStyle?.textOverflow || "",
            };
        });
        expect(disabledStyles.buttonOpacity).toBe("1");
        expect(disabledStyles.reasonColor).toBe("rgb(163, 163, 163)");
        expect(disabledStyles.reasonOverflow).toBe("hidden");
        expect(disabledStyles.reasonTextOverflow).toBe("ellipsis");

        // Verify enabled model stays single-line without disabled reason element.
        const enabledOption = page.locator('button[role="option"]', { hasText: "Seedream 5.0 Pro" });
        expect(await enabledOption.isDisabled()).toBe(false);
        expect(await enabledOption.locator(".provider-model-disabled-reason").count()).toBe(0);
    } finally {
        await page.close();
    }
}, 20_000);

test("dark canvas under light app keeps high-contrast model labels and disabled reasons", async () => {
    const page = await browser.newPage({ viewport: { width: 520, height: 420 } });
    try {
        await page.goto(new URL("/?variant=canvas&theme=dark&appTheme=light", server.url).toString());
        await page.locator(".canvas-composer-model-picker").click();
        const enabledOption = page.locator('button[role="option"]', { hasText: "Seedream 5.0 Pro" });
        await enabledOption.waitFor({ state: "visible" });
        const enabledColor = await enabledOption.evaluate((el) => window.getComputedStyle(el).color);
        expect(enabledColor).toBe("rgb(237, 237, 237)");

        const disabledReason = page.locator('button[role="option"]', { hasText: "MOSS Image" }).locator(".provider-model-disabled-reason");
        await disabledReason.waitFor({ state: "visible" });
        const reasonColor = await disabledReason.evaluate((el) => window.getComputedStyle(el).color);
        expect(reasonColor).toBe("rgb(163, 163, 163)");
    } finally {
        await page.close();
    }
}, 20_000);

test("creation model picker renders visible disabled reason for text-to-image-only models", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 460 } });
    try {
        await page.goto(new URL("/?variant=creation&theme=light", server.url).toString());
        await page.locator(".canvas-composer-model-picker").click();
        await page.locator(".canvas-model-picker-brand", { hasText: "BeefTV 官方" }).click();
        const disabledOption = page.locator('button[role="option"]', { hasText: "MOSS Image" });
        await disabledOption.waitFor({ state: "visible" });
        expect(await disabledOption.isDisabled()).toBe(true);
        expect(await disabledOption.getAttribute("aria-description")).toBe("仅支持文生图，不支持图片重绘");

        const reason = disabledOption.locator(".canvas-model-picker-option-reason");
        await reason.waitFor({ state: "visible" });
        expect((await reason.innerText()).trim()).toBe("仅支持文生图");
        const box = await reason.boundingBox();
        expect(box?.height || 0).toBeGreaterThan(8);
        const creationStyles = await disabledOption.evaluate((el) => {
            const btnStyle = window.getComputedStyle(el);
            const reasonEl = el.querySelector(".canvas-model-picker-option-reason") as HTMLElement | null;
            const reasonStyle = reasonEl ? window.getComputedStyle(reasonEl) : null;
            return {
                buttonOpacity: btnStyle.opacity,
                reasonColor: reasonStyle?.color || "",
                reasonOverflow: reasonStyle?.overflow || "",
                reasonTextOverflow: reasonStyle?.textOverflow || "",
            };
        });
        expect(creationStyles.buttonOpacity).toBe("1");
        expect(creationStyles.reasonColor).toBe("rgb(75, 85, 99)");
        expect(creationStyles.reasonOverflow).toBe("hidden");
        expect(creationStyles.reasonTextOverflow).toBe("ellipsis");
    } finally {
        await page.close();
    }
}, 20_000);
