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
