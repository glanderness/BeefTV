// 忙碌期 followUp 排队与跨 Run Go turnId 生命周期交接：
// 1. 后台任务/脚本完成事件在会话忙碌时经官方 whenBusy: "followUp" 入队，保留原权限模式（不降级为 canvas）；
// 2. 上一个 Run 结束并关闭旧 turnId 后，在下一个 Run 的 beforeRequest 边界检测新 Run，
//    先等待旧 Run 完成本地与 Go 侧收口，再用保留的 permissionMode 向 Go 申请新 turnId 并原子绑定 doc.active。
import crypto from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import { resetTurnAccumulator } from './canvas-turn.mjs';
import { publicPlan } from './plan.mjs';
import { resetTurnContinuation } from './durable-signals.mjs';

const CTX = BACKGROUND_CONTEXT;
const VALID_MODES = new Set(['read-only', 'canvas', 'full-access']);

export function resolvePreservedPermissionMode(entry, doc, explicitMode = '') {
  const candidates = [
    explicitMode,
    doc?.active?.permissionMode,
    entry?.input?.permissionMode,
    entry?.permissionMode,
    entry?.generation?.permissionMode,
    doc?.lastPermissionMode,
    doc?.turns?.at(-1)?.permissionMode,
  ];
  for (const mode of candidates) {
    if (typeof mode === 'string' && VALID_MODES.has(mode)) return mode;
  }
  return 'canvas';
}

export function deterministicWakeTurnId(canvasId, requestId, rawTurnId = '') {
  const cleanRaw = String(rawTurnId || '').trim().toLowerCase();
  if (/^[0-9a-f]{8,64}$/.test(cleanRaw)) return cleanRaw;
  return crypto.createHash('sha256').update(`wake:${canvasId}:${requestId}`).digest('hex').slice(0, 24);
}

export async function enqueueFollowUpEvent({
  entry,
  lock,
  state,
  update,
  kind,
  requestId,
  turnId,
  content,
  userText,
  revisionBefore = 0,
  permissionMode,
  eventData = {},
  onFollowUpStarted = null,
}) {
  const cleanKind = String(kind || 'event').replace(/[^a-z0-9_-]/gi, '_') || 'event';
  const followUpRequestId = `event:${requestId}`;
  const doc = await state(entry);
  const preservedMode = resolvePreservedPermissionMode(entry, doc, permissionMode);
  const followUpTurnId = deterministicWakeTurnId(entry.canvasId, requestId, turnId);
  const cleanUserText = String(userText || '').trim();
  const createdAt = new Date().toISOString();
  const wakeMeta = {
    wakeEvent: true,
    kind: cleanKind,
    requestId: followUpRequestId,
    turnId: followUpTurnId,
    permissionMode: preservedMode,
    userText: cleanUserText,
    revisionBefore: Number(revisionBefore || 0),
    ...(eventData && typeof eventData === 'object' ? { eventData } : {}),
  };

  const submission = await entry.root.submit({
    type: 'input',
    requestId: followUpRequestId,
    content,
    whenBusy: 'followUp',
    entry: {
      kind: `beeftv.${cleanKind}`,
      data: wakeMeta,
    },
  }, CTX);

  await lock(entry.canvasId, async () => {
    await update(entry, (current) => {
      const queued = Array.isArray(current.queuedFollowUps) ? current.queuedFollowUps : [];
      if (!queued.some((item) => item.submissionId === submission.id || item.requestId === followUpRequestId)) {
        current.queuedFollowUps = [...queued, {
          submissionId: submission.id,
          requestId: followUpRequestId,
          turnId: followUpTurnId,
          permissionMode: preservedMode,
          userText: cleanUserText,
          revisionBefore: Number(revisionBefore || 0),
          kind: cleanKind,
          content,
          createdAt,
        }];
      }
      current.lastPermissionMode = preservedMode;
    });
  });

  // 竞态兜底：若上一轮在检查 busy 与 submit 之间刚好结束，Pi 会直接 placed 启动新 Run，
  // 此时如果尚未有观察者绑定该提交，立即挂上 onFollowUpStarted 以便终态回写。
  const status = await submission.status(CTX).catch(() => null);
  if (status?.status === 'placed' && !entry.submissionWaiters?.has(submission.id)) {
    onFollowUpStarted?.(entry, submission);
  }

  return {
    submission,
    sessionId: entry.sessionId,
    turnId: followUpTurnId,
    requestId: followUpRequestId,
    permissionMode: preservedMode,
    status: status?.status || 'queued',
  };
}

export function createRunTurnHandoff({
  entry,
  lock,
  state,
  update,
  hydrate,
  openTurn,
  settleTurnWithConfirmation,
  onFollowUpStarted,
}) {
  return async function ensureRunTurnHandoff(runtime, context) {
    if (!entry?.harness || !entry?.root || entry.readOnlyHandle) return;
    const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
    const runInputs = Array.isArray(live?.run?.inputs) ? live.run.inputs : [];
    if (runInputs.length === 0) return;

    const initialDoc = await state(entry);
    const currentActive = initialDoc?.active;
    if (currentActive && currentActive.submissionId != null && runInputs.includes(currentActive.submissionId)) {
      return;
    }

    // 仅对显式 followUp 队列项或带 wakeEvent 元数据的入队条目执行跨 Run turnId 交接；
    // 同回合的 supplement（steer 补充输入）与普通首轮提交共享当前 Go turnId，绝不能等待旧回合收口或另开 turnId。
    const initialQueued = Array.isArray(initialDoc?.queuedFollowUps) ? initialDoc.queuedFollowUps : [];
    const initialQueuedItem = initialQueued.find((item) => runInputs.includes(item.submissionId)) || null;
    let initialEntryData = null;
    if (!initialQueuedItem && live?.run?.first != null) {
      const firstEntry = await runtime.entry(live.run.first, context).catch(() => null);
      if (firstEntry?.data && typeof firstEntry.data === 'object') {
        initialEntryData = firstEntry.data;
      }
    }
    if (!initialQueuedItem && initialEntryData?.wakeEvent !== true) {
      return;
    }

    // 1. 若上一轮的观察者仍在收口（正在调用 completeTurn(oldTurnId) 与 settleLocal），先等它彻底结束，
    //    避免新旧回合抢写 doc.active 或出现新 Run 误用旧 turnId。
    const oldSubmissionId = currentActive?.submissionId;
    if (oldSubmissionId != null && entry.submissionWaiters?.has(oldSubmissionId)) {
      await entry.submissionWaiters.get(oldSubmissionId).catch(() => {});
    }

    // 2. 若旧 active 在重启或无观察者场景下尚未结算，先完成旧回合两阶段收口。
    const postWaitDoc = await state(entry);
    if (
      postWaitDoc?.active &&
      postWaitDoc.active.submissionId != null &&
      !runInputs.includes(postWaitDoc.active.submissionId) &&
      typeof settleTurnWithConfirmation === 'function'
    ) {
      await settleTurnWithConfirmation(entry, postWaitDoc.active.requestId, { confirmCommittedResult: true }).catch(() => {});
    }

    // 3. 在画布锁内为新 followUp Run 向 Go 申请新 turnId（保留原 permissionMode）并原子绑定 doc.active。
    const followUpSubId = runInputs[0];
    let startedSubmission = null;
    await lock(entry.canvasId, async () => {
      const doc = await state(entry);
      if (doc?.active && doc.active.submissionId != null && runInputs.includes(doc.active.submissionId)) {
        return;
      }

      const queued = Array.isArray(doc?.queuedFollowUps) ? doc.queuedFollowUps : [];
      const queuedItem = queued.find((item) => runInputs.includes(item.submissionId)) || initialQueuedItem;

      let entryData = initialEntryData;
      if (!entryData && live?.run?.first != null) {
        const firstEntry = await runtime.entry(live.run.first, context).catch(() => null);
        if (firstEntry?.data && typeof firstEntry.data === 'object') {
          entryData = firstEntry.data;
        }
      }

      if (!queuedItem && entryData?.wakeEvent !== true) {
        return;
      }

      const preservedMode = resolvePreservedPermissionMode(
        entry,
        doc,
        queuedItem?.permissionMode || entryData?.permissionMode || '',
      );
      const nextRequestId = String(queuedItem?.requestId || entryData?.requestId || `followup:${followUpSubId}`);
      const nextTurnId = deterministicWakeTurnId(
        entry.canvasId,
        nextRequestId,
        queuedItem?.turnId || entryData?.turnId || '',
      );
      const nextUserText = String(queuedItem?.userText || entryData?.userText || '').trim();
      const nextRevisionBefore = Number(queuedItem?.revisionBefore ?? entryData?.revisionBefore ?? 0);
      const nextContent = queuedItem?.content || [{ type: 'text', text: nextUserText }];
      const createdAt = queuedItem?.createdAt || new Date().toISOString();

      if (typeof openTurn === 'function') {
        await openTurn({
          turnId: nextTurnId,
          canvasId: entry.canvasId,
          permissionMode: preservedMode,
          sessionId: entry.sessionId,
        });
      }

      entry.budget = null;
      resetTurnAccumulator(entry.turn, nextRevisionBefore, nextTurnId);
      entry.turn.canvasId = entry.canvasId;
      entry.turn.supplements = [];
      entry.turn.plan = publicPlan(doc?.plan);
      entry.log.length = 0;
      entry.generation = Object.assign(entry.generation, {
        aborted: false,
        permissionMode: preservedMode,
        intentEpoch: 0,
        modelEpoch: 0,
        pendingInput: null,
        pendingInputError: null,
        skillContextFailure: null,
        preparedRequests: new Set(),
      });
      await resetTurnContinuation(entry, nextTurnId, CTX);

      await update(entry, (draft) => {
        draft.active = {
          turnId: nextTurnId,
          requestId: nextRequestId,
          submissionId: followUpSubId,
          permissionMode: preservedMode,
          userText: nextUserText,
          revisionBefore: nextRevisionBefore,
          content: nextContent,
          createdAt,
          stopped: false,
          effects: JSON.parse(JSON.stringify(entry.turn)),
          log: [],
          supplements: [],
          intentEpoch: 0,
          modelEpoch: 0,
          ...(publicPlan(draft.plan) ? { plan: publicPlan(draft.plan) } : {}),
        };
        draft.lastPermissionMode = preservedMode;
        if (Array.isArray(draft.queuedFollowUps)) {
          draft.queuedFollowUps = draft.queuedFollowUps.filter((item) => !runInputs.includes(item.submissionId));
        }
      });

      const updated = (await state(entry)).active;
      hydrate(entry, updated);
      entry.permissionMode = preservedMode;
      entry.generation.permissionMode = preservedMode;
      entry.submittedRequest = nextRequestId;
      if (!entry.readOnlyHandle && entry.hasHostToolsDrift?.(preservedMode) && typeof entry.configurePermission === 'function') {
        await entry.configurePermission(preservedMode);
      }
      startedSubmission = await entry.harness.submission(followUpSubId, CTX);
    });

    if (startedSubmission && !entry.submissionWaiters?.has(startedSubmission.id)) {
      onFollowUpStarted?.(entry, startedSubmission);
    }
  };
}
