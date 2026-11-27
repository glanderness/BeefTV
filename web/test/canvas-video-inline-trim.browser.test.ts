import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

import { readStyleSheet } from "./helpers/app-styles";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/canvas-video-inline-trim-harness.tsx"],
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
            name: "inline-trim-fixture",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({
                    path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir),
                }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({
                    contents: "export default ''",
                    loader: "js",
                }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    const css = readStyleSheet("../src/styles/globals/canvas/canvas-zoom-and-video-trim.css");
    const html = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}${css}</style><div id="root"></div><script src="/harness.js"></script>`;
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(script, { headers: { "Content-Type": "application/javascript" } })
            : new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });
    browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("supports manual start/end/duration entry, Backspace safety, Escape cancel, and direct confirm", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 420 } });
    try {
        await page.goto(`${server.url}?width=520&durationMs=30080`);

        // 1. Click duration chip (30.08 s), use Backspace, type 30, press Enter -> exact 30.00 s.
        await page.getByRole("button", { name: /所选片段时长 30\.08 s/ }).click();
        const durationInput = page.getByRole("textbox", { name: "输入片段时长（秒）" });
        await durationInput.waitFor();
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Delete");
        await durationInput.fill("30");
        await page.keyboard.press("Enter");

        await page.getByRole("button", { name: /^片段终点 00:30\.00/ }).waitFor();
        await page.getByRole("button", { name: /^所选片段时长 30\.00 s/ }).waitFor();
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "")).toContain("所选片段时长 30.00 s");
        expect(await page.getByTestId("canvas-delete-count").textContent()).toBe("0");

        // 2. Edit start point to 1.5s -> duration updates to 28.50 s.
        await page.getByRole("button", { name: /片段起点 00:00\.00/ }).click();
        const startInput = page.getByRole("textbox", { name: "输入片段起点时间" });
        await startInput.fill("1.5");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: /片段起点 00:01\.50/ }).waitFor();
        await page.getByRole("button", { name: /所选片段时长 28\.50 s/ }).waitFor();

        // 3. Edit duration to 30 while start is 1.5s -> shifts start to 00:00.08 and end to 00:30.08.
        await page.getByRole("button", { name: /所选片段时长 28\.50 s/ }).click();
        const durationInput2 = page.getByRole("textbox", { name: "输入片段时长（秒）" });
        await durationInput2.fill("30");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: /片段起点 00:00\.08/ }).waitFor();
        await page.getByRole("button", { name: /片段终点 00:30\.08/ }).waitFor();

        // 4. ArrowUp/ArrowDown nudging inside input (+0.10s / Shift +1s / Alt -0.01s) and Escape discard.
        await page.getByRole("button", { name: /^片段起点 00:00\.08/ }).click();
        const startInput2 = page.getByRole("textbox", { name: "输入片段起点时间" });
        await page.keyboard.press("ArrowUp");
        expect(await startInput2.inputValue()).toBe("00:00.18");
        await page.keyboard.press("Alt+ArrowDown");
        expect(await startInput2.inputValue()).toBe("00:00.17");
        await startInput2.fill("9");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: /^片段起点 00:00\.17/ }).waitFor();
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "")).toContain("片段起点 00:00.17");

        // 5. Typing into end field and clicking confirm directly commits the typed value.
        await page.getByRole("button", { name: /^片段起点 00:00\.17/ }).click();
        await page.getByRole("textbox", { name: "输入片段起点时间" }).fill("0");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: /^片段终点 00:30\.08/ }).click();
        await page.getByRole("textbox", { name: "输入片段终点时间" }).fill("30");
        await page.getByRole("button", { name: "确认剪辑" }).click();

        expect(JSON.parse((await page.getByTestId("confirmed-result").textContent())!)).toEqual({
            startMs: 0,
            endMs: 30_000,
            durationMs: 30_080,
        });
    } finally {
        await page.close();
    }
});

test("snaps end handle drag to 30.00s and supports Shift fine drag and keyboard arrows", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 420 } });
    try {
        await page.goto(`${server.url}?width=520&durationMs=30080`);
        const endHandle = page.getByRole("button", { name: "调整片段终点" });
        const box = (await endHandle.boundingBox())!;

        // 1px drag left on a ~320px track snaps right to 30.00 s instead of skipping past it.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 1, box.y + box.height / 2, { steps: 1 });
        await page.mouse.up();
        await page.getByRole("button", { name: /所选片段时长 30\.00 s/ }).waitFor();

        // Keyboard arrow nudges in normal trim mode: ArrowLeft = -0.10s, Alt+ArrowRight = +0.01s.
        await endHandle.focus();
        await page.keyboard.press("ArrowLeft");
        await page.getByRole("button", { name: /片段终点 00:29\.90/ }).waitFor();
        await page.keyboard.press("Alt+ArrowRight");
        await page.getByRole("button", { name: /片段终点 00:29\.91/ }).waitFor();

        // Shift fine drag moves at 1/5 sensitivity without snapping back to 30.00s.
        const box2 = (await endHandle.boundingBox())!;
        await page.keyboard.down("Shift");
        await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
        await page.mouse.down();
        await page.mouse.move(box2.x + box2.width / 2 + 2, box2.y + box2.height / 2, { steps: 2 });
        await page.mouse.up();
        await page.keyboard.up("Shift");
        const endText = await page.getByRole("button", { name: /^片段终点 / }).textContent();
        expect(endText).not.toBe("00:30.00");
        expect(endText).not.toBe("00:29.91");
    } finally {
        await page.close();
    }
});
