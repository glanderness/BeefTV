// SDK 会话所有者：SessionManager 是唯一 transcript；createAgentSession 装配官方会话。
// 替换走官方 abort()+dispose()（与 AgentSessionRuntime.teardownCurrent 相同），
// 不用 AgentSessionRuntime：它的 factory 绑定 cwd 发现服务，switchSession 还会丢掉自定义 sessionDir。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { sessionActionIdentity } from './session-identity.mjs';
import { newTurnAccumulator, projectTurnHistory, sessionTitle } from './canvas-turn.mjs';
import { createFullControlLoader } from './full-control-loader.mjs';
import { createHostSettingsManager } from './session-settings.mjs';
import { createTurnObserver } from './lifecycle-events.mjs';

export const TURN_ENTRY_TYPE = 'beeftv.canvas.turn';

export function canvasKey(canvasId) {
  return crypto.createHash('sha256').update(canvasId).digest('hex').slice(0, 24);
}

export function createSessionStore({ sessionRoot, workspaceRoot, agentDir, runId, getModelRuntime, getModel }) {
  const sessions = new Map();
  const resourceLoader = createFullControlLoader();

  function canvasWorkspace(canvasId) {
    return path.join(workspaceRoot, canvasKey(canvasId));
  }

  function canvasSessionDir(canvasId) {
    const dir = path.join(sessionRoot, canvasKey(canvasId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function currentSessionPointerPath(canvasId) {
    return path.join(canvasSessionDir(canvasId), 'current.json');
  }

  function readCurrentSessionId(canvasId) {
    try {
      const raw = JSON.parse(fs.readFileSync(currentSessionPointerPath(canvasId), 'utf8'));
      return typeof raw?.sessionId === 'string' ? raw.sessionId : '';
    } catch { return ''; }
  }

  function writeCurrentSessionId(canvasId, sessionId) {
    fs.writeFileSync(currentSessionPointerPath(canvasId), JSON.stringify({ sessionId }), { mode: 0o600 });
  }

  function turnEntries(manager) {
    const active = [...sessions.values()].find((entry) => entry.busy && entry.sessionId === manager.getSessionId());
    return projectTurnHistory(manager.getEntries(), TURN_ENTRY_TYPE, active?.turn.turnId || '');
  }

  async function listCanvasSessions(canvasId) {
    const cwd = canvasWorkspace(canvasId);
    fs.mkdirSync(cwd, { recursive: true });
    const sessionDir = canvasSessionDir(canvasId);
    const known = await SessionManager.list(cwd, sessionDir);
    const out = [];
    for (const info of known) {
      let turns = [];
      try { turns = turnEntries(SessionManager.open(info.path, sessionDir, cwd)); } catch { turns = []; }
      out.push({
        sessionId: info.id,
        title: sessionTitle(turns),
        updatedAt: new Date(info.modified).toISOString(),
        turnCount: turns.length,
      });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  function openSessionManager(canvasId, sessionId) {
    const cwd = canvasWorkspace(canvasId);
    fs.mkdirSync(cwd, { recursive: true });
    const sessionDir = canvasSessionDir(canvasId);
    if (sessionId) {
      const file = SessionManager.findById(cwd, sessionId, sessionDir);
      if (!file) { const error = new Error('session_not_found'); error.reason = 'session_not_found'; throw error; }
      return { manager: SessionManager.open(file, sessionDir, cwd), persistence: `restored:${sessionId}` };
    }
    return { manager: SessionManager.create(cwd, sessionDir), persistence: 'created' };
  }

  async function createLiveSession({ canvasId, sessionId, buildTools }) {
    const cwd = canvasWorkspace(canvasId);
    const log = [];
    const generation = { aborted: false };
    const turn = newTurnAccumulator();
    let opened;
    try {
      opened = openSessionManager(canvasId, sessionId);
    } catch (error) {
      if (error?.reason === 'session_not_found') throw error;
      throw new Error(`会话持久化不可用（SessionManager 恢复失败）：${error.message}`);
    }
    const { manager, persistence } = opened;
    const persistedId = (typeof manager.getSessionId === 'function' && manager.getSessionId()) ||
      (typeof manager.getSessionFile === 'function' && manager.getSessionFile() ? path.basename(String(manager.getSessionFile())) : '') || '';
    const identity = sessionActionIdentity({ persistedId, runId });
    console.error(`agent-host: 会话 ${canvasId} 的动作身份来源 = ${identity.source}（persistence=${persistence}）`);
    const tools = buildTools(canvasId, log, generation, turn, identity.prefix);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: getModelRuntime() || undefined,
      model: getModel() || undefined,
      thinkingLevel: 'off',
      noTools: 'builtin',
      customTools: tools,
      resourceLoader,
      settingsManager: createHostSettingsManager(),
      sessionManager: manager,
    });
    return {
      sessionId: manager.getSessionId(),
      session,
      manager,
      log,
      busy: false,
      generation,
      turn,
      identity,
      persistence,
    };
  }

  async function disposeOwnedSession(entry) {
    if (!entry?.session) return;
    try { await entry.session.abort(); } catch { /* 释放必须继续 */ }
    try { entry.session.dispose(); } catch { /* 释放必须继续 */ }
  }

  function sessionBusyError() {
    const error = new Error('session_busy');
    error.reason = 'session_busy';
    return error;
  }

  async function replaceSession(canvasId, factory) {
    const previous = sessions.get(canvasId);
    if (previous?.busy) throw sessionBusyError();
    const next = await factory();
    sessions.set(canvasId, next);
    writeCurrentSessionId(canvasId, next.sessionId);
    if (previous && previous.session !== next.session) {
      await disposeOwnedSession(previous);
    }
    return next;
  }

  async function ensureSession(canvasId, buildTools) {
    const existing = sessions.get(canvasId);
    if (existing) return existing;
    const pointed = readCurrentSessionId(canvasId);
    if (pointed) {
      try { return await replaceSession(canvasId, () => createLiveSession({ canvasId, sessionId: pointed, buildTools })); }
      catch { /* 指针失效时按下面的规则重建 */ }
    }
    const known = await listCanvasSessions(canvasId);
    if (known.length > 0) {
      try { return await replaceSession(canvasId, () => createLiveSession({ canvasId, sessionId: known[0].sessionId, buildTools })); }
      catch { /* 损坏时新建 */ }
    }
    return replaceSession(canvasId, () => createLiveSession({ canvasId, sessionId: '', buildTools }));
  }

  async function runOwnedPrompt(entry, message, { onEvent, runWithBudget, timeoutMs }) {
    const observer = createTurnObserver();
    const unsubscribe = entry.session.subscribe((event) => {
      const payload = observer.handle(event);
      if (payload) onEvent(payload);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      entry.generation.aborted = true;
      entry.session.abort().catch(() => {});
    }, timeoutMs);
    let error = null;
    try {
      await runWithBudget(async () => {
        await entry.session.prompt(message, { expandPromptTemplates: false, source: 'rpc' });
      });
      // prompt() 在 0.87.1 会等到 _emitAgentSettled；若仍未观察到 settled，保持订阅再 waitForIdle。
      if (!observer.settled) {
        try { await entry.session.waitForIdle(); } catch { /* 仍按未 settle 处理 */ }
      }
    } catch (promptError) {
      error = `${promptError?.name || 'Error'}: ${promptError?.message || promptError}`;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    if (!observer.settled && !error) {
      error = 'Error: agent run did not settle';
    }
    return { observer, error, timedOut };
  }

  return {
    sessions,
    canvasWorkspace,
    canvasSessionDir,
    readCurrentSessionId,
    writeCurrentSessionId,
    turnEntries,
    listCanvasSessions,
    openSessionManager,
    createLiveSession,
    disposeOwnedSession,
    replaceSession,
    ensureSession,
    runOwnedPrompt,
  };
}
