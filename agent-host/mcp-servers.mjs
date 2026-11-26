// BeefTV 内置助手外部 MCP 宿主管理器：直接复用官方 @earendil-works/pi-mcp 与 pi-durable 扩展机制。
// 所有外部 MCP 工具默认 deferred: true（按需经 tool_search 或 codemode 发现，零默认提示词膨胀）；
// Stdio 子进程使用白名单环境变量，严禁泄露 BeefTV 宿主 Token 或模型密钥；
// Streamable HTTP 连接阶段二次校验 DNS/IP SSRF 并禁止重定向。
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  createMcpToolName,
  limitMcpContent,
  mcpNamespace,
  mcpServerSummary,
  normalizeMcpInputSchema,
  toLlmContent,
} from '@earendil-works/pi-mcp';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_FILES = 64;

const SAFE_STDIO_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SystemRoot', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

const CONTENT_BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    type: { enum: ['text', 'image', 'audio', 'resource_link', 'resource'] },
    text: { type: 'string' },
    data: { type: 'string' },
    mimeType: { type: 'string' },
  },
  required: ['type'],
  additionalProperties: true,
};

function createMcpResultSchema(structuredContentSchema) {
  return {
    type: 'object',
    properties: {
      content: { type: 'array', items: CONTENT_BLOCK_SCHEMA },
      structuredContent: structuredContentSchema && typeof structuredContentSchema === 'object' ? structuredContentSchema : {},
      isError: { type: 'boolean' },
    },
    required: ['content'],
    additionalProperties: true,
  };
}

function expandHome(value) {
  const str = String(value || '');
  if (str === '~') return os.homedir();
  if (str.startsWith('~/') || (process.platform === 'win32' && str.startsWith('~\\'))) {
    return path.join(os.homedir(), str.slice(2));
  }
  return str;
}

export function buildSafeStdioEnv(userEnv = {}, baseEnv = process.env) {
  const env = {};
  for (const key of SAFE_STDIO_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key].length > 0) {
      env[key] = baseEnv[key];
    }
  }
  for (const [k, v] of Object.entries(userEnv || {})) {
    const key = String(k || '').trim();
    if (!key || /^BEEFTV_AGENT_/i.test(key)) continue;
    env[key] = String(v ?? '');
  }
  return env;
}

function allowPrivateUpstreams() {
  const raw = String(process.env.CANVAS_ALLOW_PRIVATE_UPSTREAMS || '').trim().toLowerCase();
  return !['0', 'false', 'no'].includes(raw);
}

function isAllowedPrivateHost(host) {
  const normalized = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return false;
  return String(process.env.CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
    .includes(normalized);
}

function ipv4Parts(ip) {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

// Handles IPv4 literals as well as IPv4-mapped IPv6 in both dotted-quad
// (::ffff:169.254.169.254) and Node URL-canonicalized hex (::ffff:a9fe:a9fe,
// 0:0:0:0:0:ffff:a9fe:a9fe) forms.
function extractIPv4Parts(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  const direct = ipv4Parts(ip);
  if (direct) return direct;
  const mappedPrefix = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)(.+)$/i.exec(ip);
  if (!mappedPrefix) return null;
  const tail = mappedPrefix[1];
  const tailV4 = ipv4Parts(tail);
  if (tailV4) return tailV4;
  const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hexPair) return null;
  const hi = parseInt(hexPair[1], 16);
  const lo = parseInt(hexPair[2], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isBlockedLinkLocalOrSpecialIP(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  const v4 = extractIPv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  if (ip === '::' || /^(?:0{1,4}:){7}0{1,4}$/.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  if (ip.startsWith('ff')) return true;
  return false;
}

function isPrivateOrLoopbackIP(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  const v4 = extractIPv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (ip === '::1' || /^(?:0{1,4}:){7}0{0,3}1$/.test(ip)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

export async function assertSafeMcpHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('MCP 服务地址无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP 地址只支持 http/https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP 地址不允许内嵌认证信息');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const allowPrivate = allowPrivateUpstreams() || isAllowedPrivateHost(hostname);
  if (parsed.protocol === 'http:' && !allowPrivate) {
    throw new Error('当前环境禁止访问非 HTTPS 外部 MCP 地址');
  }
  if (!allowPrivate && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new Error('当前环境禁止访问本机 MCP 地址');
  }
  const ipKind = net.isIP(hostname);
  const ips = ipKind > 0
    ? [hostname]
    : (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
  if (ips.length === 0) {
    throw new Error('无法解析 MCP 服务域名');
  }
  for (const ip of ips) {
    if (isBlockedLinkLocalOrSpecialIP(ip)) {
      throw new Error('不允许访问链路本地、未指定或组播地址');
    }
    if (!allowPrivate && isPrivateOrLoopbackIP(ip)) {
      throw new Error('当前环境禁止访问本机或内网 MCP 地址');
    }
  }
  return parsed;
}

function createSafeMcpFetch(baseFetch = globalThis.fetch) {
  return async (input, init = {}) => {
    const targetUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    await assertSafeMcpHttpUrl(targetUrl);
    return baseFetch(input, { ...init, redirect: 'error' });
  };
}

function createOutputSaver(outputDir) {
  return async (data, extension = '.txt') => {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(String(extension || '')) ? extension : '.txt';
    const fileName = `mcp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeExt}`;
    const target = path.join(outputDir, fileName);
    fs.writeFileSync(target, data, { mode: 0o600 });
    try {
      const files = fs.readdirSync(outputDir)
        .filter((name) => name.startsWith('mcp-'))
        .sort();
      for (const stale of files.slice(0, Math.max(0, files.length - MAX_OUTPUT_FILES))) {
        fs.rmSync(path.join(outputDir, stale), { force: true });
      }
    } catch { /* best-effort cleanup */ }
    return target;
  };
}

function toToolAnnotations(tool) {
  const annotations = {};
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof tool?.annotations?.[hint] === 'boolean') {
      annotations[hint] = tool.annotations[hint];
    }
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function serverConfigSignature(server) {
  return JSON.stringify({
    name: server.name,
    transport: server.transport,
    enabled: Boolean(server.enabled),
    command: server.command || '',
    args: Array.isArray(server.args) ? server.args : [],
    cwd: server.cwd || '',
    env: server.env || null,
    url: server.url || '',
    headers: server.headers || null,
    timeoutSec: Number(server.timeoutSec || 30),
  });
}

function createTransportForServer(server, safeFetch, defaultCwd) {
  if (server.transport === 'stdio') {
    const cwd = server.cwd ? path.resolve(defaultCwd || process.cwd(), expandHome(server.cwd)) : (defaultCwd || process.cwd());
    return new StdioTransport({
      command: expandHome(server.command),
      args: Array.isArray(server.args) ? server.args.map(expandHome) : [],
      cwd,
      env: buildSafeStdioEnv(server.env),
      inheritEnv: false,
      stderr: 'pipe',
    });
  }
  if (server.transport === 'http') {
    return new StreamableHttpTransport({
      url: server.url,
      ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}),
      fetch: safeFetch,
      openGetStream: false,
    });
  }
  throw new Error(`不支持的 MCP 传输类型: ${server.transport}`);
}

async function connectAndDiscover(server, { safeFetch, timeoutMs, defaultCwd }) {
  const transport = createTransportForServer(server, safeFetch, defaultCwd);
  const client = new McpClient({
    name: 'beeftv-assistant',
    version: '1.0.0',
    requestTimeoutMs: timeoutMs,
  });
  let connectTimer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error(`连接超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
      }),
    ]);
    const listResult = await client.listTools({ timeoutMs });
    const tools = Array.isArray(listResult)
      ? listResult
      : Array.isArray(listResult?.tools)
        ? listResult.tools
        : [];
    return {
      client,
      transport,
      tools,
      hasResources: Boolean(client.serverCapabilities?.resources),
      serverInfo: client.serverInfo || null,
      instructions: client.instructions || '',
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
  }
}

function buildDurableExtensionForEntry(entry, { reservedNames, saveOutput, callTimeoutMs, ensureConnected }) {
  const server = entry.config;
  const usedNames = new Set(reservedNames);
  const durableTools = [];
  const toolSummaries = [];

  for (const rawTool of entry.rawTools || []) {
    const rawName = String(rawTool?.name || '').trim();
    if (!rawName) continue;
    const exposedName = createMcpToolName(server.name, rawName, (candidate) => usedNames.has(candidate));
    if (usedNames.has(exposedName)) continue;
    usedNames.add(exposedName);

    const annotations = toToolAnnotations(rawTool);
    const readOnlyHint = annotations?.readOnlyHint === true;
    const title = rawTool.title || rawTool.annotations?.title || '';
    const description = (rawTool.description && String(rawTool.description).trim())
      || title
      || `MCP 工具 ${server.name}/${rawName}`;

    // MCP spec explicitly defines annotations.readOnlyHint as an untrusted hint, not a security guarantee.
    // Keep external MCP tools replay:'unsafe', sequential, and non-readOnly for permission gating.
    const durableTool = defineTool({
      name: exposedName,
      description,
      parameters: normalizeMcpInputSchema(rawTool.inputSchema),
      structuredOutputSchema: createMcpResultSchema(rawTool.outputSchema),
      deferred: true,
      replay: 'unsafe',
      executionMode: 'sequential',
      execute: async (args, api, context = {}) => {
        const client = await ensureConnected(entry);
        const result = await client.callTool(rawName, args || {}, {
          signal: context?.abortSignal,
          timeoutMs: callTimeoutMs,
          onProgress: (progress) => {
            if (typeof api?.details === 'function') {
              const total = progress.total === undefined ? '' : `/${progress.total}`;
              api.details({
                beeftvProgress: {
                  stage: `mcp:${server.name}/${rawName}`,
                  message: progress.message || `${progress.progress}${total}`,
                },
              }, context);
            }
          },
        });
        const converted = toLlmContent(result || { content: [] });
        if (result?.isError && !converted.some((block) => block.type === 'text' && block.text.trim())) {
          converted.push({ type: 'text', text: `MCP 工具 ${server.name}/${rawName} 返回错误` });
        }
        const { content, fullOutputPath } = await limitMcpContent(converted, saveOutput);
        const { _meta: _ignored, ...scriptResult } = result || {};
        return {
          output: content,
          structuredOutput: scriptResult,
          ...(fullOutputPath ? { details: { server: server.name, tool: rawName, fullOutputPath } } : {}),
          ...(result?.isError ? { isError: true } : {}),
        };
      },
    });
    Object.assign(durableTool, {
      label: `${server.name}/${rawName}`,
      readOnly: false,
      ...(annotations ? { annotations } : {}),
      mcpServer: server.name,
      mcpToolName: rawName,
    });
    durableTools.push(durableTool);
    toolSummaries.push({
      name: rawName,
      toolName: exposedName,
      description,
      readOnly: readOnlyHint,
    });
  }

  if (durableTools.length === 0) {
    return { extension: null, tools: [], toolSummaries: [] };
  }

  const sanitizedName = server.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const summary = mcpServerSummary(server.description, entry.instructions)
    || entry.serverInfo?.name
    || `External MCP server ${server.name}`;
  const extension = defineExtension({
    name: `beeftv.mcp.${sanitizedName}`,
    namespace: {
      name: mcpNamespace(server.name),
      description: summary,
      ...(entry.instructions ? { instructions: entry.instructions } : {}),
    },
    tools: durableTools,
  });
  return { extension, tools: durableTools, toolSummaries };
}

export function createMcpServerController({
  fetchEnabledServers = null,
  dataDir = '',
  cwd = process.cwd(),
  getReservedToolNames = () => new Set(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const safeFetch = createSafeMcpFetch(fetchImpl);
  const saveOutput = createOutputSaver(path.join(dataDir || process.cwd(), 'mcp-outputs'));
  // Map<serverName, { signature, config, client, reconnecting, hasResources, serverInfo, instructions, rawTools, extension, tools, status }>
  const entries = new Map();
  let lastFingerprint = null;
  let reloadQueue = Promise.resolve();

  async function ensureConnected(entry) {
    if (entry.client?.connectionState === 'connected') return entry.client;
    if (entry.reconnecting) return entry.reconnecting;
    const staleClient = entry.client;
    const timeoutMs = Math.max(5000, Math.min(300000, Number(entry.config.timeoutSec || 30) * 1000));
    entry.reconnecting = (async () => {
      if (staleClient) await staleClient.close().catch(() => {});
      const conn = await connectAndDiscover(entry.config, {
        safeFetch,
        timeoutMs: Math.min(timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
        defaultCwd: cwd,
      });
      // If reload()/closeAll() removed or replaced this entry while connecting, close immediately.
      if (entries.get(entry.config.name) !== entry) {
        await conn.client.close().catch(() => {});
        throw new Error(`MCP 服务 "${entry.config.name}" 已被重载或关闭`);
      }
      entry.client = conn.client;
      entry.hasResources = conn.hasResources;
      entry.serverInfo = conn.serverInfo;
      entry.instructions = conn.instructions;
      return conn.client;
    })().finally(() => {
      entry.reconnecting = null;
    });
    return entry.reconnecting;
  }

  function buildResourceExtension() {
    const resourceEntries = [...entries.values()].filter((e) => e.status?.state === 'connected' && e.hasResources);
    if (resourceEntries.length === 0) return null;
    const readResourceTool = defineTool({
      name: 'read_mcp_resource',
      description: '读取已连接外部 MCP 服务暴露的资源 URI 内容。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '已连接的外部 MCP 服务名' },
          uri: { type: 'string', description: '资源 URI' },
        },
        required: ['server', 'uri'],
      },
      deferred: true,
      replay: 'safe',
      executionMode: 'parallel',
      execute: async (args, _api, context = {}) => {
        const targetName = String(args?.server || '').trim();
        const uri = String(args?.uri || '').trim();
        const target = entries.get(targetName);
        if (!target || target.status?.state !== 'connected' || !target.hasResources) {
          return { output: [{ type: 'text', text: `外部 MCP 服务 "${targetName}" 未连接或不支持资源读取。` }], isError: true };
        }
        const client = await ensureConnected(target);
        const res = await client.readResource(uri, { signal: context?.abortSignal, timeoutMs: DEFAULT_CALL_TIMEOUT_MS });
        const parts = (res?.contents || []).map((item) => {
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.blob === 'string') {
            return `[Binary resource ${item.uri || uri} (${item.mimeType || 'application/octet-stream'}, ${Buffer.from(item.blob, 'base64').length} bytes)]`;
          }
          return '';
        }).filter(Boolean);
        const { content, fullOutputPath } = await limitMcpContent(
          [{ type: 'text', text: parts.join('\n\n') || '(空资源)' }],
          saveOutput,
        );
        return {
          output: content,
          ...(fullOutputPath ? { details: { server: targetName, uri, fullOutputPath } } : {}),
        };
      },
    });
    Object.assign(readResourceTool, { readOnly: true, label: 'mcp.read_resource' });
    return defineExtension({
      name: 'beeftv.mcp.resources',
      tools: [readResourceTool],
    });
  }

  function snapshotExtensions() {
    const out = [];
    for (const item of entries.values()) {
      if (item.extension) out.push(item.extension);
    }
    const resExt = buildResourceExtension();
    if (resExt) out.push(resExt);
    return out;
  }

  function snapshotToolNames() {
    const out = [];
    for (const ext of snapshotExtensions()) {
      for (const tool of ext.tools || []) out.push(tool.name);
    }
    return out;
  }

  function snapshotStatus() {
    return [...entries.values()]
      .map((item) => item.status)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function closeEntry(item) {
    if (!item?.client) return;
    try {
      await item.client.close();
    } catch {
      // ignore close errors
    }
  }

  async function runReload(explicitServers = undefined) {
    let servers = explicitServers;
    let fingerprint = null;
    if (!Array.isArray(servers)) {
      if (typeof fetchEnabledServers === 'function') {
        const payload = await fetchEnabledServers();
        servers = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
        fingerprint = typeof payload?.fingerprint === 'string' ? payload.fingerprint : null;
      } else {
        servers = [];
      }
    }

    const desiredByName = new Map();
    for (const raw of servers) {
      if (!raw || typeof raw !== 'object' || !raw.name || raw.enabled === false) continue;
      desiredByName.set(String(raw.name), raw);
    }

    const toClose = [];
    for (const [name, prev] of entries.entries()) {
      const next = desiredByName.get(name);
      // Evict removed, changed, or previously failed/disconnected entries so reload() retries them.
      if (!next || prev.status?.state !== 'connected' || prev.client?.connectionState !== 'connected' || serverConfigSignature(next) !== prev.signature) {
        toClose.push(prev);
        entries.delete(name);
      }
    }
    await Promise.allSettled(toClose.map((item) => closeEntry(item)));

    const reserved = new Set(getReservedToolNames());
    for (const existing of entries.values()) {
      for (const tool of existing.tools || []) reserved.add(tool.name);
    }

    const pending = [...desiredByName.values()].filter((srv) => !entries.has(srv.name));
    await Promise.all(pending.map(async (server) => {
      const timeoutMs = Math.max(5000, Math.min(300000, Number(server.timeoutSec || 30) * 1000));
      const connectTimeoutMs = Math.min(timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
      const signature = serverConfigSignature(server);
      try {
        const conn = await connectAndDiscover(server, { safeFetch, timeoutMs: connectTimeoutMs, defaultCwd: cwd });
        const entry = {
          signature,
          config: server,
          client: conn.client,
          reconnecting: null,
          hasResources: conn.hasResources,
          serverInfo: conn.serverInfo,
          instructions: conn.instructions,
          rawTools: conn.tools,
          extension: null,
          tools: [],
          status: null,
        };
        const built = buildDurableExtensionForEntry(entry, {
          reservedNames: reserved,
          saveOutput,
          callTimeoutMs: timeoutMs || DEFAULT_CALL_TIMEOUT_MS,
          ensureConnected,
        });
        entry.extension = built.extension;
        entry.tools = built.tools;
        entry.status = {
          name: server.name,
          transport: server.transport,
          state: 'connected',
          toolCount: built.toolSummaries.length,
          tools: built.toolSummaries,
          serverInfo: conn.serverInfo,
          error: null,
        };
        for (const tool of built.tools) reserved.add(tool.name);
        entries.set(server.name, entry);
      } catch (error) {
        entries.set(server.name, {
          signature,
          config: server,
          client: null,
          reconnecting: null,
          hasResources: false,
          serverInfo: null,
          instructions: '',
          rawTools: [],
          extension: null,
          tools: [],
          status: {
            name: server.name,
            transport: server.transport,
            state: 'error',
            toolCount: 0,
            tools: [],
            serverInfo: null,
            error: String(error?.message || error || '连接失败'),
          },
        });
      }
    }));

    lastFingerprint = fingerprint ?? JSON.stringify([...desiredByName.values()].map(serverConfigSignature));
    return {
      servers: snapshotStatus(),
      extensions: snapshotExtensions(),
      toolNames: snapshotToolNames(),
    };
  }

  function reload(explicitServers = undefined) {
    reloadQueue = reloadQueue.catch(() => {}).then(() => runReload(explicitServers));
    return reloadQueue;
  }

  async function syncIfChanged() {
    if (typeof fetchEnabledServers !== 'function') {
      return { changed: false, extensions: snapshotExtensions() };
    }
    let payload;
    try {
      payload = await fetchEnabledServers();
    } catch {
      return { changed: false, extensions: snapshotExtensions() };
    }
    const servers = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
    const nextFingerprint = typeof payload?.fingerprint === 'string'
      ? payload.fingerprint
      : JSON.stringify(servers.map(serverConfigSignature));
    if (nextFingerprint === lastFingerprint) {
      return { changed: false, extensions: snapshotExtensions() };
    }
    const result = await reload(servers);
    lastFingerprint = nextFingerprint;
    return { changed: true, ...result };
  }

  async function testServer(serverConfig) {
    if (!serverConfig || typeof serverConfig !== 'object' || !serverConfig.name) {
      return { ok: false, state: 'error', toolCount: 0, tools: [], error: '缺少 MCP 服务配置' };
    }
    const timeoutMs = Math.max(5000, Math.min(300000, Number(serverConfig.timeoutSec || 30) * 1000));
    const connectTimeoutMs = Math.min(timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    let conn = null;
    try {
      conn = await connectAndDiscover(serverConfig, { safeFetch, timeoutMs: connectTimeoutMs, defaultCwd: cwd });
      const tools = conn.tools.map((tool) => ({
        name: tool.name,
        toolName: createMcpToolName(serverConfig.name, tool.name),
        description: tool.description || tool.title || '',
        readOnly: tool.annotations?.readOnlyHint === true,
      }));
      return {
        ok: true,
        name: serverConfig.name,
        state: 'connected',
        toolCount: tools.length,
        tools,
        serverInfo: conn.serverInfo,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        name: serverConfig.name,
        state: 'error',
        toolCount: 0,
        tools: [],
        serverInfo: null,
        error: String(error?.message || error || '连接失败'),
      };
    } finally {
      if (conn?.client) await conn.client.close().catch(() => {});
    }
  }

  async function closeAll() {
    const items = [...entries.values()];
    entries.clear();
    await Promise.allSettled(items.map((item) => closeEntry(item)));
  }

  return {
    reload,
    syncIfChanged,
    testServer,
    getStatus: snapshotStatus,
    getExtensions: snapshotExtensions,
    getToolNames: snapshotToolNames,
    closeAll,
  };
}
