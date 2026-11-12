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

async function readPalette({ dark, home, width = 1440 }: { dark: boolean; home: boolean; width?: number }) {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`
        <html class="${dark ? "dark" : ""}"><head><style>${globalsCss}\n${workspaceCss}\n${homeCss}</style></head>
        <body><div class="app-user-workspace app-product-workspace ${home ? "app-home-route" : ""}">
            <div class="app-workspace-shell">
                <aside class="app-workspace-sidebar"><div class="app-workspace-sidebar-nav"></div><div class="app-workspace-sidebar-footer"></div></aside>
                <div class="app-workspace-stage"><main class="beeftv-home">
                    <div class="beeftv-home-hero"></div><div class="beeftv-capability-icon"></div><div class="beeftv-recent-card"></div>
                    <div class="project-library-card"></div><div class="libtv-create-project-card"></div><div class="libtv-folder-card-cover"></div>
                    <div class="assets-library-page"><div class="canvas-library-frame"></div><div class="workspace-expandable-search-input"></div></div>
                    <div class="settings-page"><div class="settings-library-frame"><div class="settings-channel"></div></div></div>
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
            projectCard: background(".project-library-card"),
            projectCreateCard: background(".libtv-create-project-card"),
            assetFrame: background(".assets-library-page .canvas-library-frame"),
            modelFrame: background(".settings-library-frame"),
            modelChannel: background(".settings-channel"),
        };
    });
}

test("dark workspace keeps home, projects, assets and model settings on one near-black palette", async () => {
    const expected = {
        stage: "rgb(16, 16, 16)",
        sidebar: "rgb(22, 22, 22)",
        sidebarNav: "rgb(22, 22, 22)",
        sidebarFooter: "rgb(22, 22, 22)",
        hero: "rgb(32, 32, 32)",
        capability: "rgb(32, 32, 32)",
        recent: "rgb(22, 22, 22)",
        projectCard: "rgb(23, 23, 23)",
        projectCreateCard: "rgb(32, 32, 32)",
        assetFrame: "rgb(22, 22, 22)",
        modelFrame: "rgb(22, 22, 22)",
        modelChannel: "rgb(22, 22, 22)",
    };
    for (const width of [1440, 840]) {
        expect(await readPalette({ dark: true, home: true, width })).toEqual(expected);
        expect(await readPalette({ dark: true, home: false, width })).toEqual(expected);
    }
    const lightHome = await readPalette({ dark: false, home: true });
    expect(lightHome.stage).toBe("rgb(248, 248, 250)");
});

test("dark project folder and asset search do not keep the brighter gray fills", async () => {
    await readPalette({ dark: true, home: false });
    const colors = await page.evaluate(() => ({
        folder: getComputedStyle(document.querySelector(".libtv-folder-card-cover")!).backgroundImage,
        search: getComputedStyle(document.querySelector(".workspace-expandable-search-input")!).backgroundColor,
    }));
    const folderTop = colors.folder.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(folderTop).not.toBeNull();
    expect(Number(folderTop![1])).toBeLessThanOrEqual(48);
    expect(colors.search).toBe("rgb(32, 32, 32)");
});

test("creation reference file card (.is-file) keeps 58x77 layout, 11px filename, full-name tooltip, and no maximize overlay in both themes", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { CreationAttachmentThumbnail } = await import("../src/pages/create/creation-workspace");
    const longFileName = "ambient-soundtrack-extremely-long-reference-audio-clip-v2-final.mp3";
    const cardHtml = renderToStaticMarkup(
        createElement(CreationAttachmentThumbnail, {
            item: {
                id: "aud-long",
                name: longFileName,
                type: "audio/mpeg",
                url: "https://example.com/ambient.mp3",
            },
            onPreview: () => {},
            onRemove: () => {},
        }),
    );

    for (const dark of [true, false]) {
        for (const expanded of [false, true]) {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.setContent(`
                <html class="${dark ? "dark" : ""}"><head><style>${globalsCss}\n${workspaceCss}</style></head>
                <body><div class="app-user-workspace app-product-workspace"><div class="creation-home" style="padding:24px">
                    <div class="creation-reference-track ${expanded ? "is-expanded" : ""}">
                        <div class="creation-reference-stack-card">${cardHtml}</div>
                    </div>
                </div></div></body></html>
            `);
            const metrics = await page.evaluate(() => {
                const card = document.querySelector<HTMLElement>(".creation-reference-stack-card")!;
                const preview = document.querySelector<HTMLElement>(".creation-reference-card-preview.is-file")!;
                const iconWrap = preview.querySelector<HTMLElement>(".creation-chat-file-icon")!;
                const svg = iconWrap.querySelector<SVGElement>("svg")!;
                const nameEl = iconWrap.querySelector<HTMLElement>("em")!;
                const svgRect = svg.getBoundingClientRect();
                const nameRect = nameEl.getBoundingClientRect();
                const wrapStyle = getComputedStyle(iconWrap);
                const nameStyle = getComputedStyle(nameEl);
                return {
                    cardWidth: card.offsetWidth,
                    cardHeight: card.offsetHeight,
                    svgVisible: svgRect.width >= 12 && svgRect.height >= 12,
                    nameVisible: nameRect.width > 20 && nameRect.height >= 11,
                    wrapOpacity: wrapStyle.opacity,
                    wrapPosition: wrapStyle.position,
                    fontSize: nameStyle.fontSize,
                    textOverflow: nameStyle.textOverflow,
                    ariaLabel: preview.getAttribute("aria-label"),
                    title: preview.getAttribute("title"),
                    hasMaximizeOverlay: Boolean(preview.querySelector(".lucide-maximize-2") || document.querySelector('[aria-label^="放大预览"]')),
                };
            });
            expect(metrics).toEqual({
                cardWidth: expanded ? 52 : 58,
                cardHeight: expanded ? 69 : 77,
                svgVisible: true,
                nameVisible: true,
                wrapOpacity: "1",
                wrapPosition: "static",
                fontSize: "11px",
                textOverflow: "ellipsis",
                ariaLabel: longFileName,
                title: longFileName,
                hasMaximizeOverlay: false,
            });
        }
    }
});
