import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 64 * 1024;
// /events allows up to 48,000-char skill_script_completed payloads; UTF-8 Chinese text
// takes 3 bytes per char (~144 KiB) plus JSON envelope overhead.
export const MAX_EVENTS_BODY_BYTES = 256 * 1024;

export function sendLine(res, payload) {
  res.write(JSON.stringify(payload) + '\n');
}

export function instanceProof(nonce) {
  if (!nonce) return '';
  return crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16);
}

export function timingSafeMatch(got, expected) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function instanceOK(req, instanceNonce) {
  if (!instanceNonce) return true;
  return timingSafeMatch(req.headers['x-beeftv-instance-nonce'] || '', instanceNonce);
}

export function authorized(req, { instanceNonce, hostToken, allowedOrigin, listenPipe }) {
  if (!instanceOK(req, instanceNonce)) return { ok: false, reason: 'instance_mismatch' };
  if (!timingSafeMatch(req.headers['x-beeftv-agent-token'] || '', hostToken)) return { ok: false, reason: 'unauthorized' };
  const origin = String(req.headers.origin || '');
  if (allowedOrigin && origin && origin !== allowedOrigin) return { ok: false, reason: 'origin_rejected' };
  const host = String(req.headers.host || '');
  const hostAllowed = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    || (Boolean(listenPipe) && /^pipe-[0-9a-f]{16}\.invalid$/.test(host));
  if (!hostAllowed) return { ok: false, reason: 'host_rejected' };
  return { ok: true };
}

export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('body too large');
      error.tooLarge = true;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const raw = await readBody(req, maxBytes);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('invalid_request'), { reason: 'invalid_request' });
    }
    return parsed;
  } catch (error) {
    if (error?.reason === 'invalid_request') throw error;
    throw Object.assign(new Error('invalid_request'), { reason: 'invalid_request' });
  }
}

export function respond(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function respondStoreError(res, error, isCorruptSessionArtifactError) {
  if (error?.reason === 'invalid_request') {
    respond(res, 400, { code: 400, reason: 'invalid_request' });
    return true;
  }
  if (['skill_context_revision_conflict', 'skill_context_request_conflict', 'skill_scope_reset_pending', 'skill_context_changed', 'session_not_running', 'supplement_preparation_pending', 'submission_request_conflict'].includes(error?.reason)) {
    respond(res, 409, { code: 409, reason: error.reason });
    return true;
  }
  if (['invalid_skill_context_action', 'invalid_skill_context_request', 'invalid_skill_selection', 'invalid_thinking_level'].includes(error?.reason)) {
    respond(res, 400, { code: 400, reason: error.reason });
    return true;
  }
  if (error?.reason === 'model_not_configured' || error?.reason === 'compaction_failed') {
    respond(res, 503, { code: 503, reason: error.reason });
    return true;
  }
  if (error?.reason === 'session_busy') { respond(res, 409, { code: 409, reason: 'session_busy' }); return true; }
  if (error?.reason === 'session_not_current') { respond(res, 409, { code: 409, reason: 'session_not_current' }); return true; }
  if (error?.reason === 'session_not_found') { respond(res, 404, { code: 404, reason: 'session_not_found' }); return true; }
  if (error?.reason === 'session_pointer_failed') {
    respond(res, 500, { code: 500, reason: 'session_pointer_failed', message: String(error.message || error) });
    return true;
  }
  if (error?.reason === 'session_pointer_unavailable') {
    respond(res, 503, { code: 503, reason: 'session_pointer_unavailable' });
    return true;
  }
  if (error?.reason === 'session_store_closed') {
    respond(res, 503, { code: 503, reason: 'session_store_closed' });
    return true;
  }
  if (isCorruptSessionArtifactError(error)) {
    respond(res, 409, { code: 409, reason: error.reason || 'corrupt_session_manifest' });
    return true;
  }
  return false;
}
