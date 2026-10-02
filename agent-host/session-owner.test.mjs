import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

function fakeEntry(id) {
  const entry = {
    sessionId: id,
    busy: false,
    disposed: false,
    abortCalls: 0,
    disposeCalls: 0,
    generation: { aborted: false },
    turn: { turnId: '' },
    session: {
      abort: async () => { entry.abortCalls += 1; },
      dispose: () => { entry.disposeCalls += 1; },
    },
  };
  return entry;
}

describe('画布预约、指针回滚与 chat 占位', () => {
  test('并发 replaceSession 工厂不重叠，旧会话只 dispose 一次，落败候选被释放', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-race', old);
      const events = [];
      const a = fakeEntry('new-a');
      const b = fakeEntry('new-b');
      await Promise.all([
        store.replaceSession('canvas-race', async () => {
          events.push('a-start');
          await delay(30);
          events.push('a-end');
          return a;
        }),
        store.replaceSession('canvas-race', async () => {
          events.push('b-start');
          await delay(5);
          events.push('b-end');
          return b;
        }),
      ]);
      const order = events.join(',');
      expect(order === 'a-start,a-end,b-start,b-end' || order === 'b-start,b-end,a-start,a-end').toBe(true);
      const active = store.sessions.get('canvas-race');
      const loser = active === a ? b : a;
      expect(active === a || active === b).toBe(true);
      expect(old.disposeCalls).toBe(1);
      expect(active.disposeCalls).toBe(0);
      expect(loser.disposeCalls).toBe(1);
      expect(old.disposed).toBe(true);
      expect(loser.disposed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('并发 ensureSession 与 replaceSession 共享预约，最终一条活动会话', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-er', old);
      const next = fakeEntry('new');
      const events = [];
      const [ensured, replaced] = await Promise.all([
        store.ensureSession('canvas-er', () => []).then((entry) => {
          events.push('ensure');
          return entry;
        }),
        store.replaceSession('canvas-er', async () => {
          events.push('replace-start');
          await delay(20);
          events.push('replace-end');
          return next;
        }),
      ]);
      const order = events.join(',');
      expect(order === 'ensure,replace-start,replace-end' || order === 'replace-start,replace-end,ensure').toBe(true);
      expect(replaced).toBe(next);
      expect(store.sessions.get('canvas-er')).toBe(next);
      expect(ensured === old || ensured === next).toBe(true);
      expect(old.disposeCalls).toBe(1);
      expect(next.disposeCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('不同画布的 replace 可以重叠', async () => {
    const { root, store } = scratchStore();
    try {
      let started = 0;
      let release;
      const bothStarted = new Promise((resolve) => { release = resolve; });
      await Promise.all([
        store.replaceSession('canvas-1', async () => {
          started += 1;
          if (started === 2) release();
          await bothStarted;
          return fakeEntry('one');
        }),
        store.replaceSession('canvas-2', async () => {
          started += 1;
          if (started === 2) release();
          await bothStarted;
          return fakeEntry('two');
        }),
      ]);
      expect(started).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('current.json 是目录时 replace 失败，旧会话仍在，候选被 dispose', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-p', old);
      mkdirSync(store.currentSessionPointerPath('canvas-p'), { recursive: true });
      const next = fakeEntry('new-b');
      await expect(store.replaceSession('canvas-p', async () => next)).rejects.toMatchObject({ reason: 'session_pointer_failed' });
      expect(store.sessions.get('canvas-p')).toBe(old);
      expect(old.disposeCalls).toBe(0);
      expect(next.disposeCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('指针目录不可写时 replace 失败，current.json 仍是旧 id，候选被 dispose', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-ro', old);
      store.writeCurrentSessionId('canvas-ro', 'old');
      const dir = store.canvasSessionDir('canvas-ro');
      chmodSync(dir, 0o555);
      const next = fakeEntry('new');
      try {
        await expect(store.replaceSession('canvas-ro', async () => next)).rejects.toMatchObject({ reason: 'session_pointer_failed' });
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(store.sessions.get('canvas-ro')).toBe(old);
      expect(JSON.parse(readFileSync(store.currentSessionPointerPath('canvas-ro'), 'utf8')).sessionId).toBe('old');
      expect(old.disposeCalls).toBe(0);
      expect(next.disposeCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('工厂失败时不安装、不 dispose 旧会话', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-f', old);
      await expect(store.replaceSession('canvas-f', async () => {
        throw new Error('factory down');
      })).rejects.toThrow('factory down');
      expect(store.sessions.get('canvas-f')).toBe(old);
      expect(old.disposeCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ensureSession 遇到 EISDIR 指针不上新会话', async () => {
    const { root, store } = scratchStore();
    try {
      mkdirSync(store.currentSessionPointerPath('canvas-e'), { recursive: true });
      await expect(store.ensureSession('canvas-e', () => [])).rejects.toMatchObject({ reason: 'session_pointer_failed' });
      expect(store.sessions.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ensureSession 遇到损坏指针不上新会话', async () => {
    const { root, store } = scratchStore();
    try {
      writeFileSync(store.currentSessionPointerPath('canvas-bad'), '{');
      await expect(store.ensureSession('canvas-bad', () => [])).rejects.toMatchObject({ reason: 'session_pointer_failed' });
      expect(store.sessions.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ensureSession 不吞掉 SDK 装配失败', async () => {
    const root = mkdtempSync(join(tmpdir(), 'beeftv-session-owner-'));
    const store = createSessionStore({
      sessionRoot: join(root, 'sessions'),
      workspaceRoot: join(root, 'workspace'),
      agentDir: join(root, 'pi-agent'),
      runId: 'run-test',
      getModelRuntime: () => { throw new Error('runtime boom'); },
      getModel: () => undefined,
    });
    try {
      await expect(store.ensureSession('canvas-sdk', () => [])).rejects.toThrow('runtime boom');
      expect(store.sessions.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ensureSession 指针指向缺失会话时回退到可恢复历史', async () => {
    const { root, store, buildTools } = scratchStore();
    try {
      const live = await store.replaceSession('canvas-miss', () => store.createLiveSession({
        canvasId: 'canvas-miss', sessionId: '', buildTools,
      }));
      live.manager.appendCustomEntry(TURN_ENTRY_TYPE, {
        turnId: 'keep', userText: '可恢复的原话', reply: '记下', toolCalls: [], change: null, proposals: [],
        error: null, cancelled: false, createdAt: new Date().toISOString(),
      });
      live.manager.appendMessage({ role: 'user', content: [{ type: 'text', text: '可恢复的原话' }] });
      live.manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '记下' }] });
      const keptId = live.sessionId;
      await store.disposeOwnedSession(live);
      store.sessions.delete('canvas-miss');
      writeFileSync(store.currentSessionPointerPath('canvas-miss'), JSON.stringify({ sessionId: 'definitely-missing-session' }));
      const restored = await store.ensureSession('canvas-miss', buildTools);
      expect(restored.sessionId).toBe(keptId);
      expect(store.turnEntries(restored.manager)[0].userText).toBe('可恢复的原话');
      await store.disposeAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('chat 占 busy 与 replace 互斥：busy 时工厂不跑', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-chat', old);
      const held = await store.acquireChatSession('canvas-chat', () => []);
      expect(held).toBe(old);
      expect(old.busy).toBe(true);
      let factoryRan = false;
      await expect(store.replaceSession('canvas-chat', async () => {
        factoryRan = true;
        return fakeEntry('new');
      })).rejects.toMatchObject({ reason: 'session_busy' });
      expect(factoryRan).toBe(false);
      expect(store.sessions.get('canvas-chat')).toBe(old);
      expect(old.disposeCalls).toBe(0);
      store.releaseChatSession(held);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('并发 acquireChat 与 replace：不会 dispose 仍被 chat 占用的会话，也不会泄漏候选', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-mix', old);
      const candidate = fakeEntry('new');
      const [chat, replaced] = await Promise.allSettled([
        store.acquireChatSession('canvas-mix', () => []),
        store.replaceSession('canvas-mix', async () => {
          await delay(15);
          return candidate;
        }),
      ]);
      const active = store.sessions.get('canvas-mix');
      if (replaced.status === 'rejected') {
        expect(replaced.reason).toMatchObject({ reason: 'session_busy' });
        expect(chat.status).toBe('fulfilled');
        expect(chat.value).toBe(old);
        expect(old.busy).toBe(true);
        expect(active).toBe(old);
        expect(old.disposeCalls).toBe(0);
        expect(candidate.disposeCalls).toBe(0);
      } else {
        expect(chat.status).toBe('fulfilled');
        expect(chat.value).toBe(active);
        expect(active.busy).toBe(true);
        expect(active).toBe(candidate);
        expect(old.disposeCalls).toBe(1);
        expect(candidate.disposeCalls).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('acquireChat 发现会话已切换时不占 busy', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-cur', old);
      await expect(store.acquireChatSession('canvas-cur', () => [], 'other')).rejects.toMatchObject({ reason: 'session_not_current' });
      expect(old.busy).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disposeAll 释放全部活动会话且只 dispose 一次', async () => {
    const { root, store } = scratchStore();
    try {
      const a = fakeEntry('a');
      const b = fakeEntry('b');
      store.sessions.set('c1', a);
      store.sessions.set('c2', b);
      expect(await store.disposeAll()).toBe(2);
      expect(store.sessions.size).toBe(0);
      expect(a.disposeCalls).toBe(1);
      expect(b.disposeCalls).toBe(1);
      await store.disposeOwnedSession(a);
      expect(a.disposeCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disposeAll 等待进行中的 replace，安装后的候选也会被释放', async () => {
    const { root, store } = scratchStore();
    try {
      const old = fakeEntry('old');
      store.sessions.set('canvas-sd', old);
      let releaseFactory;
      const gate = new Promise((resolve) => { releaseFactory = resolve; });
      let signalStarted;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      const next = fakeEntry('new');
      const replaced = store.replaceSession('canvas-sd', async () => {
        signalStarted();
        await gate;
        return next;
      });
      await started;
      const disposing = store.disposeAll();
      releaseFactory();
      await replaced;
      expect(await disposing).toBe(1);
      expect(store.sessions.size).toBe(0);
      expect(old.disposeCalls).toBe(1);
      expect(next.disposeCalls).toBe(1);
      await expect(store.replaceSession('canvas-sd', async () => fakeEntry('after'))).rejects.toMatchObject({ reason: 'session_store_closed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('真实 SDK 并发 replace 最终只有一条活动会话', async () => {
    const { root, store, buildTools } = scratchStore();
    try {
      const [first, second] = await Promise.all([
        store.replaceSession('canvas-sdk-race', () => store.createLiveSession({
          canvasId: 'canvas-sdk-race', sessionId: '', buildTools,
        })),
        store.replaceSession('canvas-sdk-race', () => store.createLiveSession({
          canvasId: 'canvas-sdk-race', sessionId: '', buildTools,
        })),
      ]);
      const active = store.sessions.get('canvas-sdk-race');
      expect(active === first || active === second).toBe(true);
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(store.readCurrentSessionId('canvas-sdk-race')).toBe(active.sessionId);
      await store.disposeAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('真实 SDK 并发 ensure 与 replace 最终指针与活动会话一致', async () => {
    const { root, store, buildTools } = scratchStore();
    try {
      const [ensured, replaced] = await Promise.all([
        store.ensureSession('canvas-er-sdk', buildTools),
        store.replaceSession('canvas-er-sdk', () => store.createLiveSession({
          canvasId: 'canvas-er-sdk', sessionId: '', buildTools,
        })),
      ]);
      const active = store.sessions.get('canvas-er-sdk');
      expect(active === ensured || active === replaced).toBe(true);
      expect(active.disposed).toBe(false);
      if (ensured !== active) expect(ensured.disposed).toBe(true);
      if (replaced !== active) expect(replaced.disposed).toBe(true);
      expect(store.readCurrentSessionId('canvas-er-sdk')).toBe(active.sessionId);
      await store.disposeAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
