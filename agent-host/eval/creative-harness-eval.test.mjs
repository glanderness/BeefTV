// 7-Scenario Offline Reproducible Creative Harness Regression Eval Suite ($0 real spend).
// Verifies end-to-end contracts across Go backend ops, Pi 1.6.0 Durable Harness,
// pi-creative-media extensions, native media retention/eviction, #362 stream guard,
// PR-4 ToolPark cold signal wake, PR-5 ProductionMandate, and creative compaction.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CompactionEntry, UsageDoc } from '@earendil-works/pi-durable';
import { providerRegistration } from '../canvas-turn.mjs';
import { createDurableSessionStore } from '../durable-session-owner.mjs';
import { createDurableApprovalExtension, resolvePaidOpForTool } from '../durable-approval.mjs';
import { BUSINESS_TASK_SETTLED_SIGNAL, BusinessTaskSettled } from '../durable-signals.mjs';
import { createNativePartStore } from '../native-part-store.mjs';
import { DEFAULT_MAX_REQUEST_BYTES } from '../extensions/pi-creative-media/index.mjs';
import {
  adaptMediaRequest,
  MEDIA_REFERENCE_MARKER,
  mediaToolResult,
} from '../media-content.mjs';
import {
  applyMonotoneMediaCutoff,
  evaluateMonotoneMediaCutoff,
} from '../studio-digest.mjs';
import {
  normalizeModelTransportError,
  PARTIAL_OUTPUT_STREAM_INTERRUPTED,
} from '../model-transport-error.mjs';

const CTX = BACKGROUND_CONTEXT;
const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EVAL_DIR, '../..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-eval-${prefix}-`));
}

function runGoTests(runRegex) {
  const output = execFileSync(
    'go',
    ['test', '-race', '-count=1', '-v', './internal/operations', '-run', runRegex],
    { cwd: BACKEND_DIR, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  expect(output).toContain('PASS');
  expect(output).not.toContain('testing: warning: no tests to run');
  return output;
}

function sseChunk(res, delta, finishReason = null, usage = undefined) {
  const chunk = {
    id: `chatcmpl-eval-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'eval-stub-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function msgText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

async function createStubModels(dir, baseUrl) {
  process.env.BEEFTV_AGENT_API_KEY = 'sk-eval-offline-stub';
  const runtime = await ModelRuntime.create({
    authPath: path.join(dir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('beeftv', providerRegistration({
    api: 'openai-completions',
    baseUrl: `${baseUrl}/v1`,
    modelId: 'eval-stub-model',
    contextWindow: 128000,
    maxTokens: 4096,
  }));
  return runtime.models;
}

describe('7-Scenario Offline Creative Harness Regression Eval Suite ($0 spend)', () => {
  // -------------------------------------------------------------------------
  // Scenario 1: First/mid/tail video frame extraction + short/VFR fallback + Source.StartMs
  // -------------------------------------------------------------------------
  test('Scenario 1: first/mid/tail frame extraction, <=100ms & VFR tail fallback, 1024 scale, and Source.StartMs metadata', { timeout: 60000 }, async () => {
    const goOut = runGoTests('^TestMediaFrame');
    expect(goOut).toContain('TestMediaFrameSampleTimestampsFirstMidTailAndShortClamp');
    expect(goOut).toContain('TestMediaFrameExtractionHDScale1024AndFirstMidTailTimestamps');
    expect(goOut).toContain('TestMediaFrameExtractionShortClipAndVFRTailFallback');
    expect(goOut).toContain('TestMediaFrameExtractionDynamicBudgetDownscale');

    const dir = makeTempDir('s1-frames');
    try {
      const store = createNativePartStore({ directory: path.join(dir, 'parts') });
      const pngBuf = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const pngBase64 = pngBuf.toString('base64');
      const pngSha = crypto.createHash('sha256').update(pngBuf).digest('hex');
      const result = mediaToolResult({
        result: {
          mode: 'frames',
          mediaType: 'video',
          canvasId: 'c-eval-1',
          resourceId: 'res-vid-1',
          content: [
            { type: 'image', mimeType: 'image/png', data: pngBase64, sha256: pngSha, source: { canvasId: 'c-eval-1', resourceId: 'res-vid-1', version: 'v1', startMs: 0, endMs: 0 } },
            { type: 'image', mimeType: 'image/png', data: pngBase64, sha256: pngSha, source: { canvasId: 'c-eval-1', resourceId: 'res-vid-1', version: 'v1', startMs: 2500, endMs: 2500 } },
            { type: 'image', mimeType: 'image/png', data: pngBase64, sha256: pngSha, source: { canvasId: 'c-eval-1', resourceId: 'res-vid-1', version: 'v1', startMs: 4900, endMs: 4900 } },
          ],
        },
      }, 'media.inspect', { api: 'google-generative-ai', modelId: 'gemini-2.5-pro', nativePartStore: store, canvasId: 'c-eval-1', sessionId: 'sess-s1' });
      const sourceBlocks = result.content
        .filter((b) => b.type === 'text' && b.text.includes('"startMs"'))
        .map((b) => JSON.parse(b.text).source.startMs);
      expect(sourceBlocks).toEqual([0, 2500, 4900]);
      expect(result.content.filter((b) => b.type === 'image')).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: media.transcribe free local Whisper vs paid cloud Whisper mandate enforcement
  // -------------------------------------------------------------------------
  test('Scenario 2: media.transcribe free local Whisper bypasses mandate while paid cloud Whisper enforces mandate precheck & Go permit', { timeout: 60000 }, async () => {
    const goOut = runGoTests('^TestMediaTranscribe');
    expect(goOut).toContain('TestMediaTranscribeFreeLocalWhisperRunsWithoutMandate');
    expect(goOut).toContain('TestMediaTranscribePaidCloudWhisperMandateAndRaceEnforcement');

    // JS host layer: free local Whisper (model == '') is NOT a paid op; paid cloud Whisper IS.
    expect(resolvePaidOpForTool({ name: 'media_transcribe', arguments: { canvasId: 'c1', resourceId: 'r1', model: '' } })).toBe('');
    expect(resolvePaidOpForTool({ name: 'media_transcribe', arguments: { canvasId: 'c1', resourceId: 'r1' } })).toBe('');
    expect(resolvePaidOpForTool({ name: 'media_transcribe', arguments: { canvasId: 'c1', resourceId: 'r1', model: 'whisper-1' } })).toBe('media.transcribe');

    const precheckCalls = [];
    const ext = createDurableApprovalExtension({
      entry: { canvasId: 'c-eval-2', sessionId: 'sess-s2', permissionMode: 'canvas', turn: { turnId: 'turn-s2' }, readOnlyToolNames: new Set(['media_transcribe']) },
      precheckTool: async (payload) => {
        precheckCalls.push(payload);
        return {
          decision: 'approval_required',
          proposalId: 'appr-transcribe-1',
          summary: '云端语音转写需要授权',
          unquotedCount: 1,
        };
      },
    });
    const beforeTool = ext.hooks[0].handlers.beforeTool;
    const freeRes = await beforeTool(
      { id: 'tc-free', name: 'media_transcribe', arguments: { canvasId: 'c-eval-2', resourceId: 'r-audio-1' } },
      { taskId: 1, now: () => Date.now() },
      CTX,
    );
    expect(freeRes).toBeUndefined();
    expect(precheckCalls).toHaveLength(0);

    const paidRes = await beforeTool(
      { id: 'tc-paid', name: 'media_transcribe', arguments: { canvasId: 'c-eval-2', resourceId: 'r-audio-1', model: 'whisper-1' } },
      { taskId: 2, now: () => Date.now() },
      CTX,
    );
    expect(precheckCalls).toHaveLength(1);
    expect(precheckCalls[0].opName).toBe('media.transcribe');
    expect(Array.isArray(paidRes?.sleep?.signals)).toBe(true);
    expect(paidRes.sleep.signals[0]?.key).toBe('appr-transcribe-1');
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Sequential inspection of 8+ videos: <=32MiB cap, ENOENT graceful degradation,
  //             reference-aware eviction, AND 100% byte-identical KV prefix across turns
  // -------------------------------------------------------------------------
  test('Scenario 3: 9 sequential videos never crash 32 MiB cap, degrade missing parts cleanly, protect live refs, and keep KV prefix byte-identical', async () => {
    const dir = makeTempDir('s3-media-kv');
    try {
      const store = createNativePartStore({ directory: path.join(dir, 'parts') });
      const googleModel = { api: 'google-generative-ai', modelId: 'gemini-2.5-pro', nativePartStore: store };
      // 9 distinct videos x ~4.5 MiB each = ~40.5 MiB (> 32 MiB DEFAULT_MAX_REQUEST_BYTES)
      const messages = [];
      const messageEntryId = new Map();
      const refIds = [];
      const googleContents = [];

      for (let i = 0; i < 9; i += 1) {
        const videoBuf = Buffer.alloc(4_500_000, 0x41 + i);
        const videoBase64 = videoBuf.toString('base64');
        const videoSha = crypto.createHash('sha256').update(videoBuf).digest('hex');
        const startMs = i * 5000;
        const endMs = startMs + 4000;
        const toolRes = mediaToolResult({
          result: {
            mode: 'video',
            mediaType: 'video',
            canvasId: 'c-eval-3',
            resourceId: `res-vid-${i}`,
            content: [{
              type: 'media',
              mimeType: 'video/mp4',
              data: videoBase64,
              sha256: videoSha,
              source: { canvasId: 'c-eval-3', resourceId: `res-vid-${i}`, version: `v-${i}`, startMs, endMs },
            }],
          },
        }, 'media.inspect', { ...googleModel, canvasId: 'c-eval-3', sessionId: 'sess-s3' });
        const markerText = toolRes.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const refLine = markerText.split('\n').find((line) => line.startsWith(MEDIA_REFERENCE_MARKER)) || '';
        const ref = refLine ? JSON.parse(refLine.slice(MEDIA_REFERENCE_MARKER.length)) : null;
        expect(ref?.id).toBeTruthy();
        refIds.push(ref.id);
        const toolMsg = { role: 'toolResult', toolCallId: `tc-${i}`, toolName: 'media_inspect', content: toolRes.content };
        messages.push(toolMsg);
        messageEntryId.set(toolMsg, i + 1);
        googleContents.push(
          { role: 'model', parts: [{ functionCall: { name: 'media_inspect', args: { resourceId: `res-vid-${i}` } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'media_inspect', id: `tc-${i}`, response: { output: markerText } } }] },
        );
      }

      // Live session references MUST NOT be evicted by pruneUnreferenced even with tiny maxTotalBytes.
      const livePrune = store.pruneUnreferenced({ maxTotalBytes: 1024 });
      expect(livePrune.deleted).toHaveLength(0);
      expect(livePrune.kept).toBe(9);

      // Delete the 8th video part from disk to simulate ENOENT missing part.
      fs.rmSync(path.join(dir, 'parts', `${refIds[7]}.bin`), { force: true });

      const adapted = adaptMediaRequest({ contents: googleContents }, googleModel);
      // Must NEVER throw on >32MiB OR ENOENT; oldest parts + missing part degrade to structured text placeholders!
      let totalInlineDecodedBytes = 0;
      const placeholderTexts = [];
      for (const content of adapted.contents) {
        for (const part of content.parts) {
          if (part.inlineData?.data) {
            totalInlineDecodedBytes += Math.floor((part.inlineData.data.length * 3) / 4);
          }
          const fnOut = part.functionResponse?.response?.output;
          if (typeof fnOut === 'string' && fnOut.includes('历史媒体已降级为文本占位')) {
            placeholderTexts.push(fnOut);
          }
        }
      }
      expect(totalInlineDecodedBytes).toBeLessThanOrEqual(DEFAULT_MAX_REQUEST_BYTES);
      expect(totalInlineDecodedBytes).toBeGreaterThan(0);
      expect(placeholderTexts.some((t) => t.includes('res-vid-0') && t.includes('video/mp4') && t.includes('budget_exceeded'))).toBe(true);
      expect(placeholderTexts.some((t) => t.includes('res-vid-7') && t.includes('video/mp4') && t.includes('"reason":"missing"'))).toBe(true);

      // Monotone MediaRetentionDoc cutoff cursor: once advanced, consecutive turns keep 100% byte-identical prefix!
      const eval1 = evaluateMonotoneMediaCutoff(messages, {
        cutoffEntryId: 0,
        messageEntryId,
        maxNativeMediaBytes: DEFAULT_MAX_REQUEST_BYTES,
        nativePartStore: store,
      });
      expect(eval1.advanced).toBe(true);
      const cutoff = eval1.cutoffEntryId;
      expect(cutoff).toBeGreaterThan(0);

      // Turn N (text follow-up) vs Turn N+1 (another text follow-up): cutoff does NOT slide!
      const userTurnN = { role: 'user', content: '总结分镜节奏' };
      const turnN = [...messages, userTurnN];
      messageEntryId.set(userTurnN, 10);
      const evalTurnN = evaluateMonotoneMediaCutoff(turnN, {
        cutoffEntryId: cutoff,
        messageEntryId,
        maxNativeMediaBytes: DEFAULT_MAX_REQUEST_BYTES,
        nativePartStore: store,
      });
      expect(evalTurnN.advanced).toBe(false);
      expect(evalTurnN.cutoffEntryId).toBe(cutoff);

      const asstTurnN = { role: 'assistant', content: '节奏稳定' };
      const userTurnN1 = { role: 'user', content: '继续第10镜' };
      const turnN1 = [...turnN, asstTurnN, userTurnN1];
      messageEntryId.set(asstTurnN, 11);
      messageEntryId.set(userTurnN1, 12);
      const prefixN = JSON.stringify(applyMonotoneMediaCutoff(turnN, { cutoffEntryId: cutoff, messageEntryId }).slice(0, 10));
      const prefixN1 = JSON.stringify(applyMonotoneMediaCutoff(turnN1, { cutoffEntryId: cutoff, messageEntryId }).slice(0, 10));
      expect(prefixN1).toBe(prefixN);

      // Releasing the session allows pruneUnreferenced to reclaim all unreferenced parts cleanly.
      store.releaseSession('c-eval-3', 'sess-s3');
      const releasedPrune = store.pruneUnreferenced({ maxTotalBytes: 0 });
      expect(releasedPrune.deleted.length).toBeGreaterThanOrEqual(8);
      expect(releasedPrune.totalBytes).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 4: #362 stream EOF retry vs partial-output zero-double-billing & crash restart guard
  // -------------------------------------------------------------------------
  test('Scenario 4: #362 retries clean zero-output premature EOF but blocks duplicate upstream billing on partial-output interruption', { timeout: 30000 }, async () => {
    // 4a: Clean zero-output premature EOF -> rewritten to retryable Network error so Pi retries automatically.
    const cleanEofMsg = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'upstream stream ended before first response: unexpected EOF',
    };
    const normalizedCleanEof = normalizeModelTransportError(cleanEofMsg);
    expect(normalizedCleanEof.kind).toBe('error');
    expect(cleanEofMsg.errorMessage).toContain('Network error:');

    // 4b: Partial assistant output followed by premature EOF -> non-retryable zero-double-billing!
    const partialEofMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: '已经输出了一半的分镜方案...' }],
      stopReason: 'error',
      errorMessage: 'terminated: unexpected EOF',
    };
    const normalizedPartialEof = normalizeModelTransportError(partialEofMsg);
    expect(normalizedPartialEof.kind).toBe('partial_output_interrupted');
    expect(partialEofMsg.errorMessage).toBe(PARTIAL_OUTPUT_STREAM_INTERRUPTED);

    // End-to-end against real Durable Session + local HTTP SSE server:
    const dir = makeTempDir('s4-eof');
    let mode = 'clean-eof';
    let cleanEofAttempts = 0;
    let partialEofAttempts = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      if (mode === 'clean-eof') {
        cleanEofAttempts += 1;
        if (cleanEofAttempts === 1) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sseChunk(res, { role: 'assistant', content: 'EOF 重试恢复成功' });
        sseChunk(res, {}, 'stop', { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
        res.end('data: [DONE]\n\n');
        return;
      }
      partialEofAttempts += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseChunk(res, { role: 'assistant', content: '已生成半段付费内容，随后网络中断' });
      setTimeout(() => res.socket.destroy(), 15);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const models = await createStubModels(dir, baseUrl);
    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'eval-stub-model' }),
      buildTools: () => [],
      authorizeTurn: async () => ({ open: true, canvasId: 'c-eval-4', permissionMode: 'canvas' }),
      settings: { retry: { maxRetries: 2, baseDelayMs: 20, maxDelayMs: 50 } },
    });
    try {
      const entry = await store.createSession('c-eval-4');
      // 4a: clean 0-output EOF recovers on attempt 2.
      const sub1 = await store.submit(entry, { turnId: 't-eof-clean', requestId: 'r-eof-clean', content: '测试零输出断流重试', userText: '测试零输出断流重试' });
      const res1 = await store.wait(entry, sub1);
      expect(res1.error).toBeNull();
      expect(cleanEofAttempts).toBe(2);

      // 4b: partial-output mid-stream EOF MUST NOT trigger a 2nd upstream HTTP call (zero double billing!).
      mode = 'partial-eof';
      const sub2 = await store.submit(entry, { turnId: 't-eof-partial', requestId: 'r-eof-partial', content: '测试半段输出防重复计费', userText: '测试半段输出防重复计费' });
      const res2 = await store.wait(entry, sub2);
      expect(res2.error).toBeTruthy();
      expect(partialEofAttempts).toBe(1);
    } finally {
      await store.disposeAll();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 5: PR-4 ToolPark + /signals cold wake across restart
  // -------------------------------------------------------------------------
  test('Scenario 5: PR-4 ToolPark parks cleanly, survives complete host shutdown, and cold-wakes via deliverSignal', { timeout: 30000 }, async () => {
    const dir = makeTempDir('s5-toolpark');
    let modelTurn = 0;
    let parkedTaskId = null;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      modelTurn += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (modelTurn === 1) {
        sseChunk(res, {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'tc-park-1',
            type: 'function',
            function: { name: 'wait_render_eval', arguments: JSON.stringify({ taskId: 'eval-task-99' }) },
          }],
        });
        sseChunk(res, {}, 'tool_calls', { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 });
      } else {
        sseChunk(res, { role: 'assistant', content: '冷重启唤醒成功，成片已就绪。' });
        sseChunk(res, {}, 'stop', { prompt_tokens: 45, completion_tokens: 14, total_tokens: 59 });
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const models = await createStubModels(dir, baseUrl);

    const makeTools = () => [{
      name: 'wait_render_eval',
      label: 'eval.wait_render',
      description: 'Parks waiting for business_task_settled signal',
      readOnly: true,
      replay: 'safe',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      execute: async (_callId, input, _signal, { durableApi }) => {
        if (durableApi.wake?.reason === 'signal') {
          return { content: [{ type: 'text', text: JSON.stringify({ settled: true, taskId: input.taskId, payload: durableApi.wake.value }) }] };
        }
        parkedTaskId = durableApi.taskId;
        return {
          sleep: {
            signals: [BusinessTaskSettled.key(input.taskId)],
            until: durableApi.now() + 60_000,
            checkpoint: { taskId: input.taskId },
          },
        };
      },
    }];

    const makeStore = () => createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'eval-stub-model' }),
      buildTools: makeTools,
      authorizeTurn: async () => ({ open: true, canvasId: 'c-eval-5', permissionMode: 'canvas' }),
      settings: { retry: { maxRetries: 0 } },
    });

    const store1 = makeStore();
    let store2 = null;
    try {
      const entry = await store1.createSession('c-eval-5');
      const sessionId = entry.sessionId;
      await store1.submit(entry, { turnId: 't-park-1', requestId: 'r-park-1', content: '等待渲染任务 eval-task-99', userText: '等待渲染任务 eval-task-99' });

      // Wait until tool has parked.
      const deadline = Date.now() + 10_000;
      while (!parkedTaskId && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(parkedTaskId).toBeTruthy();
      await new Promise((r) => setTimeout(r, 80));

      // Simulate complete cold host shutdown!
      await store1.disposeAll();

      // Brand-new cold store instance opens the session on demand when signal arrives!
      store2 = makeStore();
      const wakeResult = await store2.deliverSignal('c-eval-5', sessionId, {
        durableTaskId: parkedTaskId,
        signal: BUSINESS_TASK_SETTLED_SIGNAL,
        key: 'eval-task-99',
        value: { taskId: 'eval-task-99', status: 'succeeded', state: 'completed' },
      });
      expect(wakeResult.ok).toBe(true);

      const waitDeadline = Date.now() + 10_000;
      let history = null;
      while (Date.now() < waitDeadline) {
        history = await store2.history('c-eval-5', sessionId);
        if (history.turns.some((t) => String(t.reply || '').includes('冷重启唤醒成功'))) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(modelTurn).toBe(2);
      expect(history.turns.some((t) => String(t.reply || '').includes('冷重启唤醒成功'))).toBe(true);
    } finally {
      await store1.disposeAll().catch(() => {});
      if (store2) await store2.disposeAll().catch(() => {});
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 6: PR-5 ProductionMandate concurrent reserve, ceiling pause,
  //             failed+retrievable non-release, unquoted gate
  // -------------------------------------------------------------------------
  test('Scenario 6: PR-5 ProductionMandate enforces concurrent reserve, ceiling pause, failed+retrievable non-release, and unquoted gate', { timeout: 60000 }, async () => {
    const goOut = runGoTests('^TestProductionMandate(6Shot|Parallel4|LifecycleRetrievable|UnquotedBYOK)');
    expect(goOut).toContain('TestProductionMandate6ShotAutoExecutionAndBudgetExhaustion');
    expect(goOut).toContain('TestProductionMandateParallel4ToolReservationsNoDeadlock');
    expect(goOut).toContain('TestProductionMandateLifecycleRetrievableNeverReleasesAndOrphanReconciliation');
    expect(goOut).toContain('TestProductionMandateUnquotedBYOKNeverGetsFreePass');

    // Verify JS beforeTool approval extension honors allow / approval_required (ceiling/unquoted) / deny.
    const decisions = [
      { decision: 'allow' },
      { decision: 'approval_required', proposalId: 'appr-ceiling-1', reason: 'budget_ceiling_reached', summary: '预算上限已满' },
      { decision: 'deny', reason: 'read_only_blocked' },
    ];
    let idx = 0;
    const ext = createDurableApprovalExtension({
      entry: { canvasId: 'c-eval-6', sessionId: 'sess-s6', permissionMode: 'canvas', turn: { turnId: 'turn-s6' } },
      precheckTool: async () => decisions[idx++],
    });
    const beforeTool = ext.hooks[0].handlers.beforeTool;
    const call = { id: 'tc-1', name: 'canvas_generation_submit', arguments: { canvasId: 'c-eval-6', proposalId: 'gp-1', nodeIds: ['n1'] } };
    const api = { taskId: 11, now: () => Date.now() };
    expect(await beforeTool(call, api, CTX)).toBeUndefined();
    const parked = await beforeTool(call, api, CTX);
    expect(parked?.sleep?.signals?.[0]?.key).toBe('appr-ceiling-1');
    const denied = await beforeTool(call, api, CTX);
    expect(denied?.block).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Auto-compaction preserving storyboard, resourceId, and active Skill pointers
  //             via pi-creative-media generic factory + BeefTV adapter
  // -------------------------------------------------------------------------
  test('Scenario 7: auto-compaction preserves storyboard, resourceId, and active Skill pointers via pi-creative-media factory + BeefTV adapter', { timeout: 30000 }, async () => {
    const dir = makeTempDir('s7-compact');
    let summaryCaptured = null;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const systemText = (body.messages || [])
        .filter((m) => m.role === 'system' || m.role === 'developer')
        .map(msgText)
        .join('\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (systemText.includes('上下文压缩助手')) {
        summaryCaptured = body;
        sseChunk(res, {
          role: 'assistant',
          content: '## 画布与分镜计划\n- 镜头 1-4 霓虹雨夜追逐分镜已锁定\n## 已确认资产与素材标识\n- resourceId: res_eval_shot_01, res_eval_shot_02',
        });
        sseChunk(res, {}, 'stop', { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 });
      } else {
        sseChunk(res, {
          role: 'assistant',
          content: '已锁定镜头 1-4 分镜表与素材 res_eval_shot_01、res_eval_shot_02。' + '场景运镜细节。'.repeat(60),
        });
        sseChunk(res, {}, 'stop', { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 });
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const models = await createStubModels(dir, baseUrl);
    const skillPin = { skillId: 'storyboard-director', versionId: 'v2', contentHash: 'b'.repeat(64), skillName: '分镜导演规范' };
    const store = createDurableSessionStore({
      sessionRoot: path.join(dir, 'sessions'),
      workspaceRoot: path.join(dir, 'workspace'),
      getModels: () => models,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'eval-stub-model' }),
      buildTools: () => [],
      authorizeTurn: async () => ({ open: true, canvasId: 'c-eval-7', permissionMode: 'canvas' }),
      settings: {
        retry: { maxRetries: 0 },
        compaction: { enabled: false, keepRecentTokens: 80, reserveTokens: 2048, backgroundTokens: 0 },
      },
      skills: {
        readContext: async (entry) => ({ canvasId: entry.canvasId, sessionId: entry.sessionId, revision: 1, scopeId: 's-eval-7', activePins: [skillPin], lifecycle: 'active' }),
        changeContext: async (entry) => ({ canvasId: entry.canvasId, sessionId: entry.sessionId, revision: 1, scopeId: 's-eval-7', activePins: [skillPin], lifecycle: 'active' }),
        readVersion: async (_entry, pin) => ({
          pin,
          name: '分镜导演规范',
          version: '2',
          description: '保持角色与景别连贯',
          instruction: '先锁首帧再出视频。',
          files: [],
          unsupportedCapabilities: [],
        }),
        readCatalog: async () => ({ skills: [], total: 0 }),
      },
    });
    try {
      const entry = await store.createSession('c-eval-7');
      for (const [i, text] of [
        '画布 c-eval-7 分镜 1-4：雨夜追逐，引用 res_eval_shot_01 与 res_eval_shot_02。' + '镜头描述。'.repeat(100),
        '保持角色风衣一致并推进第 3 镜。' + '镜头描述。'.repeat(100),
        '准备合成最终成片。' + '镜头描述。'.repeat(100),
      ].entries()) {
        const sub = await store.submit(entry, {
          turnId: `t-c7-${i + 1}`,
          requestId: `r-c7-${i + 1}`,
          content: text,
          userText: text,
          skills: i === 0 ? [skillPin] : [],
        });
        expect((await store.wait(entry, sub)).error).toBeNull();
      }
      const usageBefore = await entry.harness.snapshot(UsageDoc, entry.root.id, CTX);
      const tokensBefore = usageBefore?.models?.['beeftv/eval-stub-model']?.totalTokens || 0;

      const compacted = await store.compactSession('c-eval-7', { sessionId: entry.sessionId });
      expect(compacted.compacted).toBe(true);
      expect(summaryCaptured).toBeTruthy();

      const view = await entry.root.context(CTX);
      const compEntry = view.entries.find((e) => e.kind === CompactionEntry.kind);
      expect(compEntry).toBeTruthy();
      const summaryText = msgText(compEntry.model?.[0]);
      expect(summaryText).toContain('c-eval-7');
      expect(summaryText).toContain('res_eval_shot_01');
      expect(summaryText).toContain('storyboard-director');

      const usageAfter = await entry.harness.snapshot(UsageDoc, entry.root.id, CTX);
      const tokensAfter = usageAfter?.models?.['beeftv/eval-stub-model']?.totalTokens || 0;
      expect(tokensAfter).toBeGreaterThanOrEqual(tokensBefore + 360);
    } finally {
      await store.disposeAll();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
