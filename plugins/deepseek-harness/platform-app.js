// 本机已安装 BeefTV 桌面应用的跨平台发现、版本校验与拉起。
// 独立运行包的下载与管理留在 runtime-store.js，避免两条路径互相串味。

import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// macOS 与 Linux 从 2.2.0 起提供 --harness-runtime；Windows 的命名管道控制面从 2.4.3 起提供。
const minimumVersions = {
  darwin: '2.2.0',
  linux: '2.2.0',
  win32: '2.4.3',
}

export function minimumLocalAppVersion(platform = process.platform, env = process.env) {
  if (platform === 'win32' && env?.BEEFTV_HARNESS_MIN_WINDOWS_VERSION) {
    return env.BEEFTV_HARNESS_MIN_WINDOWS_VERSION.trim()
  }
  return minimumVersions[platform] || '2.2.0'
}

export function parseStableSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version || '').trim())
  return match ? match.slice(1, 4).map(Number) : null
}

export function compareSemver(left, right) {
  const a = parseStableSemver(left)
  const b = parseStableSemver(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

export function supportsHarnessVersion(version, platform = process.platform, env = process.env) {
  const compared = compareSemver(version, minimumLocalAppVersion(platform, env))
  return compared !== null && compared >= 0
}

function execFileOutput(command, args, timeout = 5_000) {
  return new Promise(resolve => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

async function readVersionJSON(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'))
    return typeof data?.version === 'string' && data.version.trim() ? data.version.trim() : null
  } catch {
    return null
  }
}

// 便携版与安装版统一支持通过随包 CLI `beeftv --version` 读取编译期版本号（不启动桌面窗口、不打开数据库）。
async function readCLIVersion(cliPath) {
  const output = await execFileOutput(cliPath, ['--version'], 5_000)
  return output && parseStableSemver(output) ? output : null
}

async function detectDarwinLocalApp(env = process.env) {
  const bundle = env?.BEEFTV_LOCAL_APP_DIR?.trim() || '/Applications/BeefTV.app'
  const paths = {
    bundle,
    info: join(bundle, 'Contents', 'Info.plist'),
    executable: join(bundle, 'Contents', 'MacOS', 'BeefTV'),
    cli: join(bundle, 'Contents', 'MacOS', 'cli', 'beeftv'),
  }
  try {
    await Promise.all([access(paths.executable, constants.X_OK), access(paths.cli, constants.X_OK)])
  } catch {
    return null
  }
  const version = await execFileOutput('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', paths.info])
    || await readCLIVersion(paths.cli)
  return {
    paths,
    version,
    launch: () => new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', bundle], { timeout: 10_000 }, error => {
        if (error) reject(error)
        else resolve()
      })
    }),
    launchFailureMessage: `无法打开本机 BeefTV，请确认 ${bundle} 已完整安装`,
  }
}

async function readWindowsRegistryInstall() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BeefTV'
  const output = await execFileOutput('reg.exe', ['query', key], 5_000)
  if (!output) return { dir: null, version: null }
  const readValue = name => {
    const pattern = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, 'im')
    const matched = pattern.exec(output)
    return matched ? matched[1].trim().replace(/^"|"$/g, '') : null
  }
  return { dir: readValue('InstallLocation'), version: readValue('DisplayVersion') }
}

async function detectWindowsLocalApp(env = process.env) {
  const reg = await readWindowsRegistryInstall()
  const candidates = [
    env?.BEEFTV_LOCAL_APP_DIR,
    reg.dir,
    env?.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'BeefTV') : null,
    env?.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'BeefTV') : null,
    env?.ProgramFiles ? join(env.ProgramFiles, 'BeefTV') : null,
  ].filter((value, index, list) => typeof value === 'string' && value.trim() && list.indexOf(value) === index)

  for (const dir of candidates) {
    const paths = {
      bundle: dir,
      executable: join(dir, 'BeefTV.exe'),
      cli: join(dir, 'cli', 'beeftv.exe'),
    }
    try {
      await Promise.all([access(paths.executable, constants.F_OK), access(paths.cli, constants.F_OK)])
    } catch {
      continue
    }
    // 优先使用注册表版本或 version.json，其次调用随包 cli/beeftv.exe --version（适用于便携 ZIP 解压安装）。
    const version = (reg.dir && reg.dir.toLowerCase() === dir.toLowerCase() ? reg.version : null)
      || await readVersionJSON(join(dir, 'version.json'))
      || await readCLIVersion(paths.cli)
    return {
      paths,
      version,
      launch: () => new Promise((resolve, reject) => {
        try {
          const child = spawn(paths.executable, [], { detached: true, stdio: 'ignore', windowsHide: false })
          child.once('error', reject)
          child.unref()
          resolve()
        } catch (error) {
          reject(error)
        }
      }),
      launchFailureMessage: `无法打开本机 BeefTV，请确认 ${dir} 安装完整`,
    }
  }
  return null
}

async function detectLinuxLocalApp(env = process.env) {
  const candidates = [
    env?.BEEFTV_LOCAL_APP_DIR,
    '/opt/beeftv/BeefTV-linux',
    join(homedir(), '.local', 'share', 'beeftv', 'BeefTV-linux'),
  ].filter((value, index, list) => typeof value === 'string' && value.trim() && list.indexOf(value) === index)

  for (const dir of candidates) {
    const paths = {
      bundle: dir,
      executable: join(dir, 'BeefTV'),
      cli: join(dir, 'cli', 'beeftv'),
    }
    try {
      await Promise.all([access(paths.executable, constants.X_OK), access(paths.cli, constants.X_OK)])
    } catch {
      continue
    }
    let version = await readVersionJSON(join(dir, 'version.json'))
    if (!version && dir === '/opt/beeftv/BeefTV-linux') {
      version = await execFileOutput('dpkg-query', ['-W', '-f=${Version}', 'beeftv'], 5_000)
    }
    if (!version) {
      version = await readCLIVersion(paths.cli)
    }
    return {
      paths,
      version,
      launch: () => new Promise((resolve, reject) => {
        try {
          const child = spawn(paths.executable, [], { detached: true, stdio: 'ignore' })
          child.once('error', reject)
          child.unref()
          resolve()
        } catch (error) {
          reject(error)
        }
      }),
      launchFailureMessage: `无法打开本机 BeefTV，请确认 ${dir} 安装完整`,
    }
  }
  return null
}

export async function inspectLocalApp({ platform = process.platform, env = process.env } = {}) {
  const minimum = minimumLocalAppVersion(platform, env)
  let detected = null
  if (platform === 'darwin') detected = await detectDarwinLocalApp(env)
  else if (platform === 'win32') detected = await detectWindowsLocalApp(env)
  else if (platform === 'linux') detected = await detectLinuxLocalApp(env)
  else {
    return {
      status: { compatible: false, version: null, message: '当前系统暂不支持连接本机 BeefTV。' },
      detected: null,
    }
  }
  if (!detected) {
    return {
      status: { compatible: false, version: null, message: `未找到本机 BeefTV。请安装 ${minimum} 或更高版本后重新连接。` },
      detected: null,
    }
  }
  if (supportsHarnessVersion(detected.version, platform, env)) {
    return {
      status: { compatible: true, version: detected.version, message: null },
      detected,
    }
  }
  return {
    status: {
      compatible: false,
      version: detected.version,
      message: detected.version
        ? `本机 BeefTV 版本为 ${detected.version}，需要 ${minimum} 或更高版本。请升级后重新连接。`
        : `无法读取本机 BeefTV 的版本。请重新安装 ${minimum} 或更高版本后重新连接。`,
    },
    detected,
  }
}

export async function localAppStatus(options) {
  return (await inspectLocalApp(options)).status
}
