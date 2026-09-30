import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const globalsCss = await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text();
const workspaceCss = await Bun.file(new URL("../src/styles/workspace-product.css", import.meta.url)).text();
const homeCss = await Bun.file(new URL("../src/pages/home/home-dashboard.css", import.meta.url)).text();

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
}, 30_000);

afterAll(async () => {
    await browser?.close();
}, 30_000);

async function readPalette({ dark, home }: { dark: boolean; home: boolean }) {
    await page.setContent(`
        <html class="${dark ? "dark" : ""}"><head><style>${globalsCss}\n${workspaceCss}\n${homeCss}</style></head>
        <body><div class="app-user-workspace app-product-workspace ${home ? "app-home-route" : ""}">
            <div class="app-workspace-shell">
                <aside class="app-workspace-sidebar"><div class="app-workspace-sidebar-nav"></div><div class="app-workspace-sidebar-footer"></div></aside>
                <div class="app-workspace-stage"><main class="beeftv-home">
                    <div class="beeftv-home-hero"></div><div class="beeftv-capability-icon"></div><div class="beeftv-recent-card"></div>
                </main></div>
            </div>
        </div></body></html>
    `);
    return page.evaluate(() => {
        const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
        return {
            stage: background(".app-workspace-stage"),
            sidebar: background(".app-workspace-sidebar"),
            sidebarNav: background(".app-workspace-sidebar-nav"),
            sidebarFooter: background(".app-workspace-sidebar-footer"),
            hero: background(".beeftv-home-hero"),
            capability: background(".beeftv-capability-icon"),
            recent: background(".beeftv-recent-card"),
        };
    });
}

test("dark home restores the original near-black surfaces without changing other routes or light mode", async () => {
    expect(await readPalette({ dark: true, home: true })).toEqual({
        stage: "rgb(16, 16, 16)",
        sidebar: "rgb(22, 22, 22)",
        sidebarNav: "rgb(22, 22, 22)",
        sidebarFooter: "rgb(22, 22, 22)",
        hero: "rgb(32, 32, 32)",
        capability: "rgb(32, 32, 32)",
        recent: "rgb(22, 22, 22)",
    });
    const darkOtherRoute = await readPalette({ dark: true, home: false });
    expect(darkOtherRoute.stage).toBe("rgb(21, 21, 23)");
    const lightHome = await readPalette({ dark: false, home: true });
    expect(lightHome.stage).toBe("rgb(248, 248, 250)");
});
