// 制作现场：把整张画布压成助手每轮都能一眼看懂的几百字，
// 以及“上一次对话结束后别人（用户、生成任务）又改了什么”的差异说明。
// 纯函数、无 IO、结果确定（同一画布状态永远得到同一段文字），便于提示词缓存与测试。
import { defineDoc } from '@earendil-works/pi-durable';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai/utils/transcript';
import {
  DEFAULT_MAX_REQUEST_BYTES,
  formatDegradedMediaPlaceholder,
} from './extensions/pi-creative-media/media-payload.mjs';
import { MEDIA_PART_MARKER, MEDIA_REFERENCE_MARKER } from './media-content.mjs';

export const MediaRetentionDoc = defineDoc({
  kind: 'beeftv.media_retention',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({
    cutoffEntryId: 0,
    cutoffMessageIndex: 0,
  }),
  checkpointWhen: () => true,
});

// 单调媒体裁剪总内联图字符阈值（默认 ~4MB base64 ≈ 3MB 原始图片字节）：
// 仅在压缩或累计内联图体积超出阈值时单调推进 cutoff，正常相邻视觉轮次绝不改写历史前缀，保护 KV Prompt Cache。
export const DEFAULT_MAX_INLINE_IMAGE_CHARS = (() => {
  const raw = Number(process.env.BEEFTV_AGENT_MAX_INLINE_IMAGE_CHARS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 4 * 1024 * 1024;
})();

const TYPE_LABEL = {
  image: '图片', video: '视频', audio: '音频', text: '文本', markdown: '文档', script: '分镜板',
  frame: '分组', svg: 'SVG', html: '网页', panorama: '全景', compare: '对比', chart: '图表',
};
const MEDIA = new Set(['image', 'video', 'audio']);

const HEADER_SECTION_ORDER = ['instructions', 'beeftv_skill_catalog', 'codemode'];

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .join('\n');
}

const SERIALIZED_STUDIO_TAIL_RE =
  /^(?:\[系统恢复：以下技能之前已加载，因对话被压缩，原文补回。[\s\S]*<\/skill>(?:\n\n|$))?(?:<beeftv_plan>\n[\s\S]*\n<\/beeftv_plan>(?:\n\n|$))?(?:<beeftv_studio>\n[\s\S]*\n<\/beeftv_studio>)?$/;

export function isTransientStudioTailText(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return false;
  return (
    (text.startsWith('<beeftv_studio>\n') ||
      text.startsWith('<beeftv_plan>\n') ||
      text.startsWith('[系统恢复：以下技能之前已加载，因对话被压缩，原文补回。')) &&
    SERIALIZED_STUDIO_TAIL_RE.test(text)
  );
}

export function isTransientStudioTailMessage(message) {
  if (!message || message.role !== 'user') return false;
  if (message.transientStudioTail === true) return true;
  return isTransientStudioTailText(extractMessageText(message));
}

const HISTORICAL_TOOL_IMAGE_OMITTED_TEXT =
  '[此前已展示过的历史媒体预览图已在后续步骤折叠以节省上下文；如需复查概览请调 media_overview，查看原图或局部细节请调 media_inspect]';
const HISTORICAL_FILE_IMAGE_OMITTED_TEXT =
  '[此前已展示过的文档扫描页画面已在后续步骤折叠以节省上下文；你此前据此读取并记录的内容仍然有效，如需再次查看请重新调用 file_read]';
// 仅裁剪 >=16KB base64 的真实媒体预览图；几百字节的小占位图/图标直接保留以维持前缀缓存字节一致。
const DEFAULT_MIN_PRUNE_IMAGE_CHARS = 16 * 1024;

function isToolResultMessage(message) {
  return message?.role === 'toolResult' || message?.role === 'tool';
}

function isFileReadToolResult(message) {
  const name = typeof message?.toolName === 'string' ? message.toolName : typeof message?.name === 'string' ? message.name : '';
  if (name === 'file_read' || name === 'file.read') return true;
  if (!Array.isArray(message?.content)) return false;
  const firstText = message.content.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text || '';
  return firstText.includes('"op":"file.read"') || firstText.includes('"format":"pdf-images"');
}

function isPrunableImagePart(part, minChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS) {
  return part?.type === 'image' && typeof part.data === 'string' && part.data.length >= minChars;
}

function hasPrunableImagePart(message, minChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS) {
  return Array.isArray(message?.content) && message.content.some((part) => isPrunableImagePart(part, minChars));
}

function inlineImageCharsOfMessage(message, minChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS) {
  if (!isToolResultMessage(message) || !Array.isArray(message?.content)) return 0;
  let total = 0;
  for (const part of message.content) {
    if (isPrunableImagePart(part, minChars)) total += part.data.length;
  }
  return total;
}

function nativeMediaBytesOfText(text, nativePartStore = null) {
  if (typeof text !== 'string' || (!text.includes(MEDIA_REFERENCE_MARKER) && !text.includes(MEDIA_PART_MARKER))) return 0;
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(MEDIA_REFERENCE_MARKER)) {
      try {
        const ref = JSON.parse(line.slice(MEDIA_REFERENCE_MARKER.length));
        const size = typeof nativePartStore?.statSize === 'function' ? nativePartStore.statSize(ref?.id) : 0;
        total += size > 0 ? size : 0;
      } catch { /* ignore malformed */ }
    } else if (line.startsWith(MEDIA_PART_MARKER)) {
      try {
        const part = JSON.parse(line.slice(MEDIA_PART_MARKER.length));
        if (typeof part?.data === 'string') total += Math.floor(part.data.length * 3 / 4);
      } catch { /* ignore malformed */ }
    }
  }
  return total;
}

function nativeMediaBytesOfMessage(message, nativePartStore = null) {
  if (!isToolResultMessage(message)) return 0;
  if (typeof message.content === 'string') return nativeMediaBytesOfText(message.content, nativePartStore);
  if (!Array.isArray(message.content)) return 0;
  let total = 0;
  for (const part of message.content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      total += nativeMediaBytesOfText(part.text, nativePartStore);
    }
  }
  return total;
}

function foldNativeMediaMarkersInText(text) {
  if (typeof text !== 'string' || (!text.includes(MEDIA_REFERENCE_MARKER) && !text.includes(MEDIA_PART_MARKER))) return text;
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (line.startsWith(MEDIA_REFERENCE_MARKER)) {
      try {
        const ref = JSON.parse(line.slice(MEDIA_REFERENCE_MARKER.length));
        changed = true;
        return formatDegradedMediaPlaceholder(ref, 'budget_exceeded');
      } catch {
        return line;
      }
    }
    if (line.startsWith(MEDIA_PART_MARKER)) {
      try {
        const part = JSON.parse(line.slice(MEDIA_PART_MARKER.length));
        changed = true;
        return formatDegradedMediaPlaceholder(part, 'budget_exceeded');
      } catch {
        return line;
      }
    }
    return line;
  });
  return changed ? lines.join('\n') : text;
}

function hasNativeMediaMarker(message) {
  if (!isToolResultMessage(message)) return false;
  if (typeof message.content === 'string') {
    return message.content.includes(MEDIA_REFERENCE_MARKER) || message.content.includes(MEDIA_PART_MARKER);
  }
  return Array.isArray(message.content) && message.content.some(
    (part) => part?.type === 'text' && typeof part.text === 'string'
      && (part.text.includes(MEDIA_REFERENCE_MARKER) || part.text.includes(MEDIA_PART_MARKER)),
  );
}

function foldToolMediaInMessage(message, minChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS) {
  if (!isToolResultMessage(message)) return message;
  const hasImg = hasPrunableImagePart(message, minChars);
  const hasNative = hasNativeMediaMarker(message);
  if (!hasImg && !hasNative) return message;
  if (typeof message.content === 'string') {
    return { ...message, content: foldNativeMediaMarkersInText(message.content) };
  }
  const omittedText = isFileReadToolResult(message)
    ? HISTORICAL_FILE_IMAGE_OMITTED_TEXT
    : HISTORICAL_TOOL_IMAGE_OMITTED_TEXT;
  return {
    ...message,
    content: message.content.map((part) => {
      if (isPrunableImagePart(part, minChars)) return { type: 'text', text: omittedText };
      if (part?.type === 'text' && typeof part.text === 'string') {
        const folded = foldNativeMediaMarkersInText(part.text);
        if (folded !== part.text) return { ...part, text: folded };
      }
      return part;
    }),
  };
}

// 计算单调递增的媒体裁剪游标（同时覆盖内联图片与原生音视频引用，共享同一持久化 MediaRetentionDoc）：
// - cutoffEntryId / cutoffMessageIndex 只增不减；
// - 当游标之后累计内联大图字符数 <= maxInlineImageChars 且原生音视频字节 <= maxNativeMediaBytes 时
//   游标纹丝不动（相邻视觉/视频轮次前缀 100% 字节一致，保护 KV Prompt Cache）；
// - 超出预算时仅从最旧的媒体 toolResult 单调前推到满足预算为止，始终保留最新一条媒体消息。
export function evaluateMonotoneMediaCutoff(messages = [], {
  cutoffEntryId = 0,
  cutoffMessageIndex = 0,
  messageEntryId = null,
  maxInlineImageChars = DEFAULT_MAX_INLINE_IMAGE_CHARS,
  maxNativeMediaBytes = DEFAULT_MAX_REQUEST_BYTES,
  minImageChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS,
  nativePartStore = null,
} = {}) {
  const useEntryIds = messageEntryId instanceof Map && messageEntryId.size > 0;
  let nextCutoffEntryId = Number.isFinite(cutoffEntryId) && cutoffEntryId > 0 ? Math.trunc(cutoffEntryId) : 0;
  let nextCutoffMessageIndex = Number.isFinite(cutoffMessageIndex) && cutoffMessageIndex > 0 ? Math.trunc(cutoffMessageIndex) : 0;

  const retained = [];
  let retainedChars = 0;
  let retainedNativeBytes = 0;
  for (let idx = 0; idx < messages.length; idx += 1) {
    const message = messages[idx];
    const chars = inlineImageCharsOfMessage(message, minImageChars);
    const nativeBytes = nativeMediaBytesOfMessage(message, nativePartStore);
    if (chars <= 0 && nativeBytes <= 0) continue;
    const entryId = useEntryIds ? messageEntryId.get(message) : undefined;
    const alreadyFolded = useEntryIds && typeof entryId === 'number'
      ? entryId <= nextCutoffEntryId
      : idx < nextCutoffMessageIndex;
    if (alreadyFolded) continue;
    retained.push({ idx, entryId, chars, nativeBytes });
    retainedChars += chars;
    retainedNativeBytes += nativeBytes;
  }

  const imageLimit = Number.isFinite(maxInlineImageChars) && maxInlineImageChars > 0
    ? maxInlineImageChars
    : DEFAULT_MAX_INLINE_IMAGE_CHARS;
  const nativeLimit = Number.isFinite(maxNativeMediaBytes) && maxNativeMediaBytes > 0
    ? maxNativeMediaBytes
    : DEFAULT_MAX_REQUEST_BYTES;

  let advanced = false;
  if ((retainedChars > imageLimit || retainedNativeBytes > nativeLimit) && retained.length > 1) {
    let remainingChars = retainedChars;
    let remainingNative = retainedNativeBytes;
    // 至少保留最新 1 条媒体 toolResult，避免单条超标把当前正在看的媒体也折叠掉。
    for (let i = 0; i < retained.length - 1 && (remainingChars > imageLimit || remainingNative > nativeLimit); i += 1) {
      const item = retained[i];
      remainingChars -= item.chars;
      remainingNative -= item.nativeBytes;
      if (useEntryIds && typeof item.entryId === 'number') {
        if (item.entryId > nextCutoffEntryId) {
          nextCutoffEntryId = item.entryId;
          advanced = true;
        }
      } else {
        const candidateIdx = item.idx + 1;
        if (candidateIdx > nextCutoffMessageIndex) {
          nextCutoffMessageIndex = candidateIdx;
          advanced = true;
        }
      }
    }
  }

  return {
    cutoffEntryId: nextCutoffEntryId,
    cutoffMessageIndex: nextCutoffMessageIndex,
    advanced,
    retainedImageChars: retainedChars,
    retainedNativeBytes,
  };
}

// 依据已持久化的单调游标折叠旧媒体预览图与原生音视频引用（纯函数，不原地修改原消息数组）。
export function applyMonotoneMediaCutoff(messages = [], {
  cutoffEntryId = 0,
  cutoffMessageIndex = 0,
  messageEntryId = null,
  minImageChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS,
} = {}) {
  const useEntryIds = messageEntryId instanceof Map && messageEntryId.size > 0;
  const entryCutoff = Number.isFinite(cutoffEntryId) && cutoffEntryId > 0 ? Math.trunc(cutoffEntryId) : 0;
  const indexCutoff = Number.isFinite(cutoffMessageIndex) && cutoffMessageIndex > 0 ? Math.trunc(cutoffMessageIndex) : 0;
  if (entryCutoff <= 0 && indexCutoff <= 0) return messages;
  return messages.map((message, idx) => {
    if (!isToolResultMessage(message) || (!hasPrunableImagePart(message, minImageChars) && !hasNativeMediaMarker(message))) return message;
    const entryId = useEntryIds ? messageEntryId.get(message) : undefined;
    const shouldFold = useEntryIds && typeof entryId === 'number'
      ? entryId <= entryCutoff
      : idx < indexCutoff;
    return shouldFold ? foldToolMediaInMessage(message, minImageChars) : message;
  });
}

// 读取并按需单调推进持久化 MediaRetentionDoc 游标。
export async function syncMonotoneMediaCutoff(runtime, context, messages, messageEntryId, {
  maxInlineImageChars = DEFAULT_MAX_INLINE_IMAGE_CHARS,
  maxNativeMediaBytes = DEFAULT_MAX_REQUEST_BYTES,
  minImageChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS,
  nativePartStore = null,
} = {}) {
  const snap = await runtime.snapshot(MediaRetentionDoc, runtime.conversationId, context).catch(() => null);
  const cutoffEval = evaluateMonotoneMediaCutoff(messages, {
    cutoffEntryId: snap?.cutoffEntryId || 0,
    cutoffMessageIndex: snap?.cutoffMessageIndex || 0,
    messageEntryId,
    maxInlineImageChars,
    maxNativeMediaBytes,
    minImageChars,
    nativePartStore,
  });
  if (cutoffEval.advanced) {
    await runtime.commit(async (tx) => {
      const retention = await tx.doc(MediaRetentionDoc, runtime.conversationId);
      if (cutoffEval.cutoffEntryId > (retention.cutoffEntryId || 0)) {
        retention.cutoffEntryId = cutoffEval.cutoffEntryId;
      }
      if (cutoffEval.cutoffMessageIndex > (retention.cutoffMessageIndex || 0)) {
        retention.cutoffMessageIndex = cutoffEval.cutoffMessageIndex;
      }
      return undefined;
    }, context).catch(() => {});
  }
  return cutoffEval;
}

// Pin stable system sections from the initial system message in deterministic
// key order (instructions first, beeftv_skill_catalog second), falling back to
// getCurrentSystemMessage only if a section was absent on messages[0]. Even if
// a session is reopened after a restart and a later turn emits a modified catalog
// delta, pinning from messages[0] keeps the leading header byte-identical.
export function normalizeSystemHeaderMessages(messages = []) {
  const firstSystemIdx = messages.findIndex((m) => m && m.role === 'system');
  if (firstSystemIdx < 0) return messages.slice();
  const initialSections = messages[firstSystemIdx]?.sections || {};
  const replayed = getCurrentSystemMessage(messages);
  const rawSections = replayed?.sections || {};
  const orderedSections = {};
  for (const key of HEADER_SECTION_ORDER) {
    const initialVal = initialSections[key];
    const val = typeof initialVal === 'string' && initialVal.length > 0 ? initialVal : rawSections[key];
    if (typeof val === 'string' && val.length > 0 && !(key in initialSections && initialVal === null)) {
      orderedSections[key] = val;
    }
  }
  return messages.flatMap((message, idx) => {
    if (!message || message.role !== 'system') return [message];
    if (idx === firstSystemIdx) {
      return [{ ...message, content: '', sections: orderedSections }];
    }
    const hasToolsAdded = Array.isArray(message.toolsAdded) && message.toolsAdded.length > 0;
    const hasToolsRemoved = Array.isArray(message.toolsRemoved) && message.toolsRemoved.length > 0;
    if (!hasToolsAdded && !hasToolsRemoved) return [];
    const nextMsg = { ...message, content: '' };
    delete nextMsg.sections;
    return [nextMsg];
  });
}

// The SDK can resume an already prepared request. Normalize system header sections
// (instructions first, skill catalog second; no transient studio/plan/active_skills)
// and append transient studio/plan/restored-skills context at the end as a non-system message.
export function withCurrentStudio(messages, digest, options = {}) {
  const {
    includeStudio = true,
    planText = '',
    restoredSkillsText = '',
    mediaCutoffEntryId = 0,
    mediaCutoffMessageIndex = 0,
    messageEntryId = null,
    minImageChars = DEFAULT_MIN_PRUNE_IMAGE_CHARS,
  } = options || {};
  const normalized = applyMonotoneMediaCutoff(
    normalizeSystemHeaderMessages(messages).filter(
      (message, idx, arr) => !(idx === arr.length - 1 && message?.transientStudioTail === true),
    ),
    {
      cutoffEntryId: mediaCutoffEntryId,
      cutoffMessageIndex: mediaCutoffMessageIndex,
      messageEntryId,
      minImageChars,
    },
  );
  const tailBlocks = [];
  if (typeof restoredSkillsText === 'string' && restoredSkillsText.trim()) {
    tailBlocks.push(restoredSkillsText.trim());
  }
  if (typeof planText === 'string' && planText.trim()) {
    const trimmedPlan = planText.trim();
    tailBlocks.push(
      trimmedPlan.startsWith('<beeftv_plan>')
        ? trimmedPlan
        : `<beeftv_plan>\n${trimmedPlan}\n</beeftv_plan>`,
    );
  }
  if (includeStudio) {
    const studioText =
      digest ||
      '当前画布无法读取，现场状态未知。不要使用历史快照推断当前内容；本次相关写入已暂停，请说明读取失败后再继续。';
    tailBlocks.push(`<beeftv_studio>\n${studioText}\n</beeftv_studio>`);
  }
  if (tailBlocks.length === 0) {
    return normalized;
  }
  return [
    ...normalized,
    {
      role: 'user',
      transientStudioTail: true,
      content: [{ type: 'text', text: tailBlocks.join('\n\n') }],
      timestamp: Date.now(),
    },
  ];
}

const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// 节点当前状态：done 已有结果 / running 生成中 / failed 失败 / empty 还没有结果
export function nodeState(node) {
  const meta = node?.metadata || {};
  if (meta.status === 'loading' || meta.taskStatus === 'queued' || meta.taskStatus === 'running') return 'running';
  if (meta.status === 'error' || meta.taskStatus === 'failed') return 'failed';
  if (meta.status === 'success' || meta.assetId || meta.storageKey) return 'done';
  return 'empty';
}
const STATE_LABEL = { done: '完成', running: '生成中', failed: '失败', empty: '空' };

function formatMediaStatus(node) {
  if (!node) return '不存在';
  const state = nodeState(node);
  const label = STATE_LABEL[state] || '不存在';
  const durationMs = Number(node?.metadata?.durationMs);
  if (state === 'done' && Number.isFinite(durationMs) && durationMs > 0) {
    return `${label}(${Math.round(durationMs)}ms)`;
  }
  return label;
}

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

// 内容指纹：只含用户会在意的字段；位置、尺寸、预览缓存不算改动。
function contentFingerprint(node) {
  const meta = node?.metadata || {};
  return fnv(JSON.stringify([node?.title, meta.content, meta.composerContent, meta.prompt, meta.model, meta.seconds, meta.size, meta.quality,
    meta.count, meta.assetId, meta.storyboard?.rows]));
}

function storyboardRows(node) {
  const rows = node?.metadata?.storyboard?.rows;
  return Array.isArray(rows) ? rows : [];
}

export function buildStudioDigest(canvas, { maxBytes = 3600, selectedNodeIds = [] } = {}) {
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const connections = Array.isArray(canvas?.connections) ? canvas.connections : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const counts = {};
  for (const node of nodes) {
    const kind = TYPE_LABEL[node.type] ? node.type : 'other';
    const bucket = counts[kind] ||= { total: 0, done: 0, running: 0, failed: 0, empty: 0 };
    bucket.total++;
    if (MEDIA.has(node.type)) bucket[nodeState(node)]++;
  }
  const lines = [];
  const summary = Object.entries(counts).map(([kind, c]) => {
    const label = TYPE_LABEL[kind] || '其他';
    if (!MEDIA.has(kind)) return `${label} ${c.total}`;
    const parts = [c.done && `完成 ${c.done}`, c.running && `生成中 ${c.running}`, c.failed && `失败 ${c.failed}`, c.empty && `待生成 ${c.empty}`].filter(Boolean);
    return `${label} ${c.total}${parts.length ? `（${parts.join('、')}）` : ''}`;
  });
  lines.push(`[制作现场｜画布版本 ${canvas?.revision ?? '?'}｜本轮请求前的实际状态]`);
  lines.push(nodes.length ? `概况：${summary.join('｜')}｜连线 ${connections.length}` : '概况：画布是空的。');
  const documents = nodes.filter(node => !MEDIA.has(node.type) && node.type !== 'script');
  if (documents.length) {
    lines.push(`内容节点（正文仅为预览，长原文用 canvas_get 配合 readView 按当前版本分段读取）：${documents.slice(0, 8).map((node) => {
      const raw = String(node.metadata?.content || node.metadata?.composerContent || '');
      const lenTag = raw.length > 100 ? `(${raw.length}字)` : '';
      return `${node.id}「${clip(node.title, 24)}」${TYPE_LABEL[node.type] || node.type}${lenTag} ${clip(raw, 100)}`;
    }).join('；')}${documents.length > 8 ? `…共 ${documents.length} 个` : ''}`);
  }

  const rowBound = new Set();
  for (const board of nodes.filter((node) => node.type === 'script')) {
    const rows = storyboardRows(board);
    lines.push(`分镜板「${clip(board.title, 24)}」id=${board.id}，共 ${rows.length} 镜：`);
    rows.forEach((row, index) => {
      if (row.imageNodeId) rowBound.add(row.imageNodeId);
      if (row.videoNodeId) rowBound.add(row.videoNodeId);
      const image = row.imageNodeId ? formatMediaStatus(byId.get(row.imageNodeId)) : '未建';
      const video = row.videoNodeId ? formatMediaStatus(byId.get(row.videoNodeId)) : '未建';
      const prompts = `${row.imageGenerationPrompt ? '图词✓' : '图词✗'} ${row.videoMotionPrompt ? '视词✓' : '视词✗'}`;
      lines.push(`  镜${row.shotNumber ?? index + 1} ${row.durationSeconds ?? '?'}s｜行id=${row.id}｜首帧 ${row.imageNodeId || '—'} ${image}｜视频 ${row.videoNodeId || '—'} ${video}｜${prompts}｜${clip(row.plotDescription, 18)}`);
    });
  }

  const running = nodes.filter((node) => MEDIA.has(node.type) && nodeState(node) === 'running');
  if (running.length) lines.push(`生成中：${running.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 16)}」`).join('、')}${running.length > 8 ? `…共 ${running.length}` : ''}`);
  const failed = nodes.filter((node) => MEDIA.has(node.type) && nodeState(node) === 'failed');
  if (failed.length) lines.push(`失败：${failed.slice(0, 6).map((node) => `${node.id}「${clip(node.title, 14)}」${clip(node.metadata?.generationErrorSummary || node.metadata?.errorDetails || node.metadata?.taskErrorCode, 40)}`).join('；')}${failed.length > 6 ? `…共 ${failed.length}` : ''}`);
  const loose = nodes.filter((node) => MEDIA.has(node.type) && !rowBound.has(node.id));
  if (loose.length && !nodes.some((node) => node.type === 'script')) {
    lines.push(`媒体节点：${loose.slice(0, 16).map((node) => `${node.id}「${clip(node.title, 14)}」${TYPE_LABEL[node.type]}${formatMediaStatus(node)}`).join('、')}${loose.length > 16 ? `…共 ${loose.length}` : ''}`);
  } else if (loose.length) {
    lines.push(`不在分镜行里的媒体节点 ${loose.length} 个：${loose.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 14)}」${TYPE_LABEL[node.type]}${formatMediaStatus(node)}`).join('、')}${loose.length > 8 ? `…共 ${loose.length}` : ''}（如需关联分镜行请用 canvas_script_row_update 绑定 imageNodeId/videoNodeId）`);
  }
  const selected = selectedNodeIds.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length) lines.push(`用户选中：${selected.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 14)}」`).join('、')}`);
  const bibleDigest = typeof canvas?.creativeBibleDigest === 'string' ? canvas.creativeBibleDigest.trim() : '';

  const clipUtf8 = (str, byteLimit) => {
    if (Buffer.byteLength(str, 'utf8') <= byteLimit) return str;
    let out = '';
    for (const ch of str) {
      if (Buffer.byteLength(out + ch + '…', 'utf8') > byteLimit) break;
      out += ch;
    }
    return `${out}…`;
  };

  let boundedBible = '';
  let bodyBudget = maxBytes;
  if (bibleDigest) {
    const bibleBudget = Math.max(400, Math.floor(maxBytes * 0.45));
    boundedBible = clipUtf8(bibleDigest, bibleBudget);
    bodyBudget = Math.max(800, maxBytes - Buffer.byteLength(boundedBible, 'utf8') - 1);
  }

  let text = lines.join('\n');
  // 超预算时从分镜明细开始收缩，保证概况、进行中、失败与创作设定集留下。
  while (Buffer.byteLength(text, 'utf8') > bodyBudget) {
    const index = lines.findLastIndex((line) => line.startsWith('  镜'));
    if (index < 0) { text = clipUtf8(text, bodyBudget); break; }
    lines.splice(index, 1);
    const hidden = lines.filter((line) => line.startsWith('…')).length;
    if (!hidden) lines.push('…分镜明细已收缩，需要时用 canvas_get 读取分镜板');
    text = lines.join('\n');
  }
  if (boundedBible) {
    text = `${text}\n${boundedBible}`;
  }
  return { text, snapshot: snapshotOf(nodes), stats: { revision: canvas?.revision ?? null, nodes: nodes.length, connections: connections.length } };
}

// 快照：节点 id → 内容指纹/状态/标题。只存很小的几个字段，进会话文档。
export function snapshotOf(nodes) {
  const out = {};
  for (const node of nodes || []) {
    if (!node?.id) continue;
    out[node.id] = { t: clip(node.title, 30), h: contentFingerprint(node), s: nodeState(node), y: node.type };
  }
  return out;
}

// 对比“上次对话结束时”和“现在”：返回给助手看的一行说明；没有变化返回空串。
export function describeChangesSince(previous, current, { limit = 420 } = {}) {
  if (!previous || typeof previous !== 'object') return '';
  const parts = [];
  const name = (entry) => `「${clip(entry?.t, 14) || '未命名'}」`;
  const list = (items) => items.slice(0, 5).join('') + (items.length > 5 ? `等 ${items.length} 个` : '');
  const edited = [], added = [], removed = [], done = [], failed = [];
  for (const [id, now] of Object.entries(current)) {
    const before = previous[id];
    if (!before) { added.push(name(now)); continue; }
    if (before.s !== now.s) {
      if (now.s === 'done' && before.s !== 'done') { done.push(name(now)); continue; }
      if (now.s === 'failed') { failed.push(name(now)); continue; }
    }
    if (before.h !== now.h && before.s === now.s) edited.push(name(now));
  }
  for (const [id, before] of Object.entries(previous)) if (!current[id]) removed.push(name(before));
  if (edited.length) parts.push(`用户修改了${list(edited)}`);
  if (added.length) parts.push(`新增 ${added.length} 个节点（${list(added)}）`);
  if (removed.length) parts.push(`删除了${list(removed)}`);
  if (done.length) parts.push(`${list(done)}生成完成`);
  if (failed.length) parts.push(`${list(failed)}生成失败`);
  if (!parts.length) return '';
  return clip(`自上次对话结束后：${parts.join('；')}。以此为准，不要覆盖这些变化。`, limit);
}

// 检查本轮新建的媒体节点是否已回写分镜行且视频节点已连线首帧图；未补齐时返回单行提醒。
export function buildUnboundMediaReminder(canvas, createdNodeIds) {
  if (!canvas || !Array.isArray(createdNodeIds) || createdNodeIds.length === 0) return '';
  const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const connections = Array.isArray(canvas.connections) ? canvas.connections : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const scriptNodes = nodes.filter((n) => n.type === 'script' && (n.metadata?.storyboard?.rows?.length || 0) > 0);
  if (scriptNodes.length === 0) return '';
  const boundIds = new Set();
  for (const s of scriptNodes) {
    for (const r of s.metadata?.storyboard?.rows || []) {
      if (r.imageNodeId) boundIds.add(r.imageNodeId);
      if (r.videoNodeId) boundIds.add(r.videoNodeId);
    }
  }
  const createdSet = new Set(createdNodeIds);
  const unboundMedia = nodes.filter(
    (n) => createdSet.has(n.id) && (n.type === 'image' || n.type === 'video') && !boundIds.has(n.id),
  );
  const createdImages = nodes.filter((n) => createdSet.has(n.id) && n.type === 'image');
  const unlinkedVideos = createdImages.length > 0
    ? nodes.filter(
        (n) =>
          createdSet.has(n.id) &&
          n.type === 'video' &&
          !connections.some((e) => e.toNodeId === n.id && byId.get(e.fromNodeId)?.type === 'image'),
      )
    : [];
  if (unboundMedia.length === 0 && unlinkedVideos.length === 0) return '';
  const hints = [];
  if (unboundMedia.length > 0) {
    const list = unboundMedia.map((n) => `${n.id}「${n.title || n.type}」`).join('、');
    hints.push(`本轮新建的媒体节点（${list}）尚未通过 canvas_script_row_update 的 imageNodeId/videoNodeId 写回对应分镜行`);
  }
  if (unlinkedVideos.length > 0) {
    const vList = unlinkedVideos.map((n) => `${n.id}「${n.title || n.type}」`).join('、');
    hints.push(`本轮新建的视频节点（${vList}）尚未通过 canvas_edge_create 连接对应的首帧图节点`);
  }
  return `[制作现场检查] ${hints.join('；')}（当前画布 expectedRevision=${canvas.revision}）。请先补齐上述绑定/连线后再回复用户。`;
}
