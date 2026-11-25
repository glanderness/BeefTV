import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildProtocolBrowserOptions, ModelProtocolBrowser } from "@/components/model-protocol-browser";
import type { ModelProtocolDefinition } from "@/lib/model-protocols";
import { protocolGuidanceForCapability } from "@/pages/settings/channel-model-settings";

const VIDEO_PROTOCOLS: ModelProtocolDefinition[] = [
    {
        value: "agnes-video",
        label: "Agnes Video 2.5 / 2.5 Flash",
        vendor: "影策 / Open AI Canvas contributors",
        capability: "video",
        create: "POST /videos",
        poll: "GET /agnesapi?video_id={id}",
        contentType: "application/json",
        media: "影策 / Open AI Canvas contributors · 1.0.0",
        baseUrl: "https://apihub.agnes-ai.com/v1",
        authType: "bearer",
        description: "Agnes Video 2.5 / 2.5 Flash 独立请求协议插件。",
        enabled: true,
    },
    {
        value: "autodl-comfyui",
        label: "AutoDL ComfyUI 视频",
        vendor: "BeefTV Contributors",
        capability: "video",
        create: "POST /api/v1/comfyui/comfyui_workflow/{model}",
        poll: "GET /api/v1/comfyui/status/{task_id}",
        contentType: "application/json",
        media: "BeefTV Contributors · 1.0.0",
        baseUrl: "https://autodl.art",
        authType: "header",
        description: "通过 AutoDL.Art ComfyUI 工作流 API 接入异步视频生成",
        workflows: [{ id: "wf-1", label: "图生视频工作流", providerId: "autodl-comfyui", capability: "video", parameters: [] }],
        enabled: true,
    },
    {
        value: "baidu-video",
        label: "百度千帆视频",
        vendor: "影策 / Open AI Canvas contributors",
        capability: "video",
        create: "POST /v2/video/generations",
        poll: "GET /v2/video/generations/{task_id}",
        contentType: "application/json",
        media: "影策 / Open AI Canvas contributors · 1.0.0",
        baseUrl: "https://qianfan.baidubce.com",
        authType: "bearer",
        description: "百度千帆视频 独立请求协议插件。",
        enabled: true,
    },
    {
        value: "dashscope-wan-video",
        label: "DashScope Wan Video",
        vendor: "影策 / Open AI Canvas contributors",
        capability: "video",
        create: "POST /api/v1/services/aigc/video-generation/video-synthesis",
        poll: "GET /api/v1/tasks/{task_id}",
        contentType: "application/json",
        media: "影策 / Open AI Canvas contributors · 1.0.0",
        baseUrl: "https://dashscope.aliyuncs.com",
        authType: "bearer",
        description: "DashScope Wan Video 独立请求协议插件。",
        enabled: true,
    },
    {
        value: "ll2-seedance-video",
        label: "LL2 Seedance 2.0 Video",
        vendor: "BeefTV",
        capability: "video",
        create: "POST /seedance/api/v3/contents/generations/tasks",
        poll: "GET /seedance/api/v3/contents/generations/tasks/{task_id}",
        contentType: "application/json",
        media: "BeefTV · 1.1.1",
        baseUrl: "https://api.ll2.cn",
        authType: "bearer",
        enabled: true,
    },
    {
        value: "newapi",
        label: "OpenAI Videos / Sora",
        vendor: "影策 / Open AI Canvas contributors",
        capability: "video",
        create: "POST /v1/videos",
        poll: "GET /v1/videos/{task_id}",
        contentType: "multipart/form-data",
        media: "影策 / Open AI Canvas contributors · 1.0.0",
        baseUrl: "https://api.openai.com",
        authType: "bearer",
        enabled: true,
    },
    {
        value: "newapi-channel-2",
        label: "NewAPI Video Generations Channel 2",
        vendor: "影策 / Open AI Canvas contributors",
        capability: "video",
        create: "POST /v1/video/generations",
        poll: "GET /v1/video/generations/{task_id}",
        contentType: "application/json",
        media: "影策 / Open AI Canvas contributors · 1.0.0",
        baseUrl: "http://127.0.0.1:3000",
        authType: "bearer",
        enabled: true,
    },
    {
        value: "video-generations-json",
        label: "视频生成 JSON · ratio / duration",
        vendor: "BeefTV Contributors",
        capability: "video",
        create: "POST /v1/video/generations",
        poll: "GET /v1/video/generations/{task_id}",
        contentType: "application/json",
        media: "BeefTV Contributors · 1.0.0",
        authType: "bearer",
        description: "使用 images、ratio、duration 的异步视频 JSON 协议。",
        enabled: true,
    },
];

describe("ModelProtocolBrowser grouping and endpoint guidance", () => {
    test("groups common generic protocols before vendor-specific, partner, and workflow protocols", () => {
        const html = renderToStaticMarkup(
            <ModelProtocolBrowser
                capability="video"
                value="dashscope-wan-video"
                protocols={VIDEO_PROTOCOLS}
            />,
        );

        expect(html).toContain("常用与通用兼容");
        expect(html).toContain("官方与厂商专用接口");
        expect(html).toContain("预置合作渠道专用");
        expect(html).toContain("本地与工作流接口");

        // Common / generic protocols must appear before alphabetical vendor protocols like Agnes / Baidu / DashScope.
        const genericIdx = html.indexOf("NewAPI Video Generations Channel 2");
        const openaiVideoIdx = html.indexOf("OpenAI Videos / Sora");
        const agnesIdx = html.indexOf("Agnes Video 2.5 / 2.5 Flash");
        const ll2Idx = html.indexOf("LL2 Seedance 2.0 Video");
        const autodlIdx = html.indexOf("AutoDL ComfyUI 视频");

        expect(genericIdx).toBeGreaterThan(-1);
        expect(openaiVideoIdx).toBeGreaterThan(-1);
        expect(agnesIdx).toBeGreaterThan(genericIdx);
        expect(agnesIdx).toBeGreaterThan(openaiVideoIdx);
        expect(ll2Idx).toBeGreaterThan(genericIdx);
        expect(autodlIdx).toBeGreaterThan(genericIdx);

        // Should replace generic contributor boilerplate in row tags with meaningful host / partner hints.
        expect(html).not.toContain(">影策 / Open AI Canvas contributors<");
        expect(html).toContain("dashscope.aliyuncs.com");
        expect(html).toContain("qianfan.baidubce.com");
        expect(html).toContain("LL2 (DMC)");

        // Detail pane shows suggested base URL & omits boilerplate plugin suffix description.
        expect(html).toContain("建议地址");
        expect(html).toContain("https://dashscope.aliyuncs.com");
        expect(html).not.toContain("DashScope Wan Video 独立请求协议插件。");
    });

    test("surfaces protocols matching the channel base URL at the top and displays real workflow descriptions", () => {
        const html = renderToStaticMarkup(
            <ModelProtocolBrowser
                capability="video"
                value="autodl-comfyui"
                channelBaseUrl="https://dashscope.aliyuncs.com/compatible-mode/v1"
                protocols={VIDEO_PROTOCOLS}
            />,
        );

        expect(html).toContain("匹配当前服务地址");
        const matchedHeaderIdx = html.indexOf("匹配当前服务地址");
        const dashscopeIdx = html.indexOf("DashScope Wan Video");
        const genericHeaderIdx = html.indexOf("常用与通用兼容");
        expect(matchedHeaderIdx).toBeGreaterThan(-1);
        expect(dashscopeIdx).toBeGreaterThan(matchedHeaderIdx);
        expect(dashscopeIdx).toBeLessThan(genericHeaderIdx);

        // Selected AutoDL ComfyUI shows its real description and base URL in detail pane.
        expect(html).toContain("通过 AutoDL.Art ComfyUI 工作流 API 接入异步视频生成");
        expect(html).toContain("https://autodl.art");
    });

    test("uses declared service presets for host matching and connection guidance", () => {
        const presets = [
            { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com" },
            { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api" },
            { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
        ];
        const protocol: ModelProtocolDefinition = {
            value: "chat-completion",
            label: "OpenAI Chat Completions",
            capability: "text",
            create: "POST /chat/completions",
            contentType: "application/json",
            media: "OpenAI",
            baseUrl: "https://api.openai.com",
            presets,
        };

        for (const preset of presets) {
            const [option] = buildProtocolBrowserOptions([protocol], "text", `${preset.baseUrl}/custom`);
            expect(option?.group).toBe("匹配当前服务地址");
            expect(option?.vendor).toBe(preset.label);
            expect(option?.details.find((detail) => detail.label === "建议地址")?.value).toEqual(<code>{preset.baseUrl}</code>);
            expect(option?.description).toContain("兼容");
        }
        for (const url of ["https://openrouter.ai.example.com/api", "http://localhost:8080/v1"]) {
            expect(buildProtocolBrowserOptions([protocol], "text", url)[0]?.group).toBe("常用与通用兼容");
        }
    });

    test("capability guidance matches the active capability instead of recommending Chat Completions for media", () => {
        expect(protocolGuidanceForCapability("text")).toContain("OpenAI Chat Completions");
        expect(protocolGuidanceForCapability("image")).toContain("OpenAI Images");
        expect(protocolGuidanceForCapability("image")).not.toContain("OpenAI Chat Completions");
        expect(protocolGuidanceForCapability("video")).not.toContain("OpenAI Chat Completions");
        expect(protocolGuidanceForCapability("video")).toContain("常用与通用兼容");
        expect(protocolGuidanceForCapability("audio")).toContain("OpenAI Audio Speech");
        expect(protocolGuidanceForCapability("audio")).not.toContain("OpenAI Chat Completions");
    });

    test("classifies local loopback, presets-backed, and arbitrary-port loopback relay protocols without hardcoded ID lists or :3000 heuristics", () => {
        const mixedProtocols: ModelProtocolDefinition[] = [
            {
                value: "ollama-chat",
                label: "Ollama Chat",
                vendor: "BeefTV Contributors",
                capability: "text",
                create: "POST /api/chat",
                contentType: "application/json",
                media: "BeefTV Contributors · 1.0.0",
                baseUrl: "http://127.0.0.1:11434",
                authType: "none",
                enabled: true,
            },
            {
                value: "custom-relay-8080",
                label: "Custom Relay 8080",
                vendor: "BeefTV Contributors",
                capability: "text",
                create: "POST /v1/chat/completions",
                contentType: "application/json",
                media: "BeefTV Contributors · 1.0.0",
                baseUrl: "http://127.0.0.1:8080",
                authType: "bearer",
                enabled: true,
            },
            {
                value: "custom-presets-compat",
                label: "Custom Presets Compat",
                vendor: "BeefTV Contributors",
                capability: "text",
                create: "POST /v1/chat/completions",
                contentType: "application/json",
                media: "BeefTV Contributors · 1.0.0",
                baseUrl: "https://compat.example.com",
                authType: "bearer",
                presets: [{ id: "p1", label: "Example Compat", baseUrl: "https://compat.example.com" }],
                enabled: true,
            },
        ];

        const defaultOptions = buildProtocolBrowserOptions(mixedProtocols, "text");
        const ollamaDefault = defaultOptions.find((item) => item.value === "ollama-chat");
        const relayDefault = defaultOptions.find((item) => item.value === "custom-relay-8080");
        const presetsDefault = defaultOptions.find((item) => item.value === "custom-presets-compat");

        expect(ollamaDefault?.group).toBe("本地与工作流接口");
        expect(ollamaDefault?.details?.some((d) => d.label === "建议地址")).toBe(true);
        expect(relayDefault?.group).toBe("常用与通用兼容");
        expect(relayDefault?.details?.some((d) => d.label === "建议地址")).toBe(false);
        expect(presetsDefault?.group).toBe("常用与通用兼容");

        const ollamaMatched = buildProtocolBrowserOptions(mixedProtocols, "text", "http://127.0.0.1:11434");
        expect(ollamaMatched.find((item) => item.value === "ollama-chat")?.group).toBe("匹配当前服务地址");
        expect(ollamaMatched.find((item) => item.value === "custom-relay-8080")?.group).toBe("常用与通用兼容");

        const relayLoopbackChannel = buildProtocolBrowserOptions(mixedProtocols, "text", "http://127.0.0.1:8080");
        expect(relayLoopbackChannel.find((item) => item.value === "custom-relay-8080")?.group).toBe("常用与通用兼容");
    });
});
