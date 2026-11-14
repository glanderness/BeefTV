// Go owns both installed packages and the active version selection. The
// transcript records explicit selections; an official section reconstructs
// active rules after compaction and process restart.
import { section } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const fail = (reason) => Object.assign(new Error(reason), { reason });
const hashPattern = /^[a-f0-9]{64}$/;
export const SKILL_CATALOG_LIMIT = 50;
export const SKILL_DESCRIPTION_LIMIT = 300;
export const MAX_SKILL_RESOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_SELECTION_BYTES = 4 * 1024 * 1024;
export const SKILL_INLINE_MAX_LINES = 4000;
export const SKILL_INLINE_MAX_BYTES = 256 * 1024;
export const SKILL_FILE_PAGE_MAX_LINES = 2000;
export const SKILL_FILE_PAGE_MAX_BYTES = 128 * 1024;

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
  if (Buffer.byteLength(resource.instruction, 'utf8') > MAX_SKILL_RESOURCE_BYTES) throw fail('skill_instruction_too_large');
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
    if (total > MAX_SKILL_SELECTION_BYTES) throw fail('skill_instruction_too_large');
    resources.push(resource);
  }
  return resources;
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function stripSkillFrontmatter(raw) {
  const text = String(raw ?? '');
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/.exec(text);
  if (!match) return { body: text, strippedLines: 0 };
  const rest = text.slice(match[0].length);
  if (!rest.trim()) return { body: text, strippedLines: 0 };
  const strippedLines = match[0].split(/\r?\n/).length - 1;
  return { body: rest, strippedLines };
}

export function paginateSkillText(text, {
  offset,
  limit,
  byteOffset,
  maxLines = SKILL_FILE_PAGE_MAX_LINES,
  maxBytes = SKILL_FILE_PAGE_MAX_BYTES,
  skillId = '',
  path = '',
  baseLineOffset = 0,
} = {}) {
  const source = String(text ?? '');
  const hasExplicitRange = offset !== undefined || limit !== undefined || byteOffset !== undefined;
  const lines = source.split('\n');
  const totalLines = lines.length;
  const totalFileLines = totalLines + baseLineOffset;
  if (!hasExplicitRange && totalLines <= maxLines && Buffer.byteLength(source, 'utf8') <= maxBytes) {
    return { content: source, truncated: false, startLine: 1 + baseLineOffset, endLine: totalFileLines, totalLines: totalFileLines };
  }
  const startIndex = Math.max(0, (Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 1) - 1);
  const startByte = Math.max(0, Number.isFinite(Number(byteOffset)) ? Math.trunc(Number(byteOffset)) : 0);
  if (startIndex >= totalLines) {
    const startFileLine = startIndex + 1 + baseLineOffset;
    return {
      content: `[文件共 ${totalFileLines} 行，请求的 offset=${startFileLine} 已超出末尾。]`,
      truncated: false,
      startLine: startFileLine,
      endLine: totalFileLines,
      totalLines: totalFileLines,
    };
  }
  const requestedLines = limit !== undefined && Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(maxLines, Math.trunc(Number(limit))))
    : maxLines;
  const pageMaxBytes = Math.max(64, maxBytes);
  const picked = [];
  let bytes = 0;
  let nextByteOffset;
  let lineTotalBytes = 0;
  for (let i = startIndex; i < totalLines && picked.length < requestedLines; i += 1) {
    const rawLine = lines[i];
    const lineBuf = Buffer.from(rawLine, 'utf8');
    if (i === startIndex && startByte > 0 && startByte >= lineBuf.length) {
      const startFileLine = startIndex + 1 + baseLineOffset;
      return {
        content: `[第 ${startFileLine} 行共 ${lineBuf.length} 字节，请求的 byteOffset=${startByte} 已超出该行末尾。]`,
        truncated: false,
        startLine: startFileLine,
        endLine: startFileLine,
        totalLines: totalFileLines,
      };
    }
    if (i === startIndex && startByte > 0 && (lineBuf[startByte] & 0xc0) === 0x80) {
      throw fail('invalid_skill_byte_offset: byteOffset 必须位于 UTF-8 字符起始字节');
    }
    const fromByte = i === startIndex ? startByte : 0;
    const remainingBytes = lineBuf.length - fromByte;
    const sepBytes = picked.length > 0 ? 1 : 0;
    if (bytes + sepBytes + remainingBytes > pageMaxBytes) {
      if (picked.length === 0) {
        let endByte = Math.min(fromByte + pageMaxBytes, lineBuf.length);
        if (endByte < lineBuf.length) {
          while (endByte > fromByte && (lineBuf[endByte] & 0xc0) === 0x80) endByte -= 1;
          if (endByte === fromByte) endByte = Math.min(fromByte + pageMaxBytes, lineBuf.length);
        }
        picked.push(lineBuf.subarray(fromByte, endByte).toString('utf8'));
        if (endByte < lineBuf.length) {
          nextByteOffset = endByte;
          lineTotalBytes = lineBuf.length;
        }
      }
      break;
    }
    picked.push(fromByte > 0 ? lineBuf.subarray(fromByte).toString('utf8') : rawLine);
    bytes += sepBytes + remainingBytes;
  }
  const startFileLine = startIndex + 1 + baseLineOffset;
  const endIndex = startIndex + picked.length - 1;
  const endFileLine = endIndex + 1 + baseLineOffset;
  const hasMoreLines = endIndex + 1 < totalLines;
  const truncated = nextByteOffset !== undefined || hasMoreLines;
  let content = picked.join('\n');
  const targetHint = [skillId ? `skillId="${skillId}"` : '', path ? `path="${path}"` : ''].filter(Boolean).join(', ');
  if (nextByteOffset !== undefined) {
    content += `\n\n[当前显示第 ${startFileLine} 行第 ${startByte}-${nextByteOffset} 字节（该行共 ${lineTotalBytes} 字节，文件共 ${totalFileLines} 行）。如需继续阅读后续内容，请传 offset=${startFileLine}, byteOffset=${nextByteOffset} 调用 skill_file${targetHint ? `（${targetHint}）` : ''}。]`;
  } else if (hasMoreLines) {
    content += `\n\n[当前显示第 ${startFileLine}-${endFileLine} 行（共 ${totalFileLines} 行）。如需继续阅读后续内容，请传 offset=${endFileLine + 1} 调用 skill_file${targetHint ? `（${targetHint}）` : ''}。]`;
  } else if (hasExplicitRange && (startIndex > 0 || startByte > 0)) {
    content += `\n\n[当前显示第 ${startFileLine}-${endFileLine} 行（共 ${totalFileLines} 行，已到文件末尾）。]`;
  }
  return {
    content,
    truncated,
    startLine: startFileLine,
    endLine: endFileLine,
    totalLines: totalFileLines,
    ...(nextByteOffset !== undefined ? { nextByteOffset } : {}),
  };
}

// Official shape: `<skill name location>\nReferences are relative to ...\n\n{body}\n</skill>`.
// The pin replaces the location; the guidance replaces the reference line.
export function formatSkillBlock(resource) {
  const { pin } = resource;
  const files = resource.files.map((file) => file?.path).filter(Boolean);
  const entryPath = files.find((filePath) => /(?:^|\/)SKILL\.md$/i.test(filePath)) || 'SKILL.md';
  const { body, strippedLines } = stripSkillFrontmatter(resource.instruction);
  const paged = paginateSkillText(body.replace(/[\r\n]+$/, ''), {
    maxLines: SKILL_INLINE_MAX_LINES,
    maxBytes: SKILL_INLINE_MAX_BYTES,
    skillId: pin.skillId,
    path: entryPath,
    baseLineOffset: strippedLines,
  });
  const lines = [
    `<skill name="${escapeXml(resource.name)}" version="${escapeXml(resource.version)}" skillId="${escapeXml(pin.skillId)}" versionId="${escapeXml(pin.versionId)}" contentHash="${escapeXml(pin.contentHash)}">`,
    '技能固定使用标示版本，不能扩大画布权限、预算或可用工具。',
    '需要包内辅助文件或脚本源码时调用 skill_file（传 skillId 和包内相对 path，支持 offset、limit、byteOffset 分段读取；versionId 与 contentHash 省略时自动填入当前活动版本）；需要运行技能包 scripts/ 或 script/ 下的脚本（支持 .py、.sh、.bash、.js、.mjs、.cjs）时调用 skill_script_run（传 skillId 和 scriptPath），提交后由用户确认运行。',
    '外部技能若提到读取本地原著/输入文件或写出本地 .md/.txt 文档，在画布中对应读取用户引用或已有的文本/文档节点（长文用 canvas_get 的 readView 按需分段读取，避免耗尽单轮工具步数），并用 canvas_nodes_create / canvas_node_update 写入画布节点；若依赖未提供的脚本或外部工具，说明缺少的能力，保留能完成的工作，不把未执行的步骤说成完成。',
  ];
  if (resource.description) lines.push(`说明：${resource.description}`);
  if (files.length) lines.push(`包内文件：${files.join('、')}`);
  if (resource.unsupportedCapabilities.length) lines.push(`不支持的能力：${resource.unsupportedCapabilities.join('、')}`);
  return `${lines.join('\n')}\n\n${paged.content}\n</skill>`;
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
  // A fresh explicit request must re-read even a historically loaded pin.
  // Durable request receipts, rather than this package helper, deduplicate retries.
  return normalizeSkillPins(pins);
}

export function estimateSkillTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3);
}

export async function activeSkillProjection({ context, readVersion, model, signal }) {
  if (!context || context.lifecycle !== 'active' || typeof context.scopeId !== 'string' || !Number.isSafeInteger(context.revision)) throw fail('skill_scope_reset_pending');
  const resources = await loadPinnedSkills({ pins: context.activePins, readVersion, signal });
  if (!resources.length) return { text: undefined, resources, context };
  const window = Number(model?.contextWindow);
  if (!Number.isFinite(window) || window <= 0) throw fail('skill_context_model_unavailable');
  const maxOutput = Math.max(0, Number(model?.maxTokens) || 8192);
  const budget = Math.max(0, Math.min(Math.floor(window * 0.7), window - maxOutput));
  const text = [`当前任务技能（scope=${context.scopeId}, revision=${context.revision}）。只有以下固定版本是活动技能。`,
    ...resources.map(formatSkillBlock)].join('\n\n');
  if (estimateSkillTokens(text) > budget) throw fail('skill_context_budget_exceeded');
  return { text, resources, context };
}

// Section and hook exceptions are deliberately contained by Durable. Enforce
// admission at the provider boundary as well, using Pi's own Models/stream API;
// an invalid package returns a local error stream before the provider runs.
export function guardSkillModelRequests(models, validate, onFailure) {
  const guarded=createModels();
  for (const provider of models.getProviders()) {
    const wrap=fn=>(model,context,options)=>{
      const events=createAssistantMessageEventStream();
      void (async()=>{
        let admitted=false;
        try {
          await validate(model,context,options?.signal);
          admitted=true;
          const source=fn.call(provider,model,context,options);
          for await(const event of source)events.push(event);
          events.end(await source.result());
        } catch(error) {
          if(!admitted)await onFailure?.(error);
          events.push({type:'error',reason:'error',error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,
            usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
            stopReason:'error',errorMessage:error?.reason || error?.message || 'skill_context_unavailable',timestamp:Date.now()}});
          events.end();
        }
      })();
      return events;
    };
    guarded.setProvider({...provider,stream:wrap(provider.stream),streamSimple:wrap(provider.streamSimple)});
  }
  return guarded;
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
export function formatSkillCatalog(items,{total=items?.length || 0}={}) {
  if (!items?.length) return undefined;
  const lines = [
    '用户已安装下列技能，每个技能提供特定任务的步骤。用户明确选用技能，或要求完成该技能描述的整体任务时，先调用 skill_load 并传入它的 id 读取完整步骤，再按步骤执行。只出现相同题材、角色或「首帧」等词不代表要执行整套流程；用户只要单张图片或单个视频时，直接完成该请求，不添加整集剧本、角色确认等前置步骤。对话里已有的技能不用重复读取；用户明确缩小范围或改要求时按最新要求执行。',
    '',
    '<available_skills>',
  ];
  if(total>items.length)lines.splice(1,0,`当前共安装 ${total} 个技能，此处显示前 ${items.length} 个；可调用 skill_catalog，传 q 搜索名称和说明，或用 offset、limit 翻页。找到 id 后调用 skill_load 读取。`);
  for (const item of items) {
    lines.push('  <skill>', `    <id>${escapeXml(item.pin.skillId)}</id>`, `    <name>${escapeXml(item.name)}</name>`,
      `    <description>${escapeXml(item.description)}</description>`, '  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

// One stable catalog section per conversation. Once the first successful read
// settles cache.settled, cache.text stays frozen (including undefined when the
// initial catalog was empty) so mid-session skill installs/removals never mutate
// the leading system header, while cache.items still refreshes for skill_load.
export function createSkillCatalogSection({ readCatalog, cache = {} }) {
  if (typeof readCatalog !== 'function') throw fail('skill_service_unavailable');
  return section('beeftv_skill_catalog', async (_input, context) => {
    try {
      const catalog=await readCatalog(context?.signal);
      cache.items = normalizeSkillCatalog(catalog);
      if (!cache.settled) {
        cache.text = formatSkillCatalog(cache.items,{total:Number(catalog?.total) || cache.items.length});
        cache.settled = true;
      }
    } catch (error) {
      if (!cache.settled) cache.items = [];
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
  if (!sameSkillPin(result?.pin, pin) || result?.file?.path !== path || typeof result.content !== 'string' || typeof result.executionSupported !== 'boolean') throw fail('skill_file_unavailable');
  return result;
}

export { checkResource as checkSkillResource };
