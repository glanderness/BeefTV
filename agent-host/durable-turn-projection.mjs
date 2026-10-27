// 这一回合唯一的展示投影：可见正文与可读思考都从同一份官方事件里出。
// 实时、终态与重开历史共用这里的形状，界面不另建只会拼字符串的 reasoning reducer。
const visibleTextOf = (message) => message?.role === 'assistant'
  ? (message.content || []).filter((block) => block?.type === 'text').map((block) => block.text || '').join('') : '';

// 只留展示需要的字段：签名、redacted 载荷、工具参数与上游错误都不进投影。
function projectBlock(block) {
  if (block?.type === 'thinking') return { type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', redacted: block.redacted === true };
  if (block?.type === 'text') return { type: 'text', text: typeof block.text === 'string' ? block.text : '' };
  return { type: 'text', text: '' };
}

function projectMessage(message) {
  return message?.role === 'assistant' ? { role: 'assistant', content: (message.content || []).map(projectBlock) } : null;
}

/**
 * 官方已经给到用户的可读思考：redacted 与空文本都不算。
 * 这里只读 thinking 正文，不读签名，也不解码任何不透明载荷。
 */
export function readableThinking(message) {
  if (message?.role !== 'assistant') return [];
  return (message.content || []).flatMap((block, contentIndex) => block?.type === 'thinking' && block.redacted !== true
    && typeof block.thinking === 'string' && block.thinking.trim() ? [{ contentIndex, text: block.thinking }] : []);
}

/** 终态与历史回合的思考片段：与实时流同形，已结束的块一律是 done。 */
export function durableReasoningSegments(assistant) {
  return readableThinking(assistant).map(({ contentIndex, text }) => ({ id: `reasoning:${contentIndex}`, text, status: 'done' }));
}

// Durable publishes whole messages/blocks as well as append deltas. Keep one
// current-turn projection so replacement and overflow snapshots cannot duplicate text.
export function createDurableTurnProjection() {
  let afterEntry = Infinity;
  let completed = new Map();
  let message = null;
  // 进行中消息的临时身份：message_end 后由对应 entry 取代这一槽，不拿它当会话唯一 ID。
  let messageSerial = 0;
  let text = '';
  let reasoning = [];
  let initialized = false;

  // 一个正在生成的消息里只有最后一块还在长，其余思考块已经写完。
  const segmentsOf = (owner, thinking, streamingIndex) => thinking.map(({ contentIndex, text: body }) => ({
    id: `${owner}:${contentIndex}`, text: body, status: contentIndex === streamingIndex ? 'streaming' : 'done' }));

  const compose = () => {
    const entries = [...completed.entries()];
    return {
      text: [...entries.map(([, entry]) => visibleTextOf(entry)), visibleTextOf(message)].filter(Boolean).join('\n\n'),
      reasoning: [
        ...entries.flatMap(([entryId, entry]) => segmentsOf(entryId, readableThinking(entry), -1)),
        ...(message ? segmentsOf(`live-${messageSerial}`, readableThinking(message), message.content.length - 1) : []),
      ],
    };
  };

  return {
    get text() { return text; },
    get reasoning() { return reasoning; },
    get initialized() { return initialized; },
    accept(event) {
      switch (event?.type) {
        case 'snapshot':
          if (event.afterEntry !== undefined) afterEntry = event.afterEntry;
          completed = new Map((event.entries || []).filter((entry) => entry.id > afterEntry)
            .map((entry) => [entry.id, projectMessage(entry.model?.[0])]));
          message = projectMessage(event.generation?.message);
          if (message) messageSerial += 1;
          break;
        case 'message_start':
          if (event.message?.role !== 'assistant') return [];
          message = projectMessage(event.message);
          messageSerial += 1;
          break;
        case 'message_update':
          for (const change of event.changes || []) {
            if (change.type === 'message') {
              message = projectMessage(change.message);
              if (message) messageSerial += 1;
              continue;
            }
            if (!message) message = { role: 'assistant', content: [] };
            // 正文与思考各自成块；工具参数、签名和上游错误留在官方记录里。
            if (change.type === 'text_start' || change.type === 'thinking_start' || change.type === 'block') {
              message.content[change.contentIndex] = projectBlock(change.block);
            } else if (change.type === 'text_delta') {
              const previous = message.content[change.contentIndex];
              message.content[change.contentIndex] = { type: 'text', text: (previous?.type === 'text' ? previous.text : '') + change.delta };
            } else if (change.type === 'thinking_delta') {
              const previous = message.content[change.contentIndex];
              const open = previous?.type === 'thinking' ? previous : null;
              // redacted 是块的属性：追加增量不能把它变成可读内容。
              message.content[change.contentIndex] = { type: 'thinking', thinking: (open?.thinking || '') + change.delta, redacted: open?.redacted === true };
            }
          }
          break;
        case 'message_end':
          if (event.entry?.model?.[0]?.role !== 'assistant' || event.entry.id <= afterEntry) return [];
          completed.set(event.entry.id, projectMessage(event.entry.model[0]));
          message = null;
          break;
        default: return [];
      }
      const next = compose();
      const payloads = [];
      if (!initialized || next.text !== text) payloads.push({ type: 'text_snapshot', text: next.text });
      // 没有可读思考就不发空快照：界面据此不生成空的思考抽屉。
      if (next.reasoning.length && JSON.stringify(next.reasoning) !== JSON.stringify(reasoning)) {
        payloads.push({ type: 'reasoning_snapshot', segments: next.reasoning });
      }
      initialized = true;
      text = next.text;
      reasoning = next.reasoning;
      return payloads;
    },
  };
}
