import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { TURN_ENTRY_TYPE, createSessionStore } from './session-owner.mjs';

function scratchStore() {
  const root = mkdtempSync(join(tmpdir(), 'beeftv-session-owner-'));
  const store = createSessionStore({
    sessionRoot: join(root, 'sessions'),
    workspaceRoot: join(root, 'workspace'),
    agentDir: join(root, 'pi-agent'),
    runId: 'run-test',
    getModelRuntime: () => undefined,
    getModel: () => undefined,
  });
  return { root, store, buildTools: () => [] };
}

describe('官方 SDK 会话创建、替换、释放与持久化', () => {
  test('replace 会 abort+dispose 上一条官方会话，SessionManager 文件仍保留', async () => {
    const { root, store, buildTools } = scratchStore();
    try {
      const first = await store.replaceSession('canvas-a', () => store.createLiveSession({
        canvasId: 'canvas-a', sessionId: '', buildTools,
      }));
      expect(first.session.getActiveToolNames()).toEqual([]);
      first.manager.appendCustomEntry(TURN_ENTRY_TYPE, {
        turnId: 'turn-keep', userText: '保留这条对话', reply: '已记下', toolCalls: [], change: null, proposals: [],
        error: null, cancelled: false, createdAt: new Date().toISOString(),
      });
      first.manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '保留这条对话' }] });
      first.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '已记下' }] });
      const firstId = first.sessionId;
      const firstFile = first.manager.getSessionFile();
      expect(firstFile).toBeTruthy();

      let disposed = false;
      const originalDispose = first.session.dispose.bind(first.session);
      first.session.dispose = () => { disposed = true; originalDispose(); };

      const second = await store.replaceSession('canvas-a', () => store.createLiveSession({
        canvasId: 'canvas-a', sessionId: '', buildTools,
      }));
      expect(disposed).toBe(true);
      expect(second.sessionId).not.toBe(firstId);
      expect(store.sessions.get('canvas-a').session).toBe(second.session);
      expect(first.session).not.toBe(second.session);

      const cwd = store.canvasWorkspace('canvas-a');
      const sessionDir = store.canvasSessionDir('canvas-a');
      const file = SessionManager.findById(cwd, firstId, sessionDir);
      expect(file).toBe(firstFile);
      const reopened = SessionManager.open(file, sessionDir, cwd);
      expect(reopened.getSessionId()).toBe(firstId);
      const turns = store.turnEntries(reopened);
      expect(turns).toHaveLength(1);
      expect(turns[0].userText).toBe('保留这条对话');
      await store.disposeOwnedSession(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('busy 会话拒绝替换，不 dispose 当前官方会话', async () => {
    const { root, store, buildTools } = scratchStore();
    try {
      const live = await store.replaceSession('canvas-b', () => store.createLiveSession({
        canvasId: 'canvas-b', sessionId: '', buildTools,
      }));
      live.busy = true;
      let disposed = false;
      const originalDispose = live.session.dispose.bind(live.session);
      live.session.dispose = () => { disposed = true; originalDispose(); };
      await expect(store.replaceSession('canvas-b', () => store.createLiveSession({
        canvasId: 'canvas-b', sessionId: '', buildTools,
      }))).rejects.toMatchObject({ reason: 'session_busy' });
      expect(disposed).toBe(false);
      expect(store.sessions.get('canvas-b')).toBe(live);
    } finally {
      await store.disposeOwnedSession(store.sessions.get('canvas-b'));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('create → dispose → open 仍能读到官方 JSONL custom entry', async () => {
    const { root, store, buildTools } = scratchStore();
    try {
      const live = await store.createLiveSession({ canvasId: 'canvas-c', sessionId: '', buildTools });
      live.manager.appendCustomEntry(`${TURN_ENTRY_TYPE}.started`, { turnId: 't1', userText: '中断前的原话' });
      live.manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '中断前的原话' }] });
      live.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '半截' }] });
      const sessionId = live.sessionId;
      await store.disposeOwnedSession(live);
      const restored = await store.createLiveSession({ canvasId: 'canvas-c', sessionId, buildTools });
      expect(restored.sessionId).toBe(sessionId);
      expect(restored.persistence).toBe(`restored:${sessionId}`);
      const history = store.turnEntries(restored.manager);
      expect(history[0].errorReason).toBe('turn_interrupted');
      expect(history[0].userText).toBe('中断前的原话');
      await store.disposeOwnedSession(restored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
