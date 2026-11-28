import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
    CanvasAssistantApprovalCard,
    CanvasAssistantMandateBar,
    formatMandateCny,
} from "@/pages/canvas/canvas-assistant-approval-card";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import {
    applyHistoryActiveTurn,
    createCanvasRun,
    upsertPendingApproval,
} from "@/pages/canvas/canvas-assistant-recovery";
import { assistantLifecycleText } from "@/pages/canvas/canvas-assistant-copy";
import {
    confirmAssistantProduction,
    createAssistantMandate,
    decideAssistantApproval,
    ensureAgentUiSession,
    listAssistantMandates,
    resetAgentUiSession,
    revokeAssistantMandate,
    streamAgentChat,
    type AssistantGenerationProposal,
    type AssistantHistory,
    type AssistantPendingApproval,
    type AssistantProductionMandate,
    type AssistantTurn,
} from "@/services/api/agent-assistant";
import { apiClient, configureApiRuntime, http } from "@/services/api/request";
import * as requestRuntime from "@/services/api/request";

describe("PR-5 Canvas Assistant ProductionMandate & Approval Card UI", () => {
    test("CanvasAssistantApprovalCard 展示批准本次、批准本片预算包（上限 ¥X）与拒绝按钮及报价摘要", () => {
        const approval: AssistantPendingApproval = {
            proposalId: "ap-shot-1",
            toolName: "canvas_generation_submit",
            opName: "canvas.generation.submit",
            summary: "即将生成 2 张首帧图",
            estimatedCny: 3.5,
            unquotedCount: 1,
            suggestedCapCny: 50,
            kinds: ["image", "media_review"],
        };
        const html = renderToStaticMarkup(
            <CanvasAssistantApprovalCard
                approval={approval}
                onApproveOnce={() => {}}
                onApproveMandate={() => {}}
                onReject={() => {}}
            />,
        );
        expect(html).toContain("待批准 · 付费操作");
        expect(html).toContain("即将生成 2 张首帧图");
        expect(html).toContain("约 ¥3.50 + 1 项无报价");
        expect(html).toContain("图片生成 · 媒体审片");
        expect(html).toContain("同时允许无报价/自带 Key 调用（限 4 次，独立于 ¥ 上限计数）");
        expect(html).toContain("批准本次");
        expect(html).toContain("批准本片预算包（上限 ¥50）");
        expect(html).toContain("拒绝");
    });

    test("CanvasAssistantMandateBar 展示剩余/已用/预留额度与撤销按钮；非 active 状态自动隐藏", () => {
        const activeMandate: AssistantProductionMandate = {
            id: "pm-1",
            canvasId: "c1",
            sessionId: "durable:s1",
            maxAmountCny: 50,
            spentAmountCny: 12.5,
            reservedAmountCny: 5,
            remainingCny: 32.5,
            maxUnquotedCount: 4,
            usedUnquotedCount: 1,
            remainingUnquoted: 3,
            allowedKinds: ["image", "video", "audio", "media_review"],
            status: "active",
            version: 2,
        };
        const activeHtml = renderToStaticMarkup(
            <CanvasAssistantMandateBar mandate={activeMandate} onRevoke={() => {}} />,
        );
        expect(activeHtml).toContain("本片预算包生效中");
        expect(activeHtml).toContain("剩余 ¥32.50 / 上限 ¥50");
        expect(activeHtml).toContain("已用 ¥12.50，预留 ¥5");
        expect(activeHtml).toContain("无报价余 3/4 次");
        expect(activeHtml).toContain("撤销预算包");

        const revokedHtml = renderToStaticMarkup(
            <CanvasAssistantMandateBar mandate={{ ...activeMandate, status: "revoked" }} onRevoke={() => {}} />,
        );
        expect(revokedHtml).toBe("");
        expect(formatMandateCny(20)).toBe("¥20");
    });

    test("CanvasAssistantTurnView 生成方案卡采用服务端 suggestedCapCny，无报价或已有预算包时不静默放行", () => {
        const proposal: AssistantGenerationProposal = {
            proposalId: "gp-1",
            kind: "image",
            nodeIds: ["n1"],
            model: "image-1",
            modelKey: "beeftv::image-1",
            suggestedCapCny: 50,
            estimate: { amount: 1.5, priced: 1, unknown: 0, text: "预计费用：¥1.50" },
        };
        const turn: AssistantTurn = {
            turnId: "t1",
            userText: "生成分镜图",
            selectedNodeIds: [],
            reply: "请确认",
            toolCalls: [],
            change: null,
            proposals: [proposal],
            error: null,
            cancelled: false,
            createdAt: "2026-11-28T00:00:00Z",
        };
        const withoutMandate = renderToStaticMarkup(
            <CanvasAssistantTurnView
                turn={turn}
                handledProposals={new Set()}
                hasActiveMandate={false}
                onLocate={() => {}}
                onUndo={() => {}}
                onRunProposal={() => {}}
                onDismissProposal={() => {}}
            />,
        );
        expect(withoutMandate).toContain("批准本片预算包（上限 ¥50）");

        const withUnknown = renderToStaticMarkup(
            <CanvasAssistantTurnView
                turn={{
                    ...turn,
                    proposals: [{ ...proposal, estimate: { amount: 0, priced: 0, unknown: 1, text: "暂无价格" } }],
                }}
                handledProposals={new Set()}
                hasActiveMandate={false}
                onLocate={() => {}}
                onUndo={() => {}}
                onRunProposal={() => {}}
                onDismissProposal={() => {}}
            />,
        );
        expect(withUnknown).not.toContain("批准本片预算包");

        const withMandate = renderToStaticMarkup(
            <CanvasAssistantTurnView
                turn={turn}
                handledProposals={new Set()}
                hasActiveMandate={true}
                onLocate={() => {}}
                onUndo={() => {}}
                onRunProposal={() => {}}
                onDismissProposal={() => {}}
            />,
        );
        expect(withMandate).not.toContain("批准本片预算包");
    });

    test("history 恢复与 upsertPendingApproval 正确保留并去重休眠审批单", () => {
        const run = createCanvasRun();
        const history: AssistantHistory = {
            sessionId: "durable:s1",
            turns: [],
            pendingApprovals: [{ proposalId: "ap-1", toolName: "canvas_generation_submit", summary: "镜1生成" }],
            active: {
                turnId: "t-active",
                userText: "做短片",
                selectedNodeIds: [],
                createdAt: "2026-11-28T00:00:00Z",
                status: "running",
                lifecycle: { type: "lifecycle", phase: "approval", toolName: "canvas_generation_submit" },
                pendingApprovals: [{ proposalId: "ap-1", toolName: "canvas_generation_submit", summary: "镜1生成" }],
            },
        };
        applyHistoryActiveTurn(run, history, "durable:s1");
        expect(run.pendingApprovals).toHaveLength(1);
        expect(run.pendingApprovals[0].proposalId).toBe("ap-1");
        expect(assistantLifecycleText(history.active?.lifecycle)).toBe("等待你确认继续执行。");

        const merged = upsertPendingApproval(run.pendingApprovals, {
            proposalId: "ap-1",
            toolName: "canvas_generation_submit",
            summary: "镜1生成（更新）",
        });
        expect(merged).toHaveLength(1);
        expect(merged[0].summary).toBe("镜1生成（更新）");
    });
});

describe("PR-5 NDJSON approval_required / heartbeat 流与 Go 预算包 API 契约", () => {
    let previousFetch: typeof fetch;
    let previousBaseURL: string;
    let httpGetSpy: ReturnType<typeof spyOn>;
    let httpPostSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        previousFetch = globalThis.fetch;
        previousBaseURL = requestRuntime.apiBaseURL;
        configureApiRuntime("http://127.0.0.1:54321/api", "");
        resetAgentUiSession();
        httpGetSpy = spyOn(http, "get").mockResolvedValue({ mandates: [], activeMandate: null } as never);
        httpPostSpy = spyOn(http, "post").mockImplementation((async (url: string) => {
            if (url === "/assistant/ui-session") {
                return { token: "ui-token-pr5", expiresAt: new Date(Date.now() + 600_000).toISOString() };
            }
            return { ok: true };
        }) as never);
    });

    afterEach(() => {
        resetAgentUiSession();
        globalThis.fetch = previousFetch;
        httpGetSpy.mockRestore();
        httpPostSpy.mockRestore();
        configureApiRuntime(previousBaseURL, String(apiClient.defaults.headers.common["X-Desktop-Token"] || ""));
    });

    test("streamAgentChat 解析实时 approval_required 与 heartbeat(pendingApprovals) 事件", async () => {
        const encoder = new TextEncoder();
        const lines = [
            JSON.stringify({ type: "session", sessionId: "durable:s-live" }),
            JSON.stringify({ type: "approval_required", proposalId: "ap-live-1", toolName: "canvas_generation_submit", estimatedCny: 2.5, summary: "生成首帧" }),
            JSON.stringify({ type: "heartbeat", pendingApprovals: [{ proposalId: "ap-live-1", toolName: "canvas_generation_submit", estimatedCny: 2.5 }] }),
            JSON.stringify({ type: "turn_end", reply: "已完成", toolCalls: [], error: null, cancelled: false }),
        ].join("\n") + "\n";
        globalThis.fetch = (async () => new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(lines));
                    controller.close();
                },
            }),
            { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
        )) as unknown as typeof fetch;

        const approvals: AssistantPendingApproval[] = [];
        const heartbeats: AssistantPendingApproval[][] = [];
        await streamAgentChat("c1", "开始做片", {
            onApprovalRequired: (a) => approvals.push(a),
            onHeartbeat: (h) => { if (h.pendingApprovals) heartbeats.push(h.pendingApprovals); },
        });
        expect(approvals).toHaveLength(1);
        expect(approvals[0].proposalId).toBe("ap-live-1");
        expect(approvals[0].estimatedCny).toBe(2.5);
        expect(heartbeats).toHaveLength(1);
        expect(heartbeats[0][0].proposalId).toBe("ap-live-1");
    });

    test("预算包与审批决策 API 携带 UI Session 调用对应后端端点", async () => {
        await ensureAgentUiSession();
        const calls: Array<{ method: string; url: string; body?: unknown }> = [];
        httpGetSpy.mockImplementation((async (url: string) => {
            calls.push({ method: "GET", url });
            return { mandates: [], activeMandate: null };
        }) as never);
        httpPostSpy.mockImplementation((async (url: string, body: unknown) => {
            calls.push({ method: "POST", url, body });
            if (url.includes("/decide")) return { approval: { proposalId: "ap-1" }, signaled: false };
            return { ok: true };
        }) as never);

        await listAssistantMandates("c1", "durable:s1");
        await createAssistantMandate({ canvasId: "c1", maxAmountCny: 50, maxUnquotedCount: 0, expiresInMinutes: 120 });
        await revokeAssistantMandate("pm-1");
        const decided = await decideAssistantApproval("ap-1", { decision: "reject", reason: "超出预算" });
        await confirmAssistantProduction("c1", "t1", {
            proposalId: "gp-1",
            kind: "image",
            nodeIds: ["n1"],
            model: "m1",
            modelKey: "beeftv::m1",
        }, true, { maxAmountCny: 50, maxUnquotedCount: 0 });

        expect(calls[0]).toEqual({ method: "GET", url: "/assistant/mandates?canvasId=c1&sessionId=durable%3As1" });
        expect(calls[1]).toMatchObject({ method: "POST", url: "/assistant/mandates", body: { canvasId: "c1", maxAmountCny: 50, maxUnquotedCount: 0, expiresInMinutes: 120 } });
        expect(calls[2]).toMatchObject({ method: "POST", url: "/assistant/mandates/pm-1/revoke" });
        expect(calls[3]).toMatchObject({ method: "POST", url: "/assistant/approvals/ap-1/decide", body: { decision: "reject", reason: "超出预算" } });
        expect(decided.signaled).toBe(false);
        expect(calls[4]).toMatchObject({ method: "POST", url: "/assistant/turns/t1/proposals/gp-1/production", body: { createMandate: { maxAmountCny: 50, maxUnquotedCount: 0 } } });
    });
});
