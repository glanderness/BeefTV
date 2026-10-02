import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { createTurnBudget } from './request-budget.mjs';
import { ASSISTANT_CANVAS_NODE_UPDATE_PATCH, createOperationBridge, scopedSchema } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('操作桥', () => {
  test('任务绑定与自动交付共用产物身份，跨会话重试不制造第二次效果', async () => {
    const seen = [];
    const receipts = new Set();
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/ops') {
        res.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.task.bind', readOnly: false,
          params: { type: 'object', properties: { canvasId: { type: 'string' }, taskId: { type: 'string' }, nodeId: { type: 'string' }, outputIndex: { type: 'integer' } } } }] } }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seen.push(body);
      const { taskId, nodeId, outputIndex } = body.params;
      const key = `attach-node:${taskId}:${nodeId}:${outputIndex}`;
      if (body.opId !== key) {
        res.writeHead(400); res.end(JSON.stringify({ code: 1, reason: 'effect_identity_mismatch' })); return;
      }
      const replayed = receipts.has(key);
      receipts.add(key);
      res.end(JSON.stringify({ code: 0, data: { replayed, result: { revision: 3, nodeId } } }));
    });
    const port = await listen(server);
    try {
      const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${port}`, hostToken: 'test-only', turnBudgetContext: new AsyncLocalStorage() });
      await bridge.loadDescriptors();
      const turns = new Map();
      const tool = (session) => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 1, `turn-${session}`);
        turns.set(session, turn);
        return bridge.buildTools('canvas-1', [], { aborted: false }, turn, session)[0];
      };
      const first = await tool('session-A').execute('call-A', { taskId: ' task-1 ', nodeId: ' node-1 ', operationId: 'forged' });
      const replay = await tool('session-B').execute('call-B', { taskId: 'task-1', nodeId: 'node-1', outputIndex: 0 });
      expect(JSON.parse(first.content[0].text).replayed).toBe(false);
      expect(JSON.parse(replay.content[0].text).replayed).toBe(true);
      expect(seen[0]).toEqual({ opId: 'attach-node:task-1:node-1:0', params: { taskId: 'task-1', nodeId: 'node-1', canvasId: 'canvas-1', outputIndex: 0 } });
      expect(seen[1]).toEqual(seen[0]);
      expect(turns.get('session-A').updatedNodeIds).toEqual(['node-1']);
      expect(turns.get('session-B').updatedNodeIds).toEqual([]);
      expect(turns.get('session-B').operationIds).toEqual([]);
      expect(turns.get('session-B').revisionAfter).toBe(0);
      for (const outputIndex of [-1, 0.5, '0']) {
        await expect(tool('session-A').execute('bad', { taskId: 'task-1', nodeId: 'node-1', outputIndex })).rejects.toThrow('invalid_params');
      }
      await expect(tool('session-A').execute('foreign', { canvasId: 'other', taskId: 'task-1', nodeId: 'node-1' })).rejects.toThrow('scope_denied');
      expect(seen).toHaveLength(2);
      expect(receipts.size).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('schema 去掉 canvasId 与 operationId，引用画布读取可保留 canvasId', () => {
    const params = {
      type: 'object',
      properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, title: { type: 'string' } },
      required: ['canvasId', 'operationId', 'title'],
    };
    expect(scopedSchema(params)).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    expect(scopedSchema(params, true).properties.canvasId).toEqual({ type: 'string' });
    expect(scopedSchema(params, true).properties.operationId).toBeUndefined();
  });

  test('真实 HTTP：凭据与回合头到达 ops，写入 identity 绑定会话', async () => {
    const seen = [];
    const opsServer = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({
        url: req.url,
        token: req.headers['x-beeftv-agent-token'],
        turn: req.headers['x-beeftv-agent-turn'],
        body: body ? JSON.parse(body) : {},
      });
      if (req.url === '/ops') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            ops: [{
              id: 'canvas.nodes.create',
              summary: 'Create node',
              readOnly: false,
              params: { type: 'object', properties: { canvasId: { type: 'string' }, nodes: { type: 'array' } }, required: ['canvasId', 'nodes'] },
            }],
          },
        }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { op: 'canvas.nodes.create', replayed: false, result: { revision: 2, created: [{ id: 'n1' }] } } }));
    });
    const port = await listen(opsServer);
    const turnBudgetContext = new AsyncLocalStorage();
    try {
      const bridge = createOperationBridge({
        opsUrl: `http://127.0.0.1:${port}`,
        hostToken: 'host-secret',
        desktopToken: '',
        readOnly: false,
        turnBudgetContext,
      });
      await bridge.loadDescriptors();
      const log = [];
      const generation = { aborted: false };
      const turn = resetTurnAccumulator(newTurnAccumulator(), 1, 'turn-9');
      const tools = bridge.buildTools('canvas-1', log, generation, turn, 'sess-A');
      expect(tools[0].parameters.properties.canvasId).toBeUndefined();
      const budget = createTurnBudget({ maxToolSteps: 4 });
      const result = await turnBudgetContext.run(budget, () => tools[0].execute('call-7', { nodes: [{ title: '镜头' }] }, undefined));
      expect(JSON.parse(result.content[0].text).result.created[0].id).toBe('n1');
      const write = seen.find((item) => item.url === '/ops/canvas.nodes.create');
      expect(write.token).toBe('host-secret');
      expect(write.turn).toBe('turn-9');
      expect(write.body.opId).toBe('sess-A:call-7');
      expect(write.body.params.canvasId).toBe('canvas-1');
      expect(write.body.params.operationId).toBeUndefined();
    } finally {
      opsServer.closeAllConnections();
      await new Promise((resolve) => opsServer.close(resolve));
    }
  });
});

const NODE_UPDATE_PARAMS = {
  type: 'object',
  properties: {
    canvasId: { type: 'string' },
    nodeId: { type: 'string' },
    expectedRevision: { type: 'integer' },
    patch: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  required: ['canvasId', 'nodeId', 'patch', 'expectedRevision'],
};

const NODE_CREATE_PARAMS = {
  type: 'object',
  properties: {
    canvasId: { type: 'string' },
    expectedRevision: { type: 'integer' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, type: { type: 'string' }, prompt: { type: 'string' } },
        required: ['title', 'type'],
      },
    },
  },
  required: ['canvasId', 'nodes', 'expectedRevision'],
};

function nodeUpdateOps() {
  return [
    { id: 'canvas.node.update', summary: '局部修改一个节点', readOnly: false, params: JSON.parse(JSON.stringify(NODE_UPDATE_PARAMS)) },
    { id: 'canvas.nodes.create', summary: '批量创建节点', readOnly: false, params: JSON.parse(JSON.stringify(NODE_CREATE_PARAMS)) },
  ];
}

async function withNodeUpdateBridge(run) {
  const seen = [];
  const opsServer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, body: parsed });
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: nodeUpdateOps() } }));
      return;
    }
    res.end(JSON.stringify({
      code: 0,
      data: { op: req.url.slice('/ops/'.length), replayed: false, result: { revision: 4, nodeId: parsed.params?.nodeId } },
    }));
  });
  const port = await listen(opsServer);
  const turnBudgetContext = new AsyncLocalStorage();
  try {
    const bridge = createOperationBridge({
      opsUrl: `http://127.0.0.1:${port}`,
      hostToken: 'host-secret',
      desktopToken: '',
      readOnly: false,
      turnBudgetContext,
    });
    await bridge.loadDescriptors();
    await run({ bridge, seen, turnBudgetContext });
  } finally {
    opsServer.closeAllConnections();
    await new Promise((resolve) => opsServer.close(resolve));
  }
}

describe('内置助手节点更新投影', () => {
  test('boolean 第二参数保持兼容：不声明 descriptor 时不隐藏 prompt', () => {
    const snapshot = JSON.stringify(NODE_UPDATE_PARAMS);
    expect(scopedSchema(NODE_UPDATE_PARAMS, false).properties.patch.properties.prompt).toEqual({ type: 'string' });
    expect(scopedSchema(NODE_UPDATE_PARAMS).properties.canvasId).toBeUndefined();
    expect(JSON.stringify(NODE_UPDATE_PARAMS)).toBe(snapshot);
  });

  test('投影只暴露 title/content，并可用对象第二参数向后兼容', () => {
    const projected = scopedSchema(NODE_UPDATE_PARAMS, false, 'canvas.node.update');
    expect(projected.properties.patch.properties).toEqual(ASSISTANT_CANVAS_NODE_UPDATE_PATCH);
    expect(projected.properties.patch.additionalProperties).toBe(false);
    expect(projected.properties.patch.properties.prompt).toBeUndefined();
    expect(projected.properties.canvasId).toBeUndefined();
    expect(projected.required).toEqual(['nodeId', 'patch', 'expectedRevision']);

    const viaOptions = scopedSchema(NODE_UPDATE_PARAMS, { descriptorId: 'canvas.node.update' });
    expect(viaOptions.properties.patch.properties).toEqual(ASSISTANT_CANVAS_NODE_UPDATE_PATCH);
    expect(viaOptions.properties.canvasId).toBeUndefined();

    const viaReadOptions = scopedSchema(NODE_UPDATE_PARAMS, {
      allowReferencedCanvasRead: true,
      descriptorId: 'canvas.node.update',
    });
    expect(viaReadOptions.properties.canvasId).toEqual({ type: 'string' });
    expect(viaReadOptions.properties.patch.properties.prompt).toBeUndefined();
  });

  test('真实 customTools schema 隐藏 prompt，创建工具仍保留 prompt', async () => {
    await withNodeUpdateBridge(async ({ bridge }) => {
      const stored = bridge.descriptors.get('canvas_node_update');
      const original = JSON.parse(JSON.stringify(stored));
      const tools = bridge.buildTools('canvas-1', [], { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 3, 'turn-p'), 'sess-P');
      const update = tools.find((tool) => tool.name === 'canvas_node_update');
      const create = tools.find((tool) => tool.name === 'canvas_nodes_create');
      expect(update.parameters.properties.patch.properties).toEqual(ASSISTANT_CANVAS_NODE_UPDATE_PATCH);
      expect(update.parameters.properties.patch.properties.content.description).toContain('下次生成提示词草稿');
      expect(update.parameters.properties.patch.properties.content.description).toContain('文本节点的正文');
      expect(update.parameters.properties.patch.properties.content.description).toContain('省略的字段保持原样');
      expect(update.parameters.properties.patch.properties.prompt).toBeUndefined();
      expect(create.parameters.properties.nodes.items.properties.prompt).toEqual({ type: 'string' });
      expect(bridge.descriptors.get('canvas_node_update')).toEqual(original);
      expect(stored.params.properties.patch.properties.prompt).toEqual({ type: 'string' });
      update.parameters.properties.patch.properties.title.description = 'mutated';
      expect(stored.params.properties.patch.properties.title.description).toBeUndefined();
      expect(stored.params).toEqual(original.params);
    });
  });

  test('执行拒绝编造的 patch.prompt，且不转发到 ops', async () => {
    await withNodeUpdateBridge(async ({ bridge, seen, turnBudgetContext }) => {
      const tools = bridge.buildTools('canvas-1', [], { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 3, 'turn-p'), 'sess-P');
      const update = tools.find((tool) => tool.name === 'canvas_node_update');
      const budget = createTurnBudget({ maxToolSteps: 4 });
      await expect(turnBudgetContext.run(budget, () => update.execute('call-repro', {
        nodeId: 'img-1',
        expectedRevision: 3,
        patch: { content: '', prompt: '新的提示词', title: '新名字' },
      }))).rejects.toThrow(/unsupported_patch_field: canvas\.node\.update 不能提交 patch\.prompt/);
      expect(seen.filter((item) => item.url === '/ops/canvas.node.update')).toEqual([]);
    });
  });

  test('content 原样转发，不改写字段，省略的字段不会被补上', async () => {
    await withNodeUpdateBridge(async ({ bridge, seen, turnBudgetContext }) => {
      const tools = bridge.buildTools('canvas-1', [], { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 3, 'turn-p'), 'sess-P');
      const update = tools.find((tool) => tool.name === 'canvas_node_update');
      const budget = createTurnBudget({ maxToolSteps: 4 });
      await turnBudgetContext.run(budget, () => update.execute('call-content', {
        nodeId: 'img-1',
        expectedRevision: 3,
        patch: { title: '新名字', content: '夜景：雨夜巷口对峙' },
      }));
      await turnBudgetContext.run(budget, () => update.execute('call-title-only', {
        nodeId: 'img-1',
        expectedRevision: 4,
        patch: { title: '只改名' },
      }));
      const writes = seen.filter((item) => item.url === '/ops/canvas.node.update');
      expect(writes[0].body.params).toEqual({
        nodeId: 'img-1',
        expectedRevision: 3,
        patch: { title: '新名字', content: '夜景：雨夜巷口对峙' },
        canvasId: 'canvas-1',
      });
      expect(writes[1].body.params.patch).toEqual({ title: '只改名' });
      expect(Object.hasOwn(writes[1].body.params.patch, 'content')).toBe(false);
      expect(Object.hasOwn(writes[1].body.params.patch, 'prompt')).toBe(false);
      expect(writes[0].body.params.patch).not.toHaveProperty('prompt');
    });
  });
});
