import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { canvasKey } from './session-owner.mjs';
import { serveEmptySkillContext } from './test-support/skill-context-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withHost(run, envExtra = {}, options = {}) {
  const { slowFirstModel = true } = options;
  const directory = mkdtempSync(path.join(tmpdir(), 'beeftv session lifecycle '));
  const hostToken = 'synthetic-lifecycle-host';
  let child;
  let base;
  let log = '';
  let modelCalls = 0;
  const modelPayloads = [];
  const listen = (server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const jsonBody = async (req) => {
    let text = '';
    for await (const part of req) text += part;
    return JSON.parse(text || '{}');
  };
  const api = async (route, body) => {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': hostToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, payload, text };
  };
  const ops = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-beeftv-agent-token'] !== hostToken) { res.writeHead(403).end('{}'); return; }
    if(serveEmptySkillContext(req,res))return;
    if (req.url === '/api/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.get', summary: 'Read', readOnly: true, scope: 'canvas', params: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] } }] } }));
      return;
    }
    // Go 回合记录：宿主在开始/恢复前读取它，并按 canvasId 校验归属。
    if (req.url.startsWith('/api/assistant/runtime/turns/')) {
      const turnId = decodeURIComponent(req.url.split('/')[5] || '');
      res.end(JSON.stringify({ code: 0, data: { turnId, canvasId: options.canvasId || 'canvas', permissionMode: 'canvas', open: true } }));
      return;
    }
    res.end(JSON.stringify({ code: 0, data: { result: { canvas: { revision: 1 } } } }));
  });
  const model = createServer(async (req, res) => {
    modelPayloads.push(await jsonBody(req));
    modelCalls += 1;
    if (options.failFirstModel && modelCalls === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic provider rejection', type: 'invalid_request_error' } }));
      return;
    }
    if (slowFirstModel && modelCalls === 1) {
      await delay(8000);
      if (res.writableEnded) return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const waitFor = async (check, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return;
      await delay(50);
    }
    throw new Error('fixture condition timed out: ' + log.slice(-1500));
  };
  try {
    const opsPort = await listen(ops);
    const modelPort = await listen(model);
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      BEEFTV_AGENT_DATA_DIR: directory,
      BEEFTV_AGENT_HOST_TOKEN: hostToken,
      BEEFTV_AGENT_PORT: String(port),
      BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`,
      BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_MODEL: 'synthetic',
      BEEFTV_AGENT_API_KEY: 'synthetic-only',
      BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      BEEFTV_AGENT_TURN_TIMEOUT_MS: '20000',
      ...envExtra,
    };
    const start = async () => {
      child = spawn('node', [path.join(root, 'agent-host/server.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => { log += chunk; });
      child.stderr.on('data', (chunk) => { log += chunk; });
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error('host exited: ' + log);
        try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; }
        catch { return false; }
      }, 20000);
    };
    const restart = async (modelId) => {
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await exited;
      if (modelId) env.BEEFTV_AGENT_MODEL = modelId;
      await start();
    };
    await start();
    await run({ api, waitFor, directory, child, restart, base, hostToken, getLog: () => log, getModelCalls: () => modelCalls, getModelPayloads: () => modelPayloads });
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    for (const server of [ops, model]) {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('真实宿主：空新会话跨进程重启和模型切换仍可激活，零模型请求', async () => {
  await withHost(async ({ api, restart, getModelCalls }) => {
    const old = await api('/sessions', { canvasId: 'empty-restart' });
    const fresh = await api('/sessions', { canvasId: 'empty-restart' });
    expect(fresh.status).toBe(200);
    expect(fresh.payload.sessionId).not.toBe(old.payload.sessionId);
    const sessionId = fresh.payload.sessionId;
    for (const modelId of [undefined, 'synthetic-after-switch']) {
      await restart(modelId);
      const activated = await api('/sessions/activate', { canvasId: 'empty-restart', sessionId });
      expect(activated.status).toBe(200);
      expect(activated.payload.sessionId).toBe(sessionId);
      const history = await api('/history?canvasId=empty-restart');
      expect(history.payload).toEqual({ sessionId, turns: [], active: null });
      const listed = await api('/sessions?canvasId=empty-restart');
      expect(listed.payload.currentSessionId).toBe(sessionId);
      expect((await api('/health')).payload.model).toBe(modelId || 'synthetic');
    }
    expect(getModelCalls()).toBe(0);
  });
}, 35000);

test('真实宿主：新建会话替换会释放上一条，忙碌时拒绝替换', async () => {
  await withHost(async ({ api, waitFor, getModelCalls }) => {
    const created = await api('/sessions', { canvasId: 'life-canvas' });
    expect(created.status).toBe(200);
    const firstId = created.payload.sessionId;
    expect(firstId).toBeTruthy();

    const replaced = await api('/sessions', { canvasId: 'life-canvas' });
    expect(replaced.status).toBe(200);
    expect(replaced.payload.sessionId).not.toBe(firstId);
    const listed = await api('/sessions?canvasId=life-canvas');
    expect(listed.payload.currentSessionId).toBe(replaced.payload.sessionId);

    const chat = api('/chat', { canvasId: 'life-canvas', message: 'Keep this turn busy.', turnId: 'busyturn1', revisionBefore: 1, sessionId: replaced.payload.sessionId });
    await waitFor(() => getModelCalls() >= 1, 8000);
    const busyReplace = await api('/sessions', { canvasId: 'life-canvas' });
    expect(busyReplace.status).toBe(409);
    expect(busyReplace.payload.reason).toBe('session_busy');
    await api('/cancel', { canvasId: 'life-canvas' });
    await chat;
  }, {}, { canvasId: 'life-canvas' });
}, 35000);

test('真实宿主：并发新建会话最终只有一条当前会话', async () => {
  await withHost(async ({ api }) => {
    const [a, b] = await Promise.all([
      api('/sessions', { canvasId: 'parallel-canvas' }),
      api('/sessions', { canvasId: 'parallel-canvas' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.payload.sessionId).not.toBe(b.payload.sessionId);
    const listed = await api('/sessions?canvasId=parallel-canvas');
    expect(listed.status).toBe(200);
    expect([a.payload.sessionId, b.payload.sessionId]).toContain(listed.payload.currentSessionId);
    const health = await api('/health');
    expect(health.status).toBe(200);
    expect(health.payload.sessions).toBe(1);
  });
}, 35000);

test('真实宿主：指针写成目录后替换失败，当前会话仍是旧的', async () => {
  await withHost(async ({ api, directory }) => {
    const created = await api('/sessions', { canvasId: 'pointer-canvas' });
    expect(created.status).toBe(200);
    const firstId = created.payload.sessionId;
    const pointer = path.join(directory, 'sessions', canvasKey('pointer-canvas'), 'current.json');
    rmSync(pointer, { force: true });
    mkdirSync(pointer);
    const replaced = await api('/sessions', { canvasId: 'pointer-canvas' });
    expect(replaced.status).toBe(500);
    expect(replaced.payload.reason).toBe('session_pointer_failed');
    const listed = await api('/sessions?canvasId=pointer-canvas');
    expect(listed.status).toBe(200);
    expect(listed.payload.currentSessionId).toBe(firstId);
  });
}, 35000);

test('真实宿主：chat 与 replace 并发时不是 500，忙碌则拒绝替换', async () => {
  await withHost(async ({ api }) => {
    const created = await api('/sessions', { canvasId: 'mix-canvas' });
    expect(created.status).toBe(200);
    const [chat, replaced] = await Promise.all([
      api('/chat', { canvasId: 'mix-canvas', message: 'Keep this turn busy.', turnId: 'mixturn1', revisionBefore: 1, sessionId: created.payload.sessionId }),
      api('/sessions', { canvasId: 'mix-canvas' }),
    ]);
    expect(chat.status).toBe(200);
    expect([200, 409]).toContain(replaced.status);
    if (replaced.status === 409) expect(replaced.payload.reason).toBe('session_busy');
    const listed = await api('/sessions?canvasId=mix-canvas');
    expect(listed.status).toBe(200);
    expect(listed.payload.currentSessionId).toBeTruthy();
    const health = await api('/health');
    expect(health.status).toBe(200);
    expect(health.payload.sessions).toBe(1);
  }, {}, { canvasId: 'mix-canvas' });
}, 35000);

test('真实宿主：SIGTERM 释放活动会话后退出', async () => {
  await withHost(async ({ api, child, getLog }) => {
    const created = await api('/sessions', { canvasId: 'shutdown-canvas' });
    expect(created.status).toBe(200);
    const exited = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, delay(3000).then(() => 'timeout')]);
    expect(code).not.toBe('timeout');
    expect(getLog()).toContain('关闭，释放');
  });
}, 35000);

for (const failFirstModel of [false, true]) test(`真实宿主：旧 JSONL 交接首轮${failFirstModel ? '失败' : '成功'}后重启仍复用会话和上下文`, async () => {
  await withHost(async ({ api, directory, getModelPayloads, restart }) => {
    const canvasId = 'legacy-handoff';
    const canvasDir = path.join(directory, 'sessions', canvasKey(canvasId));
    mkdirSync(canvasDir, { recursive: true });
    const sessionId = 'legacy-pi-session';
    const timestamp = '2026-10-07T12:00:00.000Z';
    const rows = [
      { type: 'session', version: 3, id: sessionId, timestamp, cwd: path.join(directory, 'workspace', canvasKey(canvasId)) },
      { type: 'message', id: 'user-old', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: '旧会话里的原始需求' }], timestamp: 1791374400000 } },
      { type: 'message', id: 'assistant-old', parentId: 'user-old', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '旧会话里的历史回执' }], timestamp: 1791374401000 } },
      { type: 'custom', id: 'turn-old', parentId: 'assistant-old', timestamp, customType: 'beeftv.canvas.turn',
        data: { turnId: 'legacy-turn', userText: '旧会话里的原始需求', reply: '旧会话里的历史回执', toolCalls: [], proposals: [], error: null, cancelled: false, createdAt: timestamp } },
    ];
    writeFileSync(path.join(canvasDir, `2026-10-07T12-00-00-000Z_${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(path.join(canvasDir, 'current.json'), JSON.stringify({ sessionId }));

    // 旧会话历史仍可读。
    const history = await api(`/history?canvasId=${canvasId}`);
    expect(history.status).toBe(200);
    expect(history.payload.sessionId).toBe(sessionId);
    expect(history.payload.turns).toHaveLength(1);
    expect(history.payload.turns[0].userText).toBe('旧会话里的原始需求');

    // 在旧会话里发消息：新建 Durable 会话，模型请求带上交接说明。
    const chat = await api('/chat', { canvasId, message: '继续改一下', turnId: 'handoff-turn-1', revisionBefore: 1, sessionId });
    expect(chat.status).toBe(200);
    const end = chat.text.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.type === 'turn_end');
    expect(end.sessionId).toMatch(/^durable:/);
    expect(end.sessionId).not.toBe(sessionId);
    expect(Boolean(end.error)).toBe(failFirstModel);
    expect(JSON.parse(chat.text.trim().split('\n')[0])).toMatchObject({ type: 'session', sessionId: end.sessionId });
    const payload = JSON.stringify(getModelPayloads().at(-1));
    expect(payload).toContain('旧会话里的原始需求');
    expect(payload).toContain('旧会话里的历史回执');

    // 客户端可能没收到终态；宿主重启后，仍拿旧 ID 重试不能再次创建会话。
    await restart();
    const next = await api('/chat', { canvasId, message: '再改一处', turnId: 'handoff-turn-2', revisionBefore: 1, sessionId });
    expect(next.status).toBe(200);
    const nextEnd = next.text.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.type === 'turn_end');
    expect(nextEnd.sessionId).toBe(end.sessionId);
    expect(nextEnd.reply).toBe('ok');
    expect(JSON.stringify(getModelPayloads().at(-1))).toContain('继续改一下');

    const listed = await api(`/sessions?canvasId=${canvasId}`);
    expect(listed.payload.currentSessionId).toBe(end.sessionId);
    const ids = listed.payload.sessions.map((item) => item.sessionId);
    expect(ids).toContain(sessionId);
    expect(ids).toContain(end.sessionId);
    expect(ids.filter((id) => id.startsWith('durable:'))).toHaveLength(1);
  }, {}, { canvasId: 'legacy-handoff', slowFirstModel: false, failFirstModel });
}, 35000);

test('真实宿主：旧会话交接首轮断线，重启后重发原请求复用会话和回执', async () => {
  await withHost(async ({ api, directory, restart, base, hostToken, waitFor, getModelCalls }) => {
    const canvasId = 'canvas';
    const sessionId = 'legacy-disconnected';
    const canvasDir = path.join(directory, 'sessions', canvasKey(canvasId));
    mkdirSync(canvasDir, { recursive: true });
    const row = { type: 'session', version: 3, id: sessionId, timestamp: '2026-10-07T12:00:00.000Z', cwd: path.join(directory, 'workspace', canvasKey(canvasId)) };
    writeFileSync(path.join(canvasDir, `2026-10-07T12-00-00-000Z_${sessionId}.jsonl`), JSON.stringify(row) + '\n');
    const body = { canvasId, sessionId, turnId: 'lost-response', requestId: 'lost-response', message: '保留这条消息' };
    const controller = new AbortController();
    const response = await fetch(base + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beeftv-Agent-Token': hostToken }, body: JSON.stringify(body), signal: controller.signal });
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const successor = JSON.parse(first.trim().split('\n')[0]).sessionId;
    expect(successor).toMatch(/^durable:/);
    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(async () => (await api(`/history?canvasId=${canvasId}&sessionId=${successor}`)).payload.turns?.length === 1, 15000);
    await restart();
    const retry = await api('/chat', body);
    const end = retry.text.trim().split('\n').map(JSON.parse).find(event => event.type === 'turn_end');
    expect(end.sessionId).toBe(successor);
    expect(getModelCalls()).toBe(1);
    const listed = await api(`/sessions?canvasId=${canvasId}`);
    expect(listed.payload.sessions.filter(item => item.sessionId.startsWith('durable:'))).toHaveLength(1);
    const fresh = await api('/sessions', { canvasId });
    expect(fresh.payload.sessionId).not.toBe(successor);
    await api('/sessions/activate', { canvasId, sessionId });
    const again = await api('/chat', { ...body, turnId: 'next-turn', requestId: 'next-turn', message: '继续同一接续会话' });
    expect(again.text).toContain(successor);
    expect(getModelCalls()).toBe(2);
  });
}, 35000);
