import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelProtocolBrowser } from "@/components/model-protocol-browser";
import { modelProtocolLabel } from "@/lib/model-protocols";
import { providerCatalogDefinition } from "@/services/api/plugin-catalog";

const catalog = [
    { id: "newapi", version: "2.0.1", name: "OpenAI Videos / Sora", vendor: "BeefTV", categories: ["video"], scopes: ["user.custom-channel"], create: "POST /v1/videos", contentType: "multipart/form-data", enabled: true, retired: true, retiredReason: "1 个已保存的连接或模型配置仍在使用该协议" },
    { id: "video-generations-json", version: "1.0.0", name: "视频生成 JSON", vendor: "BeefTV", categories: ["video"], scopes: ["user.custom-channel"], create: "POST /v1/video/generations", contentType: "application/json", enabled: true },
].map(providerCatalogDefinition);

function radioFor(html: string, protocol: string) {
    return html.match(new RegExp(`<input[^>]*value="${protocol}"[^>]*>`))?.[0] || "";
}

describe("retired protocol plugins", () => {
    test("a protocol kept only for saved configuration still resolves but cannot be newly selected", () => {
        const retired = catalog.find((item) => item.value === "newapi");
        expect(retired).toBeDefined();
        expect(retired?.retired).toBe(true);
        expect(retired?.retiredReason).toContain("已保存的连接");
        // Saved configuration keeps its protocol name and request details.
        expect(modelProtocolLabel("newapi", catalog)).toBe("OpenAI Videos / Sora");

        const html = renderToStaticMarkup(<ModelProtocolBrowser protocols={catalog} value="newapi" capability="video" />);
        expect(html).not.toContain("不在可用目录");
        expect(html).toContain("OpenAI Videos / Sora");
        const saved = radioFor(html, "newapi");
        expect(saved).toContain("checked");
        expect(saved).toContain("disabled");
        // A protocol the release still ships stays selectable.
        const shipped = radioFor(html, "video-generations-json");
        expect(shipped).not.toContain("disabled");
    });
});
