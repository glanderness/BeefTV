// PR-4 Pi 1.6.0 原生长程运行时行为测试（在真实 Node 24 + SQLite Durable + 真实 server.mjs 上执行）：
// 1. ToolPark + POST /signals 跨重启/关闭会话冷启动唤醒、404 signal_target_not_found、鉴权校验；
// 2. api.memo 幂等等待注册（早唤醒不重复登记）、until 兜底对账不触发 invalid_park、Stop 触发 cancel()；
// 3. tool_parked 实时事件 + 可配置 NDJSON heartbeat + /chat 断连不终止睡眠工具 + /history 恢复 parked 状态；
// 4. 忙碌期 /events 经 whenBusy:"followUp" 入队、保留 full-access 权限不降级、跨 Run Go turnId 交接无 turn_not_open；
// 5. TurnContinuationDoc 跨重启与跨轮保留 planContinuations 并遵守 maxPlanContinuations；
// 6. CompactionTask.beforeCompact 创作态摘要保留 canvasId/分镜/resourceId/技能指针、记账公开 UsageDoc，瞬态错回退官方重试循环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { createOperationBridge } from './operation-bridge.mjs';

const hostDir = path.dirname(fileURLToPath(import.meta.url));
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

async function startHostProcess(env) {
  const child = spawn(process.execPath, [path.join(hostDir, 'server.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server.mjs start timeout: ${stderr}`)), 15000);
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stdout}\n${stderr}`)); });
  });
  return {
    baseUrl,
    child,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

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

async function waitFor(fn, timeoutMs = 10000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// ============================================================================
// Flows 1 & 2: ToolPark + POST /signals cold-start wakeup after host restart,
// wrong-taskId 404, auth guard, tool_parked, periodic heartbeat, /chat disconnect
// does NOT abort parked tool, and /history restores parked state!
// ============================================================================
test('Flows 1 & 2: ToolPark streams tool_parked + heartbeat, survives /chat disconnect and host restart, and wakes via POST /signals', { timeout: 60000 }, async () => {
  const dataDir = tempDir('park-restart');
  const hostToken = 'longrun-host-token';
  const taskId = 'task-park-1';
  let taskSettled = false;
  let submitCalls = 0;
  const taskWaits = [];
  const openTurns = new Map();
  const completedTurns = [];
  let modelCalls = 0;
  const secondModelPrompt = [];

  const descriptors = [
    {
      id: 'canvas.get',
      readOnly: true,
      replay: 'safe',
      assistantModes: ['read-only', 'canvas', 'full-access'],
      scope: 'canvas',
      summary: 'Read canvas',
      params: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] },
    },
    {
      id: 'canvas.generation.submit',
      readOnly: false,
      replay: 'safe',
      assistantModes: ['canvas', 'full-access'],
      scope: 'canvas',
      summary: 'Submit generation proposal',
      params: {
        type: 'object',
        properties: { canvasId: { type: 'string' }, proposalId: { type: 'string' } },
        required: ['canvasId', 'proposalId'],
      },
    },
    {
      id: 'task.wait',
      readOnly: true,
      replay: 'safe',
      assistantModes: ['read-only', 'canvas', 'full-access'],
      scope: 'workspace.read',
      summary: 'Wait for tasks',
      params: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' } } },
    },
  ];

  const mockBackend = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = req.url || '';
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // Mock OpenAI LLM endpoint
    if (url.startsWith('/v1/chat/completions')) {
      modelCalls += 1;
      const body = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (modelCalls === 1) {
        sseChunk(res, {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call-submit-1',
            type: 'function',
            function: { name: 'canvas_generation_submit', arguments: JSON.stringify({ proposalId: 'prop-1' }) },
          }],
        });
        sseChunk(res, {}, 'tool_calls');
      } else {
        secondModelPrompt.push(body);
        sseChunk(res, { role: 'assistant', content: '视频与图片均已生成完成。' });
        sseChunk(res, {}, 'stop');
      }
      res.end('data: [DONE]\n\n');
      return;
    }

    // Mock Go backend /api/*
    if (url === '/api/ops') return json(200, { code: 0, data: { ops: descriptors } });
    if (url === '/api/plugins/packages/enabled' || url === '/api/plugins' || url === '/api/assistant/runtime/mcp-servers') {
      return json(200, { code: 0, data: { packages: [], plugins: [], servers: [] } });
    }
    if (url.startsWith('/api/assistant/runtime/canvases/') && url.includes('/skill-context')) {
      const qs = new URL(url, 'http://127.0.0.1').searchParams;
      return json(200, { code: 0, data: { canvasId: 'canvas-1', sessionId: qs.get('sessionId') || '', revision: 0, scopeId: 'scope-0', activePins: [], lifecycle: 'active' } });
    }
    if (url === '/api/ops/skill.catalog') {
      return json(200, { code: 0, data: { result: { skills: [], total: 0 } } });
    }
    if (url === '/api/assistant/runtime/tool-precheck') {
      return json(200, { code: 0, data: { decision: 'allow' } });
    }
    if (url === '/api/ops/canvas.get') {
      const node = taskSettled
        ? { id: 'n-1', type: 'image', title: 'Shot 1', metadata: { taskId, status: 'success', storageKey: 'resource:res-1', taskOutcome: { phase: 'ready' } } }
        : { id: 'n-1', type: 'image', title: 'Shot 1', metadata: { taskId, status: 'running' } };
      return json(200, { code: 0, data: { result: { canvasId: 'canvas-1', canvas: { id: 'canvas-1', revision: taskSettled ? 2 : 1, nodes: [node], connections: [] } } } });
    }
    if (url === '/api/ops/canvas.generation.submit') {
      submitCalls += 1;
      return json(200, { code: 0, data: { result: { canvasId: 'canvas-1', taskIds: [taskId], nodeIds: ['n-1'], status: 'running' } } });
    }
    if (url === '/api/ops/task.wait') {
      const task = taskSettled
        ? { taskId, id: taskId, type: 'canvas_image', status: 'succeeded', state: 'completed', reason: 'saved', resultState: 'ready', outputs: [{ outputIndex: 0, resourceId: 'res-1' }] }
        : { taskId, id: taskId, type: 'canvas_image', status: 'running', state: 'running', reason: 'running', outputs: [] };
      return json(200, { code: 0, data: { result: { taskIds: [taskId], pending: !taskSettled, completed: taskSettled, failed: false, tasks: [task] } } });
    }
    if (url === '/api/assistant/runtime/task-waits') {
      const body = JSON.parse(raw);
      taskWaits.push(body);
      return json(200, { code: 0, data: { registered: true, durableTaskId: body.durableTaskId, taskIds: body.taskIds } });
    }
    if (url === '/api/assistant/runtime/task-waits/cancel') {
      return json(200, { code: 0, data: { cancelled: true } });
    }
    const turnMatch = url.match(/^\/api\/assistant\/runtime\/turns\/([^/]+)(\/complete|\/bind-session)?$/);
    if (turnMatch) {
      const turnId = turnMatch[1];
      const suffix = turnMatch[2] || '';
      if (suffix === '/bind-session') return json(200, { code: 0, data: { bound: true } });
      if (suffix === '/complete') {
        openTurns.set(turnId, false);
        completedTurns.push(turnId);
        return json(200, { code: 0, data: { turnId, canvasId: 'canvas-1', permissionMode: 'canvas', open: false } });
      }
      const isOpen = openTurns.has(turnId) ? openTurns.get(turnId) : true;
      return json(200, { code: 0, data: { turnId, canvasId: 'canvas-1', permissionMode: 'canvas', open: isOpen } });
    }
    return json(404, { code: 404, reason: 'not_found' });
  });

  await new Promise((resolve) => mockBackend.listen(0, '127.0.0.1', resolve));
  const mockUrl = `http://127.0.0.1:${mockBackend.address().port}`;
  const hostEnv = {
    BEEFTV_AGENT_PORT: '0',
    BEEFTV_AGENT_HOST_TOKEN: hostToken,
    BEEFTV_AGENT_DATA_DIR: dataDir,
    BEEFTV_OPS_URL: `${mockUrl}/api`,
    BEEFTV_AGENT_API_KEY: 'synthetic-key',
    BEEFTV_AGENT_BASE_URL: `${mockUrl}/v1`,
    BEEFTV_AGENT_MODEL: 'studio-test',
    BEEFTV_AGENT_API: 'openai-completions',
    BEEFTV_AGENT_PARKED_HEARTBEAT_MS: '60',
    BEEFTV_AGENT_TASK_RECONCILE_MS: '60000',
  };

  let host1, host2, host3;
  try {
    host1 = await startHostProcess(hostEnv);
    const headers = { 'Content-Type': 'application/json', 'X-Beeftv-Agent-Token': hostToken };

    // Start /chat and abort the HTTP stream after observing tool_parked + >=2 heartbeat frames.
    const chatAbort = new AbortController();
    const chatRes = await fetch(`${host1.baseUrl}/chat`, {
      method: 'POST',
      headers,
      signal: chatAbort.signal,
      body: JSON.stringify({
        canvasId: 'canvas-1',
        turnId: 'turnpark0001',
        requestId: 'req-park-1',
        permissionMode: 'canvas',
        message: '请提交并等待生成完成',
      }),
    });
    assert.equal(chatRes.status, 200, `unexpected /chat status ${chatRes.status}: ${chatRes.status !== 200 ? await chatRes.text() : ''} stderr=${host1.stderr()}`);

    const streamEvents = [];
    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (!line) continue;
          streamEvents.push(JSON.parse(line));
        }
        const parkedCount = streamEvents.filter((e) => e.type === 'tool_parked').length;
        const heartbeatCount = streamEvents.filter((e) => e.type === 'heartbeat').length;
        if (parkedCount >= 1 && heartbeatCount >= 2) {
          chatAbort.abort();
          break;
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') throw err;
    }

    const parkedEvent = streamEvents.find((e) => e.type === 'tool_parked');
    assert(parkedEvent, `stream must emit tool_parked while tool is sleeping; events=${JSON.stringify(streamEvents)} stderr=${host1.stderr()}`);
    assert.deepEqual(parkedEvent.taskIds, [taskId]);
    assert(streamEvents.filter((e) => e.type === 'heartbeat' && e.parked === true).length >= 2, 'stream must emit periodic heartbeat frames while parked');
    assert.equal(taskWaits.length, 1, 'Go /assistant/runtime/task-waits must be registered once');
    assert.equal(submitCalls, 1, 'canvas.generation.submit must run once');

    const sessionId = taskWaits[0].sessionId;
    const durableTaskId = taskWaits[0].durableTaskId;
    assert(Number.isSafeInteger(durableTaskId) && durableTaskId > 0);

    // /chat disconnected — /history must STILL show active.parked === true (not aborted!).
    const hist1Res = await fetch(`${host1.baseUrl}/history?canvasId=canvas-1&sessionId=${encodeURIComponent(sessionId)}`, { headers });
    assert.equal(hist1Res.status, 200);
    const hist1 = await hist1Res.json();
    assert.equal(hist1.active?.parked, true, '/history must restore parked state after /chat disconnect');
    assert(Array.isArray(hist1.active?.parkedTools) && hist1.active.parkedTools.length === 1);
    assert.deepEqual(hist1.active.parkedTools[0].taskIds, [taskId]);

    // Simulate full agent-host process restart: stop Process 1, boot Process 2 on the same dataDir.
    // Send the VALID POST /signals FIRST before ANY other request to genuinely prove cold-start closed-session delivery!
    await host1.stop();
    host1 = null;
    host2 = await startHostProcess(hostEnv);

    taskSettled = true;
    const sigRes = await fetch(`${host2.baseUrl}/signals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        canvasId: 'canvas-1',
        sessionId,
        durableTaskId,
        signal: 'business_task_settled',
        key: taskId,
        value: { taskId, status: 'succeeded', state: 'completed', reason: 'saved' },
      }),
    });
    assert.equal(sigRes.status, 200);
    const sigBody = await sigRes.json();
    assert.equal(sigBody.ok, true);
    assert.equal(sigBody.result, 'delivered');

    // Wait for cold-woken session to complete the turn cleanly without re-submitting generation!
    const finalHistory = await waitFor(async () => {
      const r = await fetch(`${host2.baseUrl}/history?canvasId=canvas-1&sessionId=${encodeURIComponent(sessionId)}`, { headers });
      const data = await r.json();
      return !data.active && data.turns?.length === 1 ? data : null;
    }, 15000);

    assert.equal(submitCalls, 1, 'woken tool must NOT re-submit canvas.generation.submit');
    assert.equal(taskWaits.length, 1, 'api.memo must prevent double registration across restart/wakeup');
    assert.equal(finalHistory.turns[0].reply, '视频与图片均已生成完成。');
    assert.equal(finalHistory.turns[0].error, null);
    assert(completedTurns.includes('turnpark0001'), 'Go completeTurn must be acknowledged after cold signal wakeup');
    assert.equal(secondModelPrompt.length, 1);

    // Cold-start auth & 404 leak check on a fresh Process 3:
    // 1) Missing host token -> 403;
    // 2) Wrong durableTaskId on a cold closed session -> 404 signal_target_not_found,
    //    leaving ZERO stale mounted/busy harness so /health is idle and /history opens cleanly!
    await host2.stop();
    host2 = null;
    host3 = await startHostProcess(hostEnv);

    const unauthRes = await fetch(`${host3.baseUrl}/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId: 'canvas-1', sessionId, durableTaskId, signal: 'business_task_settled', key: taskId, value: {} }),
    });
    assert.equal(unauthRes.status, 403);

    const missingTargetRes = await fetch(`${host3.baseUrl}/signals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ canvasId: 'canvas-1', sessionId, durableTaskId: 999999, signal: 'business_task_settled', key: taskId, value: { status: 'succeeded' } }),
    });
    assert.equal(missingTargetRes.status, 404);
    const missingBody = await missingTargetRes.json();
    assert.equal(missingBody.error, 'signal_target_not_found');

    const health3 = await (await fetch(`${host3.baseUrl}/health`, { headers })).json();
    assert.equal(health3.busy, false, 'failed cold-start 404 signal must not leak a busy mounted session');
    const hist3Res = await fetch(`${host3.baseUrl}/history?canvasId=canvas-1&sessionId=${encodeURIComponent(sessionId)}`, { headers });
    assert.equal(hist3Res.status, 200);
    assert.equal((await hist3Res.json()).turns?.length, 1);
  } finally {
    await host1?.stop();
    await host2?.stop();
    await host3?.stop();
    mockBackend.closeAllConnections();
    await new Promise((resolve) => mockBackend.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Flow 1b: api.memo idempotency on early reopen wakeup, until safety-net
// reconcile without invalid_park, and cancel() cleanup on Stop!
// ============================================================================
test('Flow 1b: gatedCall early wakeup keeps api.memo idempotent, until reconcile avoids invalid_park, and Stop calls cancel()', { timeout: 45000 }, async () => {
  const dir = tempDir('park-memo-cancel');
  let taskState = 'running';
  let submitCount = 0;
  let registerCount = 0;
  const cancelledWaits = [];
  let modelStep = 0;

  const descriptors = [
    {
      id: 'canvas.generation.submit',
      readOnly: false,
      replay: 'safe',
      assistantModes: ['canvas', 'full-access'],
      scope: 'canvas',
      summary: 'Submit generation',
      params: { type: 'object', properties: { canvasId: { type: 'string' }, proposalId: { type: 'string' } }, required: ['canvasId', 'proposalId'] },
    },
    {
      id: 'task.wait',
      readOnly: true,
      replay: 'safe',
      assistantModes: ['read-only', 'canvas', 'full-access'],
      scope: 'workspace.read',
      summary: 'Wait tasks',
      params: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' } } },
    },
  ];

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = req.url || '';
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.startsWith('/v1/chat/completions')) {
      modelStep += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (modelStep === 1 || modelStep === 3 || modelStep === 4 || modelStep === 6) {
        sseChunk(res, {
          role: 'assistant',
          tool_calls: [{ index: 0, id: `c-${modelStep}`, type: 'function', function: { name: 'canvas_generation_submit', arguments: JSON.stringify({ proposalId: `p-${modelStep}` }) } }],
        });
        sseChunk(res, {}, 'tool_calls');
      } else {
        sseChunk(res, { role: 'assistant', content: `done-${modelStep}` });
        sseChunk(res, {}, 'stop');
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    if (url === '/api/ops') return json(200, { code: 0, data: { ops: descriptors } });
    if (url === '/api/ops/canvas.generation.submit') {
      submitCount += 1;
      return json(200, { code: 0, data: { result: { canvasId: 'c1', taskIds: [`t-${submitCount}`], status: 'running' } } });
    }
    if (url === '/api/ops/task.wait') {
      const body = JSON.parse(raw);
      const id = body.params?.taskIds?.[0] || 't-1';
      const settled = taskState === 'succeeded';
      const task = settled
        ? { taskId: id, id, type: 'canvas_image', status: 'succeeded', state: 'completed', reason: 'saved', resultState: 'ready', outputs: [{ outputIndex: 0, resourceId: 'r-ok' }] }
        : { taskId: id, id, type: 'canvas_image', status: 'running', state: 'running', reason: 'running', outputs: [] };
      return json(200, { code: 0, data: { result: { taskIds: [id], pending: !settled, completed: settled, failed: false, tasks: [task] } } });
    }
    if (url === '/api/assistant/runtime/task-waits') {
      registerCount += 1;
      return json(200, { code: 0, data: { registered: true } });
    }
    if (url === '/api/assistant/runtime/task-waits/cancel') {
      cancelledWaits.push(JSON.parse(raw));
      return json(200, { code: 0, data: { cancelled: true } });
    }
    return json(200, { code: 0, data: {} });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const models = await createMockModels(dir, baseUrl);
  const openStore = async () => {
    const bridge = createOperationBridge({
      opsUrl: `${baseUrl}/api`,
      hostToken: 'tok',
      turnBudgetContext: new AsyncLocalStorage(),
      reconcileIntervalMs: 250,
      bindingRetryMs: 50,
    });
    await bridge.loadDescriptors();
    return createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'studio-test' }),
      buildTools: bridge.buildTools,
      authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
      settings: { retry: { maxRetries: 0 } },
    });
  };

  let store;
  try {
    // Part A: Park -> reopen early before until (simulating gatedCall early wakeup) -> until fires while running -> settle on next until.
    store = await openStore();
    const entry1 = await store.createSession('c1');
    const sessionId = entry1.sessionId;
    await store.submit(entry1, { turnId: 'turn-until', requestId: 'req-until', content: 'submit 1' });
    await waitFor(async () => {
      if (registerCount < 1) return false;
      const hist = await store.history('c1', sessionId);
      return hist.active?.parked === true;
    }, 5000);
    // Close and immediately reopen BEFORE until expires: api.memo must NOT register a second time!
    await store.disposeAll();
    store = await openStore();
    const reopened = await store.ensureSession('c1', sessionId);
    const recovered = await store.recover(reopened);
    // Wait longer than reconcileIntervalMs (250ms) -> registered signal wait keeps until=deadline so signal key NEVER expires early!
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(registerCount, 1, 'api.memo must keep wait registration strictly idempotent across reopen');
    assert.equal(submitCount, 1, 'submit must not be re-executed on reopen');
    taskState = 'succeeded';
    const deliv1 = await store.deliverSignal('c1', reopened.sessionId, {
      signal: 'business_task_settled',
      key: 't-1',
      value: { taskId: 't-1', status: 'succeeded', state: 'completed', reason: 'saved' },
    });
    assert.equal(deliv1.ok, true, 'signal key must stay alive past reconcileIntervalMs when registered');
    assert.equal(deliv1.result, 'delivered');
    const record1 = await store.wait(reopened, recovered);
    assert.equal(record1.error, null);
    assert.equal(record1.reply, 'done-2');
    assert(cancelledWaits.length >= 1, 'non-park completion exit must cancel Go wait subscription');

    // Part B: Park a second task, then call store.stop() -> cancel() hook must post /assistant/runtime/task-waits/cancel!
    const cancelsBeforeStop = cancelledWaits.length;
    taskState = 'running';
    const sub2 = await store.submit(reopened, { turnId: 'turn-cancel', requestId: 'req-cancel', content: 'submit 2' });
    const wait2 = store.wait(reopened, sub2);
    wait2.catch(() => {});
    await waitFor(async () => {
      if (registerCount < 2) return false;
      const hist = await store.history('c1', reopened.sessionId);
      return hist.active?.parked === true;
    }, 5000);
    await store.stop(reopened, 'req-cancel');
    const rec2 = await wait2;
    assert.equal(rec2.cancelled, true);
    await waitFor(() => cancelledWaits.length > cancelsBeforeStop, 3000);
    assert.equal(cancelledWaits.at(-1).canvasId, 'c1');
    assert.deepEqual(cancelledWaits.at(-1).taskIds, ['t-2']);

    // Part C: Omitting durableTaskId falls back to harness.inspect() scanning sleeping pi.tool tasks by { signal, key }.
    taskState = 'running';
    const sub3 = await store.submit(reopened, { turnId: 'turn-fallback-sig', requestId: 'req-fallback-sig', content: 'submit 3' });
    const wait3 = store.wait(reopened, sub3);
    wait3.catch(() => {});
    await waitFor(async () => {
      if (registerCount < 3) return false;
      const hist = await store.history('c1', reopened.sessionId);
      return hist.active?.parked === true;
    }, 5000);
    taskState = 'succeeded';
    const fallbackDeliv = await store.deliverSignal('c1', reopened.sessionId, {
      signal: 'business_task_settled',
      key: 't-3',
      value: { taskId: 't-3', status: 'succeeded', state: 'completed', reason: 'saved' },
    });
    assert.equal(fallbackDeliv.ok, true, 'signal lookup without durableTaskId must find sleeping pi.tool via harness.inspect');
    assert.equal(fallbackDeliv.result, 'delivered');
    const rec3 = await wait3;
    assert.equal(rec3.error, null);

    // Part D (Fix 6): /steer (supplement) + canvasContextChanged arriving while parked must NOT discard paid task result!
    taskState = 'running';
    const sub4 = await store.submit(reopened, { turnId: 'turn-steer-park', requestId: 'req-steer-park', content: 'submit 4' });
    const wait4 = store.wait(reopened, sub4);
    wait4.catch(() => {});
    await waitFor(async () => {
      if (registerCount < 4) return false;
      const hist = await store.history('c1', reopened.sessionId);
      return hist.active?.parked === true;
    }, 5000);
    // Inject /steer supplement while parked (advances intentEpoch > modelEpoch) + mark canvasContextChanged.
    await store.supplement(reopened, { requestId: 'steer-while-parked', content: '顺便微调一下色调', input: { message: '顺便微调一下色调' } });
    reopened.turn.canvasContextChanged = true;
    taskState = 'succeeded';
    const deliv4 = await store.deliverSignal('c1', reopened.sessionId, {
      signal: 'business_task_settled',
      key: 't-4',
      value: { taskId: 't-4', status: 'succeeded', state: 'completed', reason: 'saved' },
    });
    assert.equal(deliv4.ok, true);
    const rec4 = await wait4;
    assert.equal(rec4.error, null);
    assert.equal(submitCount, 4, 'resumed parked tool after /steer must not re-submit');
    assert(!rec4.toolCalls.some((c) => c.tool === 'canvas.generation.submit' && c.isError), 'resumed parked tool after /steer must NOT fail with turn_intent_changed');
  } finally {
    await store?.disposeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Flow 3: Busy session receives task_completed via /events -> whenBusy:"followUp"
// preserves full-access (no downgrade to canvas), closes old turnId, and opens
// fresh Go turnId at beforeRequest boundary with zero turn_not_open!
// ============================================================================
test('Flow 3: busy full-access session queues /events via whenBusy:followUp and hands off to a fresh full-access Go turnId', { timeout: 45000 }, async () => {
  const dataDir = tempDir('followup-handoff');
  const hostToken = 'followup-token';
  const turn1Entered = deferred();
  const releaseTurn1 = deferred();
  const turnStates = new Map([['turn00000001', { open: true, permissionMode: 'full-access' }]]);
  const openedTurns = [];
  const authChecks = [];
  const completedTurns = [];
  let modelCall = 0;

  const descriptors = [
    {
      id: 'workspace.write_probe',
      readOnly: false,
      replay: 'safe',
      assistantModes: ['full-access'],
      scope: 'workspace',
      summary: 'Full-access only probe',
      params: { type: 'object', properties: { note: { type: 'string' } } },
    },
  ];

  const mockBackend = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = req.url || '';
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    if (url.startsWith('/v1/chat/completions')) {
      modelCall += 1;
      if (modelCall === 1) {
        turn1Entered.resolve();
        await releaseTurn1.promise;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sseChunk(res, { role: 'assistant', content: '第一轮已完成。' });
        sseChunk(res, {}, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      if (modelCall === 2) {
        // Follow-up run invokes a full-access-only tool to prove permissionMode was preserved!
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sseChunk(res, {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call-fa-1', type: 'function', function: { name: 'workspace_write_probe', arguments: JSON.stringify({ note: 'from-followup' }) } }],
        });
        sseChunk(res, {}, 'tool_calls');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseChunk(res, { role: 'assistant', content: '后台完成事件已处理完毕。' });
      sseChunk(res, {}, 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }

    if (url === '/api/ops') return json(200, { code: 0, data: { ops: descriptors } });
    if (url === '/api/plugins/packages/enabled' || url === '/api/plugins' || url === '/api/assistant/runtime/mcp-servers') {
      return json(200, { code: 0, data: { packages: [], plugins: [], servers: [] } });
    }
    if (url.startsWith('/api/assistant/runtime/canvases/') && url.includes('/skill-context')) {
      const qs = new URL(url, 'http://127.0.0.1').searchParams;
      return json(200, { code: 0, data: { canvasId: 'canvas-fa', sessionId: qs.get('sessionId') || '', revision: 0, scopeId: 'scope-0', activePins: [], lifecycle: 'active' } });
    }
    if (url === '/api/ops/skill.catalog') {
      return json(200, { code: 0, data: { result: { skills: [], total: 0 } } });
    }
    if (url === '/api/assistant/runtime/tool-precheck') {
      return json(200, { code: 0, data: { decision: 'allow' } });
    }
    if (url === '/api/ops/canvas.get') {
      return json(200, { code: 0, data: { result: { canvasId: 'canvas-fa', canvas: { id: 'canvas-fa', revision: 1, nodes: [], connections: [] } } } });
    }
    if (url === '/api/ops/workspace.write_probe') {
      const turnId = req.headers['x-beeftv-agent-turn'];
      const st = turnStates.get(turnId);
      if (!st?.open) return json(409, { code: 409, reason: 'turn_not_open', msg: 'turn closed' });
      if (st.permissionMode !== 'full-access') return json(403, { code: 403, reason: 'scope_denied', msg: 'not full-access' });
      return json(200, { code: 0, data: { result: { ok: true, turnId } } });
    }
    if (url === '/api/assistant/runtime/turns' && req.method === 'POST') {
      const body = JSON.parse(raw);
      openedTurns.push(body);
      turnStates.set(body.turnId, { open: true, permissionMode: body.permissionMode });
      return json(200, { code: 0, data: { turnId: body.turnId, canvasId: body.canvasId, permissionMode: body.permissionMode, open: true } });
    }
    const turnMatch = url.match(/^\/api\/assistant\/runtime\/turns\/([^/]+)(\/complete|\/bind-session)?$/);
    if (turnMatch) {
      const turnId = turnMatch[1];
      const suffix = turnMatch[2] || '';
      const st = turnStates.get(turnId);
      if (!st) return json(404, { code: 404, reason: 'turn_not_found' });
      if (suffix === '/bind-session') return json(200, { code: 0, data: { bound: true } });
      if (suffix === '/complete') {
        st.open = false;
        completedTurns.push(turnId);
        return json(200, { code: 0, data: { turnId, canvasId: 'canvas-fa', permissionMode: st.permissionMode, open: false } });
      }
      authChecks.push({ turnId, open: st.open, permissionMode: st.permissionMode });
      if (!st.open) return json(409, { code: 409, reason: 'turn_not_open', msg: 'turn closed' });
      return json(200, { code: 0, data: { turnId, canvasId: 'canvas-fa', permissionMode: st.permissionMode, open: true } });
    }
    return json(404, { code: 404, reason: 'not_found' });
  });

  await new Promise((resolve) => mockBackend.listen(0, '127.0.0.1', resolve));
  const mockUrl = `http://127.0.0.1:${mockBackend.address().port}`;
  let host;
  try {
    host = await startHostProcess({
      BEEFTV_AGENT_PORT: '0',
      BEEFTV_AGENT_HOST_TOKEN: hostToken,
      BEEFTV_AGENT_DATA_DIR: dataDir,
      BEEFTV_OPS_URL: `${mockUrl}/api`,
      BEEFTV_AGENT_API_KEY: 'synthetic-key',
      BEEFTV_AGENT_BASE_URL: `${mockUrl}/v1`,
      BEEFTV_AGENT_MODEL: 'studio-test',
      BEEFTV_AGENT_API: 'openai-completions',
    });
    const headers = { 'Content-Type': 'application/json', 'X-Beeftv-Agent-Token': hostToken };

    // Start Run 1 in full-access mode.
    const chatPromise = fetch(`${host.baseUrl}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        canvasId: 'canvas-fa',
        turnId: 'turn00000001',
        requestId: 'req-fa-1',
        permissionMode: 'full-access',
        message: '开始长任务',
      }),
    }).then((r) => r.text());

    await turn1Entered.promise;

    // While Run 1 is busy in full-access, deliver task_completed WITH explicit default permissionMode:'canvas'.
    // Active doc.active.permissionMode ('full-access') MUST win unconditionally (no downgrade!).
    const evtRes = await fetch(`${host.baseUrl}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        canvasId: 'canvas-fa',
        kind: 'task_completed',
        requestId: 'evt-bg-1',
        permissionMode: 'canvas',
        message: '后台生图任务 task-bg-1 已完成，请立刻继续。',
      }),
    });
    assert.equal(evtRes.status, 202);
    const evtBody = await evtRes.json();
    assert.equal(evtBody.queued, true, 'busy /events must queue followUp instead of passive recordEvent');
    assert.equal(evtBody.mode, 'followUp');
    assert.equal(evtBody.permissionMode, 'full-access', 'busy followUp must preserve active full-access even when payload carries default canvas');

    // Release Run 1 and wait for BOTH Run 1 and follow-up Run 2 to settle!
    releaseTurn1.resolve();
    await chatPromise;

    const history = await waitFor(async () => {
      const r = await fetch(`${host.baseUrl}/history?canvasId=canvas-fa`, { headers });
      const data = await r.json();
      return !data.active && data.turns?.length === 2 ? data : null;
    }, 15000);

    assert.equal(openedTurns.length, 1, 'followUp Run 2 must open a fresh Go turnId at beforeRequest boundary');
    assert.equal(openedTurns[0].permissionMode, 'full-access', 'fresh Go turnId must preserve full-access');
    assert.notEqual(openedTurns[0].turnId, 'turn00000001');
    assert(completedTurns.includes('turn00000001'), 'old turnId must be closed cleanly');
    assert(completedTurns.includes(openedTurns[0].turnId), 'fresh followUp turnId must also be closed cleanly');
    assert(authChecks.every((c) => c.open === true), 'no authorization check may hit a closed turn (no turn_not_open)');
    assert.equal(history.turns[0].reply, '第一轮已完成。');
    assert.equal(history.turns[1].reply, '后台完成事件已处理完毕。');
    assert.equal(history.turns[1].error, null);
    assert(history.turns[1].toolCalls.some((c) => c.tool === 'workspace.write_probe' && !c.isError), 'full-access tool succeeded in follow-up turn');

    // Idle session immediately after full-access turns receiving /events with NO permissionMode
    // MUST default safely to 'canvas' (NEVER inherit stale 'full-access' from previous settled turns!).
    const idleNoModeRes = await fetch(`${host.baseUrl}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        canvasId: 'canvas-fa',
        kind: 'skill_script_completed',
        requestId: 'evt-idle-no-mode',
        message: '空闲期未携带 permissionMode 的脚本完成事件。',
      }),
    });
    assert.equal(idleNoModeRes.status, 202);
    const idleNoModeBody = await idleNoModeRes.json();
    assert.equal(idleNoModeBody.permissionMode, 'canvas', 'idle /events without permissionMode must default safely to canvas, not stale full-access');
    await waitFor(async () => {
      const r = await fetch(`${host.baseUrl}/history?canvasId=canvas-fa`, { headers });
      const data = await r.json();
      return !data.active && data.turns?.length === 3 ? data : null;
    }, 15000);
    assert.equal(openedTurns[1].permissionMode, 'canvas', 'Go turn opened for idle /events without permissionMode must be canvas');

    // Idle session receiving an explicit valid permissionMode ('read-only') MUST honor it.
    const idleExplicitRes = await fetch(`${host.baseUrl}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        canvasId: 'canvas-fa',
        kind: 'task_completed',
        requestId: 'evt-idle-readonly',
        permissionMode: 'read-only',
        message: '空闲期显式指定 read-only 权限的事件。',
      }),
    });
    assert.equal(idleExplicitRes.status, 202);
    const idleExplicitBody = await idleExplicitRes.json();
    assert.equal(idleExplicitBody.permissionMode, 'read-only', 'idle /events with explicit permissionMode must honor explicit mode');
    await waitFor(async () => {
      const r = await fetch(`${host.baseUrl}/history?canvasId=canvas-fa`, { headers });
      const data = await r.json();
      return !data.active && data.turns?.length === 4 ? data : null;
    }, 15000);
    assert.equal(openedTurns[2].permissionMode, 'read-only');
  } finally {
    releaseTurn1.resolve();
    await host?.stop();
    mockBackend.closeAllConnections();
    await new Promise((resolve) => mockBackend.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
