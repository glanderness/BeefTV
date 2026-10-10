import { test, expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import descriptors from './operation-descriptors.fixture.json';
import { createOperationBridge } from './operation-bridge.mjs';
import { durableToolReplay } from './durable-session-owner.mjs';
import { newTurnAccumulator } from './canvas-turn.mjs';

test('Go descriptors drive default Pi discovery, calls and durable replay', async () => {
 const writes = [];
 const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/ops') {
   res.end(JSON.stringify({code:0, data:{ops:[...descriptors, {id:'unknown.write', readOnly:false}]}})); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  writes.push(JSON.parse(raw));
  res.end(JSON.stringify({code:0,data:{result:{canvasId:'canvas-a', revision:2, created:[{id:'row-a',shotNumber:1}]}}}));
 });
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 try {
  const bridge = createOperationBridge({opsUrl:`http://127.0.0.1:${server.address().port}`,hostToken:'test',turnBudgetContext:new AsyncLocalStorage()});
  await bridge.loadDescriptors();
  const build = mode => bridge.buildTools('canvas-a',[],{aborted:false,...(mode ? {permissionMode:mode}: {})},newTurnAccumulator(),'session');
  const tools = build();
  for (const id of ['canvas.script.rows.append','canvas.script.row.update','canvas.script.row.remove']) {
   const tool = tools.find(tool => tool.label === id);
   expect(tool).toBeDefined(); expect(durableToolReplay(tool)).toBe('safe');
   expect(build('read-only').some(tool => tool.label === id)).toBe(false);
   expect(build('full-access').some(tool => tool.label === id)).toBe(true);
  }
  expect(tools.some(tool => tool.label === 'canvas.document.commit')).toBe(false);
  expect(build('read-only').some(tool => tool.label === 'canvas.generation.propose')).toBe(false);
  expect(build('full-access').some(tool => tool.label === 'conversation.message.attach')).toBe(false);
  expect(tools.some(tool => tool.label === 'unknown.write')).toBe(false);
  expect(build('full-access').some(tool => tool.label === 'unknown.write')).toBe(false);
  expect(durableToolReplay({label:'canvas.script.rows.append'})).toBe('unsafe');
  const append = tools.find(tool => tool.label === 'canvas.script.rows.append');
  await append.execute('call-1',{nodeId:'script',expectedRevision:1,rows:[{durationSeconds:6}]});
  expect(writes[0].params.canvasId).toBe('canvas-a');
  expect(writes[0].opId).toBeTruthy();
  await expect(append.execute('call-2',{canvasId:'other',nodeId:'script',expectedRevision:1,rows:[{}]})).rejects.toThrow('scope_denied');
  expect(writes).toHaveLength(1);
 } finally { await new Promise(resolve => server.close(resolve)); }
});
