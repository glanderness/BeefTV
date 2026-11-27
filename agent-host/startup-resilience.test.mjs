import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { createOperationBridge } from './operation-bridge.mjs';

const AGENT_HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MJS = path.join(AGENT_HOST_DIR, 'server.mjs');
const SAMPLE_OPS = [
  { id: 'canvas.get', summary: '读取画布', readOnly: true, assistantModes: ['read-only', 'canvas', 'full-access'], params: { type: 'object', properties: {} } },
  { id: 'canvas.node.update', summary: '更新节点', readOnly: false, assistantModes: ['canvas', 'full-access'], params: { type: 'object', properties: {} } },
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startTestAgentHost(opsPort) {
  const probe = http.createServer();
  const agentPort = await listen(probe);
  await closeServer(probe);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btv-startup-resilience-'));
  const hostToken = 'resilience-host-token';
  const nonce = 'resilience-nonce-123';
  let childStderr = '';
  const startedAt = Date.now();
  const child = spawn('node', [SERVER_MJS], {
    env: {
      ...process.env,
      BEEFTV_AGENT_DATA_DIR: dataDir,
      BEEFTV_AGENT_HOST_TOKEN: hostToken,
      BEEFTV_AGENT_INSTANCE_NONCE: nonce,
      BEEFTV_AGENT_PORT: String(agentPort),
      BEEFTV_AGENT_PIPE: '',
      BEEFTV_AGENT_LISTEN_FD: '',
      BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`,
      BEEFTV_OPS_PIPE: '',
      BEEFTV_AGENT_MODEL: 'deepseek-chat',
      BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_BASE_URL: 'http://127.0.0.1:1/v1',
      BEEFTV_AGENT_API_KEY: 'sk-test-startup',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { childStderr += chunk.toString('utf8'); });
  const exitPromise = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });

  const authHeaders = {
    'X-Beeftv-Agent-Token': hostToken,
    'X-Beeftv-Instance-Nonce': nonce,
  };
  const baseUrl = `http://127.0.0.1:${agentPort}`;

  async function waitForHealth(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`agent-host exited early (code=${child.exitCode}): ${childStderr}`);
      }
      try {
        const resp = await fetch(`${baseUrl}/health`, {
          headers: { 'X-Beeftv-Instance-Nonce': nonce },
        });
        if (resp.status === 200) {
          return { health: await resp.json(), elapsedMs: Date.now() - startedAt };
        }
      } catch {
        // Wait for listen.
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`agent-host did not become healthy within ${timeoutMs}ms: ${childStderr}`);
  }

  async function stop() {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3000))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { baseUrl, authHeaders, nonce, dataDir, waitForHealth, stop };
}

function writeTestPluginPackage(baseDir, dirName, toolName) {
  const pkgDir = path.join(baseDir, dirName);
  fs.mkdirSync(path.join(pkgDir, 'extensions'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: `@beeftv-plugin/${dirName}`,
      version: '1.0.0',
      type: 'module',
      keywords: ['beeftv-plugin', 'pi-package'],
      pi: { extensions: ['./extensions/index.js'] },
    }),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'extensions', 'index.js'),
    `export default function (pi) {
      pi.registerTool({
        name: ${JSON.stringify(toolName)},
        description: 'Concurrent startup resilience test tool',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: ${JSON.stringify(toolName)} }] }; }
      });
    }`,
  );
  return pkgDir;
}

function writeMockStdioMcpServer(baseDir) {
  const scriptPath = path.join(baseDir, 'mock-mcp.mjs');
  fs.writeFileSync(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const send = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: res }) + '\\n');
  if (msg.method === 'initialize') {
    send({
      protocolVersion: msg.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    send({
      tools: [{
        name: 'echo',
        description: 'Echoes text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      }],
    });
  } else if (msg.method === 'tools/call') {
    send({ content: [{ type: 'text', text: 'echo' }] });
  }
});
`);
  return scriptPath;
}

describe('agent-host startup resilience and lazy descriptor recovery', () => {
  test('ensureDescriptorsLoaded retries after initial failure and deduplicates concurrent loads', async () => {
    let opsCalls = 0;
    const opsServer = http.createServer((req, res) => {
      if (req.url === '/api/ops') {
        opsCalls += 1;
        if (opsCalls === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 503, reason: 'temporarily_unavailable', msg: 'warming up' }));
          return;
        }
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            data: {
              ops: [{ id: 'canvas.get', summary: '读取画布', readOnly: true, assistantModes: ['canvas'], params: { type: 'object', properties: {} } }],
            },
          }));
        }, 20);
        return;
      }
      res.writeHead(404).end();
    });
    const opsPort = await listen(opsServer);
    try {
      const bridge = createOperationBridge({
        opsUrl: `http://127.0.0.1:${opsPort}/api`,
        hostToken: 'tok-1',
        turnBudgetContext: new AsyncLocalStorage(),
      });
      await expect(bridge.ensureDescriptorsLoaded()).rejects.toThrow('temporarily_unavailable');
      expect(bridge.descriptors.size).toBe(0);

      const [first, second] = await Promise.all([
        bridge.ensureDescriptorsLoaded(),
        bridge.ensureDescriptorsLoaded(),
      ]);
      expect(first).toBe(1);
      expect(second).toBe(1);
      expect(opsCalls).toBe(2);
      expect(bridge.descriptors.has('canvas_get')).toBe(true);

      // Once loaded, subsequent calls return cached count without issuing another request.
      expect(await bridge.ensureDescriptorsLoaded()).toBe(1);
      expect(opsCalls).toBe(2);
    } finally {
      await closeServer(opsServer);
    }
  });

  test('server.mjs starts listening without waiting on slow MCP/plugin sync and lazily reloads empty descriptors', async () => {
    let opsCalls = 0;
    let releaseSlowSync = null;
    const heldResponses = [];
    const slowSyncGate = new Promise((resolve) => {
      releaseSlowSync = resolve;
    });

    const opsServer = http.createServer((req, res) => {
      if (req.url === '/api/ops') {
        opsCalls += 1;
        if (opsCalls === 1) {
          // Simulate initial startup ops discovery failing transiently.
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 503, reason: 'starting', msg: 'ops not ready' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { ops: SAMPLE_OPS } }));
        return;
      }
      if (req.url === '/api/plugins/packages/enabled' || req.url === '/api/assistant/runtime/mcp-servers') {
        heldResponses.push(res);
        void slowSyncGate.then(() => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            data: req.url.includes('mcp-servers') ? { fingerprint: 'empty', servers: [] } : { packages: [] },
          }));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: {} }));
    });
    const opsPort = await listen(opsServer);
    const host = await startTestAgentHost(opsPort);

    try {
      // Wait for /health while plugin & MCP sync endpoints are intentionally blocked.
      const { health: firstHealth, elapsedMs: readyElapsedMs } = await host.waitForHealth(8000);
      expect(firstHealth.ok).toBe(true);
      expect(firstHealth.instance).toBe(crypto.createHash('sha256').update(host.nonce).digest('hex').slice(0, 16));
      // Must become ready while slow plugin/MCP sync is STILL held open.
      expect(readyElapsedMs).toBeLessThan(8000);

      // Release slow plugin/MCP sync so GET /tools can complete and verify lazy descriptor reload.
      releaseSlowSync();
      const toolsResp = await fetch(`${host.baseUrl}/tools`, { headers: host.authHeaders });
      expect(toolsResp.status).toBe(200);
      const toolsBody = await toolsResp.json();
      expect(toolsBody.known).toContain('canvas_get');
      expect(toolsBody.known).toContain('canvas_node_update');
      expect(opsCalls).toBeGreaterThanOrEqual(2);

      const secondHealthResp = await fetch(`${host.baseUrl}/health`, {
        headers: { 'X-Beeftv-Instance-Nonce': host.nonce },
      });
      const secondHealth = await secondHealthResp.json();
      expect(secondHealth.operations).toBe(2);
    } finally {
      releaseSlowSync?.();
      for (const res of heldResponses) {
        if (!res.writableEnded) res.destroy();
      }
      await host.stop();
      await closeServer(opsServer);
    }
  });

  test('mounted Durable session receives recovered canvas ops tools after empty-descriptor startup', async () => {
    let opsReady = false;
    const opsServer = http.createServer((req, res) => {
      if (req.url === '/api/ops') {
        if (!opsReady) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 503, reason: 'starting', msg: 'ops warming up' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { ops: SAMPLE_OPS } }));
        return;
      }
      if (req.url === '/api/plugins/packages/enabled') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { packages: [] } }));
        return;
      }
      if (req.url === '/api/assistant/runtime/mcp-servers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { fingerprint: 'empty', servers: [] } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: {} }));
    });
    const opsPort = await listen(opsServer);
    const host = await startTestAgentHost(opsPort);

    try {
      const { health } = await host.waitForHealth(8000);
      expect(health.operations).toBe(0);

      // Mount a Durable session while ops descriptors are still empty.
      const createResp = await fetch(`${host.baseUrl}/sessions`, {
        method: 'POST',
        headers: { ...host.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: 'canvas-late-ops' }),
      });
      expect(createResp.status).toBe(200);
      const historyResp = await fetch(`${host.baseUrl}/history?canvasId=canvas-late-ops`, {
        headers: host.authHeaders,
      });
      expect(historyResp.status).toBe(200);

      // Confirm the mounted session currently has no canvas ops tools.
      const beforeToolsResp = await fetch(`${host.baseUrl}/tools?canvasId=canvas-late-ops`, {
        headers: host.authHeaders,
      });
      expect(beforeToolsResp.status).toBe(200);
      const beforeTools = await beforeToolsResp.json();
      expect(beforeTools.activeTools).toContain('plan_update');
      expect(beforeTools.activeTools).not.toContain('canvas_get');
      expect(beforeTools.activeTools).not.toContain('canvas_node_update');

      // Now allow /api/ops to recover; the ALREADY-MOUNTED session must gain canvas ops tools.
      opsReady = true;
      const afterToolsResp = await fetch(`${host.baseUrl}/tools?canvasId=canvas-late-ops`, {
        headers: host.authHeaders,
      });
      expect(afterToolsResp.status).toBe(200);
      const afterTools = await afterToolsResp.json();
      expect(afterTools.activeTools).toContain('canvas_get');
      expect(afterTools.activeTools).toContain('canvas_node_update');
      expect(afterTools.known).toContain('canvas_get');
      expect(afterTools.known).toContain('canvas_node_update');

      const afterHealth = await (await fetch(`${host.baseUrl}/health`, {
        headers: { 'X-Beeftv-Instance-Nonce': host.nonce },
      })).json();
      expect(afterHealth.operations).toBe(2);
      expect(afterHealth.sessions).toBe(1);
    } finally {
      await host.stop();
      await closeServer(opsServer);
    }
  });

  test('durable session dynamically picks up newly loaded host tools even when permissionMode is unchanged', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'btv-durable-late-tools-'));
    const dynamicOps = [];
    const store = createDurableSessionStore({
      sessionRoot: path.join(tmp, 'sessions'),
      workspaceRoot: path.join(tmp, 'workspace'),
      getModels: () => createModels(),
      getModelRef: () => ({ provider: 'beeftv', modelId: 'deepseek-chat' }),
      authorizeTurn: async ({ canvasId, turnId }) => ({ open: true, canvasId, turnId, permissionMode: 'canvas' }),
      buildTools: (_canvasId, _log, generation) => {
        const mode = generation.permissionMode || 'canvas';
        return dynamicOps
          .filter((op) => op.assistantModes.includes(mode))
          .map((op) => ({
            name: op.id.replace(/\./g, '_'),
            label: op.id,
            readOnly: op.readOnly,
            replay: op.readOnly ? 'safe' : 'unsafe',
            description: op.summary,
            parameters: op.params,
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          }));
      },
    });
    try {
      const entry = await store.createSession('canvas-same-mode');
      await entry.configurePermission('canvas');
      entry.permissionMode = 'canvas';
      expect(entry.toolNames).not.toContain('canvas_get');
      expect(entry.readOnlyToolNames.has('canvas_get')).toBe(false);

      // Populate ops descriptors later while permissionMode stays 'canvas'.
      dynamicOps.push(...SAMPLE_OPS);
      expect(entry.hasHostToolsDrift('canvas')).toBe(true);
      await store.refreshHostTools();

      expect(entry.toolNames).toContain('canvas_get');
      expect(entry.toolNames).toContain('canvas_node_update');
      expect(entry.readOnlyToolNames.has('canvas_get')).toBe(true);
      expect(entry.readOnlyToolNames.has('canvas_node_update')).toBe(false);
      const agent = await entry.root.agent(BACKGROUND_CONTEXT);
      const configuredNames = (agent.tools || []).map((t) => t.name);
      expect(configuredNames).toContain('canvas_get');
      expect(configuredNames).toContain('canvas_node_update');
    } finally {
      await store.disposeAll();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('concurrent plugin and MCP sync preserves both extension toolsets on mounted sessions', async () => {
    const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btv-concurrent-ext-'));
    const pluginV1Dir = writeTestPluginPackage(fixturesDir, 'concurrent-v1', 'concurrent_plugin_ping');
    const pluginV2Dir = writeTestPluginPackage(fixturesDir, 'concurrent-v2', 'concurrent_plugin_v2');
    const mockMcpScript = writeMockStdioMcpServer(fixturesDir);

    let enabledPackages = [{ id: 'concurrent-plugin', packageDir: pluginV1Dir }];
    let releasePlugin = null;
    let releaseMcp = null;
    const heldResponses = [];
    const pluginGate = new Promise((resolve) => { releasePlugin = resolve; });
    const mcpGate = new Promise((resolve) => { releaseMcp = resolve; });
    let pluginCalls = 0;
    let mcpCalls = 0;

    const opsServer = http.createServer((req, res) => {
      if (req.url === '/api/ops') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { ops: SAMPLE_OPS } }));
        return;
      }
      if (req.url === '/api/plugins/packages/enabled') {
        pluginCalls += 1;
        const respondPlugins = () => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: { packages: enabledPackages } }));
        };
        if (pluginCalls === 1) {
          heldResponses.push(res);
          void pluginGate.then(respondPlugins);
          return;
        }
        respondPlugins();
        return;
      }
      if (req.url === '/api/assistant/runtime/mcp-servers') {
        mcpCalls += 1;
        const respondMcp = () => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            data: {
              fingerprint: 'mcp-mock-1',
              servers: [{
                name: 'mock',
                transport: 'stdio',
                enabled: true,
                command: process.execPath,
                args: [mockMcpScript],
                timeoutSec: 15,
              }],
            },
          }));
        };
        if (mcpCalls === 1) {
          heldResponses.push(res);
          void mcpGate.then(respondMcp);
          return;
        }
        respondMcp();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: {} }));
    });
    const opsPort = await listen(opsServer);
    const host = await startTestAgentHost(opsPort);

    try {
      await host.waitForHealth(8000);
      // Mount a Durable session BEFORE plugin and MCP startup syncs finish.
      const createResp = await fetch(`${host.baseUrl}/sessions`, {
        method: 'POST',
        headers: { ...host.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: 'canvas-concurrent-ext' }),
      });
      expect(createResp.status).toBe(200);

      // Release plugin and MCP sync concurrently (staggered slightly so reload calls overlap).
      releasePlugin();
      setTimeout(() => releaseMcp(), 15);

      const toolsResp = await fetch(`${host.baseUrl}/tools?canvasId=canvas-concurrent-ext`, {
        headers: host.authHeaders,
      });
      expect(toolsResp.status).toBe(200);
      const toolsBody = await toolsResp.json();
      expect(toolsBody.activeTools).toContain('canvas_get');
      expect(toolsBody.activeTools).toContain('concurrent_plugin_ping');
      expect(toolsBody.activeTools).toContain('mcp__mock__echo');
      expect(toolsBody.activeTools).toContain('read_mcp_resource');
      expect(toolsBody.known).toContain('concurrent_plugin_ping');
      expect(toolsBody.known).toContain('mcp__mock__echo');

      // Also verify concurrent explicit reloads keep both plugin and MCP extensions intact.
      enabledPackages = [{ id: 'concurrent-plugin', packageDir: pluginV2Dir }];
      const [pluginReload, mcpReload] = await Promise.all([
        fetch(`${host.baseUrl}/plugins/reload`, {
          method: 'POST',
          headers: { ...host.authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        fetch(`${host.baseUrl}/mcp-servers/reload`, {
          method: 'POST',
          headers: { ...host.authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
      ]);
      expect(pluginReload.status).toBe(200);
      expect(mcpReload.status).toBe(200);

      const reloadedTools = await (await fetch(`${host.baseUrl}/tools?canvasId=canvas-concurrent-ext`, {
        headers: host.authHeaders,
      })).json();
      expect(reloadedTools.activeTools).toContain('canvas_get');
      expect(reloadedTools.activeTools).toContain('concurrent_plugin_v2');
      expect(reloadedTools.activeTools).toContain('mcp__mock__echo');
    } finally {
      releasePlugin?.();
      releaseMcp?.();
      for (const res of heldResponses) {
        if (!res.writableEnded) res.destroy();
      }
      await host.stop();
      await closeServer(opsServer);
      fs.rmSync(fixturesDir, { recursive: true, force: true });
    }
  });
});
