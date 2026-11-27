import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentAssistantFailureText, type AssistantTurn } from "@/services/api/agent-assistant";
import { assistantTurnCanContinue, ASSISTANT_CONTINUE_PROMPT } from "@/pages/canvas/canvas-assistant-copy";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
const makeTurn = (reason: string): AssistantTurn => ({
    turnId: "current-turn",
    userText: "检查视频结果",
    reply: "",
    createdAt: "2026-10-08",
    error: "Request timed out.",
    errorReason: reason,
    cancelled: false,
    selectedNodeIds: [],
    toolCalls: [{ tool: "canvas.node.update", args: { nodeId: "saved-node" } }],
    change: { revisionBefore: 1, revisionAfter: 2, createdNodeIds: ["saved-node"], updatedNodeIds: [], createdEdgeIds: [] },
    proposals: [{ proposalId: "confirmed-proposal", kind: "video", model: "test-video-model", modelKey: "test-video-model", nodeIds: ["saved-node"] }],
});
for (const reason of ["model_error", "provider_error"])
    test(reason + " is incomplete/continuable while committed changes and started proposal stay visible", () => {
        const turn = makeTurn(reason);
        const before = JSON.stringify(turn);
        let actions = 0;
        const html = renderToStaticMarkup(
            <CanvasAssistantTurnView turn={turn} handledProposals={new Set(["confirmed-proposal"])} onLocate={() => actions++} onUndo={() => actions++} onRunProposal={() => actions++} onDismissProposal={() => actions++} onContinue={() => actions++} />,
        );
        expect(html).toContain("尚未完成");
        expect(html).toContain("模型没有完成回复");
        expect(html).toContain("已经完成的操作会保留");
        expect(html).toContain("继续处理");
        expect(html).toContain("新建 1 个节点");
        expect(html).toContain("已开始生成");
        expect(html).not.toContain("这一步没有完成");
        expect(actions).toBe(0);
        expect(JSON.stringify(turn)).toBe(before);
        expect(turn.error).toBeTruthy();
    });
test("continuation stays manual and does not expose an action after undo or without a handler", () => {
    const props = { turn: makeTurn("model_error"), handledProposals: new Set(["confirmed-proposal"]), onLocate: () => {}, onUndo: () => {}, onRunProposal: () => {}, onDismissProposal: () => {} };
    expect(renderToStaticMarkup(<CanvasAssistantTurnView {...props} />)).not.toContain(">继续处理<");
    expect(
        renderToStaticMarkup(
            <CanvasAssistantTurnView
                {...props}
                status={{ undone: true }}
                onContinue={() => {
                    throw Error("must not submit");
                }}
            />,
        ),
    ).not.toContain(">继续处理<");
    expect(ASSISTANT_CONTINUE_PROMPT).toContain("不要重复创建节点或重新提交已开始的生成任务");
});
test("unknown and fatal policy failures retain existing conservative action eligibility", () => {
    for (const reason of ["forbidden", "native_history_unavailable", "request_budget_storage_unavailable", "unrecognized_reason"]) expect(assistantTurnCanContinue(reason)).toBe(false);
    expect(agentAssistantFailureText("unrecognized_reason", "fallback")).toBe("fallback");
    expect(assistantTurnCanContinue("turn_timeout")).toBe(true);
    expect(assistantTurnCanContinue("model_network_error")).toBe(true);
    const networkHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={makeTurn("model_network_error")}
            handledProposals={new Set(["confirmed-proposal"])}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
            onContinue={() => {}}
        />,
    );
    expect(networkHtml).toContain("继续处理");
    expect(networkHtml).toContain("网络代理");
});

test("stream interruption, truncation, content filter and transport reasons render plain Chinese copy and safe continue actions", () => {
    const partialTurn: AssistantTurn = { ...makeTurn("partial_output_stream_interrupted"), reply: "已生成的半截分镜内容", rawStopReason: "error" };
    const partialHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView turn={partialTurn} handledProposals={new Set()} onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} onContinue={() => {}} />,
    );
    expect(partialHtml).toContain("已生成的半截分镜内容");
    expect(partialHtml).toContain("模型输出中途中断，已保留已生成内容，可点击继续处理");
    expect(partialHtml).toContain("继续处理");
    expect(assistantTurnCanContinue("partial_output_stream_interrupted")).toBe(true);

    const truncatedTurn: AssistantTurn = { ...makeTurn("model_output_truncated"), reply: "达到长度上限前的现有内容", rawStopReason: "length" };
    const truncatedHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView turn={truncatedTurn} handledProposals={new Set()} onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} onContinue={() => {}} />,
    );
    expect(truncatedHtml).toContain("达到长度上限前的现有内容");
    expect(truncatedHtml).toContain("回复达到长度上限被截断，已保留现有内容，可点击继续处理");
    expect(truncatedHtml).toContain("继续处理");
    expect(assistantTurnCanContinue("model_output_truncated")).toBe(true);

    const filteredTurn: AssistantTurn = { ...makeTurn("model_content_filtered"), rawStopReason: "content_filter" };
    const filteredHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView turn={filteredTurn} handledProposals={new Set()} onLocate={() => {}} onUndo={() => {}} onRunProposal={() => {}} onDismissProposal={() => {}} onContinue={() => {}} />,
    );
    expect(filteredHtml).toContain("上游模型触发了安全审核拦截，请调整措辞后重试");
    expect(filteredHtml).not.toContain(">继续处理<");
    expect(assistantTurnCanContinue("model_content_filtered")).toBe(false);

    for (const [reason, expected] of [
        ["stream_ended_without_finish_reason", "未返回完成标记"],
        ["upstream_eof_before_first_byte", "返回首字节前中断"],
        ["stream_idle_timeout", "长时间无响应"],
        ["provider_rate_limited", "触发限流"],
        ["provider_unavailable", "暂时繁忙或不可用"],
    ] as const) {
        expect(agentAssistantFailureText(reason)).toContain(expected);
        expect(assistantTurnCanContinue(reason)).toBe(true);
    }
});
