import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '@earendil-works/pi-mcp';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { FAILURE_BACKOFF_MS, TOOL_CALL_TIMEOUT_MS, buildStdioEnv, createMcpToolSource, defaultConnect, normalizeMcpServer, uniqueToolName } from './mcp-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// 最小 MCP 服务器：在内存管道的 server 端应答 initialize / tools/list / tools/call。
async function fakeConnect({ tools = [], onCall = async () => ({ content: [{ type: 'text', text: 'ok' }] }), onClose } = {}) {
  return async (server) => {
    const pair = createInMemoryTransportPair();
    pair.server.onMessage(async (message) => {
      if (message.id === undefined || !message.method) return;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: server.name, version: '1' } };
      else if (message.method === 'tools/list') result = { tools };
      else if (message.method === 'tools/call') result = await onCall(message.params, server);
      else result = {};
      await pair.server.send({ jsonrpc: '2.0', id: message.id, result });
    });
    await pair.server.start();
    const client = new McpClient({ name: 'test', version: '1' });
    await client.connect(pair.client);
    if (onClose) {
      const close = client.close.bind(client);
      client.close = async () => { onClose(server); await close(); };
    }
    return client;
  };
}

const httpServer = (overrides = {}) => ({ id: 'a', name: 'Alpha', transport: 'http', url: 'https://mcp.example.test/mcp', ...overrides });

describe('normalizeMcpServer', () => {
  test('keeps valid stdio and http servers, drops incomplete or unsupported ones', () => {
    expect(normalizeMcpServer({ id: 's', name: 'S', transport: 'stdio', command: 'node', args: ['x.js'] })).toMatchObject({ command: 'node', args: ['x.js'], enabled: true });
    expect(normalizeMcpServer(httpServer())).toMatchObject({ url: 'https://mcp.example.test/mcp' });
    expect(normalizeMcpServer({ id: 's', transport: 'stdio' })).toBeNull();
    expect(normalizeMcpServer(httpServer({ url: 'file:///etc/passwd' }))).toBeNull();
    expect(normalizeMcpServer(httpServer({ url: 'not a url' }))).toBeNull();
    expect(normalizeMcpServer({ transport: 'stdio', command: 'node' })).toBeNull();
    expect(normalizeMcpServer(httpServer({ transport: 'websocket' }))).toBeNull();
  });
});

describe('buildStdioEnv', () => {
  test('keeps only the allowlist plus the server own variables, never host tokens', () => {
    const hostEnv = {
      PATH: '/usr/bin', HOME: '/home/u', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      BEEFTV_DESKTOP_TOKEN: 'desk', CANVAS_DESKTOP_LAUNCH_TOKEN: 'launch',
      AGENT_HOST_TOKEN: 'host', SOME_API_TOKEN: 'api', OPENAI_API_KEY: 'key',
    };
    const env = buildStdioEnv([{ name: 'MCP_REGION', value: 'cn' }], hostEnv, { platform: 'win32', home: '/home/u', execPath: '/usr/bin/node', delimiter: ';', exists: () => true });
    expect(Object.keys(env).sort()).toEqual(['ComSpec', 'HOME', 'MCP_REGION', 'PATH', 'PATHEXT']);
    expect(Object.keys(env).some((name) => /TOKEN|KEY/i.test(name))).toBe(false);
  });

  test('augments PATH with the node dir and existing package manager dirs, deduped', () => {
    const env = buildStdioEnv([], { PATH: '/usr/bin:/usr/bin:/opt/homebrew/bin' },
      { platform: 'linux', home: '/home/u', execPath: '/usr/bin/node', delimiter: ':', exists: (dir) => dir !== '/usr/local/bin' });
    expect(env.PATH).toBe('/usr/bin:/opt/homebrew/bin:/home/u/.local/bin:/home/u/.bun/bin:/home/u/.volta/bin:/home/u/.cargo/bin');
  });

  test('a server-configured PATH wins and is not augmented', () => {
    const env = buildStdioEnv([{ name: 'PATH', value: '/custom/bin' }], { PATH: '/usr/bin' },
      { platform: 'linux', home: '/home/u', execPath: '/usr/bin/node', delimiter: ':', exists: () => true });
    expect(env.PATH).toBe('/custom/bin');
  });
});

describe('uniqueToolName', () => {
  test('uses only provider-safe characters, caps at 64, and suffixes collisions', () => {
    const used = new Set();
    const first = uniqueToolName('Notes Server!', 'search.docs/v2', used);
    const second = uniqueToolName('Notes Server!', 'search.docs/v2', used);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(second).not.toBe(first);
    expect(second).toMatch(/_2$/);
    const long = uniqueToolName('a'.repeat(100), 'b'.repeat(100), new Set());
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('createMcpToolSource.tools', () => {
  const tools = [
    { name: 'search', title: '搜索', description: 'Search notes', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'delete_note', inputSchema: {}, annotations: { destructiveHint: true } },
    { name: 'hidden', inputSchema: {} },
  ];

  test('exposes all enabled tools in canvas mode and only read-only ones in read-only mode', async () => {
    const source = createMcpToolSource({ loadServers: async () => [httpServer()], connect: await fakeConnect({ tools }) });
    const canvas = await source.tools({ permissionMode: 'canvas' });
    expect(canvas.map((tool) => tool.toolName)).toEqual(['search', 'delete_note', 'hidden']);
    const readOnly = await source.tools({ permissionMode: 'read-only' });
    expect(readOnly.map((tool) => tool.toolName)).toEqual(['search']);
    expect(readOnly[0]).toMatchObject({ readOnly: true, serverId: 'a', label: 'Alpha · 搜索', description: '[Alpha] Search notes' });
    expect(readOnly[0].parameters).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } });
    await source.close();
  });

  test('omits disabled tools and skips disabled servers', async () => {
    const connect = await fakeConnect({ tools });
    const source = createMcpToolSource({
      loadServers: async () => [httpServer({ disabledTools: ['hidden'] }), httpServer({ id: 'b', name: 'Off', enabled: false })],
      connect,
    });
    const names = (await source.tools()).map((tool) => tool.toolName);
    expect(names).toEqual(['search', 'delete_note']);
    await source.close();
  });

  test('execute maps the MCP result, including tool-reported errors', async () => {
    const source = createMcpToolSource({
      loadServers: async () => [httpServer()],
      connect: await fakeConnect({
        tools: [{ name: 'run', inputSchema: {} }],
        onCall: async (params) => ({ content: [{ type: 'text', text: `got ${params.arguments.x}` }], isError: params.arguments.x === 'bad' }),
      }),
    });
    const [tool] = await source.tools();
    expect(await tool.execute('call-1', { x: 'ok' })).toEqual({ content: [{ type: 'text', text: 'got ok' }], details: undefined, isError: false });
    expect(await tool.execute('call-2', { x: 'bad' })).toMatchObject({ isError: true });
    await source.close();
  });

  test('tool calls get the long call timeout, not the short connect one', async () => {
    let received;
    const source = createMcpToolSource({
      loadServers: async () => [httpServer()],
      connect: async () => ({
        listTools: async () => [{ name: 'slow', inputSchema: {} }],
        callTool: async (name, args, options) => { received = { name, args, options }; return { content: [{ type: 'text', text: 'done' }] }; },
        close: async () => {},
      }),
    });
    const [tool] = await source.tools();
    const result = await tool.execute('call-1', { x: 1 }, undefined);
    expect(received.name).toBe('slow');
    expect(received.args).toEqual({ x: 1 });
    expect(received.options.timeoutMs).toBe(TOOL_CALL_TIMEOUT_MS);
    expect(TOOL_CALL_TIMEOUT_MS).toBe(600_000);
    expect(result).toMatchObject({ isError: false });
    await source.close();
  });

  test('a failing server is skipped with its status, and the other servers still load', async () => {
    const good = await fakeConnect({ tools: [{ name: 'ping', inputSchema: {} }] });
    const source = createMcpToolSource({
      loadServers: async () => [httpServer({ id: 'bad', name: 'Broken' }), httpServer({ id: 'good', name: 'Good' })],
      connect: async (server) => {
        if (server.id === 'bad') throw Object.assign(new Error('boom'), { reason: 'mcp_connect_failed' });
        return good(server);
      },
    });
    const tools = await source.tools();
    expect(tools.map((tool) => tool.serverId)).toEqual(['good']);
    expect(source.status().bad).toMatchObject({ ok: false, error: '无法连接，请检查命令或地址是否正确' });
    expect(source.status().good).toMatchObject({ ok: true, toolCount: 1 });
    await source.close();
  });

  test('connects servers in parallel and keeps tool names in server order', async () => {
    let started = 0;
    let resolved = 0;
    let firstResolvedStarted = null;
    let releaseAll;
    const gate = new Promise((resolve) => { releaseAll = resolve; });
    const client = { listTools: async () => [{ name: 't', inputSchema: {} }], callTool: async () => ({ content: [] }), close: async () => {} };
    const source = createMcpToolSource({
      loadServers: async () => [httpServer({ id: 'a', name: 'Alpha' }), httpServer({ id: 'b', name: 'Beta' })],
      connect: async () => {
        started += 1;
        if (started === 2) releaseAll();
        let timer;
        await Promise.race([gate, new Promise((resolve) => { timer = setTimeout(resolve, 500); })]);
        clearTimeout(timer);
        resolved += 1;
        if (resolved === 1) firstResolvedStarted = started;
        return client;
      },
    });
    const listed = await source.tools();
    expect(firstResolvedStarted).toBe(2);
    expect(listed.map((tool) => tool.name)).toEqual(['mcp__Alpha__t', 'mcp__Beta__t']);
    await source.close();
  });

  test('reconnects when the config fingerprint changes and closes connections for removed servers', async () => {
    const opened = [];
    const closed = [];
    const connect = await fakeConnect({ tools: [{ name: 't', inputSchema: {} }], onClose: (server) => closed.push(server.url) });
    let servers = [httpServer()];
    const source = createMcpToolSource({
      loadServers: async () => servers,
      connect: async (server) => { opened.push(server.url); return connect(server); },
    });
    await source.tools();
    await source.tools();
    expect(opened).toEqual(['https://mcp.example.test/mcp']);
    servers = [httpServer({ url: 'https://mcp.example.test/v2' })];
    await source.tools();
    expect(opened).toEqual(['https://mcp.example.test/mcp', 'https://mcp.example.test/v2']);
    expect(closed).toEqual(['https://mcp.example.test/mcp']);
    servers = [];
    await source.tools();
    expect(closed).toEqual(['https://mcp.example.test/mcp', 'https://mcp.example.test/v2']);
    await source.close();
  });

  test('skips reconnecting a failed server inside the backoff window and retries after it', async () => {
    let clock = 1_000_000;
    let attempts = 0;
    let servers = [httpServer({ id: 'bad', name: 'Broken' })];
    const source = createMcpToolSource({
      loadServers: async () => servers,
      connect: async () => { attempts += 1; throw Object.assign(new Error('boom'), { reason: 'mcp_connect_failed' }); },
      now: () => clock,
    });
    await source.tools();
    expect(attempts).toBe(1);
    expect(source.status().bad).toMatchObject({ ok: false, error: '无法连接，请检查命令或地址是否正确' });

    clock += FAILURE_BACKOFF_MS - 1;
    await source.tools();
    expect(attempts).toBe(1);
    expect(source.status().bad).toMatchObject({ ok: false, error: '无法连接，请检查命令或地址是否正确' });

    clock += 1;
    await source.tools();
    expect(attempts).toBe(2);

    // 配置改变后立即重试，不受退避窗口限制。
    clock += 1;
    servers = [httpServer({ id: 'bad', name: 'Broken', url: 'https://mcp.example.test/v2' })];
    await source.tools();
    expect(attempts).toBe(3);
    await source.close();
  });

  test('drops a dead cached connection and reconnects on the next assembly', async () => {
    let opens = 0;
    const pairs = [];
    const source = createMcpToolSource({
      loadServers: async () => [httpServer()],
      connect: async () => {
        opens += 1;
        const pair = createInMemoryTransportPair();
        pairs.push(pair);
        pair.server.onMessage(async (message) => {
          if (message.id === undefined || !message.method) return;
          const result = message.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } }
            : message.method === 'tools/list' ? { tools: [{ name: 't', inputSchema: {} }] } : {};
          await pair.server.send({ jsonrpc: '2.0', id: message.id, result });
        });
        await pair.server.start();
        const client = new McpClient({ name: 'test', version: '1' });
        await client.connect(pair.client);
        return client;
      },
    });
    await source.tools();
    expect(opens).toBe(1);
    await pairs[0].server.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await source.tools();
    expect(opens).toBe(2);
    await source.close();
  });

  test('probe lists tools with read-only flags and preserves specific failure reasons', async () => {
    const source = createMcpToolSource({ loadServers: async () => [], connect: await fakeConnect({ tools: [{ name: 'a', title: 'A', inputSchema: {}, annotations: { readOnlyHint: true } }] }) });
    expect(await source.probe(httpServer({ enabled: false }))).toEqual({ tools: [{ name: 'a', title: 'A', description: '', readOnly: true }] });
    await expect(source.probe({ id: 'x', transport: 'stdio' })).rejects.toMatchObject({ reason: 'mcp_server_invalid' });

    const failing = (error) => createMcpToolSource({ loadServers: async () => [], connect: async () => { throw error; } });
    await expect(failing(Object.assign(new Error('t'), { reason: 'mcp_connect_timeout' })).probe(httpServer())).rejects.toMatchObject({ reason: 'mcp_connect_timeout' });
    await expect(failing(Object.assign(new Error('c'), { reason: 'mcp_connect_failed' })).probe(httpServer())).rejects.toMatchObject({ reason: 'mcp_connect_failed' });
    await expect(failing(new Error('plain')).probe(httpServer())).rejects.toMatchObject({ reason: 'mcp_connect_failed' });

    const listFailure = createMcpToolSource({ loadServers: async () => [], connect: async () => ({ listTools: async () => { throw new Error('list boom'); }, close: async () => {} }) });
    await expect(listFailure.probe(httpServer())).rejects.toMatchObject({ reason: 'mcp_list_failed' });
  });
});

describe('real stdio transport', () => {
  test('lists and calls tools over a child process without leaking host tokens', async () => {
    const fixture = path.join(here, 'test-support', 'mcp-stdio-fixture.mjs');
    const previous = process.env.BEEFTV_TEST_HOST_TOKEN;
    process.env.BEEFTV_TEST_HOST_TOKEN = 'must-not-leak';
    const source = createMcpToolSource({
      loadServers: async () => [{ id: 'fx', name: 'Fixture', transport: 'stdio', command: process.execPath, args: [fixture], env: [{ name: 'FIXTURE_MARK', value: 'yes' }] }],
      connect: defaultConnect,
    });
    try {
      const tools = await source.tools({ permissionMode: 'read-only' });
      expect(tools.map((tool) => tool.toolName)).toEqual(['echo']);
      const result = await tools[0].execute('call-1', { text: 'hi' });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.args).toEqual({ text: 'hi' });
      expect(payload.visible).toContain('FIXTURE_MARK');
      expect(payload.visible).not.toContain('BEEFTV_TEST_HOST_TOKEN');
    } finally {
      await source.close();
      if (previous === undefined) delete process.env.BEEFTV_TEST_HOST_TOKEN; else process.env.BEEFTV_TEST_HOST_TOKEN = previous;
    }
  });
});
