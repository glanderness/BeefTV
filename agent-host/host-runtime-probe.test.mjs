import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newTurnAccumulator } from './canvas-turn.mjs';
import { isSkippableSessionError } from './durable-session-owner.mjs';
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

  test('wait() clears entry.busy when watcher throws while entry.running still holds the outer promise', async () => {
    const doc = {
      active: { requestId: 'req-fail', turnId: 'turn-fail', stopped: false },
      turns: [],
      stopRequests: [],
    };
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
      root: { id: 'root-5', abort: async () => {} },
      harness: { commit: async () => null },
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
      watch: async function* () {
        yield { type: 'snapshot', state: { status: 'running' } };
        throw new Error('storage_io_error');
      },
    };
    entry.running = lifecycle.wait(entry, failingSubmission).finally(() => {
      entry.running = null;
    });
    await expect(entry.running).rejects.toThrow('storage_io_error');
    expect(entry.waiters).toBe(0);
    expect(entry.running).toBeNull();
    expect(entry.busy).toBe(false);
  });
});
