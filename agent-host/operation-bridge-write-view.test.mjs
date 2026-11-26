import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { createOperationBridge } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';
import { canvasWriteView } from './canvas-write-view.mjs';
import { canvasNodesGetView } from './canvas-read-view.mjs';
import { boundOutput } from '@earendil-works/chord/output';

// Documented Pi tool-output limits, exercised through the public shared API.
const DEFAULT_MAX_BYTES = 50 * 1024, DEFAULT_MAX_LINES = 2000;

const longPrompt = '镜'.repeat(9000);

async function fixture(run) {
  const node = { id: 'shot', type: 'image', title: '首帧', metadata: {
    composerContent: longPrompt, content: 'resource:rendered', model: 'resolved-model', prompt: longPrompt,
    size: '9:16', status: 'success', taskFailureDiagnostics: { message: 'unrelated'.repeat(10000) },
  } };
  const original = JSON.stringify(node), requests = [], seen = new Set();
  const descriptors = ['canvas.node.configure', 'canvas.node.update', 'canvas.node.bind_asset', 'canvas.get'].map(id => ({
    id, summary: id, assistantModes: ['canvas'], replay: 'safe', readOnly: id === 'canvas.get',
    params: { type: 'object', properties: { canvasId: { type: 'string' }, nodeId: { type: 'string' },
      expectedRevision: { type: 'integer' }, patch: { type: 'object', properties: { content: { type: 'string' }, title: { type: 'string' } } } } },
  }));
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') { res.end(JSON.stringify({ code: 0, data: { ops: descriptors } })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    if (req.url === '/ops/canvas.get') {
      res.end(JSON.stringify({ code: 0, data: { result: { canvasId: 'canvas', canvas: { revision: 42, nodes: [node], connections: [] } } } }));
      return;
    }
    const replayed = seen.has(input.opId); seen.add(input.opId);
    // Match Go map order: revision follows the full node, including its large metadata.
    res.end(JSON.stringify({ code: 0, data: { op: req.url.slice(5), replayed, result: {
      assetId: 'asset', canvasId: 'canvas', draftConfigured: req.url.endsWith('configure'), node,
      nodeId: 'shot', referenceBound: req.url.endsWith('bind_asset'), resourceId: 'rendered', revision: 42,
    } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'fixture', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    const turn = resetTurnAccumulator(newTurnAccumulator(), 1, 'turn');
    const tools = bridge.buildTools('canvas', [], { aborted: false }, turn, 'session');
    const call = (id, args, callId = 'write') => tools.find(t => t.label === id).execute(callId, args);
    await run({ call, node, turn, requests });
    expect(JSON.stringify(node)).toBe(original);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

function retainedJSON(output) {
  const retained = boundOutput(output.content[0].text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: 'head' });
  expect(retained.droppedBytes).toBe(0);
  expect(retained.bytes).toBeLessThan(8000);
  return JSON.parse(retained.text);
}

describe('node write receipts keep their identity within official tool output limits', () => {
  test('task binding keeps current identity/status and omits the large canvas without mutating Go receipts', () => {
    const data = { replayed: true, result: { canvasId: 'canvas', revision: 99, nodeId: 'film', taskId: 'render',
      bindingStatus: 'replaced', assetId: 'asset', resourceId: 'resource', storageKey: 'resource:resource',
      alsoChanged: [{ nodeId: 'batch-root', fields: ['assetId'] }],
      canvas: { nodes: [{ metadata: { prompt: longPrompt.repeat(10) } }] }, node: { metadata: { prompt: longPrompt } },
      historical: { revision: 3, node: { metadata: { prompt: longPrompt } } } } };
    const original = JSON.stringify(data);
    const view = canvasWriteView(data, 'canvas.task.bind');
    const projected = retainedJSON({ content: [{ type: 'text', text: JSON.stringify(view) }] });
    expect(projected.result).toMatchObject({ canvasId: 'canvas', revision: 99, nodeId: 'film', taskId: 'render', bindingStatus: 'replaced',
      assetId: 'asset', resourceId: 'resource', storageKey: 'resource:resource',
      alsoChanged: [{ nodeId: 'batch-root', fields: ['assetId'] }] });
    expect(projected.result.canvas).toBeUndefined();
    expect(projected.result.historical).toBeUndefined();
    expect(JSON.stringify(data)).toBe(original);
  });
  test('short text edits retain actual values, leave the stored receipt intact and do not affect other operations', () => {
    const data = { replayed: false, result: { canvasId: 'canvas', nodeId: 'text', revision: 7,
      node: { id: 'text', type: 'text', title: '实际名称', position: { x: 1, y: 2 }, metadata: { content: '实际正文', custom: 'keep' } },
    } };
    const original = JSON.stringify(data);
    const output = canvasWriteView(data, 'canvas.node.update', { patch: { title: '请求名称', content: '请求正文' } });
    expect(output.result.node).toEqual({ id: 'text', type: 'text', title: '实际名称', metadata: { content: '实际正文' } });
    expect(JSON.stringify(data)).toBe(original);
    expect(canvasWriteView(data, 'canvas.get')).toBe(data);
    expect(canvasWriteView(data, 'canvas.task.bind')).toBe(data);
    const missingNode = { result: { nodeId: 'text', revision: 7 } };
    expect(canvasWriteView(missingNode, 'canvas.node.update')).toBe(missingNode);
  });

  test('model catalog and generation propose omit raw pricing tables so the assistant only reports proposal estimates', () => {
    const catalogData = {
      result: {
        source: 'local',
        channels: [{
          id: 'beeftv',
          models: [{
            id: 'seedance-2.0',
            modelKey: 'seedance-2.0',
            capability: 'video',
            videoPricing: { currency: 'CNY', mode: 'tokens', rates: { '720p': { output: 28 }, '1080p': { output: 31.104 } } },
          }],
        }],
      },
    };
    const projectedCatalog = canvasWriteView(catalogData, 'model.catalog');
    expect(projectedCatalog.result.channels[0].models[0].videoPricing).toBeUndefined();
    expect(catalogData.result.channels[0].models[0].videoPricing).toBeDefined();

    const proposeData = {
      result: {
        proposalId: 'gp-1',
        modelKey: 'beeftv::seedance-2.0',
        pricing: { currency: 'CNY', mode: 'tokens', rates: { '720p': { output: 28 } } },
        estimate: { amount: 4.968, approx: true, text: '预计费用：约 ¥4.97' },
        targets: [{
          nodeId: 'v1',
          pricing: { currency: 'CNY', mode: 'tokens', rates: { '720p': { output: 28 } } },
          estimate: { amount: 4.968, approx: true, text: '约 ¥4.97' },
        }],
      },
    };
    const projectedPropose = canvasWriteView(proposeData, 'canvas.generation.propose');
    expect(projectedPropose.result.pricing).toBeUndefined();
    expect(projectedPropose.result.targets[0].pricing).toBeUndefined();
    expect(projectedPropose.result.estimate).toEqual(proposeData.result.estimate);
    expect(projectedPropose.result.targets[0].estimate).toEqual(proposeData.result.targets[0].estimate);
    expect(proposeData.result.pricing).toBeDefined();
  });

  test.each(['canvas.node.configure', 'canvas.node.update', 'canvas.node.bind_asset'])('%s omits unrelated node data without changing the write, effects or replay', async operation => {
    await fixture(async ({ call, turn, requests }) => {
      const patch = operation.endsWith('configure') ? { model: 'display-model', size: '9:16' } : { title: '首帧' };
      const args = { nodeId: 'shot', expectedRevision: 41, ...(operation.endsWith('bind_asset') ? { assetId: 'asset' } : { patch }) };
      const output = retainedJSON(await call(operation, args));
      expect(output.result.revision).toBe(42);
      expect(output.result.nodeId).toBe('shot');
      expect(output.result.node).toMatchObject({ id: 'shot', title: '首帧', type: 'image' });
      expect(output.result.node.metadata?.prompt).toBeUndefined();
      expect(output.result.node.metadata?.taskFailureDiagnostics).toBeUndefined();
      if (operation.endsWith('configure')) expect(output.result.node.metadata).toEqual({ model: 'resolved-model', size: '9:16' });
      if (operation.endsWith('bind_asset')) expect(output.result).toMatchObject({ assetId: 'asset', resourceId: 'rendered', referenceBound: true });
      expect(output.result.writeView).toEqual({ complete: false, omittedNodeFields: true, readView: { nodeId: 'shot', expectedRevision: 42 } });
      expect(turn.revisionAfter).toBe(42);
      expect(turn.updatedNodeIds).toContain('shot');
      expect(turn.operationIds).toHaveLength(1);
      const replay = retainedJSON(await call(operation, args));
      expect(replay.replayed).toBe(true);
      expect(replay.result).toEqual(output.result);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0].params).toEqual({ ...args, canvasId: 'canvas' });
    });
  });

  test('a changed long draft has an explicit preview and its exact original stays readable', async () => {
    await fixture(async ({ call, requests }) => {
      const output = retainedJSON(await call('canvas.node.update', { nodeId: 'shot', expectedRevision: 41, patch: { content: longPrompt } }));
      const field = output.result.node.metadata.composerContent;
      expect(field.complete).toBe(false);
      expect(field.characters).toBe(longPrompt.length);
      expect(field.preview).toBe(longPrompt.slice(0, 160));
      expect(field.readView).toEqual({ nodeId: 'shot', fieldPath: '/metadata/composerContent', expectedRevision: 42 });
      expect(requests[0].params.patch.content).toBe(longPrompt);
      let restored = '', textOffset = 0;
      for (;;) {
        const read = JSON.parse((await call('canvas.get', { readView: { ...field.readView, textOffset } }, `read-${textOffset}`)).content[0].text).result;
        restored += read.value;
        if (read.readView.nextTextOffset === undefined) break;
        textOffset = read.readView.nextTextOffset;
      }
      expect(restored).toBe(longPrompt);
    });
  });

  test('canvas.nodes.configure write view compacts large batch receipts without mutating original Go data', () => {
    const nodes = Array.from({ length: 30 }, (_, index) => ({
      canvasId: 'canvas',
      nodeId: `shot-${index + 1}`,
      draftConfigured: true,
      revision: 12,
      node: {
        id: `shot-${index + 1}`,
        type: 'image',
        metadata: { prompt: longPrompt, taskFailureDiagnostics: { message: 'big'.repeat(500) } },
      },
    }));
    const data = { replayed: false, result: { canvasId: 'canvas', revision: 12, nodes } };
    const original = JSON.stringify(data);
    const projected = retainedJSON({ content: [{ type: 'text', text: JSON.stringify(canvasWriteView(data, 'canvas.nodes.configure')) }] });
    expect(projected.result.canvasId).toBe('canvas');
    expect(projected.result.revision).toBe(12);
    expect(projected.result.nodes).toHaveLength(30);
    expect(projected.result.nodes[0]).toEqual({ nodeId: 'shot-1', draftConfigured: true, revision: 12 });
    expect(projected.result.writeView).toEqual({ complete: false, omittedNodeFields: true });
    expect(JSON.stringify(data)).toBe(original);
  });

  test('canvas.nodes.get read view compacts noisy/long fields and stays bounded on large batches', () => {
    const nodes = Array.from({ length: 60 }, (_, index) => ({
      id: `shot-${index + 1}`,
      type: 'image',
      title: `镜头 ${index + 1}`,
      metadata: {
        prompt: longPrompt,
        model: 'seedream-5.0',
        taskFailureDiagnostics: { message: 'noisy'.repeat(1000) },
      },
    }));
    const data = { result: { canvasId: 'canvas', revision: 15, nodes, missingNodeIds: ['missing-1'] } };
    const original = JSON.stringify(data);
    const view = canvasNodesGetView(data);
    const text = JSON.stringify(view);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(40000);
    expect(view.result.missingNodeIds).toEqual(['missing-1']);
    expect(view.result.nodes[0].metadata.prompt.complete).toBe(false);
    expect(view.result.nodes[0].metadata.prompt.readView).toEqual({
      nodeId: 'shot-1',
      fieldPath: '/metadata/prompt',
      expectedRevision: 15,
    });
    expect(view.result.nodes[0].metadata.taskFailureDiagnostics.complete).toBe(false);
    expect(view.result.readView.complete).toBe(false);
    expect(JSON.stringify(data)).toBe(original);
  });

  test('canvas.nodes.get budgets huge missingNodeIds without starving found nodes', () => {
    const foundNode = { id: 'real-1', type: 'image', title: '存在的图', metadata: { model: 'seedream-5.0' } };
    const missingNodeIds = Array.from({ length: 3000 }, (_, i) => `missing-node-id-${i + 1}`);
    const data = { result: { canvasId: 'canvas', revision: 7, nodes: [foundNode], missingNodeIds } };
    const original = JSON.stringify(data);
    const view = canvasNodesGetView(data);
    const text = JSON.stringify(view);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(40000);
    expect(view.result.nodes).toEqual([foundNode]);
    expect(view.result.omittedMissingCount).toBeGreaterThan(0);
    expect(view.result.missingNodeIds.length + view.result.omittedMissingCount).toBe(3000);
    expect(view.result.readView).toMatchObject({ complete: false, partialFields: 0 });
    expect(JSON.stringify(data)).toBe(original);
  });

  test('canvas.generation.propose strips order/pricing and stays under 50KiB for 80 mixed targets', () => {
    const chinesePrompt = '赛博朋克雨夜霓虹街道特写镜头，电影级光影质感。'.repeat(14);
    const allTargets = Array.from({ length: 80 }, (_, index) => ({
      nodeId: `target-${index + 1}`,
      title: `镜头 ${index + 1}`,
      kind: index % 3 === 0 ? 'image' : index % 3 === 1 ? 'video' : 'audio',
      modelKey: 'beeftv::seedream-5.0',
      prompt: chinesePrompt,
      parameters: { size: '16:9', quality: '2k' },
      pricing: { currency: 'CNY', rates: { '2k': 0.4 } },
      estimate: { amount: 0.4, text: '预计 ¥0.40' },
    }));
    const firstBatch = allTargets.slice(0, 40);
    const data = {
      result: {
        proposalId: 'gp-large-80',
        orderId: 'gp-large-80',
        kind: 'image',
        nodeIds: firstBatch.map(t => t.nodeId),
        model: 'seedream-5.0',
        modelKey: 'beeftv::seedream-5.0',
        pricing: { currency: 'CNY', rates: { '2k': 0.4 } },
        estimate: { amount: 16, priced: 40, unknown: 0, text: '预计费用：¥16.00' },
        approvalMode: 'ask',
        status: 'pending',
        source: { canvasId: 'canvas', canvasRevision: 9, modelConfigRevision: 2 },
        targets: firstBatch,
        production: {
          targets: allTargets,
          estimate: { amount: 32, priced: 80, unknown: 0, text: '整片预计费用：¥32.00' },
        },
        order: {
          orderId: 'gp-large-80',
          pricing: { currency: 'CNY', secretRate: 0.4 },
          targets: allTargets,
          targetViews: allTargets,
        },
      },
    };
    const original = JSON.stringify(data);
    const view = canvasWriteView(data, 'canvas.generation.propose');
    const serialized = JSON.stringify(view);
    const bounded = boundOutput(serialized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: 'head' });
    expect(bounded.droppedBytes).toBe(0);
    expect(bounded.bytes).toBeLessThanOrEqual(40000);
    const parsed = JSON.parse(bounded.text);
    expect(parsed.result.proposalId).toBe('gp-large-80');
    expect(parsed.result.order).toBeUndefined();
    expect(parsed.result.pricing).toBeUndefined();
    expect(serialized).not.toContain('secretRate');
    expect(parsed.result.estimate).toEqual(data.result.estimate);
    expect(parsed.result.production.estimate).toEqual(data.result.production.estimate);
    expect(parsed.result.targets.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).toBe(original);
  });

  test('canvas.generation.submit compacts and budgets 60 completed tasks within 50KiB', () => {
    const tasks = Array.from({ length: 60 }, (_, i) => ({
      id: `task-${i + 1}`,
      status: 'succeeded',
      resultState: 'ready',
      outcome: { phase: 'ready' },
      input: { prompt: longPrompt, config: { model: 'seedream-5.0' } },
      outputs: [{ outputIndex: 0, mediaType: 'image', resourceId: `res-${i + 1}`, rawPayload: longPrompt }],
    }));
    const data = {
      result: {
        canvasId: 'canvas',
        revision: 22,
        status: 'succeeded',
        taskIds: tasks.map(t => t.id),
        nodeIds: tasks.map((_, i) => `node-${i + 1}`),
        tasks,
      },
    };
    const original = JSON.stringify(data);
    const view = canvasWriteView(data, 'canvas.generation.submit');
    const bounded = boundOutput(JSON.stringify(view), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: 'head' });
    expect(bounded.droppedBytes).toBe(0);
    const parsed = JSON.parse(bounded.text);
    expect(parsed.result.revision).toBe(22);
    expect(parsed.result.status).toBe('succeeded');
    expect(parsed.result.tasks[0]).toEqual({
      id: 'task-1',
      status: 'succeeded',
      resultState: 'ready',
      outcome: { phase: 'ready' },
      outputs: [{ outputIndex: 0, mediaType: 'image', resourceId: 'res-1' }],
    });
    expect(JSON.stringify(data)).toBe(original);
  });

  test('canvas.nodes.configure bounds 500 configured nodes within 50KiB', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      canvasId: 'canvas',
      nodeId: `batch-node-identifier-${i + 1}`,
      draftConfigured: true,
      revision: 33,
      node: { id: `batch-node-identifier-${i + 1}`, metadata: { prompt: longPrompt } },
    }));
    const data = { replayed: false, result: { canvasId: 'canvas', revision: 33, nodes } };
    const view = canvasWriteView(data, 'canvas.nodes.configure');
    const bounded = boundOutput(JSON.stringify(view), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: 'head' });
    expect(bounded.droppedBytes).toBe(0);
    expect(bounded.bytes).toBeLessThanOrEqual(40000);
    const parsed = JSON.parse(bounded.text);
    expect(parsed.result.configuredCount).toBe(500);
    expect(parsed.result.nodes.length + (parsed.result.omittedNodeCount || 0)).toBe(500);
  });

  test('business.list retains tool params schemas while staying bounded within 40KiB', () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({
      id: `business_get_item_${i + 1}`,
      method: 'GET',
      path: `/items/:id`,
      readOnly: true,
      summary: `查询条目 ${i + 1}`,
      params: {
        type: 'object',
        properties: {
          path: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] },
          query: { type: 'object', properties: { page: { type: 'integer' } } },
        },
      },
    }));
    const data = { result: { total: 12, offset: 0, limit: 50, tools } };
    const view = canvasWriteView(data, 'business.list');
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThanOrEqual(40000);
    expect(view.result.tools).toHaveLength(12);
    expect(view.result.tools[0].params).toEqual(tools[0].params);

    // 单个超大 params schema 会被裁剪且绝不会把整页退化成空数组。
    const hugeProps = Object.fromEntries(
      Array.from({ length: 120 }, (_, idx) => [`field_${idx}`, { type: 'string', description: '超长字段说明'.repeat(80) }]),
    );
    const hugeView = canvasWriteView({
      result: {
        total: 2,
        offset: 0,
        limit: 10,
        tools: [
          { id: 'huge.tool', method: 'POST', path: '/api/huge', readOnly: false, summary: '大参数工具', params: { type: 'object', properties: hugeProps } },
          { id: 'small.tool', method: 'GET', path: '/api/small', readOnly: true, summary: '小参数工具', params: { type: 'object', properties: { id: { type: 'string' } } } },
        ],
      },
    }, 'business.list');
    expect(hugeView.result.tools.length).toBeGreaterThanOrEqual(1);
    expect(hugeView.result.tools[0].id).toBe('huge.tool');
    expect(hugeView.result.tools[0].params?.omittedPropertyCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(hugeView), 'utf8')).toBeLessThanOrEqual(40000);
  });
});
