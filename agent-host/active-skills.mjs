// 活动技能恢复与指针投影：
// 1. 压缩阶段由 durable-compaction.mjs 写入持久技能指针（formatActiveSkillPointers），保留技能身份；
// 2. 当有损压缩导致完整技能正文不在当前可见消息内时，在本次请求前按窗口预算临时补回，
//    并由 Models 层的 guardSkillModelRequests 继续做安全完整性校验。
import { SKILL_PAGE_MAX_BYTES, formatSkillBlock } from './skill-resource.mjs';

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
}

// 供 CompactionTask.beforeCompact 使用的技能指针清单（单一真相来源）。
export function formatActiveSkillPointers(resources = []) {
  const seen = new Set();
  const lines = [];
  for (const item of resources || []) {
    const pin = item?.pin || item || {};
    if (!pin.skillId || !pin.versionId || !pin.contentHash) continue;
    const key = `${pin.skillId}@${pin.versionId}:${pin.contentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String(item?.name || pin.skillName || pin.skillId).trim();
    const version = String(item?.version || '').trim();
    lines.push(`- ${label} (skillId=${pin.skillId}, versionId=${pin.versionId}${version ? `, version=${version}` : ''}, contentHash=${pin.contentHash})`);
  }
  return lines.join('\n');
}

// 正文是否仍在可见消息里：以技能块的 versionId + contentHash 为准（formatSkillBlock 的固定属性）。
export function skillBlockVisible(messages, recordOrResource) {
  const pin = recordOrResource?.pin || recordOrResource || {};
  const needle = `versionId="${pin.versionId}" contentHash="${pin.contentHash}"`;
  return messages.some(
    (message) =>
      (message.role === 'user' || message.role === 'toolResult' || message.role === 'tool') &&
      messageText(message).includes(needle),
  );
}

export function missingSkillResources(messages, resources = [], contextWindow) {
  const missing = (resources || []).filter((resource) => !skillBlockVisible(messages, resource));
  return missing.length > 0 ? fitRestoredSkills(missing, contextWindow) : [];
}

// 补回消息：用同一个官方格式的技能块，前面写明原因，避免模型当成新要求。
export function restoredSkillMessage(resources, now = Date.now()) {
  const text = ['[系统恢复：以下技能之前已加载，因对话被压缩，原文补回。继续按它的步骤、数量和画幅限制执行；用户换了话题就不再适用。]',
    ...resources.map(formatSkillBlock)].join('\n\n');
  return { role: 'user', content: [{ type: 'text', text }], timestamp: now };
}

// 总大小护栏：补回内容不超过模型窗口的 1/5，超出则只补最近一个。
export function fitRestoredSkills(resources, contextWindow) {
  const budget = Math.floor((Number(contextWindow) || 0) / 5);
  if (!budget) return resources.slice(-1);
  const kept = [];
  let bytes = 0;
  for (const resource of [...resources].reverse()) {
    bytes += Math.min(SKILL_PAGE_MAX_BYTES, Buffer.byteLength(resource.instruction || '', 'utf8'));
    if (kept.length && bytes > budget) break;
    kept.unshift(resource);
  }
  return kept;
}
