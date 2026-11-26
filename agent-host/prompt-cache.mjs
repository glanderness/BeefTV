// 提示词缓存与会话亲和性：走官方 GenerationTask.beforeProviderRequest 钩子。
// 1. Anthropic 会话固定 metadata.user_id 维持渠道亲和性；
// 2. 把 pi-ai 落在末尾易变 <beeftv_studio>/<beeftv_plan> 尾块上的 cache_control
//    前移到紧邻的前一个稳定历史块上，避免每次画布 revision 推进都整段缓存失效。
import { isTransientStudioTailText } from './studio-digest.mjs';

const VALID_CACHE_RETENTIONS = new Set(['none', 'short', 'long']);
const ANTHROPIC_CACHEABLE_TYPES = new Set(['text', 'image', 'tool_result', 'tool_use', 'tool_addition', 'tool_removal']);
const OPENAI_CACHEABLE_TYPES = new Set(['text']);

export function resolveHostCacheRetention(env = process.env) {
  const raw = String(env?.BEEFTV_AGENT_CACHE_RETENTION || '').trim().toLowerCase();
  return VALID_CACHE_RETENTIONS.has(raw) ? raw : 'long';
}

function isCacheableBlock(block, api) {
  if (!block || typeof block !== 'object') return false;
  if (api === 'anthropic-messages') {
    return ANTHROPIC_CACHEABLE_TYPES.has(block.type);
  }
  return OPENAI_CACHEABLE_TYPES.has(block.type);
}

function attachCacheControlToMessage(message, api, marker) {
  if (!message || typeof message !== 'object') return null;
  if (message.role === 'system' || message.role === 'developer') return null;
  if (Array.isArray(message.content)) {
    for (let i = message.content.length - 1; i >= 0; i -= 1) {
      const block = message.content[i];
      if (!isCacheableBlock(block, api)) continue;
      if (block.type === 'text' && isTransientStudioTailText(block.text)) continue;
      const nextContent = message.content.slice();
      nextContent[i] = { ...block, cache_control: marker };
      return { ...message, content: nextContent };
    }
    return null;
  }
  if (typeof message.content === 'string' && message.content.length > 0 && !isTransientStudioTailText(message.content)) {
    return {
      ...message,
      content: [{ type: 'text', text: message.content, cache_control: marker }],
    };
  }
  return null;
}

export function adaptProviderPromptCache(payload, api, { sessionId = '' } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  let next = payload;
  if (api === 'anthropic-messages' && sessionId && !payload.metadata?.user_id) {
    next = {
      ...next,
      metadata: { ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}), user_id: sessionId },
    };
  }
  if (api !== 'anthropic-messages' && api !== 'openai-completions') return next;
  const messages = next.messages;
  if (!Array.isArray(messages) || messages.length === 0) return next;
  // Pi 1.6.0 对 supportsMidConvoEffort 的 Claude 5 系列会在末尾追加 { role: 'system', content: [], output_config }，
  // 跳过末尾控制性 system 消息以定位最后一条 user 消息。
  let lastIdx = messages.length - 1;
  while (lastIdx >= 0 && messages[lastIdx]?.role === 'system') lastIdx -= 1;
  if (lastIdx < 0) return next;
  const lastMsg = messages[lastIdx];
  if (!lastMsg || lastMsg.role !== 'user' || !Array.isArray(lastMsg.content) || lastMsg.content.length === 0) {
    return next;
  }
  const tailIdx = lastMsg.content.length - 1;
  const tailBlock = lastMsg.content[tailIdx];
  if (!tailBlock || tailBlock.type !== 'text' || !tailBlock.cache_control || !isTransientStudioTailText(tailBlock.text)) {
    return next;
  }
  const marker = tailBlock.cache_control;
  const { cache_control: _dropped, ...cleanTail } = tailBlock;
  const nextLastContent = lastMsg.content.slice();
  nextLastContent[tailIdx] = cleanTail;

  // 1. 优先落回同一条合并后 user 消息里紧邻的前一个稳定内容块（Anthropic 常把相邻 user/tool_result 合并）
  let placed = false;
  for (let i = tailIdx - 1; i >= 0; i -= 1) {
    const candidate = nextLastContent[i];
    if (!isCacheableBlock(candidate, api)) continue;
    if (candidate.type === 'text' && isTransientStudioTailText(candidate.text)) continue;
    nextLastContent[i] = { ...candidate, cache_control: marker };
    placed = true;
    break;
  }

  const nextMessages = messages.slice();
  nextMessages[lastIdx] = { ...lastMsg, content: nextLastContent };

  // 2. 如果最后一条消息里只有易变尾块，则落回前一条稳定对话消息的最后一个可缓存块
  if (!placed) {
    for (let m = lastIdx - 1; m >= 0; m -= 1) {
      const updated = attachCacheControlToMessage(nextMessages[m], api, marker);
      if (updated) {
        nextMessages[m] = updated;
        break;
      }
    }
  }

  return { ...next, messages: nextMessages };
}
