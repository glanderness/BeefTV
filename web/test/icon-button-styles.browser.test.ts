import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { startUIFoundationServer } from "../scripts/serve-ui-foundation.mjs";

let server: Awaited<ReturnType<typeof startUIFoundationServer>>;
let browser: Browser;
const path = import.meta.dir + "/fixtures/icon-button-style-baseline.json";
const update = process.env.BEEFTV_UPDATE_ICON_BASELINE === "1";
if (update && process.env.CI) throw new Error("CI cannot update the IconButton baseline");
const baseline: Record<string, unknown> = update ? {} : JSON.parse(readFileSync(path, "utf8"));

beforeAll(async () => {
    server = await startUIFoundationServer();
    browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (update && Object.keys(baseline).length === 8) writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
});

async function settle(page: Page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
                .map((animation) => animation.finished.catch(() => undefined)),
        );
    });
}

async function capture(page: Page, name?: string) {
    const buttons = name ? page.getByRole("button", { name, exact: true }) : page.getByTestId("icon-button-matrix").locator("button");
    return buttons.evaluateAll((buttons) =>
        buttons.map((button) => {
            const read = (element: Element) => {
                const style = getComputedStyle(element);
                return Object.fromEntries(
                    [
                        "display",
                        "flex-shrink",
                        "align-items",
                        "justify-content",
                        "width",
                        "height",
                        "color",
                        "background-color",
                        "border-radius",
                        "border-width",
                        "border-color",
                        "opacity",
                        "pointer-events",
                        "outline-style",
                        "outline-width",
                        "box-shadow",
                        "scale",
                        "padding",
                    ].map((property) => [property, style.getPropertyValue(property)]),
                );
            };
            return { name: button.getAttribute("aria-label"), button: read(button), icon: read(button.querySelector("svg")!) };
        }),
    );
}

for (const scope of ["workspace", "canvas"])
    for (const theme of ["light", "dark"])
        for (const skin of ["classic", "custom"]) {
            test(`${scope}/${theme}/${skin} preserves IconButton variants, states and caller overrides`, async () => {
                const context = await browser.newContext({ viewport: { width: 960, height: 900 }, reducedMotion: "no-preference" });
                const page = await context.newPage();
                const errors: string[] = [];
                page.on("pageerror", (error) => errors.push(error.message));
                try {
                    await page.goto(`${server.url}/?iconMatrix=1&scope=${scope}&theme=${theme}&skin=${skin}`);
                    await page.getByTestId("icon-button-matrix").waitFor();
                    await page.evaluate(() => document.fonts.ready);
                    await settle(page);
                    const results: Record<string, unknown> = { normal: await capture(page) };
                    for (const name of ["ghost/default", "default/default", "outline/default", "solid/default", "danger/default", "override color", "override hover", "composed variants"]) {
                        const button = page.getByRole("button", { name, exact: true });
                        await button.hover();
                        await settle(page);
                        results[`hover:${name}`] = await capture(page, name);
                        await page.mouse.down();
                        try {
                            await settle(page);
                            results[`pressed:${name}`] = await capture(page, name);
                        } finally {
                            await page.mouse.up();
                        }
                    }
                    await page.mouse.move(0, 0);
                    for (const name of ["ghost/default", "override focus", "exported variants"]) {
                        const button = page.getByRole("button", { name, exact: true });
                        await button.focus();
                        await page.keyboard.press("Shift+Tab");
                        await page.keyboard.press("Tab");
                        expect(await button.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
                        await settle(page);
                        results[`focus:${name}`] = await capture(page, name);
                    }
                    await page.evaluate(() => {
                        (document.activeElement as HTMLElement)?.blur();
                        document.documentElement.style.fontSize = "20px";
                    });
                    await settle(page);
                    results.largeRootFont = await capture(page);
                    const key = `${scope}/${theme}/${skin}`;
                    if (!update) expect(results).toEqual(baseline[key]);
                    expect(await page.getByRole("button", { name: "decorative active", exact: true }).getAttribute("aria-pressed")).toBeNull();
                    const count = page.getByRole("button", { name: "matrix count", exact: true });
                    await count.click();
                    await count.press("Enter");
                    await count.press("Space");
                    await page.getByRole("button", { name: "matrix disabled", exact: true }).click({ force: true });
                    await page.getByRole("button", { name: "matrix loading", exact: true }).click({ force: true });
                    expect(await page.getByRole("status", { name: "matrix clicks", exact: true }).textContent()).toBe("3");
                    expect(await page.getByRole("status", { name: "matrix submits", exact: true }).textContent()).toBe("0");
                    await page.getByRole("button", { name: "explicit submit", exact: true }).click();
                    expect(await page.getByRole("status", { name: "matrix submits", exact: true }).textContent()).toBe("1");
                    expect(errors).toEqual([]);
                    if (update) baseline[key] = results;
                } finally {
                    await context.close();
                }
            }, 60_000);
        }

test("public variants override preceding layout utilities in cn", async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    try {
        await page.goto(`${server.url}/?iconMatrix=1&iconPrefix=1&scope=canvas`);
        const button = page.getByRole("button", { name: "prepended variants", exact: true });
        await button.waitFor();
        expect(await button.evaluate((element) => element.classList.contains("grid"))).toBe(false);
        expect(
            await button.evaluate((element) => {
                const style = getComputedStyle(element);
                return { display: style.display, shrink: style.flexShrink, align: style.alignItems, justify: style.justifyContent };
            }),
            // The fixture's flex parent blockifies inline-flex to the computed flex.
        ).toEqual({ display: "flex", shrink: "0", align: "center", justify: "center" });
    } finally {
        await page.close();
    }
}, 30_000);
