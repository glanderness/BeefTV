import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSafeMcpHttpUrl, buildSafeStdioEnv, createMcpServerController } from './mcp-servers.mjs';

test('buildSafeStdioEnv strips BEEFTV_AGENT_* and arbitrary process secrets', () => {
  const env = buildSafeStdioEnv(
    { CUSTOM_API_KEY: 'ok', BEEFTV_AGENT_HOST_TOKEN: 'blocked' },
    { PATH: '/usr/bin', BEEFTV_AGENT_API_KEY: 'super-secret', OPENAI_API_KEY: 'other-secret' },
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.CUSTOM_API_KEY, 'ok');
  assert.equal(env.BEEFTV_AGENT_HOST_TOKEN, undefined);
  assert.equal(env.BEEFTV_AGENT_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('assertSafeMcpHttpUrl blocks link-local metadata, IPv4-mapped IPv6, and enforces private upstream policy', async () => {
  await assert.rejects(() => assertSafeMcpHttpUrl('http://169.254.169.254/latest/meta-data'), /链路本地|禁止/);
  await assert.rejects(() => assertSafeMcpHttpUrl('http://[::ffff:169.254.169.254]/mcp'), /链路本地|禁止/);
  await assert.rejects(() => assertSafeMcpHttpUrl('https://[::ffff:0.0.0.0]/mcp'), /链路本地|未指定|禁止/);
  await assert.rejects(() => assertSafeMcpHttpUrl('https://user:pass@example.com/mcp'), /认证/);
  const prev = process.env.CANVAS_ALLOW_PRIVATE_UPSTREAMS;
  try {
    process.env.CANVAS_ALLOW_PRIVATE_UPSTREAMS = 'false';
    await assert.rejects(() => assertSafeMcpHttpUrl('http://127.0.0.1:8080/mcp'), /禁止/);
    await assert.rejects(() => assertSafeMcpHttpUrl('https://127.0.0.1:8080/mcp'), /本机或内网/);
    await assert.rejects(() => assertSafeMcpHttpUrl('https://[::ffff:127.0.0.1]/mcp'), /本机或内网/);
    await assert.rejects(() => assertSafeMcpHttpUrl('https://[::ffff:169.254.169.254]/mcp'), /链路本地|禁止/);
  } finally {
    if (prev === undefined) delete process.env.CANVAS_ALLOW_PRIVATE_UPSTREAMS;
    else process.env.CANVAS_ALLOW_PRIVATE_UPSTREAMS = prev;
  }
});

test('createMcpServerController connects real stdio MCP server, exposes deferred tools and executes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-mcp-test-'));
  const mockServerScript = path.join(dir, 'mock-mcp.mjs');
  fs.writeFileSync(mockServerScript, `
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
      instructions: 'Use mock echo for tests.',
    });
  } else if (msg.method === 'tools/list') {
    send({
      tools: [{
        name: 'echo',
        description: 'Echoes text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        annotations: { readOnlyHint: true },
      }],
    });
  } else if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text || '';
    send({
      content: [{ type: 'text', text: 'echo:' + text }],
      structuredContent: { echoed: text, hasHostSecret: Boolean(process.env.BEEFTV_AGENT_API_KEY) },
    });
  } else if (msg.method === 'resources/read') {
    send({
      contents: [{ uri: msg.params?.uri, mimeType: 'text/plain', text: 'resource-body' }],
    });
  }
});
`);

  const prevSecret = process.env.BEEFTV_AGENT_API_KEY;
  process.env.BEEFTV_AGENT_API_KEY = 'must-never-leak';
  const controller = createMcpServerController({
    dataDir: dir,
    cwd: dir,
    fetchEnabledServers: async () => ({
      fingerprint: 'fp-1',
      servers: [{
        name: 'mock',
        transport: 'stdio',
        enabled: true,
        command: process.execPath,
        args: [mockServerScript],
        timeoutSec: 15,
      }],
    }),
  });

  try {
    const synced = await controller.syncIfChanged();
    assert.equal(synced.changed, true);
    const status = controller.getStatus();
    assert.equal(status.length, 1);
    assert.equal(status[0].state, 'connected');
    assert.equal(status[0].toolCount, 1);

    const exts = controller.getExtensions();
    const mcpExt = exts.find((e) => e.name === 'beeftv.mcp.mock');
    assert.ok(mcpExt);
    assert.equal(mcpExt.tools.length, 1);
    assert.equal(mcpExt.tools[0].deferred, true);
    // Untrusted server annotations.readOnlyHint must not grant readOnly/replay-safe authority.
    assert.equal(mcpExt.tools[0].readOnly, false);
    assert.equal(mcpExt.tools[0].replay, 'unsafe');

    const callResult = await mcpExt.tools[0].execute({ text: 'hello' }, {}, {});
    assert.equal(callResult.output[0].text, 'echo:hello');
    assert.equal(callResult.structuredOutput.structuredContent.hasHostSecret, false);

    const resExt = exts.find((e) => e.name === 'beeftv.mcp.resources');
    assert.ok(resExt);
    const resOut = await resExt.tools[0].execute({ server: 'mock', uri: 'mock://doc' }, {}, {});
    assert.equal(resOut.output[0].text, 'resource-body');
  } finally {
    await controller.closeAll();
    if (prevSecret === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
    else process.env.BEEFTV_AGENT_API_KEY = prevSecret;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createMcpServerController explicit reload retries previously failed servers', async () => {
  let attempts = 0;
  const controller = createMcpServerController({
    dataDir: os.tmpdir(),
    cwd: os.tmpdir(),
    fetchEnabledServers: async () => ({
      fingerprint: 'fp-retry',
      servers: [{
        name: 'flaky',
        transport: 'http',
        enabled: true,
        url: 'http://127.0.0.1:9/mcp',
        timeoutSec: 5,
      }],
    }),
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('connect refused');
    },
  });
  try {
    await controller.syncIfChanged();
    assert.equal(attempts, 1);
    assert.equal(controller.getStatus()[0]?.state, 'error');
    await controller.reload();
    assert.equal(attempts, 2);
  } finally {
    await controller.closeAll();
  }
});
