// PR-4 Pi 1.6.0 原生长程运行时行为测试（续跑状态文档与创作态压缩）：
// 4. TurnContinuationDoc 跨重启与跨轮保留 planContinuations 并遵守 maxPlanContinuations；
// 5. CompactionTask.beforeCompact 创作态摘要保留 canvasId/分镜/resourceId/技能指针、记账公开 UsageDoc，瞬态错回退官方重试循环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { CompactionEntry, UsageDoc } from '@earendil-works/pi-durable';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { readTurnContinuation } from './durable-signals.mjs';
import { handleEventsRoute } from './events-route.mjs';
import { deterministicFollowUpTurnId, deterministicWakeTurnId, resolvePreservedPermissionMode } from './durable-followup.mjs';
import { fixtureSkillContext } from './test-support/skill-context-fixture.mjs';

const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-longrun-${name}-`));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const sseChunk = (res, delta, finish_reason = null, usage = undefined) => {
  res.write('data: ' + JSON.stringify({
    id: 'mock-cmpl',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  }) + '\n\n');
};
const msgText = (msg) => typeof msg?.content === 'string'
  ? msg.content
  : (msg?.content || []).map((part) => part?.text || '').join('');
const userTextOf = (payload) => (payload?.messages || []).filter((m) => m.role === 'user').map(msgText).join('\n');

async function createMockModels(directory, baseUrl, modelId = 'studio-test') {
  const runtime = await ModelRuntime.create({
    authPath: path.join(directory, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('beeftv', {
    api: 'openai-completions',
    apiKey: 'synthetic-key',
    baseUrl: `${baseUrl}/v1`,
    models: [{
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ['text'],
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  const models = createModels();
  models.setProvider(runtime.getProvider('beeftv'));
  return models;
}

// Flow 4: Multi-turn & post-restart onYield durable plan continuation
test('Flow 4: TurnContinuationDoc survives host restart without resetting planContinuations and continues active plans across turns', { timeout: 45000 }, async () => {
  const dir = tempDir('onyield-durable');
  const gate3 = deferred();
  const release3 = deferred();
  let phase = 'before-restart';
  let callIndex = 0;
  const payloads = [];

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    payloads.push({ phase, body });
    callIndex += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (phase === 'before-restart') {
      if (callIndex === 1) {
        sseChunk(res, {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'p-1', type: 'function', function: { name: 'plan_update', arguments: JSON.stringify({ goal: '五镜头短片', items: [{ id: 's1', title: '生成镜头1', status: 'doing' }, { id: 's2', title: '生成镜头2', status: 'todo' }] }) } }],
        });
        sseChunk(res, {}, 'tool_calls');
      } else if (callIndex === 2) {
        sseChunk(res, { role: 'assistant', content: '先汇报进度 1' });
        sseChunk(res, {}, 'stop');
      } else if (callIndex === 3) {
        sseChunk(res, {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'p-2', type: 'function', function: { name: 'plan_update', arguments: JSON.stringify({ items: [{ id: 's1', title: '生成镜头1', status: 'doing', note: '已推进' }, { id: 's2', title: '生成镜头2', status: 'todo' }] }) } }],
        });
        sseChunk(res, {}, 'tool_calls');
      } else if (callIndex === 4) {
        gate3.resolve();
        await release3.promise;
        sseChunk(res, { role: 'assistant', content: 'interrupted' });
        sseChunk(res, {}, 'stop');
      }
    } else if (phase === 'after-restart') {
      sseChunk(res, { role: 'assistant', content: `restarted-reply-${callIndex}` });
      sseChunk(res, {}, 'stop');
    } else {
      sseChunk(res, { role: 'assistant', content: `turn2-reply-${callIndex}` });
      sseChunk(res, {}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const models = await createMockModels(dir, baseUrl);
  const openStore = () => createDurableSessionStore({
    sessionRoot: path.join(dir, 'sessions'),
    workspaceRoot: path.join(dir, 'workspace'),
    getModels: () => models,
    getModelRef: () => ({ provider: 'beeftv', modelId: 'studio-test' }),
    buildTools: () => [],
    authorizeTurn: async () => ({ open: true, canvasId: 'c-plan', permissionMode: 'canvas' }),
    maxPlanContinuations: 2,
    settings: { retry: { maxRetries: 0 } },
  });

  let store;
  try {
    store = openStore();
    const entry = await store.createSession('c-plan');
    const sessionId = entry.sessionId;
    await store.submit(entry, { turnId: 'turn-plan-1', requestId: 'req-plan-1', content: '执行五镜头计划' });
    await gate3.promise;
    const beforeCont = await readTurnContinuation(entry, CTX);
    assert.equal(beforeCont.planContinuations, 1);
    assert.equal(beforeCont.toolCalledSinceYield, true);

    await store.disposeAll();
    release3.resolve();

    phase = 'after-restart';
    callIndex = 0;
    store = openStore();
    const restored = await store.ensureSession('c-plan', sessionId);
    const persistedCont = await readTurnContinuation(restored, CTX);
    assert.equal(persistedCont.planContinuations, 1, 'planContinuations must survive host restart instead of resetting to 0');

    const recovered = await store.recover(restored);
    const rec1 = await store.wait(restored, recovered);
    assert.equal(rec1.error, null);
    const afterPayloads = payloads.filter((p) => p.phase === 'after-restart');
    assert.equal(afterPayloads.length, 2, 'must fire exactly 1 remaining continuation (1->2) and respect maxPlanContinuations=2');
    assert.match(userTextOf(afterPayloads[1].body), /计划还没做完/);
    const finalCont = await readTurnContinuation(restored, CTX);
    assert.equal(finalCont.planContinuations, 2);

    // Unrelated plain-text Q&A turn when a stale unfinished plan exists:
    // Because plan_update was NOT touched in Turn 2 (planTouchedInTurn === false), onYield MUST trigger 0 extra continuations!
    phase = 'turn-2';
    callIndex = 0;
    const sub2 = await store.submit(restored, { turnId: 'turn-plan-2', requestId: 'req-plan-2', content: '请问这片子的背景音乐适合什么风格？' });
    const rec2 = await store.wait(restored, sub2);
    assert.equal(rec2.error, null);
    const turn2Payloads = payloads.filter((p) => p.phase === 'turn-2');
    assert.equal(turn2Payloads.length, 1, 'unrelated text-only turn with stale unfinished plan must trigger 0 extra LLM continuations');
  } finally {
    release3.resolve();
    await store?.disposeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Flow 5: Production CompactionTask.beforeCompact creative summarizer
test('Flow 5: CompactionTask.beforeCompact preserves creative anchors, increments UsageDoc, and falls back cleanly on transient error', { timeout: 60000 }, async () => {
  const dir = tempDir('creative-compact');
  const hashA = 'a'.repeat(64);
  const batchesPin = { skillId: 'batches', versionId: 'v1', contentHash: hashA, skillName: '短剧资产分批' };
  let summaryAttempt = 0;
  let failFirstBeforeCompact = false;
  const capturedSummaryBodies = [];

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const systemContent = (body.messages || []).filter((m) => m.role === 'system' || m.role === 'developer').map(msgText).join('\n');
    const isCreativeBeforeCompact = systemContent.includes('上下文压缩助手');
    const isNativeFallbackCompact = !isCreativeBeforeCompact && systemContent.includes('context summarization assistant');

    if (isCreativeBeforeCompact || isNativeFallbackCompact) {
      summaryAttempt += 1;
      capturedSummaryBodies.push({ attempt: summaryAttempt, isCreativeBeforeCompact, body });
      if (failFirstBeforeCompact && isCreativeBeforeCompact) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'transient_compaction_500' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = isCreativeBeforeCompact
        ? '## 画布与分镜计划\n- 分镜 1-3 已确认\n## 已确认资产与素材标识\n- resourceId: res-hero-001\n## 进行中与待确认任务\n- taskId: task-inflight-77'
        : 'Native Pi fallback summary preserving canvas-studio-99 and res-hero-001.';
      sseChunk(res, { role: 'assistant', content: text });
      sseChunk(res, {}, 'stop', { prompt_tokens: 420, completion_tokens: 85, total_tokens: 505 });
      res.end('data: [DONE]\n\n');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseChunk(res, { role: 'assistant', content: '已记录画布分镜、素材 res-hero-001 与在途任务 task-inflight-77。' + '镜头细节描述。'.repeat(80) });
    sseChunk(res, {}, 'stop', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const models = await createMockModels(dir, baseUrl);
  const skillContexts = fixtureSkillContext(dir);

  const closedTurnIds = new Set();
  const readContextTurnIds = [];

  const store = createDurableSessionStore({
    sessionRoot: path.join(dir, 'sessions'),
    workspaceRoot: path.join(dir, 'workspace'),
    getModels: () => models,
    getModelRef: () => ({ provider: 'beeftv', modelId: 'studio-test' }),
    buildTools: () => [],
    authorizeTurn: async ({ turnId }) => {
      if (closedTurnIds.has(turnId)) throw Object.assign(new Error('turn_not_open'), { reason: 'turn_not_open' });
      return { open: true, canvasId: 'canvas-studio-99', permissionMode: 'canvas' };
    },
    settings: {
      retry: { maxRetries: 0 },
      compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 2048, backgroundTokens: 0 },
    },
    skills: {
      ...skillContexts,
      readContext: async (entry, turnId) => {
        readContextTurnIds.push(turnId);
        if (turnId && closedTurnIds.has(turnId)) {
          throw Object.assign(new Error('turn_not_open'), { reason: 'turn_not_open' });
        }
        return skillContexts.readContext(entry);
      },
      readVersion: async (_entry, pin) => ({
        pin,
        name: '短剧资产分批',
        version: '1',
        description: '先出角色再出场景',
        instruction: '先出 4 张角色设定图，再推进分镜。',
        files: [],
        unsupportedCapabilities: [],
      }),
      readCatalog: async () => ({ skills: [], total: 0 }),
    },
  });

  try {
    const entry = await store.createSession('canvas-studio-99');
    for (const [idx, text] of [
      'canvas-studio-99 使用 16:9 赛博朋克风格，参考 resourceId: res-hero-001，任务 task-inflight-77。' + '分镜细节。'.repeat(120),
      '确认角色服装与镜头景别约束。' + '镜头细节。'.repeat(120),
      '准备进入第三镜头合成。' + '对白细节。'.repeat(120),
    ].entries()) {
      const turnId = `compact-turn-${idx + 1}`;
      const sub = await store.submit(entry, {
        turnId,
        requestId: `compact-req-${idx + 1}`,
        content: text,
        userText: text,
        skills: idx === 0 ? [batchesPin] : [],
      });
      assert.equal((await store.wait(entry, sub)).error, null);
      closedTurnIds.add(turnId);
    }

    const usageBefore = await entry.harness.snapshot(UsageDoc, entry.root.id, CTX);
    const totalBefore = usageBefore?.models?.['beeftv/studio-test']?.totalTokens || 0;
    const readCountBeforeCompact = readContextTurnIds.length;

    // 5a: Happy path through production CompactionTask.beforeCompact (idle compaction must pass turnId='' to readContext, not closed compact-turn-3!)
    const res1 = await store.compactSession('canvas-studio-99', { sessionId: entry.sessionId });
    assert.equal(res1.compacted, true);
    assert(readContextTurnIds.slice(readCountBeforeCompact).includes(''), 'idle beforeCompact must query fresh skill context with empty turnId');
    assert.equal(capturedSummaryBodies.length, 1);
    assert.equal(capturedSummaryBodies[0].isCreativeBeforeCompact, true, 'production beforeCompact must handle compaction');
    const promptSent = JSON.stringify(capturedSummaryBodies[0].body.messages);
    assert.match(promptSent, /canvas-studio-99/);
    assert.match(promptSent, /res-hero-001/);
    assert.match(promptSent, /task-inflight-77/);
    assert.match(promptSent, /batches/);

    const view1 = await entry.root.context(CTX);
    const compEntry1 = view1.entries.find((e) => e.kind === CompactionEntry.kind);
    assert(compEntry1, 'CompactionEntry must be committed');
    const summaryText1 = msgText(compEntry1.model?.[0]);
    assert.match(summaryText1, /canvas-studio-99/, 'summary must preserve canvasId');
    assert.match(summaryText1, /res-hero-001/, 'summary must preserve resourceId');
    assert.match(summaryText1, /task-inflight-77/, 'summary must preserve in-flight taskId');
    assert.match(summaryText1, /batches/, 'summary must preserve active Skill pointer');

    const usageAfter = await entry.harness.snapshot(UsageDoc, entry.root.id, CTX);
    const totalAfter = usageAfter?.models?.['beeftv/studio-test']?.totalTokens || 0;
    assert(totalAfter >= totalBefore + 505, `UsageDoc must account for beforeCompact tokens (before=${totalBefore}, after=${totalAfter})`);

    // 5b: Transient error in beforeCompact returns undefined -> Pi falls back to native CompactionTask cleanly!
    for (const i of [4, 5]) {
      const sub = await store.submit(entry, {
        turnId: `compact-turn-${i}`,
        requestId: `compact-req-${i}`,
        content: `后续制作镜头 ${i}，` + '更多分镜描述。'.repeat(140),
        userText: `后续制作镜头 ${i}`,
      });
      assert.equal((await store.wait(entry, sub)).error, null);
    }
    failFirstBeforeCompact = true;
    const countBeforeFallback = capturedSummaryBodies.length;
    const res2 = await store.compactSession('canvas-studio-99', { sessionId: entry.sessionId });
    assert.equal(res2.compacted, true, 'transient beforeCompact failure must seamlessly fall back to native CompactionTask');
    const fallbackCalls = capturedSummaryBodies.slice(countBeforeFallback);
    assert.equal(fallbackCalls.length, 2, 'beforeCompact fails once (returning undefined), then native CompactionTask succeeds');
    assert.equal(fallbackCalls[0].isCreativeBeforeCompact, true);
    assert.equal(fallbackCalls[1].isCreativeBeforeCompact, false);
    const view2 = await entry.root.context(CTX);
    const compEntry2 = view2.entries.filter((e) => e.kind === CompactionEntry.kind).at(-1);
    assert.match(msgText(compEntry2?.model?.[0]), /Native Pi fallback summary/);
  } finally {
    await store.disposeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Flow 6: events-route & durable-followup edge contracts
test('Flow 6: events-route falls back to recordEvent on submitFollowUpEvent failure, isolates session_busy turnId, and enforces permissionMode priority', async () => {
  // 1) permissionMode strictness matrix: active wins over explicit default; idle respects explicit valid mode and defaults to canvas without inheriting stale full-access.
  assert.equal(
    resolvePreservedPermissionMode({ busy: true }, { active: { permissionMode: 'full-access' }, lastPermissionMode: 'canvas' }, 'canvas'),
    'full-access',
  );
  assert.equal(
    resolvePreservedPermissionMode({ busy: false, permissionMode: 'full-access' }, { active: null, lastPermissionMode: 'full-access' }, 'canvas'),
    'canvas',
  );
  assert.equal(
    resolvePreservedPermissionMode({ busy: false, permissionMode: 'full-access' }, { active: null, lastPermissionMode: 'full-access', turns: [{ permissionMode: 'full-access' }] }, ''),
    'canvas',
  );
  assert.equal(
    resolvePreservedPermissionMode({ busy: false, permissionMode: 'full-access' }, { active: null, lastPermissionMode: 'full-access' }, 'read-only'),
    'read-only',
  );

  // 2) Distinct followUp turnId when idle attempt opened & finalized wakeTurnId and hit session_busy race.
  const idleTurnId = deterministicWakeTurnId('c-race', 'req-race', '');
  const followUpTurnId = deterministicFollowUpTurnId('c-race', 'req-race', '', idleTurnId);
  assert.notEqual(followUpTurnId, idleTurnId);
  const explicitSameTurnId = deterministicFollowUpTurnId('c-race', 'req-race', 'aabbccdd1122', 'aabbccdd1122');
  assert.notEqual(explicitSameTurnId, 'aabbccdd1122');

  const makeReq = (payload) => {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return {
      async *[Symbol.asyncIterator]() { yield raw; },
    };
  };
  const makeRes = () => {
    const out = { status: 0, body: '' };
    return {
      out,
      writeHead(status) { out.status = status; },
      end(body) { out.body = String(body || ''); },
    };
  };

  // 3) submitFollowUpEvent throws -> falls back cleanly to durable.recordEvent (202, event never lost!).
  let recordedFallback = null;
  let capturedFollowUpArgs = null;
  const res1 = makeRes();
  await handleEventsRoute(makeReq({
    canvasId: 'c-fallback',
    kind: 'task_completed',
    requestId: 'req-fb-1',
    turnId: 'aabbccdd0011',
    message: '后台任务已完成',
  }), res1, {
    durable: {
      ensureCurrentSession: async () => ({ canvasId: 'c-fallback', sessionId: 'durable:11111111-1111-1111-1111-111111111111' }),
      busyState: async () => ({ busy: false }),
      resolvedPermissionMode: async () => 'full-access',
      submit: async () => { throw Object.assign(new Error('session_busy'), { reason: 'session_busy' }); },
      submitFollowUpEvent: async (_entry, payload) => {
        capturedFollowUpArgs = payload;
        throw new Error('storage_locked_transient');
      },
      recordEvent: async (canvasId, evt) => {
        recordedFallback = { canvasId, evt };
        return { accepted: true, recorded: true };
      },
    },
    ops: {
      descriptors: new Map([['x', {}]]),
      opsRequest: async () => ({}),
    },
    currentId: () => 'durable:11111111-1111-1111-1111-111111111111',
    followDurable: () => {},
    getProviderReason: () => '',
    readOnlyMode: false,
    modelApi: 'openai-completions',
    modelId: 'studio-test',
  });
  assert.equal(capturedFollowUpArgs.excludedTurnId, 'aabbccdd0011', 'idle finalized turnId must be passed as excludedTurnId');
  assert.equal(res1.out.status, 202);
  assert.equal(JSON.parse(res1.out.body).recorded, true);
  assert.equal(recordedFallback?.canvasId, 'c-fallback');
  assert.equal(recordedFallback?.evt?.kind, 'task_completed');
});
