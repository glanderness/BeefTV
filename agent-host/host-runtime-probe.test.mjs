import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { newTurnAccumulator } from './canvas-turn.mjs';
import { createDurableSessionStore, isCorruptSessionArtifactError, isSkippableSessionError } from './durable-session-owner.mjs';
import { canvasKey } from './session-owner.mjs';
import { createDurableTurnLifecycle } from './durable-watch-observer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let receipt;
beforeAll(() => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv runtime receipt '));
  try {
    const output = path.join(scratch, 'receipt.json');
    const child = spawnSync('node', [path.join(root, 'agent-host/test-support/host-runtime-probe.mjs'), root, output], { cwd: root, encoding: 'utf8', timeout: 150000 });
    if (child.error) throw child.error;
    receipt = JSON.parse(readFileSync(output, 'utf8'));
    if (!receipt.results?.length) throw new Error('Runtime probe returned no scenario results');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 170000);

describe('真实 Node 与 pi SDK 的隔离执行链（模型和操作端点均为本地替身）', () => {
  for (const name of [
    'budget-exhaustion-is-an-explicit-failed-turn',
    'new-turn-after-budget-exhaustion-still-works',
    'asset-tool-does-not-inject-unknown-canvasId',
    'explicit-reference-canvas-can-reach-backend-read-guard',
    'history-and-sessions-survive-unresumable-turn-and-corrupt-manifest',
    'transient-frozen-model-resumes-when-restored-and-allows-continue-when-superseded',
    'corrupt-current-session-and-pointer-self-heal-without-500',
  ]) {
    test(name, () => {
      const result = receipt.results.find((item) => item.name === name);
      expect(result, JSON.stringify(receipt.results)).toBeDefined();
      expect(result.passed, result.error).toBe(true);
    });
  }

  test('isSkippableSessionError classifies corrupt session artifacts without swallowing unexpected errors', () => {
    expect(isSkippableSessionError(new SyntaxError('Unexpected token'))).toBe(true);
    for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EISDIR']) {
      expect(isSkippableSessionError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    for (const reason of ['corrupt_session_manifest', 'durable_version_mismatch', 'session_not_found']) {
      expect(isSkippableSessionError(Object.assign(new Error(reason), { reason }))).toBe(true);
    }
    expect(isSkippableSessionError(Object.assign(new Error('SQLITE_NOTADB: file is not a database'), { code: 'ERR_SQLITE_ERROR' }))).toBe(true);
    expect(isSkippableSessionError(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }))).toBe(true);
    expect(isSkippableSessionError(new RangeError('unexpected programming bug'))).toBe(false);
    expect(isSkippableSessionError(Object.assign(new Error('out of memory'), { code: 'ENOMEM' }))).toBe(false);

    expect(isCorruptSessionArtifactError(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('corrupt_session_manifest'), { reason: 'corrupt_session_manifest' }))).toBe(true);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('durable_version_mismatch'), { reason: 'durable_version_mismatch' }))).toBe(true);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('SQLITE_NOTADB: file is not a database'), { code: 'ERR_SQLITE_ERROR' }))).toBe(true);
  });

  test('recoverForRead settle race does not abort or settle a newer turn started before lock acquisition', async () => {
    let doc = {
      active: { requestId: 'req-A', turnId: 'turn-A', stopped: false },
      turns: [],
      stopRequests: [],
    };
    let aborts = 0;
    let lockQueue = Promise.resolve();
    const lock = (_canvasId, fn) => {
      const run = lockQueue.then(fn, fn);
      lockQueue = run.catch(() => {});
      return run;
    };
    let releaseAuthA;
    const authGate = new Promise((resolve) => { releaseAuthA = resolve; });
    const entry = {
      canvasId: 'race-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000001',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-1',
        abort: async () => { aborts += 1; },
      },
      harness: {
        commit: async () => null,
      },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock,
      hydrate: () => {},
      authorization: async (_entry, turnId) => {
        if (turnId === 'turn-A') {
          await authGate;
          throw Object.assign(new Error('turn_not_open'), { reason: 'turn_not_open' });
        }
        return { open: true };
      },
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });

    const readPromise = lifecycle.recoverForRead(entry);
    // Simulate concurrent request settling req-A and admitting req-B while lock is held right as authGate rejects.
    const concurrentTurnB = lock('race-canvas', async () => {
      doc.turns = [{ requestId: 'req-A', turnId: 'turn-A', errorReason: 'turn_interrupted' }];
      doc.active = { requestId: 'req-B', turnId: 'turn-B', stopped: false };
      entry.submittedRequest = 'req-B';
      entry.busy = true;
      releaseAuthA();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await Promise.all([readPromise, concurrentTurnB]);
    expect(aborts).toBe(0);
    expect(doc.active?.requestId).toBe('req-B');
    expect(doc.turns.map((t) => t.requestId)).toEqual(['req-A']);
    expect(entry.busy).toBe(true);
    expect(entry.submittedRequest).toBe('req-B');
  });

  test('recoverForRead treats model_not_configured as transient without mutating active on disk', async () => {
    const doc = {
      active: { requestId: 'req-no-model', turnId: 'turn-no-model', content: [{ type: 'text', text: 'hi' }], stopped: false },
      turns: [],
      stopRequests: [],
    };
    const entry = {
      canvasId: 'no-model-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000002',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: { id: 'root-2', abort: async () => {} },
      harness: { commit: async () => null },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => { throw Object.assign(new Error('model_not_configured'), { reason: 'model_not_configured' }); },
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const res = await lifecycle.recoverForRead(entry);
    expect(res.submission).toBeNull();
    expect(res.unresumableReason).toBe('model_not_configured');
    expect(res.unresumableTurn?.errorReason).toBe('turn_interrupted');
    expect(doc.active?.requestId).toBe('req-no-model');
    expect(entry.busy).toBe(false);
  });

  test('in-flight recoverOnce re-checks active after authorization and never resurrects a settled turn', async () => {
    const doc = {
      active: { requestId: 'req-A', turnId: 'turn-A', stopped: false },
      turns: [],
      stopRequests: [],
    };
    let submitCalls = 0;
    let releaseAuthA;
    const authGate = new Promise((resolve) => { releaseAuthA = resolve; });
    const entry = {
      canvasId: 'recover-race-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000003',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: { id: 'root-3', abort: async () => {} },
      harness: { commit: async () => null },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => {
        await authGate;
        return { open: true };
      },
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => { submitCalls += 1; return { id: 'sub' }; },
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const recovering = lifecycle.recoverForRead(entry);
    // While recoverOnce is paused in authorization, req-A is settled and req-B becomes active in this process.
    doc.turns = [{ requestId: 'req-A', turnId: 'turn-A', errorReason: 'turn_interrupted' }];
    doc.active = { requestId: 'req-B', turnId: 'turn-B', stopped: false };
    entry.submittingRequest = 'req-B';
    releaseAuthA();
    const res = await recovering;
    expect(res).toEqual({ submission: null, unresumableReason: null, unresumableTurn: null });
    expect(submitCalls).toBe(0);
    expect(doc.active?.requestId).toBe('req-B');
  });

  test('settleUnresumableTurnLocked preserves committed done answers instead of misreporting turn_interrupted', async () => {
    const doc = {
      active: { requestId: 'req-done', turnId: 'turn-done', submissionId: 'sub-done', userText: 'Hi', stopped: false },
      turns: [],
      stopRequests: [],
    };
    const answerEntry = {
      id: 2,
      model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Committed answer text.' }] }],
    };
    const entry = {
      canvasId: 'done-settle-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000004',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-4',
        abort: async () => {},
        context: async () => ({ entries: [answerEntry], head: { head: 2 } }),
      },
      harness: {
        commit: async (fn) => fn({
          submissionByRequest: () => ({ id: 'sub-done', entry: 1 }),
          entry: (id) => (id === 2 ? answerEntry : null),
        }),
        submission: async () => ({
          status: async () => ({ status: 'done', entry: 1, answer: 2 }),
        }),
      },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: false }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const pending = await lifecycle.settleUnresumableTurnLocked(entry, 'req-done');
    expect(pending?.record.status).toBe('done');
    expect(pending?.record.reply).toBe('Committed answer text.');
    expect(pending?.record.error).toBeNull();
    expect(doc.active).toBeNull();
    expect(doc.turns).toHaveLength(1);
    expect(doc.turns[0].reply).toBe('Committed answer text.');
  });

  test('wait() keeps entry busy when official submission is still running and clears busy once submission is not running', async () => {
    const doc = {
      active: { requestId: 'req-fail', turnId: 'turn-fail', stopped: false },
      turns: [],
      stopRequests: [],
    };
    let watchClosed = false;
    let currentSubStatus = 'running';
    const emittedTypes = [];
    const entry = {
      canvasId: 'wait-fail-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000005',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: 'req-fail',
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-5',
        abort: async () => {},
        watch: async () => ({
          value: { entries: [], docs: {} },
          stop: () => { watchClosed = true; },
        }),
      },
      harness: {
        commit: async () => null,
        watchDoc: async () => { throw new Error('storage_io_error'); },
      },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const failingSubmission = {
      status: async () => ({ status: currentSubStatus, entry: 1, requestId: 'req-fail' }),
    };
    // 1. Official submission still running: observer failure marks detachedRunning and keeps entry.busy=true!
    entry.running = lifecycle.wait(entry, failingSubmission, {
      onEvent: (event) => { emittedTypes.push(event.type); },
    }).finally(() => {
      entry.running = null;
    });
    await expect(entry.running).rejects.toThrow('storage_io_error');
    expect(emittedTypes).toContain('snapshot');
    expect(watchClosed).toBe(true);
    expect(entry.waiters).toBe(0);
    expect(entry.running).toBeNull();
    expect(entry.detachedRunning).toBe(true);
    expect(entry.busy).toBe(true);

    // 2. When the background submission later finishes on its own (without a second wait() call),
    // monitorDetachedSubmission reaps detachedRunning and settles entry.busy back to false!
    currentSubStatus = 'unanswered';
    const reapDeadline = Date.now() + 2000;
    while (entry.busy && Date.now() < reapDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(entry.detachedRunning).toBe(false);
    expect(entry.busy).toBe(false);
    expect(doc.active).toBeNull();
    expect(doc.turns.map((item) => item.requestId)).toEqual(['req-fail']);

    // 3. Observer failure when submission is already not running clears detachedRunning and busy immediately!
    doc.active = { requestId: 'req-fail-2', turnId: 'turn-fail-2', stopped: false };
    entry.busy = true;
    entry.submittedRequest = 'req-fail-2';
    entry.running = lifecycle.wait(entry, failingSubmission).finally(() => {
      entry.running = null;
    });
    await expect(entry.running).rejects.toThrow('storage_io_error');
    expect(entry.detachedRunning).toBe(false);
    expect(entry.busy).toBe(false);
  });

  test('resolveCurrentSession is pure on read fallback and handles directory or missing pointers', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-resolve-live-'));
    const store = createDurableSessionStore({
      sessionRoot: path.join(scratch, 'sessions'),
      workspaceRoot: path.join(scratch, 'workspace'),
      getModels: () => createModels(),
      getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      buildTools: () => [],
      authorizeTurn: async () => ({ open: true, canvasId: 'live-canvas', permissionMode: 'canvas' }),
    });
    try {
      const first = await store.createSession('live-canvas');
      const second = await store.createSession('live-canvas');
      expect(second.sessionId).not.toBe(first.sessionId);
      const pointerPath = path.join(scratch, 'sessions', canvasKey('live-canvas'), 'current.json');

      // 1. Stale pointer pointing to first while second is busy in memory -> live busy wins without 409 session_busy!
      second.busy = true;
      mkdirSync(path.dirname(pointerPath), { recursive: true });
      writeFileSync(pointerPath, JSON.stringify({ sessionId: first.sessionId }));
      const busyActive = await store.resolveCurrentSession('live-canvas');
      expect(busyActive.sessionId).toBe(second.sessionId);
      expect(busyActive.entry).toBe(second);
      const busyPreloaded = await store.resolveCurrentSession('live-canvas', {
        persist: false,
        activateDurable: false,
        preloadedList: [
          { sessionId: first.sessionId, updatedAt: '2026-01-02T00:00:00.000Z' },
          { sessionId: second.sessionId, updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      });
      expect(busyPreloaded.sessionId).toBe(second.sessionId);

      // 2. Missing pointer (ENOENT) while second is idle live owner -> keeps second instead of switching away!
      second.busy = false;
      rmSync(pointerPath, { force: true });
      expect(store.readSafeCurrentPointer('live-canvas')).toBe(second.sessionId);
      const missingPtrResolved = await store.resolveCurrentSession('live-canvas');
      expect(missingPtrResolved.sessionId).toBe(second.sessionId);
      expect(missingPtrResolved.entry).toBe(second);

      // 3. Cold-start (no live owner): corrupt pointer or directory pointer falls back purely without mutating current.json!
      await store.releaseIdleSession('live-canvas');
      rmSync(pointerPath, { force: true });
      mkdirSync(pointerPath, { recursive: true });
      expect(store.readSafeCurrentPointer('live-canvas')).toBe('');
      const pureFallback = await store.resolveCurrentSession('live-canvas', { persist: false, activateDurable: false });
      expect(pureFallback.entry).toBeNull();
      expect([first.sessionId, second.sessionId]).toContain(pureFallback.sessionId);
      expect(store.sessions.has('live-canvas')).toBe(false);

      // 4. Explicit legacy sessionId without handoffLegacy throws session_not_found instead of creating durable session.
      await expect(store.ensureSession('live-canvas', 'legacy-readonly-id')).rejects.toMatchObject({ reason: 'session_not_found' });
    } finally {
      await store.disposeAll();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('submit deduplicates an already-finished requestId without settling a paused active turn, and refreshCanvasBusy settles finished detached turns', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-submit-dedup-'));
    const completedTurns = [];
    const runtime = await ModelRuntime.create({
      authPath: path.join(scratch, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('beeftv', {
      api: 'openai-completions',
      apiKey: 'synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [{
        id: 'synthetic-model',
        name: 'synthetic-model',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const registeredModels = createModels();
    registeredModels.setProvider(runtime.getProvider('beeftv'));
    const store = createDurableSessionStore({
      sessionRoot: path.join(scratch, 'sessions'),
      workspaceRoot: path.join(scratch, 'workspace'),
      getModels: () => registeredModels,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      buildTools: () => [],
      authorizeTurn: async ({ turnId, canvasId }) => ({ open: true, turnId, canvasId, permissionMode: 'canvas' }),
      completeTurn: async ({ turnId }) => { completedTurns.push(turnId); },
      settings: { retry: { maxRetries: 0 } },
    });
    try {
      const entry = await store.createSession('dedup-canvas');
      // Stop req-finished-1 before submit so it records a finished turn in doc.turns with zero model calls!
      await store.cancelRequest('dedup-canvas', entry.sessionId, 'req-finished-1');
      const stoppedSub = await store.submit(entry, {
        requestId: 'req-finished-1',
        turnId: 'turn-finished-1',
        content: [{ type: 'text', text: 'first' }],
        userText: 'first',
      });
      expect(stoppedSub).toBeNull();

      let allowModel = true;
      await store.disposeAll();
      const store2 = createDurableSessionStore({
        sessionRoot: path.join(scratch, 'sessions'),
        workspaceRoot: path.join(scratch, 'workspace'),
        getModels: () => (allowModel ? registeredModels : createModels()),
        getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
        buildTools: () => [],
        authorizeTurn: async ({ turnId, canvasId }) => ({ open: true, turnId, canvasId, permissionMode: 'canvas' }),
        completeTurn: async ({ turnId }) => { completedTurns.push(turnId); },
        settings: { retry: { maxRetries: 0 } },
      });
      try {
        const reopened = await store2.activateSession('dedup-canvas', entry.sessionId);
        // Submit req-paused-2 (loopback port 1 settles unanswered quickly with maxRetries: 0,
        // while doc.active holds req-paused-2 until wait/settle runs!).
        const pausedSub = await store2.submit(reopened, {
          requestId: 'req-paused-2',
          turnId: 'turn-paused-2',
          content: [{ type: 'text', text: 'paused' }],
          userText: 'paused',
        });
        expect(pausedSub).toBeTruthy();
        // Reset local live flags as after a cold restart with paused turn on disk (pinned model now unavailable).
        allowModel = false;
        reopened.submittingRequest = null;
        reopened.submittedRequest = null;
        reopened.busy = false;
        const pausedRead = await store2.recoverForRead(reopened);
        expect(pausedRead.unresumableReason).toBe('model_unavailable_for_resume');

        // Now resend already-finished req-finished-1 with new Go turnId 'turn-dup-1':
        // must return null (finished stopped record), complete ONLY 'turn-dup-1', and keep req-paused-2 active on disk!
        const dupSub = await store2.submit(reopened, {
          requestId: 'req-finished-1',
          turnId: 'turn-dup-1',
          content: [{ type: 'text', text: 'first' }],
          userText: 'first',
        });
        expect(dupSub).toBeNull();
        expect(completedTurns).toContain('turn-dup-1');
        expect(completedTurns).not.toContain('turn-paused-2');
        const histAfterDup = await store2.history('dedup-canvas', reopened.sessionId);
        expect(histAfterDup.active?.requestId).toBe('req-paused-2');

        // Also verify refreshCanvasBusy clears detachedRunning once the official submission is no longer running,
        // unblocking createSession without 409 session_busy!
        const statusDeadline = Date.now() + 5000;
        while ((await pausedSub.status()).status === 'running' && Date.now() < statusDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        reopened.busy = true;
        reopened.detachedRunning = true;
        expect(await store2.refreshCanvasBusy('dedup-canvas')).toBe(false);
        expect(reopened.detachedRunning).toBe(false);
        expect(reopened.busy).toBe(false);
        const createdAfterDetached = await store2.createSession('dedup-canvas');
        expect(createdAfterDetached.sessionId).not.toBe(reopened.sessionId);
      } finally {
        await store2.disposeAll();
      }
    } finally {
      await store.disposeAll();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
