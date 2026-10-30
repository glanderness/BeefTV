import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCache, extractStyle, StyleProvider } from "@ant-design/cssinjs";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { SkillInstallForm } from "../src/pages/skills/skill-install-form";

test("import errors wrap inside the narrow dialog instead of creating horizontal scroll", async () => {
    const cache = createCache();
    const html = renderToStaticMarkup(createElement(StyleProvider, { cache }, createElement(SkillInstallForm, {
        id: "narrow-import", mode: "zip", installing: false, localRuntime: true,
    })));
    const controlCss = await Bun.file(new URL("../src/styles/workspace-controls.css", import.meta.url)).text();
    const importCss = await Bun.file(new URL("../src/pages/skills/skill-install.css", import.meta.url)).text();
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => Boolean(p && existsSync(p)));
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
        const page = await browser.newPage({ viewport: { width: 642, height: 828 } });
        // Modal centering supplies nowrap; the error field must establish its own wrapping.
        await page.setContent(`<style>body{margin:0}.dialog{width:570px;white-space:nowrap}.body{overflow:auto}</style>
            ${extractStyle(cache)}<style>${controlCss}\n${importCss}</style><div class="dialog"><div class="body">${html}</div></div>`);
        const result = await page.evaluate(() => {
            const control = document.querySelector(".ant-form-item-control")!;
            const error = document.createElement("div");
            error.className = "ant-form-item-explain-error";
            error.textContent = "技能包中缺少 SKILL.md。请检查所选文件及格式后重新安装。".repeat(5);
            control.append(error);
            const body = document.querySelector(".body")!;
            return { overflow: body.scrollWidth > body.clientWidth, wraps: error.getBoundingClientRect().height > 25 };
        });
        expect(result).toEqual({ overflow: false, wraps: true });
    } finally {
        await browser.close();
    }
}, 30_000);
