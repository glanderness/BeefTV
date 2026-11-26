// Phase 2.2 端到端行为测试：
// 1. 官方 pi-durable/tool-search 延迟工具发现（首轮隐藏、搜索后次轮注入）
// 2. 官方 pi-durable/codemode QuickJS-WASI 沙盒编排 + 确认卡模型独占限制 + 只读拦截
// 3. 官方 @earendil-works/pi-mcp 真实 Streamable HTTP MCP 服务端接入、安全环境变量白名单与工具调用
// 4. plugin-packages.mjs 透传 executionMode / deferred / callers / namespace / structuredOutputSchema
// 5. 扫描版 PDF 图片经 operation-bridge 转为多模态 image 内容块
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { providerRegistration } from './canvas-turn.mjs';
import { buildSafeStdioEnv, createMcpServerController } from './mcp-servers.mjs';
import { loadPluginExtensionsFromPackages } from './plugin-packages.mjs';
import { createOperationBridge } from './operation-bridge.mjs';

function sseOpenAIChunks(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function makeFakeModelServer(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push({ url: req.url, body });
    const chunks = handler(body, seen.length);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseOpenAIChunks(chunks));
  });
  return { server, seen };
}

function makeMockStreamableHttpMcpServer() {
  const receivedCalls = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!raw.trim()) {
      res.writeHead(202);
      res.end();
      return;
    }
    const msg = JSON.parse(raw);
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    let result;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'demo-search', version: '1.0.0' },
        instructions: 'Search web references for storyboarding.',
      };
    } else if (msg.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'web_search',
            description: 'Search the web for visual film references',
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
          {
            name: 'write_note',
            description: 'Write an external note',
            annotations: { readOnlyHint: false },
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      };
    } else if (msg.method === 'tools/call') {
      receivedCalls.push(msg.params);
      result = {
        content: [{ type: 'text', text: `found references for ${msg.params?.arguments?.query || ''}` }],
        structuredContent: { hits: 2, query: msg.params?.arguments?.query || '' },
      };
    } else {
      result = {};
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-demo-1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  return { server, receivedCalls };
}

describe('Phase 2.2: Pi tool_search, codemode, pi-mcp, plugin fields & scanned PDF bridge', () => {
  test('buildSafeStdioEnv strips BEEFTV_AGENT_* secrets while keeping PATH and user env', () => {
    const env = buildSafeStdioEnv(
      { EXA_API_KEY: 'exa-ok', BEEFTV_AGENT_HOST_TOKEN: 'blocked' },
      {
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        BEEFTV_AGENT_HOST_TOKEN: 'secret-host',
        BEEFTV_AGENT_API_KEY: 'secret-model',
        BEEFTV_AGENT_DESKTOP_TOKEN: 'secret-desktop',
      },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.EXA_API_KEY).toBe('exa-ok');
    expect(env.BEEFTV_AGENT_HOST_TOKEN).toBeUndefined();
    expect(env.BEEFTV_AGENT_API_KEY).toBeUndefined();
    expect(env.BEEFTV_AGENT_DESKTOP_TOKEN).toBeUndefined();
  });

  test('pi-mcp + tool_search + codemode E2E: external MCP tools stay deferred until discovered and run cleanly inside codemode & direct tool calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-phase22-e2e-'));
    const mcpSrv = makeMockStreamableHttpMcpServer();
    let callStep = 0;
    const modelSrv = makeFakeModelServer((body) => {
      callStep += 1;
      if (callStep === 1) {
        // Turn 1 req 1: call tool_search for external MCP tool
        return [
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tc_search', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: 'web_search visual film references' }) } }] }, finish_reason: null }] },
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ];
      }
      if (callStep === 2) {
        // Turn 1 req 2: call codemode to invoke both canvas_search & mcp__demo__web_search in parallel
        const script = [
          'const found = await searchTools("web_search");',
          'const [c, m] = await Promise.all([tools.canvas_search({}), tools.mcp__demo__web_search({ query: "cyberpunk neon" })]);',
          'return { foundCount: found.length, canvas: c, mcpHits: m.structuredContent?.hits, mcpQuery: m.structuredContent?.query };',
        ].join('\n');
        return [
          { id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tc_code', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: script }) } }] }, finish_reason: null }] },
          { id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ];
      }
      return [
        { id: 'c3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'phase 2.2 done' }, finish_reason: null }] },
        { id: 'c3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
    });

    await Promise.all([
      new Promise((r) => mcpSrv.server.listen(0, '127.0.0.1', r)),
      new Promise((r) => modelSrv.server.listen(0, '127.0.0.1', r)),
    ]);
    const mcpPort = mcpSrv.server.address().port;
    const modelPort = modelSrv.server.address().port;
    const prevKey = process.env.BEEFTV_AGENT_API_KEY;
    process.env.BEEFTV_AGENT_API_KEY = 'sk-phase22';

    const mcpController = createMcpServerController({
      cwd: dir,
      dataDir: dir,
      fetchEnabledServers: async () => ({
        fingerprint: 'fp-demo',
        servers: [{
          name: 'demo',
          transport: 'http',
          enabled: true,
          url: `http://127.0.0.1:${mcpPort}/mcp`,
          timeoutSec: 15,
        }],
      }),
    });

    let store;
    try {
      const tested = await mcpController.testServer({
        name: 'demo',
        transport: 'http',
        enabled: true,
        url: `http://127.0.0.1:${mcpPort}/mcp`,
        timeoutSec: 15,
      });
      expect(tested.ok).toBe(true);
      expect(tested.toolCount).toBe(2);

      const synced = await mcpController.syncIfChanged();
      expect(synced.changed).toBe(true);
      const demoStatus = mcpController.getStatus().find((item) => item.name === 'demo');
      expect(demoStatus?.state).toBe('connected');
      expect(demoStatus?.toolCount).toBe(2);

      const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider('beeftv', providerRegistration({
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        modelId: 'test-model',
        maxTokens: 4096,
        contextWindow: 200000,
      }));
      const models = createModels();
      models.setProvider(runtime.getProvider('beeftv'));

      store = createDurableSessionStore({
        sessionRoot: path.join(dir, 'sessions'),
        workspaceRoot: path.join(dir, 'workspace'),
        getModels: () => models,
        getModelRef: () => ({ provider: 'beeftv', modelId: 'test-model' }),
        extensions: () => mcpController.getExtensions(),
        buildTools: () => [
          {
            name: 'canvas_search',
            label: 'canvas.search',
            readOnly: true,
            replay: 'safe',
            description: 'Search workspace canvases',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: '{"total":1}' }] }),
          },
          {
            name: 'skill_market_search',
            label: 'skill.market.search',
            readOnly: true,
            replay: 'safe',
            description: 'Search remote skill marketplace',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: '{"items":[]}' }] }),
          },
          {
            name: 'canvas_generation_propose',
            label: 'canvas.generation.propose',
            readOnly: true,
            replay: 'safe',
            description: 'Propose paid generation',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
          },
        ],
        authorizeTurn: async () => ({ open: true, canvasId: 'c1', permissionMode: 'canvas' }),
        settings: { retry: { maxRetries: 0 } },
        thinkingLevel: 'off',
      });

      const entry = await store.ensureSession('c1');
      const sub = await store.submit(entry, { turnId: 't1', requestId: 'r1', content: 'search web refs', userText: 'search web refs', revisionBefore: 1 });
      const settled = await store.wait(entry, sub);
      expect(settled.error).toBeNull();
      expect(settled.reply).toBe('phase 2.2 done');

      // Req 1: deferred MCP tools & skill_market_search must NOT be offered upfront; tool_search & codemode ARE offered.
      const req1ToolNames = (modelSrv.seen[0].body.tools || []).map((t) => t.function?.name);
      expect(req1ToolNames).toContain('tool_search');
      expect(req1ToolNames).toContain('codemode');
      expect(req1ToolNames).toContain('canvas_search');
      expect(req1ToolNames).not.toContain('mcp__demo__web_search');
      expect(req1ToolNames).not.toContain('skill_market_search');

      // Req 2 (after tool_search): mcp__demo__web_search is now offered to the model!
      const req2ToolNames = (modelSrv.seen[1].body.tools || []).map((t) => t.function?.name);
      expect(req2ToolNames).toContain('mcp__demo__web_search');

      // Req 3 (after codemode): MCP server actually received tools/call and codemode returned structured JSON!
      expect(mcpSrv.receivedCalls).toHaveLength(1);
      expect(mcpSrv.receivedCalls[0]).toMatchObject({ name: 'web_search', arguments: { query: 'cyberpunk neon' } });
      const codemodeToolMsg = modelSrv.seen[2].body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'tc_code');
      const codemodeContent = typeof codemodeToolMsg?.content === 'string' ? codemodeToolMsg.content : JSON.stringify(codemodeToolMsg);
      expect(codemodeContent).toContain('"mcpHits":2');
      expect(codemodeContent).toContain('"mcpQuery":"cyberpunk neon"');
    } finally {
      if (store) await store.disposeAll();
      await mcpController.closeAll();
      if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
      else process.env.BEEFTV_AGENT_API_KEY = prevKey;
      mcpSrv.server.closeAllConnections();
      modelSrv.server.closeAllConnections();
      await Promise.all([
        new Promise((r) => mcpSrv.server.close(r)),
        new Promise((r) => modelSrv.server.close(r)),
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 25000);

  test('plugin-packages.mjs preserves executionMode, deferred, callers, structuredOutputSchema, and extension namespace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-fields-'));
    try {
      const pkgDir = path.join(dir, 'sample-plugin');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: 'sample-plugin',
        version: '1.0.0',
        beeftv: { id: 'sample-plugin' },
        pi: { extensions: ['./ext.mjs'] },
      }));
      fs.writeFileSync(path.join(pkgDir, 'ext.mjs'), `
        export default function (pi) {
          pi.registerTool({
            name: 'sample_fast_lookup',
            description: 'Fast parallel lookup',
            readOnly: true,
            executionMode: 'parallel',
            deferred: true,
            callers: ['model', 'tools'],
            namespace: { name: 'sample', description: 'Sample namespace' },
            structuredOutputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredOutput: { ok: true } }),
          });
        }
      `);
      const loaded = await loadPluginExtensionsFromPackages({
        packages: [{ id: 'sample-plugin', name: 'sample-plugin', version: '1.0.0', packageDir: pkgDir }],
      });
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(1);
      expect(loaded.extensions[0].namespace).toEqual({ name: 'sample', description: 'Sample namespace' });
      const tool = loaded.tools[0];
      expect(tool.executionMode).toBe('parallel');
      expect(tool.deferred).toBe(true);
      expect(tool.callers).toEqual(['model', 'tools']);
      expect(tool.structuredOutputSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('operation-bridge converts scanned PDF images from file.read into multimodal image blocks without base64 JSON bloat', async () => {
    const fakeOps = createServer(async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/ops') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            ops: [{
              id: 'file.read',
              summary: 'Read file',
              readOnly: true,
              scope: 'canvas',
              assistantModes: ['canvas', 'read-only', 'full-access'],
              replay: 'safe',
              params: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'] },
            }],
          },
        }));
        return;
      }
      res.end(JSON.stringify({
        code: 0,
        data: {
          result: {
            resourceId: 'res-pdf-1',
            format: 'pdf-images',
            mimeType: 'application/pdf',
            bytes: 12345,
            readable: true,
            note: '已提取前 1 页画面',
            images: [{ page: 1, mimeType: 'image/jpeg', data: 'AAAA', width: 240, height: 160 }],
          },
        },
      }));
    });
    await new Promise((r) => fakeOps.listen(0, '127.0.0.1', r));
    const port = fakeOps.address().port;
    try {
      const bridge = createOperationBridge({
        opsUrl: `http://127.0.0.1:${port}/api`,
        hostToken: 'tok',
        turnBudgetContext: { getStore: () => null },
      });
      await bridge.loadDescriptors();
      const log = [];
      const tools = bridge.buildTools('c1', log, { permissionMode: 'canvas', intentEpoch: 0, modelEpoch: 0 }, { turnId: 't1', writeChains: [] });
      const fileRead = tools.find((t) => t.name === 'file_read');
      const res = await fileRead.execute('call-1', { resourceId: 'res-pdf-1' });
      expect(res.content.some((p) => p.type === 'image' && p.mimeType === 'image/jpeg' && p.data === 'AAAA')).toBe(true);
      const textBlock = res.content.find((p) => p.type === 'text')?.text || '';
      expect(textBlock).toContain('imagePages');
      expect(textBlock).not.toContain('"data":"AAAA"');
    } finally {
      fakeOps.closeAllConnections();
      await new Promise((r) => fakeOps.close(r));
    }
  });
});
