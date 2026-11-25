import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyModelFetchError, classifyModelHttpStatus, createDispatchDiagnostics, MODEL_OUTCOME_REASONS } from './dispatch-diagnostics.mjs';
import { fetchModelWithProgressIdle } from './model-stream-idle.mjs';

test('dispatch evidence survives reopen with exact identities and no request payload', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'agent-requests.jsonl');
  const first=createDispatchDiagnostics(file,'launch-1');
  assert.equal(first.record({requestId:'request-admitted-1',turnId:'1122334455667788',canvasId:'canvas-123',sessionId:'durable:11111111-2222-3333-4444-555555555555',model:'model-1',origin:'https://private.example',path:'/secret',apiKey:'PRIVATE',body:'prompt PRIVATE'}),true);
  createDispatchDiagnostics(file,'launch-2').record({turnId:'2233445566778899',canvasId:'canvas-123',model:'model-1'});
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,2);assert.equal(rows[0].launchId,'launch-1');assert.equal(rows[1].launchId,'launch-2');
  assert.equal(rows[0].sessionId,'durable:11111111-2222-3333-4444-555555555555');
  assert.equal(rows[0].requestId,'request-admitted-1');
  assert.equal(new Set(rows.map(x=>x.id)).size,2);
  assert.equal(/PRIVATE|private\.example|apiKey|prompt|origin/.test(JSON.stringify(rows)),false);
});

test('dispatch files rotate within a fixed byte budget and old files expire', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-bounded-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'ledger');const recorder=createDispatchDiagnostics(file,'launch-1',{maxBytes:300,segments:2,maxAgeMs:1000});
  for(let i=0;i<20;i++)assert.equal(recorder.record({turnId:'1122334455667788',model:'model-1',dispatchIndex:i}),true);
  const files=fs.readdirSync(dir);assert.equal(files.length,2);
  assert.ok(files.reduce((sum,name)=>sum+fs.statSync(path.join(dir,name)).size,0)<=600);
  fs.utimesSync(`${file}.1`,new Date(0),new Date(0));recorder.record({model:'model-1'});
  if(fs.existsSync(`${file}.1`)) assert.ok(fs.statSync(`${file}.1`).mtimeMs>Date.now()-10000);
});

test('an unavailable diagnostic path reports failure without throwing into dispatch', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-unavailable-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const blocker=path.join(dir,'file');fs.writeFileSync(blocker,'');const recorder=createDispatchDiagnostics(path.join(blocker,'ledger'),'launch-1');
  assert.equal(recorder.record({model:'model-1'}),false);assert.equal(recorder.writeErrors(),1);
});

test('model outcome classification and ledger keep only allowlisted machine codes', t => {
  assert.equal(classifyModelHttpStatus(200), 'http_200');
  assert.equal(classifyModelHttpStatus(429), 'http_429');
  assert.equal(classifyModelHttpStatus(502), 'http_502');
  assert.equal(classifyModelHttpStatus(418), 'http_4xx');
  assert.equal(classifyModelFetchError(new Error('Model stream idle timeout: no text for 95000 ms')), 'stream_idle_timeout');
  assert.equal(classifyModelFetchError(new Error('upstream stream ended before first response: unexpected EOF')), 'network_eof');
  assert.equal(classifyModelFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'aborted');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agent-requests.jsonl');
  const recorder = createDispatchDiagnostics(file, 'launch-1');
  assert.equal(recorder.record({
    turnId: '1122334455667788', canvasId: 'canvas-1', sessionId: 'durable:11111111-2222-3333-4444-555555555555',
    model: 'deepseek-v4.1-flash', status: 'error', httpStatus: 429, reason: 'http_429', durationMs: 321,
  }), true);
  assert.equal(recorder.record({
    turnId: '1122334455667788', status: 'PRIVATE_STATUS', reason: 'PRIVATE_RAW_BODY', httpStatus: 9999, durationMs: -5,
  }), true);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].reason, 'http_429');
  assert.equal(rows[0].httpStatus, 429);
  assert.equal(rows[0].durationMs, 321);
  assert.equal(rows[1].status, undefined);
  assert.equal(rows[1].reason, undefined);
  assert.equal(rows[1].httpStatus, undefined);
  assert.equal(rows[1].durationMs, undefined);
  assert.equal(/PRIVATE_/.test(JSON.stringify(rows)), false);
});

test('SSE stream stall and premature EOF settle outcome as error rather than http_200', async () => {
  const enc = new TextEncoder();
  const reqBody = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const reqOpts = { method: 'POST', body: reqBody };

  // 1. Mid-stream idle timeout after HTTP 200 headers
  const stalled = [];
  const stallRes = await fetchModelWithProgressIdle('https://model.invalid/v1/chat/completions', reqOpts, {
    timeoutMs: 30,
    fetch: async () => new Response(new ReadableStream({
      start(ctrl) { ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    onSettled: info => stalled.push(info),
  });
  assert.equal(stalled.length, 0, 'must not settle on 200 headers before SSE body finishes');
  await assert.rejects(async () => {
    const reader = stallRes.body.getReader();
    while (!(await reader.read()).done) { /* drain until timeout */ }
  }, /idle timeout/i);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].ok, false);
  assert.equal(classifyModelFetchError(stalled[0].error), 'stream_idle_timeout');

  // 2. Mid-stream premature EOF / socket close
  const eofOutcomes = [];
  const eofRes = await fetchModelWithProgressIdle('https://model.invalid/v1/chat/completions', reqOpts, {
    timeoutMs: 500,
    fetch: async () => new Response(new ReadableStream({
      pull(ctrl) { ctrl.error(new TypeError('terminated')); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    onSettled: info => eofOutcomes.push(info),
  });
  await assert.rejects(async () => {
    await eofRes.body.getReader().read();
  });
  assert.equal(eofOutcomes.length, 1);
  assert.equal(eofOutcomes[0].ok, false);
  assert.equal(classifyModelFetchError(eofOutcomes[0].error), 'network_eof');

  // 3. Clean SSE completion records ok / http_200 only after stream ends
  const okOutcomes = [];
  const okRes = await fetchModelWithProgressIdle('https://model.invalid/v1/chat/completions', reqOpts, {
    timeoutMs: 500,
    fetch: async () => new Response(new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        ctrl.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    onSettled: info => okOutcomes.push(info),
  });
  assert.equal(okOutcomes.length, 0);
  const reader = okRes.body.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(okOutcomes.length, 1);
  assert.equal(okOutcomes[0].ok, true);
  assert.equal(classifyModelHttpStatus(okOutcomes[0].httpStatus), 'http_200');

  // 4. Clean SSE EOF before terminal event ([DONE]/finish_reason) settles as network_eof
  const truncated = [];
  const truncRes = await fetchModelWithProgressIdle('https://model.invalid/v1/chat/completions', reqOpts, {
    timeoutMs: 500,
    fetch: async () => new Response(new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        ctrl.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    onSettled: info => truncated.push(info),
  });
  const truncReader = truncRes.body.getReader();
  while (!(await truncReader.read()).done) { /* drain clean FIN */ }
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].ok, false);
  assert.equal(classifyModelFetchError(truncated[0].error), 'network_eof');

  // 5. Non-SSE response settles immediately without wrapping Response in a synthetic stream
  const nonSseOutcomes = [];
  const rawResponse = new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const nonSseRes = await fetchModelWithProgressIdle('https://model.invalid/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  }, {
    fetch: async () => rawResponse,
    onSettled: info => nonSseOutcomes.push(info),
  });
  assert.equal(nonSseRes, rawResponse);
  assert.equal(nonSseOutcomes.length, 1);
  assert.equal(nonSseOutcomes[0].ok, true);
  assert.equal(classifyModelHttpStatus(nonSseOutcomes[0].httpStatus), 'http_200');
});

test('MODEL_OUTCOME_REASONS loads from the single-source allowlist', () => {
  assert.ok(Array.isArray(MODEL_OUTCOME_REASONS) && MODEL_OUTCOME_REASONS.length >= 10);
  assert.ok(MODEL_OUTCOME_REASONS.includes('http_200') && MODEL_OUTCOME_REASONS.includes('stream_idle_timeout') && MODEL_OUTCOME_REASONS.includes('network_eof'));
});
