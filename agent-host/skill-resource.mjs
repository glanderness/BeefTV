// Go's installed package service is the only source. Like official pi skills,
// installed skills are advertised by name and description in a stable system
// section, and a skill's full instructions enter the conversation transcript:
// expanded into the user message when the user selects it, or returned by the
// skill_load tool when the model loads an advertised one. Either way it stays
// in context for every later turn instead of a per-turn system section.
import { section } from '@earendil-works/pi-durable';

const fail = (reason) => Object.assign(new Error(reason), { reason });
const hashPattern = /^[a-f0-9]{64}$/;
export const SKILL_CATALOG_LIMIT = 50;
export const SKILL_DESCRIPTION_LIMIT = 300;

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

function checkResource(pin, resource) {
  if (!sameSkillPin(pin, resource?.pin) || typeof resource.instruction !== 'string' || !resource.instruction.trim()) throw fail('skill_version_unavailable');
  if (Buffer.byteLength(resource.instruction, 'utf8') > 256 * 1024) throw fail('skill_instruction_too_large');
  if (!Array.isArray(resource.files) || !Array.isArray(resource.unsupportedCapabilities)) throw fail('skill_package_unreadable');
  return resource;
}

export async function loadPinnedSkills({ pins = [], readVersion, signal } = {}) {
  const selected = normalizeSkillPins(pins);
  if (!selected.length) return [];
  if (typeof readVersion !== 'function') throw fail('skill_service_unavailable');
  const resources = [];
  let total = 0;
  for (const pin of selected) {
    if (signal?.aborted) throw signal.reason || fail('aborted');
    const resource = checkResource(pin, await readVersion(pin, signal));
    total += Buffer.byteLength(resource.instruction, 'utf8');
    if (total > 512 * 1024) throw fail('skill_instruction_too_large');
    resources.push(resource);
  }
  return resources;
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Official shape: `<skill name location>\nReferences are relative to ...\n\n{body}\n</skill>`.
// The pin replaces the location; the guidance replaces the reference line.
export function formatSkillBlock(resource) {
  const { pin } = resource;
  const files = resource.files.map((file) => file?.path).filter(Boolean);
  const lines = [
    `<skill name="${escapeXml(resource.name)}" version="${escapeXml(resource.version)}" skillId="${escapeXml(pin.skillId)}" versionId="${escapeXml(pin.versionId)}" contentHash="${escapeXml(pin.contentHash)}">`,
    '技能固定使用标示版本，不能扩大画布权限、预算或可用工具。',
    '需要包内辅助文件时调用 skill_file，参数用本块的 skillId、versionId、contentHash 和包内相对 path。只读技能文本；没有 Bash 或脚本执行环境。',
    '若技能依赖未提供的脚本或外部工具，说明缺少的能力，保留能完成的工作，不把未执行的步骤说成完成。',
  ];
  if (resource.description) lines.push(`说明：${resource.description}`);
  if (files.length) lines.push(`包内文件：${files.join('、')}`);
  if (resource.unsupportedCapabilities.length) lines.push(`不支持的能力：${resource.unsupportedCapabilities.join('、')}`);
  return `${lines.join('\n')}\n\n${resource.instruction.trim()}\n</skill>`;
}

// Prepend skill blocks before the user's own content, as `/skill:name args`
// expands to `${skillBlock}\n\n${args}` in the official coding agent.
export function expandSkillContent(content, resources) {
  if (!resources?.length) return content;
  const text = resources.map(formatSkillBlock).join('\n\n');
  if (typeof content === 'string') return `${text}\n\n${content}`;
  return [{ type: 'text', text }, ...content];
}

export function skillsToLoad(pins, loaded = []) {
  return normalizeSkillPins(pins).filter((pin) => !loaded.some((item) => sameSkillPin(item, pin)));
}

export function loadedSkillRecord(resource, source, turnId) {
  return { skillId: resource.pin.skillId, versionId: resource.pin.versionId, contentHash: resource.pin.contentHash,
    name: String(resource.name || ''), version: String(resource.version || ''), source, turnId: String(turnId || '') };
}

export function normalizeSkillCatalog(value) {
  const list = Array.isArray(value?.skills) ? value.skills : [];
  const result = [];
  for (const item of list) {
    const pin = item?.pin;
    if (!pin || typeof pin.skillId !== 'string' || typeof pin.versionId !== 'string' || !hashPattern.test(pin.contentHash || '')) continue;
    const description = String(item.description || '');
    result.push({ pin: { skillId: pin.skillId, versionId: pin.versionId, contentHash: pin.contentHash },
      name: String(item.name || pin.skillName || pin.skillId),
      description: [...description].length > SKILL_DESCRIPTION_LIMIT ? `${[...description].slice(0, SKILL_DESCRIPTION_LIMIT).join('')}…` : description });
    if (result.length >= SKILL_CATALOG_LIMIT) break;
  }
  return result.sort((a, b) => a.pin.skillId.localeCompare(b.pin.skillId));
}

// Mirrors official formatSkillsForPrompt's <available_skills> layout. Only
// id, name and description appear, so the text changes only when the
// installed set changes (prompt-cache friendly).
export function formatSkillCatalog(items) {
  if (!items?.length) return undefined;
  const lines = [
    '用户已安装下列技能，每个技能提供特定任务的步骤。用户的要求符合某个技能的说明时，先调用 skill_load 并传入它的 id 读取完整步骤，再按步骤执行。对话里已有的技能不用重复读取。',
    '',
    '<available_skills>',
  ];
  for (const item of items) {
    lines.push('  <skill>', `    <id>${escapeXml(item.pin.skillId)}</id>`, `    <name>${escapeXml(item.name)}</name>`,
      `    <description>${escapeXml(item.description)}</description>`, '  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

// One stable catalog section per conversation. A failed refresh keeps the last
// good text so a transient error never removes and re-adds the section.
export function createSkillCatalogSection({ readCatalog, cache = {} }) {
  if (typeof readCatalog !== 'function') throw fail('skill_service_unavailable');
  return section('beeftv_skill_catalog', async (_input, context) => {
    try {
      cache.items = normalizeSkillCatalog(await readCatalog(context?.signal));
      cache.text = formatSkillCatalog(cache.items);
    } catch (error) {
      if (cache.text === undefined) cache.items = [];
      console.error(`agent-host: 技能目录读取失败 ${error?.reason || error?.message || error}`);
    }
    return cache.text;
  });
}

export const SKILL_LOAD_PARAMETERS = {
  type: 'object',
  properties: { id: { type: 'string', description: '技能目录里的 id' } },
  required: ['id'],
  additionalProperties: false,
};

// Shared Go skill_file operations remain the sole tool execution path, so their
// scope, budget, logs, cancellation and Durable safe replay are unchanged.
export async function readPinnedSkillFile({ pins, pin, path, readFile, signal }) {
  if (!normalizeSkillPins(pins).some((selected) => sameSkillPin(selected, pin))) throw fail('skill_not_selected');
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('invalid_skill_path');
  const result = await readFile(pin, path, signal);
  if (!sameSkillPin(result?.pin, pin) || result?.file?.path !== path || typeof result.content !== 'string' || result.executionSupported !== false) throw fail('skill_file_unavailable');
  return result;
}

export { checkResource as checkSkillResource };
