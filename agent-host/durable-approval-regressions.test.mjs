import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { closeSharedPhotonImages, createDurableApprovalExtension } from './durable-approval.mjs';
import { createCreativeCompactionExtension } from './durable-compaction.mjs';
import { MediaRetentionDoc } from './studio-digest.mjs';

afterAll(async () => {
  await closeSharedPhotonImages();
});

function makeScriptedModels(turnResponder) {
  const models = createModels();
  const seenRequests = [];
  const runStream = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    (async () => {
      const idx = seenRequests.length;
      const clonedMessages = JSON.parse(JSON.stringify(context.messages || []));
      seenRequests.push({ model, messages: clonedMessages, options });
      const plan = await turnResponder(idx, context, options);
      const message = {
        role: 'assistant',
        content: plan.content || [{ type: 'text', text: plan.text || 'ok' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: plan.stopReason || (plan.content?.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop'),
        timestamp: Date.now(),
      };
      stream.push({ type: 'start', partial: { ...message, content: [] } });
      for (let i = 0; i < message.content.length; i += 1) {
        const block = message.content[i];
        if (block.type === 'text') {
          stream.push({ type: 'text_start', contentIndex: i, partial: message });
          stream.push({ type: 'text_delta', contentIndex: i, delta: block.text, partial: message });
          stream.push({ type: 'text_end', contentIndex: i, content: block.text, partial: message });
        } else if (block.type === 'toolCall') {
          stream.push({ type: 'toolcall_start', contentIndex: i, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: block, partial: message });
        }
      }
      stream.push({ type: 'done', reason: message.stopReason, message });
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

describe('PR-5 Review Regressions: MediaRetentionDoc fork/compaction, beforeTool auth/fail-closed, read-only plugins & afterTools', () => {
  test('Item 7a + 8d: MediaRetentionDoc 使用 fork:"current" 在 forkSession 中保留游标，且转发 maxInlineImageChars', async () => {
    expect(MediaRetentionDoc.definition.fork).toBe('current');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-fork-retention-'));
    const imgPayload = Buffer.alloc(36 * 1024, 0x41).toString('base64');
    const { models, seenRequests } = makeScriptedModels((idx) => {
      if (idx === 0) return { content: [{ type: 'toolCall', id: 'tc-img-1', name: 'media_overview', arguments: { nodeId: 'n1' } }], stopReason: 'toolUse' };
      if (idx === 1) return { text: '图 1 完成' };
      if (idx === 2) return { content: [{ type: 'toolCall', id: 'tc-img-2', name: 'media_overview', arguments: { nodeId: 'n2' } }], stopReason: 'toolUse' };
      if (idx === 3) return { text: '图 2 完成' };
      return { text: '分支后继续' };
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
        description: '返回图片',
        parameters: { type: 'object', properties: { nodeId: { type: 'string' } } },
        execute: async (args) => ({
          content: [
            { type: 'text', text: JSON.stringify({ op: 'media.overview', nodeId: args.nodeId }) },
            { type: 'image', mimeType: 'image/png', data: imgPayload },
          ],
        }),
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      enableImageFitting: false,
      maxInlineImageChars: 40 * 1024,
    });
    try {
      const entry = await store.ensureSession('c1');
      await store.wait(entry, await store.submit(entry, { turnId: 't1', requestId: 'r1', content: '看图1', userText: '看图1', revisionBefore: 1 }));
      await store.wait(entry, await store.submit(entry, { turnId: 't2', requestId: 'r2', content: '看图2', userText: '看图2', revisionBefore: 1 }));
      const srcDoc = await entry.harness.snapshot(MediaRetentionDoc, entry.root.id, CTX);
      expect(srcDoc.cutoffEntryId).toBeGreaterThan(0);

      // Fork session after turn 2: MediaRetentionDoc cutoff must survive via fork:'current' with zero TypeError!
      const forkedInfo = await store.forkSession('c1', { sessionId: entry.sessionId, turnId: 't2' });
      const forked = await store.ensureSession('c1', forkedInfo.sessionId);
      const forkedDoc = await forked.harness.snapshot(MediaRetentionDoc, forked.root.id, CTX);
      expect(forkedDoc.cutoffEntryId).toBe(srcDoc.cutoffEntryId);
      // Verify forked session continues smoothly using forwarded settings (enableImageFitting:false, maxInlineImageChars).
      const afterFork = await store.wait(forked, await store.submit(forked, { turnId: 't3', requestId: 'r3', content: '继续', userText: '继续', revisionBefore: 1 }));
      expect(afterFork.error).toBeNull();
      expect(seenRequests.length).toBe(5);
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('Item 7b: 压缩生成失败时不推进 MediaRetentionDoc.cutoffEntryId；成功时推进到 entries.at(-1).id', async () => {
    const retentionState = { cutoffEntryId: 0, cutoffMessageIndex: 0 };
    const makeApi = (completeResult) => ({
      conversationId: 'conv-1',
      now: () => Date.now(),
      settings: { stream: {} },
      agent: async () => ({ model: { provider: 'beeftv', modelId: 'm1' }, thinkingLevel: 'off' }),
      models: {
        getModel: () => ({ id: 'm1', provider: 'beeftv', api: 'openai-completions', contextWindow: 128000, maxTokens: 4096 }),
        completeSimple: async () => {
          if (completeResult instanceof Error) throw completeResult;
          return completeResult;
        },
      },
      snapshot: async () => ({ model: { provider: 'beeftv', modelId: 'm1' }, thinkingLevel: 'off' }),
      commit: async (fn) => fn({ doc: async () => retentionState }),
    });
    const ext = createCreativeCompactionExtension({
      entry: { canvasId: 'c1', sessionId: 's1', turn: { turnId: 't1' }, compactingHookCount: 0 },
      state: async () => ({ plan: null }),
      skills: null,
      resolveActiveSkills: async () => ({ loadedIds: [], resources: [] }),
    });
    const beforeCompact = ext.hooks[0].handlers.beforeCompact;
    const compaction = {
      entries: [{ id: 10, model: [{ role: 'user', content: 'u1' }] }, { id: 25, model: [{ role: 'assistant', content: [{ type: 'text', text: 'a1' }] }] }],
    };

    // 1. Failed compaction (error thrown) -> returns undefined AND leaves cutoffEntryId at 0!
    const failed1 = await beforeCompact(compaction, makeApi(new Error('upstream 502')), {});
    expect(failed1).toBeUndefined();
    expect(retentionState.cutoffEntryId).toBe(0);

    // 2. Empty/non-stop summary -> returns undefined AND leaves cutoffEntryId at 0!
    const failed2 = await beforeCompact(compaction, makeApi({ stopReason: 'error', content: [] }), {});
    expect(failed2).toBeUndefined();
    expect(retentionState.cutoffEntryId).toBe(0);

    // 3. Valid summary -> advances cutoffEntryId strictly to entries.at(-1).id (25)!
    const ok = await beforeCompact(compaction, makeApi({
      stopReason: 'stop',
      content: [{ type: 'text', text: '已整理当前创作摘要（canvasId: c1）' }],
    }), {});
    expect(ok?.summary).toContain('已整理当前创作摘要');
    expect(retentionState.cutoffEntryId).toBe(25);
  });

  test('Item 8a: beforeTool 先校验 authorization 再查 permissionMode/canvasId，且付费工具缺少预检通道时 fail-closed', async () => {
    const order = [];
    const entry = {
      canvasId: 'c1',
      sessionId: 's1',
      permissionMode: 'read-only',
      readOnlyToolNames: new Set(['canvas_get']),
      generation: { permissionMode: 'read-only', aborted: false },
      turn: { turnId: 't-auth-order' },
    };
    const extAuthFail = createDurableApprovalExtension({
      entry,
      authorization: async () => {
        order.push('authorization');
        throw Object.assign(new Error('turn_revoked'), { reason: 'turn_revoked' });
      },
      precheckTool: null,
    });
    const beforeTool1 = extAuthFail.hooks[0].handlers.beforeTool;
    // Even for a write tool blocked in read-only mode, authorization MUST run first and return turn_revoked!
    const res1 = await beforeTool1(
      { id: 'c-1', name: 'canvas_node_create', arguments: { canvasId: 'c-other' } },
      { taskId: 1, memo: async () => undefined },
      {},
    );
    expect(order).toEqual(['authorization']);
    expect(res1).toEqual({ block: 'turn_revoked' });

    // Paid tool with NO runPrecheck (neither precheckTool nor opsRequest) MUST fail closed!
    const extNoPrecheck = createDurableApprovalExtension({
      entry: { ...entry, permissionMode: 'canvas', generation: { permissionMode: 'canvas', aborted: false } },
      authorization: async () => {},
      precheckTool: null,
      opsRequest: null,
    });
    const beforeTool2 = extNoPrecheck.hooks[0].handlers.beforeTool;
    const res2 = await beforeTool2(
      { id: 'c-paid', name: 'canvas_generation_submit', arguments: { canvasId: 'c1', nodeIds: ['n1'] } },
      { taskId: 2, memo: async () => undefined },
      {},
    );
    expect(res2).toEqual({ block: 'tool_precheck_unavailable' });
  });

  test('Item 8b: configurePermission("read-only") 保留只读插件工具白名单，同时拦截写入型插件工具', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-ro-'));
    let readPluginCalls = 0;
    let writePluginCalls = 0;
    const { models } = makeScriptedModels((idx) => {
      if (idx === 0) {
        return {
          content: [
            { type: 'toolCall', id: 'tc-ro', name: 'plugin_read_probe', arguments: {} },
            { type: 'toolCall', id: 'tc-wr', name: 'plugin_write_probe', arguments: {} },
          ],
          stopReason: 'toolUse',
        };
      }
      return { text: '只读插件检查完毕' };
    });
    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
      buildTools: () => [],
      extensions: async () => [{
        name: 'test.plugin.ro',
        tools: [
          {
            name: 'plugin_read_probe',
            description: '只读插件工具',
            readOnly: true,
            parameters: { type: 'object', properties: {} },
            execute: async () => { readPluginCalls += 1; return { content: [{ type: 'text', text: '{"ok":true}' }] }; },
          },
          {
            name: 'plugin_write_probe',
            description: '写入插件工具',
            readOnly: false,
            parameters: { type: 'object', properties: {} },
            execute: async () => { writePluginCalls += 1; return { content: [{ type: 'text', text: '{"ok":true}' }] }; },
          },
        ],
      }],
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'read-only' }),
      enableImageFitting: false,
    });
    try {
      const entry = await store.ensureSession('c1');
      // Explicitly switch permission mode to read-only (triggers projectHostTools('read-only')).
      await entry.configurePermission('read-only');
      const res = await store.wait(entry, await store.submit(entry, {
        turnId: 't-ro-plugin',
        requestId: 'r-ro-plugin',
        content: '调用只读和写入插件',
        userText: '调用只读和写入插件',
        permissionMode: 'read-only',
        revisionBefore: 1,
      }));
      expect(res.error).toBeNull();
      expect(readPluginCalls).toBe(1);
      expect(writePluginCalls).toBe(0);
    } finally {
      await store.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('Item 8c: GenerationHooks.afterTools 无论 [propose, plan_update] 还是 [plan_update, propose] 均仅 1 次 LLM 请求收口', async () => {
    for (const order of ['propose_first', 'plan_first']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-aftertools-${order}-`));
      const calls = order === 'propose_first'
        ? [
          { type: 'toolCall', id: 'tc-p', name: 'canvas_generation_propose', arguments: { nodeIds: ['n1'] } },
          { type: 'toolCall', id: 'tc-u', name: 'plan_update', arguments: { goal: 'g', items: [{ id: 's1', title: 'S1', status: 'needs_user' }] } },
        ]
        : [
          { type: 'toolCall', id: 'tc-u', name: 'plan_update', arguments: { goal: 'g', items: [{ id: 's1', title: 'S1', status: 'needs_user' }] } },
          { type: 'toolCall', id: 'tc-p', name: 'canvas_generation_propose', arguments: { nodeIds: ['n1'] } },
        ];
      const { models, seenRequests } = makeScriptedModels((idx) => (
        idx === 0 ? { content: calls, stopReason: 'toolUse' } : { text: '不应触发第二次请求' }
      ));
      const store = createDurableSessionStore({
        sessionRoot: path.join(dir, 'sessions'),
        workspaceRoot: path.join(dir, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'scripted-model' }),
        buildTools: (_c, _l, _g, turn) => [{
          name: 'canvas_generation_propose',
          label: 'canvas.generation.propose',
          readOnly: false,
          replay: 'safe',
          description: '提议生成',
          parameters: { type: 'object', properties: { nodeIds: { type: 'array', items: { type: 'string' } } } },
          execute: async () => {
            turn.proposals.push({ proposalId: `gp-${order}`, kind: 'image', nodeIds: ['n1'] });
            return { content: [{ type: 'text', text: `{"proposalId":"gp-${order}"}` }] };
          },
        }],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        enableImageFitting: false,
      });
      try {
        const entry = await store.ensureSession('c1');
        const res = await store.wait(entry, await store.submit(entry, {
          turnId: `t-${order}`,
          requestId: `r-${order}`,
          content: '准备方案并更新计划',
          userText: '准备方案并更新计划',
          revisionBefore: 1,
        }));
        expect(res.error).toBeNull();
        expect(seenRequests.length).toBe(1);
        expect(res.proposals[0]?.proposalId).toBe(`gp-${order}`);
      } finally {
        await store.disposeAll();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 20000);
});
