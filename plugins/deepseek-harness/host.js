import { randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { approvalReason, attachLocalRuntime, embeddedDocument, embeddedPathRejection, inspectWorkspace, localAppStatus, publicContext, rememberQuote, requiresGenerationApproval, startLocalRuntime, startRuntime, workspaceJSON } from './runtime.js'

export const name = 'beeftv'
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt']

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(value))
}

async function bodyJSON(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new Error('请求需要 JSON 内容')
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 32_768) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function proxy(runtime, req, res, path, basePath) {
  return new Promise((resolve, reject) => {
    if (!path.startsWith('/') || path.startsWith('//')) {
      reject(new Error('无效的工作区路径'))
      return
    }
    // The checked target is sent verbatim. Re-parsing it could drop or rewrite parts the check saw.
    const bridge = new URL(runtime.bridgeURL)
    // The page marker lets the bridge apply its own path check to embedded-page traffic.
    const headers = { ...req.headers, host: bridge.host, 'x-beeftv-harness-token': runtime.bridgeToken, 'x-beeftv-harness-page': '1' }
    for (const header of ['authorization', 'cookie', 'origin', 'x-desktop-token', 'x-beeftv-ui-bootstrap', 'x-beeftv-client', 'x-beeftv-owner']) delete headers[header]
    const upstream = request({ hostname: bridge.hostname, port: bridge.port, path, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }
      delete responseHeaders['set-cookie']
      if ((response.headers['content-type'] || '').includes('text/html')) {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const html = embeddedDocument(Buffer.concat(chunks).toString('utf8'), basePath)
          delete responseHeaders['content-length']
          delete responseHeaders['content-encoding']
          res.writeHead(response.statusCode || 200, responseHeaders)
          res.end(html)
          resolve()
        })
      } else {
        if ((response.headers['content-type'] || '').includes('text/event-stream')) {
          responseHeaders['cache-control'] = 'no-cache, no-transform'
          responseHeaders['x-accel-buffering'] = 'no'
          req.socket?.setNoDelay?.(true)
          response.socket?.setNoDelay?.(true)
        }
        res.writeHead(response.statusCode || 502, responseHeaders)
        res.flushHeaders?.()
        response.pipe(res)
        response.once('end', resolve)
        res.once('close', resolve)
      }
      response.once('error', reject)
    })
    upstream.once('error', reject)
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  })
}

const mcpToolName = id => `mcp__beeftv__${id.replace(/[^A-Za-z0-9_-]/g, '_')}`

// The BeefTV MCP server sets readOnlyHint from the operation catalog. DSH does not pass MCP
// annotations to plugins, so the Host reads the same catalog. business.list is the CLI's own
// discovery tool and is always annotated read-only.
function readOnlyToolNames(operations) {
  return new Set([mcpToolName('business.list'), ...operations.filter(operation => operation.readOnly === true).map(operation => mcpToolName(operation.id))])
}

function recordToolActivity(runtime, exec, result) {
  if (!runtime || result?.isError || typeof exec?.name !== 'string' || !exec.name.startsWith('mcp__beeftv__')) return
  if (runtime.readOnlyTools?.has(exec.name.replace(/_[a-f0-9]{12}$/, ''))) return
  if (/^mcp__beeftv__business_call(?:_[a-f0-9]{12})?$/.test(exec.name)) {
    const tool = runtime.businessTools?.find(item => item.id === exec.arguments?.tool)
    if (tool?.readOnly === true) return
  }
  let payload = null
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text : undefined
  if (text) {
    try {
      const parsed = JSON.parse(text)
      payload = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed
    } catch {
      payload = null
    }
  }
  const rawCanvasId = payload?.canvasId || payload?.project?.id || exec.arguments?.canvasId || exec.arguments?.path?.id
  const canvasId = typeof rawCanvasId === 'string' && rawCanvasId ? rawCanvasId.slice(0, 200) : null
  const created = /^mcp__beeftv__canvas_create(?:_[a-f0-9]{12})?$/.test(exec.name)
    || (exec.arguments?.tool === 'business_put_canvas_projects_id' && exec.arguments?.body?.project?.revision === 0)
  const kind = created ? 'canvas-created' : canvasId ? 'canvas-updated' : 'workspace-updated'
  runtime.activity = { seq: (runtime.activity?.seq || 0) + 1, kind, canvasId }
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const pluginHome = join(home, 'storages', 'beeftv')
  const settingsPath = join(pluginHome, 'connection.json')
  let current = null
  let switching = false
  let error = null
  let desiredMode = null
  let statusCheck = null
  const contexts = new Map()

  function status() {
    const mcpTools = ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__beeftv__')).map(tool => tool.name)
    return {
      connected: Boolean(current), mode: current?.mode || null,
      connectionId: current?.connectionId || null,
      version: current?.version || null, switching, error,
      workspace: current?.workspace || null,
      build: current?.build || null,
      activity: current?.activity || null,
      appURL: current ? `${ctx.webServer.getOrigin()}${current.basePath}/` : null,
      mcpTools, mcpState: current?.mcp?.state ?? null,
      guideState: current?.guideState || null, guideError: current?.guideError || null,
    }
  }

  async function release(runtime) {
    if (!runtime) return
    try { await runtime.mcp?.dispose() } catch { /* Complete cleanup after a failed activation. */ }
    try {
      if (runtime.clientId) await workspaceJSON(runtime, `/api/agent-clients/${encodeURIComponent(runtime.clientId)}`, { method: 'DELETE' })
    } catch {
      // Runtime shutdown still proceeds if the desktop owner already exited.
    }
    await runtime.close()
  }

  async function connect(mode, reconnect = false) {
    if (!['standalone', 'local'].includes(mode)) throw new Error('请选择独立工作区或本地 BeefTV')
    if (switching) throw new Error('正在连接工作区，请稍后重试')
    if (current?.mode === mode) {
      try {
        await workspaceJSON(current, '/api/health')
        return status()
      } catch {
        const stale = current
        current = null
        await release(stale)
      }
    }
    switching = true
    error = null
    const previous = current
    current = null
    contexts.clear()
    await release(previous)
    let runtime
    try {
      runtime = mode === 'local'
        ? await (reconnect ? attachLocalRuntime() : startLocalRuntime())
        : await startRuntime(join(pluginHome, 'workspace'))
      Object.assign(runtime, await inspectWorkspace(runtime))
      const registered = await workspaceJSON(runtime, '/api/agent-clients', {
        method: 'POST', body: JSON.stringify({ label: 'DeepSeek Harness', kind: 'other', mode: 'read-write', approvalMode: 'caller' }),
      })
      runtime.clientId = registered.client.id
      const readWorkspace = async (path, init = {}, failure = '无法读取工作区业务目录') => {
        const response = await fetch(`${runtime.baseURL}${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', 'X-Beeftv-Client': registered.client.id, authorization: `Bearer ${registered.token}` },
          signal: AbortSignal.timeout(15_000),
        })
        let payload
        try {
          payload = await response.json()
        } catch {
          const error = new Error(failure)
          error.status = response.status
          throw error
        }
        if (!response.ok || payload.code !== 0) {
          const error = new Error(failure)
          error.status = response.status
          throw error
        }
        return payload.data
      }
      // 旧工作区没有 agent.guide 时返回 404，不阻断连接；其他失败重试一次并记录，便于区分版本问题。
      const readGuide = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return { guide: await readWorkspace('/ops/agent.guide', { method: 'POST', body: '{}' }, '无法读取工作区使用说明') }
          } catch (failure) {
            if (failure.status === 404) return { missing: true }
            if (attempt === 1) return { error: `${failure.message || '无法读取工作区使用说明'}${failure.status ? `（HTTP ${failure.status}）` : ''}` }
          }
        }
      }
      const [business, operations, guideResult] = await Promise.all([
        readWorkspace('/business/tools'),
        readWorkspace('/ops'),
        readGuide(),
      ])
      if (!Array.isArray(business?.tools) || !Array.isArray(operations?.ops)) throw new Error('无法读取工作区业务目录')
      runtime.businessTools = business.tools
      runtime.readOnlyTools = readOnlyToolNames(operations.ops)
      const guide = guideResult.guide
      const guideValid = guide?.name === 'beeftv-canvas' && typeof guide.version === 'string' && typeof guide.text === 'string' && Boolean(guide.text)
      runtime.guide = guideValid ? guide : null
      runtime.guideState = guideResult.missing ? 'missing' : (guideResult.error || (!guideValid && guide)) ? 'failed' : 'ready'
      runtime.guideError = guideResult.error || (!guideValid && guide ? '使用说明格式无效' : null)
      runtime.mode = mode
      runtime.connectionId = randomUUID()
      runtime.basePath = `/beeftv/app/${randomBytes(24).toString('hex')}`
      runtime.mcp = ctx.plugin(mcpClient.default || mcpClient, {
        serverName: 'beeftv', transport: 'stdio', command: runtime.cli, args: ['mcp', 'serve'],
        failOnStartupError: true, toolCallTimeoutMs: 120_000,
        env: { BEEFTV_BASE_URL: runtime.baseURL, BEEFTV_CLIENT_ID: registered.client.id, BEEFTV_CLIENT_TOKEN: registered.token },
      })
      await runtime.mcp
      current = runtime
      desiredMode = mode
      if (runtime.owned) runtime.child.once('exit', () => {
        if (current !== runtime) return
        current = null
        error = 'BeefTV 工作区已关闭，请重新连接'
      })
      await mkdir(pluginHome, { recursive: true, mode: 0o700 })
      await writeFile(settingsPath, JSON.stringify({ mode }), { mode: 0o600 })
      return status()
    } catch (failure) {
      if (runtime && runtime !== current) await release(runtime)
      error = failure.message
      throw failure
    } finally {
      switching = false
    }
  }

  async function refreshConnection() {
    if (switching) return status()
    if (!statusCheck) statusCheck = (async () => {
      const previous = current
      if (previous) {
        try {
          const health = await workspaceJSON(previous, '/api/health', { signal: AbortSignal.timeout(2000) })
          if (!health.ready || !health.schema?.ready) throw new Error('工作区尚未就绪')
        } catch {
          if (current !== previous || switching) return status()
          current = null
          contexts.clear()
          error = 'BeefTV 连接已中断，等待本机应用恢复'
          await release(previous)
        }
      }
      if (!current && desiredMode === 'local' && !switching) {
        try { await connect('local', true) } catch { /* Retry discovery on the next status request. */ }
      }
      // The workspace chooser needs to know whether the installed App can be connected at all.
      return current ? status() : { ...status(), localApp: await localAppStatus() }
    })().finally(() => { statusCheck = null })
    return statusCheck
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/beeftv',
    async handler(req, res) {
      try {
        // Workspace requests are judged on the raw target. Parsing it first could resolve it into a path the bridge reads differently.
        if (current && req.url.startsWith(`${current.basePath}/`)) {
          const target = req.url.slice(current.basePath.length)
          const rawPath = target.split('?', 1)[0]
          if (req.method === 'GET' && rawPath === '/__harness/status') return json(res, 200, status())
          const origin = req.headers.origin
          if (origin && origin !== ctx.webServer.getOrigin()) return json(res, 403, { error: '不允许的来源' })
          const rejected = embeddedPathRejection(rawPath)
          if (rejected) return json(res, rejected, { error: rejected === 403 ? '该操作由 DeepSeek Harness 管理' : '无效的工作区路径' })
          await proxy(current, req, res, target, current.basePath)
          return
        }
        const url = new URL(req.url, 'http://localhost')
        const rejection = ctx.connection.requestRejection({ headers: req.headers })
        if (rejection) return json(res, rejection, { error: '未授权' })
        if (req.method === 'GET' && url.pathname === '/beeftv/status') return json(res, 200, await refreshConnection())
        if (req.method === 'POST' && url.pathname === '/beeftv/connect') {
          const body = await bodyJSON(req)
          await connect(body.mode)
          return json(res, 200, status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/context') {
          const body = await bodyJSON(req)
          if (!current || body.connectionId !== current.connectionId) return json(res, 409, { error: '工作区连接已更新，请刷新后重试' })
          if (typeof body.sessionId !== 'string' || body.sessionId.length > 256) throw new Error('无效的 Agent 会话')
          if (contexts.size >= 64 && !contexts.has(body.sessionId)) contexts.delete(contexts.keys().next().value)
          const view = publicContext(body.context)
          view.agentMode = ['creation', 'assets', 'ecosystem'].includes(body.agentMode) ? body.agentMode : 'creation'
          contexts.set(body.sessionId, view)
          return json(res, 200, { ok: true })
        }
        json(res, 404, { error: '未找到接口' })
      } catch (failure) {
        if (!res.headersSent) json(res, 503, { error: failure.message })
        else res.destroy()
      }
    },
  }))

  ctx.systemPrompt.section({
    name: 'beeftv-creation', order: 9000, interpolate: false,
    text: `你是 BeefTV Agent，协助用户完成长程 AI 视频导演创作、素材管理以及工作区深度定制。连接后通过 beeftv MCP 工具直接操作本机 BeefTV 的画布、分镜脚本、生成任务、时间线与配置，与本机 BeefTV 应用共享同一套数据与版本。
若下方提供「BeefTV 共用工作方法」，按它执行；没有时只按这里和工具返回执行。这里只补 DeepSeek Harness 专有规则：
1. 是否弹出审批由用户在 DSH 选的访问模式决定：弹出时等用户确认；完全权限下直接执行，不要再另外追问。用户拒绝后停止本次操作，不自动重试或绕道提交付费任务。
2. beeftv MCP 工具名可能带后缀；business_ 开头的名称是 business.call 的 tool 参数，不是可以直接调用的工具。
3. 不要读取或输出账号密钥。`,
  })
  ctx.systemPrompt.context({
    name: 'beeftv-current-view', order: 9000, interpolate: false,
    text: ({ agent }) => {
      if (!current) return ''
      const view = contexts.get(agent?.id)
      if (!view) return ''
      const guide = current.guide
      if (!guide) {
        const reason = current.guideState === 'missing' ? '当前工作区没有提供共用工作方法（BeefTV 版本较旧）' : '共用使用说明读取失败'
        return `${reason}。先读画布再写，写操作带 operationId，付费生成先提议并在回复里报价，其他按工具返回和用户要求执行。\n\nBeefTV 当前工作区视图（仅为定位信息，请用工具读取最新内容）\n${JSON.stringify(view)}`
      }
      const heading = `BeefTV 共用工作方法（${guide.name} ${guide.version}）`
      const directions = {
        creation: '长程导演创作模式。围绕当前画布（或新建画布）规划整片分镜、镜头节点、声音与时间线，按共用工作方法的顺序推进；生成前先报价。',
        assets: '素材管理模式。先搜索并核对素材，再复用到画布；画面与声音检查用共用工作方法里的媒体工具。',
        ecosystem: '创造与生态定制模式（接入第三方 API 渠道、开发插件、编写 Skill）。高影响改动先说明关键变更并等用户同意。',
      }
      return `${directions[view.agentMode]}\n\n${heading}\n${guide.text}\n\nBeefTV 当前工作区视图（仅为定位信息，请用工具读取最新内容）\n${JSON.stringify(view)}`
    },
  })
  function fullAccess(agent) {
    if (!agent?.session) return false
    try {
      return ctx.get?.('permissionPresets')?.current(agent.session) === 'danger-full-access'
    } catch {
      return false
    }
  }
  ctx.on('tools/result', (exec, result) => {
    if (current) rememberQuote(current.quotes ??= new Map(), exec?.name, result)
    recordToolActivity(current, exec, result)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !requiresGenerationApproval(exec.name, exec.arguments, current?.businessTools)) return decision
    // The user chose 完全权限: DSH shows no approval prompts and rejects any ask without showing it, so the
    // call runs as the user chose, like a fully authorized external agent. A bare "never" approval policy
    // without that preset is DSH's unattended mode, where asks must still fail closed.
    if (fullAccess(exec.agent)) return decision
    return { kind: 'ask', reason: approvalReason(exec.name, exec.arguments, current?.businessTools, current?.quotes) }
  })
  ctx.effect(() => () => { const runtime = current; current = null; void release(runtime) })
  void readFile(settingsPath, 'utf8').then(JSON.parse).then(settings => connect(settings.mode)).catch(failure => {
    if (failure.code !== 'ENOENT') error = failure.message
  })
}
