import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/services/api/agent-assistant.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/pages/canvas/canvas-agent-assistant-panel.tsx", import.meta.url), "utf8");
const project = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");

/** 粗略取出源码里的字符串字面量与模板字符串，用于检查渲染文案。 */
function source_string_literals(code: string) {
    const literals = code.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
    return literals.map((literal) => literal.slice(1, -1));
}

describe("创作助手前端接线", () => {
    test("流式对话与停止打到后端真实注册的 /api/assistant/* 路由", () => {
        // 后端 registerAgentProxyRoutes 注册的是 /assistant/chat 与 /assistant/cancel；
        // 曾经写成 /api/agent/* 时每一次发送都只拿到 404，面板永远没有回复。
        // 原生 Wails 的页面 origin 不是后端地址，必须使用当前运行时的 API base。
        // stream 测试另外实际调用两条路径，核对最终绝对 URL。
        expect(source).toContain('fetch(`${apiBaseURL}/assistant/chat`');
        expect(source).toContain('fetch(`${apiBaseURL}/assistant/cancel`');
        expect(source).not.toContain("/api/agent/chat");
        expect(source).not.toContain("/api/agent/cancel");
        expect(source).toContain('http.post<{ token: string }>("/assistant/ui-session"');
        expect(source).toContain('http.get<AgentHostStatus>("/assistant/status")');
    });

    test("面板展示文案使用用户语，不出现实现者术语", () => {
        // 只看会渲染给用户的字符串字面量，避免把 DOM 变量名当成文案。
        const userFacing = source_string_literals(panel).filter((text) => /[\u4e00-\u9fff]/.test(text));
        expect(userFacing.length).toBeGreaterThan(3);
        for (const text of userFacing) {
            for (const term of ["agent-host", "宿主", "Node", "幂等", "MCP", "revision", "API", "token"]) {
                expect(`${text}`).not.toContain(term);
            }
        }
        expect(panel).toContain("创作助手暂时不可用");
    });

    test("面板在回合结束时通知画布拉取最新内容", () => {
        expect(panel).toContain("onTurnSettled");
        expect(project).toContain("onTurnSettled");
        expect(project).toContain("refreshLocalCanvasProjectIfChanged(canvasId)");
    });

    test("发送时冻结选中对象快照，不随后续选择变化", () => {
        expect(panel).toContain("const selectedSnapshot = [...selectedNodeIds]");
        expect(panel).toContain("selectedSnapshot");
    });
});
