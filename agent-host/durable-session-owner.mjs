// New conversations have one official Durable owner. Legacy JSONL sessions are
// deliberately never imported or run here. Go remains the business authority.
import fs from 'node:fs';
import {officialNativeHistory} from './native-history.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc, defineExtension, defineTool, watchEvents,
  GenerationTask, hook } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { canvasKey } from './session-owner.mjs';
import { newTurnAccumulator, resetTurnAccumulator, turnChange, sessionTitle } from './canvas-turn.mjs';
import { SYSTEM_PROMPT } from './full-control-loader.mjs';

export const DURABLE_VERSION = '1.0.4';
const STATE = defineDoc({ kind: 'beeftv.host', version: 1, scope: 'session',
  initial: () => ({ version: DURABLE_VERSION, canvasId: '', sessionId: '', active: null, turns: [] }) });
const CTX = BACKGROUND_CONTEXT;
const supplementMarker = (id) => `[BEEFTV_INPUT:${id}]`;
function supplementContent(id, content) {
  return [{ type: 'text', text: supplementMarker(id) }, ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content)];
}
const idPattern = /^durable:([a-f0-9-]{36})$/;
const fail = (reason) => Object.assign(new Error(reason), { reason });
export const isDurableSessionId = (id) => idPattern.test(String(id || ''));
const SAFE_WRITES = new Set(['canvas.nodes.create', 'canvas.node.update', 'canvas.node.configure', 'canvas.edge.create',
  'canvas.node.move','canvas.node.delete','canvas.edge.delete','canvas.document.commit',
  'canvas.task.bind', 'canvas.timeline.update', 'canvas.timeline.render']);
export function durableToolReplay(tool) {
  return tool.readOnly === true || SAFE_WRITES.has(tool.label) ||
    ['canvas.get', 'canvas.search', 'asset.get', 'asset.list', 'task.get', 'canvas.generation.propose',
      'media.overview', 'media.inspect', 'media.check', 'skill.get', 'skill.file'].includes(tool.label) ? 'safe' : 'unsafe';
}
export function publicDurableTurn(active, running = false) {
  if (!active) return null;
  const keys = ['permissionMode','turnId', 'requestId', 'submissionId', 'userText', 'selectedNodeIds', 'attachments', 'skills',
    'references', 'supplements', 'supplementInputs', 'createdAt', 'reply', 'toolCalls', 'change', 'proposals',
    'cancelled', 'error', 'errorReason', 'sessionId', 'status'];
  const result = Object.fromEntries(keys.filter((key) => active[key] !== undefined).map((key) => [key, active[key]]));
  if (running) { delete result.toolCalls; result.status = 'running'; }
  return result;
}
export function durableCompletion(settled, assistant, budgetFailure, stopped = false) {
  const cancelled = Boolean(stopped || settled.reason === 'aborted');
  const text = assistant?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || '';
  if (cancelled) return { reply: text, cancelled, error: null, errorReason: null };
  if (settled.status !== 'done') return { reply: '', cancelled: false,
    error: String(budgetFailure?.message || settled.detail || settled.reason || 'agent_run_failed'),
    errorReason: budgetFailure?.reason || settled.reason || 'agent_run_failed' };
  if (!assistant || ['error', 'aborted'].includes(assistant.stopReason)) return { reply: '', cancelled: false,
    error: assistant?.errorMessage || 'agent_answer_missing', errorReason: 'provider_error' };
  return { reply: assistant.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || '',
    cancelled: false, error: null, errorReason: null };
}

export function createDurableSessionStore({ sessionRoot, workspaceRoot, getModels, getModelRef,
  buildTools, authorizeTurn, completeTurn = async () => {}, runWithBudget = (_entry, fn) => fn(),
  extensions = () => [], settings = {} }) {
  if (typeof authorizeTurn !== 'function') throw fail('durable_authorizer_required');
  const sessions = new Map();
  const locks = new Map();
  let closed = false;
  const directory = (canvasId) => path.join(sessionRoot, canvasKey(canvasId));
  const durableDirectory = (canvasId) => path.join(directory(canvasId), 'durable');
  const currentPath = (canvasId) => path.join(directory(canvasId), 'current.json');
  async function lock(canvasId, fn) {
    const previous = locks.get(canvasId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (closed) throw fail('session_store_closed'); return fn(); });
    locks.set(canvasId, next);
    try { return await next; } finally { if (locks.get(canvasId) === next) locks.delete(canvasId); }
  }
  function publish(entry) {
    const temporary = `${currentPath(entry.canvasId)}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ sessionId: entry.sessionId, kind: 'durable', version: DURABLE_VERSION }), { mode: 0o600 });
    fs.renameSync(temporary, currentPath(entry.canvasId));
  }
  async function state(entry) { return await entry.harness.snapshot(STATE, CTX); }
  async function authorization(entry, turnId, allowClosed = false) {
    const result = await authorizeTurn({ canvasId: entry.canvasId, turnId, sessionId: entry.sessionId });
    const mode=result?.permissionMode || 'canvas';
    if (!['read-only','canvas','full-access'].includes(mode)) throw fail('invalid_permission_mode');
    if (entry.input?.turnId===turnId && (entry.input.permissionMode || 'canvas')!==mode) throw fail('permission_mode_frozen');
    if (entry.permissionMode!==mode) {entry.permissionMode=mode;entry.generation.permissionMode=mode;if(entry.configurePermission) await entry.configurePermission(mode);}
    if (result?.open === false) {
      // Only an explicit identity-matching response can mean owned but closed.
      if (result.canvasId !== entry.canvasId || result.turnId !== turnId) throw fail('scope_denied');
      if (!allowClosed) throw fail('turn_not_open');
    }
    return result;
  }
  async function update(entry, mutate) {
    return entry.harness.commit(async (tx) => mutate(await tx.doc(STATE)), CTX);
  }
  function hydrate(entry, active) {
    entry.busy = Boolean(active);
    if (!active) return;
    Object.assign(entry.turn, active.effects);
    entry.turn.turnId = active.turnId;
    entry.input = active;
    entry.generation.permissionMode=active.permissionMode || 'canvas';
    const pins = [...(active.skills || active.skillPins || []), ...(active.supplementInputs || []).flatMap((input) => input.skills || [])];
    entry.skillPins = [...new Map(pins.map((pin) => [pin.skillId, pin])).values()];
    entry.generation.aborted ||= Boolean(active.stopped);
    entry.generation.intentEpoch = active.intentEpoch || 0;
    entry.generation.modelEpoch = active.modelEpoch || 0;
    entry.turn.supplements = active.supplements || [];
  }
  async function persistEffects(entry) {
    await update(entry, (doc) => {
      if (doc.active && doc.active.turnId === entry.turn.turnId) {
        doc.active.effects = JSON.parse(JSON.stringify(entry.turn));
        doc.active.log = [...entry.log];
        doc.active.modelEpoch = entry.generation.modelEpoch;
      }
    });
  }
  async function open(canvasId, sessionId) {
    if (!isDurableSessionId(sessionId)) throw fail('session_not_found');
    const uuid = idPattern.exec(sessionId)[1];
    const dir = durableDirectory(canvasId);
    const manifestPath = path.join(dir, `${uuid}.json`);
    if (!fs.existsSync(manifestPath)) throw fail('session_not_found');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.canvasId !== canvasId || manifest.sessionId !== sessionId || manifest.version !== DURABLE_VERSION) throw fail('durable_version_mismatch');
    const cwd = path.join(workspaceRoot, canvasKey(canvasId));
    fs.mkdirSync(cwd, { recursive: true });
    const entry = { kind: 'durable', canvasId, sessionId, identity: { prefix: sessionId, source: 'durable-session-id' },
      log: [], generation: { durable: true, aborted: false, intentEpoch: 0, modelEpoch: 0 }, turn: newTurnAccumulator(), busy: false, persistence: 'restored',
      budgetDirectory: path.join(dir, `${uuid}.budget`) };
    fs.mkdirSync(entry.budgetDirectory, { recursive: true, mode: 0o700 });
    const registry = createRegistry();
    entry.generation.permissionMode='full-access';
    const tools = buildTools(canvasId, entry.log, entry.generation, entry.turn, sessionId).map((tool) => defineTool({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      replay: durableToolReplay(tool), executionMode: 'sequential',
      ...(['media.overview', 'media.inspect', 'media.check'].includes(tool.label) ? { outputLimits: { maxBytes: 64 * 1024 * 1024, maxLines: 100000 } } : {}),
      execute: async (args, api, context) => {
        if (entry.generation.aborted) throw fail('aborted');
        if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
        if (entry.generation.pendingInput?.state === 'pending') throw fail('supplement_preparation_pending');
        await authorization(entry, entry.turn.turnId);
        try {
          return await runWithBudget(entry, () => tool.execute(String(api.taskId), args, context.abortSignal));
        } finally { await persistEffects(entry); }
      },
    }));
    const operationExtension=defineExtension({ name: 'beeftv.operations.v1', tools, hooks: [hook(GenerationTask, {
      beforeRequest: async (request) => {
        for (;;) {
          if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
          if (entry.generation.pendingInput?.state === 'pending') await entry.generation.pendingInput.promise;
          if (entry.generation.aborted) throw fail('aborted');
          await authorization(entry, entry.turn.turnId);
          const nativeDoc = await state(entry);
          const active = nativeDoc.active;
          entry.nativeHistory = await officialNativeHistory(entry,nativeDoc,CTX);
          if(entry.budget) {entry.budget.nativeHistory=entry.nativeHistory;entry.budget.sessionId=entry.sessionId;}
          if (entry.generation.pendingInput?.state === 'pending') continue;
          if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
          let messages = request.messages;
          // A recovered generation may already have checkpointed its prepared
          // request before steering was queued. Overlay only missing durable user
          // inputs through the official request hook; the queue still owns their
          // transcript placement. This prevents replaying a stale prepared intent.
          for (const input of active?.supplementContents || []) {
            if (!JSON.stringify(messages).includes(supplementMarker(input.requestId))) {
              messages = [...messages, { role: 'user', content: supplementContent(input.requestId, input.content), timestamp: Date.now() }];
            }
          }
          entry.generation.modelEpoch = active?.intentEpoch || 0;
          await persistEffects(entry);
          if (entry.generation.pendingInput?.state === 'pending') continue;
          if ((active?.intentEpoch || 0) !== entry.generation.intentEpoch) continue;
          if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
          if (messages !== request.messages) return { messages };
          return;
        }
      },
    })] });
    registry.install(operationExtension);
    entry.configurePermission=async mode=>{
      entry.generation.permissionMode=mode;
      const projected=buildTools(canvasId,entry.log,entry.generation,entry.turn,sessionId);
      const byName=new Map(projected.map(t=>[t.name,t]));
      const selected=tools.filter(t=>byName.has(t.name)).map(t=>({...t,parameters:byName.get(t.name).parameters}));
      registry.install(defineExtension({...operationExtension,tools:selected}));
      if(entry.root) await entry.root.configure({tools:selected,instructions:`${SYSTEM_PROMPT}\n${mode==='read-only'?'只能读取工作区内容，不能修改或生成。':mode==='full-access'?'可读取和修改本工作区的所有画布。付费生成必须等待用户确认。':'仅修改当前画布；其他画布只读。'}`},CTX);
    };
    for (const extension of await extensions(entry)) registry.install(extension);
    entry.harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, `${uuid}.sqlite`)), {
      models: await getModels(entry), registry,
      settings: { stream: { timeoutMs: 95000, maxRetries: 0 }, retry: { maxRetries: 2 },
        toolExecution: 'sequential', steeringMode: 'all', ...settings },
    }, CTX);
    try {
      entry.root = await entry.harness.root(CTX, { agent: { model: await getModelRef(entry), tools,
        instructions: SYSTEM_PROMPT, thinkingLevel: 'off', cwd } });
      let hostState = await state(entry);
      if (!hostState) {
        await update(entry, (doc) => { doc.canvasId = canvasId; doc.sessionId = sessionId; });
        hostState = await state(entry);
      }
      if (hostState.canvasId !== canvasId || hostState.sessionId !== sessionId || hostState.version !== DURABLE_VERSION) throw fail('durable_version_mismatch');
      hydrate(entry, hostState.active);
      entry.log.push(...(hostState.active?.log || []));
      return entry;
    } catch (error) { await entry.harness.close(CTX); throw error; }
  }
  async function createSession(canvasId) {
    return lock(canvasId, async () => {
      if (sessions.get(canvasId)?.busy) throw fail('session_busy');
      const sessionId = `durable:${crypto.randomUUID()}`;
      fs.mkdirSync(durableDirectory(canvasId), { recursive: true, mode: 0o700 });
      const file = path.join(durableDirectory(canvasId), `${idPattern.exec(sessionId)[1]}.json`);
      fs.writeFileSync(file, JSON.stringify({ sessionId, canvasId, version: DURABLE_VERSION, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      const entry = await open(canvasId, sessionId);
      entry.persistence = 'created';
      publish(entry);
      const previous = sessions.get(canvasId);
      sessions.set(canvasId, entry);
      if (previous) await previous.harness.close(CTX);
      return entry;
    });
  }
  async function activateSession(canvasId, sessionId) {
    return lock(canvasId, async () => {
      const previous = sessions.get(canvasId);
      if (previous?.sessionId === sessionId) { publish(previous); return previous; }
      if (previous?.busy) throw fail('session_busy');
      const entry = await open(canvasId, sessionId);
      publish(entry);
      sessions.set(canvasId, entry);
      if (previous) await previous.harness.close(CTX);
      return entry;
    });
  }
  async function ensureSession(canvasId, sessionId = '') {
    if (!sessionId) {
      if (sessions.has(canvasId)) return sessions.get(canvasId);
      try { sessionId = JSON.parse(fs.readFileSync(currentPath(canvasId), 'utf8')).sessionId; }
      catch (error) { if (error.code !== 'ENOENT') throw fail('session_pointer_failed'); }
    }
    if (!sessionId) return createSession(canvasId);
    return activateSession(canvasId, sessionId);
  }
  async function submit(entry, input) {
    return lock(entry.canvasId, async () => {
      const existing = await state(entry);
      const requestId = String(input.requestId || input.turnId || '').trim();
      if (!requestId || !input.turnId || !input.content) throw fail('invalid_request');
      if (existing.active && existing.active.requestId !== requestId) throw fail('session_busy');
      const finished = existing.turns.find((turn) => turn.requestId === requestId);
      if (finished) return entry.harness.submission(finished.submissionId, CTX);
      if (existing.active && (existing.active.turnId !== input.turnId || JSON.stringify(existing.active.content) !== JSON.stringify(input.content))) throw fail('submission_request_conflict');
      const auth=await authorization(entry, input.turnId);
      input={...input,permissionMode:auth?.permissionMode || 'canvas'};
      if (!existing.active) {
        entry.budget = null;
        resetTurnAccumulator(entry.turn, input.revisionBefore, input.turnId);
        entry.turn.canvasId=entry.canvasId;
        entry.turn.supplements = [];
        entry.log.length = 0;
        entry.generation = Object.assign(entry.generation, { aborted: false, intentEpoch: 0, modelEpoch: 0, pendingInput: null, pendingInputError: null });
        await update(entry, (doc) => {
          doc.active = { ...input, requestId, createdAt: new Date().toISOString(), stopped: false,
            effects: JSON.parse(JSON.stringify(entry.turn)), log: [], supplements: [], intentEpoch: 0, modelEpoch: 0 };
        });
      }
      hydrate(entry, (await state(entry)).active);
      const submission = await entry.root.submit({ type: 'input', requestId, content: input.content, whenBusy: 'reject' }, CTX);
      await update(entry, (doc) => { if (doc.active) doc.active.submissionId = submission.id; });
      return submission;
    });
  }
  async function recover(entry) {
    const active = (await state(entry)).active;
    if (!active) return null;
    hydrate(entry, active);
    // Opening/reading never schedules pending work. Only validated recovery does.
    const auth = await authorization(entry, active.turnId, true);
    if (active.stopped) { await stop(entry); return null; }
    if (auth?.open === false) {
      const admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, active.requestId), CTX);
      const submission = admitted ? await entry.harness.submission(admitted.id, CTX) : null;
      const settled = submission && await submission.status(CTX);
      if (!settled || !['done', 'unanswered'].includes(settled.status)) throw fail('turn_not_open');
      // No submit/resume: a closed turn may only reconstruct committed history.
      const record = active.result || await completionRecord(entry, active, settled);
      await settleLocal(entry, active, record);
      return submission;
    }
    if (active.result) {
      await completeTurn({ canvasId: entry.canvasId, turnId: active.turnId, sessionId: entry.sessionId, record: active.result });
      await settleLocal(entry, active, active.result);
      return entry.harness.submission(active.submissionId, CTX);
    }
    // Re-admit persisted supplements by stable request ID before scheduling the
    // original submission. The official queue deduplicates already placed ones.
    for (const input of active.supplementContents || []) {
      await entry.root.submit({ type: 'input', requestId: `supplement:${input.requestId}`,
        content: supplementContent(input.requestId, input.content), whenBusy: 'steer' }, CTX);
    }
    return submit(entry, active);
  }
  async function supplement(entry, { requestId, content, input = {} }) {
    if (entry.completing || entry.generation.aborted) throw fail('session_not_running');
    return lock(entry.canvasId, async () => {
      if (entry.completing || entry.generation.aborted) throw fail('session_not_running');
      const active = (await state(entry)).active;
      if (!active || active.stopped || !requestId || !content) throw fail('session_not_running');
      await authorization(entry, active.turnId);
      if (entry.generation.aborted) throw fail('session_not_running');
      const previous = (active.supplementContents || []).find((input) => input.requestId === requestId);
      if (previous && JSON.stringify(previous.content) !== JSON.stringify(content)) throw fail('submission_request_conflict');
      if (previous) return entry.root.submit({ type: 'input', requestId: `supplement:${requestId}`, content: supplementContent(requestId, content), whenBusy: 'steer' }, CTX);
      entry.generation.intentEpoch += 1;
      await update(entry, (doc) => {
        if (!doc.active || doc.active.stopped || entry.generation.aborted) throw fail('session_not_running');
        const ids = doc.active.supplementIds || [];
        if (!ids.includes(requestId)) {
          doc.active.supplementIds = [...ids, requestId];
          const message = String(input.message ?? (typeof content === 'string' ? content : ''));
          doc.active.supplements = [...doc.active.supplements, message];
          doc.active.supplementInputs = [...(doc.active.supplementInputs || []), { requestId, message,
            attachments: input.attachments || [], skills: input.skills || [] }];
          doc.active.supplementContents = [...(doc.active.supplementContents || []), { requestId, content }];
          doc.active.intentEpoch = entry.generation.intentEpoch;
        }
      });
      entry.turn.supplements = (await state(entry)).active?.supplements || [];
      hydrate(entry, (await state(entry)).active);
      if (entry.generation.aborted) throw fail('session_not_running');
      const queued = await entry.root.submit({ type: 'input', requestId: `supplement:${requestId}`, content: supplementContent(requestId, content), whenBusy: 'steer' }, CTX);
      return queued;
    });
  }
  function beginPendingInput(entry) {
    if (entry.completing) throw fail('session_not_running');
    if (entry.generation.pendingInput?.state === 'pending') throw fail('supplement_preparation_pending');
    if (entry.generation.pendingInputError || entry.generation.aborted) throw fail('session_not_running');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // The HTTP preparation may reject before the next official generation hook
    // awaits it. Keep rejection handled while retaining the rejecting promise.
    promise.catch(() => {});
    const pending = { state: 'pending', promise };
    pending.cancel = () => {
      if (pending.state !== 'pending') return;
      pending.state = 'cancelled'; resolve();
      if (entry.generation.pendingInput === pending) entry.generation.pendingInput = null;
    };
    entry.generation.pendingInput = pending;
    entry.generation.modelEpoch = -1;
    return {
      resolve() {
        if (pending.state !== 'pending') return;
        pending.state = 'resolved'; resolve();
        if (entry.generation.pendingInput === pending) entry.generation.pendingInput = null;
      },
      reject(error) {
        if (pending.state !== 'pending') return;
        const reason = error?.reason || 'supplement_preparation_failed';
        entry.generation.pendingInputError = { reason, message: String(error?.message || reason) };
        pending.state = 'rejected'; reject(fail(reason));
        // End any older in-flight response as well; it must not finish the
        // business turn successfully after the latest user input was rejected.
        void entry.root.abort(CTX).catch(() => {});
      },
    };
  }
  async function wait(entry, submission, { onEvent = () => {}, signal } = {}) {
    const context = signal ? withAbortSignal(signal, CTX) : CTX;
    const stream = await watchEvents(entry.harness, entry.root.id, context);
    await onEvent({ type: 'snapshot', ...stream.snapshot, sessionId: entry.sessionId });
    stream.start(async (events) => { for (const event of events) await onEvent(event); });
    try {
      const original = await submission.wait(context);
      for (;;) {
        // Never hold the canvas admission lock while waiting for image prep or
        // official generations: supplement() needs that lock to admit inputs.
        const pending = entry.generation.pendingInput;
        if (pending?.state === 'pending') await pending.promise.catch(() => {});
        const snapshot = await state(entry);
        if (!snapshot.active) return snapshot.turns.find((turn) => turn.submissionId === submission.id) || null;
        const ids = [...(snapshot.active.supplementIds || [])];
        let settled = original;
        for (const id of ids) {
          const admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, `supplement:${id}`), CTX);
          if (!admitted) {
            // The host persists supplemental metadata before official admission.
            // A stop in that exact gap must not admit it during cancellation or
            // recovery. The fenced turn can settle using existing official work.
            if (snapshot.active.stopped || entry.generation.aborted) continue;
            throw fail('supplement_submission_missing');
          }
          const supplemental = await entry.harness.submission(admitted.id, CTX);
          settled = await supplemental.wait(context);
        }
        const result = await lock(entry.canvasId, async () => {
          const current = await state(entry);
          if (!current.active) return { done: true, record: current.turns.find((turn) => turn.submissionId === submission.id) || null };
          if (entry.generation.pendingInput?.state === 'pending' || JSON.stringify(current.active.supplementIds || []) !== JSON.stringify(ids)) return { done: false };
          entry.completing = true;
          try {
            const active = current.active;
            const record = active.result || await completionRecord(entry, active, settled);
            await update(entry, (doc) => { if (doc.active?.requestId === active.requestId) doc.active.result = record; });
            // Retain active.result until Go acknowledges. Recovery can retry
            // that completion without scheduling any more model work.
            await completeTurn({ canvasId: entry.canvasId, turnId: active.turnId, sessionId: entry.sessionId, record });
            await settleLocal(entry, active, record);
            return { done: true, record };
          } finally { entry.completing = false; }
        });
        if (result.done) return result.record;
      }
    } finally { await stream.stop(); }
  }
  async function completionRecord(entry, active, settled) {
    // The official settlement points at its exact answer entry. Never take the
    // last assistant in transcript: it may belong to a previous successful turn.
    const answer = settled.answer ? await entry.harness.commit((tx) => tx.entry(settled.answer), CTX) : null;
    let assistant = answer?.model?.find((message) => message.role === 'assistant');
    if (active.stopped || settled.reason === 'aborted') {
      // Official abort converts its committed partial into an assistant entry.
      // Scope strictly after this submission's own user entry, never prior turns.
      const original = active.submissionId ? await entry.harness.submission(active.submissionId, CTX) : null;
      const originalStatus = original ? await original.status(CTX) : null;
      const lowerBound = originalStatus?.entry ?? settled.entry;
      if (lowerBound !== undefined) {
        const view = await entry.root.context(CTX);
        const partial = view.entries.filter((item) => item.id > lowerBound).flatMap((item) => item.model || [])
          .filter((message) => message.role === 'assistant' && message.stopReason === 'aborted').at(-1);
        if (partial) assistant = partial;
      }
    }
    const preparationError = entry.generation.pendingInputError;
    const completion = preparationError ? { reply: assistant?.content?.filter(block => block.type === 'text').map(block => block.text).join('') || '', cancelled: false, error: preparationError.message, errorReason: preparationError.reason } : durableCompletion(settled, assistant, entry.budget?.failure, active.stopped);
    return { ...publicDurableTurn(active), ...completion,
      toolCalls: [...entry.log], change: turnChange(entry.turn), proposals: [...entry.turn.proposals],
      status: settled.status, sessionId: entry.sessionId };
  }
  async function settleLocal(entry, active, record) {
    await update(entry, (doc) => {
      if (doc.active?.requestId === active.requestId) { doc.turns = [...doc.turns, record]; doc.active = null; }
    });
    entry.busy = false;
  }
  async function fenceStop(entry) {
    entry.generation.aborted = true;
    // A user stop owns cancellation; it must not wait for an unrelated image
    // decoder/network response, nor turn a late prep failure into a run error.
    entry.generation.pendingInput?.cancel?.();
    await update(entry, (doc) => { if (doc.active) doc.active.stopped = true; });
  }
  async function stop(entry) {
    await fenceStop(entry);
    await entry.root.abort(CTX);
    const active = (await state(entry)).active;
    if (active?.submissionId) {
      const submission = await entry.harness.submission(active.submissionId, CTX);
      if (submission) return wait(entry, submission);
    }
  }
  async function history(canvasId, sessionId) {
    const cached = sessions.get(canvasId);
    const entry = cached?.sessionId === sessionId ? cached : await open(canvasId, sessionId);
    try { const value = await state(entry); return { sessionId, turns: value.turns.map((turn) => publicDurableTurn(turn)), active: publicDurableTurn(value.active, true) }; }
    finally { if (entry !== cached) await entry.harness.close(CTX); }
  }
  async function status(entry) {
    const value = await state(entry);
    const inspection = await entry.harness.inspect(CTX);
    return { sessionId: entry.sessionId, kind: 'durable', active: publicDurableTurn(value.active, true),
      inspection: { scheduling: inspection.scheduling,
        tasks: inspection.tasks.map((task) => ({ id: task.record.id, state: task.state.kind })),
        submissions: inspection.submissions.map((submission) => ({ id: submission.id, status: submission.status })) } };
  }
  async function listCanvasSessions(canvasId) {
    const dir = durableDirectory(canvasId);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))) {
      const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const value = await history(canvasId, info.sessionId);
      out.push({ sessionId: info.sessionId, kind: 'durable', title: sessionTitle(value.turns),
        updatedAt: value.turns.at(-1)?.createdAt || info.createdAt, turnCount: value.turns.length });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function disposeAll() {
    closed = true;
    await Promise.allSettled([...locks.values()]);
    const entries = [...sessions.values()]; sessions.clear();
    for (const entry of entries) await entry.harness.close(CTX);
    return entries.length;
  }
  return { sessions, createSession, activateSession, ensureSession, submit, recover, supplement, beginPendingInput, fenceStop, wait,
    stop, history, status, listCanvasSessions, disposeAll };
}
