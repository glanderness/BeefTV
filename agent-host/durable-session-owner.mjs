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
import { getCurrentSystemMessage } from '@earendil-works/pi-ai/utils/transcript';
import { canvasKey } from './session-owner.mjs';
import { newTurnAccumulator, resetTurnAccumulator, turnChange, sessionTitle } from './canvas-turn.mjs';
import { SYSTEM_PROMPT } from './system-prompt.mjs';
import { SKILL_LOAD_PARAMETERS, createSkillCatalogSection, expandSkillContent, loadPinnedSkills, loadedSkillRecord,
  normalizeSkillCatalog, sameSkillPin, skillsToLoad, activeSkillProjection, createActiveSkillSection, guardSkillModelRequests } from './skill-resource.mjs';

// On-disk format tag written into manifests and host state since 1.0.4; not the
// package version. Changing it rejects every existing session as mismatched.
export const DURABLE_VERSION = '1.0.4';
const STATE = defineDoc({ kind: 'beeftv.host', version: 1, scope: 'session',
  initial: () => ({ version: DURABLE_VERSION, canvasId: '', sessionId: '', active: null, turns: [], loadedSkills: [] }) });
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
// The root agent's reasoning level; budgets follow pi-ai's DEFAULT_THINKING_BUDGETS.
export function agentThinkingLevel(env = process.env) {
  const value = String(env.BEEFTV_AGENT_THINKING || '').trim().toLowerCase();
  return THINKING_LEVELS.includes(value) ? value : 'low';
}
const CTX = BACKGROUND_CONTEXT;
const supplementMarker = (id) => `[BEEFTV_INPUT:${id}]`;
function supplementContent(id, content) {
  return [{ type: 'text', text: supplementMarker(id) }, ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content)];
}
const idPattern = /^durable:([a-f0-9-]{36})$/;
const fail = (reason) => Object.assign(new Error(reason), { reason });
const requestSignature = messages => crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
export const isDurableSessionId = (id) => idPattern.test(String(id || ''));
export function durableToolReplay(tool) {
  return tool.replay === 'safe' ? 'safe' : 'unsafe';
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
  extensions = () => [], settings = {}, skills = null, thinkingLevel = agentThinkingLevel() }) {
  if (!THINKING_LEVELS.includes(thinkingLevel)) throw fail('invalid_thinking_level');
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
    try {
      fs.writeFileSync(temporary, JSON.stringify({ sessionId: entry.sessionId, kind: 'durable', version: DURABLE_VERSION }), { mode: 0o600 });
      fs.renameSync(temporary, currentPath(entry.canvasId));
    } catch (cause) {
      try { fs.rmSync(temporary, { force: true }); } catch (cleanup) { cause = new AggregateError([cause, cleanup], 'session_pointer_cleanup_failed'); }
      throw Object.assign(fail('session_pointer_failed'), { cause });
    }
  }
  async function install(entry) {
    try { publish(entry); }
    catch (error) {
      try { await entry.harness.close(CTX); }
      catch (cleanup) { error.cause = new AggregateError([error.cause, cleanup], 'session_candidate_cleanup_failed'); }
      throw error;
    }
    const previous = sessions.get(entry.canvasId);
    sessions.set(entry.canvasId, entry);
    if (previous) await previous.harness.close(CTX);
    return entry;
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
  async function turnModel(entry, active) {
    const agent = await entry.root.agent(CTX);
    // Only the backend-launched host chooses a NEW round's model. An unfinished
    // round retains its official model, including old rounds without this pin.
    const ref = active ? (active.modelRef || agent.model) : await getModelRef(entry);
    if (!ref?.provider || !ref?.modelId) throw fail('model_not_configured');
    const modelRef = { provider: ref.provider, modelId: ref.modelId };
    if (!(await getModels(entry)).getModel(modelRef.provider, modelRef.modelId)) {
      throw fail(active ? 'model_unavailable_for_resume' : 'model_not_configured');
    }
    if (active) {
      if (agent.model?.provider !== modelRef.provider || agent.model?.modelId !== modelRef.modelId) throw fail('turn_model_frozen');
    } else {
      // Existing conversations pick up the host's current reasoning level on
      // their next new round, as they pick up the model.
      await entry.root.configure({ model: modelRef, thinkingLevel }, CTX);
    }
    return modelRef;
  }
  function hydrate(entry, active) {
    entry.busy = Boolean(active);
    if (!active) return;
    Object.assign(entry.turn, active.effects);
    entry.turn.turnId = active.turnId;
    entry.input = active;
    entry.generation.permissionMode=active.permissionMode || 'canvas';
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
  // Every fresh explicit selection expands its fixed version into the user
  // message, as official `/skill:name` does. Request receipts own retry dedup.
  async function expandSelectedSkills(entry, doc, pins, content, turnId) {
    if (!skills || !Array.isArray(pins) || !pins.length) return { content, records: [] };
    const missing = skillsToLoad(pins, doc?.loadedSkills || []);
    if (!missing.length) return { content, records: [] };
    const resources = await loadPinnedSkills({ pins: missing, readVersion: (pin, signal) => skills.readVersion(entry, pin, signal, turnId) });
    return { content: expandSkillContent(content, resources), records: resources.map((resource) => loadedSkillRecord(resource, 'selected', turnId)) };
  }
  async function readSkillContext(entry, turnId = entry.turn.turnId) {
    if (typeof skills?.readContext !== 'function') throw fail('skill_context_service_unavailable');
    const context = await skills.readContext(entry, turnId);
    if (context.canvasId !== entry.canvasId || context.sessionId !== entry.sessionId) throw fail('skill_context_identity_mismatch');
    return context;
  }
  async function resolveActiveSkills(entry, ref, signal) {
    const context = await readSkillContext(entry);
    const model = (await getModels(entry)).getModel(ref.provider, ref.modelId);
    return activeSkillProjection({context,model,signal,
      readVersion:(pin,readSignal)=>skills.readVersion(entry,pin,readSignal,entry.turn.turnId)});
  }
  async function resetPendingScope(entry, context) {
    if (context.lifecycle !== 'reset_pending') return context;
    // Repeating reset after a crash before acknowledgement is safe: no model
    // request can pass until the same Go-owned scope has been acknowledged.
    await entry.root.reset('用户开始一个独立任务。只使用当前明确选择的技能和本轮提供的资源。', CTX);
    return skills.changeContext(entry,{action:'ack_reset',scopeId:context.scopeId,expectedRevision:context.revision},'');
  }
  async function prepareSkillContext(entry, pins, requestId, turnId, {append=false}={}) {
    let context = await resetPendingScope(entry,await readSkillContext(entry,turnId));
    if (pins?.length) {
      const values=append?[...context.activePins.filter(pin=>!pins.some(next=>next.skillId===pin.skillId)),...pins]:pins;
      context=await skills.changeContext(entry,{action:'activate',pins:values,expectedRevision:context.revision,requestId:`select:${requestId}`},turnId);
      const current=await readSkillContext(entry,turnId);
      if (current.scopeId!==context.scopeId || current.revision!==context.revision) throw fail('skill_context_changed');
    }
    return context;
  }
  async function skillContext(entry) {
    return lock(entry.canvasId,()=>readSkillContext(entry,''));
  }
  async function changeSkillContext(entry, change) {
    return lock(entry.canvasId,async()=>{
      if (entry.busy || (await state(entry)).active) throw fail('session_busy');
      await resetPendingScope(entry,await readSkillContext(entry,''));
      await skills.changeContext(entry,change,'');
      // A replayed new_scope receipt may predate an already acknowledged reset
      // or later tasks. Only the live Go record can request another reset.
      return resetPendingScope(entry,await readSkillContext(entry,''));
    });
  }
  function hostTools(entry) {
    if (!skills) return [];
    return [{
      name: 'skill_load', label: 'skill.load', readOnly: false, replay: 'safe',
      description: '按技能目录里的 id 加载一个已安装技能的固定版本，并在当前会话持续使用；不修改画布。需要只检查文件时使用 skill_file。',
      parameters: SKILL_LOAD_PARAMETERS,
      execute: async (_toolCallId, args, signal) => {
        const id = String(args?.id || '').trim();
        const find = (items) => (items || []).find((item) => item.pin.skillId === id);
        const active=await readSkillContext(entry);
        const pinned=active.activePins.find(pin=>pin.skillId===id);
        let item = pinned ? {pin:pinned} : find(entry.skillCatalog.items);
        if (!item) item = find(normalizeSkillCatalog(await skills.readCatalog(entry, signal, entry.turn.turnId,{id})));
        if (!item) throw fail('skill_not_installed: 技能目录里没有这个 id');
        const [resource] = await loadPinnedSkills({ pins: [item.pin], signal,
          readVersion: (pin, readSignal) => skills.readVersion(entry, pin, readSignal, entry.turn.turnId) });
        await prepareSkillContext(entry,[item.pin],`tool:${_toolCallId}`,entry.turn.turnId,{append:true});
        await update(entry, (doc) => {
          const loaded = doc.loadedSkills || [];
          if (!loaded.some((record) => sameSkillPin(record, resource.pin))) doc.loadedSkills = [...loaded, loadedSkillRecord(resource, 'tool', entry.turn.turnId)];
        });
        return { content: [{ type: 'text', text: expandSkillContent('按上面技能的步骤继续当前任务。', [resource]) }] };
      },
    }];
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
      budgetDirectory: path.join(dir, `${uuid}.budget`), skillCatalog: {} };
    fs.mkdirSync(entry.budgetDirectory, { recursive: true, mode: 0o700 });
    const registry = createRegistry();
    entry.generation.persistEffects = () => persistEffects(entry);
    entry.generation.permissionMode='full-access';
    const tools = [...buildTools(canvasId, entry.log, entry.generation, entry.turn, sessionId), ...hostTools(entry)].map((tool) => defineTool({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      replay: durableToolReplay(tool), executionMode: 'sequential',
      ...(['media.overview', 'media.inspect', 'media.check'].includes(tool.label) ? { outputLimits: { maxBytes: 64 * 1024 * 1024, maxLines: 100000 } } : {}),
      execute: async (args, api, context) => {
        if (entry.generation.aborted) throw fail('aborted');
        if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
        if (entry.generation.pendingInput?.state === 'pending') throw fail('supplement_preparation_pending');
        await authorization(entry, entry.turn.turnId);
        try {
          // Bridge tools return {content}; Durable's ToolExecutionResult names it output.
          const { content, ...result } = await runWithBudget(entry, () => tool.execute(String(api.taskId), args, context.abortSignal));
          return { ...result, output: content };
        } finally { await persistEffects(entry); }
      },
    }));
    entry.toolNames = tools.map((tool) => tool.name);
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
          // Identify generation requests without treating the SDK's separate
          // compaction summarizer request as a user-generation prompt.
          entry.generation.preparedRequests ||= new Set();
          entry.generation.preparedRequests.add(requestSignature(messages));
          if (messages !== request.messages) return { messages };
          return;
        }
      },
    })] });
    registry.install(operationExtension);
    entry.configurePermission=async mode=>{
      entry.generation.permissionMode=mode;
      const projected=[...buildTools(canvasId,entry.log,entry.generation,entry.turn,sessionId),...hostTools(entry)];
      const byName=new Map(projected.map(t=>[t.name,t]));
      const selected=tools.filter(t=>byName.has(t.name)).map(t=>({...t,parameters:byName.get(t.name).parameters}));
      entry.toolNames = selected.map((tool) => tool.name);
      registry.install(defineExtension({...operationExtension,tools:selected}));
      if(entry.root) await entry.root.configure({tools:selected,instructions:`${SYSTEM_PROMPT}\n${mode==='read-only'?'只能读取工作区内容，不能修改或生成。':mode==='full-access'?'可读取和修改本工作区的所有画布。付费生成必须等待用户确认。':'仅修改当前画布；其他画布只读。'}`},CTX);
    };
    if (skills) registry.install(defineExtension({ name: 'beeftv.skills.v1', sections: [createSkillCatalogSection({
      readCatalog: (signal) => skills.readCatalog(entry, signal, entry.turn.turnId), cache: entry.skillCatalog }),
      createActiveSkillSection((ref,signal)=>resolveActiveSkills(entry,ref,signal))] }));
    for (const extension of await extensions(entry)) registry.install(extension);
    let models=await getModels(entry);
    if(skills) models=guardSkillModelRequests(models,async(model,request,signal)=>{
      await authorization(entry,entry.turn.turnId);
      const projection=await resolveActiveSkills(entry,{provider:model.provider,modelId:model.id},signal);
      if(entry.generation.preparedRequests?.has(requestSignature(request.messages))){
        const shown=getCurrentSystemMessage(request.messages)?.sections?.beeftv_active_skills;
        const expected=projection.text?`<beeftv_active_skills>\n${projection.text}\n</beeftv_active_skills>`:undefined;
        if(shown!==expected)throw fail('skill_context_changed');
      }
    },error=>{entry.generation.skillContextFailure={reason:error?.reason || 'skill_context_unavailable',message:error?.message || '技能状态不可用'};});
    entry.harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, `${uuid}.sqlite`)), {
      models, registry,
      settings: { stream: { timeoutMs: 95000, maxRetries: 0 }, retry: { maxRetries: 2 },
        toolExecution: 'sequential', steeringMode: 'all', ...settings },
    }, CTX);
    try {
      entry.root = await entry.harness.root(CTX, { agent: { model: await getModelRef(entry), tools,
        instructions: SYSTEM_PROMPT, thinkingLevel, cwd } });
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
  // 新建候选：写清单、打开官方 Harness，但不发布指针、不写入 sessions。
  async function prepareSession(canvasId, handoffSourceId = '') {
    // A legacy source has one durable successor even if the process dies before
    // publishing current.json or the client receives no response.
    const digest = handoffSourceId && crypto.createHash('sha256').update(JSON.stringify([canvasId, handoffSourceId])).digest('hex');
    const uuid = digest ? `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}` : crypto.randomUUID();
    const sessionId = `durable:${uuid}`;
    fs.mkdirSync(durableDirectory(canvasId), { recursive: true, mode: 0o700 });
    const file = path.join(durableDirectory(canvasId), `${idPattern.exec(sessionId)[1]}.json`);
    const created = !handoffSourceId || !fs.existsSync(file);
    if (created) {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ sessionId, canvasId, handoffSourceId, version: DURABLE_VERSION, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    } else if (JSON.parse(fs.readFileSync(file, 'utf8')).handoffSourceId !== handoffSourceId) {
      throw fail('handoff_source_conflict');
    }
    const current = sessions.get(canvasId);
    if (current?.sessionId === sessionId) return current;
    const entry = await open(canvasId, sessionId);
    entry.persistence = created ? 'created' : 'restored';
    return entry;
  }
  async function createSession(canvasId) {
    return lock(canvasId, async () => {
      if (sessions.get(canvasId)?.busy) throw fail('session_busy');
      return install(await prepareSession(canvasId));
    });
  }
  // An initialized successor must never reset when an old client retries.
  async function handoffSession(canvasId, handoffNote = '', handoffSourceId = '') {
    return lock(canvasId, async () => {
      const current = sessions.get(canvasId);
      if (current?.busy) throw fail('session_busy');
      const entry = await prepareSession(canvasId, handoffSourceId);
      if (!(await state(entry)).handoffInitialized) {
        try {
          if (handoffNote) await entry.root.reset(handoffNote, CTX);
          await update(entry, (doc) => { doc.handoffInitialized = true; });
        }
        catch (error) { await entry.harness.close(CTX).catch(() => {}); throw error; }
      }
      if (entry === current) { publish(entry); return entry; }
      return install(entry);
    });
  }
  async function activateSession(canvasId, sessionId) {
    return lock(canvasId, async () => {
      const previous = sessions.get(canvasId);
      if (previous?.sessionId === sessionId) { publish(previous); return previous; }
      if (previous?.busy) throw fail('session_busy');
      const entry = await open(canvasId, sessionId);
      return install(entry);
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
      if (finished) {
        if(JSON.stringify(skillsToLoad(finished.skills || []))!==JSON.stringify(skillsToLoad(input.skills || [])))throw fail('submission_request_conflict');
        return entry.harness.submission(finished.submissionId, CTX);
      }
      if (existing.active && (existing.active.turnId !== input.turnId || JSON.stringify(existing.active.content) !== JSON.stringify(input.content) ||
        JSON.stringify(skillsToLoad(existing.active.skills || []))!==JSON.stringify(skillsToLoad(input.skills || [])))) throw fail('submission_request_conflict');
      const auth=await authorization(entry, input.turnId);
      const modelRef = await turnModel(entry, existing.active);
      input={...input,modelRef,permissionMode:auth?.permissionMode || 'canvas'};
      if (!existing.active) {
        entry.budget = null;
        resetTurnAccumulator(entry.turn, input.revisionBefore, input.turnId);
        entry.turn.canvasId=entry.canvasId;
        entry.turn.supplements = [];
        entry.log.length = 0;
        entry.generation = Object.assign(entry.generation, { aborted: false, intentEpoch: 0, modelEpoch: 0, pendingInput: null, pendingInputError: null,skillContextFailure:null,preparedRequests:new Set() });
        if (skills) await prepareSkillContext(entry,input.skills,requestId,input.turnId);
        const expansion = await expandSelectedSkills(entry, existing, input.skills, input.content, input.turnId);
        await update(entry, (doc) => {
          // content stays the client's own input (idempotency and history);
          // submittedContent is what the transcript receives, skills included.
          doc.active = { ...input, requestId, createdAt: new Date().toISOString(), stopped: false,
            effects: JSON.parse(JSON.stringify(entry.turn)), log: [], supplements: [], intentEpoch: 0, modelEpoch: 0,
            ...(expansion.records.length ? { submittedContent: expansion.content } : {}) };
          if (expansion.records.length) doc.loadedSkills = [...(doc.loadedSkills || []), ...expansion.records];
        });
      }
      const admitted = (await state(entry)).active;
      hydrate(entry, admitted);
      const submission = await entry.root.submit({ type: 'input', requestId, content: admitted.submittedContent ?? admitted.content, whenBusy: 'reject' }, CTX);
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
    await turnModel(entry, active);
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
      if (previous && JSON.stringify(previous.rawContent ?? previous.content) !== JSON.stringify(content)) throw fail('submission_request_conflict');
      const previousInput=(active.supplementInputs || []).find(item=>item.requestId===requestId);
      if(previous && previousInput && JSON.stringify(skillsToLoad(previousInput.skills || []))!==JSON.stringify(skillsToLoad(input.skills || [])))throw fail('submission_request_conflict');
      if (previous) return entry.root.submit({ type: 'input', requestId: `supplement:${requestId}`, content: supplementContent(requestId, previous.content), whenBusy: 'steer' }, CTX);
      const expansion = await expandSelectedSkills(entry, await state(entry), input.skills, content, active.turnId);
      if (skills) await prepareSkillContext(entry,input.skills,`supplement:${requestId}`,active.turnId,{append:true});
      if (entry.generation.aborted) throw fail('session_not_running');
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
          doc.active.supplementContents = [...(doc.active.supplementContents || []),
            expansion.records.length ? { requestId, content: expansion.content, rawContent: content } : { requestId, content }];
          if (expansion.records.length) doc.loadedSkills = [...(doc.loadedSkills || []), ...expansion.records];
          doc.active.intentEpoch = entry.generation.intentEpoch;
        }
      });
      entry.turn.supplements = (await state(entry)).active?.supplements || [];
      hydrate(entry, (await state(entry)).active);
      if (entry.generation.aborted) throw fail('session_not_running');
      const queued = await entry.root.submit({ type: 'input', requestId: `supplement:${requestId}`, content: supplementContent(requestId, expansion.content), whenBusy: 'steer' }, CTX);
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
    const preparationError = entry.generation.pendingInputError || entry.generation.skillContextFailure;
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
  return { sessions, createSession, handoffSession, activateSession, ensureSession, submit, recover, supplement, beginPendingInput, fenceStop, wait,
    stop, history, status, listCanvasSessions, disposeAll, skillContext, changeSkillContext };
}
