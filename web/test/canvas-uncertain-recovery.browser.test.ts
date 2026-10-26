import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const shotDirectory = "/tmp/beeftv-pr-shots/reczz28RZUXaynMg";

// 提交结果未确认的节点：原任务终态后客户端自动取回结果，不给用户添一次点击；
// 只有后端确认结果取不回时才给出「重新生成」出口。结论未定、或结果已保留时，仍然不能出现这个出口。
test("提交结果未确认的节点原任务终态后自动取回，取不回时才给重新生成出口", async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-uncertain-recovery-harness.tsx"],
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"false"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "import.meta.env.VITE_APP_VERSION": '"0.0.0-harness"', "import.meta.env.VITE_BUILD_COMMIT": '"harness"' },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const styles = readFileSync(import.meta.dir + "/../src/styles/globals.css", "utf8").replace(/@import[^;]+;/g, "").replace(/@source[^;]+;/g, "");
    const server = Bun.serve({ port: 0, fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/harness.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
        return new Response('<style>*{box-sizing:border-box}body{margin:0;background:#f4f4f5;font-family:Inter,system-ui,sans-serif}#root{display:flex;justify-content:center;padding:12px}</style><link rel="stylesheet" href="/harness.css"><div id=root></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    mkdirSync(shotDirectory, { recursive: true });
    try {
        const open = async (scenario: string) => {
            const context = await browser.newContext({ viewport: { width: 420, height: 320 }, deviceScaleFactor: 2 });
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${server.url}?case=${scenario}`);
            return { page, context, errors };
        };
        const settled = await open("settled");
        try {
            await settled.page.getByText("原任务已结束，正在取回结果").waitFor({ timeout: 7000 });
            await settled.page.getByText("取回期间不用重新生成；结果取不回时会给出重新生成入口").waitFor();
            // 自动取回期间不给用户点击：不需要用户点，也不该重复提交付费生成。
            expect(await settled.page.getByRole("button", { name: "重新生成" }).count()).toBe(0);
            expect(await settled.page.getByRole("button", { name: "查看原任务" }).count()).toBe(1);
            expect(settled.errors).toEqual([]);
            await settled.page.screenshot({ path: `${shotDirectory}/settled-submission-uncertain.png` });
        } finally { await settled.context.close(); }

        const gone = await open("gone");
        try {
            await gone.page.getByText("原任务已结束，但结果已取不回").waitFor({ timeout: 7000 });
            await gone.page.getByText("可以重新生成；会新建任务，可能再次消耗积分").waitFor();
            const retry = gone.page.getByRole("button", { name: "重新生成" });
            await retry.waitFor();
            await retry.click();
            expect(await gone.page.evaluate(() => (window as { retries: number }).retries)).toBe(1);
            expect(gone.errors).toEqual([]);
            await gone.page.screenshot({ path: `${shotDirectory}/gone-submission-uncertain.png` });
        } finally { await gone.context.close(); }

        const running = await open("running");
        try {
            await running.page.getByText("提交结果尚未确认，上游任务可能仍在执行").waitFor({ timeout: 7000 });
            expect(await running.page.getByRole("button", { name: "重新生成" }).count()).toBe(0);
            expect(await running.page.getByRole("button", { name: "查看原任务" }).count()).toBe(1);
            expect(running.errors).toEqual([]);
            await running.page.screenshot({ path: `${shotDirectory}/unresolved-submission-uncertain.png` });
        } finally { await running.context.close(); }

        const kept = await open("kept");
        try {
            await kept.page.getByText("生成结果还没取回").waitFor({ timeout: 7000 });
            expect(await kept.page.getByRole("button", { name: "重新生成" }).count()).toBe(0);
            const reload = kept.page.getByRole("button", { name: "继续取回" });
            await reload.waitFor();
            await reload.click();
            expect(await kept.page.evaluate(() => (window as { reloads: number }).reloads)).toBe(1);
            expect(kept.errors).toEqual([]);
        } finally { await kept.context.close(); }
    } finally { await browser.close(); server.stop(true); }
}, 60000);
