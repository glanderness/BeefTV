// A bounded projection of the existing dispatch ledger. This is not a request
// budget or execution journal; a diagnostic write failure cannot stop a model.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const safe = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._:@-]{0,159}$/.test(value)
  && !/secret|token|password|bearer|api.?key|sk-|:\/\//i.test(value) ? value : undefined;

const OUTCOME_STATUSES = new Set(['ok', 'error']);
const outcomeReasonsPath = [
  new URL('./model-outcome-reasons.json', import.meta.url),
  new URL('../backend/internal/assistantdiagnostics/model_outcome_reasons.json', import.meta.url),
].find(candidate => fs.existsSync(candidate));
export const MODEL_OUTCOME_REASONS = Object.freeze(
  JSON.parse(fs.readFileSync(outcomeReasonsPath, 'utf8')),
);
const OUTCOME_REASONS = new Set(MODEL_OUTCOME_REASONS);

export function classifyModelHttpStatus(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 100 || code > 599) return 'model_error';
  if (code >= 200 && code < 300) return 'http_200';
  const exact = `http_${code}`;
  if (OUTCOME_REASONS.has(exact)) return exact;
  if (code >= 400 && code < 500) return 'http_4xx';
  if (code >= 500) return 'http_5xx';
  return 'model_error';
}

export function classifyModelFetchError(error) {
  const name = String(error?.name || '');
  const message = [error?.message || error || '', error?.cause?.message || ''].filter(Boolean).join(' ');
  if (name === 'AbortError' || /\baborted\b/i.test(message)) return 'aborted';
  if (/idle timeout/i.test(message)) return 'stream_idle_timeout';
  if (/unexpected\s+eof|ended before|ended without|other side closed|premature close|\bterminated\b|socket/i.test(message)) return 'network_eof';
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|reset|tls|ssl/i.test(message)) return 'network_error';
  return 'model_error';
}

export function createDispatchDiagnostics(file, launchId, { maxBytes = 1024 * 1024, segments = 4, maxAgeMs = 48 * 3600000 } = {}) {
  let writeErrors = 0;
  const record = entry => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      for (let i = 0; i < segments; i++) {
        const part = i ? `${file}.${i}` : file;
        try { if (Date.now() - fs.statSync(part).mtimeMs > maxAgeMs) fs.unlinkSync(part); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const value = { id: crypto.randomUUID(), launchId: safe(launchId), at: new Date().toISOString(),
        turnId: safe(entry.turnId), canvasId: safe(entry.canvasId), sessionId: safe(entry.sessionId),
        requestId: safe(entry.requestId), model: safe(entry.model),
        dispatchIndex: Number.isSafeInteger(entry.dispatchIndex) ? entry.dispatchIndex : undefined,
        status: OUTCOME_STATUSES.has(entry.status) ? entry.status : undefined,
        reason: OUTCOME_REASONS.has(entry.reason) ? entry.reason : undefined,
        httpStatus: Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599 ? entry.httpStatus : undefined,
        durationMs: Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0 ? entry.durationMs : undefined };
      const line = JSON.stringify(value) + '\n';
      let size = 0;
      try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        for (let i = segments - 1; i >= 1; i--) {
          const source = i === 1 ? file : `${file}.${i - 1}`;
          const target = `${file}.${i}`;
          fs.rmSync(target, { force: true });
          try { fs.renameSync(source, target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      return true;
    } catch {
      writeErrors++;
      // Only a fixed reason: never print a local path or provider request.
      console.error('agent-host: diagnostic_ledger_write_failed');
      return false;
    }
  };
  return { record, writeErrors: () => writeErrors };
}
