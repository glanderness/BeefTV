// 操作桥：把已鉴权的共享 ops 能力变成官方 customTools。
// 画布 scope、operationId 与回合身份只在这里注入；业务规则仍在 Go 操作层。
// 内置助手对 canvas.node.update 做字段投影：模型只看到 title/content。
// 遗留 patch.prompt 仍留给 CLI/MCP；模型若编造该字段，在本桥拒绝，避免清空可见草稿。

import { collectTurnEffects } from './canvas-turn.mjs';
import { toolOperationId } from './session-identity.mjs';
import { budgetError, spendToolStep } from './request-budget.mjs';
import { mediaToolResult } from './media-content.mjs';
import { canvasReadView, CANVAS_READ_VIEW_SCHEMA } from './canvas-read-view.mjs';

const CANVAS_NODE_UPDATE = 'canvas.node.update';

export const ASSISTANT_CANVAS_NODE_UPDATE_PATCH = {
  title: {
    type: 'string',
    description: '节点名称。只在要改名时提交。',
  },
  content: {
    type: 'string',
    description: '媒体节点的下次生成提示词草稿，或文本节点的正文。只提交要改的字段；省略的字段保持原样。',
  },
};

export function createOperationBridge({
  opsUrl,
  hostToken,
  desktopToken = '',
  readOnly = false,
  turnBudgetContext,
  mediaModel = { api: '', modelId: '' },
  nativePartStore,
}) {
  const descriptors = new Map();

  async function opsRequest(method, apiPath, body, signal, turnId) {
    const timeoutMs = apiPath.startsWith('/ops/media.') ? 95000 : 30000;
    const response = await fetch(`${opsUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Beeftv-Agent-Token': hostToken,
        ...(turnId ? { 'X-Beeftv-Agent-Turn': turnId } : {}),
        ...(desktopToken ? { 'X-Desktop-Token': desktopToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let envelope = null;
    try { envelope = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!response.ok || !envelope || envelope.code !== 0) {
      const error = new Error(`${envelope?.reason || `http_${response.status}`}: ${envelope?.msg || text.slice(0, 200)}`);
      error.reason = envelope?.reason || `http_${response.status}`;
      error.details = envelope?.details || null;
      throw error;
    }
    return envelope.data;
  }

  async function loadDescriptors() {
    const data = await opsRequest('GET', '/ops');
    const ops = (data.ops || []).filter((descriptor) => !readOnly || descriptor.readOnly);
    descriptors.clear();
    for (const descriptor of ops) descriptors.set(descriptor.id.replace(/\./g, '_'), descriptor);
    return descriptors.size;
  }

  function buildTools(canvasId, log, generation, turn, identityPrefix) {
    const mode = generation.permissionMode || 'canvas';
    const canvasTools = new Set(['canvas.get','canvas.node.update','canvas.node.bind_asset','canvas.node.configure','canvas.node.move','canvas.node.delete','canvas.edge.delete','canvas.nodes.create','canvas.edge.create','canvas.timeline.update','canvas.timeline.render','canvas.generation.propose','canvas.task.bind','asset.get','task.get','media.overview','media.inspect','media.check','skill.get','skill.file','project.media.search','project.canvas.search','model.catalog']);
    return [...descriptors.entries()].filter(([,d])=>mode==='read-only' ? d.readOnly && d.id!=='canvas.generation.propose' : mode==='full-access' ? d.scope!=='conversation' : canvasTools.has(d.id)).map(([toolName, descriptor]) => ({
      name: toolName,
      label: descriptor.id,
      readOnly: descriptor.readOnly === true,
      description: descriptor.summary + (descriptor.id === 'canvas.get'
        ? '。返回有界只读视图：revision 与真实节点/连线；readView 标明完整或部分。沿 nextOffset 分页，长字段按 nodeId/fieldPath/textOffset 读取，不把 preview 当完整原文；后续读取带 expectedRevision。'
        : ''),
      parameters: scopedSchema(descriptor.params, mode !== 'canvas' || descriptor.id === 'canvas.get', descriptor.id),
      ...(descriptor.readOnly ? {} : { executionMode: 'sequential' }),
      execute: async (toolCallId, args, signal) => {
        if (generation.aborted || signal?.aborted) throw new Error('aborted');
        if (generation.permissionMode==='read-only' && (!descriptor.readOnly || descriptor.id==='canvas.generation.propose')) throw new Error('scope_denied: 本轮助手只能读取');
        if ((!descriptor.readOnly || descriptor.id === 'canvas.generation.propose') &&
            (generation.pendingInput?.state === 'pending' || generation.pendingInputError ||
             generation.modelEpoch !== generation.intentEpoch)) {
          throw new Error('turn_intent_changed: 已收到新的要求，先读取新要求再修改');
        }
        const budget = turnBudgetContext.getStore();
        const step = spendToolStep(budget);
        if (!step.allowed) {
          if (budget) budget.failure = step;
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: args || {}, isError: true, error: step.message });
          throw budgetError(step);
        }
        const params = { ...(args || {}) };
        const readView = descriptor.id === 'canvas.get' ? params.readView : undefined;
        if (descriptor.id === 'canvas.get') delete params.readView;
        delete params.operationId;
        delete params.opId;
        if (Object.hasOwn(descriptor.params?.properties || {}, 'canvasId')) {
          if ((generation.permissionMode || 'canvas') === 'canvas' && descriptor.id !== 'canvas.get' && params.canvasId !== undefined && params.canvasId !== canvasId) {
            throw new Error(`scope_denied: 画布参数与当前会话不一致（${params.canvasId} ≠ ${canvasId}）`);
          }
          if (params.canvasId === undefined) params.canvasId = canvasId;
        }
        let opId = '';
        if (!descriptor.readOnly) {
          if (!toolCallId) {
            throw new Error(`missing_tool_call_id: ${descriptor.id} 写入缺少工具调用标识，已拒绝以免重复写入`);
          }
          opId = toolOperationId(identityPrefix, toolCallId);
          if (descriptor.id === 'canvas.task.bind') {
            // Binding has one durable identity shared with automatic task delivery.
            // Normalize the default too, so a replay uses the same payload hash.
            params.taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
            params.nodeId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
            params.outputIndex = params.outputIndex ?? 0;
            if (!params.taskId || !params.nodeId || !Number.isSafeInteger(params.outputIndex) || params.outputIndex < 0) {
              throw new Error('invalid_params: 绑定产物需要有效任务、节点和输出序号');
            }
            opId = `attach-node:${params.taskId}:${params.nodeId}:${params.outputIndex}`;
          }
        }
        const started = Date.now();
        try {
          assertAssistantNodeUpdateArgs(descriptor, params);
          const data = await opsRequest('POST', `/ops/${descriptor.id}`, { opId, params }, signal, turn.turnId);
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: params, isError: false, ms: Date.now() - started, replayed: !!data?.replayed });
          // A binding replay projects the current canvas, not a write by this turn.
          if (descriptor.id !== 'canvas.task.bind' || !data?.replayed) {
            collectTurnEffects(turn, descriptor.id, data?.result, opId);
          }
          return mediaToolResult(descriptor.id === 'canvas.get' ? canvasReadView(data, readView) : data, descriptor.id, { ...mediaModel, originTurnId:turn.turnId,
            ...(generation.durable ? {nativePartStore} : {}) });
        } catch (error) {
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: params, isError: true, error: error.message, ms: Date.now() - started });
          throw error;
        }
      },
    }));
  }

  return { descriptors, opsRequest, loadDescriptors, buildTools };
}

export function scopedSchema(params, allowReferencedCanvasRead = false, descriptorId = '') {
  if (allowReferencedCanvasRead && typeof allowReferencedCanvasRead === 'object' && !Array.isArray(allowReferencedCanvasRead)) {
    const options = allowReferencedCanvasRead;
    descriptorId = options.descriptorId || descriptorId;
    allowReferencedCanvasRead = options.allowReferencedCanvasRead === true;
  }
  if (!params || typeof params !== 'object') return params;
  const clone = JSON.parse(JSON.stringify(params));
  if (clone.properties) {
    if (!allowReferencedCanvasRead) delete clone.properties.canvasId;
    delete clone.properties.operationId;
  }
  if (Array.isArray(clone.required)) clone.required = clone.required.filter((name) => name !== 'canvasId' && name !== 'operationId');
  if (descriptorId === CANVAS_NODE_UPDATE) projectCanvasNodeUpdateSchema(clone);
  if (descriptorId === 'canvas.get') {
    clone.properties ||= {};
    clone.properties.readView = JSON.parse(JSON.stringify(CANVAS_READ_VIEW_SCHEMA));
  }
  return clone;
}

function projectCanvasNodeUpdateSchema(schema) {
  if (!schema?.properties || typeof schema.properties !== 'object') return;
  const patch = schema.properties.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  patch.properties = {
    title: { ...ASSISTANT_CANVAS_NODE_UPDATE_PATCH.title },
    content: { ...ASSISTANT_CANVAS_NODE_UPDATE_PATCH.content },
  };
  patch.additionalProperties = false;
  if (Array.isArray(patch.required)) {
    patch.required = patch.required.filter((name) => name === 'title' || name === 'content');
  }
}

function assertAssistantNodeUpdateArgs(descriptor, params) {
  if (descriptor.id !== CANVAS_NODE_UPDATE) return;
  const patch = params?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  if (!Object.hasOwn(patch, 'prompt')) return;
  throw new Error('unsupported_patch_field: canvas.node.update 不能提交 patch.prompt。改可编辑提示词请用 content，未改的字段不要提交');
}
