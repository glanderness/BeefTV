import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let originalReads = 0;
let previewReads = 0;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-image-copy-harness.tsx"], target: "browser",
        define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "copy-fixture", setup(builder) {
            builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/api/resources/original/file") { originalReads++; return new Response(png, { headers: { "Content-Type": "image/png" } }); }
        if (path === "/api/resources/missing/file") return new Response("missing original", { status: 500 });
        if (path === "/preview-ok.png") { previewReads++; return new Response(png, { headers: { "Content-Type": "image/png" } }); }
        if (path === "/preview.png") return new Response("preview must not be copied", { status: 500 });
        return new Response('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
    } });
    browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const mode of ["content", "storage"]) {
    test(`copies original image from the node context menu (${mode})`, async () => {
        const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
        const page = await context.newPage();
        try {
            const before = originalReads;
            await page.goto(`${server.url}?mode=${mode}`);
            await page.getByRole("button", { name: "复制图片", exact: true }).click({ timeout: 5000 });
            await page.getByText("图片已复制到剪贴板", { exact: true }).waitFor();
            const result = await page.evaluate(async () => {
                const items = await navigator.clipboard.read();
                const blob = await items[0]!.getType("image/png");
                const image = await createImageBitmap(blob);
                return { types: items[0]!.types, width: image.width, height: image.height };
            });
            expect(result).toEqual({ types: ["image/png"], width: 1, height: 1 });
            expect(originalReads).toBeGreaterThan(before);
            await expect(page.getByRole("button", { name: "复制图片", exact: true }).count()).resolves.toBe(0);
            await page.getByRole("button", { name: "打开菜单" }).click();
            await page.getByRole("button", { name: "复制节点" }).click();
            await page.getByText("节点已复制").waitFor();
        } finally { await context.close(); }
    });
}

test("does not replace a failed image copy with an address", async () => {
    const page = await browser.newPage();
    try {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "clipboard", { value: {
                write: async () => { throw new Error("图片剪贴板写入失败"); },
                writeText: async () => { document.body.dataset.copiedAddress = "true"; },
            } });
        });
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: "复制图片", exact: true }).click({ timeout: 5000 });
        await page.getByText("图片剪贴板写入失败", { exact: true }).waitFor();
        expect(await page.locator("body").getAttribute("data-copied-address")).toBeNull();
    } finally { await page.close(); }
});

test("fails explicitly when original resource read fails instead of silently copying an available preview", async () => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    try {
        const beforePreview = previewReads;
        await page.addInitScript(() => {
            const writes: unknown[] = [];
            (window as any).__clipboardWrites = writes;
            Object.defineProperty(navigator, "clipboard", {
                value: {
                    write: async (items: ClipboardItem[]) => {
                        for (const item of items) {
                            const blob = await item.getType("image/png");
                            writes.push(blob.size);
                        }
                    },
                },
            });
        });
        await page.goto(`${server.url}?mode=missing-original`);
        await page.getByRole("button", { name: "复制图片", exact: true }).click({ timeout: 5000 });
        await page.getByText(/原图资源读取失败|HTTP 500|500|读取失败/).waitFor({ timeout: 5000 });
        expect(previewReads).toBe(beforePreview);
        expect(await page.evaluate(() => (window as any).__clipboardWrites.length)).toBe(0);
    } finally { await context.close(); }
});

test("disables image copy for empty nodes and excludes video nodes", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(`${server.url}?mode=empty`);
        expect(await page.getByRole("button", { name: "复制图片", exact: true }).isDisabled()).toBe(true);
        await page.goto(`${server.url}?mode=video`);
        await page.getByRole("button", { name: "复制节点" }).waitFor();
        expect(await page.getByRole("button", { name: "复制图片", exact: true }).count()).toBe(0);
    } finally { await page.close(); }
});
