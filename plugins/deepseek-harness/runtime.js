import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('.', import.meta.url))

const mcpOperationName = id => `mcp__beeftv__${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
const mcpToolBase = name => typeof name === 'string' ? name.replace(/_[a-f0-9]{12}$/, '') : ''
const mediaReviewTool = mcpOperationName('media.review')

// The catalog describes reads that still cost money (replay: unsafe). A catalog entry for the
// known paid review, or a missing entry, must never silently skip approval.
export function unsafeOperation(name, operations = []) {
  const tool = mcpToolBase(name)
  if (tool === mediaReviewTool) return { id: 'media.review', readOnly: true, replay: 'unsafe' }
  const catalog = Array.isArray(operations) ? operations : []
  const matched = catalog.find(operation => mcpOperationName(String(operation?.id || '')) === tool)
  return matched?.readOnly === true && matched.replay === 'unsafe' ? matched : undefined
}

function secondsLabel(milliseconds) {
  const value = Number(milliseconds)
  if (!Number.isFinite(value) || value < 0) return null
  return String(Math.round(value / 100) / 10)
}

// Names what the review will inspect. The review has no quote, so no amount appears.
export function reviewApprovalReason(args = {}) {
  const start = secondsLabel(args?.startMs)
  const end = secondsLabel(args?.endMs)
  const segment = start === null || end === null || Number(end) <= Number(start) ? '' : `片段：${start}–${end} 秒。`
  const model = typeof args?.model === 'string' ? args.model.trim().slice(0, 80) : ''
  return `审片会调用审片模型，可能收费。${segment}${model ? `模型：${model}。` : ''}`
}

export function requiresGenerationApproval(name, args, businessTools = [], operations = []) {
  if (/^mcp__beeftv__canvas_generation_submit(?:_[a-f0-9]{12})?$/.test(name)) return true
  if (unsafeOperation(name, operations)) return true
  if (!/^mcp__beeftv__business_call(?:_[a-f0-9]{12})?$/.test(name)) return false
  const tool = businessTools.find(item => item.id === args?.tool)
  return !(tool?.readOnly === true && tool.submitsGeneration === false)
}

const proposeToolName = /^mcp__beeftv__canvas_generation_propose(?:_[a-f0-9]{12})?$/
const generationUnits = { image: ['张', '图片'], video: ['段', '视频'], audio: ['段', '音频'] }

// Keeps BeefTV's own quote for each proposal, so the approval card can say what the user pays for.
export function rememberQuote(quotes, name, result) {
  if (result?.isError || !proposeToolName.test(name)) return
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text : undefined
  let quote
  try {
    quote = JSON.parse(text)?.result
  } catch {
    return
  }
  if (typeof quote?.proposalId !== 'string' || !quote.proposalId) return
  quotes.delete(quote.proposalId)
  quotes.set(quote.proposalId, quote)
  // Bounded so a long session does not keep every quote it ever saw.
  while (quotes.size > 50) quotes.delete(quotes.keys().next().value)
}

// Text for the DSH approval card. It names only the nodes this submission sends: a proposal can be
// submitted again for a subset, such as retrying failed nodes. Prices are BeefTV's per-node quotes.
export function approvalReason(name, args, businessTools = [], quotes = new Map(), operations = []) {
  const unsafe = unsafeOperation(name, operations)
  if (unsafe) {
    return unsafe.id === 'media.review'
      ? reviewApprovalReason(args)
      : `BeefTV 将执行只读操作 ${unsafe.id}，可能调用外部模型并产生费用。请核对本次操作。`
  }
  if (!/^mcp__beeftv__canvas_generation_submit(?:_[a-f0-9]{12})?$/.test(name)) {
    const business = businessTools.find(tool => tool.id === args?.tool)
    return business
      ? `BeefTV 请求执行 ${business.method} ${business.path}${business.submitsGeneration ? '，将提交可能计费的生成任务' : '，将修改工作区'}。请核对本次操作。`
      : 'BeefTV 将提交生成或未识别的业务操作，可能修改工作区或产生费用，请核对本次操作。'
  }
  const quote = quotes.get(args?.proposalId)
  const submitted = Array.isArray(args?.nodeIds) ? args.nodeIds : []
  const quoted = Array.isArray(quote?.targets) ? quote.targets : []
  const targets = quoted.filter(target => submitted.includes(target?.nodeId))
  if (!quote || !submitted.length || targets.length !== new Set(submitted).size) {
    return 'BeefTV 将提交付费生成，但这次提交和已有报价对不上，无法显示费用。可以先拒绝，让 Agent 重新报价后再提交。'
  }
  const kinds = [...new Set(targets.map(target => target.kind))]
  const [unit, label] = kinds.length === 1 ? generationUnits[kinds[0]] || ['项', '生成'] : ['项', '生成']
  const amount = targets.reduce((sum, target) => sum + (target.kind === 'image' ? Number(target.parameters?.count) || 1 : 1), 0)
  const models = [...new Set(targets.map(target => target.model).filter(model => typeof model === 'string' && model))]
  const priced = targets.filter(target => Number.isFinite(target.estimate?.amount))
  const cost = targets.length === quoted.length && typeof quote.estimate?.text === 'string' && quote.estimate.text
    ? quote.estimate.text.replace(/[。.]+$/, '')
    : priced.length === targets.length
      ? `预计费用：¥${Number(priced.reduce((sum, target) => sum + target.estimate.amount, 0).toFixed(4))}`
      : priced.length ? '部分费用按所选渠道实际计费' : '费用按所选渠道实际计费'
  return `BeefTV 将生成 ${amount} ${unit}${label}${models.length ? `（${models.join('、')}）` : ''}。${cost}。`
}

// ---- 生成完接着做：设置、任务判定与唤醒文案 ----

export const defaultPluginSettings = Object.freeze({ autoContinue: true, stepLimit: 40 })
export const minimumStepLimit = 5
export const maximumStepLimit = 200
export const maximumWakesPerSession = 3

// 设置文件来自本机磁盘，读坏或旧字段都以默认值继续，避免插件整体不可用。
export function normalizeSettings(value) {
  const autoContinue = typeof value?.autoContinue === 'boolean' ? value.autoContinue : defaultPluginSettings.autoContinue
  const stepLimit = Number.isInteger(value?.stepLimit) && value.stepLimit >= minimumStepLimit && value.stepLimit <= maximumStepLimit
    ? value.stepLimit
    : defaultPluginSettings.stepLimit
  return { autoContinue, stepLimit }
}

// 设置写入入口比读取严格：界面只能提交合法值，拼错或越界直接拒绝。
export function validatedSettingsPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的插件设置')
  const patch = {}
  if ('autoContinue' in value) {
    if (typeof value.autoContinue !== 'boolean') throw new Error('生成完自动继续只能是开或关')
    patch.autoContinue = value.autoContinue
  }
  if ('stepLimit' in value) {
    if (!Number.isInteger(value.stepLimit) || value.stepLimit < minimumStepLimit || value.stepLimit > maximumStepLimit) {
      throw new Error(`每轮步数上限必须是 ${minimumStepLimit} 到 ${maximumStepLimit} 之间的整数`)
    }
    patch.stepLimit = value.stepLimit
  }
  if (!Object.keys(patch).length) throw new Error('没有要保存的设置')
  return patch
}

const submitToolPattern = /^mcp__beeftv__canvas_generation_submit(?:_[a-f0-9]{12})?$/

function resultPayload(result) {
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text : undefined
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed
  } catch {
    return null
  }
}

// 成功提交的返回里可能有 taskIds（整批）或 taskId（单个）。重复提交复用同一任务时也只认一次。
export function submittedTaskIds(name, result) {
  if (!submitToolPattern.test(name) || result?.isError) return []
  const payload = resultPayload(result)
  const values = Array.isArray(payload?.taskIds) ? payload.taskIds : payload?.taskId ? [payload.taskId] : []
  return [...new Set(values.filter(id => typeof id === 'string' && id))]
}

function taskPhase(task) {
  return typeof task?.outcome?.phase === 'string' ? task.outcome.phase : ''
}

function resultStateReady(task) {
  if (typeof task?.resultState !== 'string' || !task.resultState) return true
  const normalized = task.resultState.toLowerCase()
  return normalized === 'ready' || normalized === 'succeeded'
}

function taskSaved(task) {
  if (task?.status !== 'succeeded') return false
  const phase = taskPhase(task)
  if (phase && phase !== 'ready') return false
  if (!resultStateReady(task)) return false
  return Boolean(task.outputs?.length && task.outputs.every(output => output?.resourceId && !output?.materializationErrorCode))
}

// 与内置 await-business-tasks 一致：任务本身成功但产物没能保存，是「未完成入库」，
// 不是生成失败；这类结果只能恢复保存，不能重新生成。
function taskIncomplete(task) {
  if (task?.status !== 'succeeded') return false
  const phase = taskPhase(task)
  if (phase === 'failed') return true
  if (typeof task?.resultState === 'string' && task.resultState.toLowerCase() === 'failed_permanent') return true
  if (phase === 'fetching' || phase === 'retrievable') return false
  return Boolean(task?.outputs?.length && task.outputs.every(output => output?.resourceId || output?.materializationErrorCode) &&
    task.outputs.some(output => output?.materializationErrorCode))
}

function taskFailed(task) {
  if (task?.status === 'cancelled') return true
  const phase = taskPhase(task)
  if (phase === 'retrievable' || phase === 'fetching' || phase === 'running') return false
  return task?.status === 'failed'
}

function failureReason(task) {
  const error = task?.error
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : typeof error?.msg === 'string' ? error.msg
    : typeof task?.reason === 'string' ? task.reason : typeof task?.note === 'string' ? task.note : ''
  if (message) return message.replace(/\s+/g, ' ').slice(0, 120)
  const materialized = Array.isArray(task?.outputs) && task.outputs.find(output => output?.materializationErrorCode)
  if (materialized) return String(materialized.materializationErrorCode).slice(0, 120)
  if (task?.status === 'cancelled') return '已取消'
  return ''
}

// 判定照搬内置 await-business-tasks：成功、产物已保存、可绑定才算完成。
export function taskOutcome(task, taskId = task?.taskId) {
  if (taskSaved(task)) return { taskId, state: 'succeeded', reason: '' }
  if (taskFailed(task)) return { taskId, state: 'failed', reason: failureReason(task) }
  if (taskIncomplete(task)) return { taskId, state: 'incomplete', reason: '结果尚未保存，只能恢复保存，不能重新生成' }
  return { taskId, state: 'pending', reason: '' }
}

// task.wait 超时返回 pending；任务详情退回用同一套判定，不把暂时读不到当成失败。
export function waitOutcome(value, taskId) {
  const status = typeof value?.status === 'string' ? value.status : ''
  // task.wait 自己负责「成功、产物已保存」的判定；这里只读它的结论，不再用 task.get 的字段重算。
  const listed = Array.isArray(value?.tasks) ? value.tasks.find(task => task?.taskId === taskId) || value.tasks[0] : undefined
  if (status === 'succeeded') return { taskId, state: 'succeeded', reason: '' }
  if (status === 'incomplete') {
    const original = failureReason(listed || value?.task || value)
    const base = '结果尚未保存，只能恢复保存，不能重新生成'
    return { taskId, state: 'incomplete', reason: original ? `${base}（${original}）` : base }
  }
  if (status === 'failed') return { taskId, state: 'failed', reason: failureReason(listed || value?.task || value) }
  if (status === 'pending') return { taskId, state: 'pending', reason: '' }
  if (value && typeof value === 'object' && ('status' in value || 'taskId' in value)) return taskOutcome(value, taskId)
  return { taskId, state: 'pending', reason: '' }
}

export function awaitWakeText(outcomes) {
  const taskIds = [...new Set(outcomes.map(outcome => outcome.taskId))]
  const failed = outcomes.filter(outcome => outcome.state === 'failed')
  const incomplete = outcomes.filter(outcome => outcome.state === 'incomplete')
  const succeeded = outcomes.length - failed.length - incomplete.length
  const parts = []
  if (failed.length) {
    const reason = failed.map(outcome => outcome.reason).find(Boolean)
    parts.push(`${failed.length} 个失败${reason ? `（${reason}）` : ''}`)
  }
  if (incomplete.length) {
    // 结果没入库不是生成失败，固定写明只能恢复保存，避免模型重新提交。
    const reason = incomplete.map(outcome => outcome.reason).find(Boolean) || '结果尚未保存，只能恢复保存，不能重新生成'
    parts.push(`${incomplete.length} 个结果未保存（${reason}）`)
  }
  const detail = parts.length ? `，${parts.join('，')}` : ''
  return `生成已结束：${succeeded} 个成功${detail}。任务：${taskIds.join('、')}。请只查询结果、绑定到节点并继续，不要重新提交。`
}

export function stepLimitNotice(limit) {
  return `这一轮已经做了 ${limit} 步，先停一下。要继续请再说一句。`
}

export function awayGenerationNotice(count) {
  return count > 0 ? `有 ${count} 个生成在你离开时完成。` : ''
}

// agent.guide 是可选的只读操作。有它时整段替换插件的说明，只补 DSH 独有的两句。
export const maximumGuideChars = 100_000

export function guidedPrompt(guide, fallback) {
  const text = typeof guide?.text === 'string' ? guide.text.trim() : ''
  // 异常超长的说明会挤掉工具定义和对话空间，宁可用插件内置的那份。
  if (!text || text.length > maximumGuideChars) return fallback
  return `${text}\n在 DeepSeek Harness 中，BeefTV 工具名带 mcp__beeftv__ 前缀。付费生成是否需要用户确认由 DSH 的访问模式决定：弹出审批时等用户确认，完全权限下直接执行，不要另外追问。`
}

export function runtimeRecord(value) {
  for (const key of ['bridgeURL', 'baseURL']) {
    const url = new URL(value?.[key])
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('工作区地址必须为本机回环地址')
  }
  if (typeof value.bridgeToken !== 'string' || !value.bridgeToken) throw new Error('工作区未返回桥接凭据')
  return value
}

export function embeddedDocument(html, basePath, parentOrigin = '*') {
  const config = JSON.stringify({ embedded: true, apiBase: `${basePath}/api`, basePath, parentOrigin }).replaceAll('<', '\\u003c')
  // The asset page's stacking context otherwise puts its narrow sidebar below the dismiss scrim.
  const styles = `<style>
html .app-workspace-shell:has(.assets-library-page) .app-workspace-main-row{z-index:auto}
/* Only top controls avoid the host overlay. The page and canvas remain full width. */
html .canvas-topbar{padding-left:calc(8px + var(--beeftv-host-leading,0px))!important}
html .app-user-workspace .app-workspace-floating-menu{left:calc(12px + var(--beeftv-host-leading,0px))!important}
/* A full sidebar stays in place. Its brand row can sit below the host controls. */
html[data-beeftv-host-chrome] .app-workspace-sidebar-brand-row,
html[data-beeftv-host-chrome] .app-workspace-sidebar-rail-header{margin-top:48px}
</style>`
  const bridge = `<script>(${embeddedChromeBridge.toString()})()</script>`
  return html.replace(/<base\b[^>]*>/gi, '').replace(/<head[^>]*>/i, match => `${match}<base href="${basePath}/"><meta name="referrer" content="no-referrer">${styles}<script>window.__BEEFTV_HARNESS__=${config}</script>${bridge}`)
}

// The parent only transmits bounded layout metrics, never workspace data or credentials.
function embeddedChromeBridge() {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'beeftv:host-chrome') return
    const leading = event.data.leading
    if (typeof leading !== 'number' || !Number.isFinite(leading) || leading < 0 || leading > 320) return
    document.documentElement.style.setProperty('--beeftv-host-leading', `${leading}px`)
    document.documentElement.toggleAttribute('data-beeftv-host-chrome', leading > 0)
  })
}

export function publicContext(value) {
  if (!value || typeof value.route !== 'string' || !value.route.startsWith('/') || value.route.startsWith('//') || value.route.length > 2048) throw new Error('无效的工作区上下文')
  const context = { route: value.route }
  for (const key of ['canvasId', 'canvasTitle']) {
    if (typeof value[key] === 'string') context[key] = value[key].slice(0, 256)
  }
  context.selectedNodeIds = Array.isArray(value.selectedNodeIds) ? value.selectedNodeIds.filter(id => typeof id === 'string').slice(0, 100).map(id => id.slice(0, 256)) : []
  return context
}

// Paths DeepSeek Harness manages itself. The embedded workspace page never reaches them.
const managedWorkspacePaths = ['/api/assistant', '/api/ops/clients', '/api/agent-clients']

// Judges the raw request path. URL parsers resolve encoded separators and dot segments differently
// from the Go bridge, so ambiguous spellings are refused instead of resolved. Returns 0, 400 or 403.
export function embeddedPathRejection(rawPath) {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\\#]|%(?:2f|5c|25)/i.test(rawPath)) return 400
  let path
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return 400
  }
  const segments = path.split('/').slice(1)
  if (segments.some((segment, index) => segment === '.' || segment === '..' || (segment === '' && index < segments.length - 1))) return 400
  // The bridge also serves the workspace under /beeftv/app, so that prefix is removed before matching.
  const effective = (path.replace(/^\/beeftv\/app(?=\/|$)/i, '') || '/').toLowerCase()
  return managedWorkspacePaths.some(managed => effective === managed || effective.startsWith(`${managed}/`)) ? 403 : 0
}

const localApp = {
  bundle: '/Applications/BeefTV.app',
  info: '/Applications/BeefTV.app/Contents/Info.plist',
  executable: '/Applications/BeefTV.app/Contents/MacOS/BeefTV',
  cli: '/Applications/BeefTV.app/Contents/MacOS/cli/beeftv',
}
// 2.2.0 is the first desktop release with the harness bridge. Older builds pass unknown flags to the
// GUI, so starting them with harness flags would open the desktop window instead of attaching.
const minimumLocalAppVersion = '2.2.0'

function supportsHarness(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '')?.slice(1).map(Number)
  if (!parts) return false
  const minimum = minimumLocalAppVersion.split('.').map(Number)
  const index = parts.findIndex((part, position) => part !== minimum[position])
  return index === -1 || parts[index] > minimum[index]
}

function bundleVersion(plist) {
  return new Promise(resolve => {
    execFile('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

export async function localAppStatus() {
  try {
    await Promise.all([access(localApp.executable, constants.X_OK), access(localApp.cli, constants.X_OK)])
  } catch {
    return { compatible: false, version: null, message: `未找到本机 BeefTV。请安装 ${minimumLocalAppVersion} 或更高版本后重新连接。` }
  }
  const version = await bundleVersion(localApp.info)
  if (supportsHarness(version)) return { compatible: true, version, message: null }
  return {
    compatible: false, version,
    message: version
      ? `本机 BeefTV 版本为 ${version}，需要 ${minimumLocalAppVersion} 或更高版本。请升级后重新连接。`
      : `无法读取本机 BeefTV 的版本。请重新安装 ${minimumLocalAppVersion} 或更高版本后重新连接。`,
  }
}

async function requireLocalApp() {
  const app = await localAppStatus()
  if (!app.compatible) throw new Error(app.message)
}

async function bundledPaths() {
  const contents = join(root, 'runtime', 'Contents')
  const paths = { executable: join(contents, 'MacOS', 'BeefTV'), cli: join(contents, 'MacOS', 'cli', 'beeftv') }
  try {
    await Promise.all(Object.values(paths).map(path => access(path, constants.X_OK)))
  } catch (error) {
    throw new Error('插件缺少内置的 BeefTV 运行时，请重新安装插件', { cause: error })
  }
  return paths
}

export async function startLocalRuntime() {
  await requireLocalApp()
  try {
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', localApp.bundle], { timeout: 10_000 }, error => {
        if (error) reject(error)
        else resolve()
      })
    })
  } catch (error) {
    throw new Error('无法打开本机 BeefTV，请确认 /Applications/BeefTV.app 已完整安装', { cause: error })
  }
  const deadline = Date.now() + 30_000
  let lastFailure
  while (Date.now() < deadline) {
    try {
      return await launchRuntime(localApp, { attachOnly: true })
    } catch (error) {
      lastFailure = error
    }
    await delay(250)
  }
  throw new Error('本机 BeefTV 尚未就绪，请检查桌面应用的启动提示后重新连接', { cause: lastFailure })
}

// Reconnects to a running desktop App without opening it again.
export async function attachLocalRuntime() {
  await requireLocalApp()
  return launchRuntime(localApp, { attachOnly: true })
}

// The standalone workspace only ever runs the runtime bundled with the plugin.
export async function startRuntime(dataDir) {
  return launchRuntime(await bundledPaths(), { dataDir })
}

async function launchRuntime(paths, { dataDir, attachOnly = false }) {
  const args = ['--harness-runtime']
  if (attachOnly) args.push('--harness-attach-only')
  if (dataDir) args.push('--data-dir', dataDir)
  const child = spawn(paths.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // Runtime logs stay out of model output and the browser. Readiness is the only stdout record.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  let ready = false
  const record = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('启动 BeefTV 超过 30 秒，请检查安装与工作区状态'))
    }, attachOnly ? 3_000 : 30_000)
    const fail = () => {
      if (ready) return
      clearTimeout(timer)
      reject(new Error('BeefTV 运行时启动失败，请确认安装完整且工作区未被旧版本占用'))
    }
    child.once('error', fail)
    child.once('exit', fail)
    lines.on('line', line => {
      if (ready) return
      try {
        const value = runtimeRecord(JSON.parse(line))
        ready = true
        clearTimeout(timer)
        resolve(value)
      } catch {
        // Go/native startup notices are not readiness records.
      }
    })
  }).catch(error => {
    lines.close()
    child.stdin.end()
    child.kill('SIGTERM')
    throw error
  })
  return {
    ...record, cli: paths.cli, child,
    close() {
      lines.close()
      child.stdin.end()
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (record.owned) child.kill('SIGTERM')
          resolve()
        }, record.owned ? 10_000 : 1_000)
        timer.unref()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

export async function workspaceJSON(runtime, path, options = {}) {
  const response = await fetch(`${runtime.bridgeURL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', 'X-Beeftv-Harness-Token': runtime.bridgeToken, ...options.headers },
  })
  const value = await response.json()
  if (!response.ok || value.code !== 0) throw new Error(value.msg || `BeefTV 请求失败 (${response.status})`)
  return value.data
}

export async function inspectWorkspace(runtime) {
  const [health, bootstrap] = await Promise.all([
    workspaceJSON(runtime, '/api/health'),
    workspaceJSON(runtime, '/api/workspace/bootstrap'),
  ])
  if (!health.ready || !health.schema?.ready || !health.build?.version || !bootstrap.workspace?.id) {
    throw new Error('BeefTV 工作区尚未就绪，请在本机应用中完成启动后重试')
  }
  if (String(runtime.version).replace(/^v/, '') !== health.build.version.replace(/^v/, '')) {
    throw new Error('BeefTV 连接版本已变化，请重新连接')
  }
  return {
    build: health.build,
    workspace: { id: bootstrap.workspace.id, name: bootstrap.workspace.name, storage: bootstrap.workspace.storage },
    contractVersion: bootstrap.contractVersion,
  }
}
