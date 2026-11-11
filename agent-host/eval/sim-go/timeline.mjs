// 时间线的局部素材刷新：只更新指定节点对应片段的 directMedia，其余片段和时间线保持原样。
// 对齐真实后端 canvas.timeline.update 的 refreshNodeIds 分支：节点必须已被片段使用，且必须有一个可读资源。

import { invalidArg } from './common.mjs';

function resourceIDFromNode(node) {
  const meta = node?.metadata || {};
  const direct = String(meta.resourceId || '').trim();
  if (direct) return direct;
  for (const value of [meta.storageKey, meta.content]) {
    const text = String(value || '').trim();
    if (!text) continue;
    if (text.startsWith('resource:')) return text.slice('resource:'.length);
    const marker = '/api/resources/';
    const index = text.indexOf(marker);
    if (index >= 0) {
      const rest = text.slice(index + marker.length).split(/[/?#]/)[0];
      if (rest) return rest;
    }
  }
  return '';
}
const TRACK_KINDS = new Set(['video', 'audio', 'subtitle', 'text', 'image']);
const CLIP_KINDS = new Set(['video', 'image', 'audio', 'subtitle']);

function requireInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArg('invalid_timeline', message);
}

// 对齐真实后端的 editing.Compile 入口校验：版本、轨道/片段 ID、轨道引用和可见媒体重叠。
// doc 存在时同时确认片段引用的节点属于这张画布；资源是否就绪仍由渲染/绑定阶段判断。
export function validateTimelineShape(timeline, doc = null) {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
    throw invalidArg('invalid_timeline', '画布中没有有效时间线');
  }
  if (timeline.version !== 2) throw invalidArg('invalid_timeline', '时间线版本必须是 2');
  requireInteger(timeline.durationMs, '时间线时长必须是毫秒整数');
  if (!Array.isArray(timeline.tracks) || !Array.isArray(timeline.clips)) {
    throw invalidArg('invalid_timeline', '时间线缺少轨道或片段');
  }
  const trackById = new Map();
  for (const track of timeline.tracks) {
    const id = String(track?.id || '').trim();
    if (!id) throw invalidArg('invalid_timeline', '轨道缺少 id');
    if (trackById.has(id)) throw invalidArg('invalid_timeline', `轨道 id 重复: ${id}`);
    if (!TRACK_KINDS.has(String(track?.kind || ''))) throw invalidArg('invalid_timeline', `轨道类型不合法: ${id}`);
    trackById.set(id, track);
  }
  const seenClips = new Set();
  const visibleMediaByTrack = new Map();
  const nodeIds = doc ? new Set((doc.nodes || []).map((node) => node.id)) : null;
  for (const clip of timeline.clips) {
    const id = String(clip?.id || '').trim();
    if (!id) throw invalidArg('invalid_timeline', '片段缺少 id');
    if (seenClips.has(id)) throw invalidArg('invalid_timeline', `片段 id 重复: ${id}`);
    seenClips.add(id);
    const kind = String(clip?.kind || '');
    if (!CLIP_KINDS.has(kind)) throw invalidArg('invalid_timeline', `片段类型不合法: ${id}`);
    const trackId = String(clip?.trackId || '').trim();
    const track = trackById.get(trackId);
    if (!track) throw invalidArg('invalid_timeline', `片段指向不存在的轨道: ${id}`);
    requireInteger(clip.startMs, `片段开始时间不合法: ${id}`);
    requireInteger(clip.durationMs, `片段时长不合法: ${id}`);
    if (nodeIds) {
      const nodeId = String(clip?.nodeId || '').trim();
      if (nodeId && !nodeIds.has(nodeId)) throw invalidArg('invalid_timeline', `片段引用不在画布的节点: ${nodeId}`);
    }
    if (kind === 'subtitle' || track.visible === false || track.muted === true) continue;
    const ranges = visibleMediaByTrack.get(trackId) || [];
    const end = clip.startMs + clip.durationMs;
    if (ranges.some((range) => clip.startMs < range.end && end > range.start)) {
      throw invalidArg('invalid_timeline', `可见片段重叠: ${id}`);
    }
    ranges.push({ start: clip.startMs, end });
    visibleMediaByTrack.set(trackId, ranges);
  }
  return timeline;
}


export function refreshTimelineSources(state, doc, nodeIds) {
  const ids = Array.isArray(nodeIds) ? nodeIds.map(String) : [];
  if (ids.length === 0 || ids.length > 50) {
    throw invalidArg('invalid_params', 'refreshNodeIds 需要1至50个不同节点');
  }
  const selected = new Set();
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || selected.has(trimmed)) {
      throw invalidArg('invalid_params', 'refreshNodeIds 不能包含空节点或重复节点');
    }
    selected.add(trimmed);
  }
  const timeline = doc.timeline;
  if (!timeline || typeof timeline !== 'object' || !Array.isArray(timeline.clips)) {
    throw invalidArg('invalid_timeline', '当前画布没有可更新的时间线');
  }
  validateTimelineShape(timeline, doc);
  const found = new Set();
  for (const clip of timeline.clips) {
    const nodeId = String(clip?.nodeId || '');
    if (!selected.has(nodeId) || clip.kind === 'subtitle') continue;
    const node = (doc.nodes || []).find((item) => item.id === nodeId);
    const resourceId = resourceIDFromNode(node);
    if (!resourceId) {
      throw invalidArg('timeline_resource_required', '时间线节点须明确关联一个资源');
    }
    const resource = state.resources.get(resourceId);
    if (!resource) {
      throw invalidArg('timeline_resource_required', '时间线节点须明确关联一个资源');
    }
    clip.directMedia = {
      id: resourceId,
      assetId: String(node?.metadata?.assetId || resource.assetId || ''),
      kind: String(resource.kind || ''),
      storageKey: `resource:${resourceId}`,
    };
    found.add(nodeId);
  }
  if (found.size !== selected.size) {
    throw invalidArg('timeline_node_not_used', '指定节点没有对应的媒体片段，未修改时间线');
  }
  return doc;
}
