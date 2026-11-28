#!/usr/bin/env node
// Verifies byte-identical parity of shared DeepSeek Harness plugin files between
// BeefTV-app/plugins/deepseek-harness/ (single canonical source) and BeefTV-DSH.
// Skips cleanly (exit 0) when no BeefTV-DSH checkout is present unless --require is passed.

import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonicalDir = resolve(repoRoot, 'plugins/deepseek-harness')

export const SHARED_DSH_FILES = Object.freeze([
  'README.md',
  'await-machine.js',
  'await-machine.test.js',
  'await-runner.js',
  'client.browser.test.ts',
  'client.js',
  'connection.js',
  'cordis.patch.yml',
  'host.js',
  'platform-app.js',
  'prompts.js',
  'runtime-store.js',
  'runtime-store.test.js',
  'runtime-verify.js',
  'runtime.js',
  'runtime.test.js',
  'step-limit.js',
  'update-trust-conformance.json',
  'workspace-http.js',
])

const PACKAGE_CONTRACT_KEYS = Object.freeze([
  'name',
  'type',
  'main',
  'exports',
  'dsh',
  'engines',
  'peerDependencies',
])

function parseArgs(argv) {
  let dshDir = process.env.BEEFTV_DSH_DIR || ''
  let required = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dsh-dir') {
      dshDir = argv[i + 1] || ''
      i += 1
    } else if (arg.startsWith('--dsh-dir=')) {
      dshDir = arg.slice('--dsh-dir='.length)
    } else if (arg === '--require') {
      required = true
    }
  }
  return {
    dshDir: resolve(dshDir || resolve(repoRoot, '..', 'BeefTV-DSH')),
    explicit: Boolean(dshDir),
    required,
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const { dshDir, explicit, required } = parseArgs(process.argv.slice(2))
  if (!(await exists(dshDir)) || !(await exists(resolve(dshDir, 'package.json')))) {
    if (required || explicit) {
      console.error(`[check-dsh-sync] FAIL: BeefTV-DSH directory not found: ${dshDir}`)
      process.exit(1)
    }
    console.log(`[check-dsh-sync] SKIP: sibling BeefTV-DSH directory not present (${dshDir})`)
    return
  }

  const drifted = []
  for (const rel of SHARED_DSH_FILES) {
    const srcPath = resolve(canonicalDir, rel)
    const dstPath = resolve(dshDir, rel)
    if (!(await exists(dstPath))) {
      drifted.push(`${rel} (missing in BeefTV-DSH)`)
      continue
    }
    const [srcBuf, dstBuf] = await Promise.all([readFile(srcPath), readFile(dstPath)])
    if (!srcBuf.equals(dstBuf)) {
      drifted.push(`${rel} (content mismatch)`)
    }
  }

  const [srcPkg, dstPkg] = await Promise.all([
    readFile(resolve(canonicalDir, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(dshDir, 'package.json'), 'utf8').then(JSON.parse),
  ])
  for (const key of PACKAGE_CONTRACT_KEYS) {
    if (JSON.stringify(srcPkg[key]) !== JSON.stringify(dstPkg[key])) {
      drifted.push(`package.json#${key} (contract mismatch)`)
    }
  }

  if (drifted.length > 0) {
    console.error(`[check-dsh-sync] FAIL: ${drifted.length} drifted item(s) against ${dshDir}:`)
    for (const item of drifted) console.error(`  - ${item}`)
    process.exit(1)
  }

  console.log(`[check-dsh-sync] OK: ${SHARED_DSH_FILES.length} shared files and package contract are byte-identical.`)
}

await main()
