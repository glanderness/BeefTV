import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-image-copy-harness.tsx"], target: "browser",
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "video-copy-fixture", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "application/javascript" } })
        : new Response('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } }) });
    browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const mode of ["video", "video-storage"]) {
    test(`video context menu copies an owned file using the node name (${mode})`, async () => {
        const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
        try {
            await page.addInitScript(() => {
                window.go = { main: { DesktopApp: { CopyOwnedMediaToClipboard: async (name, id) => {
                    document.body.dataset.copiedVideo = JSON.stringify({ name, id });
                } } } };
            });
            await page.goto(`${server.url}?mode=${mode}`);
            await page.getByRole("button", { name: "复制视频", exact: true }).click({ timeout: 5000 });
            await page.getByText("视频已复制到剪贴板", { exact: true }).waitFor();
            expect(JSON.parse((await page.locator("body").getAttribute("data-copied-video"))!)).toEqual({ name: "场景1.mp4", id: "original" });
            expect(await page.getByRole("button", { name: "复制视频", exact: true }).count()).toBe(0);
            await page.getByRole("button", { name: "打开菜单" }).click();
            await page.getByRole("button", { name: "复制节点" }).click();
            await page.getByText("节点已复制").waitFor();
        } finally { await page.close(); }
    });
}

test("empty video nodes cannot copy and native failure never reports success", async () => {
    const page = await browser.newPage();
    try {
        await page.addInitScript(() => {
            window.go = { main: { DesktopApp: { CopyOwnedMediaToClipboard: async () => { throw new Error("系统剪贴板不可写"); } } } };
        });
        await page.goto(`${server.url}?mode=video-empty`);
        expect(await page.getByRole("button", { name: "复制视频", exact: true }).isDisabled()).toBe(true);
        await page.goto(`${server.url}?mode=video`);
        await page.getByRole("button", { name: "复制视频", exact: true }).click();
        await page.getByText("系统剪贴板不可写", { exact: true }).waitFor();
        expect(await page.getByText("视频已复制到剪贴板", { exact: true }).count()).toBe(0);
    } finally { await page.close(); }
});
