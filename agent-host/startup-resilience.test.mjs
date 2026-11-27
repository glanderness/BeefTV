import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperationBridge } from './operation-bridge.mjs';

const AGENT_HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MJS = path.join(AGENT_HOST_DIR, 'server.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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
        res.end(JSON.stringify({
          code: 0,
          data: {
            ops: [
              { id: 'canvas.get', summary: '读取画布', readOnly: true, assistantModes: ['canvas'], params: { type: 'object', properties: {} } },
              { id: 'canvas.node.update', summary: '更新节点', readOnly: false, assistantModes: ['canvas'], params: { type: 'object', properties: {} } },
            ],
          },
        }));
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

    // Pick an ephemeral port for server.mjs.
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

    try {
      // Wait for /health while plugin & MCP sync endpoints are intentionally blocked.
      let firstHealth = null;
      const readyDeadline = Date.now() + 8000;
      while (Date.now() < readyDeadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`agent-host exited early (code=${child.exitCode}): ${childStderr}`);
        }
        try {
          const resp = await fetch(`http://127.0.0.1:${agentPort}/health`, {
            headers: { 'X-Beeftv-Instance-Nonce': nonce },
          });
          if (resp.status === 200) {
            firstHealth = await resp.json();
            break;
          }
        } catch {
          // Wait for listen.
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      const readyElapsedMs = Date.now() - startedAt;
      expect(firstHealth).not.toBeNull();
      expect(firstHealth.ok).toBe(true);
      expect(firstHealth.instance).toBe(crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16));
      // Must become ready while slow plugin/MCP sync is STILL held open.
      expect(readyElapsedMs).toBeLessThan(8000);

      // Release slow plugin/MCP sync so GET /tools can complete and verify lazy descriptor reload.
      releaseSlowSync();
      const toolsResp = await fetch(`http://127.0.0.1:${agentPort}/tools`, {
        headers: {
          'X-Beeftv-Agent-Token': hostToken,
          'X-Beeftv-Instance-Nonce': nonce,
        },
      });
      expect(toolsResp.status).toBe(200);
      const toolsBody = await toolsResp.json();
      expect(toolsBody.known).toContain('canvas_get');
      expect(toolsBody.known).toContain('canvas_node_update');
      expect(opsCalls).toBeGreaterThanOrEqual(2);

      const secondHealthResp = await fetch(`http://127.0.0.1:${agentPort}/health`, {
        headers: { 'X-Beeftv-Instance-Nonce': nonce },
      });
      const secondHealth = await secondHealthResp.json();
      expect(secondHealth.operations).toBe(2);
    } finally {
      releaseSlowSync?.();
      for (const res of heldResponses) {
        if (!res.writableEnded) res.destroy();
      }
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3000))]);
      await closeServer(opsServer);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
