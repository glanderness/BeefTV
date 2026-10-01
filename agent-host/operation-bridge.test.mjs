import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { createTurnBudget } from './request-budget.mjs';
import { createOperationBridge, scopedSchema } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('操作桥', () => {
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
