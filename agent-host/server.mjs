// BeefTV 内置 pi 会话宿主（正式）：HTTP 适配器。
// SDK 会话所有权在 session-owner.mjs；画布操作桥在 operation-bridge.mjs。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { providerRegistration, providerUnavailableReason,
  turnContextPrefix, modelTurnCompletion,
  unflushedSessionHistory,
  resetTurnAccumulator, turnChange } from './canvas-turn.mjs';
import { budgetError, createTurnBudget, spendModelRequest } from './request-budget.mjs';
import { createDurableRequestBudget } from './durable-request-budget.mjs';
import { createOperationBridge } from './operation-bridge.mjs';
import { TURN_ENTRY_TYPE, createSessionStore } from './session-owner.mjs';

const OPS_URL = (process.env.BEEFTV_OPS_URL || 'http://127.0.0.1:18090/api').replace(/\/+$/, '');
const HOST_TOKEN = process.env.BEEFTV_AGENT_HOST_TOKEN || '';
const DESKTOP_TOKEN = process.env.BEEFTV_AGENT_DESKTOP_TOKEN || '';
const ALLOWED_ORIGIN = process.env.BEEFTV_AGENT_ALLOWED_ORIGIN || '';
const DATA_DIR = process.env.BEEFTV_AGENT_DATA_DIR || '';
const LISTEN_FD = Number(process.env.BEEFTV_AGENT_LISTEN_FD || 0);
const PORT_RAW = String(process.env.BEEFTV_AGENT_PORT || '').trim();
const INSTANCE_NONCE = process.env.BEEFTV_AGENT_INSTANCE_NONCE || '';
const LIFETIME_STDIN = process.env.BEEFTV_AGENT_LIFETIME_STDIN === '1';
if (!LISTEN_FD && !PORT_RAW) {
  console.error('agent-host: 缺少 BEEFTV_AGENT_PORT 或 BEEFTV_AGENT_LISTEN_FD（由产品启动链注入）');
  process.exit(2);
}
const PORT = Number(PORT_RAW || 0);
const MODEL_ID = (process.env.BEEFTV_AGENT_MODEL || '').trim();
const MODEL_API = (process.env.BEEFTV_AGENT_API || 'openai-completions').trim();
const BASE_URL = (process.env.BEEFTV_AGENT_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.BEEFTV_AGENT_API_KEY || '';
const MAX_OUTPUT_TOKENS = Number(process.env.BEEFTV_AGENT_MAX_TOKENS || 4096);
const CONTEXT_WINDOW = Number(process.env.BEEFTV_AGENT_CONTEXT_WINDOW || 200000);
const TURN_TIMEOUT_MS = Number(process.env.BEEFTV_AGENT_TURN_TIMEOUT_MS || 180000);
const MAX_REQUESTS_PER_TURN = Number(process.env.BEEFTV_AGENT_MAX_REQUESTS_PER_TURN || 40);
const MAX_TOOL_STEPS_PER_TURN = Number(process.env.BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN || 40);
const LIFETIME_REQUEST_BUDGET = Number(process.env.BEEFTV_AGENT_TOTAL_REQUEST_BUDGET || 0);
const MAX_BODY_BYTES = 64 * 1024;
const READ_ONLY_MODE = process.env.BEEFTV_AGENT_READ_ONLY === '1';
const PROVIDER_ID = 'beeftv';

for (const [name, value] of Object.entries({ BEEFTV_AGENT_HOST_TOKEN: HOST_TOKEN,
  BEEFTV_AGENT_DATA_DIR: DATA_DIR })) {
  if (!value) { console.error(`agent-host: 缺少 ${name}（由产品启动链注入）`); process.exit(2); }
}
const SESSION_ROOT = path.join(DATA_DIR, 'sessions');
const RUN_ID = crypto.randomUUID();
const AGENT_DIR = path.join(DATA_DIR, 'pi-agent');
const WORKSPACE_ROOT = path.join(DATA_DIR, 'workspace');
fs.mkdirSync(SESSION_ROOT, { recursive: true });
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

let providerReason = '';
let MODEL = null;
let modelRuntime = null;

async function initializeModel() {
  providerReason = providerUnavailableReason({ modelId: MODEL_ID, baseUrl: BASE_URL, apiKey: API_KEY, api: MODEL_API });
  if (providerReason) return;
  try {
    modelRuntime = await ModelRuntime.create({
      authPath: path.join(AGENT_DIR, 'auth.json'), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerProvider(PROVIDER_ID, providerRegistration({
      api: MODEL_API, baseUrl: BASE_URL, modelId: MODEL_ID,
      maxTokens: MAX_OUTPUT_TOKENS, contextWindow: CONTEXT_WINDOW,
    }));
    MODEL = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
    if (!MODEL) { providerReason = 'model_not_configured'; return; }
    providerReason = '';
  } catch (error) {
    providerReason = 'model_not_configured';
    console.error(`agent-host: 模型初始化失败 ${error?.message || error}`);
  }
}

const outbound = [];
const ledgerPath = path.join(DATA_DIR, 'agent-requests.jsonl');
let dispatched = 0;

const lifetimeBudgetPath = path.join(DATA_DIR, 'agent-request-budget.json');
const lifetimeBudget = createDurableRequestBudget({ limit: LIFETIME_REQUEST_BUDGET, file: lifetimeBudgetPath });

const turnBudgetContext = new AsyncLocalStorage();

const BASE_ORIGIN = BASE_URL ? new URL(BASE_URL).origin : '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  let parsed = null;
  try { parsed = new URL(raw); } catch { parsed = null; }
  const isModelCall = !!BASE_ORIGIN && parsed && parsed.origin === BASE_ORIGIN;
  if (isModelCall) {
    const budget = turnBudgetContext.getStore();
    const turn = spendModelRequest(budget);
    if (!turn.allowed) {
      if (budget) budget.failure = turn;
      throw budgetError(turn);
    }
    const lifetime = lifetimeBudget.reserve();
    if (!lifetime.allowed) {
      if (budget) { budget.requests -= 1; budget.failure = lifetime; }
      throw budgetError(lifetime);
    }
    dispatched += 1;
    let bodyModel = null;
    try { bodyModel = JSON.parse(options.body || '{}').model || null; } catch { /* 非 JSON body */ }
    const entry = { at: new Date().toISOString(), dispatchIndex: dispatched, origin: parsed.origin, path: parsed.pathname, model: bodyModel };
    outbound.push(entry);
    fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  }
  return realFetch(input, options);
};

const ops = createOperationBridge({
  opsUrl: OPS_URL,
  hostToken: HOST_TOKEN,
  desktopToken: DESKTOP_TOKEN,
  readOnly: READ_ONLY_MODE,
  turnBudgetContext,
});

const store = createSessionStore({
  sessionRoot: SESSION_ROOT,
  workspaceRoot: WORKSPACE_ROOT,
  agentDir: AGENT_DIR,
  runId: RUN_ID,
  getModelRuntime: () => modelRuntime,
  getModel: () => MODEL,
});

function sendLine(res, payload) { res.write(JSON.stringify(payload) + '\n'); }

function instanceProof() {
  if (!INSTANCE_NONCE) return '';
  return crypto.createHash('sha256').update(INSTANCE_NONCE).digest('hex').slice(0, 16);
}

function timingSafeMatch(got, expected) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function instanceOK(req) {
  if (!INSTANCE_NONCE) return true;
  return timingSafeMatch(req.headers['x-beeftv-instance-nonce'] || '', INSTANCE_NONCE);
}

function authorized(req) {
  if (!instanceOK(req)) return { ok: false, reason: 'instance_mismatch' };
  if (!timingSafeMatch(req.headers['x-beeftv-agent-token'] || '', HOST_TOKEN)) return { ok: false, reason: 'unauthorized' };
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) return { ok: false, reason: 'origin_rejected' };
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return { ok: false, reason: 'host_rejected' };
  return { ok: true };
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const error = new Error('body too large'); error.tooLarge = true; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function respondStoreError(res, error) {
  if (error?.reason === 'session_busy') { respond(res, 409, { code: 409, reason: 'session_busy' }); return true; }
  if (error?.reason === 'session_not_current') { respond(res, 409, { code: 409, reason: 'session_not_current' }); return true; }
  if (error?.reason === 'session_not_found') { respond(res, 404, { code: 404, reason: 'session_not_found' }); return true; }
  if (error?.reason === 'session_pointer_failed') {
    respond(res, 500, { code: 500, reason: 'session_pointer_failed', message: String(error.message || error) });
    return true;
  }
  if (error?.reason === 'session_store_closed') {
    respond(res, 503, { code: 503, reason: 'session_store_closed' });
    return true;
  }
  return false;
}

function anySessionBusy() {
  for (const entry of store.sessions.values()) if (entry.busy) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const auth = authorized(req);
  if (url.pathname !== '/health' && !auth.ok) {
    respond(res, 403, { code: 403, reason: auth.reason });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    if (!instanceOK(req)) { respond(res, 403, { code: 403, reason: 'instance_mismatch' }); return; }
    const persistenceSummary = store.sessions.size === 0 ? 'ok' : [...new Set([...store.sessions.values()].map((entry) => entry.persistence))].join(',');
    const proof = instanceProof();
    respond(res, 200, { ok: !providerReason, reason: providerReason || undefined,
      sessions: store.sessions.size, busy: anySessionBusy(), model: MODEL?.id || MODEL_ID, api: MODEL_API,
      baseUrl: MODEL?.baseUrl || BASE_URL, persistence: persistenceSummary, runId: RUN_ID,
      instance: proof || undefined,
      requests: { dispatched, perTurnRequests: MAX_REQUESTS_PER_TURN, perTurnToolSteps: MAX_TOOL_STEPS_PER_TURN,
        lifetimeBudget: lifetimeBudget.limit, lifetimeUsed: lifetimeBudget.used },
      operations: ops.descriptors.size, readOnly: READ_ONLY_MODE, lastOutbound: outbound.at(-1) || null });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/tools') {
    const canvasId = url.searchParams.get('canvasId') || '';
    const entry = canvasId ? store.sessions.get(canvasId) : null;
    respond(res, 200, { canvasId, activeTools: entry?.session?.getActiveToolNames?.() || [], known: [...ops.descriptors.keys()] });
    return;
  }
  try {
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const list = await store.listCanvasSessions(canvasId);
      const active = store.sessions.get(canvasId)?.sessionId || store.readCurrentSessionId(canvasId) || null;
      if (active && !list.some((item) => item.sessionId === active)) {
        list.unshift({ sessionId: active, title: '', updatedAt: new Date().toISOString(), turnCount: 0 });
      }
      respond(res, 200, { currentSessionId: active, sessions: list });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const entry = await store.replaceSession(canvasId, () => store.createLiveSession({
        canvasId, sessionId: '', buildTools: ops.buildTools,
      }));
      respond(res, 200, { sessionId: entry.sessionId });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions/activate') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const sessionId = String(body.sessionId || '').trim();
      if (!canvasId || !sessionId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const entry = await store.replaceSession(canvasId, () => store.createLiveSession({
        canvasId, sessionId, buildTools: ops.buildTools,
      }));
      respond(res, 200, { sessionId: entry.sessionId });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      const requested = String(url.searchParams.get('sessionId') || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const cwd = store.canvasWorkspace(canvasId);
      const sessionDir = store.canvasSessionDir(canvasId);
      let sessionId = requested;
      if (!sessionId) {
        sessionId = store.sessions.get(canvasId)?.sessionId || store.readCurrentSessionId(canvasId) || '';
      }
      if (!sessionId) { respond(res, 200, { sessionId: null, turns: [] }); return; }
      const file = SessionManager.findById(cwd, sessionId, sessionDir);
      if (!file) {
        const active = store.sessions.get(canvasId)?.sessionId || store.readCurrentSessionId(canvasId) || '';
        const empty = unflushedSessionHistory(sessionId, active);
        if (empty) { respond(res, 200, empty); return; }
        respond(res, 404, { code: 404, reason: 'session_not_found' }); return;
      }
      respond(res, 200, { sessionId, turns: store.turnEntries(SessionManager.open(file, sessionDir, cwd)) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const entry = store.sessions.get(body.canvasId);
      if (!entry) { respond(res, 404, { code: 404, reason: 'session_not_found' }); return; }
      entry.generation.aborted = true;
      try { await entry.session.abort(); } catch (error) { console.error(`agent-host: abort 失败 ${error.message}`); }
      respond(res, 202, { accepted: true, busy: entry.busy });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const userText = String(body.message || '').trim();
      const turnId = String(body.turnId || '').trim();
      const revisionBefore = Number(body.revisionBefore || 0);
      const requestedSessionId = String(body.sessionId || '').trim();
      let message = userText;
      const selected = Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds.map((v) => String(v)) : [];
      const references = Array.isArray(body.references)
        ? body.references.filter((item) => item && typeof item === 'object' && item.id)
          .map((item) => ({ kind: String(item.kind || ''), id: String(item.id) }))
        : [];
      if (selected.length > 0 || references.length > 0) {
        message = `${turnContextPrefix({ canvasId, selectedNodeIds: selected, references })}\n${userText}`;
      }
      if (!canvasId || !message) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      if (providerReason) { respond(res, 503, { code: 503, reason: providerReason }); return; }
      const entry = await store.acquireChatSession(canvasId, ops.buildTools, requestedSessionId);
      const budget = createTurnBudget({ maxRequests: MAX_REQUESTS_PER_TURN, maxToolSteps: MAX_TOOL_STEPS_PER_TURN });
      try {
        resetTurnAccumulator(entry.turn, revisionBefore, turnId);
        entry.manager.appendCustomEntry(`${TURN_ENTRY_TYPE}.started`, {
          turnId, userText, selectedNodeIds: selected, references, createdAt: new Date().toISOString(),
        });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const before = entry.log.length;
        const started = Date.now();
        let firstTokenMs = null;
        const { observer, error: promptError, timedOut } = await store.runOwnedPrompt(entry, message, {
          onEvent: (payload) => {
            if (payload.type === 'text_delta' && firstTokenMs === null) firstTokenMs = Date.now() - started;
            sendLine(res, payload);
          },
          runWithBudget: (fn) => turnBudgetContext.run(budget, fn),
          timeoutMs: TURN_TIMEOUT_MS,
        });
        const completion = modelTurnCompletion(observer.lastAssistantMessage, promptError, budget.failure, {
          cancelled: entry.generation.aborted, timedOut,
        });
        const reply = completion.reply;
        const error = completion.error;
        const errorReason = completion.errorReason;
        const toolCalls = entry.log.slice(before);
        const change = turnChange(entry.turn);
        const proposals = [...entry.turn.proposals];
        const record = { turnId, userText, selectedNodeIds: selected, references, reply, toolCalls, change, proposals,
          error, errorReason, cancelled: entry.generation.aborted, createdAt: new Date().toISOString() };
        try { entry.manager.appendCustomEntry(TURN_ENTRY_TYPE, record); }
        catch (persistError) { console.error(`agent-host: 轮次记录写入失败 ${persistError?.message || persistError}`); }
        sendLine(res, { type: 'turn_end', turnId, reply, toolCalls, change, proposals, error, errorReason,
          cancelled: entry.generation.aborted, persistence: entry.persistence,
          sessionId: entry.sessionId, metrics: { firstTokenMs, totalMs: Date.now() - started,
            requests: budget.requests, toolSteps: budget.toolSteps } });
        res.end();
        return;
      } finally {
        store.releaseChatSession(entry);
      }
    }
    respond(res, 404, { code: 404, reason: 'not_found' });
  } catch (error) {
    if (error?.tooLarge) { respond(res, 413, { code: 413, reason: 'body_too_large' }); return; }
    if (!res.headersSent && respondStoreError(res, error)) return;
    console.error(`agent-host: 请求失败 ${error?.message || error}`);
    if (!res.headersSent) { respond(res, 500, { code: 500, reason: 'internal_error', message: String(error?.message || error) }); }
    else { sendLine(res, { type: 'turn_end', reply: '', toolCalls: [], change: null, proposals: [], error: String(error?.message || error), cancelled: false }); res.end(); }
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const released = await store.disposeAll();
    console.error(`agent-host: 关闭，释放 ${released} 个会话`);
  } catch (error) {
    console.error(`agent-host: 关闭时释放会话失败 ${error?.message || error}`);
  }
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
if (LIFETIME_STDIN) {
  process.stdin.resume();
  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('error', () => { void shutdown(); });
}

await initializeModel();
try {
  const count = await ops.loadDescriptors();
  console.error(`agent-host: 载入 ${count} 个操作（readOnly=${READ_ONLY_MODE}）`);
}
catch (error) { console.error(`agent-host: 能力发现失败（稍后可重试）：${error?.message || error}`); }
function onListen() {
  const bound = server.address();
  const port = bound && typeof bound === 'object' ? bound.port : PORT;
  console.log(`agent-host 已启动 http://127.0.0.1:${port} model=${MODEL?.id || MODEL_ID} api=${MODEL_API} baseUrl=${MODEL?.baseUrl || BASE_URL} ops=${OPS_URL} readOnly=${READ_ONLY_MODE} reason=${providerReason || 'ok'}`);
}
if (LISTEN_FD > 0) server.listen({ fd: LISTEN_FD }, onListen);
else server.listen(PORT, '127.0.0.1', onListen);
