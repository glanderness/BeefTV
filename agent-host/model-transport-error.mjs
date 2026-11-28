// Model transport & stream failure normalization + watertight zero-double-billing guards.
// Single source of truth for partial-output detection, closed rawStopReason enum,
// machine failure classification, Path A (afterResponse), and Path B (crash-restart retry guard).
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { CompactionEntry, LiveDoc, SystemEntry, UserEntry } from '@earendil-works/pi-durable';

export const PARTIAL_OUTPUT_STREAM_INTERRUPTED = 'partial_output_stream_interrupted';
export const SAFE_RAW_STOP_REASONS = Object.freeze(['stop', 'length', 'toolUse', 'error', 'aborted', 'content_filter']);
const SAFE_RAW_STOP_REASON_SET = new Set(SAFE_RAW_STOP_REASONS);

// pi-ai recognizes network errors but misses this gateway's premature EOF.
// Classify only that complete diagnostic; unrelated auth, quota, parsing and
// context errors must retain the official policy. Keep the original diagnostic.
const FIRST_RESPONSE_EOF = /^upstream stream ended before first response:\s*(?:unexpected\s+)?eof\s*$/i;
const NORMALIZED_FIRST_RESPONSE_EOF = /^(?:network error:\s*)?upstream stream ended before first response\b/i;
export const STREAM_NO_FINISH_REASON = /ended without (?:a )?(?:finish|stop)[_ ]reason|stream ended before (?:a terminal response event|message_stop)/i;
const STREAM_IDLE_TIMEOUT = /model stream idle timeout/i;
const CONNECTION_FAILURE_PATTERN = /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_PROXY_CONNECTION_FAILED|UND_ERR_CONNECT_TIMEOUT)\b|fetch failed|connection error|proxy response|tunneling socket|failed to connect/i;
const QUOTA_OR_BILLING_PATTERN = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|"code"\s*:\s*"?1308(?![0-9])/i;
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])|ResourceExhausted/i;
const PROVIDER_UNAVAILABLE_PATTERN = /overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|(?<![a-z0-9])(?:502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|unable to forward upstream/i;
const CONTENT_FILTER_ERROR_PATTERN = /\bcontent_filter\b|Provider finish_reason:\s*content_filter|Response incomplete:\s*content_filter|Provider stopped with:\s*(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT|sensitive)\b|The model refused to complete the request/i;

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function hasProducedContent(message) {
  if (!message || typeof message !== 'object') return false;
  if (Array.isArray(message.content) && message.content.some((block) =>
    (block?.type === 'text' && Boolean(block.text))
    || (block?.type === 'thinking' && (Boolean(block.thinking) || Boolean(block.thinkingSignature)))
    || block?.type === 'toolCall',
  )) {
    return true;
  }
  return Number(message.usage?.output || 0) > 0;
}

export function sanitizeRawStopReason(rawStopReason, stopReason) {
  const raw = typeof rawStopReason === 'string' ? rawStopReason.trim().toLowerCase() : '';
  switch (raw) {
    case 'stop':
    case 'end':
    case 'end_turn':
    case 'completed':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'incomplete.max_output_tokens':
      return 'length';
    case 'tooluse':
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'toolUse';
    case 'error':
    case 'failed':
    case 'network_error':
      return 'error';
    case 'aborted':
    case 'cancelled':
    case 'canceled':
      return 'aborted';
    case 'content_filter':
    case 'incomplete.content_filter':
    case 'safety':
    case 'prohibited_content':
    case 'blocklist':
    case 'spii':
    case 'recitation':
    case 'image_safety':
    case 'image_prohibited_content':
    case 'refusal':
    case 'sensitive':
      return 'content_filter';
    default:
      break;
  }
  return typeof stopReason === 'string' && SAFE_RAW_STOP_REASON_SET.has(stopReason) ? stopReason : undefined;
}

export function isContentFilterError(detail, rawStopReason) {
  if (sanitizeRawStopReason(rawStopReason) === 'content_filter') return true;
  const text = String(detail || '').trim();
  return text === 'model_content_filtered' || CONTENT_FILTER_ERROR_PATTERN.test(text);
}

function classifyFailureText(text) {
  if (!text) return null;
  if (text === PARTIAL_OUTPUT_STREAM_INTERRUPTED) return PARTIAL_OUTPUT_STREAM_INTERRUPTED;
  if (text === 'model_output_truncated') return 'model_output_truncated';
  if (isContentFilterError(text)) return 'model_content_filtered';
  if (text === 'provider_quota_exhausted' || QUOTA_OR_BILLING_PATTERN.test(text)) return 'provider_quota_exhausted';
  if (STREAM_NO_FINISH_REASON.test(text)) return 'stream_ended_without_finish_reason';
  if (STREAM_IDLE_TIMEOUT.test(text)) return 'stream_idle_timeout';
  if (NORMALIZED_FIRST_RESPONSE_EOF.test(text)) return 'upstream_eof_before_first_byte';
  if (CONNECTION_FAILURE_PATTERN.test(text)) return 'model_network_error';
  if (RATE_LIMIT_PATTERN.test(text)) return 'provider_rate_limited';
  if (PROVIDER_UNAVAILABLE_PATTERN.test(text)) return 'provider_unavailable';
  return null;
}

export function classifyModelFailureReason(detail, assistant = null) {
  const detailText = String(detail || '').trim();
  const assistantText = String(assistant?.errorMessage || '').trim();
  if (detailText === PARTIAL_OUTPUT_STREAM_INTERRUPTED || assistantText === PARTIAL_OUTPUT_STREAM_INTERRUPTED) {
    return PARTIAL_OUTPUT_STREAM_INTERRUPTED;
  }
  if (assistant?.stopReason === 'length' || detailText === 'model_output_truncated' || assistantText === 'model_output_truncated') {
    return 'model_output_truncated';
  }
  if (sanitizeRawStopReason(assistant?.rawStopReason) === 'content_filter') {
    return 'model_content_filtered';
  }
  return classifyFailureText(detailText) || classifyFailureText(assistantText);
}

export function normalizeModelTransportError(message) {
  if (!message || message.stopReason !== 'error') return null;
  const originalDetail = typeof message.errorMessage === 'string' ? message.errorMessage : '';
  const rawStopReason = sanitizeRawStopReason(message.rawStopReason, message.stopReason);
  if (isContentFilterError(originalDetail, message.rawStopReason)) {
    message.rawStopReason = 'content_filter';
    message.errorMessage = 'model_content_filtered';
    return { kind: 'content_filtered', originalReason: 'model_content_filtered', rawStopReason: 'content_filter' };
  }
  if (hasProducedContent(message)) {
    const originalReason = classifyModelFailureReason(originalDetail, message) || 'model_error';
    if (rawStopReason) message.rawStopReason = rawStopReason;
    // Replace the ENTIRE errorMessage so zero patterns in pi-ai/dist/utils/retry.js match.
    message.errorMessage = PARTIAL_OUTPUT_STREAM_INTERRUPTED;
    return { kind: 'partial_output_interrupted', originalReason, rawStopReason };
  }
  if (originalDetail.trim() === 'provider_quota_exhausted' || QUOTA_OR_BILLING_PATTERN.test(originalDetail)) {
    if (rawStopReason) message.rawStopReason = rawStopReason;
    // Neutralize quota/billing failures (e.g. HTTP 429 Insufficient balance) so pi-ai's
    // RETRYABLE_PROVIDER_ERROR_PATTERN never schedules retries on account/balance exhaustion.
    message.errorMessage = 'provider_quota_exhausted';
    return { kind: 'quota_or_billing', originalReason: 'provider_quota_exhausted', rawStopReason };
  }
  if (typeof message.errorMessage === 'string' && FIRST_RESPONSE_EOF.test(message.errorMessage)) {
    message.errorMessage = `Network error: ${message.errorMessage}`;
  }
  if (rawStopReason) message.rawStopReason = rawStopReason;
  const originalReason = classifyModelFailureReason(message.errorMessage, message) || 'model_error';
  return { kind: 'error', originalReason, rawStopReason };
}

export function recordModelResponseDiagnostics(dispatchDiagnostics, entry, message, normalized) {
  if (!message || (message.stopReason !== 'error' && message.stopReason !== 'length')) return;
  const rawStopReason = message.stopReason === 'length'
    ? (sanitizeRawStopReason(message.rawStopReason, 'length') || 'length')
    : (normalized?.rawStopReason ?? sanitizeRawStopReason(message.rawStopReason, message.stopReason));
  if (message.stopReason === 'length') {
    message.rawStopReason = rawStopReason;
  }
  if (!dispatchDiagnostics?.record) return;
  const baseDiag = {
    turnId: entry?.turn?.turnId,
    canvasId: entry?.canvasId,
    sessionId: entry?.sessionId,
    requestId: entry?.input?.requestId,
    model: message.model,
    status: 'error',
    rawStopReason,
  };
  if (message.stopReason === 'length') {
    dispatchDiagnostics.record({ ...baseDiag, reason: 'model_output_truncated', rawStopReason });
  } else if (normalized?.kind === 'content_filtered') {
    dispatchDiagnostics.record({ ...baseDiag, reason: 'model_content_filtered', rawStopReason: 'content_filter' });
  } else if (normalized?.kind === 'partial_output_interrupted') {
    if (normalized.originalReason && normalized.originalReason !== PARTIAL_OUTPUT_STREAM_INTERRUPTED && normalized.originalReason !== 'model_error') {
      dispatchDiagnostics.record({ ...baseDiag, reason: normalized.originalReason });
    }
    dispatchDiagnostics.record({ ...baseDiag, reason: PARTIAL_OUTPUT_STREAM_INTERRUPTED });
  } else if (normalized?.kind === 'quota_or_billing') {
    dispatchDiagnostics.record({ ...baseDiag, reason: 'provider_quota_exhausted' });
  } else if (normalized?.originalReason && normalized.originalReason !== 'model_error') {
    dispatchDiagnostics.record({ ...baseDiag, reason: normalized.originalReason });
  }
}

export function buildStreamErrorAssistant(model, lastPartial, error, options, fallbackReason = 'model_error') {
  const aborted = Boolean(options?.signal?.aborted);
  const content = Array.isArray(lastPartial?.content) ? lastPartial.content : [];
  const usage = lastPartial?.usage || emptyUsage();
  const rawStopReason = sanitizeRawStopReason(lastPartial?.rawStopReason, aborted ? 'aborted' : 'error');
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: aborted ? 'aborted' : 'error',
    ...(rawStopReason ? { rawStopReason } : {}),
    // Pass through the thrown error so afterResponse / normalizeModelTransportError can inspect
    // content_filter first and record the original sanitized reason before partial-output override.
    errorMessage: error?.reason || error?.message || fallbackReason,
    timestamp: Date.now(),
  };
}

export async function forwardModelEventStream(source, events, model, options, { fallbackReason = 'model_error', onError } = {}) {
  let lastPartial = null;
  try {
    for await (const event of source) {
      if (event?.partial && typeof event.partial === 'object') {
        lastPartial = event.partial;
      } else if (event?.type === 'error' && event.error && typeof event.error === 'object') {
        lastPartial = event.error;
      }
      events.push(event);
    }
    events.end(await source.result());
  } catch (error) {
    await onError?.(error, lastPartial);
    const terminal = buildStreamErrorAssistant(model, lastPartial, error, options, fallbackReason);
    events.push({ type: 'error', reason: terminal.stopReason, error: terminal });
    events.end();
  }
}

export function guardPartialOutputRetry(models, { shouldBlock, onBlocked } = {}) {
  if (!models || typeof shouldBlock !== 'function') return models;
  const guarded = createModels();
  for (const provider of models.getProviders()) {
    const wrap = (fn) => (model, context, options) => {
      const events = createAssistantMessageEventStream();
      void (async () => {
        try {
          if (!options?.signal?.aborted) {
            const blocked = await shouldBlock(model, context, options);
            if (blocked) {
              const rawStopReason = sanitizeRawStopReason(
                typeof blocked === 'object' ? blocked.rawStopReason : undefined,
                'aborted',
              ) || 'aborted';
              await onBlocked?.({ model, rawStopReason });
              const terminal = {
                role: 'assistant',
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: emptyUsage(),
                stopReason: 'error',
                rawStopReason,
                errorMessage: PARTIAL_OUTPUT_STREAM_INTERRUPTED,
                timestamp: Date.now(),
              };
              events.push({ type: 'error', reason: 'error', error: terminal });
              events.end();
              return;
            }
          }
          const source = fn.call(provider, model, context, options);
          await forwardModelEventStream(source, events, model, options);
        } catch (error) {
          const terminal = buildStreamErrorAssistant(model, null, error, options);
          events.push({ type: 'error', reason: terminal.stopReason, error: terminal });
          events.end();
        }
      })();
      return events;
    };
    guarded.setProvider({
      ...provider,
      ...(typeof provider.stream === 'function' ? { stream: wrap(provider.stream) } : {}),
      ...(typeof provider.streamSimple === 'function' ? { streamSimple: wrap(provider.streamSimple) } : {}),
    });
  }
  return guarded;
}

// Path B zero-double-billing guard: after a host crash (interrupted() -> convertPartial -> attempt > 1)
// or a mid-stream graceful restart (request() -> convertPartial -> same GenerationTask),
// short-circuit before issuing any duplicate upstream HTTP call, while leaving compaction
// (which never sets options.onPayload) and user-initiated continue/new inputs (new GenerationTask) unblocked.
export function createPartialOutputRetryGuard({ entry, models, ctx = BACKGROUND_CONTEXT }) {
  return guardPartialOutputRetry(models, {
    shouldBlock: async (_model, _requestContext, options) => {
      if (typeof options?.onPayload !== 'function') return false;
      if (!entry?.root || !entry?.harness) return false;
      const live = await entry.harness.snapshot(LiveDoc, entry.root.id, ctx);
      const attempt = Number(live?.generation?.attempt || 0);
      const currentRunTaskId = live?.run?.taskId;
      if (!(attempt > 1) && currentRunTaskId == null) return false;
      let cursor;
      for (;;) {
        const page = await entry.root.entries({ order: 'descending' }, 64, cursor, ctx);
        const items = page?.items || [];
        if (items.length === 0) return false;
        for (const item of items) {
          if (!item || item.kind === CompactionEntry.kind || item.kind === SystemEntry.kind) continue;
          const msgs = Array.isArray(item.model) ? item.model : [];
          if (item.kind === UserEntry.kind || msgs.some((m) => m?.role === 'user' || m?.role === 'toolResult')) {
            return false;
          }
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const msg = msgs[i];
            if (msg?.role !== 'assistant') continue;
            if (msg.stopReason === 'aborted' && hasProducedContent(msg)) {
              const sameGenerationTask = currentRunTaskId != null && item.byTaskId === currentRunTaskId;
              const retryFallbackWithoutTaskId = attempt > 1 && (currentRunTaskId == null || item.byTaskId == null);
              if (sameGenerationTask || retryFallbackWithoutTaskId) {
                return { blocked: true, rawStopReason: 'aborted' };
              }
            } else if (msg.stopReason && msg.stopReason !== 'error' && msg.stopReason !== 'aborted') {
              return false;
            }
          }
        }
        if (page?.next === undefined) return false;
        cursor = page.next;
      }
    },
  });
}
