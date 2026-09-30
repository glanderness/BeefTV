import { describe, expect, test } from "bun:test";

import {
    ASSISTANT_STARTER_PROMPTS,
    ASSISTANT_UNAVAILABLE_FALLBACK,
    assistantActionLabel,
    assistantChangeSummary,
    assistantChangedNodeIds,
    assistantFailedActionText,
    assistantProposalText,
    assistantStatusNotice,
    assistantUndoFailureText,
} from "@/pages/canvas/canvas-assistant-copy";
import { ASSISTANT_DEFAULT_WIDTH, ASSISTANT_MAX_WIDTH, ASSISTANT_MIN_WIDTH, clampAssistantWidth, dismissedProposalKey, resolveCanvasRightPanel } from "@/pages/canvas/use-canvas-assistant";
import type { AssistantTurnChange } from "@/services/api/agent-assistant";

describe("助手不可用原因映射成一句用户语加一个出路", () => {
    test("缺模型和协议不支持都指向模型配置", () => {
        for (const reason of ["model_not_configured", "model_protocol_unsupported"]) {
            const notice = assistantStatusNotice(reason);
            expect(notice.text).toBe("还没有可用的助手模型");
            expect(notice.action).toBe("model-settings");
            expect(notice.actionLabel).toBe("去模型配置");
        }
    });

    test("缺凭据指向去连接", () => {
        const notice = assistantStatusNotice("credential_missing");
        expect(notice.text).toBe("BeefAPI 还没连接好");
        expect(notice.action).toBe("model-settings");
    });

    test("正在启动只报告进展，没有按钮，并要求更快复查", () => {
        const notice = assistantStatusNotice("host_starting");
        expect(notice.text).toBe("助手正在启动…");
        expect(notice.action).toBeUndefined();
        expect(notice.starting).toBe(true);
    });

    test("启动失败和连不上都给重试", () => {
        for (const reason of ["host_start_failed", "host_unreachable"]) {
            const notice = assistantStatusNotice(reason);
            expect(notice.text).toBe("助手没有启动成功");
            expect(notice.action).toBe("retry");
        }
    });

    test("原因缺失或还不认识时走兜底，不显示原始值", () => {
        for (const reason of [undefined, "", "something_new_from_backend"]) {
            const notice = assistantStatusNotice(reason);
            expect(notice.text).toBe(ASSISTANT_UNAVAILABLE_FALLBACK);
            expect(notice.text).not.toContain("something_new_from_backend");
        }
    });
});

describe("工具调用翻译成做了什么", () => {
    test("已知操作说人话", () => {
        expect(assistantActionLabel("canvas.nodes.create")).toBe("新建节点");
        expect(assistantActionLabel("canvas.node.update")).toBe("修改节点");
        expect(assistantActionLabel("canvas.edge.create")).toBe("连线");
        expect(assistantActionLabel("canvas.get")).toBe("读取画布");
        expect(assistantActionLabel("canvas.search")).toBe("读取画布");
        expect(assistantActionLabel("asset.list")).toBe("读取素材");
        expect(assistantActionLabel("asset.get")).toBe("读取素材");
    });

    test("没见过的操作也不把内部名字露出去", () => {
        expect(assistantActionLabel("canvas.something.new")).toBe("改动画布");
        expect(assistantActionLabel(undefined)).toBe("改动画布");
    });

    test("失败的那一步说清是哪件事没成", () => {
        expect(assistantFailedActionText({ tool: "canvas.edge.create", isError: true })).toBe("连线没有成功");
    });
});

describe("按轮改动摘要", () => {
    const change = (patch: Partial<AssistantTurnChange>): AssistantTurnChange => ({
        revisionBefore: 1,
        revisionAfter: 2,
        createdNodeIds: [],
        updatedNodeIds: [],
        createdEdgeIds: [],
        ...patch,
    });

    test("只报告真实落地的对象", () => {
        expect(assistantChangeSummary(change({ createdNodeIds: ["a", "b", "c"], createdEdgeIds: ["e1", "e2"] }))).toBe("新建 3 个节点，连了 2 条线");
        expect(assistantChangeSummary(change({ updatedNodeIds: ["a", "b"] }))).toBe("修改 2 个节点");
    });

    test("没有改动时不出卡片", () => {
        expect(assistantChangeSummary(null)).toBeNull();
        expect(assistantChangeSummary(undefined)).toBeNull();
        expect(assistantChangeSummary(change({}))).toBeNull();
    });

    test("定位的对象包含新建和被改过的，且不重复", () => {
        expect(assistantChangedNodeIds(change({ createdNodeIds: ["a"], updatedNodeIds: ["a", "b"] })).sort()).toEqual(["a", "b"]);
        expect(assistantChangedNodeIds(null)).toEqual([]);
    });
});

describe("撤销失败原因映射", () => {
    test("画布又改过之后说明不能直接撤销", () => {
        expect(assistantUndoFailureText("canvas_changed")).toBe("这之后画布又改过，不能直接撤销");
    });

    test("其余原因各有一句话，不出现机器可读值", () => {
        expect(assistantUndoFailureText("already_undone")).toBe("这一轮已经撤销过了");
        expect(assistantUndoFailureText("no_change")).toBe("这一轮没有改动画布");
        expect(assistantUndoFailureText("unknown")).toBe("撤销没有成功，请再试一次");
    });
});

describe("付费生成确认", () => {
    test("说清数量、用哪个模型、谁扣款", () => {
        const text = assistantProposalText({ proposalId: "p1", kind: "image", nodeIds: ["a", "b"], model: "seedream-4", modelKey: "ch::seedream-4", note: "" });
        expect(text).toBe("生成 2 张参考图片 · seedream-4\n确认后开始，按所选渠道计费。");
        // 不能把带渠道前缀的内部值显示出来。
        expect(text).not.toContain("ch::");
    });

    test("视频提议说的是视频", () => {
        const text = assistantProposalText({ proposalId: "p2", kind: "video", nodeIds: ["a"], model: "seedance-1", modelKey: "ch::seedance-1" });
        expect(text).toContain("生成 1 段视频");
    });
});

describe("右侧栏位互斥", () => {
    test("版本记录占住栏位时助手不渲染", () => {
        expect(resolveCanvasRightPanel(true, true)).toBe("versions");
        expect(resolveCanvasRightPanel(false, true)).toBe("versions");
    });

    test("只开助手时是助手，两个都没开时栏位是空的", () => {
        expect(resolveCanvasRightPanel(true, false)).toBe("assistant");
        expect(resolveCanvasRightPanel(false, false)).toBeNull();
    });
});

describe("停靠宽度", () => {
    test("越界宽度被收回可用范围", () => {
        expect(clampAssistantWidth(10)).toBe(ASSISTANT_MIN_WIDTH);
        expect(clampAssistantWidth(9999)).toBe(ASSISTANT_MAX_WIDTH);
        expect(clampAssistantWidth(Number.NaN)).toBe(ASSISTANT_DEFAULT_WIDTH);
        expect(clampAssistantWidth(420)).toBe(420);
    });
});

describe("空态起步提示", () => {
    test("四条都是短剧创作能直接用的一句话", () => {
        expect(ASSISTANT_STARTER_PROMPTS).toHaveLength(4);
        for (const prompt of ASSISTANT_STARTER_PROMPTS) {
            expect(prompt.length).toBeGreaterThan(5);
            expect(prompt.length).toBeLessThan(20);
        }
    });
});

describe("生成提议的两种结果不会互相冒充", () => {
    test("同意与谢绝各记一个键", () => {
        expect(dismissedProposalKey("p1")).toBe("p1:skipped");
        const decided = new Set(["p1", dismissedProposalKey("p2")]);
        expect(decided.has("p1")).toBe(true);
        expect(decided.has(dismissedProposalKey("p1"))).toBe(false);
        expect(decided.has("p2")).toBe(false);
        expect(decided.has(dismissedProposalKey("p2"))).toBe(true);
    });
});

describe("assistantVisibleReply", () => {
    test("去掉闭合与未闭合的思考片段", async () => {
        const { assistantVisibleReply } = await import("@/pages/canvas/canvas-assistant-copy");
        expect(assistantVisibleReply("<think>先想想</think>\n已经建好三个镜头。")).toBe("已经建好三个镜头。");
        expect(assistantVisibleReply("已完成<think>还在写")).toBe("已完成");
        expect(assistantVisibleReply("<think>只有草稿")).toBe("");
    });
});

describe("assistantUnresolvedFailures", () => {
    test("重试成功的步骤不提示，仍失败的同类合并计数", async () => {
        const { assistantUnresolvedFailures } = await import("@/pages/canvas/canvas-assistant-copy");
        const calls = [
            { tool: "canvas.node.update", args: { nodeId: "a" }, isError: true },
            { tool: "canvas.node.update", args: { nodeId: "b" }, isError: true },
            { tool: "canvas.node.update", args: { nodeId: "a" }, isError: false },
            { tool: "canvas.edge.create", args: { fromNodeId: "a", toNodeId: "c" }, isError: true },
            { tool: "canvas.edge.create", args: { fromNodeId: "b", toNodeId: "c" }, isError: true },
            { tool: "canvas.get", args: {}, isError: true },
        ];
        expect(assistantUnresolvedFailures(calls)).toEqual(["修改节点没有成功", "连线没有成功（2 处）"]);
        expect(assistantUnresolvedFailures([])).toEqual([]);
    });
});
