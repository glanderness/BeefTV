// 一轮对话的变更摘要、付费生成提议与供应商定义：确定性用例，不需要模型也不需要真实会话。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { collectTurnEffects, newTurnAccumulator, providerRegistration, providerUnavailableReason,
  resetTurnAccumulator, sessionTitle, turnChange, turnContextPrefix, unflushedSessionHistory } from "./canvas-turn.mjs";
import { SYSTEM_PROMPT } from "./full-control-loader.mjs";

const serverSource = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");

describe("本轮画布变更", () => {
    test("从成功的工具结果累计新建节点、改动节点与新建连线", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 7);

        collectTurnEffects(turn, "canvas.nodes.create", { revision: 8, created: [{ id: "a" }, { id: "b" }] });
        collectTurnEffects(turn, "canvas.node.update", { revision: 9, nodeId: "a" });
        collectTurnEffects(turn, "canvas.edge.create", { revision: 10, created: true, edgeId: "e1" });

        expect(turnChange(turn)).toEqual({
            revisionBefore: 7, revisionAfter: 10,
            createdNodeIds: ["a", "b"], updatedNodeIds: ["a"], createdEdgeIds: ["e1"],
        });
    });

    test("未落盘的当前会话按空历史读取，别的会话仍然缺失", () => {
        expect(unflushedSessionHistory("s1", "s1")).toEqual({ sessionId: "s1", turns: [] });
        expect(unflushedSessionHistory("", "s1")).toEqual({ sessionId: null, turns: [] });
        expect(unflushedSessionHistory("old", "s1")).toBeNull();
    });

    test("推进版本的写入带上操作回执，重复版本不重复记", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
        collectTurnEffects(turn, "canvas.nodes.create", { revision: 5, created: [{ id: "a" }] }, "op-1");
        collectTurnEffects(turn, "canvas.node.update", { revision: 5, nodeId: "a" }, "op-stale");
        collectTurnEffects(turn, "canvas.node.update", { revision: 6, nodeId: "a" }, "op-2");
        expect(turnChange(turn).operationIds).toEqual(["op-1", "op-2"]);
    });

    test("重复连线幂等返回时不算新建连线", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 3);

        collectTurnEffects(turn, "canvas.edge.create", { revision: 3, created: false, duplicate: true, edgeId: "e1" });

        expect(turn.createdEdgeIds).toEqual([]);
        expect(turnChange(turn)).toBeNull();
    });

    test("连续修改同一节点只计一个对象，保留每次真实写入回执", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 45);
        collectTurnEffects(turn, "canvas.node.update", { revision: 46, nodeId: "video" }, "first-edit");
        collectTurnEffects(turn, "canvas.node.update", { revision: 47, nodeId: "video" }, "second-edit");
        collectTurnEffects(turn, "canvas.node.update", { revision: 48, nodeId: "image" }, "third-edit");
        expect(turnChange(turn)).toEqual({
            revisionBefore: 45, revisionAfter: 48,
            createdNodeIds: [], updatedNodeIds: ["video", "image"], createdEdgeIds: [],
            operationIds: ["first-edit", "second-edit", "third-edit"],
        });
    });

    test("只读了画布的一轮没有变更摘要", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 5);

        collectTurnEffects(turn, "canvas.get", { canvasId: "c1", canvas: { revision: 5 } });

        expect(turnChange(turn)).toBeNull();
    });

    test("重置会清空上一轮的节点、连线与提议", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 1);
        collectTurnEffects(turn, "canvas.nodes.create", { revision: 2, created: [{ id: "a" }] });
        collectTurnEffects(turn, "canvas.generation.propose", { proposalId: "gp-1", kind: "image", nodeIds: ["a"], model: "gpt-image-2" });

        resetTurnAccumulator(turn, 2);

        expect(turn.createdNodeIds).toEqual([]);
        expect(turn.proposals).toEqual([]);
        expect(turnChange(turn)).toBeNull();
    });
});

describe("付费生成提议", () => {
    test("服务端来源版本透传，不从当前状态补造，也不透传额外字段", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);
        collectTurnEffects(turn, "canvas.generation.propose", {
            proposalId: "gp-source", kind: "image", nodeIds: ["n1"], model: "m", modelKey: "c::m",
            source: { canvasId: "canvas", canvasRevision: 7, modelConfigRevision: 3, privateField: "omit" },
        });
        expect(turn.proposals[0].source).toEqual({ canvasId: "canvas", canvasRevision: 7, modelConfigRevision: 3 });
        expect(turnChange(turn)).toBeNull();
    });
    test("提议只被记录，不进变更摘要（它不写画布、不扣费）", () => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 4);

        collectTurnEffects(turn, "canvas.generation.propose", {
            proposalId: "gp-1", kind: "video", nodeIds: ["n1", "n2"],
            model: "wan3.0-video", modelKey: "beefapi::wan3.0-video", note: "两段镜头",
        });

        expect(turnChange(turn)).toBeNull();
        expect(turn.proposals).toEqual([{ proposalId: "gp-1", kind: "video", nodeIds: ["n1", "n2"],
            model: "wan3.0-video", modelKey: "beefapi::wan3.0-video", note: "两段镜头" }]);
    });

    test("系统提示词必须禁止宣称已生成，并指向提议工具", () => {
        expect(SYSTEM_PROMPT).toContain("canvas_generation_propose");
        expect(SYSTEM_PROMPT).toContain("你不能生成图片或视频");
    });

    test("系统提示词用 content 改可编辑提示词，未改字段不要提交", () => {
        expect(SYSTEM_PROMPT).toContain("改可编辑提示词或文本正文用 content");
        expect(SYSTEM_PROMPT).toContain("未改的字段不要提交");
        expect(SYSTEM_PROMPT).not.toMatch(/用 prompt/);
    });
});

describe("会话标题", () => {
    test("用第一条用户原文，截到 40 字", () => {
        expect(sessionTitle([{ userText: "  加两个分镜  " }, { userText: "再来一个" }])).toBe("加两个分镜");
        expect(sessionTitle([{ userText: "一".repeat(60) }])).toBe("一".repeat(40));
        expect(sessionTitle([])).toBe("");
    });

    test("跳过没有正文的轮次（例如被取消的那一轮）", () => {
        expect(sessionTitle([{ userText: "" }, { userText: "真正的第一句" }])).toBe("真正的第一句");
    });
});

describe("供应商定义", () => {
    test("协议不受支持或缺少模型/地址/密钥时给出机器可读原因", () => {
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x/v1", apiKey: "k", api: "openai-completions" })).toBe("");
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x", apiKey: "k", api: "anthropic-messages" })).toBe("");
        expect(providerUnavailableReason({ modelId: "", baseUrl: "https://x/v1", apiKey: "k", api: "openai-completions" })).toBe("model_not_configured");
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x/v1", apiKey: "", api: "openai-completions" })).toBe("model_not_configured");
        expect(providerUnavailableReason({ modelId: "m", baseUrl: "https://x/v1", apiKey: "k", api: "newapi-channel-1" })).toBe("model_protocol_unsupported");
    });

    test("密钥以环境变量引用登记，不落进供应商定义正文", () => {
        const registration = providerRegistration({ api: "anthropic-messages", baseUrl: "https://enterprise.example.com",
            modelId: "claude-fable-5", maxTokens: 4096, contextWindow: 200000 });

        expect(registration.apiKey).toBe("$BEEFTV_AGENT_API_KEY");
        expect(registration.api).toBe("anthropic-messages");
        expect(registration.baseUrl).toBe("https://enterprise.example.com");
        expect(registration.models).toEqual([{ id: "claude-fable-5", name: "claude-fable-5", reasoning: false,
            input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000, maxTokens: 4096 }]);
    });

    test("宿主不再硬编码 OpenAI 目录，模型与协议只来自后端下发的环境变量", () => {
        expect(serverSource).not.toContain("openaiProvider");
        expect(serverSource).not.toContain("createModels");
        expect(serverSource).toContain("BEEFTV_AGENT_API");
    });

    test("缺少模型或密钥时宿主仍然监听，只在 /health 里说明原因", () => {
        // 以前这里是 process.exit(2)：宿主静默退出，界面只会看到「助手不可用」。
        expect(serverSource).toContain("BEEFTV_AGENT_HOST_TOKEN: HOST_TOKEN");
        expect(serverSource).not.toContain("BEEFTV_AGENT_API_KEY: API_KEY");
        expect(serverSource).toContain("ok: !providerReason");
    });
});

describe("回合上下文", () => {
    test("重置时带上后端签发的 turnId；未给时清空，不沿用上一轮", () => {
        const turn = newTurnAccumulator();
        resetTurnAccumulator(turn, 3, "aabbcc");
        expect(turn.turnId).toBe("aabbcc");
        resetTurnAccumulator(turn, 4);
        expect(turn.turnId).toBe("");
    });

    test("引用只作为模型可见上下文，素材与额外画布分别标注", () => {
        expect(turnContextPrefix({ canvasId: "c1" })).toBe("[当前画布 c1]");
        expect(turnContextPrefix({ canvasId: "c1", selectedNodeIds: ["n1", "n2"] }))
            .toBe("[当前画布 c1｜选中对象: n1, n2]");
        expect(turnContextPrefix({ canvasId: "c1", references: [
            { kind: "asset", id: "a1" }, { kind: "canvas", id: "c2" }, { kind: "asset", id: "a2" }, { kind: "unknown", id: "x" },
        ] })).toBe("[当前画布 c1｜已引用素材: a1, a2｜已引用画布（只读）: c2]");
    });
});

import { modelTurnCompletion } from './canvas-turn.mjs';

describe('模型终态投影', () => {
  test('用户停止不变成模型失败，超时保留独立原因', () => {
    const message = { content: [{ type: 'text', text: '已完成的部分' }], stopReason: 'aborted' };
    expect(modelTurnCompletion(message, 'AbortError', null, { cancelled: true }))
      .toEqual({ reply: '已完成的部分', error: null, errorReason: null });
    expect(modelTurnCompletion(message, 'AbortError', null, { cancelled: true, timedOut: true }).errorReason)
      .toBe('turn_timeout');
    expect(modelTurnCompletion(message, 'AbortError', { reason: 'turn_request_budget_exhausted', message: '预算耗尽' }, { cancelled: true }).errorReason)
      .toBe('turn_request_budget_exhausted');
  });
  test('SDK 正常 resolve 但终态为 error 仍然报告失败', () => {
    const result = modelTurnCompletion({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider failed' });
    expect(result.error).toBe('provider failed');
    expect(result.errorReason).toBe('model_request_failed');
  });
  test('预算拒绝的稳定原因优先于 SDK 重试包装', () => {
    const result = modelTurnCompletion(null, 'Connection error', { reason: 'turn_request_budget_exhausted', message: '单轮预算耗尽' });
    expect(result.errorReason).toBe('turn_request_budget_exhausted');
    expect(result.error).toBe('单轮预算耗尽');
  });
  test('只使用本轮终态，不引用历史助手回复', () => {
    expect(modelTurnCompletion(null).reply).toBe('');
    expect(modelTurnCompletion({ content: [{ type: 'text', text: '当前回复' }], stopReason: 'stop' })).toEqual({ reply: '当前回复', error: null, errorReason: null });
  });
  test('思考块不进入回复，正文里的标记原样保留', () => {
    const result = modelTurnCompletion({
      content: [
        { type: 'thinking', thinking: 'internal draft' },
        { type: 'text', text: '<thinking>draft</thinking>可见答复' },
      ],
      stopReason: 'stop',
    });
    expect(result).toEqual({ reply: '<thinking>draft</thinking>可见答复', error: null, errorReason: null });
  });
});
