import crypto from 'node:crypto';
import { isDurableSessionId } from './durable-session-owner.mjs';
import { turnContextPrefix, toolCallCapabilityContext } from './canvas-turn.mjs';
import { mediaCapabilityContext } from './media-content.mjs';
import { MAX_EVENTS_BODY_BYTES, readJsonBody, respond } from './http-utils.mjs';

export async function handleEventsRoute(req, res, {
  durable,
  ops,
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
    const wakeBusy = entry ? (await durable.busyState(canvasId)).busy : true;
    if (entry && !wakeBusy) {
      const requestId = String(body.requestId || crypto.randomUUID()).trim();
      const rawTurnId = String(body.turnId || '').trim().toLowerCase();
      const turnId = /^[0-9a-f]{8,64}$/.test(rawTurnId)
        ? rawTurnId
        : crypto.createHash('sha256').update(`wake:${canvasId}:${requestId}`).digest('hex').slice(0, 24);
      let openedTurn = false;
      try {
        await ops.opsRequest('POST', '/assistant/runtime/turns', {
          turnId,
          canvasId,
          permissionMode: 'canvas',
          sessionId: entry.sessionId,
        });
        openedTurn = true;
        const wakeText = `<canvas_event kind="${cleanKind}">\n${message}\n</canvas_event>`;
        const content = [{
          type: 'text',
          text: `${turnContextPrefix({ canvasId })}\n${mediaCapabilityContext({ api: modelApi, modelId })}\n${toolCallCapabilityContext({ api: modelApi, modelId })}\n${wakeText}`,
        }];
        const submission = await durable.submit(entry, {
          turnId,
          requestId: `event:${requestId}`,
          content,
          userText: String(body.userText || message).trim() || message,
          revisionBefore: Number(body.revisionBefore || 0),
          permissionMode: 'canvas',
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
          });
          return;
        }
        await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`, {}).catch(() => null);
      } catch {
        if (openedTurn) {
          await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`, {}).catch(() => null);
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
