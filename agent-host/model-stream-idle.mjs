// Bound SSE inactivity on real text/tool progress, without aborting the official
// agent's signal or adding a retry loop.
//
// 为什么不改用 pi 自己的空闲超时（钉选 1.2.0）：
// - pi-ai 把 timeoutMs 交给 OpenAI SDK 的 `timeout`（pi-ai/dist/api/openai-completions.js:194），
//   而 SDK 在 fetch 解析出响应头后立刻 clearTimeout（openai/client.js:996 setTimeout、
//   :1023 finally clearTimeout）——只覆盖到响应头，不约束流正文的空闲。
// - pi-coding-agent 另有 undici bodyTimeout/headersTimeout 级别的 httpIdleTimeoutMs
//   （dist/core/http-dispatcher.js:77-81，docs/settings.md:125），但它只在 CLI/RPC 入口安装
//   （cli/setup.js、rpc-entry.js、modes/interactive/interactive-mode.js:1562），本宿主的
//   Durable 路径不会安装它；即便安装，undici bodyTimeout 按「每收到一段 body 就重置」，
//   SSE 心跳（`: ping`）同样算一段，识别不出「只有心跳、没有内容」。
// 因此保留本实现：只有实际文本/工具进展才重置计时（Durable 路径经 globalThis.fetch 包装生效）。
export const DEFAULT_MODEL_STREAM_IDLE_MS = 95000;

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
const text = value => typeof value === 'string' && value.length > 0;
function meaningful(protocol, data) {
  if (data === '[DONE]') return true;
  let event; try { event = JSON.parse(data); } catch { return false; }
  if (!event || typeof event !== 'object') return false;
  if (protocol === 'completions') return (Array.isArray(event.choices) ? event.choices : []).some(choice => {
    if (!choice || typeof choice !== 'object') return false;
    const delta = choice.delta || {};
    return !!choice.finish_reason || text(delta.content) || text(delta.reasoning_content) || text(delta.reasoning) || text(delta.reasoning_text) ||
      (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).some(tool => tool && (text(tool.id) || text(tool.function?.name) || text(tool.function?.arguments)));
  });
  if (protocol === 'responses') {
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return true;
    if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(event.type)) return text(event.delta);
    if (event.type === 'response.function_call_arguments.done') return text(event.arguments);
    if (event.type === 'response.custom_tool_call_input.done') return text(event.input);
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') return (Array.isArray(event.item.content) ? event.item.content : []).some(part => part && (text(part.text) || text(part.refusal)));
    return event.type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(event.item?.type) && (text(event.item.name) || text(event.item.call_id));
  }
  if (protocol === 'gemini') {
    const candidates = Array.isArray(event.candidates) ? event.candidates : [];
    return candidates.some(candidate => {
      if (!candidate || typeof candidate !== 'object') return false;
      if (candidate.finishReason) return true;
      const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
      return parts.some(part => part && typeof part === 'object' && (
        text(part.text) ||
        Boolean(part.functionCall && typeof part.functionCall === 'object' && text(part.functionCall.name)) ||
        text(part.thoughtSignature)
      ));
    });
  }
  if (event.type === 'message_stop') return true;
  if (event.type === 'message_delta') return !!event.delta?.stop_reason;
  if (event.type === 'content_block_start') return text(event.content_block?.text) || text(event.content_block?.thinking) || text(event.content_block?.data) ||
    (event.content_block?.type === 'tool_use' && (text(event.content_block.name) || text(event.content_block.id)));
  if (event.type !== 'content_block_delta') return false;
  // Thinking text and its closing signature are model progress, as text is.
  return text(event.delta?.text) || text(event.delta?.thinking) || text(event.delta?.signature) || text(event.delta?.partial_json);
}

function isTerminalEvent(protocol, data) {
  if (data === '[DONE]') return true;
  let event; try { event = JSON.parse(data); } catch { return false; }
  if (!event || typeof event !== 'object') return false;
  if (protocol === 'completions') return (Array.isArray(event.choices) ? event.choices : []).some(choice => Boolean(choice && typeof choice === 'object' && choice.finish_reason));
  if (protocol === 'responses') return ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type);
  if (protocol === 'gemini') return (Array.isArray(event.candidates) ? event.candidates : []).some(candidate => Boolean(candidate && typeof candidate === 'object' && candidate.finishReason));
  return event.type === 'message_stop' || (event.type === 'message_delta' && Boolean(event.delta?.stop_reason));
}

// Observe complete SSE records, forwarding the original bytes unchanged. A
// malformed or oversized record cannot keep the stream alive indefinitely.
function observer(protocol, progress, onTerminal) {
  const decoder = new TextDecoder(); let line = '', data = [], bytes = 0, oversized = false, previousCR = false;
  const dispatch = () => {
    if (!oversized && data.length) {
      const payload = data.join('\n');
      if (meaningful(protocol, payload)) progress();
      if (isTerminalEvent(protocol, payload)) onTerminal();
    }
    data = []; bytes = 0; oversized = false;
  };
  const finishLine = () => {
    if (line === '') {
      dispatch();
    } else if (!oversized && line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    line = '';
  };
  const push = chunk => {
    for (const char of decoder.decode(chunk, {stream: true})) {
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

export async function fetchModelWithProgressIdle(input, options = {}, {fetch: transport = globalThis.fetch, timeoutMs = DEFAULT_MODEL_STREAM_IDLE_MS, onSettled} = {}) {
  let settled = false;
  const settle = info => {
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
      // Non-SSE responses settle diagnostic outcomes on response headers without wrapping the body stream.
      settle({ ok: response.ok, httpStatus: response.status });
      return response;
    } catch (error) {
      settle({ ok: false, error });
      throw error;
    }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid model stream idle timeout');
  if (protocol === 'anthropic' && typeof options.body === 'string' && options.body.includes('"tools"')) {
    const beta = 'fine-grained-tool-streaming-2025-05-14';
    if (options.headers instanceof Headers) {
      const headers = new Headers(options.headers);
      const cur = headers.get('anthropic-beta') || '';
      if (!cur.includes(beta)) headers.set('anthropic-beta', cur ? `${cur},${beta}` : beta);
      options = { ...options, headers };
    } else if (options.headers && typeof options.headers === 'object') {
      const headers = { ...options.headers };
      const key = Object.keys(headers).find(k => k.toLowerCase() === 'anthropic-beta') || 'anthropic-beta';
      const cur = String(headers[key] || '').trim();
      if (!cur.includes(beta)) headers[key] = cur ? `${cur},${beta}` : beta;
      options = { ...options, headers };
    }
  }
  const local = new AbortController();
  let response;
  try {
    response = await transport(input, {...options, signal: caller ? AbortSignal.any([caller, local.signal]) : local.signal});
  } catch (error) {
    settle({ ok: false, error });
    throw error;
  }
  if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) {
    // Non-SSE responses settle diagnostic outcomes on response headers without wrapping the body stream.
    settle({ ok: response.ok, httpStatus: response.status });
    return response;
  }
  const reader = response.body.getReader(); let timer, finished = false, sawTerminal = false, controller;
  const cleanup = () => { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); };
  const terminate = error => {
    if (finished) return;
    finished = true; cleanup();
    settle({ ok: false, httpStatus: response.status, error });
    controller.error(error);
    local.abort(error); void reader.cancel(error).catch(() => {});
  };
  const onAbort = () => terminate(caller.reason || new DOMException('Aborted', 'AbortError'));
  const arm = () => {
    if (finished) return;
    clearTimeout(timer);
    timer = setTimeout(() => terminate(new Error(`Model stream idle timeout: no text or tool progress for ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  };
  const observe = observer(protocol, arm, () => { sawTerminal = true; });
  const body = new ReadableStream({
    start(value) { controller = value; caller?.addEventListener('abort', onAbort, {once: true}); if (caller?.aborted) onAbort(); else arm(); },
    async pull() {
      try {
        const next = await reader.read(); if (finished) return;
        if (next.done) {
          finished = true; cleanup();
          observe.flush();
          if (sawTerminal) {
            settle({ ok: true, httpStatus: response.status });
          } else {
            settle({ ok: false, httpStatus: response.status, error: new Error('Model SSE stream ended before terminal event (unexpected EOF)') });
          }
          controller.close();
          return;
        }
        observe(next.value); controller.enqueue(next.value);
      } catch (error) { terminate(error); }
    },
    cancel(reason) {
      if (finished) return;
      finished = true; cleanup();
      if (caller?.aborted) {
        settle({ ok: false, httpStatus: response.status, error: caller.reason || new DOMException('Aborted', 'AbortError') });
      } else if (reason instanceof Error) {
        settle({ ok: false, httpStatus: response.status, error: reason });
      } else {
        settle({ ok: true, httpStatus: response.status });
      }
      const cancelled = reader.cancel(reason).catch(() => {}); local.abort(reason); return cancelled;
    },
  });
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}
