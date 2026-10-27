// 本地预览服务：起一个只回放超分能力的模拟 API，再启动 Vite 开发服务器。
// 只用于把真实组件渲染成可截图的页面，不参与产品构建、不连真实后端。
const webDir = new URL("..", import.meta.url).pathname;

const capabilities = {
    cloudProcessing: true,
    maxVideoDurationMs: 300000,
    modes: [
        { mediaType: "image", mode: "precision", models: ["Standard V2"], scales: [1, 2, 3, 4], outputFormats: ["png", "jpeg"] },
        { mediaType: "image", mode: "generative", models: ["Standard V2"], scales: [1, 2, 3, 4], outputFormats: ["png", "jpeg"] },
        { mediaType: "video", mode: "precision", models: ["Standard V2"], scales: [1, 2], outputFormats: [] },
    ],
};

const api = Bun.serve({
    port: Number(process.env.PREVIEW_API_PORT || 8080),
    fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/media-upscale/capabilities") return Response.json({ code: 0, data: capabilities });
        if (path === "/api/media-upscale/estimate") {
            return Response.json({ code: 0, data: { mediaType: "image", source: { width: 100, height: 100 }, output: { width: 200, height: 200 }, currency: "CNY", reservation: 1.25, generationSubmitted: false, cloudProcessing: true } });
        }
        if (path.startsWith("/api/")) return Response.json({ code: 0, data: [] });
        return new Response("not found", { status: 404 });
    },
});

const port = process.env.PREVIEW_WEB_PORT || "3100";
const vite = Bun.spawn(["node_modules/.bin/vite", "--host", "127.0.0.1", "--port", port], { cwd: webDir, stdout: "inherit", stderr: "inherit" });
console.log(`preview api on http://127.0.0.1:${api.port} , vite pid ${vite.pid}`);
await vite.exited;
api.stop(true);
