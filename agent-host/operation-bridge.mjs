// 操作桥：把已鉴权的共享 ops 能力变成官方 customTools。
// 画布 scope、operationId 与回合身份只在这里注入；业务规则仍在 Go 操作层。

import { collectTurnEffects } from './canvas-turn.mjs';
import { toolOperationId } from './session-identity.mjs';
import { budgetError, spendToolStep } from './request-budget.mjs';

export function createOperationBridge({
  opsUrl,
  hostToken,
  desktopToken = '',
  readOnly = false,
  turnBudgetContext,
}) {
  const descriptors = new Map();

  async function opsRequest(method, apiPath, body, signal, turnId) {
    const response = await fetch(`${opsUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Beeftv-Agent-Token': hostToken,
        ...(turnId ? { 'X-Beeftv-Agent-Turn': turnId } : {}),
        ...(desktopToken ? { 'X-Desktop-Token': desktopToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
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
    return [...descriptors.entries()].map(([toolName, descriptor]) => ({
      name: toolName,
      label: descriptor.id,
      description: `${descriptor.summary}（本会话 scope=canvas:${canvasId}）`,
      parameters: scopedSchema(descriptor.params, descriptor.id === 'canvas.get'),
      ...(descriptor.readOnly ? {} : { executionMode: 'sequential' }),
      execute: async (toolCallId, args, signal) => {
        if (generation.aborted || signal?.aborted) throw new Error('aborted');
        const budget = turnBudgetContext.getStore();
        const step = spendToolStep(budget);
        if (!step.allowed) {
          if (budget) budget.failure = step;
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: args || {}, isError: true, error: step.message });
          throw budgetError(step);
        }
        const params = { ...(args || {}) };
        delete params.operationId;
        delete params.opId;
        if (Object.hasOwn(descriptor.params?.properties || {}, 'canvasId')) {
          if (descriptor.id !== 'canvas.get' && params.canvasId !== undefined && params.canvasId !== canvasId) {
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
        }
        const started = Date.now();
        try {
          const data = await opsRequest('POST', `/ops/${descriptor.id}`, { opId, params }, signal, turn.turnId);
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: params, isError: false, ms: Date.now() - started, replayed: !!data?.replayed });
          collectTurnEffects(turn, descriptor.id, data?.result, opId);
          return { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch (error) {
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: params, isError: true, error: error.message, ms: Date.now() - started });
          throw error;
        }
      },
    }));
  }

  return { descriptors, opsRequest, loadDescriptors, buildTools };
}

export function scopedSchema(params, allowReferencedCanvasRead = false) {
  if (!params || typeof params !== 'object') return params;
  const clone = JSON.parse(JSON.stringify(params));
  if (clone.properties) {
    if (!allowReferencedCanvasRead) delete clone.properties.canvasId;
    delete clone.properties.operationId;
  }
  if (Array.isArray(clone.required)) clone.required = clone.required.filter((name) => name !== 'canvasId' && name !== 'operationId');
  return clone;
}
