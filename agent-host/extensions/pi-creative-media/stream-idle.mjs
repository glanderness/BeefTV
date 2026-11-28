// Scoped SSE content-progress idle watchdog for Pi 1.6.0 provider transports.
// Bounds inactivity on actual text/thinking/tool deltas (ignoring keep-alive
// comments/heartbeats) without mutating globalThis.fetch.
export const DEFAULT_STREAM_IDLE_MS = 95000;

function protocolFor(input, options) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if ((options.method || input.method || 'GET').toUpperCase() !== 'POST') return null;
    if (typeof options.body !== 'string') return null;
    const body = JSON.parse(options.body);
    if (/:streamGenerateContent$/i.test(url.pathname) && url.searchParams.get('alt') === 'sse' && Array.isArray(body.contents)) return 'gemini';
    if (body.stream !== true) return null;
    if (/\/chat\/completions\/?$/.test(url.pathname) && Array.isArray(body.messages)) return 'completions';
    if (/\/responses\/?$/.test(url.pathname) && body.input !== undefined) return 'responses';
    if (/\/messages\/?$/.test(url.pathname) && Array.isArray(body.messages)) return 'anthropic';
  } catch { /* Unknown request formats retain their provider's behavior. */ }
  return null;
}

const hasText = (value) => typeof value === 'string' && value.length > 0;

function isMeaningfulEvent(protocol, data) {
  if (data === '[DONE]') return true;
  let event;
  try { event = JSON.parse(data); } catch { return false; }
  if (!event || typeof event !== 'object') return false;
  if (protocol === 'completions') {
    return (Array.isArray(event.choices) ? event.choices : []).some((choice) => {
      if (!choice || typeof choice !== 'object') return false;
      const delta = choice.delta || {};
      return Boolean(choice.finish_reason)
        || hasText(delta.content)
        || hasText(delta.reasoning_content)
        || hasText(delta.reasoning)
        || hasText(delta.reasoning_text)
        || (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0)
        || (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).some((tool) => tool && (hasText(tool.id) || hasText(tool.function?.name) || hasText(tool.function?.arguments)));
    });
  }
  if (protocol === 'responses') {
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return true;
    if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(event.type)) return hasText(event.delta);
    if (event.type === 'response.function_call_arguments.done') return hasText(event.arguments);
    if (event.type === 'response.custom_tool_call_input.done') return hasText(event.input);
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
      return (Array.isArray(event.item.content) ? event.item.content : []).some((part) => part && (hasText(part.text) || hasText(part.refusal)));
    }
    return event.type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(event.item?.type) && (hasText(event.item.name) || hasText(event.item.call_id));
  }
  if (protocol === 'gemini') {
    const candidates = Array.isArray(event.candidates) ? event.candidates : [];
    return candidates.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      if (candidate.finishReason) return true;
      const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
      return parts.some((part) => part && typeof part === 'object' && (
        hasText(part.text)
        || Boolean(part.functionCall && typeof part.functionCall === 'object' && hasText(part.functionCall.name))
        || hasText(part.thoughtSignature)
      ));
    });
  }
  if (event.type === 'message_stop') return true;
  if (event.type === 'message_delta') return Boolean(event.delta?.stop_reason);
  if (event.type === 'content_block_start') {
    return hasText(event.content_block?.text)
      || hasText(event.content_block?.thinking)
      || hasText(event.content_block?.data)
      || (event.content_block?.type === 'tool_use' && (hasText(event.content_block.name) || hasText(event.content_block.id)));
  }
  if (event.type !== 'content_block_delta') return false;
  return hasText(event.delta?.text) || hasText(event.delta?.thinking) || hasText(event.delta?.signature) || hasText(event.delta?.partial_json);
}

function isTerminalEvent(protocol, data) {
  if (data === '[DONE]') return true;
  let event;
  try { event = JSON.parse(data); } catch { return false; }
  if (!event || typeof event !== 'object') return false;
  if (protocol === 'completions') return (Array.isArray(event.choices) ? event.choices : []).some((choice) => Boolean(choice && typeof choice === 'object' && choice.finish_reason));
  if (protocol === 'responses') return ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type);
  if (protocol === 'gemini') return (Array.isArray(event.candidates) ? event.candidates : []).some((candidate) => Boolean(candidate && typeof candidate === 'object' && candidate.finishReason));
  return event.type === 'message_stop' || (event.type === 'message_delta' && Boolean(event.delta?.stop_reason));
}

function createSSEObserver(protocol, onProgress, onTerminal) {
  const decoder = new TextDecoder();
  let line = '';
  let data = [];
  let bytes = 0;
  let oversized = false;
  let previousCR = false;

  const dispatch = () => {
    if (!oversized && data.length) {
      const payload = data.join('\n');
      if (isMeaningfulEvent(protocol, payload)) onProgress();
      if (isTerminalEvent(protocol, payload)) onTerminal();
    }
    data = [];
    bytes = 0;
    oversized = false;
  };
  const finishLine = () => {
    if (line === '') {
      dispatch();
    } else if (!oversized && line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
    line = '';
  };
  const push = (chunk) => {
    for (const char of decoder.decode(chunk, { stream: true })) {
      if (char === '\n' && previousCR) { previousCR = false; continue; }
      previousCR = char === '\r';
      if (char === '\r' || char === '\n') { finishLine(); continue; }
      if (++bytes > 1024 * 1024) { oversized = true; data = []; line = ''; }
      else if (!oversized) line += char;
    }
  };
  push.flush = () => {
    for (const char of decoder.decode()) {
      if (char === '\r' || char === '\n') finishLine();
      else if (!oversized && ++bytes <= 1024 * 1024) line += char;
    }
    if (line !== '') finishLine();
    if (data.length) dispatch();
  };
  return push;
}

export async function fetchWithContentProgressIdle(
  input,
  options = {},
  { fetch: transport = globalThis.fetch, timeoutMs = DEFAULT_STREAM_IDLE_MS, onSettled } = {},
) {
  let settled = false;
  const settle = (info) => {
    if (settled) return;
    settled = true;
    try { onSettled?.(info); } catch { /* Diagnostic hooks must never interrupt model transport. */ }
  };
  const signals = [options.signal, input instanceof Request ? input.signal : null].filter(Boolean);
  const caller = signals.length ? AbortSignal.any(signals) : null;
  const protocol = protocolFor(input, options);
  if (!protocol) {
    try {
      const response = await transport(input, options);
      settle({ ok: response.ok, httpStatus: response.status });
      return response;
    } catch (error) {
      settle({ ok: false, error });
      throw error;
    }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid model stream idle timeout');
  const local = new AbortController();
  let response;
  try {
    response = await transport(input, { ...options, signal: caller ? AbortSignal.any([caller, local.signal]) : local.signal });
  } catch (error) {
    settle({ ok: false, error });
    throw error;
  }
  if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) {
    settle({ ok: response.ok, httpStatus: response.status });
    return response;
  }
  const reader = response.body.getReader();
  let timer;
  let finished = false;
  let sawTerminal = false;
  let controller;
  const cleanup = () => { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); };
  const terminate = (error) => {
    if (finished) return;
    finished = true;
    cleanup();
    settle({ ok: false, httpStatus: response.status, error });
    controller.error(error);
    local.abort(error);
    void reader.cancel(error).catch(() => {});
  };
  const onAbort = () => terminate(caller.reason || new DOMException('Aborted', 'AbortError'));
  const arm = () => {
    if (finished) return;
    clearTimeout(timer);
    timer = setTimeout(() => terminate(new Error(`Model stream idle timeout: no text or tool progress for ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  };
  const observe = createSSEObserver(protocol, arm, () => { sawTerminal = true; });
  const body = new ReadableStream({
    start(value) {
      controller = value;
      caller?.addEventListener('abort', onAbort, { once: true });
      if (caller?.aborted) onAbort();
      else arm();
    },
    async pull() {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finished = true;
          cleanup();
          observe.flush();
          if (sawTerminal) {
            settle({ ok: true, httpStatus: response.status });
          } else {
            settle({ ok: false, httpStatus: response.status, error: new Error('Model SSE stream ended before terminal event (unexpected EOF)') });
          }
          controller.close();
          return;
        }
        observe(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        terminate(error);
      }
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      cleanup();
      if (caller?.aborted) {
        settle({ ok: false, httpStatus: response.status, error: caller.reason || new DOMException('Aborted', 'AbortError') });
      } else if (reason instanceof Error) {
        settle({ ok: false, httpStatus: response.status, error: reason });
      } else {
        settle({ ok: true, httpStatus: response.status });
      }
      const cancelled = reader.cancel(reason).catch(() => {});
      local.abort(reason);
      return cancelled;
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createScopedStreamIdleFetch({
  fetch: transport = globalThis.fetch,
  timeoutMs = DEFAULT_STREAM_IDLE_MS,
  onSettled,
} = {}) {
  return (input, options = {}) => fetchWithContentProgressIdle(input, options, {
    fetch: transport,
    timeoutMs,
    onSettled,
  });
}
