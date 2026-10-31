import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeSourceDigest,
  runReleaseGate,
  validateReleaseReceipt,
  verifyReleaseEvidenceDirectory,
} from './verify-real-generation-release.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIGEST = '92acb696882e9fad8849dc2b7b71dd499ac2583fbd9bc5444dcdd4b6f6771e42';
const SAMPLE_EVIDENCE_BYTES = Buffer.from(JSON.stringify({ version: 'v2.1.0', passed: true }));
const SAMPLE_EVIDENCE_SHA256 = createHash('sha256').update(SAMPLE_EVIDENCE_BYTES).digest('hex');

function validReceipt(overrides = {}) {
  return {
    version: 'v2.1.0',
    sourceDigest: SAMPLE_DIGEST,
    passed: true,
    evidenceSha256: SAMPLE_EVIDENCE_SHA256,
    ...overrides,
  };
}

test('committed minimal release receipt passes dry-run and matches release tag or HEAD sourceDigest', () => {
  const dryRunResult = runReleaseGate({ cwd: ROOT_DIR, argv: ['--dry-run'] });
  assert.equal(dryRunResult.mode, 'dry-run');
  assert.equal(dryRunResult.receipt.version, dryRunResult.version);
  assert.equal(dryRunResult.receipt.passed, true);

  const tagCheck = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${dryRunResult.version}`], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  const targetRef = tagCheck.status === 0 ? dryRunResult.version : 'HEAD';
  const releaseResult = runReleaseGate({ cwd: ROOT_DIR, argv: ['--ref', targetRef] });
  assert.equal(releaseResult.mode, 'release');
  assert.equal(releaseResult.receipt.sourceDigest, computeSourceDigest(ROOT_DIR, targetRef));
});

test('validateReleaseReceipt accepts only minimal receipt fields and verifies evidence sha256', () => {
  assert.equal(
    validateReleaseReceipt(validReceipt(), {
      expectedVersion: 'v2.1.0',
      expectedSourceDigest: SAMPLE_DIGEST,
      fullEvidenceBytes: SAMPLE_EVIDENCE_BYTES,
    }),
    true,
  );

  for (const forbiddenField of [
    'ownerException',
    'spentCNY',
    'budgetCNY',
    'cases',
    'approvedBy',
    'taskId',
    'authorizationSHA256',
  ]) {
    assert.throws(
      () =>
        validateReleaseReceipt(validReceipt({ [forbiddenField]: 'internal' }), {
          expectedVersion: 'v2.1.0',
          expectedSourceDigest: SAMPLE_DIGEST,
        }),
      /disallowed internal field/,
    );
  }

  assert.throws(
    () =>
      validateReleaseReceipt(validReceipt({ passed: false }), {
        expectedVersion: 'v2.1.0',
        expectedSourceDigest: SAMPLE_DIGEST,
      }),
    /passed must be true/,
  );

  assert.throws(
    () =>
      validateReleaseReceipt(validReceipt(), {
        expectedVersion: 'v2.1.0',
        expectedSourceDigest: 'a'.repeat(64),
      }),
    /does not match this release source/,
  );

  assert.throws(
    () =>
      validateReleaseReceipt(validReceipt(), {
        expectedVersion: 'v2.1.0',
        expectedSourceDigest: SAMPLE_DIGEST,
        fullEvidenceBytes: Buffer.from('tampered'),
      }),
    /evidenceSha256 does not match full evidence file/,
  );
});

test('release gate CLI succeeds in simulated release checkout and rejects non-receipt files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeftv-release-gate-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'CI'], { cwd: dir });

    for (const rel of ['backend', 'web', 'agent-host', 'plugin-packages', 'scripts', 'assets', '.github/workflows', 'docs/release-evidence']) {
      mkdirSync(join(dir, rel), { recursive: true });
    }
    writeFileSync(join(dir, 'VERSION'), 'v2.1.1\n');
    writeFileSync(join(dir, 'backend/main.go'), 'package main\n');
    writeFileSync(join(dir, 'web/index.ts'), 'export {};\n');
    writeFileSync(join(dir, 'agent-host/index.mjs'), 'export {};\n');
    writeFileSync(join(dir, 'plugin-packages/manifest.json'), '{}\n');
    writeFileSync(join(dir, 'scripts/verify.mjs'), 'export {};\n');
    writeFileSync(join(dir, 'assets/app-icon.png'), 'png');
    writeFileSync(join(dir, '.github/workflows/release-desktop.yml'), 'name: Release\n');

    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'chore(release): prepare v2.1.1'], { cwd: dir });

    const digest = computeSourceDigest(dir);
    writeFileSync(
      join(dir, 'docs/release-evidence/v2.1.1.json'),
      JSON.stringify({
        version: 'v2.1.1',
        sourceDigest: digest,
        passed: true,
        evidenceSha256: SAMPLE_EVIDENCE_SHA256,
      }, null, 2),
    );

    const result = runReleaseGate({ cwd: dir, argv: [] });
    assert.equal(result.mode, 'release');
    assert.equal(result.version, 'v2.1.1');
    assert.equal(result.receipt.sourceDigest, digest);

    writeFileSync(join(dir, 'docs/release-evidence/v2.1.0.json'), JSON.stringify(validReceipt(), null, 2));
    assert.throws(
      () => verifyReleaseEvidenceDirectory(dir, 'v2.1.1'),
      /docs\/release-evidence must contain only v2\.1\.1\.json/,
    );
    rmSync(join(dir, 'docs/release-evidence/v2.1.0.json'));

    writeFileSync(join(dir, 'docs/release-evidence/v2.1.1-owner-authorization.json'), '{}');
    assert.throws(
      () => verifyReleaseEvidenceDirectory(dir, 'v2.1.1'),
      /disallowed internal file/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit-public-docs.sh passes on repository and rejects internal paths, session IDs, Feishu tables, budgets, and names', () => {
  const output = execFileSync('sh', ['scripts/audit-public-docs.sh'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  assert.match(output, /public documentation audit passed/);

  function createCleanAuditFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'beeftv-audit-docs-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'release-evidence'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'content', 'docs'), { recursive: true });
    copyFileSync(join(ROOT_DIR, 'scripts', 'audit-public-docs.sh'), join(dir, 'scripts', 'audit-public-docs.sh'));
    copyFileSync(
      join(ROOT_DIR, 'scripts', 'verify-real-generation-release.mjs'),
      join(dir, 'scripts', 'verify-real-generation-release.mjs'),
    );
    writeFileSync(join(dir, 'VERSION'), '2.1.0\n');
    writeFileSync(join(dir, 'README.md'), '# BeefTV\n\nSee [docs](docs/index.md).\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## v2.1.0\n');
    writeFileSync(join(dir, 'docs', 'index.md'), '# Docs\n');
    writeFileSync(
      join(dir, 'docs', 'release-evidence', 'v2.1.0.json'),
      JSON.stringify(validReceipt(), null, 2),
    );
    return dir;
  }

  function runAudit(dir) {
    return spawnSync('sh', ['scripts/audit-public-docs.sh'], {
      cwd: dir,
      encoding: 'utf8',
    });
  }

  const baseDir = createCleanAuditFixture();
  try {
    const cleanRun = runAudit(baseDir);
    assert.equal(cleanRun.status, 0, cleanRun.stderr);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }

  for (const privateRel of [
    'docs/adr/001.md',
    'docs/design/ui.md',
    'docs/superpowers/spec.md',
    'docs/audits/audit.md',
    'docs/visual-regression/diff.md',
    'docs/public-release/internal-backup-manifest.md',
    'docs/content/docs/progress/step.mdx',
    'docs/refactor/step.md',
    'docs/evidence/item.md',
    'docs/review-evidence/item.md',
    'docs/research/item.md',
    'docs/architecture/item.md',
    'docs/reports/item.md',
    'docs/plans/plan.md',
    'docs/implementation/item.md',
    'docs/ops/item.md',
    'reviews/review.md',
    'docs/agent-branch-testing.md',
    'docs/fal-h3-family.md',
    'docs/fal-h3-full-capabilities.md',
    'docs/fal-h3-max-turbo.md',
    'docs/model-provider-validation.md',
    'docs/real-generation-release.md',
    'docs/security-guardrail-audit.md',
    'docs/topaz-fal-integration-report-2026-10-20.md',
    'docs/windows-upgrade-compatibility.md',
  ]) {
    const dir = createCleanAuditFixture();
    try {
      const target = join(dir, privateRel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'internal\n');
      const res = runAudit(dir);
      assert.notEqual(res.status, 0, `expected failure for ${privateRel}`);
      assert.match(res.stderr, /internal documentation leaked into public tree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const brokenDoc of [
    '# Docs\n\n[missing](./does-not-exist.md)\n',
    '# Docs\n\n<img src="./missing-image.png" />\n',
    '# Docs\n\n<a href="./missing-page.mdx">link</a>\n',
  ]) {
    const dir = createCleanAuditFixture();
    try {
      writeFileSync(join(dir, 'docs', 'index.md'), brokenDoc);
      const res = runAudit(dir);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /broken local documentation links/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const badReceipt of [
    { version: 'v2.1.0' },
    validReceipt({ version: 'v2.0.9' }),
    validReceipt({ sourceDigest: 'short' }),
    validReceipt({ passed: false }),
    validReceipt({ evidenceSha256: 'short' }),
    validReceipt({ spentCNY: 12 }),
  ]) {
    const dir = createCleanAuditFixture();
    try {
      writeFileSync(join(dir, 'docs', 'release-evidence', 'v2.1.0.json'), JSON.stringify(badReceipt));
      const res = runAudit(dir);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /release receipt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const forbiddenSamples = [
    ['local volume path', ['', 'Volumes', 'Work'].join('/')],
    ['personal home path', ['', 'Users', 'sunny', 'Work'].join('/')],
    ['session identifier sess_', 'sess_' + '12345678'],
    ['session identifier tds/conv-', 'tds/conv-' + 'abcd1234'],
    ['Feishu table identifier', 'tbl' + 'AbcdEfgh1234'],
    ['owner-authorization', 'owner-' + 'authorization.json'],
    ['internal budget amount symbol', '预算 ' + '¥50'],
    ['internal budget amount yuan', '预算 ' + '50 元'],
    ['internal budget amount colon', '预算：' + '1000'],
    ['internal personal name', '联系 ' + '范键俊'],
    ['internal personal name Sunny', 'owner ' + 'Sunny'],
  ];

  for (const [label, sample] of forbiddenSamples) {
    const dir = createCleanAuditFixture();
    try {
      writeFileSync(join(dir, 'docs', 'index.md'), `# Docs\n\n${sample}\n`);
      const res = runAudit(dir);
      assert.notEqual(res.status, 0, `expected failure for ${label}`);
      assert.match(res.stderr, /forbidden internal patterns in public documentation/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const changelogLeakDir = createCleanAuditFixture();
  try {
    writeFileSync(join(changelogLeakDir, 'CHANGELOG.md'), `# Changelog\n\nsess_${'99999999'}\n`);
    const res = runAudit(changelogLeakDir);
    assert.notEqual(res.status, 0, 'expected failure for CHANGELOG.md leak');
    assert.match(res.stderr, /CHANGELOG\.md:3/);
  } finally {
    rmSync(changelogLeakDir, { recursive: true, force: true });
  }
});

