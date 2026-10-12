// 用户自行添加的 MCP 服务器 → 内置助手的外部工具来源。
// 客户端协议全部交给官方 @earendil-works/pi-mcp；这里只做配置校验、连接缓存、权限过滤与名称约束。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';

export const CONNECT_TIMEOUT_MS = 15_000;
// 连接/列工具用短超时，工具本身可能跑很久（例如本地 ComfyUI 出图），单次调用给足 10 分钟。
export const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;
// 坏服务器在窗口内不再重连，避免每个助手消息都被它拖慢。
export const FAILURE_BACKOFF_MS = 60_000;
const TOOL_NAME_LIMIT = 64;
// 只放行运行命令所需的系统变量。宿主进程环境里带有宿主/桌面令牌，绝不能整体继承给 MCP 子进程。
// PATHEXT / ComSpec / SystemDrive / windir 供 Windows 上的 .cmd/.bat 命令解析（npx 等）。
export const STDIO_ENV_ALLOWLIST = ['PATH', 'PATHEXT', 'ComSpec', 'SystemDrive', 'windir', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
// 桌面应用继承的 PATH 往往缺少 Node 与包管理器目录，补齐常见安装位置。
const PATH_AUGMENT_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '.local/bin', '.bun/bin', '.volta/bin', '.cargo/bin'];

function list(value) {
  return Array.isArray(value) ? value : [];
}

function keyValues(value) {
  return list(value)
    .map((item) => ({ name: String(item?.name ?? '').trim(), value: String(item?.value ?? '') }))
    .filter((item) => item.name);
}

function headerObject(value) {
  return Object.fromEntries(keyValues(value).map((item) => [item.name, item.value]));
}

// 无效条目返回 null，由调用方跳过；不会因为一条坏配置让整轮失败。
export function normalizeMcpServer(raw) {
  const id = String(raw?.id ?? '').trim();
  if (!id) return null;
  const transport = raw?.transport;
  const server = {
    id,
    name: String(raw?.name ?? '').trim() || id,
    enabled: raw?.enabled !== false,
    transport,
    disabledTools: list(raw?.disabledTools).map(String),
  };
  if (transport === 'stdio') {
    const command = String(raw?.command ?? '').trim();
    if (!command) return null;
    return { ...server, command, args: list(raw?.args).map(String), env: keyValues(raw?.env) };
  }
  if (transport === 'http') {
    let url;
    try { url = new URL(String(raw?.url ?? '').trim()); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { ...server, url: url.toString(), headers: keyValues(raw?.headers) };
  }
  return null;
}

function augmentPath(current, extra, delimiter) {
  const seen = new Set();
  const parts = [];
  for (const raw of [...String(current ?? '').split(delimiter), ...extra]) {
    const part = raw.trim();
    if (!part || seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }
  return parts.join(delimiter);
}

// 环境白名单 + 本服务器自己配置的变量。不读取 process.env 的其他任何键。
export function buildStdioEnv(serverEnv = [], hostEnv = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? fs.existsSync;
  const execPath = options.execPath ?? process.execPath;
  const delimiter = options.delimiter ?? path.delimiter;
  const home = options.home ?? os.homedir();
  const env = {};
  for (const name of STDIO_ENV_ALLOWLIST) {
    if (typeof hostEnv[name] === 'string') env[name] = hostEnv[name];
  }
  const own = keyValues(serverEnv);
  for (const item of own) env[item.name] = item.value;
  // 服务器自己配置了 PATH 就以它为准，否则在继承的 PATH 后面补上 Node 与常见包管理器目录。
  if (!own.some((item) => item.name.toUpperCase() === 'PATH')) {
    const extra = [];
    if (execPath) extra.push(path.dirname(execPath));
    if (platform !== 'win32') {
      for (const suffix of PATH_AUGMENT_DIRS) {
        const dir = suffix.startsWith('/') ? suffix : path.join(home, suffix);
        if (dir && exists(dir)) extra.push(dir);
      }
    }
    env.PATH = augmentPath(env.PATH || '', extra, delimiter);
  }
  return env;
}

function fingerprint(server) {
  const normalized = JSON.stringify({
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? null,
    env: server.env ? [...server.env].sort((a, b) => a.name.localeCompare(b.name)) : null,
    url: server.url ?? null,
    headers: server.headers ? [...server.headers].sort((a, b) => a.name.localeCompare(b.name)) : null,
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function failure(reason, message, cause) {
  return Object.assign(new Error(message), { reason, ...(cause ? { cause } : {}) });
}

export async function defaultConnect(server) {
  const transport = server.transport === 'stdio'
    ? new StdioTransport({ command: server.command, args: server.args, env: buildStdioEnv(server.env), inheritEnv: false })
    : new StreamableHttpTransport({ url: server.url, headers: headerObject(server.headers) });
  const client = new McpClient({ name: 'beeftv-agent-host', version: '1.0.0', requestTimeoutMs: CONNECT_TIMEOUT_MS });
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('mcp_connect_timeout', '连接 MCP 服务器超时')), CONNECT_TIMEOUT_MS); }),
    ]);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error.reason ? error : failure('mcp_connect_failed', '无法连接 MCP 服务器', error);
  } finally {
    clearTimeout(timer);
  }
}

function slug(value, max) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || 'x';
}

// 工具名必须是 [A-Za-z0-9_-]{1,64}。服务端名与工具名都清洗；冲突时追加序号并再截断。
export function uniqueToolName(serverName, toolName, used) {
  const base = `mcp__${slug(serverName, 20)}__${slug(toolName, 40)}`.slice(0, TOOL_NAME_LIMIT);
  let candidate = base;
  for (let index = 2; used.has(candidate); index += 1) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, TOOL_NAME_LIMIT - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function toolParameters(schema) {
  const input = schema && typeof schema === 'object' ? schema : {};
  return { ...input, type: 'object', properties: input.properties ?? {} };
}

export function createMcpToolSource({ loadServers, connect = defaultConnect, now = Date.now }) {
  const connections = new Map();
  const statuses = new Map();
  const failures = new Map();

  async function closeConnection(id) {
    const connection = connections.get(id);
    connections.delete(id);
    if (connection) await connection.client.close().catch(() => {});
  }

  async function connectServer(server, key) {
    const client = await connect(server);
    const connection = { fingerprint: key, client, toolsPromise: null };
    connection.toolsPromise = client.listTools();
    // 本地命令崩溃等会让连接断开；丢掉缓存，下一次装配重新连接。
    if (typeof client.onClose === 'function') {
      client.onClose(() => { if (connections.get(server.id)?.client === client) connections.delete(server.id); });
    }
    connections.set(server.id, connection);
    return connection;
  }

  async function prepareServer(server) {
    const key = fingerprint(server);
    const remembered = failures.get(server.id);
    if (remembered && remembered.fingerprint === key && now() - remembered.failedAt < FAILURE_BACKOFF_MS) {
      // 刚失败过且配置没变：这一轮不再连它，状态保留上一次的错误。
      statuses.set(server.id, { ok: false, toolCount: 0, error: remembered.error });
      return { server, error: remembered.error };
    }
    try {
      let connection = connections.get(server.id);
      if (!connection || connection.fingerprint !== key) {
        if (connection) await closeConnection(server.id);
        connection = await connectServer(server, key);
      }
      const listed = await connection.toolsPromise;
      failures.delete(server.id);
      statuses.set(server.id, { ok: true, toolCount: listed.length, error: null });
      return { server, listed, connection };
    } catch (error) {
      await closeConnection(server.id);
      const message = plainError(error);
      failures.set(server.id, { fingerprint: key, failedAt: now(), error: message });
      statuses.set(server.id, { ok: false, toolCount: 0, error: message });
      return { server, error: message };
    }
  }

  async function tools({ permissionMode = 'canvas' } = {}) {
    const servers = (await loadServers()).map(normalizeMcpServer).filter((server) => server?.enabled);
    const enabledIds = new Set(servers.map((server) => server.id));
    for (const id of [...connections.keys()]) {
      if (!enabledIds.has(id)) await closeConnection(id);
    }
    // 并行连接/列工具，坏服务器不阻塞其他服务器；命名仍按服务器原顺序，保证工具名稳定。
    const prepared = await Promise.all(servers.map((server) => prepareServer(server)));
    const readOnlyMode = permissionMode === 'read-only';
    const used = new Set();
    const result = [];
    for (const item of prepared) {
      if (item.error) continue;
      const { server, listed, connection } = item;
      for (const tool of listed) {
        if (server.disabledTools.includes(tool.name)) continue;
        const readOnly = tool.annotations?.readOnlyHint === true;
        if (readOnlyMode && !readOnly) continue;
        const name = uniqueToolName(server.name, tool.name, used);
        result.push({
          name,
          label: `${server.name} · ${tool.title || tool.name}`,
          description: `[${server.name}] ${tool.description || tool.title || tool.name}`,
          parameters: toolParameters(tool.inputSchema),
          readOnly,
          serverId: server.id,
          toolName: tool.name,
          execute: async (_toolCallId, args, signal) => {
            if (readOnlyMode && !readOnly) throw failure('scope_denied', '这一轮只能使用只读的 MCP 工具');
            const callResult = await connection.client.callTool(tool.name, args ?? {}, { signal, timeoutMs: TOOL_CALL_TIMEOUT_MS });
            return { content: toLlmContent(callResult), details: undefined, isError: callResult.isError === true };
          },
        });
      }
    }
    return result;
  }

  function status() {
    return Object.fromEntries(statuses);
  }

  async function probe(raw) {
    const server = normalizeMcpServer(raw);
    if (!server) throw failure('mcp_server_invalid', 'MCP 服务器配置不完整');
    let client;
    try {
      client = await connect(server);
    } catch (error) {
      // 保留连接阶段的具体原因（超时 / 连接失败），不要塌成一句通用错误。
      throw error?.reason ? error : failure('mcp_connect_failed', '无法连接 MCP 服务器', error);
    }
    try {
      const listed = await client.listTools();
      return {
        tools: listed.map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? '',
          readOnly: tool.annotations?.readOnlyHint === true,
        })),
      };
    } catch (error) {
      throw failure('mcp_list_failed', plainError(error), error);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async function close() {
    await Promise.all([...connections.keys()].map((id) => closeConnection(id)));
    statuses.clear();
  }

  return { tools, status, probe, close };
}

function plainError(error) {
  if (error?.reason === 'mcp_connect_timeout') return '连接超时，请检查服务是否在运行';
  if (error?.reason === 'mcp_connect_failed') return '无法连接，请检查命令或地址是否正确';
  return error instanceof Error ? error.message : String(error);
}
