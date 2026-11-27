// 生产态创作工作室上下文压缩扩展：通过官方 CompactionTask.beforeCompact 钩子接入。
// 1. 显式保留画布 ID、分镜/镜头计划、全部已引用/确认的 resourceId 与角色/场景/风格资产、
//    用户风格/画幅/对白约束、进行中/待确认任务 ID 与活动技能指针；
// 2. 用量严格经公开导出 UsageDoc + api.commit 记账（绝不深导内部 harness/usage.js）；
// 3. 摘要模型调用包裹在 try/catch 中，任何瞬态错误或空输出返回 undefined，无缝交回官方 CompactionTask 重试循环。
import { CompactionTask, ProviderDoc, UsageDoc, defineExtension, hook } from '@earendil-works/pi-durable';
import { renderPlanSection } from './plan.mjs';
import { formatActiveSkillPointers } from './active-skills.mjs';
import { MediaRetentionDoc } from './studio-digest.mjs';

const TOOL_RESULT_MAX_CHARS = 2400;

export const CREATIVE_COMPACTION_SYSTEM_PROMPT = `你是 AI 影视与短剧工作台（BeefTV）的上下文压缩助手。你的任务是阅读用户与创作助手之间的历史对话，生成一份结构化、可直接续作的创作状态检查点摘要。

严禁继续对话，严禁回答对话中的问题，只输出结构化摘要正文。必须精确保留所有标识（canvasId、nodeId、resourceId、assetId、taskId、proposalId、skillId、versionId、contentHash）与机器错误码，严禁编造或改写。`;

export function serializeCreativeTranscript(messages) {
  const parts = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      const text = extractText(message.content);
      if (text) parts.push(`[User]: ${text}`);
    } else if (message.role === 'assistant') {
      const text = (message.content || [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
        .map((block) => block.text);
      const calls = (message.content || [])
        .filter((block) => block?.type === 'toolCall')
        .map((block) => {
          const args = block.arguments && typeof block.arguments === 'object'
            ? Object.entries(block.arguments).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
            : '';
          return `${block.name}(${args})`;
        });
      if (text.length) parts.push(`[Assistant]: ${text.join('\n')}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`);
    } else if (message.role === 'toolResult') {
      const text = extractText(message.content);
      if (text) {
        const clipped = text.length > TOOL_RESULT_MAX_CHARS
          ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[... 省略 ${text.length - TOOL_RESULT_MAX_CHARS} 字符]`
          : text;
        parts.push(`[Tool result]: ${clipped}`);
      }
    }
  }
  return parts.join('\n\n');
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function buildCreativeCompactionPrompt({
  messages,
  canvasId = '',
  planText = '',
  activeSkillPointers = '',
  instructions = '',
}) {
  const transcript = serializeCreativeTranscript(messages);
  const studioContext = [
    canvasId ? `- 当前画布 canvasId: ${canvasId}` : '',
    planText ? `- 当前持久化制作计划:\n${planText}` : '',
    activeSkillPointers ? `- 当前激活技能指针:\n${activeSkillPointers}` : '',
  ].filter(Boolean).join('\n');

  const extraInstructions = String(instructions || '').trim();
  return [
    `<conversation>\n${transcript}\n</conversation>`,
    studioContext ? `<studio_state>\n${studioContext}\n</studio_state>` : '',
    `压缩较早的对话记录时，请把上面的创作对话压缩成一份结构化检查点摘要，供后续模型无缝接续制作。如果对话开头已有早期摘要，请合并并更新它。

严格使用以下结构：

## 画布与分镜计划
- canvasId、当前创作目标、分镜/镜头结构与已完成/进行中/待做步骤

## 已确认资产与素材标识
- 逐项保留全部已引用或已确认的 resourceId、assetId、nodeId，以及角色/场景/风格/首尾帧参考绑定关系（无则写 "(无)"）

## 风格、画幅与对白约束
- 用户明确的画风、画幅比例、分辨率、角色一致性、镜头节奏、对白/配音/字幕约束与明确禁止项

## 进行中与待确认任务
- 全部进行中、待确认、等待生成或失败待恢复的 taskId、proposalId 与精确报错原因（绝不丢弃已有 taskId 以免重复扣费）

## 激活技能与资源指针
- 当前已激活的 Skill 名称、skillId、versionId、contentHash 及已读关键规则/脚本资源指针（无则写 "(无)"）

## 关键决策与下一步
- 已定稿决策与下一条应立即执行的步骤`,
    extraInstructions ? `补充压缩要求：${extraInstructions}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function recordUsageToUsageDoc(api, message, context) {
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return;
  const modelKey = `${message.provider || 'unknown'}/${message.model || 'unknown'}`;
  await api.commit(async (tx) => {
    const doc = await tx.doc(UsageDoc, api.conversationId);
    if (!doc.models || typeof doc.models !== 'object') doc.models = {};
    const existing = Object.hasOwn(doc.models, modelKey) ? doc.models[modelKey] : undefined;
    if (!existing) {
      doc.models[modelKey] = {
        input: Number(usage.input) || 0,
        output: Number(usage.output) || 0,
        cacheRead: Number(usage.cacheRead) || 0,
        cacheWrite: Number(usage.cacheWrite) || 0,
        totalTokens: Number(usage.totalTokens) || 0,
        ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: Number(usage.cacheWrite1h) || 0 } : {}),
        ...(usage.reasoning !== undefined ? { reasoning: Number(usage.reasoning) || 0 } : {}),
        cost: {
          input: Number(usage.cost?.input) || 0,
          output: Number(usage.cost?.output) || 0,
          cacheRead: Number(usage.cost?.cacheRead) || 0,
          cacheWrite: Number(usage.cost?.cacheWrite) || 0,
          total: Number(usage.cost?.total) || 0,
        },
      };
      return undefined;
    }
    existing.input = (Number(existing.input) || 0) + (Number(usage.input) || 0);
    existing.output = (Number(existing.output) || 0) + (Number(usage.output) || 0);
    existing.cacheRead = (Number(existing.cacheRead) || 0) + (Number(usage.cacheRead) || 0);
    existing.cacheWrite = (Number(existing.cacheWrite) || 0) + (Number(usage.cacheWrite) || 0);
    existing.totalTokens = (Number(existing.totalTokens) || 0) + (Number(usage.totalTokens) || 0);
    if (usage.cacheWrite1h !== undefined) {
      existing.cacheWrite1h = (Number(existing.cacheWrite1h) || 0) + (Number(usage.cacheWrite1h) || 0);
    }
    if (usage.reasoning !== undefined) {
      existing.reasoning = (Number(existing.reasoning) || 0) + (Number(usage.reasoning) || 0);
    }
    if (!existing.cost || typeof existing.cost !== 'object') {
      existing.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    }
    existing.cost.input = (Number(existing.cost.input) || 0) + (Number(usage.cost?.input) || 0);
    existing.cost.output = (Number(existing.cost.output) || 0) + (Number(usage.cost?.output) || 0);
    existing.cost.cacheRead = (Number(existing.cost.cacheRead) || 0) + (Number(usage.cost?.cacheRead) || 0);
    existing.cost.cacheWrite = (Number(existing.cost.cacheWrite) || 0) + (Number(usage.cost?.cacheWrite) || 0);
    existing.cost.total = (Number(existing.cost.total) || 0) + (Number(usage.cost?.total) || 0);
    return undefined;
  }, context);
}

function cleanSummaryText(message) {
  if (!message || message.stopReason !== 'stop') return undefined;
  if (Array.isArray(message.content) && message.content.some((block) => block?.type === 'toolCall')) {
    return undefined;
  }
  const text = extractText(message.content);
  return text.length > 0 ? text : undefined;
}

function appendMissingAnchors(summary, { canvasId, activeSkillPointers }) {
  const extras = [];
  if (canvasId && !summary.includes(canvasId)) {
    extras.push(`canvasId: ${canvasId}`);
  }
  if (activeSkillPointers) {
    const missingLines = activeSkillPointers
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !summary.includes(line));
    if (missingLines.length > 0) {
      extras.push(`已激活技能指针:\n${missingLines.join('\n')}`);
    }
  }
  return extras.length > 0 ? `${summary}\n\n---\n${extras.join('\n')}` : summary;
}

export function createCreativeCompactionExtension({ entry, state, skills, resolveActiveSkills }) {
  return defineExtension({
    name: 'beeftv.compaction.v1',
    hooks: [hook(CompactionTask, {
      beforeCompact: async (compaction, api, context) => {
        const agent = await api.agent(context);
        const ref = agent?.model;
        const model = ref ? api.models.getModel(ref.provider, ref.modelId) : undefined;
        if (!ref || !model) return undefined;

        const doc = await state(entry).catch(() => null);
        const planText = renderPlanSection(doc?.plan) || '';

        let activeResources = [];
        if (skills && typeof resolveActiveSkills === 'function') {
          try {
            const skillTurnId = entry.busy ? (entry.turn?.turnId || '') : '';
            const projection = await resolveActiveSkills(entry, api.signal || context.abortSignal, skillTurnId);
            activeResources = projection?.resources || [];
          } catch {
            // 压缩时技能上下文读取不可用则降级使用已记录的 loadedSkills 指针，绝不阻塞压缩。
            activeResources = (doc?.loadedSkills || []).map((item) => ({
              pin: { skillId: item.skillId, versionId: item.versionId, contentHash: item.contentHash },
              name: item.name || item.skillId,
              version: item.version || '',
            }));
          }
        } else if (Array.isArray(doc?.loadedSkills) && doc.loadedSkills.length > 0) {
          activeResources = doc.loadedSkills.map((item) => ({
            pin: { skillId: item.skillId, versionId: item.versionId, contentHash: item.contentHash },
            name: item.name || item.skillId,
            version: item.version || '',
          }));
        }
        const activeSkillPointers = formatActiveSkillPointers(activeResources);

        const reserveTokens = Number(
          agent?.compaction?.reserveTokens
          ?? api.settings?.compaction?.reserveTokens
          ?? 16384,
        );
        const maxTokens = Math.min(
          Math.max(512, Math.floor(0.8 * reserveTokens)),
          model.maxTokens > 0 ? model.maxTokens : 8192,
        );
        const providerDoc = await api.snapshot(ProviderDoc, api.conversationId, context).catch(() => null);
        const now = api.now();
        const promptText = buildCreativeCompactionPrompt({
          messages: compaction.messages,
          canvasId: entry.canvasId,
          planText,
          activeSkillPointers,
          instructions: compaction.instructions,
        });
        const messages = [
          { role: 'system', content: CREATIVE_COMPACTION_SYSTEM_PROMPT, timestamp: now },
          { role: 'user', content: [{ type: 'text', text: promptText }], timestamp: now },
        ];
        const { deferred: _deferred, ...forwardedStream } = api.settings?.stream || {};
        const options = {
          ...forwardedStream,
          cacheRetention: 'none',
          maxTokens,
          signal: api.signal || context.abortSignal,
          telemetry: context.telemetry,
          sessionId: providerDoc?.sessionId || entry.sessionId,
          ...(agent.thinkingLevel && agent.thinkingLevel !== 'off' ? { reasoning: agent.thinkingLevel } : {}),
        };

        entry.compactingHookCount = (entry.compactingHookCount || 0) + 1;
        try {
          const message = await api.models.completeSimple(model, { messages }, options);
          (api.signal || context.abortSignal)?.throwIfAborted?.();
          await recordUsageToUsageDoc(api, message, context).catch(() => {});
          const rawSummary = cleanSummaryText(message);
          if (!rawSummary) {
            // 非 stop、含工具调用或空摘要时返回 undefined，交回官方 CompactionTask 瞬态重试循环。
            return undefined;
          }
          // 压缩推进时单调更新 MediaRetentionDoc 游标，使压缩点前的历史视觉内容稳定落到游标之前。
          const compactBoundaryEntryId = Number(
            compaction?.firstKeptEntryId
            ?? compaction?.cutoffEntryId
            ?? compaction?.entries?.at?.(-1)?.id
            ?? 0,
          );
          if (Number.isFinite(compactBoundaryEntryId) && compactBoundaryEntryId > 0) {
            await api.commit(async (tx) => {
              const retention = await tx.doc(MediaRetentionDoc, api.conversationId);
              if (compactBoundaryEntryId > (retention.cutoffEntryId || 0)) {
                retention.cutoffEntryId = Math.trunc(compactBoundaryEntryId);
              }
              return undefined;
            }, context).catch(() => {});
          }
          return {
            summary: appendMissingAnchors(rawSummary, {
              canvasId: entry.canvasId,
              activeSkillPointers,
            }),
          };
        } catch (error) {
          if (api.signal?.aborted || context.abortSignal?.aborted) throw error;
          // 瞬态网络/模型异常：绝不返回空摘要，返回 undefined 让 Pi CompactionTask 原生重试接管。
          return undefined;
        } finally {
          entry.compactingHookCount = Math.max(0, (entry.compactingHookCount || 1) - 1);
        }
      },
    })],
  });
}
