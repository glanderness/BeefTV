import { test, expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { createOperationBridge } from './operation-bridge.mjs';
import { isToolPark } from './await-business-tasks.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';

function makeDurableApi() {
  let clock = 1000;
  const memos = new Map();
  let checkpoint = undefined;
  return {
    api: {
      taskId: 55,
      now: () => clock,
      get checkpoint() { return checkpoint; },
      wake: undefined,
      async memo(key, value) {
        if (arguments.length >= 3) {
          if (!memos.has(key)) memos.set(key, structuredClone(value));
          return structuredClone(memos.get(key));
        }
        return memos.has(key) ? structuredClone(memos.get(key)) : undefined;
      },
      async readSignal() { return undefined; },
    },
    advance(park) {
      checkpoint = structuredClone(park.sleep.checkpoint);
      clock = Math.max(clock, park.sleep.until);
    },
  };
}

for (const observationFails of [false, true]) {
  test(`render bridge preserves original task through ${observationFails ? 'observation failure' : 'saved output'}`, async () => {
    const paths = [];
    let reads = 0;
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      const wrap = (data) => res.end(JSON.stringify({ code: 0, data }));
      if (req.url === '/ops') {
        return wrap({
          ops: [{
            id: 'canvas.timeline.render',
            readOnly: false,
            replay: 'safe',
            assistantModes: ['canvas'],
            params: { type: 'object', properties: { canvasId: { type: 'string' }, expectedRevision: { type: 'integer' } } },
          }],
        });
      }
      if (req.url === '/assistant/runtime/task-waits') {
        res.writeHead(404);
        res.end(JSON.stringify({ code: 404, reason: 'not_found' }));
        return;
      }
      paths.push(req.url);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === '/ops/canvas.timeline.render') return wrap({ result: { canvasId: 'c', taskId: 'original-render', charged: false } });
      expect(body.params.taskId).toBe('original-render');
      if (observationFails) {
        res.writeHead(503);
        res.end(JSON.stringify({ code: 1, reason: 'temporarily_unavailable', msg: 'unavailable' }));
        return;
      }
      reads += 1;
      return wrap({ result: { status: 'succeeded', outputs: reads === 1 ? [] : [{ resourceId: 'saved-mp4' }] } });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const bridge = createOperationBridge({
        opsUrl: `http://127.0.0.1:${server.address().port}`,
        hostToken: 'test',
        turnBudgetContext: new AsyncLocalStorage(),
        reconcileIntervalMs: 50,
      });
      await bridge.loadDescriptors();
      const tool = bridge.buildTools('c', [], { aborted: false, modelEpoch: 0, intentEpoch: 0 }, resetTurnAccumulator(newTurnAccumulator(), 2, 'turn'), 'session')[0];
      const durable = makeDurableApi();
      let raw = await tool.execute('render', { expectedRevision: 2 }, undefined, { durableApi: durable.api, durableContext: {} });
      while (isToolPark(raw)) {
        durable.advance(raw);
        raw = await tool.execute('render', { expectedRevision: 2 }, undefined, { durableApi: durable.api, durableContext: {} });
      }
      const result = JSON.parse(raw.content[0].text).result;
      expect(result.status).toBe(observationFails ? 'pending' : 'succeeded');
      expect(result.taskId).toBe('original-render');
      if (observationFails) {
        expect(result.observationFailed).toBe(true);
        expect(paths).toEqual(['/ops/canvas.timeline.render', '/ops/task.get']);
      } else {
        expect(result.tasks[0].outputs[0].resourceId).toBe('saved-mp4');
        expect(paths).toEqual(['/ops/canvas.timeline.render', '/ops/task.get', '/ops/task.get']);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
