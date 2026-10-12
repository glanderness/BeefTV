import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { McpServerEditorFields, McpServerList, McpSettingsPane, type EditorDraft } from "@/pages/settings/mcp-settings-pane";
import { normalizeMcpServers, type McpServerConfig } from "@/stores/use-config-store";

function draft(overrides: Partial<EditorDraft> = {}): EditorDraft {
    return { id: "", name: "我的工具", transport: "stdio", command: "npx", args: "", url: "", env: [], headers: [], ...overrides };
}

describe("MCP 服务器配置归一化", () => {
    test("保留合法条目，补齐默认字段，并去掉空行", () => {
        const servers = normalizeMcpServers([
            { id: "a", name: "Alpha", transport: "stdio", command: "node", args: ["x.js", "  ", ""], env: [{ name: "TOKEN", value: "s" }, { name: "  " }] },
            { id: "b", transport: "http", url: "https://mcp.example.test/mcp", headers: [{ id: "h", name: "Authorization", value: "t" }] },
        ]);
        expect(servers).toHaveLength(2);
        expect(servers[0]).toMatchObject({ id: "a", name: "Alpha", enabled: true, transport: "stdio", command: "node", args: ["x.js"] });
        expect(servers[0].env).toHaveLength(1);
        expect(servers[0].env?.[0]).toMatchObject({ name: "TOKEN", value: "s" });
        expect(servers[1]).toMatchObject({ id: "b", name: "b", transport: "http", url: "https://mcp.example.test/mcp" });
    });

    test("丢弃缺 id、命令、地址或协议不支持的条目", () => {
        expect(normalizeMcpServers([
            { name: "no id", transport: "stdio", command: "node" },
            { id: "no-command", transport: "stdio" },
            { id: "no-url", transport: "http" },
            { id: "bad-transport", transport: "websocket", command: "node" },
            "nope",
            null,
        ])).toEqual([]);
        expect(normalizeMcpServers("not-an-array")).toEqual([]);
        expect(normalizeMcpServers(undefined)).toEqual([]);
    });
});

describe("MCP 设置面板", () => {
    test("空列表显示引导空态", () => {
        const html = renderToStaticMarkup(createElement(McpSettingsPane));
        expect(html).toContain("还没有 MCP 服务器");
        expect(html).toContain("添加 MCP 服务器");
    });

    test("列出服务器并标注类型", () => {
        const servers: McpServerConfig[] = [
            { id: "a", name: "本地工具", enabled: true, transport: "stdio", command: "node", args: [], env: [], disabledTools: [] },
            { id: "b", name: "远程工具", enabled: false, transport: "http", url: "https://mcp.example.test/mcp", headers: [], disabledTools: [] },
        ];
        const html = renderToStaticMarkup(createElement(McpServerList, {
            servers, probing: [], probes: {}, onToggleEnabled: () => {}, onEdit: () => {}, onProbe: () => {}, onDelete: () => {}, onToggleTool: () => {},
        }));
        expect(html).toContain("本地工具");
        expect(html).toContain("本地命令");
        expect(html).toContain("远程工具");
        expect(html).toContain("远程地址");
        expect(html).toContain("检测工具");
    });

    test("编辑弹窗按传输方式显示字段与本地命令提醒", () => {
        const stdio = renderToStaticMarkup(createElement(McpServerEditorFields, { draft: draft(), error: "", onChange: () => {} }));
        expect(stdio).toContain("命令");
        expect(stdio).toContain("参数（每行一个）");
        expect(stdio).toContain("环境变量");
        expect(stdio).toContain("本地命令会在这台电脑上运行，只添加你信任的工具。");
        expect(stdio).toContain('placeholder="例如：npx"');
        expect(stdio).not.toContain('placeholder="https://example.com/mcp"');

        const http = renderToStaticMarkup(createElement(McpServerEditorFields, { draft: draft({ transport: "http", command: "", url: "https://example.com/mcp" }), error: "", onChange: () => {} }));
        expect(http).toContain("请求头");
        expect(http).toContain('placeholder="https://example.com/mcp"');
        expect(http).not.toContain("本地命令会在这台电脑上运行");
    });
});
