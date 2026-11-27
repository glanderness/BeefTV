// Durable 信号白名单注册表与回合续跑状态文档：
// 1. 信号 token 严格经官方 defineSignal() 构建并静态登记，外部 HTTP /signals 必须反查精确 token 对象；
// 2. 回合续跑状态（planTouchedInTurn / toolCalledSinceYield / planContinuations / unboundReminderSent）
//    经官方 defineDoc 落盘，通过 conversation.commit 原子更新，跨重启与跨轮唤醒不丢状态。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineSignal } from '@earendil-works/pi-durable';
import { obj, opt, str } from '@earendil-works/pi-schema';
import { readJsonBody, respond, sendLine } from './http-utils.mjs';
import { extractParkedToolsFromLive } from './durable-turn-projection.mjs';

const CTX = BACKGROUND_CONTEXT;

export const BUSINESS_TASK_SETTLED_SIGNAL = 'business_task_settled';

// 业务生成/渲染任务到达终态（成功物化完成、失败、取消或物化永久失败）时由 Go 侧投递。
export const BusinessTaskSettled = defineSignal({
  name: BUSINESS_TASK_SETTLED_SIGNAL,
  version: 1,
  schema: obj({
    taskId: opt(str()),
    status: opt(str()),
    state: opt(str()),
    reason: opt(str()),
    error: opt(str()),
    resultState: opt(str()),
  }, { open: true }),
});

// 静态白名单：严格映射到 defineSignal() 构建出的 token 实例（满足 Pi signals.js internalsOf WeakMap 校验）。
// PR-5 的审批决策信号（如 ApprovalDecision）可按同一模式直接登记于此。
const SIGNAL_TOKENS = new Map([
  [BUSINESS_TASK_SETTLED_SIGNAL, BusinessTaskSettled],
]);

export function resolveSignalToken(signalName) {
  const name = String(signalName || '').trim();
  if (!name) return null;
  return SIGNAL_TOKENS.get(name) || null;
}

export function listRegisteredSignalNames() {
  return [...SIGNAL_TOKENS.keys()];
}

export const TurnContinuationDoc = defineDoc({
  kind: 'beeftv.turn_continuation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    turnId: '',
    planTouchedInTurn: false,
    toolCalledSinceYield: false,
    planContinuations: 0,
    unboundReminderSent: false,
  }),
  checkpointWhen: () => true,
});

export async function readTurnContinuation(entry, context = CTX) {
  if (!entry?.harness || !entry?.root) {
    return TurnContinuationDoc.definition.initial();
  }
  const snap = await entry.harness.snapshot(TurnContinuationDoc, entry.root.id, context);
  return snap || TurnContinuationDoc.definition.initial();
}

export async function resetTurnContinuation(entry, turnId, context = CTX) {
  if (!entry?.root) return;
  await entry.root.commit(async (tx) => {
    const doc = await tx.doc(TurnContinuationDoc, entry.root.id);
    doc.turnId = String(turnId || '');
    doc.planTouchedInTurn = false;
    doc.toolCalledSinceYield = false;
    doc.planContinuations = 0;
    doc.unboundReminderSent = false;
  }, context);
}

export async function mutateTurnContinuation(entry, mutate, context = CTX) {
  if (!entry?.root) return undefined;
  return entry.root.commit(async (tx) => {
    const doc = await tx.doc(TurnContinuationDoc, entry.root.id);
    return mutate(doc);
  }, context);
}

// 扫描当前 Harness 中正睡眠等待 { signal, key } 的 pi.tool 任务（用于 durableTaskId 省略时的回退查找）。
export async function findSleepingToolTasksForSignal(harness, token, key, context = CTX) {
  const inspection = await harness.inspect(context);
  const matched = [];
  for (const item of inspection.tasks || []) {
    const record = item?.record;
    if (!record || record.kind !== 'pi.tool') continue;
    if (record.state?.status !== 'sleeping') continue;
    const signals = Array.isArray(record.state.signals) ? record.state.signals : [];
    if (signals.some((entry) => entry?.signal === token.name && entry?.key === key)) {
      matched.push(record.id);
    }
  }
  return matched;
}

// 向目标 Harness 投递已登记的 Durable 信号。
// - 若显式提供 durableTaskId，校验其为存在的 pi.tool 任务，否则返回 not_found；
// - 若省略 durableTaskId，通过 harness.inspect() 扫描等待该 { signal, key } 的睡眠 pi.tool 任务。
export async function deliverDurableSignal(harness, { durableTaskId, signal, key, value }, context = CTX) {
  const token = resolveSignalToken(signal);
  if (!token) {
    return { ok: false, status: 400, error: 'unknown_signal', reason: 'unknown_signal' };
  }
  const cleanKey = String(key || '').trim();
  if (!cleanKey) {
    return { ok: false, status: 400, error: 'invalid_request', reason: 'invalid_request' };
  }
  if (value === undefined) {
    return { ok: false, status: 400, error: 'invalid_request', reason: 'invalid_request' };
  }

  let targetIds = [];
  const hasExplicitId = durableTaskId !== undefined && durableTaskId !== null && durableTaskId !== '';
  if (hasExplicitId) {
    const parsed = Number(durableTaskId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return { ok: false, status: 404, error: 'signal_target_not_found', reason: 'signal_target_not_found' };
    }
    const existing = await harness.getTask(parsed, context);
    if (!existing || existing.kind !== 'pi.tool') {
      return { ok: false, status: 404, error: 'signal_target_not_found', reason: 'signal_target_not_found' };
    }
    targetIds = [parsed];
  } else {
    targetIds = await findSleepingToolTasksForSignal(harness, token, cleanKey, context);
    if (targetIds.length === 0) {
      return { ok: false, status: 404, error: 'signal_target_not_found', reason: 'signal_target_not_found' };
    }
  }

  const deliveries = [];
  for (const taskId of targetIds) {
    const result = await harness.signal(taskId, token, cleanKey, value, context);
    deliveries.push({ durableTaskId: taskId, result });
  }

  if (deliveries.length === 1 && deliveries[0].result === 'not_found') {
    return { ok: false, status: 404, error: 'signal_target_not_found', reason: 'signal_target_not_found', result: 'not_found' };
  }
  if (deliveries.length === 1 && deliveries[0].result === 'invalid') {
    return { ok: false, status: 400, error: 'invalid_signal_value', reason: 'invalid_signal_value', result: 'invalid' };
  }
  return {
    ok: true,
    status: 200,
    signal: token.name,
    key: cleanKey,
    durableTaskId: deliveries[0].durableTaskId,
    result: deliveries[0].result,
    deliveries,
  };
}

export async function handleSignalsRoute(req, res, {
  durable,
  ops,
  ensureDescriptorsLoaded,
  followDurable,
}) {
  const body = await readJsonBody(req);
  if (ops?.descriptors?.size === 0 && typeof ensureDescriptorsLoaded === 'function') {
    await Promise.resolve(ensureDescriptorsLoaded()).catch(() => {});
  }
  const delivery = await durable.deliverSignal(
    body.canvasId,
    body.sessionId,
    {
      durableTaskId: body.durableTaskId,
      signal: body.signal,
      key: body.key,
      value: body.value,
    },
    {
      onWoken: (entry, submission) => { followDurable?.(entry, submission); },
    },
  );
  if (!delivery.ok) {
    respond(res, delivery.status || 400, {
      code: delivery.status || 400,
      error: delivery.error || delivery.reason || 'signal_failed',
      reason: delivery.reason || delivery.error || 'signal_failed',
      ...(delivery.result ? { result: delivery.result } : {}),
    });
    return;
  }
  respond(res, 200, delivery);
}

export function updateParkedToolsState(entry, event) {
  if (!entry) return;
  if (event?.type === 'snapshot') {
    const live = event.docs?.['pi.live'] || event;
    entry.parkedTools = extractParkedToolsFromLive(live);
    return;
  }
  if (event?.type === 'tool_parked') {
    const list = Array.isArray(entry.parkedTools) ? [...entry.parkedTools] : [];
    const next = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.durableTaskId !== undefined ? { durableTaskId: event.durableTaskId } : {}),
      taskIds: Array.isArray(event.taskIds) ? event.taskIds : [],
      ...(event.stage ? { stage: event.stage } : {}),
      ...(event.saved !== undefined ? { saved: event.saved } : {}),
      ...(event.total !== undefined ? { total: event.total } : {}),
    };
    const idx = list.findIndex((item) => item.toolCallId === next.toolCallId);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    entry.parkedTools = list;
    return;
  }
  if (event?.type === 'tool_execution_end' && event.toolCallId && Array.isArray(entry.parkedTools)) {
    entry.parkedTools = entry.parkedTools.filter((item) => item.toolCallId !== event.toolCallId);
  }
}

export function attachParkedStreamHeartbeat(res, entry, { turnId, intervalMs, listener }) {
  let timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      stop();
      return;
    }
    if (!Array.isArray(entry.parkedTools) || entry.parkedTools.length === 0) return;
    sendLine(res, {
      type: 'heartbeat',
      parked: true,
      sessionId: entry.sessionId,
      turnId,
      parkedTools: entry.parkedTools,
      at: Date.now(),
    });
  }, intervalMs);
  timer.unref?.();
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  const onClose = () => {
    stop();
    entry.listeners?.delete(listener);
  };
  res.once('close', onClose);
  return () => {
    res.off('close', onClose);
    stop();
    entry.listeners?.delete(listener);
  };
}
