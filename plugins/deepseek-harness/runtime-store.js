// 托管 BeefTV 独立运行环境：流式下载、校验解压、原子切换与安全回收。
// 验签与下载源白名单位于 runtime-verify.js；解压至独立暂存目录后复检符号链接，通过后再原子切换。

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { compareSemver } from './platform-app.js'
import {
  DEFAULT_FEED_URL,
  DEFAULT_PUBLIC_KEY,
  isDomesticURL,
  MAX_FEED_BYTES,
  orderCandidateURLs,
  preferDomesticMirror,
  readBoundedText,
  validateRedirectURL,
  verifyFeedEnvelope,
} from './runtime-verify.js'

export {
  DEFAULT_FEED_URL,
  DEFAULT_PUBLIC_KEY,
  orderCandidateURLs,
  preferDomesticMirror,
  verifyFeedEnvelope,
}

export const ARCHIVE_SAFETY_ERROR_CODE = 'BEEFTV_UNSAFE_ARCHIVE'

function archiveSafetyError(message, options) {
  return Object.assign(new Error(message, options), { code: ARCHIVE_SAFETY_ERROR_CODE })
}

const FEED_TIMEOUT_MS = 20_000
const DOWNLOAD_STALL_TIMEOUT_MS = 45_000
const MANAGED_MARKER = '.beeftv-managed.json'

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  switch (key) {
    case 'darwin-arm64': return 'darwin-arm64'
    case 'darwin-x64': return 'darwin-amd64'
    case 'linux-x64': return 'linux-amd64'
    case 'win32-x64': return 'windows-amd64'
    default: return null
  }
}

export function minimumStandaloneVersion(platKey, env = process.env) {
  if (platKey === 'windows-amd64') {
    return env?.BEEFTV_HARNESS_MIN_WINDOWS_VERSION?.trim() || '2.4.3'
  }
  return '2.2.0'
}

function executableAccessMode(platKey) {
  return platKey === 'windows-amd64' ? constants.F_OK : constants.X_OK
}

export function runtimeLayouts(rootDir, platKey) {
  if (platKey === 'darwin-arm64' || platKey === 'darwin-amd64') {
    return [
      // 兼容开发者使用 package-runtime.mjs 打包的目录结构。
      {
        executable: join(rootDir, 'Contents', 'MacOS', 'BeefTV'),
        cli: join(rootDir, 'Contents', 'MacOS', 'cli', 'beeftv'),
      },
      // 官方发布 ZIP（desktop-update-v2.json）解压后的标准 .app 布局。
      {
        executable: join(rootDir, 'BeefTV.app', 'Contents', 'MacOS', 'BeefTV'),
        cli: join(rootDir, 'BeefTV.app', 'Contents', 'MacOS', 'cli', 'beeftv'),
      },
    ]
  }
  if (platKey === 'linux-amd64') {
    return [
      {
        executable: join(rootDir, 'BeefTV-linux', 'BeefTV'),
        cli: join(rootDir, 'BeefTV-linux', 'cli', 'beeftv'),
      },
      {
        executable: join(rootDir, 'BeefTV'),
        cli: join(rootDir, 'cli', 'beeftv'),
      },
    ]
  }
  if (platKey === 'windows-amd64') {
    return [
      {
        executable: join(rootDir, 'BeefTV.exe'),
        cli: join(rootDir, 'cli', 'beeftv.exe'),
      },
    ]
  }
  return []
}

export async function probeRuntimeDir(rootDir, platKey) {
  if (!rootDir || !platKey) return null
  const mode = executableAccessMode(platKey)
  for (const layout of runtimeLayouts(rootDir, platKey)) {
    try {
      await Promise.all([access(layout.executable, mode), access(layout.cli, mode)])
      return { ...layout, rootDir }
    } catch {
      // 尝试下一种布局。
    }
  }
  return null
}

function sourceLabelOf(rawURL) {
  return isDomesticURL(rawURL) ? '国内镜像' : '官方源'
}

function runCommand(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal }, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

function buildPowerShellExpandCommand(zipPath, targetDir) {
  const escapedZip = String(zipPath).replaceAll("'", "''")
  const escapedDest = String(targetDir).replaceAll("'", "''")
  return `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDest}' -Force`
}

// 运行包解压前已通过 Ed25519 签名、HTTPS 白名单与 SHA-256 校验；解压至独立暂存目录后仅做一次纯 Node 符号链接与路径归属复检。
export async function rejectExtractedSymlinks(targetDir) {
  const resolvedRoot = await realpath(targetDir)
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw archiveSafetyError(`安装包不能包含符号链接：${relative(resolvedRoot, fullPath)}`)
      }
      const entryReal = await realpath(fullPath)
      const rel = relative(resolvedRoot, entryReal)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw archiveSafetyError(`安装包解压路径越界：${relative(resolvedRoot, fullPath)}`)
      }
      if (entry.isDirectory()) await walk(fullPath)
    }
  }
  await walk(resolvedRoot)
}

export async function extractZipArchive(zipPath, targetDir, { platform = process.platform, signal, runCmd = runCommand } = {}) {
  await mkdir(targetDir, { recursive: true })
  try {
    if (platform === 'darwin') {
      await runCmd('/usr/bin/ditto', ['-xk', zipPath, targetDir], { signal })
    } else if (platform === 'win32') {
      try {
        await runCmd('tar.exe', ['-xf', zipPath, '-C', targetDir], { signal })
      } catch (error) {
        if (signal?.aborted) throw error
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
        await mkdir(targetDir, { recursive: true })
        await runCmd(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(buildPowerShellExpandCommand(zipPath, targetDir))],
          { signal },
        )
      }
    } else {
      try {
        await runCmd('unzip', ['-q', '-o', zipPath, '-d', targetDir], { signal })
      } catch (unzipError) {
        if (signal?.aborted) throw unzipError
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
        await mkdir(targetDir, { recursive: true })
        try {
          await runCmd('bsdtar', ['-xf', zipPath, '-C', targetDir], { signal })
        } catch (bsdtarError) {
          if (signal?.aborted) throw bsdtarError
          if (unzipError?.code === 'ENOENT' && bsdtarError?.code === 'ENOENT') {
            throw new Error('解压 BeefTV 运行环境失败：系统缺少 unzip，请先安装 unzip 后重试', { cause: unzipError })
          }
          throw bsdtarError?.code === 'ENOENT' ? unzipError : bsdtarError
        }
      }
    }
    await rejectExtractedSymlinks(targetDir)
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function ensureUnixExecutable(filePath) {
  try {
    const info = await stat(filePath)
    if ((info.mode & 0o111) === 0) await chmod(filePath, (info.mode & 0o777) | 0o755)
  } catch {
    // 交给随后的 probeRuntimeDir 报告缺失。
  }
}

function formatAbortError(error) {
  if (error?.code === 'BEEFTV_PROVISION_CANCELLED' || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    const cancelled = new Error('已取消准备 BeefTV 运行环境')
    cancelled.code = 'BEEFTV_PROVISION_CANCELLED'
    return cancelled
  }
  return error
}

async function downloadWithVerification(url, destPath, { expectedSize, expectedSha256, feedOrigin, fetchImpl, signal, onProgress }) {
  const stallController = new AbortController()
  let stallTimer = null
  const resetStall = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stallController.abort(new Error('下载超时')), DOWNLOAD_STALL_TIMEOUT_MS)
  }
  const combinedSignal = signal ? AbortSignal.any([signal, stallController.signal]) : stallController.signal
  resetStall()
  const hash = createHash('sha256')
  let downloaded = 0
  let lastProgressAt = 0
  let stream = null
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: combinedSignal })
    if (!response.ok || !response.body) {
      throw new Error(`下载失败 (HTTP ${response.status})`)
    }
    validateRedirectURL(response.url || url, feedOrigin)
    const headerTotal = Number(response.headers.get('content-length'))
    const total = expectedSize || (Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : 0)
    stream = createWriteStream(destPath, { mode: 0o600 })
    let streamError = null
    stream.once('error', error => { streamError = error })
    const reader = response.body.getReader()
    for (;;) {
      if (streamError) throw streamError
      resetStall()
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      downloaded += chunk.length
      if (expectedSize && downloaded > expectedSize) {
        throw new Error('下载文件体积超出清单声明')
      }
      hash.update(chunk)
      if (!stream.write(chunk)) {
        await new Promise((resolve, reject) => {
          if (streamError) { reject(streamError); return }
          const onDrain = () => { stream.off('error', onError); resolve() }
          const onError = error => { stream.off('drain', onDrain); reject(error) }
          stream.once('drain', onDrain)
          stream.once('error', onError)
        })
      }
      const now = Date.now()
      if (now - lastProgressAt >= 150 || (total && downloaded >= total)) {
        lastProgressAt = now
        onProgress?.({ downloadedBytes: downloaded, totalBytes: total })
      }
    }
    await new Promise((resolve, reject) => {
      stream.end(error => (error ? reject(error) : resolve()))
    })
    stream = null
    if (expectedSize && downloaded !== expectedSize) {
      throw new Error(`安装包大小不匹配（收到 ${downloaded} 字节，预期 ${expectedSize} 字节）`)
    }
    const actualSha256 = hash.digest('hex')
    if (actualSha256 !== expectedSha256) {
      throw new Error('安装包 SHA256 校验不通过')
    }
    onProgress?.({ downloadedBytes: downloaded, totalBytes: total || downloaded })
  } catch (error) {
    if (stream) {
      stream.destroy()
      stream = null
    }
    await rm(destPath, { force: true }).catch(() => {})
    if (signal?.aborted) throw formatAbortError(error)
    if (stallController.signal.aborted) throw new Error('下载连接超时，正在尝试备用源')
    throw error
  } finally {
    clearTimeout(stallTimer)
  }
}

async function readVersionFromDir(dir) {
  try {
    const info = JSON.parse(await readFile(join(dir, 'version.json'), 'utf8'))
    return typeof info?.version === 'string' ? info.version.trim() : null
  } catch {
    return null
  }
}

async function readManagedMarker(dirPath) {
  try {
    const data = JSON.parse(await readFile(join(dirPath, MANAGED_MARKER), 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

async function isManagedDir(dirPath) {
  return Boolean(await readManagedMarker(dirPath))
}

function emptyProvision() {
  return {
    phase: 'idle',
    version: null,
    downloadedBytes: 0,
    totalBytes: 0,
    percent: null,
    sourceLabel: null,
    error: null,
  }
}

export function createRuntimeStore({
  pluginHome,
  bundledDir,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  feedURL = env?.BEEFTV_HARNESS_FEED_URL || DEFAULT_FEED_URL,
  publicKey = env?.BEEFTV_HARNESS_PUBLIC_KEY || DEFAULT_PUBLIC_KEY,
  fetchImpl = globalThis.fetch,
  extractImpl = extractZipArchive,
} = {}) {
  const platKey = platformKey(platform, arch)
  const runtimesDir = pluginHome ? join(pluginHome, 'runtimes') : null
  const currentPointerPath = runtimesDir ? join(runtimesDir, 'current.json') : null
  const feedOrigin = (() => {
    try { return new URL(feedURL).origin } catch { return null }
  })()

  let provision = emptyProvision()
  let activeInstall = null
  let activeAbort = null
  let availableUpdate = null

  function unsupportedReason() {
    if (platKey) return null
    return `当前系统（${platform}/${arch}）暂不支持内置独立运行，请先在支持的平台上使用。`
  }

  async function readCurrentPointer() {
    if (!currentPointerPath) return null
    try {
      const data = JSON.parse(await readFile(currentPointerPath, 'utf8'))
      if (typeof data?.version !== 'string' || !data.version || typeof data?.dir !== 'string' || !data.dir) return null
      if (data.platform && platKey && data.platform !== platKey) return null
      return data
    } catch {
      return null
    }
  }

  async function discover() {
    if (!platKey) return null
    const overrideDir = env?.BEEFTV_HARNESS_RUNTIME_DIR?.trim()
    if (overrideDir) {
      const found = await probeRuntimeDir(overrideDir, platKey)
      if (found) {
        return { ...found, source: 'override', version: await readVersionFromDir(overrideDir) }
      }
    }
    const pointer = await readCurrentPointer()
    if (pointer) {
      const targetDir = join(runtimesDir, pointer.dir)
      const found = await probeRuntimeDir(targetDir, platKey)
      if (found) {
        return { ...found, source: 'managed', version: pointer.version, dirName: pointer.dir }
      }
    }
    if (bundledDir) {
      const found = await probeRuntimeDir(bundledDir, platKey)
      if (found) {
        return { ...found, source: 'bundled', version: await readVersionFromDir(bundledDir) }
      }
    }
    return null
  }

  async function fetchVerifiedFeed(signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('获取版本信息超时')), FEED_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const response = await fetchImpl(feedURL, { signal: combined })
      if (!response.ok) throw new Error(`读取 BeefTV 版本清单失败 (HTTP ${response.status})`)
      const text = await readBoundedText(response, MAX_FEED_BYTES)
      return verifyFeedEnvelope(text, publicKey, { feedURL })
    } catch (error) {
      if (signal?.aborted) throw formatAbortError(error)
      if (controller.signal.aborted) throw new Error('获取 BeefTV 版本信息超时，请检查网络连接后重试')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  function resolvePlatformArtifact(feed) {
    if (!platKey) throw new Error(unsupportedReason())
    const artifact = feed.platforms[platKey]
    if (!artifact) {
      throw new Error(`官方版本清单暂未包含当前系统（${platKey}）的运行包`)
    }
    const minimum = minimumStandaloneVersion(platKey, env)
    const compared = compareSemver(feed.version, minimum)
    if (compared === null || compared < 0) {
      throw new Error(`当前系统（${platKey}）独立运行需要 BeefTV ${minimum} 或更高版本，线上最新版本为 ${feed.version}。请等待正式版发布后重试。`)
    }
    return { version: feed.version, artifact }
  }

  async function writeCurrentPointer(version, dirName) {
    await mkdir(runtimesDir, { recursive: true, mode: 0o700 })
    const tmp = join(runtimesDir, `current.${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify({ version, dir: dirName, platform: platKey, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    await rename(tmp, currentPointerPath)
  }

  // 只清理带有 store 归属标记且不再使用的旧托管目录，以及空闲时的崩溃残留临时文件；绝不删用户预置目录。
  async function prune({ keepDirNames = [], includeTemps = false } = {}) {
    if (!runtimesDir || activeInstall) return
    const pointer = await readCurrentPointer()
    const keep = new Set([...keepDirNames.filter(Boolean), ...(pointer?.dir ? [pointer.dir] : [])])
    try {
      const entries = await readdir(runtimesDir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(runtimesDir, entry.name)
        if (entry.name.startsWith('.download-') || entry.name.startsWith('.staging-')) {
          if (includeTemps) await rm(fullPath, { recursive: true, force: true }).catch(() => {})
          continue
        }
        if (!entry.isDirectory() || entry.name.startsWith('.') || keep.has(entry.name)) continue
        if (await isManagedDir(fullPath)) {
          await rm(fullPath, { recursive: true, force: true }).catch(() => {})
        }
      }
    } catch {
      // 目录不存在或被短暂占用时忽略。
    }
  }

  async function writeManagedMarker(dirPath, { version, verified }) {
    const tmp = join(dirPath, `${MANAGED_MARKER}.${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify({ managedBy: 'dsh-beeftv', version, platform: platKey, verified: Boolean(verified) }), { mode: 0o600 })
    await rename(tmp, join(dirPath, MANAGED_MARKER))
  }

  async function activate(installed) {
    if (!installed?.dirName || !installed?.version || !runtimesDir) return
    const targetDir = join(runtimesDir, installed.dirName)
    const marker = await readManagedMarker(targetDir)
    if (marker?.managedBy === 'dsh-beeftv') {
      await writeManagedMarker(targetDir, { version: installed.version, verified: true })
    }
    await writeCurrentPointer(installed.version, installed.dirName)
    availableUpdate = null
  }

  async function discard(installed) {
    if (!installed?.dirName || !runtimesDir) return
    const pointer = await readCurrentPointer()
    if (pointer?.dir === installed.dirName) return
    const targetDir = join(runtimesDir, installed.dirName)
    const marker = await readManagedMarker(targetDir)
    if (marker?.managedBy === 'dsh-beeftv' && marker.verified !== true) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function installFromFeed({ signal, activate: shouldActivate = true } = {}) {
    if (!platKey) throw new Error(unsupportedReason())
    if (!runtimesDir) throw new Error('插件运行目录不可用')
    await mkdir(runtimesDir, { recursive: true, mode: 0o700 })

    provision = { ...emptyProvision(), phase: 'checking' }
    const feed = await fetchVerifiedFeed(signal)
    const { version, artifact } = resolvePlatformArtifact(feed)
    const dirName = `${version}-${platKey}`
    const finalDir = join(runtimesDir, dirName)

    const alreadyPresent = await probeRuntimeDir(finalDir, platKey)
    if (alreadyPresent) {
      const marker = await readManagedMarker(finalDir)
      // 未通过启动健康校验的托管目录视为坏版本，必须删除重下，防止独立工作区卡死在坏二进制上。
      if (marker?.managedBy === 'dsh-beeftv' && marker.verified !== true) {
        await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      } else {
        if (shouldActivate) {
          await writeCurrentPointer(version, dirName)
          availableUpdate = null
        }
        provision = emptyProvision()
        return { ...alreadyPresent, source: 'managed', version, dirName, staged: !shouldActivate }
      }
    }

    const candidates = orderCandidateURLs(artifact.urls, preferDomesticMirror({ env }))
    const zipPath = join(runtimesDir, `.download-${randomUUID()}.zip`)
    const stagingDir = join(runtimesDir, `.staging-${randomUUID()}`)
    try {
      let lastDownloadError = null
      let downloaded = false
      for (const candidate of candidates) {
        if (signal?.aborted) throw formatAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        const sourceLabel = sourceLabelOf(candidate)
        provision = {
          phase: 'downloading',
          version,
          downloadedBytes: 0,
          totalBytes: artifact.size,
          percent: 0,
          sourceLabel,
          error: null,
        }
        try {
          await downloadWithVerification(candidate, zipPath, {
            expectedSize: artifact.size,
            expectedSha256: artifact.sha256,
            feedOrigin,
            fetchImpl,
            signal,
            onProgress: ({ downloadedBytes, totalBytes }) => {
              const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null
              provision = { ...provision, downloadedBytes, totalBytes, percent }
            },
          })
          downloaded = true
          break
        } catch (error) {
          if (error?.code === 'BEEFTV_PROVISION_CANCELLED' || signal?.aborted) throw formatAbortError(error)
          lastDownloadError = error
        }
      }
      if (!downloaded) {
        throw new Error(`下载 BeefTV 运行环境失败：${lastDownloadError?.message || '请检查网络连接后重试'}`)
      }

      if (signal?.aborted) throw formatAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))

      provision = { ...provision, phase: 'extracting', percent: null }
      await extractImpl(zipPath, stagingDir, { platform, signal })
      if (platKey !== 'windows-amd64') {
        for (const layout of runtimeLayouts(stagingDir, platKey)) {
          await ensureUnixExecutable(layout.executable)
          await ensureUnixExecutable(layout.cli)
        }
      }
      const verified = await probeRuntimeDir(stagingDir, platKey)
      if (!verified) {
        throw new Error('解压后的 BeefTV 运行环境不完整，请重试')
      }
      await writeFile(join(stagingDir, 'version.json'), JSON.stringify({ version, platform: platKey }, null, 2), { mode: 0o600 }).catch(() => {})
      await writeManagedMarker(stagingDir, { version, verified: shouldActivate })

      await rm(finalDir, { recursive: true, force: true }).catch(() => {})
      await rename(stagingDir, finalDir)
      if (shouldActivate) {
        await writeCurrentPointer(version, dirName)
        availableUpdate = null
      }
      provision = emptyProvision()
      const installed = await probeRuntimeDir(finalDir, platKey)
      if (!installed) throw new Error('BeefTV 运行环境写入失败，请重试')
      return { ...installed, source: 'managed', version, dirName, staged: !shouldActivate }
    } finally {
      await rm(zipPath, { force: true }).catch(() => {})
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function ensureInstalled({ forceUpdate = false, activate: shouldActivate = true } = {}) {
    if (!forceUpdate) {
      const existing = await discover()
      if (existing) return existing
    }
    if (activeInstall) return activeInstall
    const controller = new AbortController()
    activeAbort = controller
    const job = installFromFeed({ signal: controller.signal, activate: shouldActivate }).catch(error => {
      const formatted = formatAbortError(error)
      provision = formatted.code === 'BEEFTV_PROVISION_CANCELLED'
        ? emptyProvision()
        : { ...provision, phase: 'error', error: formatted.message }
      throw formatted
    }).finally(() => {
      if (activeInstall === job) activeInstall = null
      if (activeAbort === controller) activeAbort = null
    })
    activeInstall = job
    return job
  }

  function cancel() {
    if (activeAbort) {
      provision = emptyProvision()
      activeAbort.abort()
      return true
    }
    if (provision.phase === 'error') provision = emptyProvision()
    return false
  }

  async function checkUpdate({ currentVersion = null, signal } = {}) {
    if (!platKey) return null
    const existing = await discover()
    const installedVersion = currentVersion || existing?.version || null
    if (!installedVersion) return null
    const feed = await fetchVerifiedFeed(signal)
    const { version, artifact } = resolvePlatformArtifact(feed)
    const cmp = compareSemver(version, installedVersion)
    if (cmp !== null && cmp > 0) {
      availableUpdate = { version, size: artifact.size }
      return availableUpdate
    }
    availableUpdate = null
    return null
  }

  async function status() {
    const existing = await discover()
    return {
      ready: Boolean(existing),
      source: existing?.source || null,
      version: existing?.version || null,
      platform: platKey,
      supported: Boolean(platKey),
      unsupportedReason: unsupportedReason(),
      updateAvailable: existing?.source === 'managed' ? availableUpdate : null,
    }
  }

  return {
    discover,
    ensureInstalled,
    activate,
    discard,
    cancel,
    prune,
    checkUpdate,
    status,
    provision: () => ({ ...provision }),
  }
}
