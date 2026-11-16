// 观察者异常脱离后的后台官方提交监控与两阶段回收：
// 1. 仅在存储读取成功且官方 submission 显式到达非 running 终态（或为空）时进入结算，读错一律保持 busy；
// 2. 先在锁内持久化 doc.active.result 并设 pendingCompleteRetry，锁外确认 Go /complete 后再 settleLocal。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const CTX = BACKGROUND_CONTEXT;

export function createDurableDetachedReconciler({
  state,
  update,
  lock,
  completionRecord,
  compensateFailedSkillSelection,
  settleLocal,
  completeTurn,
  hasLiveLocalOwner,
  isEntryActiveOrDetached,
  permanentUnresumableReasons,
}) {
  async function reconcileDetachedEntry(entry, expectedRequestId = '') {
    if (!entry || entry.disposed) return false;
    if (!entry.detachedRunning && !entry.pendingCompleteRetry) {
      return Boolean(entry.busy || isEntryActiveOrDetached(entry));
    }
    let prepared;
    try {
      prepared = await lock(entry.canvasId, async () => {
        if (entry.disposed) return { kind: 'idle', busy: false };
        if (hasLiveLocalOwner(entry) || entry.recovering) return { kind: 'busy' };
        if (!entry.detachedRunning && !entry.pendingCompleteRetry) {
          return { kind: 'idle', busy: Boolean(entry.busy) };
        }
        let current;
        try {
          current = await state(entry);
        } catch {
          return { kind: 'busy' };
        }
        const active = current?.active;
        if (!active) {
          entry.detachedRunning = false;
          entry.pendingCompleteRetry = false;
          if (!hasLiveLocalOwner(entry)) entry.busy = false;
          return { kind: 'idle', busy: false };
        }
        if (expectedRequestId && active.requestId !== expectedRequestId) {
          return { kind: 'idle', busy: Boolean(entry.busy || isEntryActiveOrDetached(entry)) };
        }
        let record = active.result || null;
        if (!record) {
          let admitted;
          let submission;
          let settled;
          try {
            admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, active.requestId), CTX);
            submission = admitted ? await entry.harness.submission(admitted.id, CTX) : null;
            settled = submission ? await submission.status(CTX) : null;
          } catch {
            return { kind: 'busy' };
          }
          if (submission && (!settled || settled.status === 'running')) {
            entry.detachedRunning = true;
            entry.busy = true;
            return { kind: 'busy' };
          }
          const isCommittedDone = settled?.status === 'done' && !active.stopped;
          const settlement = isCommittedDone
            ? {
                ...settled,
                ...(admitted?.entry !== undefined && settled.entry === undefined ? { entry: admitted.entry } : {}),
              }
            : {
                ...(settled || {}),
                status: 'unanswered',
                reason: active.stopped ? 'aborted' : 'interrupted',
                ...(admitted?.entry !== undefined && settled?.entry === undefined ? { entry: admitted.entry } : {}),
              };
          try {
            record = await completionRecord(entry, active, settlement);
            await compensateFailedSkillSelection(entry, active, record);
            await update(entry, (doc) => {
              if (doc.active?.requestId === active.requestId) doc.active.result = record;
            });
          } catch {
            return { kind: 'busy' };
          }
        }
        entry.detachedRunning = false;
        entry.pendingCompleteRetry = true;
        entry.busy = true;
        return {
          kind: 'complete',
          active,
          record,
          payload: { canvasId: entry.canvasId, turnId: active.turnId, sessionId: entry.sessionId, record },
        };
      });
    } catch (error) {
      if (error?.reason === 'session_store_closed') return false;
      return true;
    }

    if (prepared.kind === 'busy') return true;
    if (prepared.kind === 'idle') return prepared.busy;

    try {
      await completeTurn(prepared.payload);
    } catch (error) {
      if (!permanentUnresumableReasons.has(error?.reason || '')) {
        console.error(`agent-host: 脱离回合完成回调暂未成功，保留重试标记 ${error?.reason || error?.message || error}`);
        monitorDetachedSubmission(entry, null, prepared.active.requestId);
        return true;
      }
    }

    try {
      return await lock(entry.canvasId, async () => {
        if (entry.disposed) {
          entry.pendingCompleteRetry = false;
          entry.busy = false;
          return false;
        }
        const latest = await state(entry);
        if (latest?.active?.requestId === prepared.active.requestId) {
          await settleLocal(entry, latest.active, prepared.record);
        }
        entry.pendingCompleteRetry = false;
        if (!hasLiveLocalOwner(entry) && !entry.recovering && !entry.detachedRunning) {
          const afterSettle = await state(entry).catch(() => null);
          if (afterSettle && !afterSettle.active) entry.busy = false;
        }
        return Boolean(entry.busy || isEntryActiveOrDetached(entry));
      });
    } catch (error) {
      if (error?.reason === 'session_store_closed') return false;
      monitorDetachedSubmission(entry, null, prepared.active.requestId);
      return true;
    }
  }

  function monitorDetachedSubmission(entry, submission, detachedRequestId) {
    if (entry.detachedMonitor) return;
    const monitor = (async () => {
      for (let attempt = 0, consecutiveErrors = 0; ; attempt += 1) {
        const delayMs = consecutiveErrors > 0
          ? Math.min(200 * (2 ** Math.min(consecutiveErrors, 5)), 5000)
          : Math.min(200 + attempt * 50, 1000);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
        if ((!entry.detachedRunning && !entry.pendingCompleteRetry) || entry.disposed || hasLiveLocalOwner(entry)) return;
        if (entry.detachedRunning && submission) {
          let currentStatus;
          try {
            currentStatus = await submission.status(CTX);
            consecutiveErrors = 0;
          } catch {
            consecutiveErrors += 1;
            continue;
          }
          if (!currentStatus || currentStatus.status === 'running') continue;
        }
        const stillBusy = await reconcileDetachedEntry(entry, detachedRequestId);
        if (!stillBusy) return;
        consecutiveErrors += 1;
      }
    })().finally(() => {
      if (entry.detachedMonitor === monitor) entry.detachedMonitor = null;
    });
    entry.detachedMonitor = monitor;
  }

  return { reconcileDetachedEntry, monitorDetachedSubmission };
}
