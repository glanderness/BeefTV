import { expect, test } from 'bun:test';
import { SYSTEM_PROMPT } from './system-prompt.mjs';

test('media policy chooses minimum evidence and never presents frames as watched or heard media', () => {
  for (const instruction of ['最低必要', 'mode=frames', 'mode=video', 'mode=audio', '静态截图', '不能据此声称', '15 秒', '分段', '实际读取的区间']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
  expect(SYSTEM_PROMPT).toContain('不必读取原生视频或音频');
  expect(SYSTEM_PROMPT).toContain('用户明确要求看视频并听音频');
});

test('skills are followed step by step across turns and loaded before acting when they match', () => {
  for (const instruction of ['之后每一轮都按它的步骤顺序执行', '每次只做当前这一步或这一批', '等用户确认后再做下一步', '数量、画幅、类别', '先用 skill_load 读取', '没做的步骤不能说成已完成']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
  expect(SYSTEM_PROMPT).toContain('不要因题材相同而把单张图片、单个视频扩展成整套流程');
});

test('storyboard image and video nodes are bound back to their rows with the row prompts', () => {
  for (const instruction of ['imageNodeId', 'videoNodeId', 'imageGenerationPrompt', 'videoMotionPrompt']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
});

test('producer workflow respects studio changes, maintains plan_update, and inspects generated media', () => {
  for (const instruction of ['制作现场摘要', '不要用旧草稿覆盖用户的改动', 'plan_update', 'needs_user', '查看产物是否符合分镜要求', '只针对失败或缺失的节点重新提议']) {
    expect(SYSTEM_PROMPT).toContain(instruction);
  }
});
