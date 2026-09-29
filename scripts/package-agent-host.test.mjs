import { test, expect } from 'bun:test';
import { mkdtempSync, cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageAgentHost, verifyRuntime, NODE_VERSION } from './package-agent-host.mjs';

test('release rejects missing runtime and unsupported target', () => {
  expect(() => verifyRuntime('', 'darwin/arm64')).toThrow('required');
  expect(() => verifyRuntime('/missing', 'linux/amd64')).toThrow('Unsupported');
  expect(() => verifyRuntime('/missing', 'windows/amd64')).toThrow('Missing bundled Node');
});

test('bundled runtime, locked dependencies, and paths with spaces', () => {
  const runtime = process.env.BEEFTV_NODE_RUNTIME;
  expect(runtime).toBeTruthy();
  const target = process.platform === 'win32' ? 'windows/amd64' : `darwin/${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv package test '));
  try {
    const runtimeCopy = path.join(scratch, 'runtime source with spaces');
    const relative = process.platform === 'win32' ? 'node.exe' : 'bin/node';
    mkdirSync(path.dirname(path.join(runtimeCopy, relative)), { recursive: true });
    cpSync(path.join(runtime, relative), path.join(runtimeCopy, relative), { dereference: true });
    expect(() => verifyRuntime(runtimeCopy, target === 'darwin/arm64' ? 'darwin/amd64' : 'darwin/arm64')).toThrow();
    const destination = path.join(scratch, 'release with spaces', 'agent-host');
    packageAgentHost({ runtime: runtimeCopy, target, destination });
    const bundled = path.join(destination, 'runtime', relative);
    expect(existsSync(bundled)).toBe(true);
    expect(existsSync(path.join(destination, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).toBe(true);
    expect(existsSync(path.join(destination, 'run-agent-host.sh'))).toBe(false);
    const result = spawnSync(bundled, ['-p', 'process.versions.node'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(NODE_VERSION);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);
