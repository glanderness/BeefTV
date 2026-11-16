// 统一的两阶段回合完成确认与脱离监控：
// 1. 先在锁内持久化 doc.active.result 并置 pendingCompleteRetry（已提交 done 的回合绝不 root.abort）；
// 2. 释放锁后调用 Go /complete，仅在确认成功（或永久不可恢复码表示 Go 已关闭）后才执行 settleLocal；
// 3. 存储读取异常或 Go 临时失败时保留 doc.active.result 与 busy，由后台退避监控重试。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const CTX = BACKGROUND_CONTEXT;

export function isTerminalSubmissionStatus(status) {
  return status === 'done' || status === 'unanswered';
}

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
  async function settleTurnWithConfirmation(entry, expectedRequestId = '', { abortIfRunning = false } = {}) {
    if (!entry || entry.disposed) return { settled: false, busy: false, record: null };
    if (!abortIfRunning && !entry.detachedRunning && !entry.pendingCompleteRetry) {
      return { settled: false, busy: Boolean(entry.busy || isEntryActiveOrDetached(entry)), record: null };
    }
    let prepared;
    try {
      prepared = await lock(entry.canvasId, async () => {
        if (entry.disposed) return { kind: 'idle', busy: false };
        if (!abortIfRunning && (hasLiveLocalOwner(entry) || entry.recovering)) return { kind: 'busy' };
        if (!abortIfRunning && !entry.detachedRunning && !entry.pendingCompleteRetry) {
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
          } catch (error) {
            if (!abortIfRunning) return { kind: 'busy' };
            admitted = null;
            submission = null;
            settled = null;
            void error;
          }
          if (!abortIfRunning && submission && !isTerminalSubmissionStatus(settled?.status)) {
            entry.detachedRunning = true;
            entry.busy = true;
            return { kind: 'busy' };
          }
          const isCommittedDone = settled?.status === 'done' && !active.stopped;
          if (abortIfRunning && !isCommittedDone) {
            await entry.root.abort(CTX).catch(() => {});
            if (submission) {
              settled = await submission.status(CTX).catch(() => settled);
            }
          }
          const finalCommittedDone = settled?.status === 'done' && !active.stopped;
          const settlement = finalCommittedDone
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
      if (error?.reason === 'session_store_closed') return { settled: false, busy: false, record: null };
      return { settled: false, busy: true, record: null };
    }

    if (prepared.kind === 'busy') return { settled: false, busy: true, record: null };
    if (prepared.kind === 'idle') return { settled: true, busy: prepared.busy, record: null };

    try {
      await completeTurn(prepared.payload);
    } catch (error) {
      if (!permanentUnresumableReasons.has(error?.reason || '')) {
        console.error(`agent-host: 回合完成回调暂未成功，保留重试标记 ${error?.reason || error?.message || error}`);
        if (!entry.disposed && !entry.readOnlyHandle) {
          monitorDetachedSubmission(entry, null, prepared.active.requestId);
        }
        return { settled: false, busy: true, record: prepared.record };
      }
    }

    try {
      const busyAfter = await lock(entry.canvasId, async () => {
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
      return { settled: true, busy: busyAfter, record: prepared.record };
    } catch (error) {
      if (error?.reason === 'session_store_closed') return { settled: false, busy: false, record: prepared.record };
      if (!entry.disposed && !entry.readOnlyHandle) {
        monitorDetachedSubmission(entry, null, prepared.active.requestId);
      }
      return { settled: false, busy: true, record: prepared.record };
    }
  }

  async function reconcileDetachedEntry(entry, expectedRequestId = '') {
    const res = await settleTurnWithConfirmation(entry, expectedRequestId, { abortIfRunning: false });
    return res.busy;
  }

  function monitorDetachedSubmission(entry, submission, detachedRequestId) {
    if (entry.detachedMonitor || entry.disposed || entry.readOnlyHandle) return;
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
          if (!isTerminalSubmissionStatus(currentStatus?.status)) continue;
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

  return { settleTurnWithConfirmation, reconcileDetachedEntry, monitorDetachedSubmission };
}
