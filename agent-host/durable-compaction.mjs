// BeefTV studio compaction adapter: supplies storyboard/resourceId/Skill checkpointing
// and monotone MediaRetentionDoc cursor updates to pi-creative-media's generic factory.
import {
  createConfigurableCompactionExtension,
  recordUsageToUsageDoc,
  serializeConversationTranscript,
} from './extensions/pi-creative-media/compaction.mjs';
import { renderPlanSection } from './plan.mjs';
import { formatActiveSkillPointers } from './active-skills.mjs';
import { MediaRetentionDoc } from './studio-digest.mjs';

export { recordUsageToUsageDoc };

export const CREATIVE_COMPACTION_SYSTEM_PROMPT = `你是 AI 影视与短剧工作台（BeefTV）的上下文压缩助手。你的任务是阅读用户与创作助手之间的历史对话，生成一份结构化、可直接续作的创作状态检查点摘要。

严禁继续对话，严禁回答对话中的问题，只输出结构化摘要正文。必须精确保留所有标识（canvasId、nodeId、resourceId、assetId、taskId、proposalId、skillId、versionId、contentHash）与机器错误码，严禁编造或改写。`;

export function serializeCreativeTranscript(messages) {
  return serializeConversationTranscript(messages, { toolResultMaxChars: 2400 });
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
  return createConfigurableCompactionExtension({
    name: 'beeftv.compaction.v1',
    systemPrompt: CREATIVE_COMPACTION_SYSTEM_PROMPT,
    resolveSessionId: () => entry.sessionId,
    buildPrompt: async ({ compaction, messages, instructions, signal }) => {
      const doc = await state(entry).catch(() => null);
      const planText = renderPlanSection(doc?.plan) || '';

      let activeResources = [];
      if (skills && typeof resolveActiveSkills === 'function') {
        try {
          const skillTurnId = entry.busy ? (entry.turn?.turnId || '') : '';
          const projection = await resolveActiveSkills(entry, signal, skillTurnId);
          activeResources = projection?.resources || [];
        } catch {
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
      return {
        prompt: buildCreativeCompactionPrompt({
          messages,
          canvasId: entry.canvasId,
          planText,
          activeSkillPointers,
          instructions: compaction?.instructions ?? instructions,
        }),
        activeSkillPointers,
      };
    },
    onBeforeCall: () => {
      entry.compactingHookCount = (entry.compactingHookCount || 0) + 1;
    },
    postProcessSummary: (rawSummary, { promptMeta }) => appendMissingAnchors(rawSummary, {
      canvasId: entry.canvasId,
      activeSkillPointers: promptMeta?.activeSkillPointers || '',
    }),
    onSummaryAccepted: async ({ compaction, api, context }) => {
      const compactBoundaryEntryId = Number(compaction?.entries?.at?.(-1)?.id ?? 0);
      if (Number.isFinite(compactBoundaryEntryId) && compactBoundaryEntryId > 0) {
        await api.commit(async (tx) => {
          const retention = await tx.doc(MediaRetentionDoc, api.conversationId);
          if (compactBoundaryEntryId > (retention.cutoffEntryId || 0)) {
            retention.cutoffEntryId = Math.trunc(compactBoundaryEntryId);
          }
          return undefined;
        }, context).catch(() => {});
      }
    },
    onFinally: () => {
      entry.compactingHookCount = Math.max(0, (entry.compactingHookCount || 1) - 1);
    },
  });
}
