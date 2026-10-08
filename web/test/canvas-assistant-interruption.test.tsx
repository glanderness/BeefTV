import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import { CanvasAssistantComposer } from "@/pages/canvas/canvas-assistant-composer";
import type { AssistantTurn } from "@/services/api/agent-assistant";

const interrupted: AssistantTurn = {
    turnId: "paused", userText: "只创建草案", selectedNodeIds: [],
    reply: "两个草案已创建。", toolCalls: [], proposals: [],
    change: { revisionBefore: 1, revisionAfter: 2, createdNodeIds: ["a", "b"], updatedNodeIds: [], createdEdgeIds: [] },
    error: "raw provider error", errorReason: "turn_timeout", cancelled: false, createdAt: "2026-10-08",
};
function render(turn = interrupted, options: { undone?: boolean; continue?: boolean } = {}) {
    return renderToStaticMarkup(<CanvasAssistantTurnView turn={turn} status={{ undone: options.undone }} handledProposals={new Set()}
        onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}}
        onContinue={options.continue === false ? undefined : () => {}} />);
}

describe("处理未完成仍保留可检查的结果", () => {
    test("超时保留回复、实际改动与撤销，并提供中性状态和继续入口", () => {
        const html = render();
        expect(html).toContain("两个草案已创建");
        expect(html).toContain("新建 2 个节点");
        expect(html).toContain("撤销这一轮");
        expect(html).toContain("尚未完成");
        expect(html).toContain("继续处理");
        expect(html).toContain('class="canvas-assistant-incomplete"');
        expect(html).not.toContain("canvas-assistant-failed");
        expect(html).not.toContain("raw provider error");
    });
    test("已经撤销、旧回合或只读时不展示继续按钮", () => {
        for (const html of [render(interrupted, { undone: true }), render(interrupted, { continue: false })]) {
            expect((html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).some(button => button.includes("继续处理"))).toBe(false);
        }
        expect(render(interrupted, { undone: true })).toContain("画布改动已撤销");
    });
    test("不可继续的配置错误仍明确失败，不冒充已恢复", () => {
        const html = render({ ...interrupted, errorReason: "forbidden" });
        expect(html).toContain("canvas-assistant-failed");
        expect(html).not.toContain("继续处理");
        expect(html).not.toContain("尚未完成");
    });
    test("运行中保留输入和停止，并有明确补充入口，不新增素材附件", () => {
        const html = renderToStaticMarkup(<CanvasAssistantComposer value="只改结尾" onChange={() => {}} onSend={() => {}} onStop={() => {}}
            streaming disabled={false} canSupplement supplementBusy={false} references={[]} selectedCount={3} selectionAttached onDetachSelection={() => {}} />);
        expect(html).toContain("补充");
        expect(html).toContain("停止");
        const input = html.match(/<textarea\b[^>]*>/)?.[0] || html.match(/<div\b[^>]*contentEditable="true"[^>]*>/)?.[0];
        expect(input).toBeDefined();
        expect(input).not.toContain('disabled=""');
        expect(html).not.toContain("已选 3 个节点");
    });
    test("历史中保留已收到的补充要求，不改写原用户消息", () => {
        const html = render({ ...interrupted, supplements: ["结尾改成蛋糕"] });
        expect(html).toContain("只创建草案");
        expect(html).toContain("结尾改成蛋糕");
    });
});
