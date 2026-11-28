import { test, expect } from 'bun:test';
import { awaitBusinessTasks, isToolPark } from './await-business-tasks.mjs';

// 模拟 Pi 1.6.0 ToolPark + signals.js（checkSleep / sleepWake / readSignal / memo）状态机，
// 直接驱动 awaitBusinessTasks 的真实停泊、唤醒、信号消费与取消路径。
function createParkDriver({ now = 1000, taskId = 42 } = {}) {
  let clock = now;
  const memos = new Map();
  const signalMemos = new Map(); // key -> { value, consumed?, expired? }
  let checkpoint = undefined;
  let wake = undefined;

  const api = {
    taskId,
    now: () => clock,
    get checkpoint() { return checkpoint; },
    get wake() { return wake; },
    async memo(key, valueOrCtx) {
      if (arguments.length >= 3) {
        if (!memos.has(key)) memos.set(key, structuredClone(valueOrCtx));
        return structuredClone(memos.get(key));
      }
      return memos.has(key) ? structuredClone(memos.get(key)) : undefined;
    },
    async readSignal(_token, key) {
      const entry = signalMemos.get(key);
      if (!entry) return undefined;
      if (entry.expired) return { expired: true };
      return { value: structuredClone(entry.value) };
    },
  };

  function deliverSignal(key, value = { status: 'succeeded' }) {
    if (!signalMemos.has(key)) signalMemos.set(key, { value });
  }

  function stepSleep(park) {
    const sleep = park.sleep;
    if (sleep.until === undefined && (!sleep.signals || sleep.signals.length === 0)) {
      throw new Error('invalid_park: empty sleep');
    }
    for (const s of sleep.signals || []) {
      const stored = signalMemos.get(s.key);
      if (stored?.expired) throw new Error(`invalid_park: expired key ${s.key}`);
      if (stored?.consumed) throw new Error(`invalid_park: consumed key ${s.key}`);
    }
    checkpoint = structuredClone(sleep.checkpoint);
    // 1. Check immediate / pre-park signal wakeup first (exact signals.js sleepWake order)
    for (const s of sleep.signals || []) {
      const stored = signalMemos.get(s.key);
      if (stored && !stored.expired && !stored.consumed) {
        stored.consumed = true;
        wake = { reason: 'signal', signal: s.signal, key: s.key };
        return wake;
      }
    }
    // 2. Advance virtual clock to sleep.until
    clock = Math.max(clock, sleep.until);
    if (!sleep.signals || sleep.signals.length === 0) {
      wake = { reason: 'time' };
      return wake;
    }
    for (const s of sleep.signals) {
      if (!signalMemos.has(s.key)) signalMemos.set(s.key, { expired: true });
    }
    wake = { reason: 'expired' };
    return wake;
  }

  return {
    api,
    context: {},
    deliverSignal,
    stepSleep,
    get clock() { return clock; },
    setClock(v) { clock = v; },
    get signalMemos() { return signalMemos; },
  };
}

async function runParked(data, opts, { driver = createParkDriver(), onPark = null, maxSteps = 20 } = {}) {
  const parks = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const out = await awaitBusinessTasks(data, {
      reconcileIntervalMs: 100,
      bindingRetryMs: 50,
      durableApi: driver.api,
      durableContext: driver.context,
      ...opts,
    });
    if (!isToolPark(out)) return { result: out, parks, driver };
    parks.push(out);
    if (onPark) await onPark(out, driver, parks.length);
    driver.stepSleep(out);
  }
  throw new Error('exceeded maxSteps while driving parked tool');
}

const unsupportedWaitOps = (handler) => async (method, path, body, signal, turnId) => {
  if (path === '/assistant/runtime/task-waits') {
    const err = new Error('not_found');
    err.reason = 'not_found';
    throw err;
  }
  return handler(method, path, body, signal, turnId);
};

test('generation wait observes original tasks through materialization and canvas binding without resubmitting', async () => {
  let reads = 0, bindings = 0;
  const paths = [];
  const data = { revision: 2, result: { revision: 2, canvasId: 'canvas', taskIds: ['accepted-task'], nodeIds: ['shot'], status: 'submitted' } };
  const { result, parks } = await runParked(data, {
    canvasId: 'canvas',
    turnId: 'turn',
    opsRequest: unsupportedWaitOps(async (_method, path, body) => {
      paths.push(path);
      if (path === '/ops/task.get') {
        expect(body.params.taskId).toBe('accepted-task');
        reads++;
        return { result: reads === 1 ? { status: 'succeeded', outputs: [] } : { status: 'succeeded', outputs: [{ resourceId: 'saved-media' }] } };
      }
      bindings++;
      return { result: { canvas: { revision: bindings + 2, nodes: bindings === 1 ? [] : [{ id: 'shot', metadata: { taskId: 'accepted-task', status: 'success', storageKey: 'resource:saved-media' } }] } } };
    }),
  });
  expect(result.result.status).toBe('succeeded');
  expect(reads).toBe(3);
  expect(bindings).toBe(2);
  expect(parks.length).toBe(2);
  expect(result.revision).toBe(4);
  expect(result.result.revision).toBe(4);
  expect(data.revision).toBe(2);
  expect(data.result.revision).toBe(2);
  expect(paths.every((path) => ['/ops/task.get', '/ops/canvas.get'].includes(path))).toBe(true);
});

test('failed accepted task is returned with its original identity and no retry', async () => {
  let calls = 0;
  const { result } = await runParked({ result: { taskIds: ['original'] } }, {
    opsRequest: unsupportedWaitOps(async () => { calls++; return { result: { taskId: 'original', status: 'failed', outputs: [] } }; }),
  });
  expect(calls).toBe(1);
  expect(result.result.status).toBe('failed');
  expect(result.result.taskIds).toEqual(['original']);
});

test('stop aborts the waiting observer without purchasing a replacement', async () => {
  const controller = new AbortController();
  let calls = 0;
  const driver = createParkDriver();
  const promise = awaitBusinessTasks({ result: { taskIds: ['original'] } }, {
    signal: controller.signal,
    durableApi: driver.api,
    durableContext: driver.context,
    opsRequest: unsupportedWaitOps(async () => { calls++; controller.abort(); return { result: { status: 'running' } }; }),
  });
  await expect(promise).rejects.toThrow();
  expect(calls).toBe(1);
});

test('a failed sibling waits for admitted successful files and emits only changing progress', async () => {
  let reads = 0;
  const progress = [];
  const { result } = await runParked({ result: { taskIds: ['failed', 'saving'] } }, {
    onProgress: async (value) => progress.push(value),
    opsRequest: unsupportedWaitOps(async (_method, path, body) => {
      expect(path).toBe('/ops/task.get');
      if (body.params.taskId === 'failed') return { result: { status: 'failed' } };
      return { result: { status: 'succeeded', outputs: ++reads < 3 ? [] : [{ resourceId: 'original-saved' }] } };
    }),
  });
  expect(reads).toBe(3);
  expect(result.result.status).toBe('failed');
  expect(result.result.taskIds).toEqual(['failed', 'saving']);
  expect(progress).toEqual([{ stage: 'saving', saved: 0, total: 2, parked: true, taskIds: ['saving'] }]);
});

test('a recorded save failure returns the original task immediately without polling or generation', async () => {
  let calls = 0;
  const { result } = await runParked({ result: { taskIds: ['original'] } }, {
    opsRequest: unsupportedWaitOps(async () => {
      calls++;
      return { result: { status: 'succeeded', outputs: [{ materializationErrorCode: 'download_failed' }] } };
    }),
  });
  expect(calls).toBe(1);
  expect(result.result.taskIds).toEqual(['original']);
  expect(result.result.status).toBe('incomplete');
  expect(result.result.materializationFailed).toBe(true);
});

test('FAILED_RETRYABLE keeps waiting as saving instead of returning incomplete early', async () => {
  const states = [
    { status: 'succeeded', resultState: 'FAILED_RETRYABLE', outputs: [{ materializationErrorCode: 'transient_cdn_502' }] },
    { status: 'succeeded', resultState: 'READY', outputs: [{ resourceId: 'recovered-res' }] },
  ];
  const stages = [];
  const { result, parks } = await runParked({ result: { taskIds: ['retryable'] } }, {
    onProgress: async (value) => stages.push(value.stage),
    opsRequest: unsupportedWaitOps(async () => ({ result: states.shift() })),
  });
  expect(parks.length).toBe(1);
  expect(result.result.status).toBe('succeeded');
  expect(result.result.materializationFailed).toBeUndefined();
  expect(stages).toEqual(['saving', 'saved']);
});

test('transfer, saving and saved progress follow canonical original task state', async () => {
  const states = [
    { status: 'succeeded', outputs: [], delivery: { outputs: [{ state: 'retrying' }] } },
    { status: 'succeeded', outputs: [{ outputIndex: 0 }] },
    { status: 'succeeded', outputs: [{ resourceId: 'original-resource' }] },
  ];
  const progress = [];
  const { result } = await runParked({ result: { taskIds: ['original'] } }, {
    onProgress: async (value) => progress.push(value.stage),
    opsRequest: unsupportedWaitOps(async (_method, path, body) => {
      expect(path).toBe('/ops/task.get');
      expect(body.params.taskId).toBe('original');
      return { result: states.shift() };
    }),
  });
  expect(result.result.status).toBe('succeeded');
  expect(progress).toEqual(['downloading', 'saving', 'saved']);
});

test('a failed progress commit still returns the admitted task identity', async () => {
  let calls = 0;
  const { result } = await runParked({ result: { taskIds: ['original'] } }, {
    onProgress: async () => { throw new Error('fixture progress storage unavailable'); },
    opsRequest: unsupportedWaitOps(async () => { calls++; return { result: { status: 'running' } }; }),
  });
  expect(calls).toBe(1);
  expect(result.result.taskIds).toEqual(['original']);
  expect(result.result.status).toBe('pending');
  expect(result.result.observationFailed).toBe(true);
});

test('retrievable failed task and fetching succeeded task keep waiting until outcome is ready', async () => {
  const states = [
    { taskId: 'original', status: 'failed', outcome: { phase: 'retrievable', reason: 'provider_result_pending' }, outputs: [] },
    { taskId: 'original', status: 'succeeded', resultState: 'PENDING_MATERIALIZATION', outcome: { phase: 'fetching', reason: 'result_fetching' }, outputs: [{ resourceId: 'original-resource' }] },
    { taskId: 'original', status: 'succeeded', resultState: 'READY', outcome: { phase: 'ready', reason: 'result_ready' }, outputs: [{ resourceId: 'original-resource' }] },
  ];
  const progress = [];
  const { result } = await runParked({ result: { taskIds: ['original'] } }, {
    onProgress: async (value) => progress.push(value.stage),
    opsRequest: unsupportedWaitOps(async (_method, path, body) => {
      expect(path).toBe('/ops/task.get');
      expect(body.params.taskId).toBe('original');
      return { result: states.shift() };
    }),
  });
  expect(result.result.status).toBe('succeeded');
  expect(progress).toEqual(['downloading', 'saving', 'saved']);
});

test('transient task observation error reports observation_unavailable without fabricating terminal failure', async () => {
  const progress = [];
  const { result } = await runParked({ result: { taskIds: ['original'] } }, {
    onProgress: async (value) => progress.push(value.stage),
    opsRequest: unsupportedWaitOps(async () => { throw new Error('temporary sqlite busy'); }),
  });
  expect(result.result.taskIds).toEqual(['original']);
  expect(result.result.status).toBe('pending');
  expect(result.result.observationFailed).toBe(true);
  expect(progress).toEqual(['observation_unavailable']);
});

test('useTaskWait batches multiple tasks into server-side task.wait requests', async () => {
  const calls = [];
  const progress = [];
  const responses = [
    {
      result: {
        pending: true,
        timedOut: true,
        tasks: [
          { taskId: 't1', status: 'succeeded', state: 'completed', outputs: [{ resourceId: 'r1' }] },
          { taskId: 't2', status: 'running', state: 'running', outputs: [] },
        ],
      },
    },
    {
      result: {
        pending: false,
        completed: true,
        tasks: [
          { taskId: 't1', status: 'succeeded', state: 'completed', outputs: [{ resourceId: 'r1' }] },
          { taskId: 't2', status: 'succeeded', state: 'completed', outputs: [{ resourceId: 'r2' }] },
        ],
      },
    },
  ];
  const { result } = await runParked({ result: { taskIds: ['t1', 't2'] } }, {
    useTaskWait: true,
    onProgress: async (value) => progress.push(value),
    opsRequest: unsupportedWaitOps(async (_method, path, body) => {
      calls.push({ path, params: body.params });
      return responses.shift();
    }),
  });
  expect(calls.every((item) => item.path === '/ops/task.wait')).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0].params.taskIds).toEqual(['t1', 't2']);
  expect(result.result.status).toBe('succeeded');
  expect(result.result.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  expect(progress).toEqual([
    { stage: 'processing', saved: 1, total: 2, parked: true, taskIds: ['t2'] },
    { stage: 'saved', saved: 2, total: 2 },
  ]);
});

test('useTaskWait falls back cleanly to task.get if backend rejects task.wait', async () => {
  const paths = [];
  const { result } = await runParked({ result: { taskIds: ['t1'] } }, {
    useTaskWait: true,
    opsRequest: unsupportedWaitOps(async (_method, path) => {
      paths.push(path);
      if (path === '/ops/task.wait') {
        const err = new Error('unknown_operation: 未知操作');
        err.reason = 'unknown_operation';
        throw err;
      }
      return { result: { id: 't1', status: 'succeeded', outputs: [{ resourceId: 'r1' }] } };
    }),
  });
  expect(paths).toEqual(['/ops/task.wait', '/ops/task.get']);
  expect(result.result.status).toBe('succeeded');
});

test('useTaskWait ignores partial or cancelled task.wait batches until every task is observed', async () => {
  let calls = 0;
  const responses = [
    { result: { pending: true, timedOut: true, tasks: [{ taskId: 't1', status: 'failed', state: 'failed', error: 'quota' }] } },
    { result: { pending: true, cancelled: true, tasks: [] } },
    { result: { pending: true, timedOut: true, tasks: [{ taskId: 't1', status: 'failed', state: 'failed', error: 'quota' }, { taskId: 't2', status: 'running', state: 'running' }] } },
    { result: { pending: false, completed: false, failed: true, tasks: [{ taskId: 't1', status: 'failed', state: 'failed', error: 'quota' }, { taskId: 't2', status: 'succeeded', state: 'completed' }] } },
  ];
  const { result } = await runParked({ result: { taskIds: ['t1', 't2'] } }, {
    useTaskWait: true,
    opsRequest: unsupportedWaitOps(async (_method, path) => {
      expect(path).toBe('/ops/task.wait');
      calls += 1;
      return responses.shift();
    }),
  });
  expect(calls).toBe(4);
  expect(result.result.status).toBe('failed');
  expect(result.result.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
});

test('registered signal wait keeps until=deadline (never expires keys at 30s) and wakes immediately on pre-park signal', async () => {
  const driver = createParkDriver({ now: 1000, taskId: 88 });
  let settled = false;
  const cancels = [];
  const { result, parks } = await runParked({ result: { taskIds: ['prepark-1'] } }, {
    canvasId: 'c1',
    sessionId: 'durable:s1',
    maxIdleWaitMs: 600_000,
    reconcileIntervalMs: 30_000,
    opsRequest: async (_method, path, body) => {
      if (path === '/assistant/runtime/task-waits') {
        // Task settles AND Go delivers signal BEFORE awaitBusinessTasks even returns { sleep }!
        settled = true;
        driver.deliverSignal('prepark-1', { taskId: 'prepark-1', status: 'succeeded', state: 'completed' });
        return { registered: true };
      }
      if (path === '/assistant/runtime/task-waits/cancel') {
        cancels.push(body);
        return { cancelled: true };
      }
      return { result: settled ? { status: 'succeeded', outputs: [{ resourceId: 'res-prepark' }] } : { status: 'running' } };
    },
  }, { driver });

  // First park keeps until === deadline (601_000, NOT 31_000!) and includes prepark-1 in sleep.signals -> wakes immediately without advancing clock!
  expect(parks.length).toBe(1);
  expect(parks[0].sleep.until).toBe(601_000);
  expect(parks[0].sleep.signals.map((s) => s.key)).toEqual(['prepark-1']);
  expect(driver.clock).toBe(1000);
  expect(result.result.status).toBe('succeeded');
  expect(cancels.length).toBe(1);
  expect(cancels[0].durableTaskId).toBe(88);
});

test('short-deadline non-park exit cancels Go wait subscription and stops polling', async () => {
  const driver = createParkDriver({ now: 1000, taskId: 91 });
  const cancels = [];
  let regs = 0;
  const { result, parks } = await runParked({ result: { taskIds: ['slow-1'] } }, {
    canvasId: 'c1',
    sessionId: 'durable:s1',
    maxIdleWaitMs: 500,
    reconcileIntervalMs: 30_000,
    opsRequest: async (_method, path, body) => {
      if (path === '/assistant/runtime/task-waits') { regs += 1; return { registered: true }; }
      if (path === '/assistant/runtime/task-waits/cancel') { cancels.push(body); return { cancelled: true }; }
      return { result: { status: 'running' } };
    },
  }, { driver });

  expect(regs).toBe(1);
  expect(parks.length).toBe(1);
  expect(parks[0].sleep.until).toBe(1500);
  expect(result.result.status).toBe('pending');
  expect(cancels.length).toBe(1);
  expect(cancels[0]).toEqual({ canvasId: 'c1', sessionId: 'durable:s1', durableTaskId: 91, taskIds: ['slow-1'] });
});

test('registered=false from Go falls back to short timer-only ToolPark without signals or duplicate registrations', async () => {
  const driver = createParkDriver({ now: 1000, taskId: 92 });
  let regs = 0;
  let cancels = 0;
  let polls = 0;
  const { result, parks } = await runParked({ result: { taskIds: ['no-endpoint-1'] } }, {
    canvasId: 'c1',
    sessionId: 'durable:s1',
    maxIdleWaitMs: 600_000,
    reconcileIntervalMs: undefined,
    opsRequest: async (_method, path) => {
      if (path === '/assistant/runtime/task-waits') {
        regs += 1;
        return { registered: false, reason: 'signal_endpoint_unavailable' };
      }
      if (path === '/assistant/runtime/task-waits/cancel') {
        cancels += 1;
        return { cancelled: true };
      }
      polls += 1;
      return { result: polls >= 3 ? { status: 'succeeded', outputs: [{ resourceId: 'res-no-ep' }] } : { status: 'running' } };
    },
  }, { driver });

  expect(regs).toBe(1);
  expect(cancels).toBe(0);
  expect(parks.length).toBe(2);
  expect(parks[0].sleep.signals).toBeUndefined();
  expect(parks[0].sleep.until).toBe(3000);
  expect(parks[1].sleep.signals).toBeUndefined();
  expect(parks[1].sleep.until).toBe(5000);
  expect(result.result.status).toBe('succeeded');
});
