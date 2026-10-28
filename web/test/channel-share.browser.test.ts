import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { createModelChannel, defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { serializeChannel } from "../src/pages/settings/channel-share";

const custom = createModelChannel({ id: "share-test", name: "Share Test", baseUrl: "https://models.example.com/v1", apiKey: "synthetic-key", secretKey: "synthetic-secret", headers: [{ name: "X-Test", value: "synthetic-header" }], models: ["chat-old"], modelProfiles: [{ model: "chat-old", capability: "text", protocol: "chat-completion" }] });
const initial: AiConfig = { ...defaultConfig, channels: [custom, createModelChannel({ id: "beefapi", pinned: true }), createModelChannel({ id: "fal-topaz-upscale", models: ["topaz/upscale/image"] })] };
let saved: AiConfig;
let writes = 0;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const shots = import.meta.dir + "/../../.local/cache/channel-share-shots";
beforeEach(() => { saved = structuredClone(initial); writes = 0; });

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/channel-share-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const cssPath = import.meta.dir + "/../src/styles/globals.css";
    const css = (await postcss([tailwind({ base: import.meta.dir + "/.." })]).process(readFileSync(cssPath, "utf8"), { from: cssPath })).css
        + readFileSync(import.meta.dir + "/../src/styles/beeftv-local-overrides.css", "utf8")
        + readFileSync(import.meta.dir + "/../src/styles/workspace-product.css", "utf8")
        + (await build.outputs.find((output) => output.path.endsWith(".css"))?.text() || "");
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path.endsWith("/workspace/model-config")) {
            if (req.method === "GET") return ok({ config: saved, revision: writes });
            saved = (await req.json()).config; writes++;
            return ok({ saved: true, revision: writes });
        }
        if (path.endsWith("/plugins/catalog")) return ok({ providers: [{ id: "chat-completion", name: "Chat", version: "1", vendor: "OpenAI", categories: ["text"], scopes: ["user.custom-channel"], enabled: true, authType: "bearer" }] });
        if (path.endsWith("/beefapi/connection")) return ok({ state: "disconnected", hasCredential: false });
        if (path.startsWith("/api/")) return ok({});
        return new Response('<html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
    mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

async function newPage(options?: Parameters<Browser["newPage"]>[0]) {
    const page = await browser.newPage(options);
    page.setDefaultTimeout(6000);
    return page;
}

async function openImport(page: Page, json: string) {
    await page.getByRole("button", { name: /^导\s*入$/ }).click();
    await page.getByRole("textbox", { name: "渠道 JSON", exact: true }).fill(json);
    await page.getByRole("button", { name: "校验配置", exact: true }).click();
    await page.getByRole("button", { name: "打开编辑器", exact: true }).waitFor();
}
async function waitForSave(page: Page, predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await page.waitForTimeout(50);
    expect(predicate()).toBe(true);
}

test("browser download, delete, file import, fill key, save and reload", async () => {
    const page = await newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    try {
        await page.goto(server.url.toString());
        expect(await page.getByRole("button", { name: /^导\s*出$/ }).count()).toBe(1);
        await page.getByRole("button", { name: /^导\s*出$/ }).click();
        const downloadPromise = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "导出文件", exact: true }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("Share Test.beeftv-channel.json");
        const exported = await Bun.file((await download.path())!).text();
        expect(exported).not.toContain("synthetic-");
        expect(exported).not.toContain('"headers"');
        await page.getByRole("button", { name: "删除渠道 Share Test", exact: true }).click();
        await page.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
        await waitForSave(page, () => !saved.channels.some((channel) => channel.id === custom.id));
        await page.getByRole("button", { name: /^导\s*入$/ }).click();
        await page.locator('input[type="file"]').setInputFiles({ name: download.suggestedFilename(), mimeType: "application/json", buffer: Buffer.from(exported) });
        await page.waitForFunction(() => Boolean((document.getElementById("channel-import-json") as HTMLTextAreaElement)?.value));
        await page.getByRole("button", { name: "校验配置", exact: true }).click();
        await page.getByRole("textbox", { name: "API Key", exact: true }).fill("synthetic-new-key");
        await page.getByRole("button", { name: "导入并保存", exact: true }).click();
        await waitForSave(page, () => saved.channels.some((channel) => channel.id === custom.id && channel.apiKey === "synthetic-new-key"));
        await page.reload();
        await page.getByRole("button", { name: /^导\s*出$/ }).waitFor();
        expect(saved.channels.filter((channel) => channel.id === custom.id)).toHaveLength(1);
        expect(saved.channels.find((channel) => channel.id === custom.id)?.headers).toEqual([]);
    } catch (error) {
        console.error((await page.locator("body").innerText()).slice(-3500));
        await page.screenshot({ path: `${shots}/flow-failure.png`, fullPage: true });
        throw error;
    } finally { await page.close(); }
}, 30000);

test("same ID preview is non-persistent; saving updates models without losing local credentials", async () => {
    const page = await newPage();
    try {
        await page.goto(server.url.toString());
        const envelope = JSON.parse(serializeChannel(custom));
        envelope.channel.models = ["chat-new"];
        envelope.channel.modelProfiles = [{ model: "chat-new", capability: "text", protocol: "chat-completion" }];
        envelope.channel.baseUrl = "https://updated.example.com/v1";
        const json = JSON.stringify(envelope);
        await openImport(page, json);
        await page.getByText("服务地址将更改，后续请求会向新地址发送保留的本地凭证。", { exact: true }).waitFor();
        const beforeCancel = writes;
        await page.getByRole("button", { name: "打开编辑器", exact: true }).click();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        expect(writes).toBe(beforeCancel);
        expect(saved.channels.find((channel) => channel.id === custom.id)?.models).toEqual(["chat-old"]);
        await openImport(page, json);
        await page.getByRole("button", { name: "打开编辑器", exact: true }).click();
        await page.getByRole("button", { name: "保存并使用", exact: true }).click();
        await waitForSave(page, () => saved.channels.some((channel) => channel.id === custom.id && channel.models[0] === "chat-new"));
        await page.reload();
        await page.getByRole("button", { name: /^导\s*出$/ }).waitFor();
        expect(saved.channels.filter((channel) => channel.id === custom.id)).toHaveLength(1);
        expect(saved.channels.find((channel) => channel.id === custom.id)).toMatchObject({ apiKey: custom.apiKey, secretKey: custom.secretKey, headers: custom.headers, baseUrl: envelope.channel.baseUrl, models: ["chat-new"] });
    } finally { await page.close(); }
}, 30000);

test("Wails save bridge and copy JSON use the sanitized export", async () => {
    const page = await newPage();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
        const target = window as unknown as { go: unknown; __artifact?: { name: string; data: string } };
        target.go = { main: { DesktopApp: { SaveOwnedArtifact: async (name: string, data: string) => { target.__artifact = { name, data }; return true; } } } };
    });
    try {
        await page.goto(server.url.toString());
        await page.getByRole("button", { name: /^导\s*出$/ }).click();
        await page.getByRole("menuitem", { name: "导出文件", exact: true }).click();
        await page.waitForFunction(() => Boolean((window as unknown as { __artifact?: unknown }).__artifact));
        const artifact = await page.evaluate(() => (window as unknown as { __artifact: { name: string; data: string } }).__artifact);
        const json = Buffer.from(artifact.data, "base64").toString("utf8");
        expect(artifact.name).toBe("Share Test.beeftv-channel.json");
        expect(json).not.toContain("synthetic-");
        await page.getByRole("button", { name: /^导\s*出$/ }).click();
        await page.getByRole("menuitem", { name: "复制 JSON", exact: true }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        // The Windows clipboard may convert LF to CRLF; the shared configuration must stay identical.
        expect(JSON.parse(copied)).toEqual(JSON.parse(json));
    } finally { await page.close(); }
}, 30000);

test("import errors and controls fit light and dark themes at 390px", async () => {
    for (const theme of ["light", "dark"]) {
        const page = await newPage({ viewport: { width: 390, height: 844 } });
        try {
            await page.goto(`${server.url}?theme=${theme}`);
            await page.getByRole("button", { name: /^导\s*入$/ }).click();
            await page.getByRole("textbox", { name: "渠道 JSON", exact: true }).fill("{");
            await page.getByRole("button", { name: "校验配置", exact: true }).click();
            await page.getByText("JSON 格式不正确，请检查后重试", { exact: true }).waitFor();
            await page.screenshot({ path: `${shots}/${theme}-import-390.png`, fullPage: true });
            const dialog = await page.getByRole("dialog").boundingBox();
            expect(dialog!.x).toBeGreaterThanOrEqual(0);
            expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(391);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.getByRole("button", { name: "关闭导入模型渠道", exact: true }).click();
            for (const name of ["问题诊断", "拉取全部渠道模型", "导入", "添加模型服务", "导出"]) {
                const rect = await page.getByRole("button", { name: new RegExp(`^${name.split("").join("\\s*")}$`) }).boundingBox();
                expect(rect!.x).toBeGreaterThanOrEqual(0);
                expect(rect!.x + rect!.width).toBeLessThanOrEqual(391);
            }
            await page.screenshot({ path: `${shots}/${theme}-channels-390.png`, fullPage: true });
        } finally { await page.close(); }
    }
}, 30000);
