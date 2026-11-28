import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectLocalApp, minimumLocalAppVersion, supportsHarnessVersion } from './platform-app.js'
import {
  ARCHIVE_SAFETY_ERROR_CODE,
  createRuntimeStore,
  extractZipArchive,
  inspectZipSafety,
  orderCandidateURLs,
  platformKey,
  preferDomesticMirror,
  probeRuntimeDir,
  rejectExtractedSymlinks,
  verifyFeedEnvelope,
} from './runtime-store.js'
import { KNOWN_PLATFORMS, validateDownloadURL, validateRedirectURL } from './runtime-verify.js'

// 生成最小合法 Store (无压缩) ZIP 字节流，可按需构造合法运行包或 Zip Slip / symlink 恶意样本。
function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '', 'utf8')
    const mode = entry.mode ?? 0o100644
    const externalAttr = (mode << 16) >>> 0
    const crc = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    localParts.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // version made by: Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(externalAttr, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centralParts.push(central)

    offset += local.length + data.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, cd, eocd])
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const rawPublic = spki.subarray(spki.length - 32).toString('base64')
  return { rawPublic, privateKey }
}

function signFeed(payloadObject, privateKey) {
  const payloadBytes = Buffer.from(JSON.stringify(payloadObject), 'utf8')
  const signature = signBytes(null, payloadBytes, privateKey)
  return JSON.stringify({
    payload: payloadBytes.toString('base64'),
    signature: signature.toString('base64'),
  })
}

function validRuntimeZipFor(platKey) {
  if (platKey === 'darwin-arm64' || platKey === 'darwin-amd64') {
    return buildZip([
      { name: 'BeefTV.app/Contents/MacOS/BeefTV', data: '#!/bin/sh\necho ok\n', mode: 0o100755 },
      { name: 'BeefTV.app/Contents/MacOS/cli/beeftv', data: '#!/bin/sh\necho cli\n', mode: 0o100755 },
    ])
  }
  if (platKey === 'linux-amd64') {
    return buildZip([
      { name: 'BeefTV-linux/BeefTV', data: '#!/bin/sh\necho ok\n', mode: 0o100755 },
      { name: 'BeefTV-linux/cli/beeftv', data: '#!/bin/sh\necho cli\n', mode: 0o100755 },
    ])
  }
  return buildZip([
    { name: 'BeefTV.exe', data: 'MZ-stub', mode: 0o100644 },
    { name: 'cli/beeftv.exe', data: 'MZ-cli', mode: 0o100644 },
  ])
}

async function startFixtureServer(context, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('verifyFeedEnvelope validates Ed25519 signature, schema, and trusted artifact hosts', () => {
  const { rawPublic, privateKey } = makeSigningKey()
  const other = makeSigningKey()
  const basePayload = {
    schema: 2,
    version: 'v2.4.2',
    commit: '67becaab7cfd2abe0cb394ec3da81c16115cae7f',
    platforms: {
      'darwin-arm64': {
        urls: [
          'https://cnb.cool/beeftv-downloads/desktop/-/releases/download/v2.4.2/BeefTV-v2.4.2-darwin-arm64.zip',
          'https://updates.beefapi.com/beeftv/v2.4.2/BeefTV-v2.4.2-darwin-arm64.zip',
        ],
        sha256: 'a'.repeat(64),
        size: 1024,
      },
    },
  }
  const signed = signFeed(basePayload, privateKey)
  const verified = verifyFeedEnvelope(signed, rawPublic)
  assert.equal(verified.version, 'v2.4.2')
  assert.equal(verified.platforms['darwin-arm64'].urls.length, 2)

  // 错公钥拒绝
  assert.throws(() => verifyFeedEnvelope(signed, other.rawPublic), /签名校验失败/)

  // 篡改 payload 拒绝
  const tampered = JSON.parse(signed)
  tampered.payload = Buffer.from(JSON.stringify({ ...basePayload, version: 'v9.9.9' })).toString('base64')
  assert.throws(() => verifyFeedEnvelope(JSON.stringify(tampered), rawPublic), /签名校验失败/)

  // 不受信任下载域名拒绝
  const evilHost = signFeed({
    ...basePayload,
    platforms: {
      'darwin-arm64': {
        urls: ['https://evil.example.com/beeftv/BeefTV.zip'],
        sha256: 'a'.repeat(64),
        size: 1024,
      },
    },
  }, privateKey)
  assert.throws(() => verifyFeedEnvelope(evilHost, rawPublic), /不受信任的下载来源/)

  // 伪造 cnb.cool 仓库路径拒绝
  const evilPath = signFeed({
    ...basePayload,
    platforms: {
      'darwin-arm64': {
        urls: ['https://cnb.cool/other-org/desktop/-/releases/download/v2.4.2/a.zip'],
        sha256: 'a'.repeat(64),
        size: 1024,
      },
    },
  }, privateKey)
  assert.throws(() => verifyFeedEnvelope(evilPath, rawPublic), /不受信任的下载来源/)

  // 禁止带 query 参数和 COS 越界路径
  const withQuery = signFeed({
    ...basePayload,
    platforms: {
      'darwin-arm64': {
        urls: ['https://updates.beefapi.com/beeftv/v2.4.2/a.zip?token=1'],
        sha256: 'a'.repeat(64),
        size: 1024,
      },
    },
  }, privateKey)
  assert.throws(() => verifyFeedEnvelope(withQuery, rawPublic), /查询参数/)

  const badCosPath = signFeed({
    ...basePayload,
    platforms: {
      'darwin-arm64': {
        urls: ['https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/other/a.zip'],
        sha256: 'a'.repeat(64),
        size: 1024,
      },
    },
  }, privateKey)
  assert.throws(() => verifyFeedEnvelope(badCosPath, rawPublic), /不受信任的下载来源/)
})

test('orderCandidateURLs prioritizes domestic mirror in mainland China and official mirror overseas', () => {
  const urls = [
    'https://updates.beefapi.com/beeftv/v2.4.2/a.zip',
    'https://cnb.cool/beeftv-downloads/desktop/-/releases/download/v2.4.2/a.zip',
  ]
  assert.equal(orderCandidateURLs(urls, true)[0], urls[1])
  assert.equal(orderCandidateURLs(urls, false)[0], urls[0])
  assert.equal(preferDomesticMirror({ timeZone: 'Asia/Shanghai', locale: 'en-US' }), true)
  assert.equal(preferDomesticMirror({ timeZone: 'America/Los_Angeles', locale: 'en-US' }), false)
  assert.equal(preferDomesticMirror({ timeZone: 'Asia/Taipei', locale: 'zh-TW' }), false)
})

test('inspectZipSafety rejects traversal, absolute paths, drive letters, symlinks, forged EOCD count, and LFH mismatch', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'beeftv-zip-inspect-'))
  context.after(() => rm(dir, { recursive: true, force: true }))

  const goodPath = join(dir, 'good.zip')
  await writeFile(goodPath, validRuntimeZipFor('darwin-arm64'))
  const info = await inspectZipSafety(goodPath)
  assert.equal(info.entryCount, 2)

  for (const [label, entries, expected] of [
    ['traversal', [{ name: 'a/../../evil.sh', data: 'x' }], /路径穿越/],
    ['absolute', [{ name: '/etc/passwd', data: 'x' }], /不安全路径/],
    ['drive', [{ name: 'C:\\Windows\\evil.exe', data: 'x' }], /不安全路径/],
    ['symlink', [{ name: 'BeefTV.app/link', data: '/tmp', mode: 0o120777 }], /符号链接/],
  ]) {
    const badPath = join(dir, `${label}.zip`)
    await writeFile(badPath, buildZip(entries))
    await assert.rejects(() => inspectZipSafety(badPath), expected)
  }

  // EOCD 条目计数小于真实中央目录记录数时必须拒绝（防止尾部藏匿未检验条目）。
  const twoEntries = buildZip([
    { name: 'safe.txt', data: 'ok' },
    { name: 'hidden.txt', data: 'bad' },
  ])
  const forgedCount = Buffer.from(twoEntries)
  const eocdOffset = forgedCount.length - 22
  forgedCount.writeUInt16LE(1, eocdOffset + 8)
  forgedCount.writeUInt16LE(1, eocdOffset + 10)
  const forgedCountPath = join(dir, 'forged-count.zip')
  await writeFile(forgedCountPath, forgedCount)
  await assert.rejects(() => inspectZipSafety(forgedCountPath), /条目数量与目录大小不一致/)

  // Local File Header 文件名与 Central Directory 名称不一致时必须拒绝。
  const mismatchBuf = Buffer.from(buildZip([{ name: 'good.txt', data: 'ok' }]))
  const lfhNameIdx = mismatchBuf.indexOf(Buffer.from('good.txt'))
  Buffer.from('evil.txt').copy(mismatchBuf, lfhNameIdx)
  const mismatchPath = join(dir, 'lfh-mismatch.zip')
  await writeFile(mismatchPath, mismatchBuf)
  await assert.rejects(() => inspectZipSafety(mismatchPath), /本地文件头名称与目录不一致/)
})

test('rejectExtractedSymlinks and runtime store reject symlinks, verify SHA256 before extraction, and preserve active runtime on failure', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'beeftv-zip-safety-'))
  context.after(() => rm(dir, { recursive: true, force: true }))

  // 1. 正常目录树放行，包含符号链接（或 Windows junction）时拒绝
  const cleanTree = join(dir, 'clean')
  await mkdir(join(cleanTree, 'sub'), { recursive: true })
  await writeFile(join(cleanTree, 'sub', 'ok.txt'), 'ok')
  await rejectExtractedSymlinks(cleanTree)

  const outsideDir = join(dir, 'outside')
  await mkdir(outsideDir, { recursive: true })
  const linkTree = join(dir, 'with-symlink')
  await mkdir(join(linkTree, 'nested'), { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : undefined
  await symlink(outsideDir, join(linkTree, 'nested', 'rogue-link'), linkType)
  await assert.rejects(
    () => rejectExtractedSymlinks(linkTree),
    error => error?.code === ARCHIVE_SAFETY_ERROR_CODE && /不能包含符号链接|解压路径越界/.test(error.message),
  )

  // 2. extractZipArchive 解压出符号链接或解压命令中途失败时，必须清理整个暂存目录
  const symlinkOut = join(dir, 'stage-symlink')
  await assert.rejects(
    () => extractZipArchive('/tmp/pkg.zip', symlinkOut, {
      platform: 'linux',
      runCmd: async (_cmd, _args) => {
        await writeFile(join(symlinkOut, 'BeefTV'), 'stub')
        await symlink(outsideDir, join(symlinkOut, 'escape'), linkType)
      },
    }),
    error => error?.code === ARCHIVE_SAFETY_ERROR_CODE && /不能包含符号链接|解压路径越界/.test(error.message),
  )
  await assert.rejects(() => stat(symlinkOut))

  const failOut = join(dir, 'stage-fail')
  await assert.rejects(
    () => extractZipArchive('/tmp/pkg.zip', failOut, {
      platform: 'darwin',
      runCmd: async () => {
        await writeFile(join(failOut, 'partial.bin'), 'half')
        throw new Error('ditto failed')
      },
    }),
    /ditto failed/,
  )
  await assert.rejects(() => stat(failOut))

  // 3. runtime store 必须先完成 Ed25519 + SHA256 校验才解压，且解压后发现符号链接时清理暂存目录、绝不切换已激活版本
  const pluginHome = await mkdtemp(join(tmpdir(), 'beeftv-store-safety-'))
  context.after(() => rm(pluginHome, { recursive: true, force: true }))
  const { rawPublic, privateKey } = makeSigningKey()
  const plat = platformKey()
  assert.ok(plat, 'test host must be a supported platform')
  const zipV1 = validRuntimeZipFor(plat)
  const shaV1 = createHash('sha256').update(zipV1).digest('hex')
  const badShaBytes = Buffer.from('corrupted-payload')
  const zipV2 = validRuntimeZipFor(plat)
  const shaV2 = createHash('sha256').update(zipV2).digest('hex')

  let mode = 'bad-sha'
  let origin = ''
  origin = await startFixtureServer(context, (req, res) => {
    if (req.url === '/feed.json') {
      const version = mode === 'v2-symlink' ? 'v2.4.4' : 'v2.4.3'
      const sha = mode === 'v2-symlink' ? shaV2 : shaV1
      const size = mode === 'bad-sha' ? badShaBytes.length : (mode === 'v2-symlink' ? zipV2.length : zipV1.length)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(signFeed({
        schema: 2,
        version,
        commit: '67becaab7cfd2abe0cb394ec3da81c16115cae7f',
        platforms: { [plat]: { urls: [`${origin}/${mode}.zip`], sha256: sha, size } },
      }, privateKey))
      return
    }
    const body = mode === 'bad-sha' ? badShaBytes : (mode === 'v2-symlink' ? zipV2 : zipV1)
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })

  let extractCalls = 0
  const store = createRuntimeStore({
    pluginHome,
    feedURL: `${origin}/feed.json`,
    publicKey: rawPublic,
    extractImpl: async (zipPath, targetDir, options) => {
      extractCalls += 1
      if (mode === 'v2-symlink') {
        return extractZipArchive(zipPath, targetDir, {
          ...options,
          runCmd: async () => {
            await symlink(outsideDir, join(targetDir, 'escape'), linkType)
          },
        })
      }
      return extractZipArchive(zipPath, targetDir, options)
    },
  })

  // SHA256 不匹配必须在解压前失败，extractImpl 零调用
  await assert.rejects(() => store.ensureInstalled(), /SHA256 校验不通过/)
  assert.equal(extractCalls, 0)

  // 安装合法 v2.4.3 并激活
  mode = 'v1-good'
  const installed = await store.ensureInstalled()
  assert.equal(installed.version, 'v2.4.3')
  assert.equal(extractCalls, 1)

  // 升级到 v2.4.4 时暂存目录检出符号链接：拒绝升级、清空暂存目录、保持当前版本 v2.4.3
  mode = 'v2-symlink'
  await assert.rejects(
    () => store.ensureInstalled({ forceUpdate: true }),
    error => error?.code === ARCHIVE_SAFETY_ERROR_CODE && /不能包含符号链接|解压路径越界/.test(error.message),
  )
  const pointer = JSON.parse(await readFile(join(pluginHome, 'runtimes', 'current.json'), 'utf8'))
  assert.equal(pointer.version, 'v2.4.3')
  assert.equal((await store.status()).version, 'v2.4.3')
  const runtimeEntries = await readdir(join(pluginHome, 'runtimes'))
  assert.equal(runtimeEntries.some(name => name.startsWith('.staging-') || name.startsWith('.download-') || name.startsWith('v2.4.4-')), false)
})

test('runtime store downloads, falls back on corrupt mirror, verifies SHA256, extracts atomically, and updates cleanly', async context => {
  const pluginHome = await mkdtemp(join(tmpdir(), 'beeftv-runtime-store-'))
  context.after(() => rm(pluginHome, { recursive: true, force: true }))
  const { rawPublic, privateKey } = makeSigningKey()
  const plat = platformKey()
  assert.ok(plat, 'test host must be a supported platform')

  const zipV1 = validRuntimeZipFor(plat)
  const shaV1 = createHash('sha256').update(zipV1).digest('hex')
  const zipV2 = buildZip([
    ...(plat.startsWith('darwin-') ? [
      { name: 'BeefTV.app/Contents/MacOS/BeefTV', data: '#!/bin/sh\necho v2\n', mode: 0o100755 },
      { name: 'BeefTV.app/Contents/MacOS/cli/beeftv', data: '#!/bin/sh\necho cli2\n', mode: 0o100755 },
    ] : plat === 'linux-amd64' ? [
      { name: 'BeefTV-linux/BeefTV', data: '#!/bin/sh\necho v2\n', mode: 0o100755 },
      { name: 'BeefTV-linux/cli/beeftv', data: '#!/bin/sh\necho cli2\n', mode: 0o100755 },
    ] : [
      { name: 'BeefTV.exe', data: 'MZ-v2', mode: 0o100644 },
      { name: 'cli/beeftv.exe', data: 'MZ-cli-v2', mode: 0o100644 },
    ]),
  ])
  const shaV2 = createHash('sha256').update(zipV2).digest('hex')

  let currentFeedVersion = 'v2.4.3'
  let zipHits = []
  let origin = ''
  origin = await startFixtureServer(context, (req, res) => {
    if (req.url === '/feed.json') {
      const zip = currentFeedVersion === 'v2.4.3' ? zipV1 : zipV2
      const sha = currentFeedVersion === 'v2.4.3' ? shaV1 : shaV2
      const body = signFeed({
        schema: 2,
        version: currentFeedVersion,
        commit: '67becaab7cfd2abe0cb394ec3da81c16115cae7f',
        platforms: {
          [plat]: {
            urls: [`${origin}/bad.zip`, `${origin}/good-${currentFeedVersion}.zip`],
            sha256: sha,
            size: zip.length,
          },
        },
      }, privateKey)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    zipHits.push(req.url)
    if (req.url === '/bad.zip') {
      // 返回等长但内容篡改的坏包，验证 SHA256 拒绝并自动切下一个源。
      res.writeHead(200, { 'content-length': String(zipV1.length) })
      res.end(Buffer.alloc(zipV1.length, 0x42))
      return
    }
    const payload = req.url.includes('v2.4.4') ? zipV2 : zipV1
    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  const store = createRuntimeStore({
    pluginHome,
    feedURL: `${origin}/feed.json`,
    publicKey: rawPublic,
  })
  assert.equal((await store.status()).ready, false)

  // 并发调用 ensureInstalled 必须合并为单次下载
  const [first, second] = await Promise.all([store.ensureInstalled(), store.ensureInstalled()])
  assert.equal(first.source, 'managed')
  assert.equal(first.version, 'v2.4.3')
  assert.equal(second.executable, first.executable)
  assert.deepEqual(zipHits, ['/bad.zip', '/good-v2.4.3.zip'])

  // 再次 ensureInstalled 直接命中本地托管目录，不触发任何新下载
  zipHits = []
  const cached = await store.ensureInstalled()
  assert.equal(cached.version, 'v2.4.3')
  assert.deepEqual(zipHits, [])

  // 线上升级到 v2.4.4：checkUpdate 发现新版，forceUpdate 原子切换
  currentFeedVersion = 'v2.4.4'
  const update = await store.checkUpdate()
  assert.deepEqual(update, { version: 'v2.4.4', size: zipV2.length })
  assert.equal((await store.status()).updateAvailable?.version, 'v2.4.4')

  const upgraded = await store.ensureInstalled({ forceUpdate: true })
  assert.equal(upgraded.version, 'v2.4.4')
  assert.equal((await store.status()).version, 'v2.4.4')
  assert.equal((await store.status()).updateAvailable, null)
  const pointer = JSON.parse(await readFile(join(pluginHome, 'runtimes', 'current.json'), 'utf8'))
  assert.equal(pointer.version, 'v2.4.4')
  assert.ok((await stat(upgraded.executable)).isFile())
})

test('runtime store blocks Windows download before fetching bytes when published feed is below 2.4.3', async context => {
  const pluginHome = await mkdtemp(join(tmpdir(), 'beeftv-win-gate-'))
  context.after(() => rm(pluginHome, { recursive: true, force: true }))
  const { rawPublic, privateKey } = makeSigningKey()
  let downloadAttempted = false
  let origin = ''
  origin = await startFixtureServer(context, (req, res) => {
    if (req.url === '/feed.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(signFeed({
        schema: 2,
        version: 'v2.4.2',
        commit: '67becaab7cfd2abe0cb394ec3da81c16115cae7f',
        platforms: {
          'windows-amd64': {
            urls: [`${origin}/win.zip`],
            sha256: 'b'.repeat(64),
            size: 1024,
          },
        },
      }, privateKey))
      return
    }
    downloadAttempted = true
    res.writeHead(200)
    res.end('should not download')
  })

  const store = createRuntimeStore({
    pluginHome,
    platform: 'win32',
    arch: 'x64',
    feedURL: `${origin}/feed.json`,
    publicKey: rawPublic,
  })
  await assert.rejects(() => store.ensureInstalled(), /需要 BeefTV 2\.4\.3 或更高版本/)
  assert.equal(downloadAttempted, false)
})

test('runtime store cancel aborts in-flight download and leaves no temp zip behind', async context => {
  const pluginHome = await mkdtemp(join(tmpdir(), 'beeftv-cancel-'))
  context.after(() => rm(pluginHome, { recursive: true, force: true }))
  const { rawPublic, privateKey } = makeSigningKey()
  const plat = platformKey()
  let releaseStream
  let origin = ''
  origin = await startFixtureServer(context, (req, res) => {
    if (req.url === '/feed.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(signFeed({
        schema: 2,
        version: 'v2.4.3',
        commit: '67becaab7cfd2abe0cb394ec3da81c16115cae7f',
        platforms: {
          [plat]: {
            urls: [`${origin}/slow.zip`],
            sha256: 'c'.repeat(64),
            size: 1024 * 1024,
          },
        },
      }, privateKey))
      return
    }
    res.writeHead(200, { 'content-length': String(1024 * 1024) })
    res.write(Buffer.alloc(16 * 1024))
    releaseStream = () => res.destroy()
  })
  context.after(() => releaseStream?.())

  const store = createRuntimeStore({
    pluginHome,
    feedURL: `${origin}/feed.json`,
    publicKey: rawPublic,
  })
  const pending = store.ensureInstalled()
  for (let i = 0; i < 40 && store.provision().phase !== 'downloading'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(store.provision().phase, 'downloading')
  assert.equal(store.cancel(), true)
  // cancel() 同步重置 provision，取消接口立刻可见 idle 状态
  assert.equal(store.provision().phase, 'idle')
  await assert.rejects(() => pending, error => error?.code === 'BEEFTV_PROVISION_CANCELLED')
  assert.equal(store.provision().phase, 'idle')
})

test('runtime store prune only removes managed old versions and stale temp files, preserving user custom dirs', async context => {
  const pluginHome = await mkdtemp(join(tmpdir(), 'beeftv-prune-'))
  context.after(() => rm(pluginHome, { recursive: true, force: true }))
  const plat = platformKey()
  const runtimesDir = join(pluginHome, 'runtimes')
  await mkdir(join(runtimesDir, `v2.4.2-${plat}`), { recursive: true })
  await mkdir(join(runtimesDir, `v2.4.3-${plat}`), { recursive: true })
  await mkdir(join(runtimesDir, 'custom-preinstalled'), { recursive: true })
  await mkdir(join(runtimesDir, '.staging-crashed'), { recursive: true })
  await writeFile(join(runtimesDir, '.download-crashed.zip'), 'partial')
  await writeFile(join(runtimesDir, `v2.4.2-${plat}`, '.beeftv-managed.json'), '{}')
  await writeFile(join(runtimesDir, `v2.4.3-${plat}`, '.beeftv-managed.json'), '{}')
  await writeFile(join(runtimesDir, 'custom-preinstalled', 'marker.txt'), 'keep-me')
  await writeFile(join(runtimesDir, 'current.json'), JSON.stringify({ version: 'v2.4.3', dir: `v2.4.3-${plat}`, platform: plat }))

  const store = createRuntimeStore({ pluginHome })
  await store.prune({ includeTemps: true })

  // 旧的托管目录和崩溃残留被清除，当前托管目录与无标记的用户预装目录完整保留
  await assert.rejects(() => stat(join(runtimesDir, `v2.4.2-${plat}`)))
  await assert.rejects(() => stat(join(runtimesDir, '.staging-crashed')))
  await assert.rejects(() => stat(join(runtimesDir, '.download-crashed.zip')))
  assert.ok((await stat(join(runtimesDir, `v2.4.3-${plat}`))).isDirectory())
  assert.equal(await readFile(join(runtimesDir, 'custom-preinstalled', 'marker.txt'), 'utf8'), 'keep-me')
})

test('platform-app detects portable Linux install version via bundled cli --version without version.json', { skip: process.platform === 'win32' }, async context => {
  const dir = await mkdtemp(join(tmpdir(), 'beeftv-portable-cli-'))
  context.after(() => rm(dir, { recursive: true, force: true }))
  const linuxDir = join(dir, 'BeefTV-linux')
  await mkdir(join(linuxDir, 'cli'), { recursive: true })
  await writeFile(join(linuxDir, 'BeefTV'), '#!/bin/sh\n')
  await writeFile(join(linuxDir, 'cli', 'beeftv'), '#!/bin/sh\necho v2.4.3\n')
  await chmod(join(linuxDir, 'BeefTV'), 0o755)
  await chmod(join(linuxDir, 'cli', 'beeftv'), 0o755)

  const found = await inspectLocalApp({ platform: 'linux', env: { BEEFTV_LOCAL_APP_DIR: linuxDir } })
  assert.equal(found.status.compatible, true)
  assert.equal(found.status.version, 'v2.4.3')
})

test('runtime-verify matches shared Go/JS update trust conformance fixture', async () => {
  const spec = JSON.parse(await readFile(new URL('./update-trust-conformance.json', import.meta.url), 'utf8'))
  for (const plat of spec.knownPlatforms) assert.equal(KNOWN_PLATFORMS.has(plat), true, plat)
  for (const plat of spec.unknownPlatforms) assert.equal(KNOWN_PLATFORMS.has(plat), false, plat)
  for (const url of spec.allowedDownloadURLs) assert.equal(validateDownloadURL(url, null), url)
  for (const url of spec.rejectedDownloadURLs) assert.throws(() => validateDownloadURL(url, null), Error, url)
  for (const url of spec.allowedRedirectURLs) assert.equal(validateRedirectURL(url, null), url)
  for (const url of spec.rejectedRedirectURLs) assert.throws(() => validateRedirectURL(url, null), Error, url)

  const { rawPublic, privateKey } = makeSigningKey()
  const baseArtifact = {
    urls: [spec.allowedDownloadURLs[0]],
    sha256: 'a'.repeat(64),
    size: 1024,
  }
  const commit = '67becaab7cfd2abe0cb394ec3da81c16115cae7f'
  for (const ver of spec.validVersions) {
    const raw = signFeed({ schema: 2, version: ver, commit, platforms: { 'darwin-arm64': baseArtifact } }, privateKey)
    assert.equal(verifyFeedEnvelope(raw, rawPublic).version, ver)
  }
  for (const ver of spec.invalidVersions) {
    const raw = signFeed({ schema: 2, version: ver, commit, platforms: { 'darwin-arm64': baseArtifact } }, privateKey)
    assert.throws(() => verifyFeedEnvelope(raw, rawPublic), /版本号无效/, ver)
  }
  // 忽略未知平台（即使带非信任地址），同时拒绝 schema 1 与重复 URL
  const withUnknown = signFeed({
    schema: 2, version: 'v2.4.2', commit,
    platforms: {
      'darwin-arm64': baseArtifact,
      'freebsd-amd64': { urls: ['http://evil.example.com/nope.zip'], sha256: 'bad', size: -1 },
    },
  }, privateKey)
  const parsedUnknown = verifyFeedEnvelope(withUnknown, rawPublic)
  assert.deepEqual(Object.keys(parsedUnknown.platforms), ['darwin-arm64'])

  const schema1 = signFeed({
    schema: 1, version: 'v2.4.2', commit,
    platforms: { 'darwin-arm64': { url: spec.allowedDownloadURLs[0], sha256: 'a'.repeat(64), size: 1024 } },
  }, privateKey)
  assert.throws(() => verifyFeedEnvelope(schema1, rawPublic), /版本不受支持/)

  const dupURLs = signFeed({
    schema: 2, version: 'v2.4.2', commit,
    platforms: { 'darwin-arm64': { urls: [spec.allowedDownloadURLs[0], spec.allowedDownloadURLs[0]], sha256: 'a'.repeat(64), size: 1024 } },
  }, privateKey)
  assert.throws(() => verifyFeedEnvelope(dupURLs, rawPublic), /地址重复/)
})

test('runtime store stages unverified installs without moving current.json, activates only after verify, and re-downloads broken unverified dirs', async context => {
  const plat = platformKey()
  const { rawPublic, privateKey } = makeSigningKey()
  const zip = validRuntimeZipFor(plat)
  const sha = createHash('sha256').update(zip).digest('hex')
  let downloads = 0
  let origin = ''
  const server = createServer((req, res) => {
    if (req.url === '/feed.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(signFeed({
        schema: 2, version: 'v2.4.3', commit: '67becaab7cfd2abe0cb394ec3da81c16115cae7f',
        platforms: { [plat]: { urls: [`${origin}/pkg.zip`], sha256: sha, size: zip.length } },
      }, privateKey))
      return
    }
    downloads += 1
    res.writeHead(200, { 'content-length': String(zip.length) })
    res.end(zip)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  context.after(() => new Promise(resolve => server.close(resolve)))

  const pluginHome = await mkdtemp(join(tmpdir(), 'beeftv-staged-'))
  context.after(() => rm(pluginHome, { recursive: true, force: true }))
  const store = createRuntimeStore({ pluginHome, feedURL: `${origin}/feed.json`, publicKey: rawPublic })

  // 1. Staged install does not write current.json yet
  const staged = await store.ensureInstalled({ activate: false })
  assert.equal(staged.staged, true)
  assert.equal(downloads, 1)
  assert.equal(await store.discover(), null)
  assert.equal((await store.status()).ready, false)

  // 2. Unverified managed dir is treated as broken and re-downloaded on next install
  const stagedAgain = await store.ensureInstalled({ activate: false })
  assert.equal(downloads, 2)

  // 3. discard() removes unverified dir cleanly
  await store.discard(stagedAgain)
  await assert.rejects(() => stat(join(pluginHome, 'runtimes', stagedAgain.dirName)))

  // 4. Fresh stage + activate promotes current.json and marks verified
  const readyToPromote = await store.ensureInstalled({ activate: false })
  assert.equal(downloads, 3)
  await store.activate(readyToPromote)
  assert.equal((await store.discover())?.version, 'v2.4.3')
  // Already verified dir is reused without redownloading
  const reused = await store.ensureInstalled({ forceUpdate: true, activate: false })
  assert.equal(downloads, 3)
  assert.equal(reused.version, 'v2.4.3')
})

test('extractZipArchive dispatches OS-native extractors across darwin, win32, and linux with clean fallbacks and layout probing', async context => {
  const root = await mkdtemp(join(tmpdir(), 'beeftv-extract-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  // macOS: /usr/bin/ditto -xk
  const macCalls = []
  const macOut = join(root, 'mac')
  await extractZipArchive('/tmp/app.zip', macOut, {
    platform: 'darwin',
    runCmd: async (cmd, args) => { macCalls.push({ cmd, args }) },
  })
  assert.deepEqual(macCalls, [{ cmd: '/usr/bin/ditto', args: ['-xk', '/tmp/app.zip', macOut] }])

  // Windows: tar.exe primary path
  const winCalls1 = []
  const winOut1 = join(root, 'win1')
  await extractZipArchive('C:\\tmp\\app.zip', winOut1, {
    platform: 'win32',
    runCmd: async (cmd, args) => { winCalls1.push({ cmd, args }) },
  })
  assert.deepEqual(winCalls1, [{ cmd: 'tar.exe', args: ['-xf', 'C:\\tmp\\app.zip', '-C', winOut1] }])

  // Windows: tar.exe fails -> cleans partial staging files and falls back to UTF-16LE Base64 PowerShell Expand-Archive
  const winCalls2 = []
  const winOut2 = join(root, 'win2')
  await extractZipArchive("C:\\tmp\\中文 a'b.zip", winOut2, {
    platform: 'win32',
    runCmd: async (cmd, args) => {
      winCalls2.push({ cmd, args })
      if (cmd === 'tar.exe') {
        await writeFile(join(winOut2, 'stale.tmp'), 'partial')
        throw new Error('tar failed')
      }
      await assert.rejects(() => stat(join(winOut2, 'stale.tmp')))
    },
  })
  assert.deepEqual(winCalls2.map(c => c.cmd), ['tar.exe', 'powershell.exe'])
  assert.deepEqual(winCalls2[1].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  const expandPs = Buffer.from(winCalls2[1].args[3], 'base64').toString('utf16le')
  assert.match(expandPs, /\$ProgressPreference = 'SilentlyContinue'/)
  assert.match(expandPs, /\$ErrorActionPreference = 'Stop'/)
  assert.match(expandPs, /Expand-Archive -LiteralPath 'C:\\tmp\\中文 a''b\.zip' -DestinationPath '.*win2' -Force/)

  // Windows: aborted tar.exe must not fall back to PowerShell and cleans up staging dir
  const winAbort = new AbortController()
  const winAbortCalls = []
  const winAbortOut = join(root, 'win-abort')
  await assert.rejects(
    () => extractZipArchive('C:\\tmp\\app.zip', winAbortOut, {
      platform: 'win32',
      signal: winAbort.signal,
      runCmd: async cmd => {
        winAbortCalls.push(cmd)
        winAbort.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    }),
    /aborted/,
  )
  assert.deepEqual(winAbortCalls, ['tar.exe'])
  await assert.rejects(() => stat(winAbortOut))

  // Windows layout probe
  const winLayoutDir = join(root, 'win-layout')
  await mkdir(join(winLayoutDir, 'cli'), { recursive: true })
  await writeFile(join(winLayoutDir, 'BeefTV.exe'), 'MZ')
  await writeFile(join(winLayoutDir, 'cli', 'beeftv.exe'), 'MZ')
  const probedWin = await probeRuntimeDir(winLayoutDir, 'windows-amd64')
  assert.equal(probedWin?.executable, join(winLayoutDir, 'BeefTV.exe'))
  assert.equal(probedWin?.cli, join(winLayoutDir, 'cli', 'beeftv.exe'))

  // Linux: unzip primary path
  const linPrimary = []
  const linOut0 = join(root, 'lin0')
  await extractZipArchive('/tmp/app.zip', linOut0, {
    platform: 'linux',
    runCmd: async (cmd, args) => { linPrimary.push({ cmd, args }) },
  })
  assert.deepEqual(linPrimary, [{ cmd: 'unzip', args: ['-q', '-o', '/tmp/app.zip', '-d', linOut0] }])

  // Linux: unzip fails -> cleans partial files and falls back to bsdtar
  const linuxCalls = []
  const linOut1 = join(root, 'lin1')
  await extractZipArchive('/tmp/app.zip', linOut1, {
    platform: 'linux',
    runCmd: async (cmd, args) => {
      linuxCalls.push({ cmd, args })
      if (cmd === 'unzip') {
        await writeFile(join(linOut1, 'stale.tmp'), 'partial')
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      await assert.rejects(() => stat(join(linOut1, 'stale.tmp')))
    },
  })
  assert.deepEqual(linuxCalls, [
    { cmd: 'unzip', args: ['-q', '-o', '/tmp/app.zip', '-d', linOut1] },
    { cmd: 'bsdtar', args: ['-xf', '/tmp/app.zip', '-C', linOut1] },
  ])

  // Linux: both unzip & bsdtar missing -> clear install hint and staging cleanup
  const linOut2 = join(root, 'lin2')
  await assert.rejects(() => extractZipArchive('/tmp/app.zip', linOut2, {
    platform: 'linux',
    runCmd: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
  }), /系统缺少 unzip/)
  await assert.rejects(() => stat(linOut2))

  // Linux: unzip fails with archive error while bsdtar is missing -> surface original unzip error
  const linOut3 = join(root, 'lin3')
  await assert.rejects(() => extractZipArchive('/tmp/bad.zip', linOut3, {
    platform: 'linux',
    runCmd: async cmd => {
      if (cmd === 'unzip') throw Object.assign(new Error('CRC error'), { code: 2 })
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
  }), /CRC error/)
  await assert.rejects(() => stat(linOut3))
})

test('platform-app checks platform minimum versions and discovers Windows/Linux installs from env dir', async context => {
  assert.equal(minimumLocalAppVersion('darwin'), '2.2.0')
  assert.equal(minimumLocalAppVersion('linux'), '2.2.0')
  assert.equal(minimumLocalAppVersion('win32'), '2.4.3')
  assert.equal(supportsHarnessVersion('2.4.2', 'win32'), false)
  assert.equal(supportsHarnessVersion('2.4.3', 'win32'), true)
  assert.equal(supportsHarnessVersion('2.2.0', 'linux'), true)

  const dir = await mkdtemp(join(tmpdir(), 'beeftv-platform-app-'))
  context.after(() => rm(dir, { recursive: true, force: true }))

  // Linux 本机目录探测
  const linuxDir = join(dir, 'BeefTV-linux')
  await mkdir(join(linuxDir, 'cli'), { recursive: true })
  await writeFile(join(linuxDir, 'BeefTV'), '#!/bin/sh\n')
  await writeFile(join(linuxDir, 'cli', 'beeftv'), '#!/bin/sh\n')
  await chmod(join(linuxDir, 'BeefTV'), 0o755)
  await chmod(join(linuxDir, 'cli', 'beeftv'), 0o755)
  await writeFile(join(linuxDir, 'version.json'), JSON.stringify({ version: '2.4.2' }))
  const linuxFound = await inspectLocalApp({ platform: 'linux', env: { BEEFTV_LOCAL_APP_DIR: linuxDir } })
  assert.equal(linuxFound.status.compatible, true)
  assert.equal(linuxFound.status.version, '2.4.2')

  // Windows 本机目录探测（含 2.4.2 被版本门禁拦截，升级到 2.4.3 放行）
  const winDir = join(dir, 'BeefTV-win')
  await mkdir(join(winDir, 'cli'), { recursive: true })
  await writeFile(join(winDir, 'BeefTV.exe'), 'MZ')
  await writeFile(join(winDir, 'cli', 'beeftv.exe'), 'MZ')
  await writeFile(join(winDir, 'version.json'), JSON.stringify({ version: '2.4.2' }))
  const winOld = await inspectLocalApp({ platform: 'win32', env: { BEEFTV_LOCAL_APP_DIR: winDir } })
  assert.equal(winOld.status.compatible, false)
  assert.match(winOld.status.message, /2\.4\.3/)

  await writeFile(join(winDir, 'version.json'), JSON.stringify({ version: '2.4.3' }))
  const winNew = await inspectLocalApp({ platform: 'win32', env: { BEEFTV_LOCAL_APP_DIR: winDir } })
  assert.equal(winNew.status.compatible, true)
  assert.equal(winNew.status.version, '2.4.3')
})

test('platform-app prefers real Windows CLI version over stale uninstall registry DisplayVersion', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'beeftv-win-version-priority-'))
  context.after(() => rm(dir, { recursive: true, force: true }))

  const winDir = join(dir, 'BeefTV')
  await mkdir(join(winDir, 'cli'), { recursive: true })
  await writeFile(join(winDir, 'BeefTV.exe'), 'MZ')
  await writeFile(join(winDir, 'cli', 'beeftv.exe'), 'MZ')

  const staleRegOutput = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BeefTV',
    `    InstallLocation    REG_SZ    ${winDir}`,
    '    DisplayVersion    REG_SZ    2.4.2',
  ].join('\r\n')

  // 1. CLI binary reports updated 2.5.0 while uninstall registry still holds stale 2.4.2.
  const fromCli = await inspectLocalApp({
    platform: 'win32',
    env: {},
    execOutput: async (cmd, args) => {
      if (cmd === 'reg.exe') return staleRegOutput
      if (cmd === join(winDir, 'cli', 'beeftv.exe') && args?.[0] === '--version') return '2.5.0'
      return null
    },
  })
  assert.equal(fromCli.status.compatible, true)
  assert.equal(fromCli.status.version, '2.5.0')

  // 2. When CLI cannot run (or spawn throws on Windows), version.json still overrides stale registry DisplayVersion.
  await writeFile(join(winDir, 'version.json'), JSON.stringify({ version: '2.4.9' }))
  const fromVersionJson = await inspectLocalApp({
    platform: 'win32',
    env: {},
    execOutput: async cmd => {
      if (cmd === 'reg.exe') return staleRegOutput
      throw new Error('spawn UNKNOWN')
    },
  })
  assert.equal(fromVersionJson.status.compatible, true)
  assert.equal(fromVersionJson.status.version, '2.4.9')

  // 3. When neither CLI nor version.json provides a version, fall back to registry DisplayVersion
  // (including when registry InstallLocation carries a trailing backslash).
  await rm(join(winDir, 'version.json'))
  const staleRegTrailingSlash = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BeefTV',
    `    InstallLocation    REG_SZ    ${winDir}\\`,
    '    DisplayVersion    REG_SZ    2.4.2',
  ].join('\r\n')
  const fromRegistry = await inspectLocalApp({
    platform: 'win32',
    env: { BEEFTV_LOCAL_APP_DIR: winDir },
    execOutput: async cmd => (cmd === 'reg.exe' ? staleRegTrailingSlash : null),
  })
  assert.equal(fromRegistry.status.compatible, false)
  assert.equal(fromRegistry.status.version, '2.4.2')
})
