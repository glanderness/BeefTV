// 用户添加的 MCP 服务器在 Durable 会话里的装配：新增、移除与工具步数预算。
// 用本地替身模型驱动，不连真实 MCP 服务器，也不调用付费模型。
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { createTurnBudget } from './request-budget.mjs';

const PING = 'mcp__srv__ping';

function externalTool(name, readOnly = false, calls = []) {
  return {
    name, label: name, description: `${name} 测试工具`, parameters: { type: 'object', properties: {} },
    readOnly, serverId: 'srv', toolName: name,
    execute: async () => { calls.push(name); return { content: [{ type: 'text', text: 'pong' }], details: undefined, isError: false }; },
  };
}

async function fixture({ maxToolSteps = 0, permissionMode = 'canvas' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-mcp-owner-'));
  const payloads = [];
  const state = { external: [], tools: [], mode: permissionMode };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    const last = body.messages.at(-1);
    if (last?.role === 'tool' || !state.tools.length) { frame({ role: 'assistant', content: 'done' }); frame({}, 'stop'); }
    else {
      frame({ role: 'assistant', tool_calls: state.tools.map((name, index) => ({ index, id: `call-${index}`, type: 'function', function: { name, arguments: '{}' } })) });
      frame({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const models = createModels(); models.setProvider(runtime.getProvider('beeftv'));
  const store = createDurableSessionStore({
    sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({ provider: 'beeftv', modelId: 'fixture' }), buildTools: () => [],
    authorizeTurn: async () => ({ open: true, canvasId: 'canvas', permissionMode: state.mode }),
    // 只读过滤由外部工具来源负责（mcp-tools.mjs 的 tools({permissionMode})）；这里照同样的合同替身。
    externalTools: async (entry) => state.external.filter((tool) => entry.generation.permissionMode !== 'read-only' || tool.readOnly),
    runWithBudget: (entry, fn) => {
      if (!entry.budget) entry.budget = createTurnBudget({ maxToolSteps });
      return fn();
    },
    completeTurn: async () => {}, settings: { retry: { maxRetries: 0 } },
  });
  const runTurn = async (turnId) => {
    const entry = await store.ensureSession('canvas');
    const submission = await store.submit(entry, { turnId, content: `turn ${turnId}`, revisionBefore: 1 });
    return store.wait(entry, submission);
  };
  return { state, payloads, runTurn, async close() { await store.disposeAll(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

describe('Durable 外部 MCP 工具', () => {
  test('服务器在两轮之间新增后，下一轮才出现并可以调用', async () => {
    const fx = await fixture();
    try {
      const first = await fx.runTurn('turn-1');
      expect(first.toolCalls).toEqual([]);
      expect((fx.payloads[0].tools || []).map((tool) => tool.function.name)).not.toContain(PING);

      const calls = [];
      fx.state.external = [externalTool(PING, false, calls)];
      fx.state.tools = [PING];
      const second = await fx.runTurn('turn-2');
      expect(calls).toEqual([PING]);
      expect(second.toolCalls.map((call) => call.tool)).toEqual([PING]);
      expect(second.toolCalls[0].isError).toBe(false);
      expect(fx.payloads.at(-2).tools.map((tool) => tool.function.name)).toContain(PING);
    } finally { await fx.close(); }
  });

  test('只读回合只装配只读 MCP 工具', async () => {
    const fx = await fixture({ permissionMode: 'read-only' });
    try {
      fx.state.external = [externalTool(PING, true), externalTool('mcp__srv__write', false)];
      await fx.runTurn('turn-1');
      const names = (fx.payloads[0].tools || []).map((tool) => tool.function.name);
      expect(names).toContain(PING);
      expect(names).not.toContain('mcp__srv__write');
    } finally { await fx.close(); }
  });

  test('MCP 工具调用计入本轮工具步数预算', async () => {
    const fx = await fixture({ maxToolSteps: 1 });
    try {
      const calls = [];
      fx.state.external = [externalTool(PING, false, calls), externalTool('mcp__srv__other', false, calls)];
      fx.state.tools = [PING, 'mcp__srv__other'];
      const record = await fx.runTurn('turn-1');
      expect(calls).toEqual([PING]);
      const denied = record.toolCalls.find((call) => call.isError);
      expect(denied?.tool).toBe('mcp__srv__other');
      expect(denied?.error).toContain('工具步骤达到上限');
    } finally { await fx.close(); }
  });

  test('服务器被移除后，同名工具返回 mcp_tool_removed 而不是悄悄消失', async () => {
    const fx = await fixture();
    try {
      const calls = [];
      fx.state.external = [externalTool(PING, false, calls)];
      fx.state.tools = [PING];
      await fx.runTurn('turn-1');

      fx.state.external = [];
      fx.state.tools = [PING];
      await fx.runTurn('turn-2');
      expect(calls).toEqual([PING]);
      // 占位工具直接报错，错误会作为工具结果回到模型。
      expect(JSON.stringify(fx.payloads.at(-1).messages)).toContain('mcp_tool_removed');
    } finally { await fx.close(); }
  });
});
