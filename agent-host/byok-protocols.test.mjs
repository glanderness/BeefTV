import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  parseHostBaseUrlEnv,
  parseHostHeadersEnv,
  providerRegistration,
  resolveHostModelRequestUrl,
} from './canvas-turn.mjs';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { installModelFetchProxy } from './model-fetch-proxy.mjs';
import { createDurableRequestBudget } from './durable-request-budget.mjs';
import { mediaToolResult, adaptMediaRequest } from './media-content.mjs';

function makeBudget(dir) {
  return createDurableRequestBudget({ limit: 0, file: path.join(dir, 'budget.json') });
}

describe('BYOK multi-protocol compatibility (Claude / Gemini / OpenAI Responses / Completions)', () => {
  test('providerRegistration adapts official vs third-party BYOK relays safely across all 4 protocols', () => {
    // 1. Official Anthropic keeps long cache retention & official features
    const officialClaude = providerRegistration({
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-opus-5-5',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(officialClaude.reasoning).toBe(true);
    expect(officialClaude.contextWindow).toBe(1000000);
    expect(officialClaude.maxTokens).toBe(32768);
    expect(officialClaude.compat?.supportsMidConvoEffort).toBe(true);
    expect(officialClaude.compat?.supportsLongCacheRetention).not.toBe(false);

    // 2. Third-party Claude relay disables 1h TTL & private 2026 betas while keeping adaptive thinking
    const relayClaude = providerRegistration({
      api: 'anthropic-messages',
      baseUrl: 'https://relay.example.com',
      modelId: 'claude-sonnet-4-6-20260217',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(relayClaude.reasoning).toBe(true);
    expect(relayClaude.contextWindow).toBe(1000000);
    expect(relayClaude.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsLongCacheRetention: false,
      supportsMidConvoEffort: false,
      supportsMidConvoSystemMessages: false,
      supportsMidConvoToolChanges: false,
      supportsStrictTools: false,
    });

    // 3. Legacy Claude 3.5 disables reasoning & caps default maxTokens at 8192 so Anthropic never 400s
    const claude35 = providerRegistration({
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-3-5-sonnet-20241022',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(claude35.reasoning).toBe(false);
    expect(claude35.maxTokens).toBe(8192);

    // 3b. Official catalog provider takes precedence over opencode shadows (e.g. gpt-5.4, claude-opus-5-5, gemini-4-argon)
    const officialGpt54 = providerRegistration({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-5.4',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(officialGpt54.compat?.sessionAffinityFormat).not.toBe('openai-nosession');
    expect(officialGpt54.thinkingLevelMap?.off).toBe('none');
    expect(officialClaude.compat?.supportsMidConvoToolChanges).toBe(true);
    const officialGemini4 = providerRegistration({
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-4-argon',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(officialGemini4.maxTokens).toBe(32768);

    // 3c. Claude relay clears allowedFallbackModels & supportsMessageThreads even if relay path contains api.anthropic.com
    const relayFable = providerRegistration({
      api: 'anthropic-messages',
      baseUrl: 'https://proxy.example.com/api.anthropic.com',
      modelId: 'claude-fable-5',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(relayFable.compat?.allowedFallbackModels).toBeUndefined();
    expect(relayFable.compat?.supportsMessageThreads).toBe(false);

    // 4. Gemini 2.5 Pro gets off:null (never sends illegal thinkingBudget=0) and 1M contextWindow
    const gemini25Pro = providerRegistration({
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-2.5-pro',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(gemini25Pro.reasoning).toBe(true);
    expect(gemini25Pro.contextWindow).toBe(1048576);
    expect(gemini25Pro.thinkingLevelMap).toEqual({ off: null });

    // 5. Unlisted Gemini 3 Pro & Gemini 2.0 Flash
    const gemini3Pro = providerRegistration({
      api: 'google-generative-ai',
      baseUrl: 'https://proxy.example.com/v1beta',
      modelId: 'gemini-3-pro-preview',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(gemini3Pro.reasoning).toBe(true);
    expect(gemini3Pro.thinkingLevelMap).toMatchObject({ off: null, minimal: null, low: 'low', high: 'high' });

    const gemini20Flash = providerRegistration({
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-2.0-flash',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(gemini20Flash.reasoning).toBe(false);

    // 6. OpenAI Responses: official allows long cache retention, third-party relay disables OpenAI-private features;
    //    YYYY-MM-DD dated snapshots match catalog, gpt-5-chat is non-reasoning, unlisted gpt-5/o3 set off:null
    const officialOAI = providerRegistration({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-5-mini-2026',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(officialOAI.reasoning).toBe(true);
    expect(officialOAI.thinkingLevelMap?.off).toBeNull();
    expect(officialOAI.compat?.supportsLongCacheRetention).not.toBe(false);

    const relayOAI = providerRegistration({
      api: 'openai-responses',
      baseUrl: 'https://gateway.example.com/v1',
      modelId: 'gpt-5.6-luna',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(relayOAI.reasoning).toBe(true);
    expect(relayOAI.compat).toMatchObject({
      supportsLongCacheRetention: false,
      supportsMidConvoEffort: false,
      supportsMidConvoSystemMessages: false,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
      supportsExplicitPromptCacheMode: false,
      supportsStrictMode: false,
      supportsOpenAIGrammarTools: false,
    });

    const gpt5Chat = providerRegistration({
      api: 'openai-responses',
      baseUrl: 'https://gateway.example.com/v1',
      modelId: 'gpt-5-chat-2026-01-01',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(gpt5Chat.reasoning).toBe(false);

    const datedGpt41 = providerRegistration({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4.1-2025-04-14',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(datedGpt41.reasoning).toBe(false);
    expect(datedGpt41.contextWindow).toBeGreaterThan(200000);

    // 7. Future gpt-6* reasoning inference + non-Claude model behind LiteLLM anthropic-messages stays conservative
    const gpt6 = providerRegistration({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-6-astra',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(gpt6.reasoning).toBe(true);
    expect(gpt6.compat?.supportsLongCacheRetention).not.toBe(false);

    const nonClaudeOnAnthropic = providerRegistration({
      api: 'anthropic-messages',
      baseUrl: 'https://litellm.example.com',
      modelId: 'custom-llama-70b',
      maxTokens: 0,
      contextWindow: 0,
    }).models[0];
    expect(nonClaudeOnAnthropic.reasoning).toBe(false);
  });

  test('parseHostHeadersEnv filters blocked/unsafe/non-ASCII headers, allows CF-AIG-Authorization, and keeps literal values', () => {
    const parsed = parseHostHeadersEnv(JSON.stringify([
      { name: 'X-Tenant-Id', value: 'studio-42' },
      { name: 'CF-AIG-Authorization', value: 'Bearer cf-gw-token' },
      { name: 'X-Literal-Bang', value: '!echo pwned' },
      { name: 'X-Literal-Env', value: '$BEEFTV_AGENT_API_KEY' },
      { name: 'X-Title', value: '牛肉TV' },
      { name: 'X-Control', value: 'bad\x07bell' },
      { name: 'Authorization', value: 'Bearer evil' },
      { name: 'x-api-key', value: 'evil' },
      { name: 'x-goog-api-key', value: 'evil' },
      { name: 'X-Beeftv-Agent-Token', value: 'evil' },
      { name: 'X-Forwarded-For', value: '1.2.3.4' },
      { name: 'X-Canvas-Internal', value: '1' },
      { name: 'Host', value: 'evil.com' },
      { name: 'X-Bad-CRLF', value: 'ok\r\nEvil: 1' },
      { name: 'x-tenant-id', value: 'duplicate' },
    ]));
    expect(parsed).toEqual([
      ['X-Tenant-Id', 'studio-42'],
      ['CF-AIG-Authorization', 'Bearer cf-gw-token'],
      ['X-Literal-Bang', '!echo pwned'],
      ['X-Literal-Env', '$BEEFTV_AGENT_API_KEY'],
    ]);
  });

  test('Claude BYOK relay E2E: clean 5m ephemeral cache, no 1h TTL/2026 betas, literal custom headers, tool call & compact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-byok-claude-'));
    const seenRequests = [];
    let callIdx = 0;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seenRequests.push({ url: req.url, headers: req.headers, body });
      callIdx += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${callIdx}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: callIdx > 1 ? 100 : 0 },
        },
      });
      if (callIdx === 1) {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'canvas_search', input: {} } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } });
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        return;
      }
      const replyText = callIdx === 3 ? '摘要：保留咖啡广告画布。' : '已查到咖啡广告画布。' + '详细说明。'.repeat(50);
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: replyText } });
      sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } });
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const prevFetch = globalThis.fetch;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-ant-relay-test';

    try {
      const baseUrl = `http://127.0.0.1:${port}/custom`;
      const rawUrl = `${baseUrl}#`;
      const parsedBase = parseHostBaseUrlEnv(rawUrl);
      expect(resolveHostModelRequestUrl(`http://127.0.0.1:${port}/custom/v1/messages?beta=true`, { ...parsedBase, api: 'anthropic-messages' }))
        .toBe(`http://127.0.0.1:${port}/custom/messages?beta=true`);

      const turnBudgetContext = new AsyncLocalStorage();
      installModelFetchProxy({
        baseUrl: parsedBase.baseUrl,
        isRawBaseUrl: parsedBase.isRaw,
        modelApi: 'anthropic-messages',
        modelId: 'claude-opus-5-5',
        customHeaders: [['X-Relay-Tenant', 'studio-claude'], ['X-Literal', '!whoami']],
        turnBudgetContext,
        nativePartStore: null,
        lifetimeBudget: makeBudget(dir),
        dispatchDiagnostics: { record: () => {} },
        getOps: () => ({ opsRequest: async () => ({}) }),
      });

      const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'anthropic-messages',
        baseUrl: parsedBase.baseUrl,
        modelId: 'claude-opus-5-5',
        maxTokens: 4096,
        contextWindow: 200000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));

      const store = createDurableSessionStore({
        sessionRoot: path.join(dir, 'sessions'),
        workspaceRoot: path.join(dir, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'claude-opus-5-5' }),
        buildTools: () => [{
          name: 'canvas_search',
          label: '搜索画布',
          description: '搜索画布',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: '{"canvases":["咖啡广告"]}' }] }),
        }],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 }, compaction: { enabled: false, keepRecentTokens: 40, reserveTokens: 1024, backgroundTokens: 0 } },
        thinkingLevel: 'low',
      });
      try {
        const entry = await store.ensureSession('c1');
        const sub = await store.submit(entry, { turnId: 't1', requestId: 'r1', content: '查一下画布' + '说明'.repeat(80), userText: '查一下画布', revisionBefore: 1 });
        const result = await store.wait(entry, sub);
        expect(result.error).toBeNull();
        expect(result.reply).toContain('咖啡广告');

        // Verify exact Claude BYOK relay wire payload
        const req0 = seenRequests[0];
        expect(req0.url.startsWith('/custom/messages')).toBe(true);
        expect(req0.headers['x-api-key']).toBe('sk-ant-relay-test');
        expect(req0.headers['x-relay-tenant']).toBe('studio-claude');
        expect(req0.headers['x-literal']).toBe('!whoami');
        expect(String(req0.headers['anthropic-beta'] || '')).not.toContain('mid-conversation-output-config');
        expect(String(req0.headers['anthropic-beta'] || '')).not.toContain('inline-tools-2026');
        expect(req0.body.metadata).toEqual({ user_id: entry.sessionId });
        expect(req0.body.thinking?.block_binding).toBeUndefined();
        expect(req0.body.messages.some((m) => m.role === 'system')).toBe(false);
        expect(req0.body.tools?.some((t) => t.defer_loading || t.strict === true)).toBe(false);
        expect(JSON.stringify(req0.body)).toContain('"type":"ephemeral"');
        expect(JSON.stringify(req0.body)).not.toContain('"ttl":"1h"');

        const compacted = await store.compactSession('c1', { sessionId: entry.sessionId, instructions: '保留咖啡广告' });
        expect(compacted.compacted).toBe(true);
      } finally {
        await store.disposeAll();
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('Gemini BYOK E2E: gemini-2.5-pro off never sends budget=0, gemini-3-pro thinkingLevel works, custom headers & tool call succeed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-byok-gemini-'));
    const seenRequests = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seenRequests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'gemini ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90, cachedContentTokenCount: 20 },
      })}\n\n`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const prevFetch = globalThis.fetch;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'AIza-test-byok';

    try {
      const baseUrl = `http://127.0.0.1:${port}/v1beta`;
      const cases = [
        { modelId: 'gemini-2.5-pro', thinkingLevel: 'off' },
        { modelId: 'gemini-2.5-flash', thinkingLevel: 'off' },
        { modelId: 'gemini-3-pro-preview', thinkingLevel: 'low' },
        { modelId: 'gemini-2.0-flash', thinkingLevel: 'low' },
      ];
      for (const tc of cases) {
        globalThis.fetch = prevFetch;
        const turnBudgetContext = new AsyncLocalStorage();
        installModelFetchProxy({
          baseUrl,
          isRawBaseUrl: false,
          modelApi: 'google-generative-ai',
          modelId: tc.modelId,
          customHeaders: [['X-Gemini-Gateway', 'gw-byok']],
          turnBudgetContext,
          nativePartStore: null,
          lifetimeBudget: makeBudget(dir),
          dispatchDiagnostics: { record: () => {} },
          getOps: () => ({ opsRequest: async () => ({}) }),
        });
        const runtime = await ModelRuntime.create({ authPath: path.join(dir, `${tc.modelId}-auth.json`), modelsPath: null, refreshOnCreate: false });
        runtime.registerProvider('beeftv', providerRegistration({
          api: 'google-generative-ai',
          baseUrl,
          modelId: tc.modelId,
          maxTokens: 4096,
          contextWindow: 0,
        }));
        const models = createModels();
        models.setProvider(runtime.getProvider('beeftv'));
        const store = createDurableSessionStore({
          sessionRoot: path.join(dir, `${tc.modelId}-sessions`),
          workspaceRoot: path.join(dir, `${tc.modelId}-workspace`),
          getModels: () => models,
          getModelRef: () => ({ provider: 'beeftv', modelId: tc.modelId }),
          buildTools: () => [],
          authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
          settings: { retry: { maxRetries: 0 } },
          thinkingLevel: tc.thinkingLevel,
        });
        try {
          const entry = await store.ensureSession('c1');
          const sub = await store.submit(entry, { turnId: `t-${tc.modelId}`, requestId: `r-${tc.modelId}`, content: 'hello', userText: 'hello', revisionBefore: 1 });
          const settled = await store.wait(entry, sub);
          expect(settled.error).toBeNull();
        } finally {
          await store.disposeAll();
        }
      }

      expect(seenRequests).toHaveLength(4);
      // 1. gemini-2.5-pro @ off -> exact /v1beta/models/...:streamGenerateContent?alt=sse URL + thinkingBudget=128 (NOT 0!) + custom header
      expect(seenRequests[0].url).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
      expect(seenRequests[0].headers['x-goog-api-key']).toBe('AIza-test-byok');
      expect(seenRequests[0].headers['x-gemini-gateway']).toBe('gw-byok');
      expect(seenRequests[0].body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(128);
      // 2. gemini-2.5-flash @ off -> thinkingBudget=0
      expect(seenRequests[1].url).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
      expect(seenRequests[1].body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
      // 3. unlisted gemini-3-pro-preview @ low -> thinkingLevel=LOW
      expect(seenRequests[2].url).toBe('/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse');
      expect(seenRequests[2].body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('LOW');
      // 4. legacy gemini-2.0-flash -> no thinkingConfig sent
      expect(seenRequests[3].url).toBe('/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse');
      expect(seenRequests[3].body.generationConfig?.thinkingConfig).toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('OpenAI Responses BYOK relay omits prompt_cache_retention=24h while keeping prompt_cache_key and custom headers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-byok-responses-'));
    const seenRequests = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seenRequests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      ev('response.created', { response: { id: 'resp_1', status: 'in_progress' } });
      ev('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      ev('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
      ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'responses ok' });
      ev('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'responses ok' });
      ev('response.output_item.done', { output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'responses ok' }] } });
      ev('response.completed', { response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } } });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const prevFetch = globalThis.fetch;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-oai-relay';

    try {
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const turnBudgetContext = new AsyncLocalStorage();
      installModelFetchProxy({
        baseUrl,
        isRawBaseUrl: false,
        modelApi: 'openai-responses',
        modelId: 'gpt-5-mini-2026',
        customHeaders: [['X-OAI-Relay', 'ok']],
        turnBudgetContext,
        nativePartStore: null,
        lifetimeBudget: makeBudget(dir),
        dispatchDiagnostics: { record: () => {} },
        getOps: () => ({ opsRequest: async () => ({}) }),
      });

      const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'openai-responses',
        baseUrl,
        modelId: 'gpt-5-mini-2026',
        maxTokens: 4096,
        contextWindow: 200000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));
      const store = createDurableSessionStore({
        sessionRoot: path.join(dir, 'sessions'),
        workspaceRoot: path.join(dir, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'gpt-5-mini-2026' }),
        buildTools: () => [],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 } },
        thinkingLevel: 'low',
      });
      try {
        const entry = await store.ensureSession('c1');
        const sub = await store.submit(entry, { turnId: 't1', requestId: 'r1', content: 'hi', userText: 'hi', revisionBefore: 1 });
        const settled = await store.wait(entry, sub);
        expect(settled.error).toBeNull();
        expect(settled.reply).toBe('responses ok');
        expect(seenRequests[0].url).toBe('/v1/responses');
        expect(seenRequests[0].headers['x-oai-relay']).toBe('ok');
        expect(seenRequests[0].body.prompt_cache_key).toBe(entry.sessionId);
        expect(seenRequests[0].body.prompt_cache_retention).toBeUndefined();
      } finally {
        await store.disposeAll();
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('OpenAI Completions BYOK E2E & custom-header origin isolation (including Request input)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-byok-completions-'));
    const seenModel = [];
    const seenOther = [];
    const modelServer = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      seenModel.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'completions ok' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const otherServer = createServer((req, res) => {
      seenOther.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await Promise.all([
      new Promise((r) => modelServer.listen(0, '127.0.0.1', r)),
      new Promise((r) => otherServer.listen(0, '127.0.0.1', r)),
    ]);
    const modelPort = modelServer.address().port;
    const otherPort = otherServer.address().port;
    const prevFetch = globalThis.fetch;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-oai-compat';
    try {
      const baseUrl = `http://127.0.0.1:${modelPort}/v1`;
      installModelFetchProxy({
        baseUrl,
        isRawBaseUrl: false,
        modelApi: 'openai-completions',
        modelId: 'my-custom-chat',
        customHeaders: [['CF-AIG-Authorization', 'Bearer cf-secret'], ['X-Tenant', 'beeftv']],
        turnBudgetContext: new AsyncLocalStorage(),
        nativePartStore: null,
        lifetimeBudget: makeBudget(dir),
        dispatchDiagnostics: { record: () => {} },
        getOps: () => ({ opsRequest: async () => ({}) }),
      });

      // Non-model origin (even via Request object) must NEVER receive channel custom headers.
      await globalThis.fetch(new Request(`http://127.0.0.1:${otherPort}/ping`, { method: 'GET' }));
      expect(seenOther).toHaveLength(1);
      expect(seenOther[0].headers['cf-aig-authorization']).toBeUndefined();
      expect(seenOther[0].headers['x-tenant']).toBeUndefined();

      // Request object targeting model origin receives custom headers without clobbering Authorization.
      await globalThis.fetch(new Request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-oai-compat', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'my-custom-chat', messages: [{ role: 'user', content: 'ping' }] }),
      }));
      expect(seenModel).toHaveLength(1);
      expect(seenModel[0].url).toBe('/v1/chat/completions');
      expect(seenModel[0].headers.authorization).toBe('Bearer sk-oai-compat');
      expect(seenModel[0].headers['cf-aig-authorization']).toBe('Bearer cf-secret');
      expect(seenModel[0].headers['x-tenant']).toBe('beeftv');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      modelServer.closeAllConnections();
      otherServer.closeAllConnections();
      await Promise.all([
        new Promise((r) => modelServer.close(r)),
        new Promise((r) => otherServer.close(r)),
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test('media-content accepts OpenRouter google/gemini-* and models/gemini-* consistently', () => {
    const wavBytes = Buffer.from('RIFFdemo');
    const sha256 = crypto.createHash('sha256').update(wavBytes).digest('hex');
    const data = {
      result: {
        content: [{
          type: 'media',
          mimeType: 'audio/wav',
          data: wavBytes.toString('base64'),
          sha256,
          source: { canvasId: 'c1', nodeId: 'n1', resourceId: 'r1', version: 'a'.repeat(64), startMs: 0, endMs: 1000 },
        }],
      },
    };
    const toolRes = mediaToolResult(data, 'media.inspect', { api: 'openai-completions', modelId: 'google/gemini-2.5-pro' });
    const markerText = toolRes.content.map((c) => c.text).join('\n');
    const adapted = adaptMediaRequest({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'media_inspect' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: markerText },
      ],
    }, { api: 'openai-completions', modelId: 'google/gemini-2.5-pro' });
    expect(adapted.messages.at(-1)?.role).toBe('user');
    expect(JSON.stringify(adapted.messages.at(-1))).toContain('input_audio');
  });
});
