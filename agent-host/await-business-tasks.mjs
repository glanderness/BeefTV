import { BusinessTaskSettled } from './durable-signals.mjs';

const DEFAULT_AWAIT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_PARK_RECONCILE_MS = 2_000;
const DEFAULT_BINDING_RETRY_MS = 1000;

export function isToolPark(value) {
  return Boolean(value && typeof value === 'object' && ('sleep' in value || 'wait' in value));
}

function taskPhase(task) {
  return typeof task?.outcome?.phase === 'string' ? task.outcome.phase.toLowerCase() : '';
}

function isResultStateReady(task) {
  if (typeof task?.resultState !== 'string' || !task.resultState) return true;
  const normalized = task.resultState.toLowerCase();
  return normalized === 'ready' || normalized === 'succeeded';
}

function hasAuthoritativeWaitState(task) {
  return typeof task?.state === 'string' && task.state.length > 0;
}

function isTaskTerminalFailure(task) {
  if (hasAuthoritativeWaitState(task)) {
    return task.state === 'failed' && task.reason !== 'materialization_failed';
  }
  if (task?.status === 'cancelled') return true;
  const phase = taskPhase(task);
  if (phase === 'retrievable' || phase === 'fetching' || phase === 'running') return false;
  return task?.status === 'failed';
}

function isTaskSaved(task) {
  if (hasAuthoritativeWaitState(task)) {
    return task.state === 'completed';
  }
  if (task?.status !== 'succeeded') return false;
  const phase = taskPhase(task);
  if (phase && phase !== 'ready') return false;
  if (!isResultStateReady(task)) return false;
  return Boolean(task.outputs?.length && task.outputs.every((output) => output.resourceId && !output.materializationErrorCode));
}

function isTaskMaterializationFailed(task) {
  if (hasAuthoritativeWaitState(task)) {
    return task.state === 'failed' && task.reason === 'materialization_failed';
  }
  if (task?.status !== 'succeeded') return false;
  const phase = taskPhase(task);
  if (phase === 'failed') return true;
  const resultState = typeof task?.resultState === 'string' ? task.resultState.toLowerCase() : '';
  if (resultState === 'failed_permanent') return true;
  if (resultState === 'failed_retryable') return false;
  if (phase === 'fetching' || phase === 'retrievable') return false;
  return Boolean(
    task.outputs?.length &&
    task.outputs.every((output) => output.resourceId || output.materializationErrorCode) &&
    task.outputs.some((output) => output.materializationErrorCode),
  );
}

function isTaskSettled(task) {
  return Boolean(task && (isTaskTerminalFailure(task) || isTaskSaved(task) || isTaskMaterializationFailed(task)));
}

function normalizeObservedTask(task) {
  if (!task || typeof task !== 'object') return task;
  const id = task.id || task.taskId;
  return id && !task.id ? { ...task, id } : task;
}

function isCanvasBound(canvas, nodeIds, taskIds) {
  const nodes = canvas?.nodes || [];
  return nodeIds.every((id) =>
    nodes.some((n) =>
      n.id === id &&
      taskIds.includes(n.metadata?.taskId) &&
      n.metadata?.status === 'success' &&
      n.metadata?.storageKey?.startsWith('resource:') &&
      !n.metadata?.resourceReloadAvailable &&
      (!n.metadata?.taskOutcome?.phase || n.metadata.taskOutcome.phase === 'ready'),
    ),
  );
}

async function fetchTasksSnapshot(ids, { opsRequest, turnId, signal, preferTaskWait }) {
  let tasks;
  let waitResult = null;
  let nextPreferTaskWait = preferTaskWait;

  if (nextPreferTaskWait) {
    try {
      const response = await opsRequest('POST', '/ops/task.wait', { params: { taskIds: ids, timeoutMs: 0 } }, signal, turnId);
      if (!Array.isArray(response?.result?.tasks) || response.result.observationFailed) {
        throw new Error('task_observation_unavailable');
      }
      waitResult = response.result;
      tasks = response.result.tasks.map(normalizeObservedTask);
    } catch (waitErr) {
      if (signal?.aborted) throw waitErr;
      if (waitErr?.reason === 'unknown_operation' || waitErr?.reason === 'scope_denied') {
        nextPreferTaskWait = false;
      } else {
        throw waitErr;
      }
    }
  }

  if (!tasks) {
    tasks = await Promise.all(ids.map(async (taskId) => {
      const response = await opsRequest('POST', '/ops/task.get', { params: { taskId } }, signal, turnId);
      if (!response?.result || typeof response.result !== 'object') throw new Error('task_observation_unavailable');
      return normalizeObservedTask({ id: taskId, ...response.result });
    }));
  }

  return { tasks, waitResult, preferTaskWait: nextPreferTaskWait };
}

export function evaluateTaskBatch(ids, tasks, observedById, waitResult, { rendering = false, nodeIds } = {}) {
  const currentById = new Map();
  for (const task of tasks) {
    if (task?.id) {
      currentById.set(task.id, task);
      observedById.set(task.id, task);
    }
  }
  const completeSnapshot = !waitResult?.cancelled && tasks.length === ids.length && ids.every((id) => currentById.has(id));
  const progressTasks = completeSnapshot ? ids.map((id) => currentById.get(id)) : [...observedById.values()];
  const saved = progressTasks.filter(isTaskSaved).length;
  const failed = completeSnapshot ? progressTasks.find(isTaskTerminalFailure) : undefined;
  const settled = completeSnapshot && progressTasks.every(isTaskSettled);
  const ready = completeSnapshot && progressTasks.every(isTaskSaved);
  const downloading = progressTasks.some((task) =>
    task?.state === 'downloading' ||
    task?.delivery?.outputs?.some((output) => ['downloading', 'retrying', 'waiting'].includes(output.state)) ||
    (task?.status === 'failed' && taskPhase(task) === 'retrievable'));
  const saving = progressTasks.some((task) =>
    task?.state === 'saving' ||
    (task?.status === 'succeeded' && !isTaskSaved(task) && !isTaskMaterializationFailed(task)));
  const stage = ready
    ? (nodeIds?.length ? 'binding' : 'saved')
    : downloading
      ? 'downloading'
      : saving
        ? 'saving'
        : rendering
          ? 'rendering'
          : 'processing';
  const pendingIds = ids.filter((id) => !isTaskSettled(currentById.get(id) || observedById.get(id)));
  return {
    progressTasks,
    saved,
    failed,
    settled,
    ready,
    stage,
    pendingIds: pendingIds.length > 0 ? pendingIds : [...ids],
  };
}

async function registerTaskWaitIdempotently(ids, { durableApi, durableContext, opsRequest, turnId, signal, canvasId, sessionId, now }) {
  const memoKey = `beeftv.task_wait:${ids.join(',')}`;
  const existing = await durableApi.memo(memoKey, durableContext);
  if (existing !== undefined) return Boolean(existing?.registered);
  const registration = {
    canvasId: String(canvasId || ''),
    sessionId: String(sessionId || ''),
    durableTaskId: durableApi.taskId,
    signal: BusinessTaskSettled.name,
    taskIds: ids,
  };
  try {
    const response = await opsRequest('POST', '/assistant/runtime/task-waits', registration, signal, turnId);
    const isRegistered = response?.registered !== false;
    const saved = await durableApi.memo(memoKey, { registered: isRegistered, taskIds: ids, registeredAt: now }, durableContext);
    return Boolean(saved?.registered);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (['http_404', 'not_found', 'unknown_operation'].includes(error?.reason)) {
      await durableApi.memo(memoKey, { registered: false, unsupported: true }, durableContext);
    }
    return false;
  }
}

async function buildSleepSignals(pendingIds, consumedSet, durableApi, durableContext) {
  const sleepSignals = [];
  for (const id of pendingIds) {
    // 严格遵守 Pi signals.js checkSleep 契约：
    // - 已消费（consumedSet）或已过期（expired）的 key 绝不再入 sleep.signals，避免 invalid_park；
    // - 若信号在停泊前已投递（state && 'value' in state 且未消费），仍应纳入 sleep.signals，让 Pi 立即唤醒消费，绝不吞掉。
    if (consumedSet.has(id)) continue;
    const state = await durableApi.readSignal(BusinessTaskSettled, id, durableContext);
    if (state && 'expired' in state) continue;
    sleepSignals.push(BusinessTaskSettled.key(id));
  }
  return sleepSignals;
}

export async function cancelBusinessTaskWait(checkpoint, { opsRequest, turnId, canvasId, sessionId, signal } = {}) {
  const wait = checkpoint?.businessTaskWait;
  if (!wait || typeof opsRequest !== 'function') return;
  try {
    await opsRequest('POST', '/assistant/runtime/task-waits/cancel', {
      canvasId: String(canvasId || wait.canvasId || ''),
      sessionId: String(sessionId || wait.sessionId || ''),
      durableTaskId: wait.durableTaskId,
      taskIds: wait.ids || [],
    }, signal, turnId);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
}

// Pi 1.6.0 原生 Durable ToolPark 业务任务等待：
// 单次观察后交出执行槽进入 sleeping，由 Go POST /signals 实时唤醒（不提前在 30s 过期信号键）；
// 仅当 Go 等待登记不可用时退回纯定时器 until 轮询（不挂 signals），每次非停泊退出均显式取消 Go 等待订阅。
export async function awaitBusinessTasks(data, {
  opsRequest,
  turnId,
  signal,
  canvasId,
  sessionId = '',
  rendering = false,
  onProgress,
  useTaskWait = false,
  maxIdleWaitMs = DEFAULT_AWAIT_IDLE_TIMEOUT_MS,
  reconcileIntervalMs = DEFAULT_PARK_RECONCILE_MS,
  bindingRetryMs = DEFAULT_BINDING_RETRY_MS,
  durableApi = null,
  durableContext = null,
}) {
  const result = data?.result;
  const ids = result?.taskIds || (result?.taskId ? [result.taskId] : []);
  if (!ids.length) return data;
  if (!durableApi || !durableContext) {
    throw new Error('durable_tool_park_required: awaitBusinessTasks 需要 Durable ToolPark 上下文');
  }

  const now = durableApi.now();
  const prev = durableApi.checkpoint?.businessTaskWait || null;
  let deadline = Number.isFinite(prev?.deadline) ? prev.deadline : now + maxIdleWaitMs;
  let lastSavedCount = Number.isFinite(prev?.lastSavedCount) ? prev.lastSavedCount : 0;
  let preferTaskWait = prev?.preferTaskWait !== undefined ? Boolean(prev.preferTaskWait) : Boolean(useTaskWait);
  let previousProgress = typeof prev?.lastProgressKey === 'string' ? prev.lastProgressKey : '';
  let registered = Boolean(prev?.registered);
  const observedById = new Map(Object.entries(prev?.observedById || {}));
  const consumedSet = new Set(Array.isArray(prev?.consumedSignalKeys) ? prev.consumedSignalKeys : []);
  if (durableApi.wake?.reason === 'signal' && typeof durableApi.wake?.key === 'string' && durableApi.wake.key) {
    consumedSet.add(durableApi.wake.key);
  }
  const resolvedCanvasId = canvasId || prev?.canvasId || result?.canvasId || '';
  const resolvedSessionId = sessionId || prev?.sessionId || '';

  const emitProgress = async (stage, saved = 0, extra = {}) => {
    const value = { stage, saved, total: ids.length, ...extra };
    const serialized = JSON.stringify(value);
    if (serialized === previousProgress) return;
    await onProgress?.(value);
    previousProgress = serialized;
  };

  const cleanupRegistration = async () => {
    if (!registered) return;
    registered = false;
    await cancelBusinessTaskWait({
      businessTaskWait: {
        canvasId: resolvedCanvasId,
        sessionId: resolvedSessionId,
        durableTaskId: durableApi.taskId,
        ids,
      },
    }, {
      opsRequest,
      turnId,
      canvasId: resolvedCanvasId,
      sessionId: resolvedSessionId,
      signal,
    }).catch(() => {});
  };

  try {
    signal?.throwIfAborted();
    const fetched = await fetchTasksSnapshot(ids, {
      opsRequest,
      turnId,
      signal,
      preferTaskWait,
    });
    preferTaskWait = fetched.preferTaskWait;

    const evaluated = evaluateTaskBatch(ids, fetched.tasks, observedById, fetched.waitResult, {
      rendering,
      nodeIds: result.nodeIds,
    });
    if (evaluated.saved > lastSavedCount) {
      lastSavedCount = evaluated.saved;
      deadline = now + maxIdleWaitMs;
    }
    if (evaluated.failed && evaluated.settled) {
      await cleanupRegistration();
      return {
        ...data,
        result: {
          ...result,
          status: evaluated.failed.status,
          tasks: evaluated.progressTasks,
          taskError: evaluated.failed.error || '素材任务未成功，保留原任务，不重复生成',
        },
      };
    }
    if (evaluated.settled && !evaluated.ready) {
      await cleanupRegistration();
      return {
        ...data,
        result: {
          ...result,
          status: 'incomplete',
          tasks: evaluated.progressTasks,
          materializationFailed: true,
          note: '生成结果尚未保存成功；保留原任务，只恢复原结果的保存，不能重新生成。',
        },
      };
    }

    if (evaluated.ready) {
      await cleanupRegistration();
      let boundRevision;
      if (result.nodeIds?.length) {
        const response = await opsRequest('POST', '/ops/canvas.get', { params: { canvasId: resolvedCanvasId } }, signal, turnId);
        const canvas = response?.result?.canvas;
        if (!canvas || typeof canvas !== 'object') throw new Error('canvas_observation_unavailable');
        if (!isCanvasBound(canvas, result.nodeIds, ids)) {
          if (now >= deadline) {
            return { ...data, result: { ...result, status: 'pending', note: '原任务仍在处理中，保留任务ID；请查询原任务，不能重复提交' } };
          }
          await emitProgress('binding', evaluated.saved, { parked: true, taskIds: ids });
          const nextUntil = Math.min(deadline, Math.max(now + 1, now + bindingRetryMs));
          return {
            sleep: {
              until: nextUntil,
              checkpoint: {
                businessTaskWait: {
                  submittedData: data,
                  ids,
                  pendingIds: ids,
                  canvasId: resolvedCanvasId,
                  sessionId: resolvedSessionId,
                  durableTaskId: durableApi.taskId,
                  deadline,
                  until: nextUntil,
                  lastSavedCount,
                  preferTaskWait,
                  registered: false,
                  waitingForBinding: true,
                  consumedSignalKeys: [...consumedSet],
                  lastProgressKey: previousProgress,
                  observedById: Object.fromEntries(observedById.entries()),
                },
              },
            },
          };
        }
        if (Number.isSafeInteger(canvas.revision) && canvas.revision > 0) boundRevision = canvas.revision;
      }
      await emitProgress(result.nodeIds?.length ? 'binding' : 'saved', evaluated.saved);
      const revision = boundRevision === undefined ? {} : { revision: boundRevision };
      return { ...data, ...revision, result: { ...result, ...revision, status: 'succeeded', tasks: evaluated.progressTasks } };
    }

    if (now >= deadline) {
      await cleanupRegistration();
      return { ...data, result: { ...result, status: 'pending', note: '原任务仍在处理中，保留任务ID；请查询原任务，不能重复提交' } };
    }

    await emitProgress(evaluated.stage, evaluated.saved, { parked: true, taskIds: evaluated.pendingIds });
    registered = await registerTaskWaitIdempotently(ids, {
      durableApi,
      durableContext,
      opsRequest,
      turnId,
      signal,
      canvasId: resolvedCanvasId,
      sessionId: resolvedSessionId,
      now,
    });
    const sleepSignals = registered
      ? await buildSleepSignals(evaluated.pendingIds, consumedSet, durableApi, durableContext)
      : [];
    // 已登记 Go 信号订阅且有可用信号键时，until 设为整段 deadline（避免在 30s 处触发 sleepWake 将信号键永久标为 expired）；
    // 仅在未登记或无可用信号键时退回纯定时器轮询（不附带 signals）。
    const useSignals = registered && sleepSignals.length > 0;
    const nextUntil = useSignals
      ? Math.max(now + 1, deadline)
      : Math.min(deadline, Math.max(now + 1, now + reconcileIntervalMs));
    return {
      sleep: {
        ...(useSignals ? { signals: sleepSignals } : {}),
        until: nextUntil,
        checkpoint: {
          businessTaskWait: {
            submittedData: data,
            ids,
            pendingIds: evaluated.pendingIds,
            canvasId: resolvedCanvasId,
            sessionId: resolvedSessionId,
            durableTaskId: durableApi.taskId,
            deadline,
            until: nextUntil,
            lastSavedCount,
            preferTaskWait,
            registered,
            waitingForBinding: false,
            consumedSignalKeys: [...consumedSet],
            lastProgressKey: previousProgress,
            observedById: Object.fromEntries(observedById.entries()),
          },
        },
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    await cleanupRegistration();
    try { await emitProgress('observation_unavailable'); }
    catch { signal?.throwIfAborted(); }
    return { ...data, result: { ...result, status: 'pending', observationFailed: true, note: '原任务已受理，暂时无法读取进度；请按返回的任务ID查询，不要重新提交' } };
  }
}
