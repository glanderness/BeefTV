// BeefTV 托管运行包的安全边界与校验：Ed25519 验签、下载源与重定向白名单、流式上限读取。
// 零第三方依赖；规则与 Go 侧 backend/internal/desktopupdate 保持一致。

import { createPublicKey, verify as verifySignature } from 'node:crypto'

export const DEFAULT_FEED_URL = 'https://updates.beefapi.com/beeftv/desktop-update-v2.json'
// 与 BeefTV 正式发布更新源（desktop-update-v2.json）一致的公开 Ed25519 验签公钥。
export const DEFAULT_PUBLIC_KEY = 'Ehxax+TpPBDNNomS33+w1YiSemc0+GyaW+ePj9v+15Q='

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
export const MAX_FEED_BYTES = 1024 * 1024
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
// 与 backend/internal/desktopupdate/version.go 保持严格一致。
const STABLE_FEED_VERSION_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const GIT_SHA_RE = /^[0-9a-f]{40}$/i
const SHA256_RE = /^[0-9a-f]{64}$/i
export const KNOWN_PLATFORMS = new Set(['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])

// 与 backend/internal/desktopupdate/envelope.go 的 isKnownArtifactURL 保持严格一致。
const TRUSTED_DOWNLOAD_PATHS = new Map([
  ['updates.beefapi.com', '/beeftv/'],
  ['cnb.cool', '/beeftv-downloads/desktop/-/releases/download/'],
  ['beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com', '/beeftv/'],
])
const TRUSTED_REDIRECT_HOSTS = new Set([...TRUSTED_DOWNLOAD_PATHS.keys(), 'asset.cnb.cool'])

export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

export function isDomesticURL(rawURL) {
  try {
    const host = new URL(rawURL).hostname.toLowerCase()
    return host === 'cnb.cool'
      || host === 'asset.cnb.cool'
      || host === 'beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com'
  } catch {
    return false
  }
}

export function validateDownloadURL(rawURL, feedOrigin) {
  let parsed
  try {
    parsed = new URL(String(rawURL || '').trim())
  } catch {
    throw new Error('更新清单包含无效下载地址')
  }
  if (parsed.username || parsed.password) throw new Error('更新清单下载地址不允许包含凭据')
  if (parsed.search || parsed.hash) throw new Error('更新清单下载地址不允许包含查询参数或片段')
  if (feedOrigin && parsed.origin === feedOrigin && isLoopbackHost(parsed.hostname)) {
    return parsed.href
  }
  if (parsed.protocol !== 'https:') throw new Error('更新清单下载地址必须使用 HTTPS')
  const requiredPrefix = TRUSTED_DOWNLOAD_PATHS.get(parsed.hostname.toLowerCase())
  if (!requiredPrefix || !parsed.pathname.startsWith(requiredPrefix)) {
    throw new Error(`更新清单包含不受信任的下载来源：${parsed.hostname}`)
  }
  return parsed.href
}

// 与 backend/internal/desktopupdate/envelope.go 的 isKnownRedirectHost 保持严格一致。
export function validateRedirectURL(rawURL, feedOrigin) {
  let parsed
  try {
    parsed = new URL(String(rawURL || '').trim())
  } catch {
    throw new Error('下载地址重定向目标无效')
  }
  if (feedOrigin && parsed.origin === feedOrigin && isLoopbackHost(parsed.hostname)) {
    return parsed.href
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('下载地址重定向到了不安全的 HTTP 连接')
  }
  const host = parsed.hostname.toLowerCase()
  if (!TRUSTED_REDIRECT_HOSTS.has(host)) {
    throw new Error(`下载地址重定向到了不受信任的主机：${host}`)
  }
  return parsed.href
}

function parseEd25519PublicKey(publicKeyBase64) {
  const raw = Buffer.from(String(publicKeyBase64 || '').trim(), 'base64')
  if (raw.length !== 32) throw new Error('BeefTV 更新公钥格式无效')
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

export async function readBoundedText(response, maxBytes = MAX_FEED_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('更新清单体积异常')
  }
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('更新清单体积异常')
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const buf = Buffer.from(value)
    total += buf.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('更新清单体积异常')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export function verifyFeedEnvelope(rawText, publicKeyBase64 = DEFAULT_PUBLIC_KEY, { feedURL = DEFAULT_FEED_URL } = {}) {
  if (typeof rawText !== 'string' || Buffer.byteLength(rawText, 'utf8') > MAX_FEED_BYTES) {
    throw new Error('更新清单体积异常')
  }
  let envelope
  try {
    envelope = JSON.parse(rawText)
  } catch {
    throw new Error('更新清单格式无效')
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('更新清单签名无效')
  }
  const keys = Object.keys(envelope)
  if (keys.length !== 2 || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('更新清单签名无效')
  }
  const payloadBytes = Buffer.from(envelope.payload.trim(), 'base64')
  const signatureBytes = Buffer.from(envelope.signature.trim(), 'base64')
  if (!payloadBytes.length || signatureBytes.length !== 64) {
    throw new Error('更新清单签名无效')
  }
  const publicKey = parseEd25519PublicKey(publicKeyBase64)
  if (!verifySignature(null, payloadBytes, publicKey, signatureBytes)) {
    throw new Error('更新清单签名校验失败')
  }
  let payload
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('更新清单内容无效')
  }
  if (!payload || typeof payload !== 'object' || payload.schema !== 2) {
    throw new Error('更新清单版本不受支持')
  }
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (!STABLE_FEED_VERSION_RE.test(version)) throw new Error('更新清单版本号无效')
  if (typeof payload.commit !== 'string' || !GIT_SHA_RE.test(payload.commit.trim())) {
    throw new Error('更新清单提交信息不完整')
  }
  if (!payload.platforms || typeof payload.platforms !== 'object' || Array.isArray(payload.platforms)) {
    throw new Error('更新清单缺少平台安装包信息')
  }
  const feedOrigin = (() => {
    try { return new URL(feedURL).origin } catch { return null }
  })()
  const platforms = {}
  for (const [key, artifact] of Object.entries(payload.platforms)) {
    // 与 Go 端 envelope.go 一致：忽略未知平台条目，不阻断已知平台升级。
    if (!KNOWN_PLATFORMS.has(key)) continue
    if (!artifact || typeof artifact !== 'object') throw new Error(`更新清单 ${key} 安装包信息无效`)
    if (typeof artifact.url === 'string' && artifact.url.trim() !== '') {
      throw new Error(`更新清单 ${key} 安装包地址格式不受支持`)
    }
    if (!Array.isArray(artifact.urls) || !artifact.urls.length) {
      throw new Error(`更新清单 ${key} 缺少安装包地址`)
    }
    const seen = new Set()
    const urls = artifact.urls.map(item => {
      const validated = validateDownloadURL(item, feedOrigin)
      if (seen.has(validated)) throw new Error(`更新清单 ${key} 安装包地址重复`)
      seen.add(validated)
      return validated
    })
    const sha256 = typeof artifact.sha256 === 'string' ? artifact.sha256.trim().toLowerCase() : ''
    const size = Number(artifact.size)
    if (!SHA256_RE.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ARCHIVE_BYTES) {
      throw new Error(`更新清单 ${key} 安装包校验信息无效`)
    }
    platforms[key] = { urls, sha256, size }
  }
  if (!Object.keys(platforms).length) {
    throw new Error('更新清单缺少平台安装包信息')
  }
  return {
    schema: payload.schema,
    version,
    commit: payload.commit.trim(),
    platforms,
  }
}

export function preferDomesticMirror({ env = process.env, timeZone, locale } = {}) {
  const tz = String(timeZone ?? env?.TZ ?? (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' }
  })()).toLowerCase()
  if (/shanghai|chongqing|chungking|harbin|urumqi|kashgar|china standard time|prc/.test(tz)) {
    return true
  }
  const lang = String(locale ?? env?.LC_ALL ?? env?.LANG ?? (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().locale } catch { return '' }
  })()).toLowerCase().replaceAll('_', '-')
  if (/^zh-(tw|hk|mo|hant|sg)\b/.test(lang)) return false
  return /^zh(-cn|-hans)?\b/.test(lang)
}

export function orderCandidateURLs(urls, preferDomestic = preferDomesticMirror()) {
  if (!Array.isArray(urls) || urls.length <= 1) return [...(urls || [])]
  const primary = []
  const secondary = []
  for (const url of urls) {
    if (isDomesticURL(url) === preferDomestic) primary.push(url)
    else secondary.push(url)
  }
  return [...primary, ...secondary]
}
