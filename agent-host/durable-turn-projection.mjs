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

/** 宿主与模型的已知凭据：公开出口不能把它们原样转发出去。 */
export function hostCredentialValues(env = process.env) {
  return [env.BEEFTV_AGENT_HOST_TOKEN, env.BEEFTV_AGENT_DESKTOP_TOKEN, env.BEEFTV_AGENT_API_KEY]
    .map((value) => String(value ?? '').trim()).filter((value) => value.length >= 6);
}

// 明确格式的凭据：密钥前缀、Bearer 头，以及“名字 = 值”形式的 key/token/secret/password。
// 只覆盖已知值与可判定的格式，不承诺识别任意自然语言里的秘密。
const CREDENTIAL_NAME = '(?:api[_-]?key|authorization|x-beeftv-agent-token|x-desktop-token|host[_-]?token|desktop[_-]?token|access[_-]?token|secret|password)';
const CREDENTIAL_FORMATS = [
  [/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/gi, 'Bearer [REDACTED]'],
  [new RegExp(`(["']?${CREDENTIAL_NAME}["']?\\s*[:=]\\s*)(["'])([^"']*)(\\2)`, 'gi'), '$1$2[REDACTED]$4'],
  // 未加引号的值：跳过 Bearer 这类方案词，它由上面的规则处理。
  [new RegExp(`(\\b${CREDENTIAL_NAME}\\b\\s*[:=]\\s*)(?!Bearer\\b)([^\\s"'，。；,;）)]{6,})`, 'gi'), '$1[REDACTED]'],
];

/**
 * 已知秘密的未完整前缀先扣住：分片到达时不能先把前缀发出去，再等后面的分片来替换。
 * 只在秘密可能从一个值或词的开头出现时扣住（前面不是单词字符），避免正常词尾被反复截断。
 * 已经写完的块也照此处理：宁可少显示末尾几个字符，也不把可能的前缀发到界面上。
 */
function deferPartialSecret(text, secrets) {
  for (const secret of secrets) {
    for (let length = secret.length - 1; length > 0; length -= 1) {
      const prefix = secret.slice(0, length);
      if (!text.endsWith(prefix)) continue;
      const before = text[text.length - length - 1];
      if (before !== undefined && /\w/.test(before)) continue;
      return text.slice(0, text.length - length);
    }
  }
  return text;
}

/** 公开思考文本：已知宿主／模型凭据与明确凭据格式都不出现在展示出口。 */
export function publicThinkingText(raw, secrets = hostCredentialValues()) {
  let out = typeof raw === 'string' ? raw : '';
  if (!out) return '';
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  for (const [pattern, replacement] of CREDENTIAL_FORMATS) out = out.replace(pattern, replacement);
  return deferPartialSecret(out, secrets);
}

/** 展示用的可读思考：redacted、空文本和只剩未完整凭据前缀的块都不算。 */
function publicThinking(message, secrets) {
  return readableThinking(message).map(({ contentIndex, text }) => ({ contentIndex, text: publicThinkingText(text, secrets) }))
    .filter(({ text }) => text.length > 0);
}

/** 终态与历史回合的思考片段：与实时流同形，已结束的块一律是 done。 */
export function durableReasoningSegments(entries, secrets = hostCredentialValues()) {
  return (entries || []).flatMap((entry) => {
    const assistant = entry?.model?.[0];
    if (assistant?.role !== 'assistant') return [];
    return publicThinking(assistant, secrets).map(({ contentIndex, text }) => ({ id: `${entry.id}:${contentIndex}`, text, status: 'done' }));
  });
}

// Durable publishes whole messages/blocks as well as append deltas. Keep one
// current-turn projection so replacement and overflow snapshots cannot duplicate text.
export function createDurableTurnProjection({ secrets = hostCredentialValues() } = {}) {
  let afterEntry = Infinity;
  let completed = new Map();
  let message = null;
  // 进行中消息的临时身份：message_end 后由对应 entry 取代这一槽，不拿它当会话唯一 ID。
  let messageSerial = 0;
  let text = '';
  let reasoning = [];
  // 已经推送过可读思考：之后变空要发空数组让界面清掉旧内容，从来没有过则不发空事件。
  let published = false;
  let initialized = false;

  // 一个正在生成的消息里只有最后一块还在长，其余思考块已经写完。
  const segmentsOf = (owner, thinking, streamingIndex) => thinking.map(({ contentIndex, text: body }) => ({
    id: `${owner}:${contentIndex}`, text: body, status: contentIndex === streamingIndex ? 'streaming' : 'done' }));

  const compose = () => {
    const entries = [...completed.entries()];
    return {
      text: [...entries.map(([, entry]) => visibleTextOf(entry)), visibleTextOf(message)].filter(Boolean).join('\n\n'),
      reasoning: [
        ...entries.flatMap(([entryId, entry]) => segmentsOf(entryId, publicThinking(entry, secrets), -1)),
        ...(message ? segmentsOf(`live-${messageSerial}`, publicThinking(message, secrets), message.content.length - 1) : []),
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
      // 已经推送过可读思考后变空（块被替换成空或 redacted）则必须发完整空数组，否则界面留着旧内容。
      if (JSON.stringify(next.reasoning) !== JSON.stringify(reasoning) && (next.reasoning.length > 0 || published)) {
        payloads.push({ type: 'reasoning_snapshot', segments: next.reasoning });
      }
      if (next.reasoning.length) published = true;
      initialized = true;
      text = next.text;
      reasoning = next.reasoning;
      return payloads;
    },
  };
}
