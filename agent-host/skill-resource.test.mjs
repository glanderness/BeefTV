import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDurableSkillExtension, loadPinnedSkills, normalizeSkillPins, readPinnedSkillFile } from './skill-resource.mjs';

const pin = { skillId: 'user-skill', versionId: 'v1', contentHash: 'a'.repeat(64) };
const resource = { pin, name: '采访切片', version: '1', description: '保留原话', instruction: '先读取 references/interview.md，再按原话整理三个镜头。', files: [{ path: 'references/interview.md' }], unsupportedCapabilities: [] };

test('large Chinese instructions remain complete and oversized instructions are rejected', async () => {
  const instruction = '镜头'.repeat(13000);
  const loaded = await loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, instruction }) });
  assert.equal(loaded[0].instruction, instruction);
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, instruction: '字'.repeat(90000) }) }), /skill_instruction_too_large/);
});

test('official Durable prompt section loads only explicitly pinned remote packages and revalidates after restore', async () => {
  let calls = 0;
  const extension = createDurableSkillExtension({ getPins: () => [pin], readVersion: async (selected) => { calls++; assert.deepEqual(selected, pin); return resource; } });
  assert.equal(extension.name, 'beeftv.selected-skills.v1');
  assert.match(await extension.sections[0].render({}, {}), /references\/interview.md/);
  assert.match(await extension.sections[0].render({}, {}), /保留原话/);
  assert.equal(calls, 2);
  const restored = normalizeSkillPins(JSON.parse(JSON.stringify([pin])));
  assert.deepEqual((await loadPinnedSkills({ pins: restored, readVersion: async () => resource }))[0].pin, pin);
});

test('update does not replace a pinned version and uninstall cannot silently use cached instructions', async () => {
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, pin: { ...pin, versionId: 'v2' } }) }), /skill_version_unavailable/);
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => { throw Error('skill_uninstalled'); } }), /skill_uninstalled/);
});

test('auxiliary files require selected version and package relative path; scripts remain read only', async () => {
  const readFile = async (selected, path) => ({ pin: selected, file: { path }, content: '原话来自采访素材', executionSupported: false });
  const result = await readPinnedSkillFile({ pins: [pin], pin, path: 'references/interview.md', readFile });
  assert.equal(result.content, '原话来自采访素材');
  for (const path of ['../secrets', '/etc/passwd', 'https://example.com', 'scripts\\run.js']) {
    await assert.rejects(readPinnedSkillFile({ pins: [pin], pin, path, readFile }), /invalid_skill_path/);
  }
  await assert.rejects(readPinnedSkillFile({ pins: [], pin, path: 'SKILL.md', readFile }), /skill_not_selected/);
});

test('no selection performs no package discovery; script dependent skill exposes missing execution explicitly', async () => {
  let called = false;
  assert.deepEqual(await loadPinnedSkills({ pins: [], readVersion: async () => { called = true; } }), []);
  assert.equal(called, false);
  const extension = createDurableSkillExtension({ getPins: () => [pin], readVersion: async () => ({ ...resource, unsupportedCapabilities: ['script_execution'] }) });
  const prompt = await extension.sections[0].render({}, {});
  assert.match(prompt, /script_execution/);
  assert.match(prompt, /不把未执行的步骤说成完成/);
});
