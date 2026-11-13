import { describe, expect, test } from "bun:test";

import { createEagleAssetSource } from "../src/lib/plugins/builtin/eagle";
import { eagleDownloadFileName } from "../src/pages/plugins/eagle";
import { downloadEagleItem, downloadEagleThumbnail } from "../src/services/api/eagle";
import { apiBaseURL, configureApiRuntime } from "../src/services/api/request";
import type { Asset } from "../src/stores/use-asset-store";

describe("Eagle desktop authenticated media transport", () => {
    test("thumbnail, original file download, and backend media write-back attach X-Desktop-Token", async () => {
        const previousBase = apiBaseURL;
        const seenRequests: Array<{ path: string; baseUrl: string | null; token: string | null }> = [];
        let uploadedPayload: Record<string, unknown> | null = null;

        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
                const url = new URL(request.url);
                const token = request.headers.get("x-desktop-token");
                seenRequests.push({ path: url.pathname, baseUrl: url.searchParams.get("baseUrl"), token });
                if (token !== "desktop-launch-secret") {
                    return new Response(JSON.stringify({ code: 403, msg: "桌面运行时授权无效", reason: "desktop_token_required" }), {
                        status: 403,
                        headers: { "content-type": "application/json; charset=utf-8" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/item-1/thumbnail") {
                    return new Response(new Uint8Array([137, 80, 78, 71]), {
                        status: 200,
                        headers: { "content-type": "image/png" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/item-1/file") {
                    return new Response("original-eagle-bytes", {
                        status: 200,
                        headers: { "content-type": "image/webp" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/missing/file") {
                    return new Response(JSON.stringify({ code: 404, msg: "Eagle 原文件不存在或已被移除" }), {
                        status: 404,
                        headers: { "content-type": "application/json; charset=utf-8" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items/html-err/file") {
                    return new Response("<html>502 Bad Gateway</html>", {
                        status: 502,
                        headers: { "content-type": "text/html" },
                    });
                }
                if (url.pathname === "/api/resources/res-video-1/file") {
                    return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
                        status: 200,
                        headers: { "content-type": "video/mp4" },
                    });
                }
                if (url.pathname === "/api/plugins/eagle/items" && request.method === "POST") {
                    uploadedPayload = (await request.json()) as Record<string, unknown>;
                    return new Response(JSON.stringify({ code: 0, msg: "ok", data: { item: { id: "eagle-written-1" } } }), {
                        status: 200,
                        headers: { "content-type": "application/json; charset=utf-8" },
                    });
                }
                return new Response("not found", { status: 404 });
            },
        });

        configureApiRuntime(`http://127.0.0.1:${server.port}/api`, "desktop-launch-secret");
        try {
            const eagleUrl = "http://127.0.0.1:41595";
            const thumb = await downloadEagleThumbnail("item-1", eagleUrl);
            expect(thumb.size).toBe(4);

            const original = await downloadEagleItem("item-1", eagleUrl);
            expect(await original.text()).toBe("original-eagle-bytes");

            await expect(downloadEagleItem("missing", eagleUrl)).rejects.toThrow("Eagle 原文件不存在或已被移除");
            await expect(downloadEagleItem("html-err", eagleUrl)).rejects.toThrow("读取 Eagle 素材失败");

            const source = createEagleAssetSource(eagleUrl);
            const generatedVideo: Asset = {
                id: "asset-v1",
                kind: "video",
                title: "成片镜头",
                coverUrl: "",
                tags: ["镜头"],
                createdAt: "2026-11-13T00:00:00.000Z",
                updatedAt: "2026-11-13T00:00:00.000Z",
                data: {
                    url: `http://127.0.0.1:${server.port}/api/resources/res-video-1/file`,
                    width: 1280,
                    height: 720,
                    bytes: 8,
                    mimeType: "video/mp4",
                },
            };
            const written = await source.uploadAsset!(generatedVideo);
            expect(written.id).toBe("eagle-written-1");
            expect(uploadedPayload).toMatchObject({ name: "成片镜头.mp4" });
            expect(String(uploadedPayload?.url || "").startsWith("data:video/mp4;base64,")).toBe(true);
            expect(seenRequests.every((entry) => entry.token === "desktop-launch-secret")).toBe(true);
        } finally {
            configureApiRuntime(previousBase);
            await server.stop(true);
        }
    });

    test("eagleDownloadFileName preserves extension when missing from item title", () => {
        expect(eagleDownloadFileName({ title: "参考海报", metadata: { extension: "png" } })).toBe("参考海报.png");
        expect(eagleDownloadFileName({ title: "参考海报.webp", metadata: { extension: "webp" } })).toBe("参考海报.webp");
        expect(eagleDownloadFileName({ title: "  ", metadata: { extension: ".mp4" } })).toBe("eagle-asset.mp4");
    });
});
