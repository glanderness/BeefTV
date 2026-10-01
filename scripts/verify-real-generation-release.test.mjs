import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('release receipt rejects incomplete, stale, reused and unbalanced evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeftv-receipt-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init');
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'docs/release-evidence'), { recursive: true });
    writeFileSync(join(dir, 'scripts/verify-real-generation-release.mjs'), readFileSync(new URL('./verify-real-generation-release.mjs', import.meta.url)));
    writeFileSync(join(dir, 'VERSION'), 'v1.6.17\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate');
    const run = (...args) => execFileSync(process.execPath, ['scripts/verify-real-generation-release.mjs', ...args], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    const paths = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
    const valid = { version: 'v1.6.17', sourceDigest: run('--fingerprint').trim(), budgetCNY: 50, spentCNY: 12, pendingCNY: 0, upgrade: { preservedData: true, generationVerified: true }, cases: [1, 2].flatMap(round => paths.map(path => ({ round, path, taskId: `${round}/${path}`, providerRequestId: `${round}/${path}`, clientVersion: 'v1.6.17', platform: 'test-only', fixtureDigest: 'a'.repeat(64), model: 'test-only', status: 'succeeded', clientSubmitted: true, canvasVerified: true, mediaDecoded: true, mediaOpened: true, billing: 'settled', costCNY: 1, artifactSHA256: 'b'.repeat(64) }))) };
    const save = value => writeFileSync(join(dir, 'docs/release-evidence/v1.6.17.json'), JSON.stringify(value));
    save(valid); assert.match(run(), /12\/12/);
    for (const mutate of [r => r.cases.pop(), r => r.sourceDigest = 'old', r => r.cases[1].taskId = r.cases[0].taskId, r => r.cases[0].clientSubmitted = false, r => r.cases[0].clientVersion = 'v1.6.16', r => r.pendingCNY = 1, r => r.spentCNY = 51, r => r.spentCNY = 1]) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    for (const version of ['v1.6.18', 'v1.6.19']) {
      writeFileSync(join(dir, 'VERSION'), `${version}\n`);
      git('add', 'VERSION'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', version);
      const waiver = { ...valid, version, sourceDigest: run('--fingerprint').trim(), cases: [], liveTestWaiver: { approvedBy: 'Ender', instruction: '没事 这轮就不用实测了' }, verification: { windowsNativeRegression: 'passed' }, review: { result: 'approved' } };
      const saveWaiver = r => writeFileSync(join(dir, `docs/release-evidence/${version}.json`), JSON.stringify(r));
      saveWaiver(waiver);
      if (version === 'v1.6.18') {
        assert.match(run(), /waived by owner.*live matrix NOT completed/);
        for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.windowsNativeRegression = 'unverified']) {
          const invalid = structuredClone(waiver); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
        }
      } else assert.throws(() => run());
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
