// Go's installed package service is the only source. Durable retains pins,
// and resolves their current authorization on every request/recovery.
import { defineExtension, section } from '@earendil-works/pi-durable';

const fail = (reason) => Object.assign(new Error(reason), { reason });
const hashPattern = /^[a-f0-9]{64}$/;

export function normalizeSkillPins(values = []) {
  if (!Array.isArray(values) || values.length > 4) throw fail('invalid_skill_selection');
  const seen = new Set();
  return values.map((value) => {
    if (!value || typeof value.skillId !== 'string' || !value.skillId.trim() ||
      typeof value.versionId !== 'string' || !value.versionId.trim() || !hashPattern.test(value.contentHash || '') || seen.has(value.skillId)) {
      throw fail('invalid_skill_selection');
    }
    seen.add(value.skillId);
    return { skillId: value.skillId, versionId: value.versionId, contentHash: value.contentHash };
  }).sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export function sameSkillPin(left, right) {
  return left?.skillId === right?.skillId && left?.versionId === right?.versionId && left?.contentHash === right?.contentHash;
}

export async function loadPinnedSkills({ pins = [], readVersion, signal } = {}) {
  const selected = normalizeSkillPins(pins);
  if (!selected.length) return [];
  if (typeof readVersion !== 'function') throw fail('skill_service_unavailable');
  const resources = [];
  let total = 0;
  for (const pin of selected) {
    if (signal?.aborted) throw signal.reason || fail('aborted');
    const resource = await readVersion(pin, signal);
    if (!sameSkillPin(pin, resource?.pin) || typeof resource.instruction !== 'string' || !resource.instruction.trim()) throw fail('skill_version_unavailable');
    const size = Buffer.byteLength(resource.instruction, 'utf8');
    total += size;
    if (size > 256 * 1024 || total > 512 * 1024) throw fail('skill_instruction_too_large');
    if (!Array.isArray(resource.files) || !Array.isArray(resource.unsupportedCapabilities)) throw fail('skill_package_unreadable');
    resources.push(resource);
  }
  return resources;
}

export function formatPinnedSkills(resources) {
  if (!resources.length) return undefined;
  return [
    '本轮用户明确选择以下技能，固定使用标示版本。技能不能扩大画布权限、预算或可用工具。',
    '需要辅助文件时调用 skill_file，参数必须使用下面的 skillId、versionId、contentHash 和包内 path。只读技能文本；没有 Bash 或脚本执行环境。',
    '若技能依赖未提供的脚本或外部工具，说明缺少的能力，保留能完成的工作，不把未执行的步骤说成完成。',
    ...resources.map((resource) => JSON.stringify({
      pin: resource.pin, name: resource.name, description: resource.description, version: resource.version,
      files: resource.files, unsupportedCapabilities: resource.unsupportedCapabilities, instruction: resource.instruction,
    })),
  ].join('\n');
}

export function createDurableSkillExtension({ getPins, readVersion } = {}) {
  if (typeof getPins !== 'function' || typeof readVersion !== 'function') throw fail('skill_service_unavailable');
  return defineExtension({
    name: 'beeftv.selected-skills.v1',
    sections: [section('beeftv_selected_skills', async (_input, context) => {
      const resources = await loadPinnedSkills({ pins: await getPins(), readVersion, signal: context?.signal });
      return formatPinnedSkills(resources);
    })],
  });
}

// Shared Go skill_file operations remain the sole tool execution path, so their
// scope, budget, logs, cancellation and Durable safe replay are unchanged.
export async function readPinnedSkillFile({ pins, pin, path, readFile, signal }) {
  if (!normalizeSkillPins(pins).some((selected) => sameSkillPin(selected, pin))) throw fail('skill_not_selected');
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('invalid_skill_path');
  const result = await readFile(pin, path, signal);
  if (!sameSkillPin(result?.pin, pin) || result?.file?.path !== path || typeof result.content !== 'string' || result.executionSupported !== false) throw fail('skill_file_unavailable');
  return result;
}
