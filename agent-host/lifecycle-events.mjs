// 把官方 AgentSession 事件收成宿主 NDJSON。
// agent_end 只表示一次底层 run 结束，仍可能自动重试/压缩恢复；终态用 agent_settled + message_end + prompt 错误。

export function mapSessionEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    return { type: 'text_delta', delta: event.assistantMessageEvent.delta };
  }
  if (event.type === 'compaction_start') {
    return { type: 'lifecycle', phase: 'compaction', reason: event.reason };
  }
  if (event.type === 'compaction_end') {
    return { type: 'lifecycle', phase: 'compaction_end', reason: event.reason, aborted: Boolean(event.aborted), willRetry: Boolean(event.willRetry) };
  }
  if (event.type === 'auto_retry_start') {
    return { type: 'lifecycle', phase: 'retry', attempt: event.attempt, maxAttempts: event.maxAttempts };
  }
  if (event.type === 'auto_retry_end') {
    return { type: 'lifecycle', phase: 'retry_end', success: Boolean(event.success), attempt: event.attempt };
  }
  return null;
}

export function createTurnObserver() {
  let lastAssistantMessage = null;
  let settled = false;
  let lastAgentEnd = null;
  return {
    get lastAssistantMessage() { return lastAssistantMessage; },
    get settled() { return settled; },
    get lastAgentEnd() { return lastAgentEnd; },
    handle(event) {
      if (event?.type === 'message_end' && event.message?.role === 'assistant') {
        lastAssistantMessage = event.message;
        return null;
      }
      if (event?.type === 'agent_settled') {
        settled = true;
        return null;
      }
      if (event?.type === 'agent_end') {
        lastAgentEnd = event;
        return null;
      }
      return mapSessionEvent(event);
    },
  };
}
