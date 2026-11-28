// BeefTV 托管运行包的安全边界与校验：Ed25519 验签、下载源与重定向白名单、流式上限读取、ZIP 预检。
// 零第三方依赖；规则与 Go 侧 backend/internal/desktopupdate 保持一致。

import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { open } from 'node:fs/promises'

export const DEFAULT_FEED_URL = 'https://updates.beefapi.com/beeftv/desktop-update-v2.json'
// 与 BeefTV 正式发布更新源（desktop-update-v2.json）一致的公开 Ed25519 验签公钥。
export const DEFAULT_PUBLIC_KEY = 'Ehxax+TpPBDNNomS33+w1YiSemc0+GyaW+ePj9v+15Q='

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
export const MAX_FEED_BYTES = 1024 * 1024
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ZIP_ENTRIES = 50_000
const MAX_ZIP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
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

// 预检 ZIP Central Directory 与 Local File Header：拒绝 Zip Slip、绝对路径、符号链接、超大膨胀及 CD 计数欺骗。
export async function inspectZipSafety(zipPath) {
  const handle = await open(zipPath, 'r')
  try {
    const fileStat = await handle.stat()
    const fileSize = fileStat.size
    if (fileSize < 22) throw new Error('安装包文件不完整')
    const tailLen = Math.min(fileSize, 65_557)
    const tail = Buffer.alloc(tailLen)
    await handle.read(tail, 0, tailLen, fileSize - tailLen)

    let eocdPos = -1
    for (let offset = tailLen - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        const commentLen = tail.readUInt16LE(offset + 20)
        if (offset + 22 + commentLen === tailLen) {
          eocdPos = offset
          break
        }
      }
    }
    if (eocdPos < 0) throw new Error('安装包不是有效的 ZIP 文件')

    let entryCount = tail.readUInt16LE(eocdPos + 10)
    let cdSize = tail.readUInt32LE(eocdPos + 12)
    let cdOffset = tail.readUInt32LE(eocdPos + 16)

    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorPos = eocdPos - 20
      if (locatorPos < 0 || tail.readUInt32LE(locatorPos) !== 0x07064b50) {
        throw new Error('安装包的 ZIP64 目录无效')
      }
      const zip64Offset = Number(tail.readBigUInt64LE(locatorPos + 8))
      if (!Number.isSafeInteger(zip64Offset) || zip64Offset < 0 || zip64Offset + 56 > fileSize) {
        throw new Error('安装包的 ZIP64 偏移无效')
      }
      const z64 = Buffer.alloc(56)
      await handle.read(z64, 0, 56, zip64Offset)
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('安装包的 ZIP64 头无效')
      entryCount = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }

    if (!Number.isSafeInteger(entryCount) || entryCount <= 0 || entryCount > MAX_ZIP_ENTRIES) {
      throw new Error('安装包内文件数量超出安全限制')
    }
    if (!Number.isSafeInteger(cdOffset) || !Number.isSafeInteger(cdSize) || cdOffset < 0 || cdSize <= 0 || cdOffset + cdSize > fileSize) {
      throw new Error('安装包目录范围无效')
    }

    const cd = Buffer.alloc(cdSize)
    await handle.read(cd, 0, cdSize, cdOffset)
    const lfhHeader = Buffer.alloc(30)
    let cursor = 0
    let totalUncompressed = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > cd.length || cd.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('安装包目录记录损坏')
      }
      const compressed32 = cd.readUInt32LE(cursor + 20)
      const uncompressed32 = cd.readUInt32LE(cursor + 24)
      const nameLen = cd.readUInt16LE(cursor + 28)
      const extraLen = cd.readUInt16LE(cursor + 30)
      const commentLen = cd.readUInt16LE(cursor + 32)
      const externalAttr = cd.readUInt32LE(cursor + 38)
      let localOffset = cd.readUInt32LE(cursor + 42)
      const nameStart = cursor + 46
      const nameEnd = nameStart + nameLen
      if (nameEnd + extraLen + commentLen > cd.length) throw new Error('安装包目录条目截断')

      const entryNameBuf = cd.subarray(nameStart, nameEnd)
      const entryName = entryNameBuf.toString('utf8')
      if (!entryName || entryName.includes('\0') || entryName.startsWith('/') || entryName.startsWith('\\') || /^[a-zA-Z]:/.test(entryName)) {
        throw new Error(`安装包包含不安全路径：${entryName}`)
      }
      if (entryName.split(/[\\/]/).some(segment => segment === '..')) {
        throw new Error(`安装包包含路径穿越：${entryName}`)
      }
      const unixMode = (externalAttr >>> 16) & 0o170000
      if (unixMode === 0o120000) {
        throw new Error(`安装包包含不允许的符号链接：${entryName}`)
      }

      let entrySize = uncompressed32
      if (uncompressed32 === 0xffffffff || compressed32 === 0xffffffff || localOffset === 0xffffffff) {
        let ex = nameEnd
        const exEnd = nameEnd + extraLen
        while (ex + 4 <= exEnd) {
          const id = cd.readUInt16LE(ex)
          const len = cd.readUInt16LE(ex + 2)
          if (id === 0x0001 && ex + 4 + len <= exEnd) {
            let p = ex + 4
            if (uncompressed32 === 0xffffffff && p + 8 <= ex + 4 + len) { entrySize = Number(cd.readBigUInt64LE(p)); p += 8 }
            if (compressed32 === 0xffffffff && p + 8 <= ex + 4 + len) p += 8
            if (localOffset === 0xffffffff && p + 8 <= ex + 4 + len) localOffset = Number(cd.readBigUInt64LE(p))
            break
          }
          ex += 4 + len
        }
      }
      totalUncompressed += entrySize
      if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
        throw new Error('安装包解压体积超出安全限制')
      }
      // 交叉校验本地文件头（LFH）签名与文件名，避免 CD 与 LFH 名称错位绕过路径检查。
      if (!Number.isSafeInteger(localOffset) || localOffset < 0 || localOffset + 30 + nameLen > cdOffset) {
        throw new Error('安装包本地文件头偏移无效')
      }
      await handle.read(lfhHeader, 0, 30, localOffset)
      if (lfhHeader.readUInt32LE(0) !== 0x04034b50 || lfhHeader.readUInt16LE(26) !== nameLen) {
        throw new Error('安装包本地文件头与目录不一致')
      }
      const lfhName = Buffer.alloc(nameLen)
      await handle.read(lfhName, 0, nameLen, localOffset + 30)
      if (!lfhName.equals(entryNameBuf)) {
        throw new Error('安装包本地文件头名称与目录不一致')
      }
      cursor = nameEnd + extraLen + commentLen
    }
    // 允许中央目录尾部可选的数字签名记录（0x05054b50），拒绝尾部藏匿未检验的额外目录条目。
    if (cursor !== cdSize) {
      const hasTrailingSig = cursor + 6 <= cdSize
        && cd.readUInt32LE(cursor) === 0x05054b50
        && cursor + 6 + cd.readUInt16LE(cursor + 4) === cdSize
      if (!hasTrailingSig) {
        throw new Error('安装包中央目录条目数量与目录大小不一致')
      }
    }
    return { entryCount, totalUncompressed }
  } finally {
    await handle.close()
  }
}
