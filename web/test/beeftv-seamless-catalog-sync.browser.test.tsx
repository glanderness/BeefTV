import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

let serverState = {
    configRevision: 5,
    catalogVersion: 1,
    catalogConfigRevision: 5,
    catalogSyncing: true,
    models: ["hy-image-v3"],
    hyPrice: 0.2,
    putWrites: 0,
    syncCalls: 0,
};

function currentModelConfig() {
    return {
        channelMode: "remote",
        baseUrl: "https://beeftv.app",
        apiKey: "",
        apiFormat: "openai",
        channels: [
            {
                id: "beeftv",
                name: "BeefTV",
                baseUrl: "https://beeftv.app",
                apiKey: "",
                apiFormat: "openai",
                scope: "user",
                pinned: true,
                enabled: true,
                credentialRef: "beeftv",
                hasApiKey: true,
                models: [...serverState.models],
                modelProfiles: serverState.models.map((id) => ({
                    model: id,
                    capability: "image",
                    protocol: "openai-image",
                })),
            },
        ],
        imageModel: "beeftv::hy-image-v3",
    };
}

beforeAll(async () => {
    const bundle = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/beeftv-seamless-sync-harness.tsx"],
        target: "browser",
        define: {
            "import.meta.env.DEV": "true",
            "import.meta.env.PROD": "false",
            "import.meta.env.MODE": '"development"',
            "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
            "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
            "process.env.NODE_ENV": '"development"',
        },
        plugins: [{
            name: "source",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            },
        }],
    });
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs.find((output) => output.path.endsWith(".js"))!.text();

    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/api/workspace/model-config") {
                if (req.method === "PUT") {
                    serverState.putWrites += 1;
                    serverState.configRevision += 1;
                    return Response.json({ code: 0, data: { saved: true, revision: serverState.configRevision } });
                }
                return Response.json({
                    code: 0,
                    data: {
                        config: currentModelConfig(),
                        revision: serverState.configRevision,
                        health: "ready",
                        source: "builtin+local",
                    },
                });
            }
            if (path === "/api/beeftv/connection") {
                return Response.json({
                    code: 0,
                    data: {
                        state: "connected",
                        hasCredential: true,
                        account: { id: "42", username: "ender", display_name: "Ender" },
                        catalogRevision: serverState.catalogVersion,
                        catalogConfigRevision: serverState.catalogConfigRevision,
                        catalogSyncing: serverState.catalogSyncing,
                    },
                });
            }
            if (path === "/api/beeftv/connection/sync" && req.method === "POST") {
                serverState.syncCalls += 1;
                return Response.json({
                    code: 0,
                    data: {
                        state: "connected",
                        hasCredential: true,
                        account: { id: "42", username: "ender", display_name: "Ender" },
                        catalogRevision: serverState.catalogVersion,
                        catalogConfigRevision: serverState.catalogConfigRevision,
                        catalogSyncing: serverState.catalogSyncing,
                    },
                });
            }
            if (path === "/api/ops/generation.estimate") {
                const amount = serverState.hyPrice;
                const label = `预计 ¥${amount}`;
                return Response.json({
                    code: 0,
                    data: {
                        operation: "generation.estimate",
                        result: {
                            items: [{ amount, label, basis: `¥${amount}/张 × 1 张`, text: `${label}（¥${amount}/张 × 1 张）` }],
                            summary: { amount, priced: 1, unknown: 0, text: `预计费用：¥${amount}` },
                        },
                    },
                });
            }
            if (path.startsWith("/api/")) return Response.json({ code: 0, data: {} });
            return new Response('<!doctype html><html><meta name="viewport" content="width=device-width"><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("启动后台同步、用户写配置不掩盖目录更新、切回前台调价热更新无感生效且不丢焦点", async () => {
    serverState = {
        configRevision: 5,
        catalogVersion: 1,
        catalogConfigRevision: 5,
        catalogSyncing: true,
        models: ["hy-image-v3"],
        hyPrice: 0.2,
        putWrites: 0,
        syncCalls: 0,
    };

    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    try {
        await page.goto(server.url.href);
        await page.waitForFunction(() => document.querySelector('[data-testid="hydrated-flag"]')?.textContent === "yes");
        await page.waitForFunction(() => document.querySelector('[data-testid="generation-cost-badge"]')?.textContent === "预计 ¥0.2");
        expect(await page.getByTestId("image-models").textContent()).toBe("beeftv::hy-image-v3");

        // Keep user actively editing inside the prompt textarea during background updates.
        const textarea = page.getByTestId("prompt-input");
        await textarea.fill("我的镜头描述，持续输入中");
        await textarea.focus();

        // 1. Startup background sync writes catalogVersion 1 -> 2 (file rev 6), AND an unrelated
        //    user config edit bumps file rev 6 -> 7 before the next poll arrives.
        //    The dedicated catalogRevision must NOT be masked by the user's higher file revision!
        await page.getByTestId("user-edit-btn").click();
        await page.waitForFunction(() => true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(serverState.putWrites).toBe(1);
        const putsAfterUserEdit = serverState.putWrites;
        await textarea.focus();

        serverState.models = ["hy-image-v3", "gpt-image-2.5"];
        serverState.catalogVersion = 2;
        serverState.catalogConfigRevision = 6; // deliberately LOWER than user's configRevision (7+)!
        serverState.catalogSyncing = false;

        await page.waitForFunction(
            () => (document.querySelector('[data-testid="image-models"]')?.textContent || "").includes("beeftv::gpt-image-2.5"),
            undefined,
            { timeout: 4000 },
        );
        expect(await page.getByTestId("catalog-revision").textContent()).toBe("2");
        // Hot-reloading the catalog must NOT trigger any extra PUT writeback!
        expect(serverState.putWrites).toBe(putsAfterUserEdit);
        // Active input focus and edited text must remain completely untouched.
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid"))).toBe("prompt-input");
        expect(await textarea.inputValue()).toBe("我的镜头描述，持续输入中");

        // 2. Server updates ONLY price (model count stays 2) and bumps catalogVersion 2 -> 3.
        //    Trigger window focus -> frontend calls POST /beeftv/connection/sync -> price badge updates automatically!
        serverState.hyPrice = 0.45;
        serverState.catalogVersion = 3;
        serverState.configRevision += 1;
        serverState.catalogConfigRevision = serverState.configRevision;

        await page.evaluate(() => {
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
        });

        await page.waitForFunction(
            () => document.querySelector('[data-testid="generation-cost-badge"]')?.textContent === "预计 ¥0.45",
            undefined,
            { timeout: 4000 },
        );
        // Simultaneous focus + visibilitychange should coalesce to a single sync request.
        expect(serverState.syncCalls).toBe(1);
        expect(serverState.putWrites).toBe(putsAfterUserEdit);
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid"))).toBe("prompt-input");
        expect(errors).toEqual([]);
    } finally {
        await page.close();
    }
}, 30000);
