import crypto from 'node:crypto';
import { isDurableSessionId } from './durable-session-owner.mjs';
import { deterministicWakeTurnId } from './durable-followup.mjs';
import { turnContextPrefix, toolCallCapabilityContext } from './canvas-turn.mjs';
import { mediaCapabilityContext } from './media-content.mjs';
import { MAX_EVENTS_BODY_BYTES, readJsonBody, respond } from './http-utils.mjs';

export async function handleEventsRoute(req, res, {
  durable,
  ops,
  ensureDescriptorsLoaded = () => ops.ensureDescriptorsLoaded?.(),
  currentId,
  followDurable,
  getProviderReason,
  readOnlyMode,
  modelApi,
  modelId,
}) {
  const body = await readJsonBody(req, MAX_EVENTS_BODY_BYTES);
  const canvasId = String(body.canvasId || '').trim();
  const message = String(body.message || '').trim();
  const cleanKind = String(body.kind || 'event').replace(/[^a-z0-9_-]/gi, '_');
  const maxEventMessageLen = cleanKind === 'skill_script_completed' ? 48000 : 8000;
  if (!canvasId || !message || message.length > maxEventMessageLen) {
    respond(res, 400, { code: 400, reason: 'invalid_request' });
    return;
  }
  const requestedSessionId = String(body.sessionId || '').trim();
  const currentSessionId = currentId(canvasId);
  if (
    (cleanKind === 'task_completed' || cleanKind === 'skill_script_completed') &&
    !getProviderReason() &&
    !readOnlyMode &&
    currentSessionId &&
    isDurableSessionId(currentSessionId) &&
    (!requestedSessionId || requestedSessionId === currentSessionId)
  ) {
    const entry = await durable.ensureCurrentSession(canvasId, currentSessionId).catch(() => null);
    if (entry) {
      const requestId = String(body.requestId || crypto.randomUUID()).trim();
      const userText = String(body.userText || message).trim() || message;
      const revisionBefore = Number(body.revisionBefore || 0);
      const wakeText = `<canvas_event kind="${cleanKind}">\n${message}\n</canvas_event>`;
      const content = [{
        type: 'text',
        text: `${turnContextPrefix({ canvasId })}\n${mediaCapabilityContext({ api: modelApi, modelId })}\n${toolCallCapabilityContext({ api: modelApi, modelId })}\n${wakeText}`,
      }];
      const permissionMode = typeof durable.resolvedPermissionMode === 'function'
        ? await durable.resolvedPermissionMode(entry, body.permissionMode)
        : (body.permissionMode || entry.permissionMode || entry.generation?.permissionMode || 'canvas');
      if (ops.descriptors?.size === 0 && typeof ensureDescriptorsLoaded === 'function') {
        await Promise.resolve(ensureDescriptorsLoaded()).catch(() => {});
      }

      const wakeBusy = (await durable.busyState(canvasId)).busy;
      let shouldQueueFollowUp = wakeBusy;
      let finalizedIdleTurnId = '';

      if (!wakeBusy) {
        const turnId = deterministicWakeTurnId(canvasId, requestId, body.turnId);
        let openedTurn = false;
        try {
          await ops.opsRequest('POST', '/assistant/runtime/turns', {
            turnId,
            canvasId,
            permissionMode,
            sessionId: entry.sessionId,
          });
          openedTurn = true;
          const submission = await durable.submit(entry, {
            turnId,
            requestId: `event:${requestId}`,
            content,
            userText,
            revisionBefore,
            permissionMode,
          }, {
            onSubmitted: (sub) => { followDurable(entry, sub); },
          });
          if (submission) {
            respond(res, 202, {
              accepted: true,
              woken: true,
              sessionId: entry.sessionId,
              turnId,
              requestId: `event:${requestId}`,
              permissionMode,
            });
            return;
          }
          await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`, {}).catch(() => null);
          finalizedIdleTurnId = turnId;
        } catch (error) {
          if (openedTurn) {
            await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`, {}).catch(() => null);
            finalizedIdleTurnId = turnId;
          }
          if (error?.reason === 'session_busy') {
            shouldQueueFollowUp = true;
          }
        }
      }

      if (shouldQueueFollowUp && typeof durable.submitFollowUpEvent === 'function') {
        try {
          const queued = await durable.submitFollowUpEvent(entry, {
            kind: cleanKind,
            requestId,
            turnId: body.turnId,
            excludedTurnId: finalizedIdleTurnId,
            content,
            userText,
            revisionBefore,
            permissionMode,
            eventData: body.data && typeof body.data === 'object' ? body.data : {},
          });
          respond(res, 202, {
            accepted: true,
            woken: true,
            queued: queued.status === 'queued',
            mode: 'followUp',
            sessionId: queued.sessionId,
            turnId: queued.turnId,
            requestId: queued.requestId,
            submissionId: queued.submission.id,
            permissionMode: queued.permissionMode,
          });
          return;
        } catch (error) {
          console.error(`agent-host: followUp 入队失败，回退 recordEvent ${error?.reason || error?.message || error}`);
        }
      }
    }
  }
  const result = await durable.recordEvent(canvasId, {
    sessionId: requestedSessionId,
    requestId: body.requestId,
    kind: body.kind || 'event',
    message,
    data: body.data && typeof body.data === 'object' ? body.data : {},
  });
  respond(res, 202, result);
}
