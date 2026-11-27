import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore, durableStreamEvents } from './durable-session-owner.mjs';
import { closeSharedPhotonImages, createDurableApprovalExtension } from './durable-approval.mjs';
import { createModelFetchProxy, wrapProviderWithModelFetch } from './model-fetch-proxy.mjs';
import { createDurableRequestBudget } from './durable-request-budget.mjs';

afterAll(async () => {
  await closeSharedPhotonImages();
});

// 生成最小合法 RGB PNG（不依赖外部二进制，用于真实测试 Photon Worker 预压缩）。
function makeSolidPngBase64(width, height) {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * rowBytes;
    raw[off] = 0; // filter None
    for (let x = 0; x < width; x += 1) {
      raw[off + 1 + x * 3] = (x * 7) & 0xff;
      raw[off + 1 + x * 3 + 1] = (y * 11) & 0xff;
      raw[off + 1 + x * 3 + 2] = 0x80;
    }
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

function readPngDimensions(base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 24) return { width: 0, height: 0 };
  // PNG header
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }
  // JPEG SOF0/SOF2
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0, format: 'unknown' };
}

function makeScriptedModels(handler) {
  const models = createModels();
  const seenRequests = [];
  const runStream = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    (async () => {
      try {
        const callIdx = seenRequests.length;
        const clonedMessages = JSON.parse(JSON.stringify(context.messages || []));
        seenRequests.push({ callIdx, messages: clonedMessages, options: { metadata: options?.metadata } });
        const spec = await handler(callIdx, clonedMessages, context, options);
        const assistantMessage = {
          role: 'assistant',
          content: spec.content || [{ type: 'text', text: spec.text || 'ok' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: spec.stopReason || (spec.content?.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop'),
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: { ...assistantMessage, content: [] } });
        for (let i = 0; i < assistantMessage.content.length; i += 1) {
          const block = assistantMessage.content[i];
          if (block.type === 'text') {
            stream.push({ type: 'text_start', contentIndex: i, partial: assistantMessage });
            stream.push({ type: 'text_delta', contentIndex: i, delta: block.text, partial: assistantMessage });
            stream.push({ type: 'text_end', contentIndex: i, content: block.text, partial: assistantMessage });
          } else if (block.type === 'toolCall') {
            stream.push({ type: 'toolcall_start', contentIndex: i, partial: assistantMessage });
            stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: assistantMessage });
          }
        }
        stream.push({ type: 'done', reason: assistantMessage.stopReason, message: assistantMessage });
      } catch (err) {
        stream.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'error',
            errorMessage: err?.message || String(err),
            timestamp: Date.now(),
          },
        });
      }
    })();
    return stream;
  };
  models.setProvider(createProvider({
    id: 'beeftv',
    name: 'BeeftvTest',
    baseUrl: 'http://127.0.0.1:1',
    auth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'synthetic' }, source: 'test' }) } },
    models: [{
      id: 'scripted-model',
      name: 'Scripted',
      api: 'openai-completions',
      provider: 'beeftv',
      baseUrl: 'http://127.0.0.1:1',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    api: {
      stream: runStream,
      streamSimple: runStream,
    },
  }));
  return { models, seenRequests };
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('waitUntil timed out');
}

describe('PR-5: Central ToolHooks.beforeTool approval parking, afterTool terminate, monotone media cutoff & Photon fit', () => {
  test('beforeTool fail-closed: Go 预检异常时显式返回 { block }，绝不放行付费工具执行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-failclosed-'));
    let submitExecutions = 0;
    const { models, seenRequests } = makeScriptedModels((callIdx) => {
      if (callIdx === 0) {
        return {
          content: [{ type: 'toolCall', id: 'tc-paid-1', name: 'canvas_generation_submit', arguments: { nodeIds: ['n1'] } }],
          stopReason: 'toolUse',
        };
      }
      return { text: '已拦截并告知用户' };
    });

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: () => [{
        name: 'canvas_generation_submit',
        label: 'canvas.generation.submit',
        readOnly: false,
        replay: 'unsafe',
        description: '提交付费生成',
        parameters: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } } },
        execute: async () => {
          submitExecutions += 1;
          return { content: [{ type: 'text', text: '{"submitted":true}' }] };
        },
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      precheckTool: async () => {
        throw new Error('go_precheck_db_unavailable');
      },
      enableImageFitting: false,
    });
    try {
      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, { turnId: 't-failclosed', requestId: 'r-1', content: '生成镜1', userText: '生成镜1', revisionBefore: 1 });
      const res = await store.wait(entry, sub);
      expect(res.error).toBeNull();
      expect(submitExecutions).toBe(0);
      // 确认第二轮模型收到了明确的 toolResult 错误消息，而不是静默执行
      const secondReq = seenRequests[1];
      const toolResultMsg = secondReq.messages.find((m) => m.role === 'toolResult');
      expect(toolResultMsg?.isError).toBe(true);
      expect(JSON.stringify(toolResultMsg?.content)).toContain('go_precheck_db_unavailable');
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('beforeTool 统一权限门控：只读模式下直调与 codemode 嵌套写入均被拦截', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-readonly-'));
    let writeExecutions = 0;
    const { models, seenRequests } = makeScriptedModels((callIdx) => {
      if (callIdx === 0) {
        return {
          content: [
            { type: 'toolCall', id: 'tc-direct-write', name: 'canvas_node_update', arguments: { nodeId: 'n1', title: 'hack' } },
            {
              type: 'toolCall',
              id: 'tc-codemode-write',
              name: 'codemode',
              arguments: { code: 'return await canvas_node_update({ nodeId: "n1", title: "nested-hack" });' },
            },
          ],
          stopReason: 'toolUse',
        };
      }
      return { text: '只读模式已安全拦截写入' };
    });

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      codemodeSandbox: new CodemodeSandbox(),
      buildTools: () => [{
        name: 'canvas_node_update',
        label: 'canvas.node.update',
        readOnly: false,
        replay: 'safe',
        description: '修改节点',
        parameters: { type: 'object', properties: { nodeId: { type: 'string' }, title: { type: 'string' } } },
        execute: async () => {
          writeExecutions += 1;
          return { content: [{ type: 'text', text: '{"updated":true}' }] };
        },
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'read-only' }),
      enableImageFitting: false,
    });
    try {
      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, {
        turnId: 't-ro',
        requestId: 'r-ro',
        content: '试着改写',
        userText: '试着改写',
        permissionMode: 'read-only',
        revisionBefore: 1,
      });
      const res = await store.wait(entry, sub);
      expect(res.error).toBeNull();
      expect(writeExecutions).toBe(0);
      const toolResults = seenRequests[1].messages.filter((m) => m.role === 'toolResult');
      expect(toolResults.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(toolResults)).toContain('scope_denied');
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('beforeTool 原地审批休眠 -> 实时 approval_required 与 /history 恢复 -> ApprovalDecision 信号同回合无缝续跑', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-approve-'));
    let submitExecutions = 0;
    let precheckCalls = 0;
    const seenEvents = [];
    const { models } = makeScriptedModels((callIdx) => {
      if (callIdx === 0) {
        return {
          content: [{ type: 'toolCall', id: 'tc-gen-1', name: 'canvas_generation_submit', arguments: { nodeIds: ['shot-1'] } }],
          stopReason: 'toolUse',
        };
      }
      return { text: '镜1已生成完成！' };
    });

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: () => [{
        name: 'canvas_generation_submit',
        label: 'canvas.generation.submit',
        readOnly: false,
        replay: 'unsafe',
        description: '提交付费生成',
        parameters: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } } },
        execute: async () => {
          submitExecutions += 1;
          return { content: [{ type: 'text', text: '{"taskIds":["task-shot-1"]}' }] };
        },
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      precheckTool: async (payload) => {
        precheckCalls += 1;
        return {
          decision: 'approval_required',
          proposalId: 'ap-shot-1',
          summary: '即将生成 1 项素材（预计 ¥1.50）',
          estimatedCny: 1.5,
          suggestedCapCny: 20,
          kinds: ['image'],
          approval: { nodeIds: payload.params?.nodeIds || ['shot-1'] },
        };
      },
      enableImageFitting: false,
    });
    try {
      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, { turnId: 't-apv', requestId: 'r-apv', content: '生成镜1', userText: '生成镜1', revisionBefore: 1 });
      const waitPromise = store.wait(entry, sub, {
        onEvent: (ev) => {
          seenEvents.push(ev, ...durableStreamEvents(ev));
        },
      });

      // 等待工具进入审批休眠并向实时流投递 tool_parked + approval_required 事件
      await waitUntil(() => seenEvents.some((e) => e.type === 'approval_required' && e.proposalId === 'ap-shot-1'));
      expect(seenEvents.some((e) => e.type === 'tool_parked' && e.approval?.proposalId === 'ap-shot-1')).toBe(true);
      expect(submitExecutions).toBe(0);
      expect(precheckCalls).toBe(1);

      // 页面刷新走 /history 同样能恢复 pendingApprovals 与 approval 阶段
      const hist = await store.history('c1', entry.sessionId);
      expect(hist.active?.pendingApprovals?.length).toBe(1);
      expect(hist.active.pendingApprovals[0].proposalId).toBe('ap-shot-1');
      expect(hist.active.lifecycle?.phase).toBe('approval');

      // 用户点击批准 -> Go 投递 ApprovalDecision 信号 -> 同回合原地恢复并执行工具
      const delivered = await store.deliverSignal('c1', entry.sessionId, {
        durableTaskId: hist.active.pendingApprovals[0].durableTaskId,
        signal: 'approval_decision',
        key: 'ap-shot-1',
        value: { decision: 'approve', mandateId: 'm-1' },
      });
      expect(delivered.ok).toBe(true);

      const res = await waitPromise;
      expect(res.error).toBeNull();
      expect(submitExecutions).toBe(1);
      expect(res.reply).toContain('镜1已生成完成');
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('beforeTool 拒绝信号直接返回 { block: 用户已拒绝该操作 }，绝不执行付费工具', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-reject-'));
    let submitExecutions = 0;
    const seenEvents = [];
    const { models, seenRequests } = makeScriptedModels((callIdx) => {
      if (callIdx === 0) {
        return {
          content: [{ type: 'toolCall', id: 'tc-rej-1', name: 'canvas_generation_submit', arguments: { nodeIds: ['shot-2'] } }],
          stopReason: 'toolUse',
        };
      }
      return { text: '好的，已取消生成。' };
    });

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: () => [{
        name: 'canvas_generation_submit',
        label: 'canvas.generation.submit',
        readOnly: false,
        replay: 'unsafe',
        description: '提交付费生成',
        parameters: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } } },
        execute: async () => {
          submitExecutions += 1;
          return { content: [{ type: 'text', text: '{"submitted":true}' }] };
        },
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      precheckTool: async () => ({
        decision: 'approval_required',
        proposalId: 'ap-reject-1',
        summary: '生成镜2',
      }),
      enableImageFitting: false,
    });
    try {
      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, { turnId: 't-rej', requestId: 'r-rej', content: '生成镜2', userText: '生成镜2', revisionBefore: 1 });
      const waitPromise = store.wait(entry, sub, {
        onEvent: (ev) => {
          seenEvents.push(ev, ...durableStreamEvents(ev));
        },
      });

      const approvalEvent = await waitUntil(() => seenEvents.find((e) => e.type === 'approval_required' && e.proposalId === 'ap-reject-1'));
      await store.deliverSignal('c1', entry.sessionId, {
        durableTaskId: approvalEvent.durableTaskId,
        signal: 'approval_decision',
        key: 'ap-reject-1',
        value: { decision: 'reject' },
      });

      const res = await waitPromise;
      expect(res.error).toBeNull();
      expect(submitExecutions).toBe(0);
      const toolResultMsg = seenRequests[1].messages.find((m) => m.role === 'toolResult');
      expect(toolResultMsg?.isError).toBe(true);
      expect(JSON.stringify(toolResultMsg?.content)).toContain('用户已拒绝该操作');
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('gatedCall 提前唤醒幂等性：同一 (turnId, callId) 经 memo 复用同一 proposalId，不产生重复审批单', async () => {
    const memoStore = new Map();
    let seq = 0;
    const ext = createDurableApprovalExtension({
      entry: { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000001', permissionMode: 'canvas', turn: { turnId: 'turn-memo-1' }, generation: {} },
      precheckTool: async () => ({
        decision: 'approval_required',
        proposalId: `ap-seq-${++seq}`,
        summary: '首次预检提案',
      }),
    });
    const beforeTool = ext.hooks[0].handlers.beforeTool;
    let deliveredSignal = undefined;
    const runtime = {
      taskId: 42,
      conversationId: 1,
      now: () => 1_700_000_000_000,
      memo: async function memo(key, valueOrCtx) {
        if (arguments.length >= 3 && !memoStore.has(key)) {
          memoStore.set(key, valueOrCtx);
        }
        return memoStore.get(key);
      },
      readSignal: async (_token, key) => (key === 'ap-seq-1' ? deliveredSignal : undefined),
      commit: async () => undefined,
    };
    const call = { id: 'tc-memo-1', name: 'canvas_generation_submit', arguments: { nodeIds: ['n1'] } };

    // 1. 首次预检：memo 固定 proposalId = ap-seq-1 并休眠
    const park1 = await beforeTool(call, runtime, {});
    expect(park1?.sleep?.signals).toEqual([{ signal: 'approval_decision', key: 'ap-seq-1' }]);

    // 2. 重启/扩展重装导致提前唤醒（信号尚未到达）：即使预检返回新编号，仍复用 memo 中的 ap-seq-1
    const park2 = await beforeTool(call, runtime, {});
    expect(park2?.sleep?.signals).toEqual([{ signal: 'approval_decision', key: 'ap-seq-1' }]);

    // 3. 信号到达 ap-seq-1 -> 放行执行
    deliveredSignal = { value: { decision: 'approve' } };
    const resumed = await beforeTool(call, runtime, {});
    expect(resumed).toBeUndefined();
  });

  test('ToolHooks.afterTool 终止分离：同批 plan_update + canvas_generation_propose 立即结束本轮（仅 1 次 LLM 请求）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-terminate-'));
    const { models, seenRequests } = makeScriptedModels((callIdx) => {
      if (callIdx === 0) {
        return {
          content: [
            { type: 'toolCall', id: 'tc-plan', name: 'plan_update', arguments: { goal: '制作短片', items: [{ id: 's1', title: '生成首帧', status: 'needs_user' }] } },
            { type: 'toolCall', id: 'tc-prop', name: 'canvas_generation_propose', arguments: { nodeIds: ['img-1'] } },
          ],
          stopReason: 'toolUse',
        };
      }
      return { text: '不应该有第二次总结请求' };
    });

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: (_canvasId, _log, _gen, turn) => [{
        name: 'canvas_generation_propose',
        label: 'canvas.generation.propose',
        readOnly: false,
        replay: 'safe',
        description: '提出生成方案',
        parameters: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } } },
        execute: async () => {
          turn.proposals.push({ proposalId: 'prop-1', kind: 'image', nodeIds: ['img-1'] });
          return { content: [{ type: 'text', text: '{"proposalId":"prop-1"}' }] };
        },
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      enableImageFitting: false,
    });
    try {
      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, { turnId: 't-prop', requestId: 'r-prop', content: '规划并提案', userText: '规划并提案', revisionBefore: 1 });
      const res = await store.wait(entry, sub);
      expect(res.error).toBeNull();
      expect(res.proposals).toHaveLength(1);
      // 关键：afterTool 正确给 plan_update 打上 control.terminate，零多余总结 LLM 请求！
      expect(seenRequests).toHaveLength(1);
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('单调媒体缓存游标 E2E：相邻两轮对比视觉图前缀 100% 字节一致，第 3 轮超预算后持久化单调前推', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-mediacutoff-'));
    const pad = 'B'.repeat(26 * 1024);
    let shotSeq = 0;
    const { models, seenRequests } = makeScriptedModels((callIdx) => {
      // 每轮先调用一次 media_overview 返回 26KB 大图，再给出文字回复
      if (callIdx % 2 === 0) {
        shotSeq += 1;
        return {
          content: [{ type: 'toolCall', id: `tc-img-${shotSeq}`, name: 'media_overview', arguments: { nodeId: `shot-${shotSeq}` } }],
          stopReason: 'toolUse',
        };
      }
      return { text: `已查看镜${shotSeq}` };
    });

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: () => [{
        name: 'media_overview',
        label: 'media.overview',
        readOnly: true,
        replay: 'safe',
        description: '查看媒体概览',
        parameters: { type: 'object', properties: { nodeId: { type: 'string' } } },
        execute: async (_id, args) => ({
          content: [
            { type: 'text', text: `{"op":"media.overview","nodeId":"${args.nodeId}"}` },
            { type: 'image', mimeType: 'image/jpeg', data: `${args.nodeId}_${pad}` },
          ],
        }),
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      enableImageFitting: false,
      // 70KB 预算：两张 26KB 图（52KB <= 70KB）保持前缀字节一致；第三张到来（78KB > 70KB）才单调推进游标！
      maxInlineImageChars: 70 * 1024,
    });
    try {
      const entry = await store.ensureSession('c1');

      // Turn 1: 查看 shot-1 (26KB)
      const sub1 = await store.submit(entry, { turnId: 't1', requestId: 'r1', content: '看镜1', userText: '看镜1', revisionBefore: 1 });
      expect((await store.wait(entry, sub1)).error).toBeNull();

      // Turn 2: 查看 shot-2 (累计 52KB <= 70KB)
      const sub2 = await store.submit(entry, { turnId: 't2', requestId: 'r2', content: '对比镜2', userText: '对比镜2', revisionBefore: 1 });
      expect((await store.wait(entry, sub2)).error).toBeNull();

      // seenRequests[1] 是 Turn 1 拿到 shot-1 后的请求；seenRequests[3] 是 Turn 2 拿到 shot-2 后的请求
      const turn1AfterTool = seenRequests[1].messages;
      const turn2AfterTool = seenRequests[3].messages;
      const prefixLen = turn1AfterTool.length - 1; // 去掉末尾 transient studio tail
      expect(JSON.stringify(turn2AfterTool.slice(0, prefixLen))).toBe(JSON.stringify(turn1AfterTool.slice(0, prefixLen)));
      // 两张图都原样保留在 Turn 2 请求中，KV-Cache 前缀 100% 命中
      expect(JSON.stringify(turn2AfterTool)).toContain('shot-1_');
      expect(JSON.stringify(turn2AfterTool)).toContain('shot-2_');

      // Turn 3: 查看 shot-3 (累计 78KB > 70KB -> MediaRetentionDoc 单调前推，只折叠最旧的 shot-1)
      const sub3 = await store.submit(entry, { turnId: 't3', requestId: 'r3', content: '再看镜3', userText: '再看镜3', revisionBefore: 1 });
      expect((await store.wait(entry, sub3)).error).toBeNull();
      const turn3AfterTool = seenRequests[5].messages;
      expect(JSON.stringify(turn3AfterTool)).not.toContain('shot-1_');
      expect(JSON.stringify(turn3AfterTool)).toContain('shot-2_');
      expect(JSON.stringify(turn3AfterTool)).toContain('shot-3_');
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('Photon createFitImagesExtension 实机预压缩超大图片，且 createModelFetchProxy 绝不污染 globalThis.fetch', async () => {
    const prevGlobalFetch = globalThis.fetch;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-pr5-photon-'));
    const bigPngBase64 = makeSolidPngBase64(2400, 1800);
    expect(readPngDimensions(bigPngBase64)).toMatchObject({ width: 2400, height: 1800, format: 'png' });

    // 验证局部 fetch proxy + wrapProviderWithModelFetch 不触碰 globalThis.fetch
    const proxy = createModelFetchProxy({
      baseUrl: 'http://127.0.0.1:1/v1',
      isRawBaseUrl: false,
      modelApi: 'openai-completions',
      modelId: 'scripted-model',
      turnBudgetContext: new AsyncLocalStorage(),
      nativePartStore: null,
      lifetimeBudget: createDurableRequestBudget({ limit: 0, file: path.join(dir, 'budget.json') }),
      dispatchDiagnostics: { record: () => {} },
      getOps: () => ({ opsRequest: async () => ({}) }),
    });
    expect(globalThis.fetch).toBe(prevGlobalFetch);

    const { models, seenRequests } = makeScriptedModels((callIdx) => {
      if (callIdx === 0) {
        return {
          content: [{ type: 'toolCall', id: 'tc-big-png', name: 'media_overview', arguments: { nodeId: 'big-1' } }],
          stopReason: 'toolUse',
        };
      }
      return { text: '已收到压缩后的参考图' };
    });
    // 同步测试 wrapProviderWithModelFetch 对 provider.streamSimple 的包装（且仍不污染 globalThis.fetch）
    const wrappedProvider = wrapProviderWithModelFetch(models.getProvider('beeftv'), proxy.fetch);
    models.setProvider(wrappedProvider);
    expect(globalThis.fetch).toBe(prevGlobalFetch);

    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: () => [{
        name: 'media_overview',
        label: 'media.overview',
        readOnly: true,
        replay: 'safe',
        description: '返回超大图',
        parameters: { type: 'object', properties: { nodeId: { type: 'string' } } },
        execute: async () => ({
          content: [
            { type: 'text', text: '{"op":"media.overview"}' },
            { type: 'image', mimeType: 'image/png', data: bigPngBase64 },
          ],
        }),
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      enableImageFitting: true,
    });
    try {
      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, { turnId: 't-fit', requestId: 'r-fit', content: '看大图', userText: '看大图', revisionBefore: 1 });
      const res = await store.wait(entry, sub);
      expect(res.error).toBeNull();
      // 验证 Photon Worker 已经在工具结果落盘前把 2400x1800 图片压缩到合法上限以内
      const toolResult = seenRequests[1].messages.find((m) => m.role === 'toolResult');
      const imgPart = toolResult?.content?.find((p) => p.type === 'image');
      expect(imgPart).toBeTruthy();
      const fittedDim = readPngDimensions(imgPart.data);
      expect(Math.max(fittedDim.width, fittedDim.height)).toBeLessThanOrEqual(2000);
      expect(Math.max(fittedDim.width, fittedDim.height)).toBeGreaterThan(0);
      // 同时确认 Pi 原生 settings.stream.metadata.user_id 已传递
      expect(seenRequests[0].options.metadata).toEqual({ user_id: entry.sessionId });
      expect(globalThis.fetch).toBe(prevGlobalFetch);
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
