// BeefTV 内置 pi 会话宿主（正式）：HTTP 适配器。
// SDK 会话所有权在 session-owner.mjs；画布操作桥在 operation-bridge.mjs。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore, isDurableSessionId } from './durable-session-owner.mjs';
import { createDurableTurnBudget } from './durable-turn-budget.mjs';
import { createDurableSkillExtension } from './skill-resource.mjs';
import { providerRegistration, providerUnavailableReason,
  turnContextPrefix, modelTurnCompletion,
  unflushedSessionHistory,
  resetTurnAccumulator, turnChange } from './canvas-turn.mjs';
import { budgetError, createTurnBudget, spendModelRequest } from './request-budget.mjs';
import { createDurableRequestBudget } from './durable-request-budget.mjs';
import { createOperationBridge } from './operation-bridge.mjs';
import { TURN_ENTRY_TYPE, createSessionStore } from './session-owner.mjs';
import { adaptMediaRequest, trustedMediaSources } from './media-content.mjs';
import { createNativePartStore } from './native-part-store.mjs';

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
const NEW_SESSION_RUNTIME = process.env.BEEFTV_AGENT_NEW_SESSION_RUNTIME || 'durable';
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
const nativePartStore = createNativePartStore({directory:path.join(DATA_DIR,'native-parts')});

const BASE_ORIGIN = BASE_URL ? new URL(BASE_URL).origin : '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  let parsed = null;
  try { parsed = new URL(raw); } catch { parsed = null; }
  const isModelCall = !!BASE_ORIGIN && parsed && parsed.origin === BASE_ORIGIN;
  if (isModelCall) {
    // Transform at the real dispatch boundary; extension errors are caught by pi.
    const budget = turnBudgetContext.getStore();
    if (options.body) {
      const payload = JSON.parse(options.body);
      const mediaOptions = {api:MODEL_API,modelId:MODEL_ID,nativePartStore};
      for (const source of trustedMediaSources(payload,mediaOptions)) {
        if (!budget?.turnId || !budget.canvasId) throw new Error('media_authorization_missing');
        const overview = await ops.opsRequest('POST','/ops/media.overview',{params:{canvasId:source.canvasId,
          ...(source.nodeId ? {nodeId:source.nodeId}:{assetId:source.assetId}),resourceId:source.resourceId}},undefined,budget.turnId);
        if (overview.result.source.version !== source.version) throw new Error('media_content_changed');
      }
      options = {...options,body:JSON.stringify(adaptMediaRequest(payload,mediaOptions))};
    }
    if (budget?.generation?.aborted || options.signal?.aborted) {
      throw Object.assign(new Error('aborted'),{name:'AbortError'});
    }
    if (budget?.generation && !budget.generation.durable) budget.generation.modelEpoch = budget.generation.intentEpoch;
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
  mediaModel: { api: MODEL_API, modelId: MODEL_ID },
  nativePartStore,
});

const store = createSessionStore({
  sessionRoot: SESSION_ROOT,
  workspaceRoot: WORKSPACE_ROOT,
  agentDir: AGENT_DIR,
  runId: RUN_ID,
  getModelRuntime: () => modelRuntime,
  getModel: () => MODEL,
});

const durable = createDurableSessionStore({
  sessionRoot: SESSION_ROOT, workspaceRoot: WORKSPACE_ROOT, buildTools: ops.buildTools,
  getModels: entry => {
    const models = createModels(); const provider = modelRuntime.getProvider(PROVIDER_ID);
    const budgeted = fn => (...args) => {
      if (!entry.budget) entry.budget = createDurableTurnBudget(entry,{maxRequests:MAX_REQUESTS_PER_TURN,maxToolSteps:MAX_TOOL_STEPS_PER_TURN});
      entry.budget.generation = entry.generation;
      entry.budget.turnId = entry.turn.turnId; entry.budget.canvasId = entry.canvasId;
      return turnBudgetContext.run(entry.budget,()=>fn.call(provider,...args));
    };
    models.setProvider({...provider,stream:budgeted(provider.stream),streamSimple:budgeted(provider.streamSimple)});
    return models;
  },
  getModelRef: () => ({ provider: PROVIDER_ID, modelId: MODEL_ID }),
  extensions: entry => [createDurableSkillExtension({getPins:()=>entry.skillPins || [],
    readVersion:async (pin,signal) => (await ops.opsRequest('POST','/ops/skill.get',{params:pin},signal,entry.turn.turnId)).result,
  })],
  authorizeTurn: async ({canvasId, turnId}) => {
    const state = await ops.opsRequest('GET', `/assistant/runtime/turns/${encodeURIComponent(turnId)}`);
    if (state.canvasId !== canvasId) throw Object.assign(new Error('turn_not_open'), {reason:'turn_not_open', details:state});
    return state;
  },
  completeTurn: ({turnId}) => ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`, {}),
  runWithBudget: (entry, fn) => {
    if (!entry.budget) entry.budget = createDurableTurnBudget(entry,{maxRequests:MAX_REQUESTS_PER_TURN,maxToolSteps:MAX_TOOL_STEPS_PER_TURN});
    entry.budget.generation = entry.generation;
    entry.budget.turnId = entry.turn.turnId; entry.budget.canvasId = entry.canvasId;
    return turnBudgetContext.run(entry.budget, fn);
  },
});

function currentId(canvasId) {
  try { return store.readCurrentSessionId(canvasId) || ''; }
  catch (error) {
    // Failed pointer publication must not erase a previously owned live chat.
    const entry = durable.sessions.get(canvasId) || store.sessions.get(canvasId);
    if (entry) return entry.sessionId;
    throw error;
  }
}
function liveEntry(canvasId) {
  const id = currentId(canvasId);
  return isDurableSessionId(id) ? durable.sessions.get(canvasId) : store.sessions.get(canvasId);
}
function emitDurable(entry, event) {
  const mapped = [];
  if (event.type === 'message_update') {
    for (const change of event.changes || []) if (change.type === 'text_delta') mapped.push({type:'text_delta',delta:change.delta});
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') mapped.push({
    type:'lifecycle', phase:event.type === 'tool_execution_start' ? 'tool' : 'tool_end',toolName:event.toolName,
  });
  for (const payload of mapped) for (const listener of entry.listeners || []) listener(payload);
}
function followDurable(entry, submission) {
  if (!entry.running) {
    entry.listeners = new Set();
    entry.running = durable.wait(entry, submission, {onEvent:event=>emitDurable(entry,event)})
      .finally(()=>{entry.running=null;});
    // Observers may disconnect; the official task and its completion persist.
    entry.running.catch(error=>console.error(`agent-host: durable wait ${error.reason || error.message}`));
  }
  return entry.running;
}

async function attachmentContent(body, turnId) {
  const content = [{type:'text',text:body.message || '请分析所提供的素材，并说明适合如何使用。'}];
  for (const attachment of body.attachments || []) {
    content.push({type:'text',text:`用户提供素材：${JSON.stringify(attachment)}。使用 media.inspect 读取实际画面或音频后再判断；片段秒数转换为 startMs/endMs。`});
    if (attachment.kind === 'image') {
      const reference = {canvasId:body.canvasId,
        ...(attachment.nodeId ? {nodeId:attachment.nodeId}:{assetId:attachment.assetId}),resourceId:attachment.resourceId};
      const overview = await ops.opsRequest('POST','/ops/media.overview',{params:reference},undefined,turnId);
      const data = await ops.opsRequest('POST','/ops/media.inspect',{params:{...reference,
        expectedVersion:overview.result.source.version,mode:'frames'}},undefined,turnId);
      content.push(...data.result.content.filter(part=>part.type==='image').map(part=>({type:'image',data:part.data,mimeType:part.mimeType})));
    }
  }
  return content;
}

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
  for (const entry of durable.sessions.values()) if (entry.busy) return true;
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
    if (req.method === 'GET' && url.pathname === '/active') {
      const canvasId = String(url.searchParams.get('canvasId') || '');
      const sessionId = String(url.searchParams.get('sessionId') || currentId(canvasId));
      let entry = liveEntry(canvasId);
      if (isDurableSessionId(sessionId)) entry = await durable.ensureSession(canvasId,sessionId);
      respond(res,200,{sessionId:entry?.sessionId || null,turnId:entry?.turn.turnId || null,busy:Boolean(entry?.busy)}); return;
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const list = [...await store.listCanvasSessions(canvasId), ...await durable.listCanvasSessions(canvasId)];
      const active = currentId(canvasId) || null;
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
      if (liveEntry(canvasId)?.busy) { respond(res,409,{reason:'session_busy'}); return; }
      if (NEW_SESSION_RUNTIME === 'durable') {
        const entry = await durable.createSession(canvasId);
        respond(res,200,{sessionId:entry.sessionId}); return;
      }
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
      if (liveEntry(canvasId)?.busy) { respond(res,409,{reason:'session_busy'}); return; }
      if (isDurableSessionId(sessionId)) {
        const entry = await durable.activateSession(canvasId,sessionId);
        const submission = await durable.recover(entry);
        if (submission) followDurable(entry,submission);
        respond(res,200,{sessionId:entry.sessionId}); return;
      }
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
        sessionId = currentId(canvasId);
      }
      if (!sessionId) { respond(res, 200, { sessionId: null, turns: [] }); return; }
      if (isDurableSessionId(sessionId)) {
        if (requested && sessionId !== currentId(canvasId)) {
          respond(res,200,await durable.history(canvasId,sessionId)); return;
        }
        const entry = await durable.ensureSession(canvasId,sessionId);
        const submission = await durable.recover(entry);
        if (submission) followDurable(entry,submission);
        respond(res,200,await durable.history(canvasId,sessionId)); return;
      }
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
      const entry = liveEntry(body.canvasId);
      if (!entry) { respond(res, 404, { code: 404, reason: 'session_not_found' }); return; }
      if (entry.kind === 'durable') {
        // Persist stop intent before the Go fence so a crash can still journal it.
        await durable.fenceStop(entry);
        await ops.opsRequest('POST',`/assistant/runtime/turns/${encodeURIComponent(entry.turn.turnId)}/complete`,{});
        await durable.stop(entry);
        respond(res,202,{accepted:true,busy:entry.busy}); return;
      }
      entry.generation.aborted = true;
      try { await entry.session.abort(); } catch (error) { console.error(`agent-host: abort 失败 ${error.message}`); }
      respond(res, 202, { accepted: true, busy: entry.busy });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/steer') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const message = String(body.message || '').trim();
      const sessionId = String(body.sessionId || '').trim();
      const entry = liveEntry(canvasId);
      if (!canvasId || !sessionId || (!message && !body.attachments?.length) || message.length > 16000) {
        respond(res, 400, { code: 400, reason: 'invalid_request' }); return;
      }
      if (!entry || entry.sessionId !== sessionId) {
        respond(res, 409, { code: 409, reason: 'session_not_current' }); return;
      }
      if (entry.kind === 'durable') {
        if (!entry.busy || entry.completing || entry.generation.aborted) {
          respond(res,409,{code:409,reason:'session_not_running'}); return;
        }
        const pending = durable.beginPendingInput(entry);
        try {
          const content = await attachmentContent(body,entry.turn.turnId);
          await durable.supplement(entry,{requestId:body.requestId || crypto.randomUUID(),content,input:body});
          pending.resolve();
          respond(res,202,{accepted:true}); return;
        } catch (error) { pending.reject(error); throw error; }
      }
      if (!entry.busy || entry.generation.aborted || !entry.session.isStreaming) {
        respond(res, 409, { code: 409, reason: 'session_not_running' }); return;
      }
      // Block stale writes immediately; only journal a supplement after the
      // official queue accepts it. A rejected supplement is never acknowledged.
      entry.generation.intentEpoch += 1;
      try {
        await entry.session.steer(message);
      } catch {
        respond(res, 409, { code: 409, reason: 'steer_failed' }); return;
      }
      entry.manager.appendCustomEntry(`${TURN_ENTRY_TYPE}.supplement`, {
        turnId: entry.turn.turnId, message, createdAt: new Date().toISOString(),
      });
      entry.turn.supplements.push(message);
      respond(res, 202, { accepted: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const userText = String(body.message || '').trim();
      const turnId = String(body.turnId || '').trim();
      const revisionBefore = Number(body.revisionBefore || 0);
      const requestedSessionId = String(body.sessionId || '').trim();
      const chosen = requestedSessionId || currentId(canvasId);
      if(isDurableSessionId(chosen) || (!chosen && NEW_SESSION_RUNTIME === 'durable') || body.permissionMode) {
        const authority=await ops.opsRequest('GET',`/assistant/runtime/turns/${encodeURIComponent(turnId)}`);
        if(authority.canvasId!==canvasId || authority.open===false) throw Object.assign(new Error('turn_not_open'),{reason:'turn_not_open'});
        body.permissionMode=authority.permissionMode || 'canvas';
      } else {body.permissionMode='canvas';} // Legacy unannotated sessions never gain workspace access.
      if (isDurableSessionId(chosen) || (!chosen && NEW_SESSION_RUNTIME === 'durable')) {
        if (!canvasId || (!userText && !body.attachments?.length) || !turnId) { respond(res,400,{reason:'invalid_request'}); return; }
        if (providerReason) { respond(res,503,{reason:providerReason}); return; }
        const entry = await durable.ensureSession(canvasId,chosen);
        const content = await attachmentContent(body,turnId);
        content[0].text = `${turnContextPrefix(body)}\n${content[0].text}`;
        const submission = await durable.submit(entry,{...body,content,userText,revisionBefore,requestId:body.requestId || turnId});
        res.durableTurn = true;
        res.writeHead(200,{'Content-Type':'application/x-ndjson'});
        const result = followDurable(entry,submission);
        const listener = payload=>{ if (!res.destroyed) sendLine(res,payload); };
        entry.listeners.add(listener);
        try {
          const record = await result;
          if (!res.destroyed) { sendLine(res,{...record,type:'turn_end',persistence:entry.persistence}); res.end(); }
        } finally { entry.listeners.delete(listener); }
        return;
      }
      let message = userText;
      const selected = Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds.map((v) => String(v)) : [];
      const references = Array.isArray(body.references)
        ? body.references.filter((item) => item && typeof item === 'object' && item.id)
          .map((item) => ({ kind: String(item.kind || ''), id: String(item.id) }))
        : [];
      if (selected.length > 0 || references.length > 0) {
        message = `${turnContextPrefix({ canvasId, selectedNodeIds: selected, references,permissionMode:body.permissionMode })}\n${userText}`;
      }
      if (!canvasId || !message) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      if (providerReason) { respond(res, 503, { code: 503, reason: providerReason }); return; }
      const entry = await store.acquireChatSession(canvasId, ops.buildTools, requestedSessionId);
      entry.generation.permissionMode=body.permissionMode;
      entry.session.setActiveToolsByName(ops.buildTools(canvasId,entry.log,entry.generation,entry.turn,entry.identity.prefix).map(tool=>tool.name));
      const budget = createTurnBudget({ maxRequests: MAX_REQUESTS_PER_TURN, maxToolSteps: MAX_TOOL_STEPS_PER_TURN });
      entry.generation.intentEpoch = 0;
      entry.generation.modelEpoch = 0;
      budget.generation = entry.generation;
      try {
        resetTurnAccumulator(entry.turn, revisionBefore, turnId);
        entry.turn.canvasId=canvasId;
        entry.turn.supplements = [];
        entry.manager.appendCustomEntry(`${TURN_ENTRY_TYPE}.started`, {
          turnId, userText, permissionMode:body.permissionMode, selectedNodeIds: selected, references, createdAt: new Date().toISOString(),
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
        const supplements = [...entry.turn.supplements];
        const record = { turnId, userText, permissionMode:body.permissionMode, supplements, selectedNodeIds: selected, references, reply, toolCalls, change, proposals,
          error, errorReason, cancelled: entry.generation.aborted, createdAt: new Date().toISOString() };
        try { entry.manager.appendCustomEntry(TURN_ENTRY_TYPE, record); }
        catch (persistError) { console.error(`agent-host: 轮次记录写入失败 ${persistError?.message || persistError}`); }
        sendLine(res, { type: 'turn_end', turnId, reply, supplements, toolCalls, change, proposals, error, errorReason,
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
    else {
      if (!res.destroyed) {
        sendLine(res, res.durableTurn ? {type:'observer_error',reason:error.reason || 'interrupted'} :
          { type: 'turn_end', reply: '', toolCalls: [], change: null, proposals: [], error: String(error?.message || error), cancelled: false });
        res.end();
      }
    }
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await durable.disposeAll();
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
