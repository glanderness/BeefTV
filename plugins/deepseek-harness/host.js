import { randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  approvalReason, attachLocalRuntime, awayGenerationNotice, awaitWakeText, defaultPluginSettings, embeddedDocument, embeddedPathRejection,
  guidedPrompt, inspectWorkspace, localAppStatus, maximumWakesPerSession, normalizeSettings, publicContext, rememberQuote,
  requiresGenerationApproval, startLocalRuntime, startRuntime, stepLimitNotice, submittedTaskIds, taskOutcome,
  validatedSettingsPatch, waitOutcome, workspaceJSON,
} from './runtime.js'

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
  let localPromptDismissed = false
  let localAppCheckedAt = 0
  let statusCheck = null
  const contexts = new Map()
  // How often a standalone workspace re-checks the installed App. A later install or upgrade
  // should still surface the one-time switch prompt.
  const localAppRecheckMs = 30_000
  const pluginSettingsPath = join(pluginHome, 'settings.json')
  const awaitingPath = join(pluginHome, 'awaiting.json')
  const awaitMaximumMs = 40 * 60 * 1000
  const taskGetIntervalMs = 5_000
  let pluginSettings = { ...defaultPluginSettings }
  // 离开时还没投递的任务先留在盘上，连回同一工作区后查一次终态再决定提示数量。
  let awayPending = []
  let awayNoticeCount = 0
  // 「会话 → 等待中的任务」只属于当前进程：重启或重连后不续跑，改为在面板提示一次。
  const waits = new Map()
  const wakeCounts = new Map()
  const wakeIds = new Set()
  const pendingWakeMessages = new Map()
  const deferredWakes = new Map()
  const stoppedSessions = new Set()
  const wokenTasks = new Set()
  const turns = new Map()
  let stepNotice = null
  let settingsWrite = Promise.resolve()
  let awaitingWrite = Promise.resolve()

  async function writePluginSettings() {
    const value = { ...pluginSettings }
    settingsWrite = settingsWrite.catch(() => {}).then(async () => {
      await mkdir(pluginHome, { recursive: true, mode: 0o700 })
      await writeFile(pluginSettingsPath, JSON.stringify(value), { mode: 0o600 })
    })
    return settingsWrite
  }

  function pendingTasks() {
    const sessions = {}
    for (const [sessionId, state] of waits) {
      const ids = [...state.tasks.keys()]
      if (ids.length) sessions[sessionId] = { workspaceId: state.runtime?.workspace?.id || null, taskIds: ids }
    }
    return sessions
  }

  async function writeAwaiting() {
    const value = { sessions: pendingTasks(), away: awayPending }
    awaitingWrite = awaitingWrite.catch(() => {}).then(async () => {
      await mkdir(pluginHome, { recursive: true, mode: 0o700 })
      await writeFile(awaitingPath, JSON.stringify(value), { mode: 0o600 })
    })
    return awaitingWrite
  }

  const pluginSettingsReady = readFile(pluginSettingsPath, 'utf8').then(JSON.parse).then(value => {
    pluginSettings = normalizeSettings(value)
    return pluginSettings
  }).catch(() => pluginSettings)

  // 上次退出时还没投递的任务不恢复到内存里的等待队列，连回同一工作区后再查终态。
  const awaitingReady = readFile(awaitingPath, 'utf8').then(JSON.parse).then(async value => {
    const sessions = value?.sessions && typeof value.sessions === 'object' ? value.sessions : {}
    let leftover = false
    for (const entry of Object.values(sessions)) {
      const ids = Array.isArray(entry) ? entry : Array.isArray(entry?.taskIds) ? entry.taskIds : []
      const taskIds = ids.filter(id => typeof id === 'string' && id)
      const resolvedCount = !Array.isArray(entry) && Number.isInteger(entry?.resolvedCount) && entry.resolvedCount > 0 ? entry.resolvedCount : 0
      if (!taskIds.length && !resolvedCount) continue
      awayPending.push({ workspaceId: Array.isArray(entry) ? null : entry.workspaceId || null, taskIds, resolvedCount })
      leftover = true
    }
    if (Array.isArray(value?.away)) {
      for (const entry of value.away) {
        const taskIds = Array.isArray(entry) ? entry : Array.isArray(entry?.taskIds) ? entry.taskIds : []
        const resolvedCount = !Array.isArray(entry) && Number.isInteger(entry?.resolvedCount) && entry.resolvedCount > 0 ? entry.resolvedCount : 0
        if (!taskIds.length && !resolvedCount) continue
        awayPending.push({ workspaceId: Array.isArray(entry) ? null : entry.workspaceId || null, taskIds, resolvedCount })
        leftover = true
      }
    }
    if (leftover) await writeAwaiting()
    return value
  }).catch(() => null)

  async function writeSettings() {
    await mkdir(pluginHome, { recursive: true, mode: 0o700 })
    await writeFile(settingsPath, JSON.stringify({ mode: desiredMode, localPromptDismissed }), { mode: 0o600 })
  }

  async function refreshLocalApp(runtime) {
    if (runtime.mode !== 'standalone' || localPromptDismissed || runtime.localApp?.compatible === true) return
    if (Date.now() - localAppCheckedAt < localAppRecheckMs) return
    localAppCheckedAt = Date.now()
    runtime.localApp = await localAppStatus()
  }

  // Read before answering status or connecting, so a saved 暂不 cannot be overwritten by an
  // early connection that still sees the default.
  const settingsReady = readFile(settingsPath, 'utf8').then(JSON.parse).then(settings => {
    if (settings.localPromptDismissed === true) localPromptDismissed = true
    return settings
  }).catch(failure => {
    if (failure.code !== 'ENOENT') error = failure.message
    return null
  })

  function status() {
    const mcpTools = ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__beeftv__')).map(tool => tool.name)
    return {
      connected: Boolean(current), mode: current?.mode || null,
      connectionId: current?.connectionId || null,
      version: current?.version || null, switching, error,
      workspace: current?.workspace || null,
      build: current?.build || null,
      activity: current?.activity || null,
      localApp: current?.localApp || null,
      localPromptDismissed,
      autoContinue: pluginSettings.autoContinue,
      stepLimit: pluginSettings.stepLimit,
      awayNotice: awayGenerationNotice(awayNoticeCount) || null,
      stepNotice: stepNotice?.text || null,
      appURL: current ? `${ctx.webServer.getOrigin()}${current.basePath}/` : null,
      mcpTools, mcpState: current?.mcp?.state ?? null,
    }
  }

  // 直接走工作区操作层，带插件登记得到的客户端凭据；不经过模型，也不新增付费任务。
  async function callOperation(runtime, id, params, signal) {
    const response = await fetch(`${runtime.baseURL}/ops/${encodeURIComponent(id)}`, {
      method: 'POST',
      signal: signal ?? AbortSignal.timeout(25_000),
      headers: {
        'content-type': 'application/json',
        'X-Beeftv-Client': runtime.clientId,
        authorization: `Bearer ${runtime.clientToken}`,
      },
      body: JSON.stringify({ opId: randomUUID(), params }),
    })
    const value = await response.json()
    if (!response.ok || value.code !== 0) throw new Error(value.msg || `BeefTV 请求失败 (${response.status})`)
    return value.data
  }

  function hasOperation(runtime, id) {
    return Array.isArray(runtime?.operations) && runtime.operations.some(operation => operation?.id === id)
  }

  // 唤醒消息是插件发出的用户角色消息，用独立来源，别让其他插件当成用户亲自输入。
  function wakeMessage(text) {
    const message = {
      id: `beeftv-await-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'beeftv-await' },
    }
    wakeIds.add(message.id)
    while (wakeIds.size > 200) wakeIds.delete(wakeIds.values().next().value)
    return message
  }

  function sessionIdOf(agent) {
    return agent?.id || agent?.session?.id || null
  }

  function stopSessionWaits(sessionId) {
    stoppedSessions.add(sessionId)
    deferredWakes.delete(sessionId)
    for (const [messageId, entry] of pendingWakeMessages) {
      if (entry.sessionId === sessionId) pendingWakeMessages.delete(messageId)
    }
    const state = waits.get(sessionId)
    if (!state) return Promise.resolve()
    // 先标记取消：已经在返回路上的结果不得再触发唤醒。
    state.cancelled = true
    state.done = true
    state.controller.abort()
    waits.delete(sessionId)
    return writeAwaiting().catch(() => {})
  }

  // 重连或插件退出后不自动续跑：等待中的任务只留作「离开时完成」的计数。
  async function abandonWaits(runtime) {
    let changed = false
    for (const [sessionId, state] of [...waits]) {
      if (runtime && state.runtime !== runtime) continue
      state.cancelled = true
      state.done = true
      state.controller.abort()
      const taskIds = [...state.tasks.keys()]
      if (taskIds.length) awayPending.push({ workspaceId: state.runtime?.workspace?.id || null, taskIds, resolvedCount: 0 })
      waits.delete(sessionId)
      changed = true
    }
    if (changed) await writeAwaiting().catch(() => {})
  }

  function stopAllWaits() {
    for (const state of waits.values()) {
      state.cancelled = true
      state.done = true
      state.controller.abort()
    }
    waits.clear()
    deferredWakes.clear()
    pendingWakeMessages.clear()
    return writeAwaiting().catch(() => {})
  }

  function deferOutcomes(sessionId, outcomes, workspaceId) {
    const current = deferredWakes.get(sessionId)
    const sameWorkspace = current && current.workspaceId === workspaceId
    const deferred = sameWorkspace ? current.outcomes : []
    for (const outcome of outcomes) {
      if (!deferred.some(item => item.taskId === outcome.taskId)) deferred.push(outcome)
    }
    while (deferred.length > 50) deferred.shift()
    deferredWakes.set(sessionId, { workspaceId: workspaceId || null, outcomes: deferred })
  }

  // 投递成功才记账；会话结束或上限挡住时把结果留给下一次用户消息。
  function deliverOutcomes(sessionId, agent, outcomes) {
    if (!agent || typeof agent.followup !== 'function' || typeof agent.inject !== 'function') return false
    const message = wakeMessage(awaitWakeText(outcomes))
    try {
      // 空闲时开新一轮；忙时插进当前轮，不打断正在执行的步骤。
      if (agent.status === 'running') agent.inject(message)
      else agent.followup(message)
      for (const outcome of outcomes) wokenTasks.add(outcome.taskId)
      wakeCounts.set(sessionId, (wakeCounts.get(sessionId) || 0) + 1)
      pendingWakeMessages.set(message.id, { sessionId, outcomes, workspaceId: current?.workspace?.id || null })
      return true
    } catch {
      return false
    }
  }

  function deliverWake(state) {
    const outcomes = [...state.tasks].map(([taskId, outcome]) => ({ taskId, ...outcome }))
    const unseen = outcomes.filter(outcome => !wokenTasks.has(outcome.taskId))
    if (!unseen.length || !pluginSettings.autoContinue || state.cancelled) return
    const sessionId = state.sessionId
    const workspaceId = state.runtime?.workspace?.id || null
    if ((wakeCounts.get(sessionId) || 0) >= maximumWakesPerSession) {
      deferOutcomes(sessionId, unseen, workspaceId)
      return
    }
    if (!deliverOutcomes(sessionId, state.agent, unseen)) deferOutcomes(sessionId, unseen, workspaceId)
  }

  async function drainWait(state) {
    if (state.running || state.done) return
    state.running = true
    try {
      while (!state.done && Date.now() < state.deadline) {
        const pending = [...state.tasks].filter(([, outcome]) => outcome.state === 'pending')
        if (!pending.length) break
        if (state.useTaskWait) {
          await Promise.all(pending.map(async ([taskId]) => {
            try {
              const value = await callOperation(state.runtime, 'task.wait', { taskId }, AbortSignal.any([state.controller.signal, AbortSignal.timeout(25_000)]))
              const outcome = waitOutcome(value, taskId)
              if (outcome.state !== 'pending' && state.tasks.has(taskId)) state.tasks.set(taskId, outcome)
            } catch {
              // 操作层没有这个能力或这次读取失败时退回 task.get，避免一直空等。
              if (state.controller.signal.aborted) return
              state.useTaskWait = false
            }
          }))
        } else {
          await Promise.all(pending.map(async ([taskId]) => {
            try {
              const value = await callOperation(state.runtime, 'task.get', { taskId }, AbortSignal.any([state.controller.signal, AbortSignal.timeout(25_000)]))
              const outcome = taskOutcome(value, taskId)
              if (outcome.state !== 'pending' && state.tasks.has(taskId)) state.tasks.set(taskId, outcome)
            } catch {
              // 暂时读不到进度不是任务失败；保留原任务继续等。
            }
          }))
          if (!state.done && [...state.tasks.values()].some(outcome => outcome.state === 'pending')) {
            await delay(taskGetIntervalMs, undefined, { signal: state.controller.signal }).catch(() => {})
          }
        }
      }
    } finally {
      state.running = false
    }
    if (state.done || state.controller.signal.aborted) return
    if ([...state.tasks.values()].some(outcome => outcome.state === 'pending')) {
      // 40 分钟仍未全部结束：不再占用会话，用户仍可在画布上看任务状态。
      state.done = true
      waits.delete(state.sessionId)
      await writeAwaiting().catch(() => {})
      return
    }
    // 投递之前不写盘、也不从 waits 删除：停止/断开仍能找到这个会话并标记取消。
    // 万一进程在写盘前退出，盘上留着任务清单，重启后还能按终态提示一次。
    deliverWake(state)
    state.done = true
    if (waits.get(state.sessionId) === state) waits.delete(state.sessionId)
    await writeAwaiting().catch(() => {})
  }

  function startWaits(runtime, agent, taskIds) {
    const sessionId = sessionIdOf(agent)
    if (!pluginSettings.autoContinue || !runtime || !sessionId || !taskIds.length) return
    const fresh = taskIds.filter(id => !wokenTasks.has(id))
    if (!fresh.length) return
    let state = waits.get(sessionId)
    if (!state || state.runtime !== runtime || state.done) {
      state = {
        runtime, agent, sessionId, tasks: new Map(),
        deadline: Date.now() + awaitMaximumMs, controller: new AbortController(),
        useTaskWait: hasOperation(runtime, 'task.wait'), running: false, done: false, cancelled: false,
      }
      waits.set(sessionId, state)
    }
    state.agent = agent
    for (const taskId of fresh) {
      if (!state.tasks.has(taskId)) state.tasks.set(taskId, { state: 'pending', reason: '' })
    }
    // 新提交的任务从自己的提交时刻起算 40 分钟；同一会话的后一次等待不会提前掐掉前一次。
    state.deadline = Date.now() + awaitMaximumMs
    void writeAwaiting().catch(() => {})
    void drainWait(state)
  }

  async function loadGuide(runtime) {
    runtime.guide = null
    if (!hasOperation(runtime, 'agent.guide')) return
    try {
      const guide = await callOperation(runtime, 'agent.guide', {}, AbortSignal.timeout(15_000))
      if (typeof guide?.text === 'string' && guide.text.trim()) runtime.guide = guide
    } catch {
      // 读不到说明时沿用插件内置的完整说明，不让连接失败。
    }
  }

  // 上一段连接留下的任务只查终态用于提示，不恢复等待；查不到或仍在跑的不算「完成」。
  async function resolveAway(runtime) {
    if (!awayPending.length) {
      awayNoticeCount = 0
      return
    }
    const workspaceId = runtime.workspace?.id || null
    let notice = 0
    const kept = []
    for (const entry of awayPending) {
      if (entry.workspaceId && entry.workspaceId !== workspaceId) {
        kept.push(entry)
        continue
      }
      let completed = Number.isInteger(entry.resolvedCount) ? entry.resolvedCount : 0
      const remaining = []
      const taskIds = [...new Set(entry.taskIds)].slice(0, 20)
      await Promise.all(taskIds.map(async taskId => {
        try {
          const task = await callOperation(runtime, 'task.get', { taskId }, AbortSignal.timeout(10_000))
          if (taskOutcome(task, taskId).state !== 'pending') completed += 1
          else remaining.push(taskId)
        } catch {
          // 读不到状态就先留着，下次连回同一工作区再核对，不把仍在处理的说成已完成。
          remaining.push(taskId)
        }
      }))
      // 已解析的计数保留到用户关闭提示，重连或重启不会把提示清掉。
      kept.push({ workspaceId: entry.workspaceId, taskIds: remaining, resolvedCount: completed })
      notice += completed
    }
    awayPending = kept
    awayNoticeCount = notice
    await writeAwaiting().catch(() => {})
  }

  async function release(runtime) {
    if (!runtime) return
    // 连接断开、切换工作区或插件退出时都不再续跑后台等待。
    await abandonWaits(runtime)
    try { await runtime.mcp?.dispose() } catch { /* Complete cleanup after a failed activation. */ }
    try {
      if (runtime.clientId) await workspaceJSON(runtime, `/api/agent-clients/${encodeURIComponent(runtime.clientId)}`, { method: 'DELETE' })
    } catch {
      // Runtime shutdown still proceeds if the desktop owner already exited.
    }
    await runtime.close()
  }

  async function connect(mode, reconnect = false) {
    // 设置和上次留下的提示先读完，第一次工具调用就按用户的真实选择执行。
    await Promise.all([pluginSettingsReady, awaitingReady, settingsReady])
    if (!['standalone', 'local'].includes(mode)) throw new Error('请选择独立工作区或本地 BeefTV')
    if (switching) throw new Error('正在连接工作区，请稍后重试')
    if (current?.mode === mode) {
      try {
        await workspaceJSON(current, '/api/health')
        // 健康检查触发的重连也要把离开时的提示重新解析出来。
        await resolveAway(current)
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
      runtime.clientToken = registered.token
      const [business, operations] = await Promise.all(['/business/tools', '/ops'].map(async path => {
        const response = await fetch(`${runtime.baseURL}${path}`, {
          headers: { 'X-Beeftv-Client': registered.client.id, authorization: `Bearer ${registered.token}` },
          signal: AbortSignal.timeout(15_000),
        })
        const catalog = await response.json()
        if (!response.ok || catalog.code !== 0) throw new Error('无法读取工作区业务目录')
        return catalog.data
      }))
      if (!Array.isArray(business?.tools) || !Array.isArray(operations?.ops)) throw new Error('无法读取工作区业务目录')
      runtime.businessTools = business.tools
      runtime.operations = operations.ops
      runtime.readOnlyTools = readOnlyToolNames(operations.ops)
      // 有 agent.guide 时整段替换内置说明；读不到就沿用内置文案。
      await loadGuide(runtime)
      // 只按当前工作区核对离开时的任务，不恢复等待。
      await resolveAway(runtime)
      runtime.mode = mode
      runtime.localApp = mode === 'standalone' ? await localAppStatus() : null
      if (mode === 'standalone') localAppCheckedAt = Date.now()
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
        void abandonWaits(runtime)
        error = 'BeefTV 工作区已关闭，请重新连接'
      })
      await writeSettings()
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
      if (current) await refreshLocalApp(current)
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
        if (req.method === 'GET' && url.pathname === '/beeftv/status') {
          await Promise.all([settingsReady, pluginSettingsReady, awaitingReady])
          return json(res, 200, await refreshConnection())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/connect') {
          const body = await bodyJSON(req)
          await settingsReady
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
        if (req.method === 'POST' && url.pathname === '/beeftv/settings') {
          const body = await bodyJSON(req)
          await pluginSettingsReady
          const patch = validatedSettingsPatch(body)
          const previous = pluginSettings
          pluginSettings = { ...pluginSettings, ...patch }
          try {
            await writePluginSettings()
          } catch (failure) {
            pluginSettings = previous
            throw failure
          }
          if (!pluginSettings.autoContinue) await stopAllWaits()
          return json(res, 200, status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/away-notice') {
          const body = await bodyJSON(req)
          if (body.seen !== true) throw new Error('无效的提示设置')
          const workspaceId = current?.workspace?.id || null
          awayPending = awayPending.filter(entry => entry.workspaceId && entry.workspaceId !== workspaceId)
          awayNoticeCount = 0
          await writeAwaiting().catch(() => {})
          return json(res, 200, status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/step-notice') {
          const body = await bodyJSON(req)
          if (body.seen !== true) throw new Error('无效的提示设置')
          stepNotice = null
          return json(res, 200, status())
        }
        if (req.method === 'POST' && url.pathname === '/beeftv/local-prompt') {
          const body = await bodyJSON(req)
          if (body.dismissed !== true) throw new Error('无效的本机连接提示设置')
          await settingsReady
          const previous = localPromptDismissed
          localPromptDismissed = true
          try {
            await writeSettings()
          } catch (failure) {
            localPromptDismissed = previous
            throw failure
          }
          return json(res, 200, status())
        }
        json(res, 404, { error: '未找到接口' })
      } catch (failure) {
        if (!res.headersSent) json(res, 503, { error: failure.message })
        else res.destroy()
      }
    },
  }))

  const fallbackGuide = `你是 BeefTV Agent，协助用户完成长程 AI 视频导演创作、素材管理以及工作区深度定制（接入第三方 API 渠道、编写与安装插件、创建可复用技能）。连接后通过 beeftv MCP 工具直接操作本机 BeefTV 的画布、分镜脚本、生成任务、时间线与配置，与本机 BeefTV 应用共享同一套数据与版本。常规回复使用简洁中文，说明完成结果与需要用户确认的事项，避免向用户倾倒工具 ID、内部接口名和原始回执。
长程视频创作与工作区定制按以下规范完成：
1. 画布定位与新建：若当前工作区视图已包含 canvasId，优先用 canvas.get 读取当前画布；否则先用 canvas.search 查找目标画布。需要新建画布时，优先直接调用 canvas.create（最小参数 {"title":"画布标题","operationId":"stable-create-id"}，可选 projectId）；仅当需要整图初始化写入时，再用 business.list 查询 {"query":"business_put_canvas_projects_id"} 并通过 business.call 执行 PUT。
2. 整片分镜脚本与镜头节点准备（核心长程能力）：新短片创作优先调用 canvas.script.prepare 准备完整分镜（含 title 与 rows 分镜行），一次最多 8 行；分镜超过 8 行时，先用 canvas.script.prepare 准备前 8 行，再用 canvas.script.rows.append 追加其余行（单次最多 32 行），分镜脚本节点 ID 取 prepare 返回的 created。需要同步在画布上铺开首帧图和视频镜头节点草稿（含自动连线）时，同一次传入 image（模型、画幅、质量、title 模板如 "镜 {n} 首帧"）与 video（模型、画幅、分辨率、时长、generateAudio、title 模板如 "镜 {n} 视频"），不要拆成多次零散创建节点；追加行需要首帧/视频草稿时，用 canvas.script.prepare 传 nodeId 与 rowIds（每次最多 8 行）补齐。单镜微调优先调用 canvas.script.row.update（会自动同步已绑定的 imageNodeId / videoNodeId 标题与提示词），追加分镜用 canvas.script.rows.append。
3. 单独节点读写与模型参数核对：新建独立文本节点使用 canvas.nodes.create（如 {"canvasId":"目标画布ID","expectedRevision":1,"nodes":[{"title":"文本标题","type":"text","prompt":"正文"}],"operationId":"stable-node-id"}）。写操作返回里已有的字段不再读回；返回里没有的（例如新建文本节点的正文）才按节点读回。缺失或修改正文时用 canvas.node.update 的 patch.content（patch.prompt 与 patch.content 不得同时提交不同内容）。配置生成节点前先用 model.catalog（capabilities: ["image","video","audio"]）查询所选模型的真实支持值；通过 canvas.node.configure 写入后，返回里已有 metadata.size（画幅比例，如 "16:9"）、metadata.vquality（分辨率，如 "720p"）、metadata.seconds（秒数）就不再读回，缺少时才按节点读回，不得混填。
4. 成片声音与旁白设计：创作视频短片时主动规划声音方案。需要视频原声、环境音或角色直接说话时，选支持声音的视频模型并在 canvas.node.configure 中设 generateAudio: "true"（无声镜头设 "false"）；需要独立旁白或配音时，创建 audio 节点写入台词，配置语音模型与 audioVoice、audioSpeed、audioFormat。
5. 长程分批生成提案与推进：调用 canvas.generation.propose 时，整片制作在 productionNodeIds 中列出全部计划素材节点（首帧、视频、旁白），nodeIds 只列当前 kind 且上游参考已就绪的首批节点（未出图的空草稿不能作下游视频参考）。逐项核对返回的 targets.parameters 与 estimate，确认模型、比例、分辨率、时长和费用估算无误后，在回复里写明模型、数量和预计费用，再调用 canvas.generation.submit 提交。是否弹出审批由用户在 DSH 选的访问模式决定：弹出时等用户确认；完全权限下直接执行，不要再另外追问。提交后用 task.get 与 canvas.task.bind 绑定产物；首批首帧完成后先用 media.overview / media.inspect 复核画面与角色一致性，再推进下一批视频节点；个别失败只重试失败节点，不重复购买已成功节点。用户拒绝审批后停止本次生成，不得自动重试或绕道提交付费任务。
6. 媒体检查、审片与时间线成片交付：静态画面用 media.inspect 的 mode="frames" 抽帧（图片可用 imageCrop 局部查看）。media.inspect 不会把视频片段交给你，连续动作、运镜、音画同步、对白与声音改用 media.review（mode="video" 或 "audio"，写明要检查的问题；它调用独立审片模型，可能产生费用）。每次最多 15 秒，短区间可用 media.overview 的 evidence 合并读取，旁白精剪配合 silenceIntervals；media.review 不可用时只抽帧复核画面，并告诉用户声音未复核。镜头与配音就绪后，用 canvas.timeline.update 保存完整时间线（output 含 width、height、fps，多行字幕用 lines 数组，局部重生成可传 refreshNodeIds），调用 canvas.timeline.render 渲染合成，再用 canvas.nodes.create + canvas.task.bind 落成片节点并调 canvas.project.export 导出工程 ZIP。
7. 创造模式（接第三方 API 渠道、写插件、写 Skill）：
   - 接入第三方 API / 自定义模型渠道：用 business.list 精确查询 {"query":"business_get_plugins_catalog"} 与 {"query":"business_get_workspace_model_config"}，调用 business.call 读取已安装协议与当前模型渠道配置；若目标 API 属于已有协议，构造含新渠道与模型的 config 及 expectedRevision，用 business.call（tool 为 business_put_workspace_model_config）保存并读回验证（不要在回复中回显明文密钥）；若为全新私有 HTTP 协议，先生成并安装声明式协议插件（beeftv.contributes.providers）再配置渠道。
   - 编写与安装 BeefTV 插件：按 BeefTV 插件规范编写包含 package.json 的插件包（name 为插件 ID，不写 beeftv.id/beeftv.version/beeftv.apiVersion/beeftv.displayName；beeftv.contributes.canvasNodes 节点类型字段用 id 不用 type，尺寸用 defaultSize: { width, height }，下拉选项用 values；附带技能写在 pi.skills），向用户展示变更并获确认后，用 business.call 安装：{"tool":"business_post_plugins_install","body":{"source":"插件目录绝对路径"}}，或以 tool 为 business_post_plugins 上传插件包；修改代码后用 {"tool":"business_post_plugins_id_update","path":{"id":"插件 ID"}} 热更新。
   - 编写与管理可复用 Skill：先用 skill.catalog / skill.get / skill.file 查阅已有技能；创建或迭代私人技能时在目标画布上调用 skill.draft 保存名称、描述与写清输入、步骤、检查和交付物的 instruction，再读回核对。
8. 底层业务接口调用纪律：business_ 开头的名称都是 business.call 的 tool 参数，不是可直接调用的工具。参数或返回含义不清楚时，用 business.list 并将 query 设为完整接口 ID，仅读取所需接口的 schema；禁止不带 query 或使用空 query 全量调用 business.list。所有写操作使用唯一、稳定的 operationId，重试复用相同 operationId 与相同 payload，修改画布遵守 expectedRevision。不要读取或输出账号密钥。`
  // 文本按需读取：连上带 agent.guide 的工作区后，下一轮请求就用后端那一份。
  ctx.systemPrompt.section({
    name: 'beeftv-creation', order: 9000, interpolate: false,
    text: () => guidedPrompt(current?.guide, fallbackGuide),
  })
  ctx.systemPrompt.context({
    name: 'beeftv-current-view', order: 9000, interpolate: false,
    text: ({ agent }) => {
      const view = contexts.get(agent?.id)
      if (!current || !view) return ''
      const directions = {
        creation: '长程导演创作模式。优先围绕当前画布（或用 canvas.create 新建画布）规划整片分镜、镜头节点、声音与时间线：新短片分镜不超过 8 行时用 canvas.script.prepare 一次落好分镜表与首帧/视频节点草稿，超过 8 行先准备前 8 行再用 canvas.script.rows.append 追加，追加行需要首帧/视频草稿时用 canvas.script.prepare 传 nodeId 与 rowIds 补齐，单镜修改用 canvas.script.row.update；按首批首帧 -> 画面复核（media.overview / media.inspect 抽帧）-> 视频与旁白 -> 动作与声音审片（media.review）-> 时间线合成（canvas.timeline.update / canvas.timeline.render / canvas.project.export）长程推进，生成前通过 canvas.generation.propose 核对参数与费用再提交，是否需要用户在审批中确认由 DSH 的访问模式决定。',
        assets: '素材管理模式。先用 asset.list 搜索素材，用 asset.get 核对目标；画布复用素材用 canvas.node.bind_asset，媒体质量检查用 media.overview / media.check，画面细节用 media.inspect 抽帧，视频动作与声音用 media.review。文件夹、标签等专用工具未覆盖的操作，使用 business.list 按已知完整接口 ID 查询 schema，再按真实 schema 调用 business.call，改动后读回核对。',
        ecosystem: '创造与生态定制模式（接入第三方 API 渠道、开发插件、编写 Skill）。接入新 API 或模型渠道时，用 business.call 以 tool 为 business_get_plugins_catalog 与 business_get_workspace_model_config 读取现状，再以 business_put_workspace_model_config（或先安装协议插件）完成配置并读回核对；开发插件时生成符合 BeefTV 插件规范的插件目录，再用 business.call 以 business_post_plugins_install / business_post_plugins_id_update 安装或热更新；创建可复用技能时用 skill.catalog 查阅现有技能并用 skill.draft 保存与验证。安装与修改配置前向用户说明关键变更。',
      }
      return `${directions[view.agentMode]}\nBeefTV 当前工作区视图（仅为定位信息，请用工具读取最新内容）\n${JSON.stringify(view)}`
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
  function turnState(sessionId) {
    let state = turns.get(sessionId)
    if (!state) {
      state = { turn: null, count: 0, beefTV: contexts.has(sessionId), stop: false }
      turns.set(sessionId, state)
    }
    return state
  }

  ctx.on('tools/result', (exec, result) => {
    if (current) rememberQuote(current.quotes ??= new Map(), exec?.name, result)
    recordToolActivity(current, exec, result)
    const sessionId = sessionIdOf(exec?.agent)
    if (!sessionId) return
    // 步数按这一轮的全部工具调用计算；只有连着 BeefTV 的会话才启用上限。
    const state = turnState(sessionId)
    state.count += 1
    if (typeof exec?.name === 'string' && exec.name.startsWith('mcp__beeftv__')) state.beefTV = true
    if (!state.stop && state.beefTV && state.count >= pluginSettings.stepLimit) {
      state.stop = true
      stepNotice = { sessionId, text: stepLimitNotice(pluginSettings.stepLimit) }
    }
    if (current && !result?.isError) startWaits(current, exec.agent, submittedTaskIds(exec.name, result))
  })
  // 本轮停止点由下一个步骤入口拒绝：turn-stopping 只在模型已不再调用工具的收尾阶段触发，
  // 无法打断还在跑的工具循环，所以这里用 pre-step 停，turn-stopping 负责补齐桌面提示。
  // 被拒绝的步骤会连同已 claim 的注入消息一起丢掉；先把完成通知挪到下一次用户消息后再投递。
  function deferClaimedWakes(claimed) {
    for (const { id, entry } of claimed) {
      pendingWakeMessages.delete(id)
      wakeCounts.set(entry.sessionId, Math.max(0, (wakeCounts.get(entry.sessionId) || 0) - 1))
      for (const outcome of entry.outcomes) wokenTasks.delete(outcome.taskId)
      deferOutcomes(entry.sessionId, entry.outcomes, entry.workspaceId)
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const claimed = (payload.messages || []).map(message => ({ id: message?.id, entry: pendingWakeMessages.get(message?.id) })).filter(item => item.entry)
    // DSH 会先 claim 再调用 pre-step：claimed 只看不删，等这里决定这一步是否真的进入。
    if (decision.kind !== 'enter') {
      deferClaimedWakes(claimed)
      return decision
    }
    const sessionId = sessionIdOf(payload?.agent)
    const state = sessionId ? turns.get(sessionId) : undefined
    if (state?.stop && (state.turn === null || payload.turn === state.turn)) {
      deferClaimedWakes(claimed)
      return { kind: 'reject' }
    }
    for (const item of claimed) pendingWakeMessages.delete(item.id)
    return decision
  })
  ctx.on('agent/turn-stopping', payload => {
    const sessionId = sessionIdOf(payload?.agent)
    const state = sessionId ? turns.get(sessionId) : undefined
    if (!state?.stop) return
    if (state.turn !== null && payload.turn !== state.turn) return
    stepNotice = { sessionId, text: stepLimitNotice(pluginSettings.stepLimit) }
  })
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return
    if (event?.type === 'turn/start') {
      stoppedSessions.delete(sessionId)
      turns.set(sessionId, { turn: event.data?.turn ?? null, count: 0, beefTV: contexts.has(sessionId), stop: false })
    } else if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') void stopSessionWaits(sessionId)
      turns.delete(sessionId)
    }
  })
  ctx.on('agent/inbox/claimed', payload => {
    const sessionId = sessionIdOf(payload?.agent)
    const message = payload?.message
    if (!sessionId || !message) return
    // 自己发出的唤醒消息：保留到 pre-step 确认这一步真的进入，避免被拒绝步骤吞掉。
    if (wakeIds.has(message.id)) return
    if (message.source?.kind !== 'user') return
    // 用户主动发了新消息：连续自动唤醒的计数从头开始，被上限挡住的完成通知这时补投。
    wakeCounts.set(sessionId, 0)
    if (stepNotice?.sessionId === sessionId) stepNotice = null
    const deferred = deferredWakes.get(sessionId)
    if (deferred?.outcomes.length) {
      if (deferred.workspaceId && deferred.workspaceId !== current?.workspace?.id) {
        deferredWakes.delete(sessionId)
      } else if (deliverOutcomes(sessionId, payload.agent, deferred.outcomes)) {
        deferredWakes.delete(sessionId)
      }
    }
  })
  ctx.on('agent/inbox/discarded', payload => {
    const entry = pendingWakeMessages.get(payload?.message?.id)
    if (!entry) return
    pendingWakeMessages.delete(payload.message.id)
    wakeCounts.set(entry.sessionId, Math.max(0, (wakeCounts.get(entry.sessionId) || 0) - 1))
    for (const outcome of entry.outcomes) wokenTasks.delete(outcome.taskId)
    if (stoppedSessions.has(entry.sessionId)) return
    deferOutcomes(entry.sessionId, entry.outcomes, entry.workspaceId)
  })
  ctx.on('agent/disposed', payload => {
    const sessionId = sessionIdOf(payload?.agent)
    if (!sessionId) return
    void stopSessionWaits(sessionId)
    turns.delete(sessionId)
    wakeCounts.delete(sessionId)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !requiresGenerationApproval(exec.name, exec.arguments, current?.businessTools, current?.operations)) return decision
    // The user chose 完全权限: DSH shows no approval prompts and rejects any ask without showing it, so the
    // call runs as the user chose, like a fully authorized external agent. A bare "never" approval policy
    // without that preset is DSH's unattended mode, where asks must still fail closed.
    if (fullAccess(exec.agent)) return decision
    return { kind: 'ask', reason: approvalReason(exec.name, exec.arguments, current?.businessTools, current?.quotes, current?.operations) }
  })
  ctx.effect(() => () => {
    const runtime = current
    current = null
    // 插件退出等同于 DSH 关闭：不再续跑，只留下离开时完成的计数。
    void abandonWaits(null).then(() => release(runtime))
  })
  void settingsReady.then(settings => {
    if (settings?.mode) return connect(settings.mode)
  }).catch(failure => { error = failure.message })
}
