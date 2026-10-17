import { describe, expect, test } from 'bun:test';
import { durableLifecycleState, durableRetryReason, durableStreamEvents } from './durable-session-owner.mjs';

const SECRET = 'sk-synthetic-upstream-secret';

describe('official Durable events projected to the panel stream', () => {
  test('text and tool events keep their existing lines', () => {
    expect(durableStreamEvents({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: '好' }, { type: 'thinking_delta', contentIndex: 1, delta: 'x' }] }))
      .toEqual([{ type: 'text_delta', delta: '好' }]);
    expect(durableStreamEvents({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'media_inspect', args: {} }))
      .toEqual([{ type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' }]);
    expect(durableStreamEvents({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'media_inspect' }))
      .toEqual([{ type: 'lifecycle', phase: 'tool_end', toolName: 'media_inspect' }]);
  });

  test('official retry start/end become retry lifecycle with a classified reason and no upstream text', () => {
    const start = durableStreamEvents({ type: 'auto_retry_start', attempt: 1, at: 1791374400000, errorMessage: `503 upstream detail ${SECRET}` });
    expect(start).toEqual([{ type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'provider_unavailable' }]);
    expect(JSON.stringify(start)).not.toContain(SECRET);
    expect(durableStreamEvents({ type: 'auto_retry_end', attempt: 1 })).toEqual([{ type: 'lifecycle', phase: 'retry_end', attempt: 1 }]);
  });

  test('a snapshot taken during backoff or a running tool restores that progress', () => {
    const backoff = { type: 'snapshot', entries: [], tools: [], generation: { attempt: 2, retry: { at: 1, error: `429 Too Many Requests ${SECRET}` } } };
    expect(durableStreamEvents(backoff)).toEqual([{ type: 'lifecycle', phase: 'retry', attempt: 2, reason: 'rate_limited' }]);
    expect(JSON.stringify(durableStreamEvents(backoff))).not.toContain(SECRET);
    const tool = { type: 'snapshot', entries: [], tools: [{ callId: 'c1', name: 'media_overview', status: 'running' }] };
    expect(durableStreamEvents(tool)).toEqual([{ type: 'lifecycle', phase: 'tool', toolName: 'media_overview' }]);
    expect(durableStreamEvents({ type: 'snapshot', entries: [], tools: [{ callId: 'c1', name: 'media_overview', status: 'done' }] })).toEqual([]);
  });

  test('retry reasons are a closed set', () => {
    for (const [message, reason] of [
      ['stream idle timeout after 95000ms', 'timeout'], ['Request timed out.', 'timeout'],
      ['429 rate limit reached', 'rate_limited'], ['Too Many Requests', 'rate_limited'],
      ['503 Service Unavailable', 'provider_unavailable'], ['overloaded_error', 'provider_unavailable'], ['502 Bad Gateway', 'provider_unavailable'],
      ['fetch failed', 'network'], ['socket hang up', 'network'], ['terminated', 'network'], ['Connection error.', 'network'],
      ['unexpected provider wording', 'model_error'], [undefined, 'model_error'],
    ]) expect(durableRetryReason(message)).toBe(reason);
  });
});

describe('latest transient progress kept for history polling', () => {
  const retry = { type: 'lifecycle', phase: 'retry', attempt: 1, reason: 'timeout' };
  const tool = { type: 'lifecycle', phase: 'tool', toolName: 'media_inspect' };
  test('start sets, matching end clears, unrelated events keep the current state', () => {
    let state = durableLifecycleState(null, { type: 'auto_retry_start', attempt: 1, at: 1, errorMessage: 'stream idle timeout' });
    expect(state).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'message_update', changes: [] })).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'media_inspect' })).toEqual(retry);
    expect(durableLifecycleState(state, { type: 'auto_retry_end', attempt: 1 })).toBeNull();
    state = durableLifecycleState(null, { type: 'tool_execution_start', toolName: 'media_inspect' });
    expect(state).toEqual(tool);
    expect(durableLifecycleState(state, { type: 'tool_execution_end', toolName: 'media_inspect' })).toBeNull();
  });
  test('a snapshot replaces stale progress', () => {
    expect(durableLifecycleState(retry, { type: 'snapshot', entries: [], tools: [] })).toBeNull();
    expect(durableLifecycleState(null, { type: 'snapshot', entries: [], tools: [], generation: { attempt: 1, retry: { at: 1, error: 'stream idle timeout' } } })).toEqual(retry);
  });
});
