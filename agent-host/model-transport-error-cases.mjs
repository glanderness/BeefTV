import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createModels} from '@earendil-works/pi-ai/models';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import {Harness, LiveDoc} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {createDurableSessionStore, durableCompletion, durableStreamEvents, publicDurableTurn} from './durable-session-owner.mjs';
import {createDurableTurnBudget} from './durable-turn-budget.mjs';
import {spendModelRequest, budgetError} from './request-budget.mjs';
import {fetchModelWithProgressIdle, DEFAULT_MODEL_STREAM_IDLE_MS} from './model-stream-idle.mjs';
import {createDispatchDiagnostics} from './dispatch-diagnostics.mjs';
import {PARTIAL_OUTPUT_STREAM_INTERRUPTED, classifyModelFailureReason, hasProducedContent} from './model-transport-error.mjs';

const EOF_MESSAGE = 'upstream stream ended before first response: eof';
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

async function fixture(t, respond, {settings = {}, maxRequests = 0, idleTimeoutMs, rawHttp = false, autoSubmit = true, reasoning = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-model-transport-'));
  const requests = [];
  const toolCalls = [];
  const realFetch = globalThis.fetch;
  const ledgerPath = path.join(directory, 'agent-requests.jsonl');
  const dispatchDiagnostics = createDispatchDiagnostics(ledgerPath, 'fixture-launch');
  let store;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    requests.push(payload);
    if (rawHttp) {
      respond({req, res, payload, call: requests.length, sse});
      return;
    }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const frame = (delta, finish_reason = null) => res.write(sse({id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices: [{index: 0, delta, finish_reason}]}));
    respond({res, frame, payload, call: requests.length});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await store?.disposeAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const runtime = await ModelRuntime.create({authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false});
  runtime.registerProvider('fixture', {api: 'openai-completions', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{id: 'fixture', name: 'fixture', reasoning, input: ['text'], contextWindow: 200000, maxTokens: 1024,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]});
  const models = createModels();
  models.setProvider(runtime.getProvider('fixture'));
  const makeStore = (overrideSettings = settings, extra = {}) => createDurableSessionStore({sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({provider: 'fixture', modelId: 'fixture'}), settings: overrideSettings, dispatchDiagnostics,
    buildTools: () => [{name: 'canvas_nodes_create', label: 'canvas.nodes.create', description: 'Synthetic local write',
      parameters: {type: 'object', properties: {}}, execute: async id => {
        toolCalls.push(id);
        return {content: [{type: 'text', text: 'one completed synthetic write'}]};
      }}],
    authorizeTurn: async ({turnId}) => ({turnId, canvasId: 'canvas', permissionMode: 'canvas', open: true}),
    completeTurn: async () => {},
    ...extra});
  store = makeStore();
  const entry = await store.ensureSession('canvas');
  const transport = idleTimeoutMs === undefined ? realFetch : (input, options) =>
    fetchModelWithProgressIdle(input, options, {fetch: realFetch, timeoutMs: idleTimeoutMs});
  if (idleTimeoutMs !== undefined) globalThis.fetch = transport;
  if (maxRequests > 0) globalThis.fetch = (input, options) => {
    // Use the host's persisted dispatch guard at the same fetch boundary.
    entry.budget ||= createDurableTurnBudget(entry, {maxRequests});
    const verdict = spendModelRequest(entry.budget);
    if (!verdict.allowed) {entry.budget.failure = verdict; throw budgetError(verdict);}
    return transport(input, options);
  };
  const submission = autoSubmit ? await store.submit(entry, {turnId: 'transport-turn', requestId: 'transport-request', permissionMode: 'canvas',
    content: 'write once then summarize', userText: 'write once then summarize', revisionBefore: 1}) : null;
  return {store, entry, submission, requests, toolCalls, ledgerPath, directory,
    readLedger: () => fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    reopenStore: async (overrideSettings = settings, extra = {}) => {
      await store.disposeAll();
      store = makeStore(overrideSettings, extra);
      return store;
    },
    reopenHistory: async () => {
      await store.disposeAll();
      store = makeStore();
      return store.history('canvas', entry.sessionId);
    }};
}

function answer({res, frame}, text) {
  frame({role: 'assistant', content: text});
  frame({}, 'stop');
  res.end('data: [DONE]\n\n');
}

test('exhausted header timeout retries at most twice and retains completed tools across an explicit next request and reopen', {timeout: 20000}, async t => {
  const f = await fixture(t, response => {
    if (response.call === 1) {
      response.frame({role: 'assistant', tool_calls: [{index: 0, id: 'one-stable-tool', type: 'function',
        function: {name: 'canvas_nodes_create', arguments: '{}'}}]});
      response.frame({}, 'tool_calls');
      response.res.end('data: [DONE]\n\n');
    } else if (response.call > 4) answer(response, 'completed after explicit next request');
    // Calls 2, 3, 4 (initial + 2 retries) never send headers.
  }, {settings: {stream: {timeoutMs: 250, maxRetries: 0}, retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => {events.push(event);}});
  assert.match(record.error, /timed out/i);
  assert.equal(record.errorReason, 'model_error');
  assert.equal(record.reply, '');
  assert.equal(record.submissionId, f.submission.id);
  assert.equal(record.requestId, 'transport-request');
  assert.equal(f.requests.length, 4, 'tool step (1) + initial attempt (1) + at most 2 retries = 4');
  assert.equal(f.toolCalls.length, 1);
  assert(f.requests[1].messages.some(message => message.role === 'tool'));
  assert.equal((await f.submission.status(BACKGROUND_CONTEXT)).reason, 'model_error');
  const progress = events.flatMap(durableStreamEvents).filter(event => event.phase === 'retry');
  assert.equal(progress.length, 2);
  const view = await f.entry.root.context(BACKGROUND_CONTEXT);
  const errors = view.entries.flatMap(item => item.model || []).filter(message => message.role === 'assistant' && message.stopReason === 'error');
  assert.equal(errors.length, 3);
  assert.match(errors[0].errorMessage, /timed out/i);
  const next = await f.store.submit(f.entry, {turnId: 'next-turn', requestId: 'explicit-next-request', permissionMode: 'canvas',
    content: 'summarize the completed write', userText: 'summarize the completed write', revisionBefore: 2});
  assert.equal((await f.store.wait(f.entry, next)).reply, 'completed after explicit next request');
  assert.equal(f.requests.length, 5);
  assert.equal(f.toolCalls.length, 1);
  const wireCalls = f.requests[4].messages.flatMap(message => message.tool_calls || []).map(call => call.id);
  const wireResults = f.requests[4].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id);
  assert.deepEqual(wireCalls, ['one-stable-tool']);
  assert.deepEqual(wireResults, wireCalls);
  const history = await f.reopenHistory();
  assert.equal(history.turns.length, 2);
  assert.equal(history.turns[0].error, '模型没有完成回复。已经完成的操作会保留，请检查结果后再继续。');
  assert.equal(history.turns[0].errorReason, record.errorReason);
  assert.equal(history.turns[0].submissionId, f.submission.id);
  assert.equal(history.turns[1].reply, 'completed after explicit next request');
  assert.equal(f.requests.length, 5);
  assert.equal(f.toolCalls.length, 1);
});

test('production 180s request wait enables single-layer Layer 2 retry and preserves prompt Stop with one dispatch', {timeout: 15000}, async t => {
  const prevRetention = process.env.BEEFTV_AGENT_CACHE_RETENTION;
  delete process.env.BEEFTV_AGENT_CACHE_RETENTION;
  t.after(() => {
    if (prevRetention === undefined) delete process.env.BEEFTV_AGENT_CACHE_RETENTION;
    else process.env.BEEFTV_AGENT_CACHE_RETENTION = prevRetention;
  });
  const open = Harness.open.bind(Harness);
  t.mock.method(Harness, 'open', (storage, options, context) => {
    const { metadata, ...restStream } = options.settings.stream;
    assert.deepEqual(restStream, {timeoutMs: 180000, maxRetries: 0, cacheRetention: 'long'});
    assert.match(String(metadata?.user_id || ''), /^durable:/);
    assert.deepEqual(options.settings.retry, {enabled: true, maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 15000});
    return open(storage, options, context);
  });
  let received;
  const requestReceived = new Promise(resolve => {received = resolve;});
  const f = await fixture(t, () => received());
  const events = [];
  const waiting = f.store.wait(f.entry, f.submission, {onEvent: event => {
    events.push(event);
  }});
  await requestReceived;
  const stoppedAt = Date.now();
  await f.store.stop(f.entry, 'transport-request');
  const record = await waiting;
  assert(Date.now() - stoppedAt < 2000, 'Stop must not wait for the 180s request timeout');
  assert.equal(record.cancelled, true);
  assert.equal(record.error, null);
  assert.equal(f.requests.length, 1);
  assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
  assert.equal((await f.submission.status(BACKGROUND_CONTEXT)).reason, 'aborted');
  const history = await f.reopenHistory();
  assert.equal(history.turns[0].cancelled, true);
  assert.equal(f.requests.length, 1);
});

test('scenario 1: pre-first-byte EOF and HTTP 502 retry at most twice (never 9x) and succeed cleanly', {timeout: 20000}, async t => {
  // 1a. Pre-first-byte EOF fails twice, succeeds on 3rd attempt (2 retries)
  const eofOk = await fixture(t, response => {
    if (response.call <= 2) response.res.end(sse({error: {message: EOF_MESSAGE}}));
    else answer(response, 'recovered after gateway EOF');
  }, {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const eofEvents = [];
  const eofRecord = await eofOk.store.wait(eofOk.entry, eofOk.submission, {onEvent: event => eofEvents.push(event)});
  assert.equal(eofRecord.error, null);
  assert.equal(eofRecord.reply, 'recovered after gateway EOF');
  assert.equal(eofOk.requests.length, 3, 'initial + 2 retries');
  assert.equal(eofEvents.filter(event => event.type === 'auto_retry_start').length, 2);

  // 1b. Persistent pre-first-byte EOF stops after 3 total dispatches (never 9x) with sanitized reason
  const eofExhausted = await fixture(t, ({res}) => res.end(sse({error: {message: EOF_MESSAGE}})),
    {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const exhaustedRec = await eofExhausted.store.wait(eofExhausted.entry, eofExhausted.submission);
  assert.equal(exhaustedRec.errorReason, 'upstream_eof_before_first_byte');
  assert.equal(eofExhausted.requests.length, 3, 'bounded to 1 initial + 2 retries');

  // 1c. HTTP 502 retries via Layer 2 only (Layer 1 stream.maxRetries=0) -> succeeds on 2nd attempt
  const http502 = await fixture(t, ({res, call}) => {
    if (call <= 2) {
      res.writeHead(502, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {message: 'Bad Gateway https://internal.secret/key=leak'}}));
      return;
    }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(sse({id: 'ok', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: {role: 'assistant', content: 'recovered from 502'}, finish_reason: null}]}));
    res.write(sse({id: 'ok', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}));
    res.end('data: [DONE]\n\n');
  }, {rawHttp: true, settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const ok502 = await http502.store.wait(http502.entry, http502.submission);
  assert.equal(ok502.error, null);
  assert.equal(ok502.reply, 'recovered from 502');
  assert.equal(http502.requests.length, 3, 'Layer 1 maxRetries=0 + Layer 2 maxRetries=2 => 3 total, never 3x3=9');

  // 1d. Persistent HTTP 502 dispatches at most 3 times total (never 9x) and hides raw upstream URL
  const persist502 = await fixture(t, ({res}) => {
    res.writeHead(502, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: {message: '502 Bad Gateway https://internal.secret/api_key=leak'}}));
  }, {rawHttp: true, settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const fail502 = await persist502.store.wait(persist502.entry, persist502.submission);
  assert.equal(persist502.requests.length, 3, 'never 3x3=9 amplification');
  assert.equal(fail502.errorReason, 'provider_unavailable');
  const pub502 = publicDurableTurn(fail502);
  assert(!JSON.stringify(pub502).includes('internal.secret'));
  assert(!JSON.stringify(pub502).includes('api_key=leak'));
});

test('scenario 2: quota/billing HTTP 429 triggers 0 retries under single-layer retry policy', {timeout: 15000}, async t => {
  assert.equal(isRetryableAssistantError({stopReason: 'error', errorMessage: 'provider_quota_exhausted'}), false);
  for (const [label, body] of [
    ['insufficient_quota', {error: {message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota'}}],
    ['insufficient_balance', {error: {message: 'Insufficient balance'}}],
    ['billing', {error: {message: 'billing account disabled due to unpaid balance'}}],
    ['monthly_limit', {error: {message: 'Monthly usage limit reached for your plan'}}],
  ]) {
    const f = await fixture(t, ({res}) => {
      res.writeHead(429, {'content-type': 'application/json'});
      res.end(JSON.stringify(body));
    }, {rawHttp: true, settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
    const events = [];
    const record = await f.store.wait(f.entry, f.submission, {onEvent: event => events.push(event)});
    assert.equal(f.requests.length, 1, `${label} HTTP 429 must trigger 0 retries`);
    assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
    assert.equal(record.errorReason, 'provider_quota_exhausted', `${label} must map to provider_quota_exhausted`);
    assert.equal(publicDurableTurn(record).error, '模型服务额度或余额不足，请检查账户余额后再试。');
    assert(f.readLedger().some(row => row.reason === 'provider_quota_exhausted'), `${label} must record sanitized quota diagnostics`);
  }
});

test('scenario 3: 13k thinking/text tokens and signature-only reasoning_details closing with usage.output=0 trigger 0 retries', {timeout: 15000}, async t => {
  assert.equal(isRetryableAssistantError({stopReason: 'error', errorMessage: PARTIAL_OUTPUT_STREAM_INTERRUPTED}), false);
  assert.equal(hasProducedContent({content: [{type: 'thinking', thinking: 'x'}], usage: {output: 0}}), true);
  assert.equal(hasProducedContent({content: [{type: 'thinking', thinking: '', thinkingSignature: 'encrypted-sig'}], usage: {output: 0}}), true);
  assert.equal(hasProducedContent({content: [], usage: {output: 0}}), false);

  const bigThinking = '深度分镜推理。'.repeat(2000); // >13k chars
  const partialReply = '第一幕分镜草稿：镜头1 远景推进，镜头2 特写人物眼神。';
  const f = await fixture(t, ({frame, res}) => {
    frame({role: 'assistant', reasoning_content: bigThinking});
    frame({content: partialReply});
    // Close stream with [DONE] but NO finish_reason and NO usage chunk (usage.output stays 0!)
    res.end('data: [DONE]\n\n');
  }, {reasoning: true, settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => events.push(event)});
  assert.equal(f.requests.length, 1, 'must trigger 0 retries after partial thinking/text output');
  assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
  assert.equal(record.errorReason, PARTIAL_OUTPUT_STREAM_INTERRUPTED);
  assert.equal(record.reply, partialReply, 'partial text must be preserved in durableCompletion');
  assert.equal(record.rawStopReason, 'error');
  const pub = publicDurableTurn(record);
  assert.equal(pub.reply, partialReply);
  assert.equal(pub.error, '模型输出中途中断，已保留已生成内容，可点击继续处理。');
  const ledger = f.readLedger();
  assert(ledger.some(row => row.reason === 'stream_ended_without_finish_reason'), 'original sanitized reason recorded');
  assert(ledger.some(row => row.reason === PARTIAL_OUTPUT_STREAM_INTERRUPTED), 'guard trigger recorded');
  const history = await f.reopenHistory();
  assert.equal(history.turns[0].errorReason, PARTIAL_OUTPUT_STREAM_INTERRUPTED);
  assert.equal(history.turns[0].reply, partialReply);
  assert.equal(history.turns[0].error, '模型输出中途中断，已保留已生成内容，可点击继续处理。');

  // 3b. Encrypted/signature-only reasoning_details with usage.output === 0 and no finish_reason triggers 0 retries
  const encFix = await fixture(t, ({frame, res}) => {
    frame({role: 'assistant', reasoning_details: [{type: 'reasoning.encrypted', id: 'rs_enc_1', data: 'ciphertext-blob'}]});
    res.end('data: [DONE]\n\n');
  }, {reasoning: true, settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const encRec = await encFix.store.wait(encFix.entry, encFix.submission);
  assert.equal(encFix.requests.length, 1, 'encrypted reasoning_details must trigger 0 retries');
  assert.equal(encRec.errorReason, PARTIAL_OUTPUT_STREAM_INTERRUPTED);

  // 3c. Mid-stream thrown transport error (e.g. terminated / fetch failed) preserves partial deltas + original diagnostics and triggers 0 retries;
  //     Mid-stream thrown content_filter (e.g. SAFETY policy) after a text delta maps to model_content_filtered (NOT partial_output_stream_interrupted).
  for (const [thrownMsg, expectedReason, expectedReply, expectedRawStop, expectedLedgerReason] of [
    ['terminated', PARTIAL_OUTPUT_STREAM_INTERRUPTED, '中断前已流出的半截正文', 'error', null],
    ['fetch failed', PARTIAL_OUTPUT_STREAM_INTERRUPTED, '中断前已流出的半截正文', 'error', 'model_network_error'],
    ['Provider stopped with: SAFETY policy', 'model_content_filtered', '', 'content_filter', 'model_content_filtered'],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-stream-throw-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const throwLedgerPath = path.join(dir, 'agent-requests.jsonl');
    const throwDiag = createDispatchDiagnostics(throwLedgerPath, 'throw-launch');
    let calls = 0;
    const fakeModel = {id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', reasoning: true,
      input: ['text'], contextWindow: 200000, maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
    const streamWithThrow = () => {
      calls += 1;
      const eventsStream = createAssistantMessageEventStream();
      const partial = {role: 'assistant', content: [], api: fakeModel.api, provider: fakeModel.provider, model: fakeModel.id,
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: 'pending', timestamp: Date.now()};
      const iterable = {
        async *[Symbol.asyncIterator]() {
          partial.content.push({type: 'thinking', thinking: '先行思考草稿'});
          yield {type: 'thinking_delta', contentIndex: 0, delta: '先行思考草稿', partial};
          partial.content.push({type: 'text', text: '中断前已流出的半截正文'});
          yield {type: 'text_delta', contentIndex: 1, delta: '中断前已流出的半截正文', partial};
          throw new Error(thrownMsg);
        },
        result: () => eventsStream.result(),
      };
      return iterable;
    };
    const throwRuntime = await ModelRuntime.create({authPath: path.join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false});
    throwRuntime.registerProvider('fixture', {api: 'openai-completions', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1/v1',
      models: [{id: 'fixture', name: 'fixture', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 1024,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]});
    const baseProvider = throwRuntime.getProvider('fixture');
    const throwingModels = createModels();
    throwingModels.setProvider({...baseProvider, stream: streamWithThrow, streamSimple: streamWithThrow});
    const throwStore = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'), workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => throwingModels, getModelRef: () => ({provider: 'fixture', modelId: 'fixture'}),
      dispatchDiagnostics: throwDiag,
      settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}},
      buildTools: () => [],
      authorizeTurn: async ({turnId}) => ({turnId, canvasId: 'canvas', permissionMode: 'canvas', open: true}),
      completeTurn: async () => {},
    });
    t.after(() => throwStore.disposeAll());
    const throwEntry = await throwStore.ensureSession('canvas');
    const throwSub = await throwStore.submit(throwEntry, {turnId: 'throw-turn', requestId: 'throw-req', permissionMode: 'canvas',
      content: 'stream then throw', userText: 'stream then throw', revisionBefore: 1});
    const throwRec = await throwStore.wait(throwEntry, throwSub);
    assert.equal(calls, 1, `thrown "${thrownMsg}" after partial deltas must trigger 0 retries`);
    assert.equal(throwRec.errorReason, expectedReason);
    assert.equal(throwRec.reply, expectedReply);
    assert.equal(throwRec.rawStopReason, expectedRawStop);
    if (expectedLedgerReason) {
      const rows = fs.readFileSync(throwLedgerPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      assert(rows.some(row => row.reason === expectedLedgerReason),
        `expected ledger reason ${expectedLedgerReason} for "${thrownMsg}", got ${JSON.stringify(rows)}`);
    }
  }
});

test('scenario 4: crash-restart interrupted() -> convertPartial -> attempt>1 triggers 0 duplicate requests while continue and compaction remain unblocked', {timeout: 30000}, async t => {
  const partialText = '主机崩溃前已输出的半截分镜内容';
  let firstPartialSent;
  const partialSentPromise = new Promise(resolve => {firstPartialSent = resolve;});
  let abortPartialSent;
  const abortPartialPromise = new Promise(resolve => {abortPartialSent = resolve;});
  let abortedOnce = false;
  const f = await fixture(t, ({frame, res, payload, call}) => {
    const isCompaction = Array.isArray(payload.messages)
      && payload.messages[0]?.role === 'system'
      && /summarization assistant/i.test(String(payload.messages[0]?.content || ''));
    if (isCompaction) {
      answer({res, frame}, '## Goal\nKeep creative script\n## Progress\n### Done\n- Partial draft');
      return;
    }
    const lastUserText = JSON.stringify(payload.messages?.at(-1)?.content || '');
    if (call === 1) {
      frame({role: 'assistant', content: partialText});
      firstPartialSent();
      // Hold stream open to simulate host crash mid-generation
      return;
    }
    if (lastUserText.includes('继续完成分镜')) {
      answer({res, frame}, 'explicit user continue succeeded');
      return;
    }
    if (lastUserText.includes('generate then abort') && !abortedOnce) {
      abortedOnce = true;
      frame({role: 'assistant', content: 'user aborted draft'});
      abortPartialSent();
      return;
    }
    answer({res, frame}, 'root continue after user abort succeeded');
  }, {
    settings: {
      retry: {enabled: true, maxRetries: 2, baseDelayMs: 20, maxAgentDelayMs: 100},
      progress: {partialIntervalMs: 10, persistWithinMs: 20},
      compaction: {enabled: true, keepRecentTokens: 1, reserveTokens: 2048, backgroundTokens: 0},
    },
  });
  await partialSentPromise;
  // Wait until Pi flushes live.generation.message into SQLite before simulating crash
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const live = await f.entry.harness.snapshot(LiveDoc, f.entry.root.id, BACKGROUND_CONTEXT);
    if (live?.generation?.message?.content?.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.requests.length, 1);

  // Snapshot SQLite + WAL BEFORE disposeAll() so we simulate a true unclean crash
  // where writeAtClose never ran (leaving task.state.status === 'running' -> Pi interrupted() -> attempt=2).
  const sessionsDir = path.join(f.directory, 'sessions');
  const crashBackupDir = path.join(f.directory, 'sessions-crash-backup');
  fs.cpSync(sessionsDir, crashBackupDir, {recursive: true});
  for (const name of fs.readdirSync(crashBackupDir, {recursive: true})) {
    if (String(name).endsWith('.sqlite-shm')) fs.rmSync(path.join(crashBackupDir, String(name)), {force: true});
  }

  // Simulate true unclean crash & restart: close old store, restore pre-close SQLite snapshot, reopen!
  // Also simulate a beforeRequest exception during recovery (authorizeTurn throws once on the crashed turn)
  // to prove Path B stays fail-closed via Pi's options.onPayload invariant rather than preparedRequests.
  let failBeforeRequest = false;
  let recoveryAuthThrows = 0;
  await f.store.disposeAll();
  fs.rmSync(sessionsDir, {recursive: true, force: true});
  fs.cpSync(crashBackupDir, sessionsDir, {recursive: true});
  const store2 = await f.reopenStore({
    retry: {enabled: true, maxRetries: 2, baseDelayMs: 120, maxAgentDelayMs: 300},
    progress: {partialIntervalMs: 10, persistWithinMs: 20},
    compaction: {enabled: true, keepRecentTokens: 1, reserveTokens: 2048, backgroundTokens: 0},
  }, {
    authorizeTurn: async ({turnId}) => {
      if (failBeforeRequest && turnId === 'transport-turn') {
        recoveryAuthThrows += 1;
        throw new Error('transient beforeRequest failure during recovery');
      }
      return {turnId, canvasId: 'canvas', permissionMode: 'canvas', open: true};
    },
  });
  const reopened = await store2.ensureSession('canvas');
  const recoveredSub = await store2.recover(reopened);
  assert.ok(recoveredSub, 'interrupted turn must be recovered');
  failBeforeRequest = true;
  const crashEvents = [];
  const crashRecord = await store2.wait(reopened, recoveredSub, {onEvent: event => crashEvents.push(event)});
  assert(crashEvents.some(event => event.type === 'auto_retry_start' || (event.type === 'snapshot' && event.generation?.retry)),
    'unclean crash must exercise Pi interrupted() -> retry -> attempt > 1');
  assert(recoveryAuthThrows >= 1, 'beforeRequest must have thrown during recovery');
  assert.equal(f.requests.length, 1, 'Path B must trigger 0 duplicate upstream requests on attempt > 1 even when beforeRequest throws');
  assert.equal(crashRecord.errorReason, PARTIAL_OUTPUT_STREAM_INTERRUPTED);
  assert.equal(crashRecord.rawStopReason, 'aborted');
  assert.equal(crashRecord.reply, partialText, 'partial text from convertPartial must be preserved');
  const crashLedgerRows = f.readLedger().filter(row => row.reason === PARTIAL_OUTPUT_STREAM_INTERRUPTED);
  assert.equal(crashLedgerRows.length, 1, 'Path B must write exactly 1 deduplicated model.outcome row');
  assert.equal(crashLedgerRows[0].rawStopReason, 'aborted');

  // (a1) User-initiated explicit follow-up message after interrupted partial MUST NOT be blocked
  const continueSub = await store2.submit(reopened, {
    turnId: 'continue-turn', requestId: 'continue-request', permissionMode: 'canvas',
    content: '继续完成分镜', userText: '继续完成分镜', revisionBefore: 1,
  });
  const continueRec = await store2.wait(reopened, continueSub);
  assert.equal(continueRec.error, null);
  assert.equal(continueRec.reply, 'explicit user continue succeeded');
  assert.equal(f.requests.length, 2);

  // (b) Compaction summarization MUST NOT be blocked even after aborted partials in history
  const compactRes = await store2.compactSession('canvas', {sessionId: reopened.sessionId});
  assert.equal(compactRes.compacted, true, 'compaction summarization must succeed');
  assert.equal(f.requests.length, 3, 'compaction issued its summarization call');

  // (a2) Direct Pi `type: 'continue'` submission after an aborted stream MUST NOT be blocked (new GenerationTask, attempt === 1)
  const abortSub = await store2.submit(reopened, {
    turnId: 'abort-turn', requestId: 'abort-request', permissionMode: 'canvas',
    content: 'generate then abort', userText: 'generate then abort', revisionBefore: 1,
  });
  await abortPartialPromise;
  await new Promise(resolve => setTimeout(resolve, 40));
  await store2.stop(reopened, 'abort-request');
  await store2.wait(reopened, abortSub);
  reopened.generation.aborted = false;
  const directContinue = await reopened.root.submit({type: 'continue', requestId: 'direct-continue-after-abort'}, BACKGROUND_CONTEXT);
  const directSettled = await directContinue.wait(BACKGROUND_CONTEXT);
  assert.equal(directSettled.status, 'done', 'user-initiated continue submission after abort must not be blocked');
  assert.equal(f.requests.length, 5);
});

test('scenario 5: bare EOF without [DONE] never masks as stop (zero-output fails cleanly, partial-output triggers 0 retries)', {timeout: 15000}, async t => {
  // 5a. Zero-output bare EOF without [DONE] retries up to 2x and fails with stream_ended_without_finish_reason
  const zeroEof = await fixture(t, ({res}) => {
    res.end(); // Bare EOF with no chunks and no [DONE]
  }, {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const zeroRec = await zeroEof.store.wait(zeroEof.entry, zeroEof.submission);
  assert.equal(zeroRec.errorReason, 'stream_ended_without_finish_reason');
  assert.equal(zeroRec.reply, '');
  assert.equal(zeroEof.requests.length, 3);

  // 5b. Partial-output bare EOF without [DONE] triggers 0 retries and preserves partial text
  const partialEof = await fixture(t, ({frame, res}) => {
    frame({role: 'assistant', content: 'bare eof partial text'});
    res.end(); // Bare EOF without finish_reason or [DONE]
  }, {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const partialRec = await partialEof.store.wait(partialEof.entry, partialEof.submission);
  assert.equal(partialRec.errorReason, PARTIAL_OUTPUT_STREAM_INTERRUPTED);
  assert.equal(partialRec.reply, 'bare eof partial text');
  assert.equal(partialEof.requests.length, 1, 'must never retry or disguise as blank success');
});

test('scenario 6: stopReason=length and content_filter map accurately without leaking raw upstream body', {timeout: 15000}, async t => {
  // 6a. stopReason === 'length' -> model_output_truncated, partial reply preserved, rawStopReason='length', 0 retries
  const lenFix = await fixture(t, ({frame, res}) => {
    frame({role: 'assistant', content: '很长的剧本写到一半被截断'});
    frame({}, 'length');
    res.end('data: [DONE]\n\n');
  }, {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const lenRec = await lenFix.store.wait(lenFix.entry, lenFix.submission);
  assert.equal(lenFix.requests.length, 1);
  assert.equal(lenRec.errorReason, 'model_output_truncated');
  assert.equal(lenRec.rawStopReason, 'length');
  assert.equal(lenRec.reply, '很长的剧本写到一半被截断');
  const lenPub = publicDurableTurn(lenRec);
  assert.equal(lenPub.error, '回复达到长度上限被截断，已保留现有内容，可点击继续处理。');
  assert.equal(lenPub.rawStopReason, 'length');

  // 6b. content_filter (provider finish_reason) -> model_content_filtered, rawStopReason='content_filter', 0 retries, no raw leak
  const cfFix = await fixture(t, ({frame, res}) => {
    frame({role: 'assistant', content: 'partial before filter https://secret.invalid?api_key=leak'});
    frame({}, 'content_filter');
    res.end('data: [DONE]\n\n');
  }, {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const cfRec = await cfFix.store.wait(cfFix.entry, cfFix.submission);
  assert.equal(cfFix.requests.length, 1, 'content_filter must trigger 0 retries');
  assert.equal(cfRec.errorReason, 'model_content_filtered');
  assert.equal(cfRec.rawStopReason, 'content_filter');
  assert.equal(cfRec.reply, '');
  const cfPub = publicDurableTurn(cfRec);
  assert.equal(cfPub.error, '上游模型触发了安全审核拦截，请调整措辞后重试。');
  assert.equal(cfPub.rawStopReason, 'content_filter');
  assert(!JSON.stringify(cfPub).includes('secret.invalid'));
  assert(!JSON.stringify(cfPub).includes('api_key=leak'));
  const cfLedger = cfFix.readLedger();
  assert(cfLedger.some(row => row.reason === 'model_content_filtered' && row.rawStopReason === 'content_filter'));

  // 6c. errorMessage-only content_filter (no provider finish_reason) must assign rawStopReason='content_filter'
  // onto the persisted SQLite message so durableCompletion, dispatch ledger, and Go SQLite reader all agree.
  const cfMsgFix = await fixture(t, ({res}) => {
    res.end(sse({error: {message: 'Provider stopped with: SAFETY policy https://internal.invalid?token=secret'}}));
  }, {settings: {retry: {enabled: true, maxRetries: 2, baseDelayMs: 10, maxAgentDelayMs: 100}}});
  const cfMsgRec = await cfMsgFix.store.wait(cfMsgFix.entry, cfMsgFix.submission);
  assert.equal(cfMsgFix.requests.length, 1, 'errorMessage-only content filter must trigger 0 retries');
  assert.equal(cfMsgRec.errorReason, 'model_content_filtered');
  assert.equal(cfMsgRec.rawStopReason, 'content_filter');
  assert(cfMsgFix.readLedger().some(row => row.reason === 'model_content_filtered' && row.rawStopReason === 'content_filter'));
  const sqliteFiles = fs.readdirSync(path.join(cfMsgFix.directory, 'sessions'), {recursive: true})
    .filter(name => String(name).endsWith('.sqlite'));
  assert.equal(sqliteFiles.length, 1);
  const db = new DatabaseSync(path.join(cfMsgFix.directory, 'sessions', String(sqliteFiles[0])), {readOnly: true});
  try {
    const persisted = db.prepare(`SELECT json_extract(m.value, '$.rawStopReason') AS rawStopReason, json_extract(m.value, '$.errorMessage') AS errorMessage FROM entries e, json_each(e.record, '$.model') m WHERE json_extract(m.value, '$.role') = 'assistant'`).all();
    assert(persisted.some(row => row.rawStopReason === 'content_filter' && row.errorMessage === 'model_content_filtered'),
      `expected content_filter persisted in SQLite, got ${JSON.stringify(persisted)}`);
  } finally {
    db.close();
  }

  // 6d. Anthropic & OpenAI Responses no-finish-reason variants classify to stream_ended_without_finish_reason.
  assert.equal(classifyModelFailureReason('Anthropic stream ended without a stop reason'), 'stream_ended_without_finish_reason');
  assert.equal(classifyModelFailureReason('Anthropic stream ended before message_stop'), 'stream_ended_without_finish_reason');
  assert.equal(classifyModelFailureReason('OpenAI Responses stream ended before a terminal response event'), 'stream_ended_without_finish_reason');

  // 6e. Even when settled.detail is omitted, durableCompletion falls back to assistant.errorMessage without losing specific codes.
  const withoutDetail = durableCompletion(
    {status: 'unanswered', reason: 'model_error'},
    {role: 'assistant', stopReason: 'error', errorMessage: 'Stream ended without finish_reason', content: []},
  );
  assert.equal(withoutDetail.errorReason, 'stream_ended_without_finish_reason');
  assert.equal(withoutDetail.rawStopReason, 'error');
});

test('delayed headers beyond idle allowance and normal tool continuation both succeed without retries', {timeout: 15000}, async t => {
  assert.equal(DEFAULT_MODEL_STREAM_IDLE_MS, 95000);
  const f = await fixture(t, response => {
    const timer = setTimeout(() => {
      if (response.call === 1) {
        response.frame({role: 'assistant', tool_calls: [{index: 0, id: 'normal-tool', type: 'function',
          function: {name: 'canvas_nodes_create', arguments: '{}'}}]});
        response.frame({}, 'tool_calls');
        response.res.end('data: [DONE]\n\n');
      } else answer(response, 'normal continuation');
    }, 300);
    response.res.on('close', () => clearTimeout(timer));
  }, {settings: {stream: {timeoutMs: 1800, maxRetries: 0}}, idleTimeoutMs: 100});
  // Scale the clocks independently: waiting for headers longer than the body
  // idle allowance is valid because that timer only starts after headers.
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => events.push(event)});
  assert.equal(record.error, null);
  assert.equal(record.reply, 'normal continuation');
  assert.equal(f.requests.length, 2);
  assert.equal(f.toolCalls.length, 1);
  assert(f.requests[1].messages.some(message => message.role === 'tool'));
  assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
});

for (const [label, message, expectedDetail, expectedReason] of [
  ['authentication', '401 Unauthorized: invalid API key', '401 Unauthorized: invalid API key', 'model_error'],
  ['quota', `insufficient_quota: ${EOF_MESSAGE}`, 'provider_quota_exhausted', 'provider_quota_exhausted'],
  ['balance', `insufficient balance: ${EOF_MESSAGE}`, 'provider_quota_exhausted', 'provider_quota_exhausted'],
  ['billing', `billing account disabled: ${EOF_MESSAGE}`, 'provider_quota_exhausted', 'provider_quota_exhausted'],
  ['request budget', 'turn_request_budget_exhausted', 'turn_request_budget_exhausted', 'model_error'],
  ['tool budget', 'turn_tool_step_budget_exhausted', 'turn_tool_step_budget_exhausted', 'model_error'],
  ['context overflow', 'context length exceeded', 'context length exceeded', 'model_error'],
  ['unclassified EOF', 'unexpected EOF', 'unexpected EOF', 'model_error'],
  ['content parse EOF', 'EOF while decoding JSON', 'EOF while decoding JSON', 'model_error'],
]) test(`${label} remains terminal without new retries`, {timeout: 15000}, async t => {
  const f = await fixture(t, ({res}) => res.end(sse({error: {message}})));
  const events = [];
  const record = await f.store.wait(f.entry, f.submission, {onEvent: event => {events.push(event);}});
  assert.equal(record.error, expectedDetail);
  assert.equal(record.errorReason, expectedReason);
  assert.equal(f.requests.length, 1);
  assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0);
});

test('official EOF retry cannot dispatch past the persisted turn request budget', {timeout: 15000}, async t => {
  const f = await fixture(t, ({res}) => res.end(sse({error: {message: EOF_MESSAGE}})),
    {maxRequests: 1, settings: {retry: {maxRetries: 2, baseDelayMs: 1}}});
  const record = await f.store.wait(f.entry, f.submission);
  assert.equal(record.errorReason, 'turn_request_budget_exhausted');
  assert.equal(f.requests.length, 1);
  assert.equal(f.entry.budget.requests, 1);
  assert.equal(createDurableTurnBudget(f.entry, {maxRequests: 1}).requests, 1);
  assert.equal((await f.reopenHistory()).turns[0].errorReason, 'turn_request_budget_exhausted');
  assert.equal(f.requests.length, 1);
});
