import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { providerRegistration } from './canvas-turn.mjs';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { buildStudioDigest } from './studio-digest.mjs';

const CTX = BACKGROUND_CONTEXT;

async function startStubModelServer(replies) {
  let callIndex = 0;
  const seenRequests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    seenRequests.push(body);
    const reply = replies[callIndex++] ?? `reply-${callIndex}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const writeChunk = (delta, finishReason = null, usage = undefined) => {
      const payload = {
        id: `chatcmpl-fork-${callIndex}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'stub-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    writeChunk({ role: 'assistant', content: reply });
    writeChunk({}, 'stop', { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seenRequests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('Creative Harness Phase 2.3', () => {
  test('buildStudioDigest stays byte-identical without Creative Bible and appends digest when configured', () => {
    const baseCanvas = {
      revision: 3,
      nodes: [{ id: 'n1', type: 'text', title: '大纲', metadata: { content: '第一场雨夜追逐' } }],
      connections: [],
    };
    const withoutBible = buildStudioDigest(baseCanvas);
    expect(withoutBible.text).not.toContain('创作设定集');

    const withBible = buildStudioDigest({
      ...baseCanvas,
      creativeBibleDigest: '创作设定集「霓虹雨夜」（v1）：\n  画风质感：35mm 电影胶片\n  创作禁忌：禁止现代水印',
    });
    expect(withBible.text).toContain('创作设定集「霓虹雨夜」');
    expect(withBible.text).toContain('禁止现代水印');
    expect(withBible.text.startsWith(withoutBible.text)).toBe(true);

    // Even on a large storyboard canvas exceeding maxBytes, Creative Bible is preserved rather than dropped.
    const bigStoryboard = {
      revision: 9,
      nodes: [
        {
          id: 'script-1',
          type: 'script',
          title: '第一集分镜',
          metadata: {
            rows: Array.from({ length: 45 }, (_, idx) => ({
              id: `row-${idx + 1}`,
              shotNumber: idx + 1,
              durationSeconds: 4,
              plotDescription: `第${idx + 1}镜雨夜长街追逐冲突与细节镜头描写`,
              imageGenerationPrompt: `雨夜长街古建筑特写镜头 ${idx + 1}`,
            })),
          },
        },
      ],
      connections: [],
      creativeBibleDigest: '创作设定集「山海纪行」（v2）：\n  画风质感：新中式工笔水墨融合35mm胶片\n  创作禁忌：禁止现代霓虹招牌与英文路标',
    };
    const bigDigest = buildStudioDigest(bigStoryboard, { maxBytes: 2400 });
    expect(Buffer.byteLength(bigDigest.text, 'utf8')).toBeLessThanOrEqual(2400);
    expect(bigDigest.text).toContain('创作设定集「山海纪行」');
    expect(bigDigest.text).toContain('禁止现代霓虹招牌');
  });

  test('forkSession preserves trailing toolResult on terminate turns and resets post-fork plan/proposals', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-phase2-3-fork-term-'));
    const sessionRoot = path.join(tmpRoot, 'sessions');
    const workspaceRoot = path.join(tmpRoot, 'workspace');
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-phase23-fork-term';

    let callIdx = 0;
    const seenRequests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seenRequests.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const writeChunk = (delta, finishReason = null, usage = undefined) => {
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-term-${callIdx}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`);
      };
      callIdx += 1;
      if (callIdx === 1) {
        // Turn 1: emits a terminating tool call (canvas_generation_propose) so settled.answer precedes toolResult!
        writeChunk({
          role: 'assistant',
          content: '已准备好合并方案，请确认。',
          tool_calls: [{ index: 0, id: 'call_prop_1', type: 'function', function: { name: 'canvas_generation_propose', arguments: '{"canvasId":"c-term","nodeIds":["n1"]}' } }],
        });
        writeChunk({}, 'tool_calls', { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 });
        res.end('data: [DONE]\n\n');
        return;
      }
      if (callIdx === 2) {
        // Turn 2 on parent: sets a post-fork plan that must NOT leak into the fork at turn-1.
        writeChunk({
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_plan_2', type: 'function', function: { name: 'plan_update', arguments: JSON.stringify({ goal: '父分支后续计划', steps: [{ title: '父分支步骤', status: 'pending' }] }) } }],
        });
        writeChunk({}, 'tool_calls', { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 });
        res.end('data: [DONE]\n\n');
        return;
      }
      if (callIdx === 3) {
        writeChunk({ role: 'assistant', content: '父分支第二轮完成' });
        writeChunk({}, 'stop', { prompt_tokens: 70, completion_tokens: 10, total_tokens: 80 });
        res.end('data: [DONE]\n\n');
        return;
      }
      // Forked branch follow-up turn!
      writeChunk({ role: 'assistant', content: '分支后续回复成功' });
      writeChunk({}, 'stop', { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 });
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

    const runtime = await ModelRuntime.create({ authPath: path.join(tmpRoot, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('beeftv', providerRegistration({
      api: 'openai-completions',
      baseUrl,
      modelId: 'stub-model',
      maxTokens: 4096,
      contextWindow: 128000,
    }));
    const models = createModels();
    models.setProvider(runtime.getProvider('beeftv'));

    const store = createDurableSessionStore({
      sessionRoot,
      workspaceRoot,
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'stub-model' }),
      buildTools: (_canvasId, _log, _gen, turn) => [{
        name: 'canvas_generation_propose',
        label: 'canvas.generation.propose',
        readOnly: true,
        replay: 'safe',
        description: 'Propose generation',
        parameters: { type: 'object', properties: { canvasId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } } } },
        execute: async () => {
          turn.proposals.push({ proposalId: 'gp-term-1', kind: 'image', nodeIds: ['n1'], model: 'stub', modelKey: 'beeftv::stub' });
          return { content: [{ type: 'text', text: '{"proposalId":"gp-term-1"}' }], details: { proposalId: 'gp-term-1' } };
        },
      }],
      authorizeTurn: async ({ canvasId, turnId }) => ({ open: true, canvasId, turnId, permissionMode: 'canvas' }),
      completeTurn: async () => {},
      readCanvas: async () => ({ revision: 1, nodes: [], connections: [] }),
      settings: { retry: { maxRetries: 0 } },
    });

    try {
      const canvasId = 'c-term';
      const src = await store.createSession(canvasId);
      const runTurn = async (turnId, message) => {
        const cur = await store.ensureSession(canvasId, '', { handoffLegacy: false });
        const sub = await store.submit(cur, { turnId, requestId: `req-${turnId}`, content: message, userText: message, revisionBefore: 1, permissionMode: 'canvas' });
        await store.wait(cur, sub);
      };
      await runTurn('turn-prop', '准备图片提案');
      await runTurn('turn-parent-2', '继续做父分支计划');

      const forked = await store.forkSession(canvasId, { sessionId: src.sessionId, turnId: 'turn-prop' });
      const forkedHist = await store.history(canvasId, forked.sessionId);
      expect(forkedHist.turns.length).toBe(1);
      // Inherited parent proposals must be invalidated on the forked branch.
      expect(forkedHist.turns[0].proposalsInvalidated).toBe(true);
      // Post-fork parent plan must NOT leak into the forked branch.
      expect(forkedHist.plan ?? null).toBeNull();

      // Send a follow-up turn on the fork and confirm the model request carries BOTH tool_calls AND its matching tool result!
      await runTurn('turn-fork-next', '换个方向重新来');
      const lastReq = seenRequests.at(-1);
      const assistantWithCall = lastReq.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.id === 'call_prop_1'));
      const matchingToolResult = lastReq.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_prop_1');
      expect(assistantWithCall).toBeDefined();
      expect(matchingToolResult).toBeDefined();
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      await store.disposeAll();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('forkSession uses official Pi Durable conversation.fork() to branch cleanly at an earlier turn', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-phase2-3-fork-'));
    const sessionRoot = path.join(tmpRoot, 'sessions');
    const workspaceRoot = path.join(tmpRoot, 'workspace');
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-phase23-fork';
    const stub = await startStubModelServer([
      '第一轮回复：已构思雨夜开场',
      '第二轮回复：加入赛博追车桥段',
      '分支第三轮回复：改走安静悬疑路线',
    ]);

    const runtime = await ModelRuntime.create({
      authPath: path.join(tmpRoot, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('beeftv', providerRegistration({
      api: 'openai-completions',
      baseUrl: stub.baseUrl,
      modelId: 'stub-model',
      maxTokens: 4096,
      contextWindow: 128000,
    }));
    const models = createModels();
    models.setProvider(runtime.getProvider('beeftv'));

    const store = createDurableSessionStore({
      sessionRoot,
      workspaceRoot,
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'stub-model' }),
      buildTools: () => [],
      authorizeTurn: async ({ canvasId, turnId }) => ({ open: true, canvasId, turnId, permissionMode: 'canvas' }),
      completeTurn: async () => {},
      readCanvas: async () => ({ revision: 1, nodes: [], connections: [] }),
      settings: { retry: { maxRetries: 0 } },
    });

    try {
      const canvasId = 'canvas-fork-test';
      const entry = await store.createSession(canvasId);
      const sourceSessionId = entry.sessionId;

      const runTurn = async (turnId, message) => {
        const current = await store.ensureSession(canvasId, '', { handoffLegacy: false });
        const submission = await store.submit(current, {
          turnId,
          requestId: `req-${turnId}`,
          content: message,
          userText: message,
          revisionBefore: 1,
          selectedNodeIds: [],
          permissionMode: 'canvas',
        });
        await store.wait(current, submission);
      };

      await runTurn('turn-1', '先定一下雨夜开场基调');
      await runTurn('turn-2', '第二场加上高速追车戏');

      const beforeHistory = await store.history(canvasId, sourceSessionId);
      expect(beforeHistory.turns.length).toBe(2);
      expect(beforeHistory.turns[0].reply).toContain('雨夜开场');
      expect(beforeHistory.turns[1].reply).toContain('追车桥段');

      // Fork right after turn-1 (before turn-2 existed!)
      const forked = await store.forkSession(canvasId, { sessionId: sourceSessionId, turnId: 'turn-1' });
      expect(forked.sessionId).not.toBe(sourceSessionId);
      expect(forked.conversationId).toBeGreaterThan(1);
      expect(forked.turnCount).toBe(1);
      expect(forked.forkedFrom.sessionId).toBe(sourceSessionId);
      expect(forked.forkedFrom.turnId).toBe('turn-1');

      // Forked session history contains only turn-1 and preserves forkedFrom metadata.
      const forkedHistory = await store.history(canvasId, forked.sessionId);
      expect(forkedHistory.turns.length).toBe(1);
      expect(forkedHistory.turns[0].turnId).toBe('turn-1');
      expect(forkedHistory.forkedFrom?.turnId).toBe('turn-1');

      // Continue talking on the forked branch -> model context comes from turn-1, NOT turn-2!
      const forkedEntry = await store.ensureSession(canvasId, forked.sessionId);
      const forkedContext = await forkedEntry.root.context(CTX);
      const contextText = JSON.stringify(forkedContext.messages);
      expect(contextText).toContain('雨夜开场');
      expect(contextText).not.toContain('追车桥段');

      await runTurn('turn-3-alt', '这一版不要追车，改走安静悬疑路线');
      const forkedAfter = await store.history(canvasId, forked.sessionId);
      expect(forkedAfter.turns.length).toBe(2);
      expect(forkedAfter.turns[1].reply).toContain('安静悬疑');
      // Verify the actual HTTP request sent to the model on the forked branch did NOT contain turn-2!
      const lastRequestJSON = JSON.stringify(stub.seenRequests[stub.seenRequests.length - 1]);
      expect(lastRequestJSON).toContain('雨夜开场');
      expect(lastRequestJSON).not.toContain('追车桥段');

      // Original parent session remains completely intact with its original 2 turns!
      const parentAfter = await store.history(canvasId, sourceSessionId);
      expect(parentAfter.turns.length).toBe(2);
      expect(parentAfter.turns[1].reply).toContain('追车桥段');

      // Session list includes both parent and fork with forkedFrom metadata.
      const listed = await store.listCanvasSessions(canvasId);
      expect(listed.length).toBe(2);
      const forkMeta = listed.find((item) => item.sessionId === forked.sessionId);
      expect(forkMeta?.forkedFrom?.sessionId).toBe(sourceSessionId);

      // Deleting the forked session does NOT affect the parent session.
      await store.deleteSession(canvasId, forked.sessionId);
      const parentStillAlive = await store.history(canvasId, sourceSessionId);
      expect(parentStillAlive.turns.length).toBe(2);
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      await store.disposeAll();
      await stub.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
