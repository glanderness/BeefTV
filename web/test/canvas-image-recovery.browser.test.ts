import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

test("生成图片拉取失败显示重试，点击后恢复图片，明暗主题和窄屏均可操作", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-image-recovery-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"' },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    let downloads = 0;
    let failureMode = "transport";
    const server = Bun.serve({ port: 0, fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/api/resources/preview/file") {
            if (++downloads === 1) return failureMode === "transport" ? new Response("temporarily unavailable", { status: 503 }) : new Response("invalid image bytes", { headers: { "Content-Type": "image/png" } });
            return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: {}, msg: "" });
        return new Response('<style>#root>div>div{height:100%}#root img{width:100%;height:100%}</style><div id=root></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const scenario of [{ theme: "light", mode: "transport" }, { theme: "dark", mode: "decode" }]) {
            const { theme, mode } = scenario;
            failureMode = mode;
            downloads = 0;
            const context = await browser.newContext({ viewport: { width: 390, height: 500 } });
            const page = await context.newPage();
            page.on("pageerror", (error) => console.error(error.message));
            await page.goto(`${server.url}?theme=${theme}`);
            await page.getByText("图片加载失败", { exact: true }).waitFor({ timeout: 7000 });
            await page.getByRole("button", { name: "重新加载" }).click();
            await page.waitForFunction(() => Boolean(document.querySelector("img")?.naturalWidth));
            expect(await page.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(16);
            expect(downloads).toBe(2);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await context.close();
        }
    } finally { await browser.close(); server.stop(true); }
}, 60000);
