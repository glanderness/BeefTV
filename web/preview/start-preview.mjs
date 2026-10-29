// 本地预览服务：起一个只回放超分能力的模拟 API，再启动 Vite 开发服务器。
// 只用于把真实组件渲染成可截图的页面，不参与产品构建。
//
// 前端 API 入口与 Vite 代理在这里被显式固定到这个模拟服务：
//   1. 子进程环境先剔除所有继承来的 VITE_* 变量（含 VITE_API_PROXY_TARGET / VITE_CANVAS_BACKEND_URL /
//      VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT），再写入固定值，避免继承值或 web/.env* 把请求改道。
//   2. 代理目标取自模拟服务实际监听的端口（api.port），改 PREVIEW_API_PORT 时代理跟着改。
//   3. 模拟服务给每个响应打 X-Preview-Api: mock，启动后自检 /api 是否命中模拟服务。
const webDir = new URL("..", import.meta.url).pathname;

const apiPort = Number(process.env.PREVIEW_API_PORT || 8080);
const port = process.env.PREVIEW_WEB_PORT || "3100";
const base = `http://127.0.0.1:${port}`;

const capabilities = {
    cloudProcessing: true,
    maxVideoDurationMs: 300000,
    modes: [
        { mediaType: "image", mode: "precision", models: ["Standard V2"], scales: [1, 2, 3, 4], outputFormats: ["png", "jpeg"] },
        { mediaType: "image", mode: "generative", models: ["Standard V2"], scales: [1, 2, 3, 4], outputFormats: ["png", "jpeg"] },
        { mediaType: "video", mode: "precision", models: ["Standard V2"], scales: [1, 2], outputFormats: [] },
    ],
};

const served = [];

const api = Bun.serve({
    port: apiPort,
    fetch(request) {
        const path = new URL(request.url).pathname;
        served.push(`${request.method} ${path}`);
        console.log(`[preview-api] ${request.method} ${path}`);
        const json = data => Response.json({ code: 0, data }, { headers: { "X-Preview-Api": "mock" } });
        if (path === "/api/media-upscale/capabilities") return json(capabilities);
        if (path === "/api/media-upscale/estimate") {
            return json({ mediaType: "image", source: { width: 100, height: 100 }, output: { width: 200, height: 200 }, currency: "CNY", reservation: 1.25, generationSubmitted: false, cloudProcessing: true });
        }
        if (path.startsWith("/api/")) return json([]);
        return new Response("not found", { status: 404, headers: { "X-Preview-Api": "mock" } });
    },
});

// 继承环境里的 VITE_* 一律不带给 Vite：前端入口与代理只认下面这组固定值。
const inheritedViteKeys = Object.keys(process.env).filter(key => key.startsWith("VITE_"));
const childEnv = { ...process.env };
for (const key of inheritedViteKeys) delete childEnv[key];
Object.assign(childEnv, {
    // 代理固定到模拟服务实际监听的端口；前端 API 入口固定为同源 /api。
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${api.port}`,
    VITE_CANVAS_BACKEND_URL: "/api",
    // 预览页不启动桌面宿主，不携带桌面启动令牌。
    VITE_DESKTOP_LAUNCH_TOKEN: "",
});

const vite = Bun.spawn(["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", port], {
    cwd: webDir,
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
});
console.log(`preview api on http://127.0.0.1:${api.port} (proxy pinned to api.port) , vite pid ${vite.pid} , page ${base}/preview/visible-client-brand.html`);
if (inheritedViteKeys.length) console.log(`[preview] 已丢弃继承的 VITE_* 变量：${inheritedViteKeys.join(", ")}`);

// 自检：/api 必须由模拟服务应答，否则说明代理没固定住。
async function checkProxy() {
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const response = await fetch(`${base}/api/media-upscale/capabilities`);
            const marker = response.headers.get("x-preview-api");
            console.log(marker === "mock" ? "[preview] 代理自检通过：/api 命中模拟服务" : `[preview] 代理自检失败：/api 未命中模拟服务（X-Preview-Api=${marker}）`);
            return;
        } catch {
            await Bun.sleep(500);
        }
    }
    console.log("[preview] 代理自检失败：Vite 未就绪");
}
void checkProxy();

await vite.exited;
api.stop(true);
console.log(`[preview-api] 共应答 ${served.length} 个请求：\n${served.map(line => `  ${line}`).join("\n")}`);