import { setTimeout as delay } from 'node:timers/promises';
import { BusinessTaskSettled } from './durable-signals.mjs';

const DEFAULT_AWAIT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TASK_WAIT_SLICE_MS = 5000;
const DEFAULT_PARK_RECONCILE_MS = 30_000;
const DEFAULT_BINDING_RETRY_MS = 1000;

export function isToolPark(value) {
  return Boolean(value && typeof value === 'object' && ('sleep' in value || 'wait' in value));
}

function taskPhase(task) {
  return typeof task?.outcome?.phase === 'string' ? task.outcome.phase : '';
}

function isResultStateReady(task) {
  if (typeof task?.resultState !== 'string' || !task.resultState) return true;
  const normalized = task.resultState.toLowerCase();
  return normalized === 'ready' || normalized === 'succeeded';
}

function isTaskTerminalFailure(task) {
  if (task?.state === 'failed') return task?.reason !== 'materialization_failed';
  if (task?.status === 'cancelled') return true;
  const phase = taskPhase(task);
  if (phase === 'retrievable' || phase === 'fetching' || phase === 'running') return false;
  return task?.status === 'failed';
}

function isTaskSaved(task) {
  if (task?.state === 'completed') return true;
  if (task?.status !== 'succeeded') return false;
  const phase = taskPhase(task);
  if (phase && phase !== 'ready') return false;
  if (!isResultStateReady(task)) return false;
  return Boolean(task.outputs?.length && task.outputs.every((output) => output.resourceId && !output.materializationErrorCode));
}

function isTaskMaterializationFailed(task) {
  if (task?.state === 'failed' && task?.reason === 'materialization_failed') return true;
  if (task?.status !== 'succeeded') return false;
  const phase = taskPhase(task);
  if (phase === 'failed') return true;
  if (typeof task?.resultState === 'string' && task.resultState.toLowerCase() === 'failed_permanent') return true;
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

async function fetchTasksSnapshot(ids, { opsRequest, turnId, signal, preferTaskWait, timeoutMs }) {
  let tasks;
  let waitResult = null;
  let waitedOnServer = false;
  let nextPreferTaskWait = preferTaskWait;

  if (nextPreferTaskWait) {
    try {
      const response = await opsRequest('POST', '/ops/task.wait', { params: { taskIds: ids, timeoutMs } }, signal, turnId);
      if (!Array.isArray(response?.result?.tasks) || response.result.observationFailed) {
        throw new Error('task_observation_unavailable');
      }
      waitResult = response.result;
      tasks = response.result.tasks.map(normalizeObservedTask);
      waitedOnServer = true;
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

  return { tasks, waitResult, waitedOnServer, preferTaskWait: nextPreferTaskWait };
}

function evaluateTaskBatch(ids, tasks, observedById, waitResult, { rendering, nodeIds }) {
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
    await opsRequest('POST', '/assistant/runtime/task-waits', registration, signal, turnId);
    const saved = await durableApi.memo(memoKey, { registered: true, taskIds: ids, registeredAt: now }, durableContext);
    return Boolean(saved?.registered);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (['http_404', 'not_found', 'unknown_operation'].includes(error?.reason)) {
      await durableApi.memo(memoKey, { registered: false, unsupported: true }, durableContext);
    }
    return false;
  }
}

async function buildSleepSignals(pendingIds, durableApi, durableContext) {
  const sleepSignals = [];
  for (const id of pendingIds) {
    // 严格遵守 Pi signals.js checkSleep 契约：已过期（expired）或已投递/已消费的 key 绝不再入 sleep.signals，
    // 避免触发 invalid_park。
    const state = await durableApi.readSignal(BusinessTaskSettled, id, durableContext);
    if (state === undefined) {
      sleepSignals.push(BusinessTaskSettled.key(id));
    }
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

// Durable ToolPark 等待实现：无阻塞轮询循环，检查一次后即交出执行槽进入 sleeping，
// 由 Go POST /signals 实时唤醒，until 作为兜底对账定时器，并支持 cancel() 清理订阅。
async function awaitBusinessTasksParked(data, {
  opsRequest,
  turnId,
  signal,
  canvasId,
  sessionId,
  rendering,
  onProgress,
  useTaskWait,
  maxIdleWaitMs,
  reconcileIntervalMs,
  bindingRetryMs,
  durableApi,
  durableContext,
}) {
  const result = data?.result;
  const ids = result?.taskIds || (result?.taskId ? [result.taskId] : []);
  if (!ids.length) return data;

  const now = durableApi.now();
  const prev = durableApi.checkpoint?.businessTaskWait || null;
  let deadline = Number.isFinite(prev?.deadline) ? prev.deadline : now + maxIdleWaitMs;
  let lastSavedCount = Number.isFinite(prev?.lastSavedCount) ? prev.lastSavedCount : 0;
  let preferTaskWait = prev?.preferTaskWait !== undefined ? Boolean(prev.preferTaskWait) : Boolean(useTaskWait);
  let previousProgress = typeof prev?.lastProgressKey === 'string' ? prev.lastProgressKey : '';
  const observedById = new Map(Object.entries(prev?.observedById || {}));
  const resolvedCanvasId = canvasId || prev?.canvasId || result?.canvasId || '';
  const resolvedSessionId = sessionId || prev?.sessionId || '';

  const emitProgress = async (stage, saved = 0, extra = {}) => {
    const value = { stage, saved, total: ids.length, ...extra };
    const serialized = JSON.stringify(value);
    if (serialized === previousProgress) return;
    await onProgress?.(value);
    previousProgress = serialized;
  };

  // 读取本任务上每个待等业务任务的信号状态（既用于消费结果，也用于过滤过期/已消费 key 防 invalid_park）。
  let anySignalDelivered = false;
  for (const id of ids) {
    const sigState = await durableApi.readSignal(BusinessTaskSettled, id, durableContext);
    if (sigState && 'value' in sigState) {
      anySignalDelivered = true;
    }
  }

  // 提前唤醒保护（例如重启/扩展变动触发 gatedCall 或未到 until 且无新信号到达）：
  // 不重复注册（api.memo 幂等），核对过期状态后安全续睡原 until。
  const prevUntil = Number.isFinite(prev?.until) ? prev.until : undefined;
  const wakeReason = durableApi.wake?.reason;
  const isEarlyWakeWithoutSignal = Boolean(
    prev &&
    !wakeReason &&
    !anySignalDelivered &&
    prevUntil !== undefined &&
    now < prevUntil,
  );
  if (isEarlyWakeWithoutSignal) {
    const registered = await registerTaskWaitIdempotently(ids, {
      durableApi,
      durableContext,
      opsRequest,
      turnId,
      signal,
      canvasId: resolvedCanvasId,
      sessionId: resolvedSessionId,
      now,
    });
    const pendingIds = Array.isArray(prev.pendingIds) && prev.pendingIds.length ? prev.pendingIds : ids;
    const sleepSignals = prev.waitingForBinding ? [] : await buildSleepSignals(pendingIds, durableApi, durableContext);
    return {
      sleep: {
        ...(sleepSignals.length > 0 ? { signals: sleepSignals } : {}),
        until: prevUntil,
        checkpoint: {
          businessTaskWait: {
            ...prev,
            registered,
            lastProgressKey: previousProgress,
          },
        },
      },
    };
  }

  try {
    signal?.throwIfAborted();
    const fetched = await fetchTasksSnapshot(ids, {
      opsRequest,
      turnId,
      signal,
      preferTaskWait,
      timeoutMs: 0,
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
                  registered: Boolean(prev?.registered),
                  waitingForBinding: true,
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
      return { ...data, result: { ...result, status: 'pending', note: '原任务仍在处理中，保留任务ID；请查询原任务，不能重复提交' } };
    }

    await emitProgress(evaluated.stage, evaluated.saved, { parked: true, taskIds: evaluated.pendingIds });
    const registered = await registerTaskWaitIdempotently(ids, {
      durableApi,
      durableContext,
      opsRequest,
      turnId,
      signal,
      canvasId: resolvedCanvasId,
      sessionId: resolvedSessionId,
      now,
    });
    const sleepSignals = await buildSleepSignals(evaluated.pendingIds, durableApi, durableContext);
    const nextUntil = Math.min(deadline, Math.max(now + 1, now + reconcileIntervalMs));
    return {
      sleep: {
        ...(sleepSignals.length > 0 ? { signals: sleepSignals } : {}),
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
            lastProgressKey: previousProgress,
            observedById: Object.fromEntries(observedById.entries()),
          },
        },
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    try { await emitProgress('observation_unavailable'); }
    catch { signal?.throwIfAborted(); }
    return { ...data, result: { ...result, status: 'pending', observationFailed: true, note: '原任务已受理，暂时无法读取进度；请按返回的任务ID查询，不要重新提交' } };
  }
}

// 业务任务等待入口：
// - 在 Durable ToolTask 运行时内（传入 durableApi）严格走官方 ToolPark（零阻塞挂起 + 信号唤醒 + until 对账）；
// - 非 Durable 独立调用方（如单测或离线桥接调用）保持原有兼容轮询路径。
export async function awaitBusinessTasks(data, {
  opsRequest,
  turnId,
  signal,
  canvasId,
  sessionId = '',
  intervalMs = 1000,
  rendering = false,
  onProgress,
  useTaskWait = false,
  taskWaitSliceMs = DEFAULT_TASK_WAIT_SLICE_MS,
  maxIdleWaitMs = DEFAULT_AWAIT_IDLE_TIMEOUT_MS,
  reconcileIntervalMs = DEFAULT_PARK_RECONCILE_MS,
  bindingRetryMs = DEFAULT_BINDING_RETRY_MS,
  durableApi = null,
  durableContext = null,
}) {
  if (durableApi && durableContext) {
    return awaitBusinessTasksParked(data, {
      opsRequest,
      turnId,
      signal,
      canvasId,
      sessionId,
      rendering,
      onProgress,
      useTaskWait,
      maxIdleWaitMs,
      reconcileIntervalMs,
      bindingRetryMs,
      durableApi,
      durableContext,
    });
  }

  const result = data?.result;
  const ids = result?.taskIds || (result?.taskId ? [result.taskId] : []);
  if (!ids.length) return data;
  let previousProgress;
  const progress = async (stage, saved = 0) => {
    const value = { stage, saved, total: ids.length };
    const serialized = JSON.stringify(value);
    if (serialized === previousProgress) return;
    await onProgress?.(value);
    previousProgress = serialized;
  };
  let preferTaskWait = Boolean(useTaskWait);
  let lastSavedCount = 0;
  let deadline = Date.now() + maxIdleWaitMs;
  const observedById = new Map();
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const remainingMs = Math.max(0, deadline - Date.now());
      const timeoutMs = Math.min(25000, Math.max(0, Math.min(taskWaitSliceMs, remainingMs)));
      const fetched = await fetchTasksSnapshot(ids, {
        opsRequest,
        turnId,
        signal,
        preferTaskWait,
        timeoutMs,
      });
      preferTaskWait = fetched.preferTaskWait;
      const evaluated = evaluateTaskBatch(ids, fetched.tasks, observedById, fetched.waitResult, {
        rendering,
        nodeIds: result.nodeIds,
      });
      if (evaluated.saved > lastSavedCount) {
        lastSavedCount = evaluated.saved;
        deadline = Date.now() + maxIdleWaitMs;
      }
      if (evaluated.failed && evaluated.settled) {
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
      await progress(evaluated.stage, evaluated.saved);
      if (evaluated.ready) {
        let boundRevision;
        if (result.nodeIds?.length) {
          const response = await opsRequest('POST', '/ops/canvas.get', { params: { canvasId } }, signal, turnId);
          const canvas = response?.result?.canvas;
          if (!canvas || typeof canvas !== 'object') throw new Error('canvas_observation_unavailable');
          if (!isCanvasBound(canvas, result.nodeIds, ids)) {
            await delay(intervalMs, undefined, { signal });
            continue;
          }
          if (Number.isSafeInteger(canvas.revision) && canvas.revision > 0) boundRevision = canvas.revision;
        }
        const revision = boundRevision === undefined ? {} : { revision: boundRevision };
        return { ...data, ...revision, result: { ...result, ...revision, status: 'succeeded', tasks: evaluated.progressTasks } };
      }
      if (!fetched.waitedOnServer) {
        await delay(intervalMs, undefined, { signal });
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    try { await progress('observation_unavailable'); }
    catch { signal?.throwIfAborted(); }
    return { ...data, result: { ...result, status: 'pending', observationFailed: true, note: '原任务已受理，暂时无法读取进度；请按返回的任务ID查询，不要重新提交' } };
  }
  return { ...data, result: { ...result, status: 'pending', note: '原任务仍在处理中，保留任务ID；请查询原任务，不能重复提交' } };
}
