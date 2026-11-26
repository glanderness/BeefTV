// Phase 2.1 + Phase 1 修复的行为验证：
// 1. file.read 超过 50KB JSON 经过官方 pi-durable ToolTask 不被截断，保留完整 pagination 与续读提示；
// 2. Anthropic / OpenRouter-Claude 的 cache_control 从末尾易变 <beeftv_studio> 尾块前移到前一个稳定历史块；
// 3. 只读工具在官方 toolExecution='parallel' 下真实并行执行，混合写工具回合仍保持顺序；
// 4. 官方 contextUsage / configureSession(thinkingLevel) / compactSession / SQLite telemetry 全链路生效。
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { providerRegistration } from './canvas-turn.mjs';
import { adaptProviderPromptCache } from './prompt-cache.mjs';
import { openHostTelemetry } from './durable-telemetry.mjs';
import { nativeSourceKey, officialNativeHistory } from './native-history.mjs';
import { fixtureSkillContext } from './test-support/skill-context-fixture.mjs';

describe('Phase 2.1 Pi 1.6.0 harness upgrades and Phase 1 fixes', () => {
  test('adaptProviderPromptCache shifts cache_control off mutable <beeftv_studio> tail onto prior stable block', () => {
    const mergedAnthropic = {
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '帮我分析第一集分镜' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '思考中', signature: 'sig-1' }, { type: 'text', text: '好的' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' },
            { type: 'text', text: '<beeftv_studio>\n[制作现场｜画布版本 9]\n</beeftv_studio>', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        },
      ],
    };
    const shifted = adaptProviderPromptCache(mergedAnthropic, 'anthropic-messages', { sessionId: 'durable:test-1' });
    expect(shifted.metadata).toEqual({ user_id: 'durable:test-1' });
    expect(shifted.messages[2].content[1].cache_control).toBeUndefined();
    expect(shifted.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    // When the tail is its own standalone message (e.g. OpenRouter Claude), shift onto the prior assistant text block (never thinking).
    const separateOpenRouter = {
      model: 'anthropic/claude-sonnet-4-5',
      messages: [
        { role: 'user', content: '第一轮消息' },
        { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: '<beeftv_studio>\n[制作现场｜画布版本 10]\n</beeftv_studio>', cache_control: { type: 'ephemeral' } }],
        },
      ],
    };
    const shiftedOR = adaptProviderPromptCache(separateOpenRouter, 'openai-completions');
    expect(shiftedOR.messages[2].content[0].cache_control).toBeUndefined();
    expect(shiftedOR.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });

    // Pi 1.6.0 Claude 5 models append a trailing system output_config control message after the user turn.
    const claude5TrailingControl = {
      model: 'claude-sonnet-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '分析镜头' }] },
        { role: 'assistant', content: [{ type: 'text', text: '开始检查' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: '<beeftv_studio>\n[制作现场｜画布版本 11]\n</beeftv_studio>', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        },
        { role: 'system', content: [], output_config: { effort: 'high' } },
      ],
    };
    const shiftedC5 = adaptProviderPromptCache(claude5TrailingControl, 'anthropic-messages', { sessionId: 'durable:c5' });
    expect(shiftedC5.messages[2].content[0].cache_control).toBeUndefined();
    expect(shiftedC5.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('providerRegistration enables OpenRouter Claude Anthropic cache format without inheriting third-party catalog prices', () => {
    const openrouterClaude = providerRegistration({
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-sonnet-4-5',
      maxTokens: 8192,
      contextWindow: 200000,
    }).models[0];
    expect(openrouterClaude.compat.cacheControlFormat).toBe('anthropic');
    expect(openrouterClaude.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test('officialNativeHistory indexes byOriginSource so Gemini 2.5 without functionResponse.id survives repeated media inspections across turns', async () => {
    const sharedSource = { canvasId: 'c1', nodeId: 'n1', resourceId: 'r1', version: 'v1', startMs: 0, endMs: 5000 };
    const line1 = 'BEEFTV_MEDIA_REF_V1:' + JSON.stringify({ id: 'ref-1', source: { ...sharedSource, originTurnId: 'turn-1' } });
    const line2 = 'BEEFTV_MEDIA_REF_V1:' + JSON.stringify({ id: 'ref-2', source: { ...sharedSource, originTurnId: 'turn-2' } });
    const fakeEntry = {
      root: {
        id: 'conv-1',
        context: async () => ({
          entries: [
            { id: 1, model: [] },
            { id: 2, model: [{ role: 'toolResult', toolName: 'media_inspect', toolCallId: 'c-1', content: [{ type: 'text', text: line1 }] }] },
            { id: 3, model: [] },
            { id: 4, model: [{ role: 'toolResult', toolName: 'media_inspect', toolCallId: 'c-2', content: [{ type: 'text', text: line2 }] }] },
          ],
        }),
      },
      harness: {
        commit: async (fn) => fn({
          submission: (id) => ({
            sub1: { conversationId: 'conv-1', requestId: 'req-1', entry: 1, status: 'done' },
            sub2: { conversationId: 'conv-1', requestId: 'req-2', entry: 3, status: 'done' },
          }[id]),
        }),
      },
    };
    const history = await officialNativeHistory(fakeEntry, {
      turns: [
        { turnId: 'turn-1', requestId: 'req-1', submissionId: 'sub1' },
        { turnId: 'turn-2', requestId: 'req-2', submissionId: 'sub2' },
      ],
      active: null,
    }, {});
    const sk = nativeSourceKey(sharedSource);
    // Repeated inspection of the same segment makes legacy bySource ambiguous (null),
    // while byOriginSource cleanly distinguishes both turns without locking the session!
    expect(history.bySource.get(sk)).toBeNull();
    expect(history.byOriginSource.get(`turn-1:${sk}`)).toEqual({ originTurnId: 'turn-1', historical: true });
    expect(history.byOriginSource.get(`turn-2:${sk}`)).toEqual({ originTurnId: 'turn-2', historical: true });
  });

  test('file_read >50KB JSON survives official pi-durable ToolTask without truncation, read-only tools execute in parallel, and session config/usage/telemetry work', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-phase21-'));
    const recordedRequests = [];
    let modelTurn = 0;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      recordedRequests.push(body);
      modelTurn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const writeChunk = (delta, finish_reason = null, usage = undefined) => {
        res.write('data: ' + JSON.stringify({
          id: `c-${modelTurn}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        }) + '\n\n');
      };
      if (modelTurn === 1) {
        // Emit two read-only calls in parallel: a >50KB file_read and a slow read tool.
        writeChunk({
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_file', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ resourceId: 'res-big' }) } },
            { index: 1, id: 'call_probe', type: 'function', function: { name: 'asset_list', arguments: JSON.stringify({}) } },
          ],
        });
        writeChunk({}, 'tool_calls', { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
        res.end('data: [DONE]\n\n');
        return;
      }
      writeChunk({ role: 'assistant', content: '已读取大文档并完成检查。' });
      writeChunk({}, 'stop', { prompt_tokens: 5200, completion_tokens: 40, total_tokens: 5240 });
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-phase21';

    let inFlight = 0;
    let maxConcurrent = 0;
    const hugeDoc = Array.from({ length: 700 }, (_, i) => `第${i + 1}行：这是一段用于测试超过50KB JSON不会被官方文档限流拦腰截断的剧本台词内容。`).join('\n');
    const footer = '\n\n[当前显示第 1-700 行（共 1200 行）。如需继续阅读后续内容，请传 offset=701 调用 file_read（resourceId="res-big"）。]';
    const bigPayload = {
      op: 'file.read',
      result: {
        resourceId: 'res-big',
        format: 'text',
        readable: true,
        content: hugeDoc + footer,
        pagination: { startLine: 1, endLine: 700, totalLines: 1200, truncated: true },
      },
    };
    // Confirm the serialized JSON actually exceeds pi-durable's default 50 KiB limit.
    expect(Buffer.byteLength(JSON.stringify(bigPayload), 'utf8')).toBeGreaterThan(55 * 1024);

    const hostTelemetry = await openHostTelemetry(path.join(directory, 'telemetry'));
    try {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'deepseek-v4.1-flash',
        maxTokens: 4096,
        contextWindow: 128000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));

      const store = createDurableSessionStore({
        sessionRoot: path.join(directory, 'sessions'),
        workspaceRoot: path.join(directory, 'workspace'),
        telemetry: hostTelemetry.telemetry,
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'deepseek-v4.1-flash' }),
        buildTools: () => [
          {
            name: 'file_read',
            label: 'file.read',
            readOnly: true,
            replay: 'safe',
            description: 'Read uploaded file',
            parameters: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'] },
            execute: async () => {
              inFlight += 1;
              maxConcurrent = Math.max(maxConcurrent, inFlight);
              await new Promise((r) => setTimeout(r, 40));
              inFlight -= 1;
              return { content: [{ type: 'text', text: JSON.stringify(bigPayload) }] };
            },
          },
          {
            name: 'asset_list',
            label: 'asset.list',
            readOnly: true,
            replay: 'safe',
            description: 'List assets',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              inFlight += 1;
              maxConcurrent = Math.max(maxConcurrent, inFlight);
              await new Promise((r) => setTimeout(r, 40));
              inFlight -= 1;
              return { content: [{ type: 'text', text: JSON.stringify({ result: { items: [] } }) }] };
            },
          },
        ],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 } },
      });

      try {
        const entry = await store.ensureSession('c1');
        // 1. Configure per-session thinkingLevel before turn
        const configured = await store.configureSession('c1', { sessionId: entry.sessionId, thinkingLevel: 'high' });
        expect(configured.thinkingLevel).toBe('high');

        const sub = await store.submit(entry, { turnId: 't1', requestId: 'r1', content: '读取剧本并检查素材', userText: '读取剧本并检查素材', revisionBefore: 1 });
        await store.wait(entry, sub);

        // 2. Verify read-only tools actually ran concurrently under toolExecution='parallel'
        expect(maxConcurrent).toBe(2);

        // 3. Verify >50KB file_read JSON reached the model intact with footer and pagination!
        const secondReq = recordedRequests[1];
        const fileToolMsg = secondReq.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_file');
        expect(fileToolMsg).toBeDefined();
        const parsedToolResult = JSON.parse(fileToolMsg.content);
        expect(parsedToolResult.result.pagination).toEqual({ startLine: 1, endLine: 700, totalLines: 1200, truncated: true });
        expect(parsedToolResult.result.content).toContain('offset=701');

        // 4. Verify history exposes official contextUsage & persisted thinkingLevel
        const history = await store.history('c1', entry.sessionId);
        expect(history.thinkingLevel).toBe('high');
        expect(history.contextUsage.contextWindow).toBe(128000);
        expect(history.contextUsage.estimatedTokens).toBeGreaterThan(0);
        expect(history.contextUsage.totalInput).toBeGreaterThan(0);

        // 5. Verify manual compaction API completes cleanly (short conversation -> compacted=false, no crash)
        const compactRes = await store.compactSession('c1', { sessionId: entry.sessionId });
        expect(compactRes.sessionId).toBe(entry.sessionId);
        expect(typeof compactRes.compacted).toBe('boolean');
        expect(compactRes.contextUsage).toBeDefined();
      } finally {
        await store.disposeAll();
      }
      await hostTelemetry.close();
      expect(fs.existsSync(path.join(directory, 'telemetry', 'telemetry.sqlite'))).toBe(true);
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);

  test('idle manual compaction succeeds with skills enabled, closed prior turn, concurrent busy guard, and structured compaction_failed errors', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-phase21-compact-'));
    let openTurnId = '';
    let holdCompact = null;
    let releaseCompact = null;
    let compactStartedResolve = null;
    const compactStarted = new Promise((r) => { compactStartedResolve = r; });
    let failCompactCall = false;
    let compactSummaryCalls = 0;

    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const isSummaryCall = JSON.stringify(body.messages || []).includes('压缩较早的对话记录时');
      if (isSummaryCall) {
        compactSummaryCalls += 1;
        compactStartedResolve?.();
        if (holdCompact) await holdCompact;
        if (failCompactCall) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream compaction error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'sum-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '摘要：保留分镜 1-3 与角色设定。' }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'sum-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'c-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '确认收到。' + '详细分镜说明。'.repeat(60) }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'c-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1500, completion_tokens: 400, total_tokens: 1900 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-test-compact';

    try {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'deepseek-v4.1-flash',
        maxTokens: 4096,
        contextWindow: 128000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));

      const skillContexts = fixtureSkillContext(directory);
      const store = createDurableSessionStore({
        sessionRoot: path.join(directory, 'sessions'),
        workspaceRoot: path.join(directory, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'deepseek-v4.1-flash' }),
        buildTools: () => [],
        skills: {
          ...skillContexts,
          readVersion: async () => { throw new Error('unexpected_skill_read'); },
          readCatalog: async () => ({ skills: [], total: 0 }),
        },
        authorizeTurn: async ({ turnId }) => {
          if (!turnId || turnId !== openTurnId) {
            throw Object.assign(new Error('turn_not_open'), { reason: 'turn_not_open' });
          }
          return { open: true, canvasId: 'c1', permissionMode: 'canvas' };
        },
        settings: {
          retry: { maxRetries: 0 },
          compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 2048, backgroundTokens: 0 },
        },
      });

      try {
        const entry = await store.ensureSession('c1');
        // Run 3 multi-paragraph turns so real history exceeds keepRecentTokens and forces LLM summarization.
        for (const id of ['turn-a', 'turn-b', 'turn-c']) {
          openTurnId = id;
          const sub = await store.submit(entry, {
            turnId: id,
            requestId: id,
            content: `轮次 ${id}：` + '分镜脚本详细内容与镜头景别光影描述。'.repeat(120),
            userText: `轮次 ${id}`,
            revisionBefore: 1,
          });
          const settled = await store.wait(entry, sub);
          expect(settled.error).toBeNull();
          openTurnId = ''; // Close the turn in Go before idle compaction!
        }

        // Simulate a previous turn having left aborted=true on entry.generation.
        entry.generation.aborted = true;
        holdCompact = new Promise((r) => { releaseCompact = r; });

        const compactPromise = store.compactSession('c1', { sessionId: entry.sessionId, instructions: '保留主角服装' });
        await compactStarted;

        // While compacting: entry is marked busy and concurrent configureSession / submit / changeSkillContext fail fast with session_busy!
        expect(store.isEntryBusy(entry)).toBe(true);
        await expect(store.configureSession('c1', { sessionId: entry.sessionId, thinkingLevel: 'high' }))
          .rejects.toMatchObject({ reason: 'session_busy' });
        await expect(store.submit(entry, { turnId: 'turn-race', requestId: 'turn-race', content: '压缩中并发消息', userText: '压缩中并发消息', revisionBefore: 1 }))
          .rejects.toMatchObject({ reason: 'session_busy' });
        await expect(store.changeSkillContext(entry, { action: 'clear', expectedRevision: 0, requestId: 'clear-race' }))
          .rejects.toMatchObject({ reason: 'session_busy' });

        releaseCompact();
        holdCompact = null;
        const compacted = await compactPromise;
        expect(compacted.compacted).toBe(true);
        expect(compactSummaryCalls).toBe(1);
        expect(store.isEntryBusy(entry)).toBe(false);

        // Next turn followed by failing summarizer returns structured compaction_failed (not internal_error).
        for (const id of ['turn-d', 'turn-e']) {
          openTurnId = id;
          const sub = await store.submit(entry, {
            turnId: id,
            requestId: id,
            content: `后续 ${id}：` + '补充新的镜头与配音脚本内容。'.repeat(120),
            userText: `后续 ${id}`,
            revisionBefore: 2,
          });
          expect((await store.wait(entry, sub)).error).toBeNull();
          openTurnId = '';
        }
        failCompactCall = true;
        await expect(store.compactSession('c1', { sessionId: entry.sessionId }))
          .rejects.toMatchObject({ reason: 'compaction_failed' });
        expect(store.isEntryBusy(entry)).toBe(false);
      } finally {
        await store.disposeAll();
      }
    } finally {
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
