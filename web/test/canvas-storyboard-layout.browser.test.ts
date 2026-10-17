import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-storyboard-layout-harness.tsx"], target: "browser", define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "source-alias", setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
        builder.onLoad({ filter: /src\/components\/model-logo\.tsx$/ }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        return new Response('<style>.w-full{width:100%}</style><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

for (const mode of ["light", "dark"]) {
    test(`storyboard fixed cells hide scrolling content in ${mode} mode`, async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 992 } });
        try {
            await page.goto(server.url + "?" + mode);
            await page.getByRole("dialog").waitFor();
            await page.locator(".ant-table-tbody tr.ant-table-row").first().waitFor();
            const checkOpaque = async () => {
                const colors = await page.locator(".ant-table-thead th.ant-table-cell-fix, .ant-table-row td.ant-table-cell-fix").evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).backgroundColor));
                expect(colors.length).toBeGreaterThan(4);
                for (const color of colors) expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
            };
            await checkOpaque();
            await page.locator(".ant-table-tbody tr.ant-table-row").first().getByRole("checkbox").check();
            await page.locator(".ant-table-tbody tr.ant-table-row").nth(1).hover();
            await checkOpaque();
            await page.locator(".ant-table-body").evaluate((body) => { body.scrollLeft = body.scrollWidth; });
            await checkOpaque();
            const layout = await page.locator(".ant-table-tbody tr.ant-table-row").first().evaluate((row) => {
                const cells = [...row.querySelectorAll("td")];
                const actions = cells.at(-1)!.getBoundingClientRect();
                const assets = cells.at(-2)!.getBoundingClientRect();
                const input = row.querySelector(".ant-input-number")!;
                const duration = input.closest("td")!.getBoundingClientRect();
                const field = input.getBoundingClientRect();
                return { assetsRight: assets.right, actionsLeft: actions.left, fieldWidth: field.width, durationWidth: duration.width };
            });
            expect(layout.assetsRight).toBeLessThanOrEqual(layout.actionsLeft + 1);
            expect(layout.fieldWidth).toBeLessThan(layout.durationWidth);
        } finally { await page.close(); }
    }, 15_000);
}
