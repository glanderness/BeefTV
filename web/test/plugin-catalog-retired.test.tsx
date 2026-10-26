import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelProtocolBrowser } from "@/components/model-protocol-browser";
import { defaultProtocolForCapability, ensureModelProfilesWithUiDefaults, modelProtocolLabel, selectableProtocol } from "@/lib/model-protocols";
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

    test("a retired protocol never becomes the default of a new model", () => {
        // "newapi-channel-2" is first in the standard video order; "openai-image"
        // is the only standard image protocol. Retiring those two is the case where
        // a missing filter would still pick the retired value.
        const retiredVideo = { value: "newapi-channel-2", label: "Channel 2", capability: "video" as const, create: "POST /v1/video/generations", contentType: "application/json", media: "内置协议", enabled: true, retired: true };
        const shippedVideo = { value: "newapi", label: "OpenAI Videos", capability: "video" as const, create: "POST /v1/videos", contentType: "multipart/form-data", media: "内置协议", enabled: true };
        expect(selectableProtocol(retiredVideo)).toBe(false);
        expect(selectableProtocol(shippedVideo)).toBe(true);
        expect(defaultProtocolForCapability("video", [retiredVideo, shippedVideo])).toBe("newapi");
        // The same list without the retirement marker keeps the standard order.
        expect(defaultProtocolForCapability("video", [{ ...retiredVideo, retired: false }, shippedVideo])).toBe("newapi-channel-2");

        const retiredImage = { value: "openai-image", label: "OpenAI Images", capability: "image" as const, create: "POST /v1/images/generations", contentType: "application/json", media: "内置协议", enabled: true, retired: true };
        const shippedImage = { value: "gemini-image", label: "Gemini Images", capability: "image" as const, create: "POST /v1/images", contentType: "application/json", media: "内置协议", enabled: true };
        expect(defaultProtocolForCapability("image", [retiredImage, shippedImage])).toBe("gemini-image");
        expect(defaultProtocolForCapability("image", [{ ...retiredImage, retired: false }, shippedImage])).toBe("openai-image");

        // A saved model keeps the protocol it already stores ...
        const saved = ensureModelProfilesWithUiDefaults(["gpt-image-3"], [{ model: "gpt-image-3", capability: "image", protocol: "openai-image" }], [retiredImage, shippedImage]);
        expect(saved[0]?.protocol).toBe("openai-image");
        // ... while a new model is assigned a selectable one.
        const fresh = ensureModelProfilesWithUiDefaults(["gpt-image-3"], undefined, [retiredImage, shippedImage]);
        expect(fresh[0]?.protocol).toBe("gemini-image");
    });
});
