import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { canvasKey } from './session-owner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withHost(run, envExtra = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'beeftv session lifecycle '));
  const hostToken = 'synthetic-lifecycle-host';
  let child;
  let base;
  let log = '';
  let modelCalls = 0;
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
    if (req.url === '/api/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.get', summary: 'Read', readOnly: true, scope: 'canvas', params: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] } }] } }));
      return;
    }
    res.end(JSON.stringify({ code: 0, data: { result: { canvas: { revision: 1 } } } }));
  });
  const model = createServer(async (req, res) => {
    await jsonBody(req);
    modelCalls += 1;
    if (modelCalls === 1) {
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
    child = spawn('node', [path.join(root, 'agent-host/server.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error('host exited: ' + log);
      try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    }, 10000);
    await run({ api, waitFor, directory, child, getLog: () => log, getModelCalls: () => modelCalls });
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

    const chat = api('/chat', { canvasId: 'life-canvas', message: 'Keep this turn busy.', turnId: 'busyturn1', revisionBefore: 1 });
    await waitFor(() => getModelCalls() >= 1, 8000);
    const busyReplace = await api('/sessions', { canvasId: 'life-canvas' });
    expect(busyReplace.status).toBe(409);
    expect(busyReplace.payload.reason).toBe('session_busy');
    await api('/cancel', { canvasId: 'life-canvas' });
    await chat;
  });
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
      api('/chat', { canvasId: 'mix-canvas', message: 'Keep this turn busy.', turnId: 'mixturn1', revisionBefore: 1 }),
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
  });
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
