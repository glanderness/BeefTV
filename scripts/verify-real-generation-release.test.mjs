import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  THEME_AGENT_CONTRACT_VERSION,
  THEME_AGENT_SINCE,
  REQUIRED_AGENT_CHECK_IDS,
  DETERMINISTIC_FAULT_CHECK_IDS,
  fixtureDigestFromManifest,
  inspectFixtureManifest,
  requiresThemeAgentContract,
  findCopiedPriorTheme,
  releaseContractVersion,
  DURABLE_AGENT_CHECK_IDS,
} from './real-generation-release-contract.mjs';

const PATHS = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
const BUNNY_FIXTURES = {
  'image-1.jpg': '93701f45cf50d48de5ba452cd26eeafeba40a2fceef2e50fb98940ccb919250f',
  'image-2.jpg': '5946874132e3e82d7c1ed74db2a97e39b08f58ba7dc3fa9129adffcdd714af84',
  'reference.mp4': '282ef9563a8dbad86470368bef7afa9fcfd1df7791cf38f4f5e803c9d535da60',
};

function copyGate(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'docs/release-evidence'), { recursive: true });
  for (const name of ['verify-real-generation-release.mjs', 'real-generation-release-contract.mjs']) {
    writeFileSync(join(dir, 'scripts', name), readFileSync(new URL(`./${name}`, import.meta.url)));
  }
}

function setupRepo(version) {
  const dir = mkdtempSync(join(tmpdir(), 'beeftv-receipt-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  copyGate(dir);
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate');
  const run = (...args) => execFileSync(process.execPath, ['scripts/verify-real-generation-release.mjs', ...args], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const save = (value, name = version) => writeFileSync(join(dir, `docs/release-evidence/${name}.json`), JSON.stringify(value));
  const commitVersion = next => {
    writeFileSync(join(dir, 'VERSION'), `${next}\n`);
    git('add', 'VERSION');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', next);
  };
  return { dir, git, run, save, commitVersion };
}

test('v1.7.12 unified-name waiver cannot waive evidence or carry forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.12');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt'];
    const value = {
      version: 'v1.7.12', sourceDigest, budgetCNY: null, spentCNY: null, pendingCNY: null,
      newSpentCNY: 0, newPendingCNY: 0, cases: [], liveMatrixStatus: 'not_run_owner_waived', releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: '上线吧 豁免了 飞书文档你再看看还要不要更新', scope: 'seedance-unified-display', evidence },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.11', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['displayNames', 'nativeNames', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', method: id === 'nativeNames' ? 'native' : 'test', sourceDigest, evidence }])),
      packages: { status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, workflowEvidence: evidence },
    };
    save(value); assert.match(run(), /unified Seedance release; paid matrix NOT run/);
    const mutations = [
      r => r.liveTestWaiver.instruction = '上线吧', r => r.liveTestWaiver.approvedBy = 'other',
      r => r.liveTestWaiver.evidence = [], r => r.liveTestWaiver.scope = 'other',
      r => r.newSpentCNY = 1, r => r.newPendingCNY = null, r => r.cases.push({}),
      r => r.liveMatrixStatus = 'passed', r => r.budgetCNY = 0, r => r.spentCNY = 0, r => r.pendingCNY = 0,
      r => r.priorFinancialUncertainty.pendingCNY = 0, r => r.priorFinancialUncertainty.evidence = [],
      r => r.priorFinancialUncertainty.carriedFromVersion = 'v1.7.10', r => r.review.independent = false,
      r => r.review.sourceDigest = 'old', r => r.review.result = 'pending', r => r.upgrade.preservedData = false,
      r => r.upgrade.sourceDigest = 'old', r => r.verification.nativeNames.method = 'static',
      r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.packages.finalArchiveSmokeBeforeUpload = false, r => r.packages.workflowEvidence = [],
      r => r.packages.status = 'passed', r => r.packages.archives = {}, r => r.releaseComplete = true,
    ];
    for (const id of Object.keys(value.verification)) mutations.push(
      r => delete r.verification[id], r => r.verification[id].status = 'pending',
      r => r.verification[id].sourceDigest = 'old', r => r.verification[id].evidence = []);
    for (const mutate of mutations) {
      const invalid = structuredClone(value); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.7.13');
    save({ ...value, version: 'v1.7.13', sourceDigest: run('--fingerprint').trim() }, 'v1.7.13');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.10 name-only waiver retains native, review, financial and package gates', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.10');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const evidence = ['synthetic test receipt'];
    const value = {
      version: 'v1.7.10', sourceDigest, budgetCNY: 0, spentCNY: 0, newSpentCNY: 0, pendingCNY: 0,
      liveMatrixStatus: 'not_run_owner_waived', cases: [], releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: 'beeftv本次豁免 直接上线', scope: 'seedance-display-names-only', evidence },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.9', pendingCNY: null, evidence },
      review: { result: 'approved', independent: true, reviewer: 'fixture', sourceDigest, evidence },
      upgrade: { preservedData: true, sourceDigest, evidence },
      verification: Object.fromEntries(['displayNames', 'nativeNames', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', method: id === 'nativeNames' ? 'native' : 'test', sourceDigest, evidence }])),
      packages: { status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, workflowEvidence: evidence },
    };
    save(value);
    assert.match(run(), /display-name release; paid matrix NOT run/);
    for (const mutate of [
      r => { r.liveTestWaiver.instruction = '上线吧'; },
      r => { r.spentCNY = 1; },
      r => { r.liveMatrixStatus = 'passed'; },
      r => { r.priorFinancialUncertainty.pendingCNY = 0; },
      r => { r.review.independent = false; },
      r => { r.upgrade.preservedData = false; },
      r => { r.verification.nativeNames.method = 'static'; },
      r => { r.verification.displayNames.sourceDigest = 'old'; },
      r => { r.verification.ci.status = 'pending'; },
      r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; },
      r => { r.releaseComplete = true; },
    ]) {
      const invalid = structuredClone(value); mutate(invalid); save(invalid);
      assert.throws(() => run());
    }
    commitVersion('v1.7.11');
    value.version = 'v1.7.11'; value.sourceDigest = run('--fingerprint').trim(); save(value, 'v1.7.11');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.9 accepted evidence cannot hide gaps, skip native cases, or carry to another version', () => {
  const { dir, git, run, save, commitVersion } = setupRepo('v1.7.9');
  try {
    // Reuse Git objects only: no working files, accounts or private test media.
    git('fetch', '--quiet', '--depth=1', decodeURIComponent(new URL('..', import.meta.url).pathname), 'refs/tags/v1.7.9');
    git('update-ref', 'HEAD', 'FETCH_HEAD');
    const value = JSON.parse(readFileSync(new URL('../docs/release-evidence/v1.7.9.json', import.meta.url)));
    value.sourceDigest = run('--fingerprint').trim();
    value.review.sourceDigest = value.sourceDigest;
    value.review.result = 'approved'; // Synthetic isolated test fixture, not a release approval.
    save(value);
    assert.match(run(), /owner-authorized evidence carry-forward/);
    for (const mutate of [
      r => { r.ownerException.instruction = 'yes'; },
      r => { r.pendingCNY = 0; },
      r => { r.budgetCNY = 200; },
      r => { r.portraitAcceptance.cases[1].billing = 'pending'; },
      r => { r.portraitAcceptance.cases[0].attempts = 2; },
      r => { r.cases[0].executedSourceDigest = r.sourceDigest; },
      r => { r.cases[0].confirmed = false; },
      r => { delete r.agentChecks.cli_mcp; },
      r => { r.agentChecks.session_restart.status = 'pending'; },
      r => { r.review.result = 'pending'; },
      r => { r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false; },
      r => { r.releaseComplete = true; },
    ]) {
      const invalid = structuredClone(value);
      mutate(invalid); save(invalid);
      assert.throws(() => run());
    }
    // Product changes cannot be hidden by updating the outer receipt digest.
    mkdirSync(join(dir, 'backend'), { recursive: true });
    writeFileSync(join(dir, 'backend/unaccepted-change.txt'), 'changed runtime');
    git('add', 'backend/unaccepted-change.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'unaccepted runtime');
    value.sourceDigest = run('--fingerprint').trim(); value.review.sourceDigest = value.sourceDigest; save(value);
    assert.throws(() => run());
    commitVersion('v1.7.10');
    value.version = 'v1.7.10'; value.sourceDigest = run('--fingerprint').trim(); save(value, 'v1.7.10');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.11 one-image authorization rejects additional calls, stale source, missing recovery or review', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.11');
  try {
    const digest = run('--fingerprint').trim();
    const bound = { sourceDigest: digest, evidence: ['synthetic.log'] };
    const valid = {
      version: 'v1.7.11', sourceDigest: digest, releaseComplete: false,
      ownerException: { scope: 'canvas-image-bind-regression-20261007', approvedBy: 'Ender', instruction: '只复测一次生成图片看看会不会复现报错即可上线', evidence: ['owner.log'] },
      liveMatrixStatus: 'not_run_owner_limited_to_one_image', paidSubmissionLimit: 1,
      cases: [{ path: 'image-image', model: 'beefapi::gpt-image-2.5', attempts: 1, status: 'succeeded', clientSubmitted: true, canvasVerified: true, mediaDecoded: true, mediaOpened: true, billing: 'settled', costCNY: 0.42, executedSourceDigest: digest, clientVersion: 'v1.7.11', taskId: 'synthetic-task', providerRequestId: 'synthetic-request', artifactSHA256: 'a'.repeat(64), evidence: ['native.log'] }],
      newSpentCNY: 0.42, newPendingCNY: 0,
      budgetCNY: null, spentCNY: null, pendingCNY: null,
      financialUncertainty: { status: 'unresolved', evidence: ['prior.json'] },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.10', pendingCNY: null, evidence: ['prior.json'] },
      review: { ...bound, result: 'approved', independent: true, reviewer: 'synthetic-reviewer' },
      upgrade: { ...bound, preservedData: true },
      verification: Object.fromEntries(['saveBarrier', 'resultRecovery', 'scopeIsolation', 'localReleaseGate', 'ci'].map(id => [id, { ...bound, status: 'passed' }])),
      packages: { status: 'pending_release_workflow', windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, workflowEvidence: ['workflow.yml'] },
    };
    save(valid); assert.match(run(), /single-image regression passed/);
    for (const mutate of [
      r => r.cases.push(r.cases[0]), r => r.cases[0].attempts = 2,
      r => r.cases[0].canvasVerified = false, r => r.cases[0].billing = 'pending',
      r => r.cases[0].executedSourceDigest = 'b'.repeat(64),
      r => r.ownerException.instruction = 'yes', r => r.review.result = 'pending',
      r => r.verification.resultRecovery.status = 'pending', r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.budgetCNY = 0, r => r.spentCNY = 0, r => r.pendingCNY = 0,
      r => delete r.financialUncertainty, r => r.financialUncertainty.evidence = [],
      r => { r.cases[0].costCNY = 0; r.newSpentCNY = 0; },
      r => r.packages.finalArchiveSmokeBeforeUpload = false, r => r.releaseComplete = true,
    ]) { const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run()); }
    commitVersion('v1.7.12');
    valid.version = 'v1.7.12'; valid.sourceDigest = run('--fingerprint').trim(); save(valid, 'v1.7.12');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release fingerprint binds the packaged app icon', () => {
  const { dir, git, run } = setupRepo('v1.7.6');
  try {
    const before = run('--fingerprint').trim();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/app-icon.png'), 'test icon bytes');
    git('add', 'assets/app-icon.png');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'change packaged icon');
    assert.notEqual(run('--fingerprint').trim(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeChecks(sourceDigest, tweak) {
  const checks = Object.fromEntries(REQUIRED_AGENT_CHECK_IDS.map(id => [id, {
    status: 'passed',
    method: DETERMINISTIC_FAULT_CHECK_IDS.includes(id) ? 'deterministic' : 'native',
    evidence: [`${id}.log`],
    sourceDigest,
  }]));
  if (tweak) tweak(checks);
  return checks;
}

function makeCases(version, fixtureDigest) {
  return [1, 2].flatMap(round => PATHS.map(path => ({
    round,
    path,
    taskId: `${round}/${path}`,
    providerRequestId: `${round}/${path}`,
    clientVersion: version,
    platform: 'test-only',
    fixtureDigest,
    model: 'test-only',
    status: 'succeeded',
    clientSubmitted: true,
    canvasVerified: true,
    mediaDecoded: true,
    mediaOpened: true,
    billing: 'settled',
    costCNY: 1,
    artifactSHA256: 'b'.repeat(64),
    entrypoint: 'assistant',
    sessionId: `s-${round}-${path}`,
    turnId: `t-${round}-${path}`,
    proposalId: `p-${round}-${path}`,
    operationId: `proposal:p-${round}-${path}:node-${round}-${path}`,
    confirmed: true,
  })));
}

function makeScenario(fixtures, extra = {}) {
  return {
    id: 'autumn-lantern-2026',
    title: 'city lantern night',
    source: 'https://example.invalid/trends/lantern',
    queryDate: '2026-10-02',
    fixtures,
    ...extra,
  };
}

function themeFixtures(salt = 'c') {
  return {
    'theme-a.jpg': salt.repeat(64),
    'theme-b.png': String.fromCharCode(salt.charCodeAt(0) + 1).repeat(64),
    'theme-c.mp4': String.fromCharCode(salt.charCodeAt(0) + 2).repeat(64),
  };
}

function makeV2(version, sourceDigest, extra = {}) {
  const fixtures = extra.fixtures || themeFixtures();
  const fixtureDigest = fixtureDigestFromManifest(fixtures);
  const { fixtures: _ignored, ...rest } = extra;
  return {
    version,
    sourceDigest,
    contractVersion: THEME_AGENT_CONTRACT_VERSION,
    budgetCNY: 50,
    spentCNY: 12,
    pendingCNY: 0,
    upgrade: { preservedData: true, generationVerified: true },
    scenario: makeScenario(fixtures),
    agentChecks: makeChecks(sourceDigest),
    review: { result: 'approved', sourceDigest, reviewer: 'independent-test-reviewer', evidence: ['review.md'] },
    cases: makeCases(version, fixtureDigest),
    ...rest,
  };
}

function makeV3(version, sourceDigest, extra = {}) {
  const fixtures = extra.fixtures || { ...themeFixtures(), 'voice.wav': 'f'.repeat(64) };
  const value = makeV2(version, sourceDigest, { ...extra, fixtures, contractVersion: 3 });
  value.review.independent = true;
  for (const id of DURABLE_AGENT_CHECK_IDS) value.agentChecks[id] = { status: 'passed', method: 'native', sourceDigest, evidence: [`${id}.log`] };
  value.billingAttempts = value.cases.map(item => ({ id: item.taskId, taskId: item.taskId, kind: 'media', billing: 'settled', costCNY: item.costCNY, evidence: ['billing.json'] }));
  value.billingAttempts.push({ id: 'chat-1', kind: 'chat', billing: 'settled', costCNY: 1, evidence: ['chat-billing.json'] });
  value.spentCNY = value.billingAttempts.reduce((sum, item) => sum + item.costCNY, 0);
  return value;
}

test('v1.7.13 contract 3 preserves twelve cases, adds native capabilities and reconciles CNY50', () => {
  const { dir, run, save } = setupRepo('v1.7.13');
  try {
    const digest = run('--fingerprint').trim();
    const valid = makeV3('v1.7.13', digest);
    save(valid); assert.match(run(), /12\/12/);
    assert.equal(releaseContractVersion('v1.7.12'), 2);
    assert.equal(releaseContractVersion('v1.7.13'), 3);
    assert.equal(releaseContractVersion('v2.0.0'), 3);
    assert.equal(inspectFixtureManifest(valid.scenario.fixtures, 3).ok, true);
    assert.equal(inspectFixtureManifest(valid.scenario.fixtures, 2).ok, false);
    const mutations = [
      r => r.contractVersion = 2, r => r.contractVersion = 4,
      r => r.budgetCNY = 51, r => r.spentCNY = 51, r => r.pendingCNY = 1,
      r => r.review.independent = false, r => delete r.scenario.fixtures['voice.wav'],
      r => r.cases.pop(), r => r.cases[0].confirmed = false,
      r => delete r.billingAttempts, r => r.billingAttempts.pop(),
      r => r.billingAttempts[0].billing = 'pending', r => r.billingAttempts[0].costCNY = null,
      r => r.billingAttempts[0].evidence = [], r => r.billingAttempts[0].taskId = 'unrelated',
      r => r.billingAttempts.push(r.billingAttempts[0]),
      r => r.liveTestWaiver = { approvedBy: 'Ender', instruction: '上线吧 豁免了 飞书文档你再看看还要不要更新', scope: 'seedance-unified-display' },
      r => r.ownerException = { approvedBy: 'Ender', instruction: '上线吧' },
    ];
    for (const id of DURABLE_AGENT_CHECK_IDS) mutations.push(r => delete r.agentChecks[id], r => r.agentChecks[id].sourceDigest = 'old', r => r.agentChecks[id].method = 'fixture');
    // Historical waivers cannot excuse v3 evidence or a missing matrix.
    for (const mutate of mutations) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const waived = structuredClone(valid); waived.cases = []; waived.liveTestWaiver = { approvedBy: 'Ender', instruction: '上线吧 豁免了 飞书文档你再看看还要不要更新', scope: 'seedance-unified-display' };
    save(waived); assert.throws(() => run());
    for (const id of ['native_video', 'native_audio', 'skill_version', 'skill_files', 'permission_modes', 'external_business', 'media_film_review']) {
      const invalid = structuredClone(valid); invalid.agentChecks[id].method = 'deterministic'; save(invalid); assert.throws(() => run());
    }
    const fault = structuredClone(valid); fault.agentChecks.durable_resume.method = 'deterministic'; save(fault); assert.match(run(), /12\/12/);
    const refunds = structuredClone(valid); refunds.billingAttempts.push({ id: 'failed-refunded', kind: 'chat', billing: 'refunded', costCNY: 0, evidence: ['refund.json'] }); save(refunds); assert.match(run(), /12\/12/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const version of ['v1.7.3', 'v1.7.5', 'v1.7.6', 'v1.7.7', 'v1.7.8']) test(`${version} waiver requires current targeted evidence and cannot carry forward`, () => {
  const { dir, run, save, commitVersion } = setupRepo(version);
  try {
    const sourceDigest = run('--fingerprint').trim();
    const proof = { status: 'passed', sourceDigest, evidence: ['synthetic-test-evidence'] };
    const valid = {
      version, sourceDigest, budgetCNY: 0, spentCNY: 0, newSpentCNY: 0, pendingCNY: 0,
      liveMatrixStatus: 'not_run_owner_waived', cases: [], releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: '本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布', scope: 'byok-updater-targeted-acceptance' },
      priorFinancialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.2', pendingCNY: null, failedRequestIds: ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'], evidence: ['prior.json'] },
      review: { result: 'approved', independent: true, reviewer: 'test-only', sourceDigest, evidence: ['review.md'] },
      upgrade: { preservedData: true, sourceDigest, evidence: ['upgrade.md'] },
      verification: Object.fromEntries(['modelServiceFlow', 'credentialPersistence', 'saveBarrier', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }])),
      packages: { status: 'pending_release_workflow', finalArchiveSmokeBeforeUpload: true, windowsReleasedUpgradeAndRollbackBeforeUpload: true, workflowEvidence: ['workflow.yml'] },
    };
    if (version === 'v1.7.5') {
      valid.liveTestWaiver = { approvedBy: 'Ender', instruction: '合了一起发布吧', scope: 'byok-download-resume-targeted-acceptance' };
      for (const id of ['fullReferenceContract', 'relativeDownload', 'nativePlaybackAndSave', 'updaterResume', 'privacyScan']) valid.verification[id] = { ...proof, method: 'native' };
      for (const id of ['fullReferenceContract', 'relativeDownload', 'nativePlaybackAndSave', 'updaterResume', 'privacyScan']) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
      const nonNative = structuredClone(valid); nonNative.verification.nativePlaybackAndSave.method = 'static'; save(nonNative); assert.throws(() => run());
      const oldWaiver = structuredClone(valid); oldWaiver.liveTestWaiver.instruction = '本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布'; save(oldWaiver); assert.throws(() => run());
    }
    if (version === 'v1.7.6') {
      valid.liveTestWaiver.scope = 'workspace-assets-targeted-acceptance';
      valid.verification = Object.fromEntries(['uploadLifecycle', 'deleteConfirmation', 'archivedRecovery', 'mediaPreview', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }]));
      for (const id of Object.keys(valid.verification)) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
    }
    if (version === 'v1.7.7') {
      valid.liveTestWaiver = { approvedBy: 'Ender', instruction: '本版豁免付费矩阵，专项验收、review 和 CI 通过后发布', scope: 'reference-media-targeted-acceptance' };
      valid.verification = Object.fromEntries(['mediaAdmission', 'referenceLinks', 'preparationStage', 'configScalars', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }]));
      for (const id of Object.keys(valid.verification)) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
    }
    if (version === 'v1.7.8') {
      valid.liveTestWaiver = { approvedBy: 'Ender', instruction: '豁免  你只要复现并且保证修复  同时你现在让一个子agent去看看还有没有这类bug 审计一下', scope: 'video-preview-audio-targeted-acceptance' };
      valid.verification = Object.fromEntries(['previewRegression', 'configRecovery', 'typeAudit', 'localReleaseGate', 'ci'].map(id => [id, { ...proof }]));
      for (const id of Object.keys(valid.verification)) {
        const missing = structuredClone(valid); delete missing.verification[id]; save(missing); assert.throws(() => run());
      }
    }
    save(valid); assert.match(run(), /paid matrix NOT run/);
    for (const mutate of [
      r => r.liveTestWaiver.approvedBy = 'other', r => r.review.independent = false,
      r => r.review.sourceDigest = 'stale', r => r.upgrade.preservedData = false,
      r => r.newSpentCNY = 1, r => r.cases = [{}], r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.verification[version === 'v1.7.8' ? 'previewRegression' : version === 'v1.7.7' ? 'referenceLinks' : version === 'v1.7.6' ? 'archivedRecovery' : 'credentialPersistence'].status = 'failed', r => r.verification.ci.sourceDigest = 'stale',
      r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.releaseComplete = true, r => r.packages.status = 'passed',
    ]) {
      const changed = structuredClone(valid); mutate(changed); save(changed); assert.throws(() => run());
    }
    const next = version === 'v1.7.3' ? 'v1.7.4' : version === 'v1.7.5' ? 'v1.7.6' : version === 'v1.7.6' ? 'v1.7.7' : version === 'v1.7.7' ? 'v1.7.8' : 'v1.7.9';
    commitVersion(next);
    save({ ...valid, version: next, sourceDigest: run('--fingerprint').trim() }, next);
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.2 paid-generation waiver requires targeted evidence and preserves prior uncertainty', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.2');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const requestIds = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
    const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64'];
    const checkIds = ['mcpStartup', 'assistantRuntime', 'windowsNativeRuntime', 'packagedCLI', 'localReleaseGate', 'ci'];
    const valid = {
      version: 'v1.7.2', sourceDigest, budgetCNY: 100, spentCNY: 43.74479, newSpentCNY: 0,
      pendingCNY: null, knownPendingCNY: 0, cases: [], liveMatrixStatus: 'not_run_owner_waived', releaseComplete: false,
      liveTestWaiver: { approvedBy: 'Ender', instruction: '本版豁免付费生成，专项验收通过后上线', scope: 'mcp-assistant-targeted-acceptance' },
      financialUncertainty: { status: 'unresolved', carriedFromVersion: 'v1.7.1', failedRequestIds: requestIds, evidence: ['prior-financial-audit.md'] },
      review: { result: 'approved', independent: true, reviewer: 'independent-test-reviewer', sourceDigest, evidence: ['review.md'] },
      upgrade: { preservedData: true, sourceDigest, evidence: ['upgrade.md'] },
      verification: Object.fromEntries(checkIds.map(id => [id, { status: 'passed', sourceDigest, evidence: [`${id}.md`] }])),
    };
    valid.verification.windowsNativeRuntime.method = 'native';
    Object.assign(valid.verification.packagedCLI, {
      method: 'package-validator', platforms, finalArchiveSmokeBeforeUpload: true,
      releaseWorkflowEvidence: ['release-desktop.yml#archive-validation-before-upload'], finalArchivesStatus: 'pending_release_workflow',
    });
    save(valid);
    assert.match(run(), /media matrix NOT run; new expense 0; two prior refund terminal states remain unknown; final archives: pending_release_workflow/);
    const mutations = [
      r => r.sourceDigest = 'stale', r => r.pendingCNY = 0, r => r.pendingCNY = 1,
      r => r.knownPendingCNY = 1, r => r.spentCNY = 0, r => r.newSpentCNY = 1,
      r => r.financialUncertainty.status = 'settled', r => r.financialUncertainty.carriedFromVersion = 'v1.6.23',
      r => r.financialUncertainty.failedRequestIds.pop(), r => r.financialUncertainty.failedRequestIds.push('extra'),
      r => r.financialUncertainty.evidence = [], r => delete r.financialUncertainty,
      r => r.liveTestWaiver.approvedBy = 'other', r => r.liveTestWaiver.scope = 'model-picker-targeted-acceptance',
      r => r.liveTestWaiver.instruction = '上线吧', r => r.review.independent = false,
      r => r.review.sourceDigest = 'stale', r => r.review.result = 'pending', r => r.review.evidence = [],
      r => r.upgrade.preservedData = false, r => r.upgrade.sourceDigest = 'stale', r => r.upgrade.evidence = [],
      r => r.cases.push({ status: 'succeeded' }), r => r.liveMatrixStatus = 'passed',
      r => r.verification.windowsNativeRuntime.method = 'cross-compiled',
      r => r.verification.packagedCLI.method = 'mocked-final-archives',
      r => r.verification.packagedCLI.platforms.pop(), r => r.verification.packagedCLI.platforms.push('linux-amd64'),
      r => r.verification.packagedCLI.finalArchiveSmokeBeforeUpload = false,
      r => r.verification.packagedCLI.releaseWorkflowEvidence = [],
      r => r.verification.packagedCLI.finalArchivesStatus = 'passed',
      r => r.verification.packagedCLI.finalArchivesStatus = 'waived',
      r => r.verification.packagedCLI.finalArchives = { 'windows-amd64': { status: 'passed' } },
      r => r.releaseComplete = true,
    ];
    for (const id of checkIds) {
      mutations.push(r => delete r.verification[id], r => r.verification[id].status = 'pending',
        r => r.verification[id].evidence = [], r => r.verification[id].sourceDigest = 'stale');
    }
    for (const mutate of mutations) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const completed = structuredClone(valid);
    completed.releaseComplete = true;
    completed.verification.packagedCLI.finalArchivesStatus = 'passed';
    completed.verification.packagedCLI.finalArchives = Object.fromEntries(platforms.map(platform => [platform, {
      status: 'passed', sourceDigest, sha256: 'a'.repeat(64), evidence: [`${platform}-archive-smoke.md`],
    }]));
    save(completed); assert.match(run(), /final archives: passed/);
    for (const platform of platforms) {
      for (const field of ['status', 'sourceDigest', 'sha256', 'evidence']) {
        const invalid = structuredClone(completed); delete invalid.verification.packagedCLI.finalArchives[platform][field];
        save(invalid); assert.throws(() => run());
      }
    }
    commitVersion('v1.7.3');
    save({ ...valid, version: 'v1.7.3', sourceDigest: run('--fingerprint').trim() }, 'v1.7.3');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.1 targeted acceptance preserves uncertainty and never carries forward', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.7.1');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const requestIds = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
    const instruction = '上线吧 1.7.1 值得一个大版本';
    const valid = {
      version: 'v1.7.1', sourceDigest, budgetCNY: 100, spentCNY: 43.74479, newSpentCNY: 0,
      pendingCNY: null, knownPendingCNY: 0, cases: [], liveMatrixStatus: 'not_run_owner_waived',
      liveTestWaiver: { approvedBy: 'Ender', instruction, scope: 'model-picker-targeted-acceptance' },
      financialUncertainty: { status: 'unresolved', failedRequestIds: requestIds },
      financialEvidenceException: { approvedBy: 'Ender', instruction, scope: 'two-failed-chat-refund-evidence-only', requestIds, evidence: ['audit.md'] },
      review: { result: 'approved', reviewer: 'independent', sourceDigest, evidence: ['review.md'] },
      upgrade: { preservedData: true },
      verification: Object.fromEntries(['modelPicker', 'authorizationDefaultRecovery', 'saveBarrier', 'localReleaseGate', 'ci'].map(id => [id, { status: 'passed', evidence: ['targeted.md'] }])),
    };
    save(valid); assert.match(run(), /media matrix NOT run/);
    for (const mutate of [r => r.pendingCNY = 0, r => r.newSpentCNY = 1,
      r => r.financialUncertainty.failedRequestIds.push('other'), r => r.financialEvidenceException.evidence = [],
      r => r.liveTestWaiver.instruction = '上线吧', r => r.review.sourceDigest = 'stale',
      r => r.review.result = 'pending', r => r.upgrade.preservedData = false,
      r => r.cases.push({status:'succeeded'}), r => r.liveMatrixStatus = 'passed',
      r => r.verification.modelPicker.evidence = [], r => delete r.verification.ci]) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.7.2');
    save({ ...valid, version: 'v1.7.2', sourceDigest: run('--fingerprint').trim() }, 'v1.7.2');
    assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.6.23 failed-chat evidence exception is exact and cannot waive media or future releases', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.6.23');
  try {
    const requestIds = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
    const valid = makeV2('v1.6.23', run('--fingerprint').trim(), {
      pendingCNY: null, knownPendingCNY: 0,
      financialUncertainty: { status: 'unresolved', failedRequestIds: requestIds },
      financialEvidenceException: { approvedBy: 'Ender', instruction: '上线吧', scope: 'two-failed-chat-refund-evidence-only', requestIds, evidence: ['financial-audit.json'] },
    });
    save(valid); assert.match(run(), /total pending remains unknown/);
    for (const mutate of [r => delete r.financialEvidenceException, r => r.knownPendingCNY = 1, r => r.pendingCNY = 1, r => r.pendingCNY = 0, r => delete r.financialEvidenceException.approvedBy, r => r.financialEvidenceException.requestIds = ['other'], r => r.financialUncertainty.failedRequestIds = [...requestIds, 'other'], r => r.financialEvidenceException.evidence = [], r => r.cases[0].billing = 'pending', r => r.cases.pop(), r => r.review.result = 'pending']) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    commitVersion('v1.6.24');
    save({ ...valid, version: 'v1.6.24', sourceDigest: run('--fingerprint').trim() }, 'v1.6.24');
    assert.throws(() => run(), /unresolved billing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical fixture digest matches historical bunny receipts', () => {
  assert.equal(fixtureDigestFromManifest(BUNNY_FIXTURES), '2714dc3b18420b1b9b266fef54883611185a71b2afb8fe78db13885fac07e2c6');
  assert.equal(inspectFixtureManifest(BUNNY_FIXTURES).ok, true);
  assert.equal(inspectFixtureManifest({ 'only.jpg': 'a'.repeat(64), 'clip.mp4': 'b'.repeat(64) }).ok, false);
  assert.equal(inspectFixtureManifest({ 'a.jpg': 'a'.repeat(64), 'b.jpg': 'a'.repeat(64), 'c.mp4': 'b'.repeat(64) }).ok, false);
});

test('theme/agent contract starts at v1.6.23 and stays closed for unknown versions', () => {
  assert.equal(requiresThemeAgentContract('v1.6.22'), false);
  assert.equal(requiresThemeAgentContract(THEME_AGENT_SINCE), true);
  assert.equal(requiresThemeAgentContract('v1.6.24'), true);
  assert.equal(requiresThemeAgentContract('v1.7.0'), true);
  assert.equal(requiresThemeAgentContract('v2.0.0'), true);
  assert.throws(() => requiresThemeAgentContract('1.6.23'), /unparseable VERSION/);
  const prior = { contractVersion: 2, version: 'v1.6.23', scenario: makeScenario(themeFixtures()) };
  const digest = fixtureDigestFromManifest(themeFixtures());
  assert.ok(findCopiedPriorTheme(makeScenario(themeFixtures()), digest, [prior]));
  assert.equal(findCopiedPriorTheme(makeScenario(themeFixtures('a'), { id: 'new-theme' }), digest, [{ ...prior, contractVersion: 1 }]), null);
});

test('release receipt rejects incomplete, stale, reused and unbalanced evidence', () => {
  const { dir, git, run, save } = setupRepo('v1.6.17');
  try {
    const valid = { version: 'v1.6.17', sourceDigest: run('--fingerprint').trim(), budgetCNY: 50, spentCNY: 12, pendingCNY: 0, upgrade: { preservedData: true, generationVerified: true }, cases: [1, 2].flatMap(round => PATHS.map(path => ({ round, path, taskId: `${round}/${path}`, providerRequestId: `${round}/${path}`, clientVersion: 'v1.6.17', platform: 'test-only', fixtureDigest: 'a'.repeat(64), model: 'test-only', status: 'succeeded', clientSubmitted: true, canvasVerified: true, mediaDecoded: true, mediaOpened: true, billing: 'settled', costCNY: 1, artifactSHA256: 'b'.repeat(64) }))) };
    save(valid); assert.match(run(), /12\/12/);
    for (const mutate of [r => r.cases.pop(), r => r.sourceDigest = 'old', r => r.cases[1].taskId = r.cases[0].taskId, r => r.cases[0].clientSubmitted = false, r => r.cases[0].clientVersion = 'v1.6.16', r => r.pendingCNY = 1, r => r.spentCNY = 51, r => r.spentCNY = 1]) {
      const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    mkdirSync(join(dir, 'agent-host'));
    for (const file of ['server.mjs', 'bun.lock', 'package.json']) {
      const current = { ...valid, sourceDigest: run('--fingerprint').trim() };
      save(current); assert.match(run(), /12\/12/);
      writeFileSync(join(dir, 'agent-host', file), `changed ${file}\n`);
      git('add', `agent-host/${file}`);
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `host ${file}`);
      assert.notEqual(run('--fingerprint').trim(), current.sourceDigest);
      assert.throws(() => run(), /receipt does not match this release source/);
    }
    for (const version of ['v1.6.18', 'v1.6.19', 'v1.6.20']) {
      writeFileSync(join(dir, 'VERSION'), `${version}\n`);
      git('add', 'VERSION'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', version);
      const waiver = { ...valid, version, sourceDigest: run('--fingerprint').trim(), cases: [], liveTestWaiver: { approvedBy: 'Ender', instruction: '没事 这轮就不用实测了' }, verification: { windowsNativeRegression: 'passed' }, review: { result: 'approved' } };
      const saveWaiver = r => save(r, version);
      saveWaiver(waiver);
      if (version === 'v1.6.18') {
        assert.match(run(), /waived by owner.*live matrix NOT completed/);
        for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.windowsNativeRegression = 'unverified']) {
          const invalid = structuredClone(waiver); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
        }
      } else {
        assert.throws(() => run());
        const directRelease = { ...waiver, liveTestWaiver: { approvedBy: 'Ender', instruction: '发布吧' }, verification: { localReleaseGate: 'passed', errorRegression: 'passed' } };
        saveWaiver(directRelease);
        if (version === 'v1.6.19') {
          assert.match(run(), /waived by owner.*live matrix NOT completed/);
          for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.spentCNY = 51, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.errorRegression = 'unverified', r => r.verification.localReleaseGate = 'unverified', r => r.upgrade.preservedData = false]) {
            const invalid = structuredClone(directRelease); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
          }
        } else {
          assert.throws(() => run());
          const downloadOnly = { ...valid, version, sourceDigest: run('--fingerprint').trim(), budgetCNY: 0, spentCNY: 0, pendingCNY: 0, cases: [], liveTestWaiver: { approvedBy: 'Ender', instruction: '本版豁免付费生成矩阵，review 通过就发布（推荐）' }, verification: { windowsDownloads: 'passed', ci: 'passed' }, review: { result: 'approved' }, upgrade: { preservedData: true } };
          saveWaiver(downloadOnly);
          assert.match(run(), /waived by owner.*live matrix NOT completed/);
          for (const mutate of [r => r.sourceDigest = 'old', r => r.pendingCNY = 1, r => r.spentCNY = 1, r => r.liveTestWaiver.approvedBy = 'unknown', r => r.review.result = 'pending', r => r.verification.windowsDownloads = 'unverified', r => r.verification.ci = 'unverified', r => r.upgrade.preservedData = false]) {
            const invalid = structuredClone(downloadOnly); mutate(invalid); saveWaiver(invalid); assert.throws(() => run());
          }
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.6.23+ requires theme, shared fixtures and native assistant evidence', () => {
  const { dir, run, save, commitVersion } = setupRepo('v1.6.23');
  try {
    const sourceDigest = run('--fingerprint').trim();
    const valid = makeV2('v1.6.23', sourceDigest);
    save(valid);
    assert.match(run(), /12\/12/);

    for (const [mutate, pattern] of [
      [r => { delete r.contractVersion; }, /explicit contractVersion=2 is required/],
      [r => { r.contractVersion = 1; }, /explicit contractVersion=2 is required/],
      [r => { r.contractVersion = 3; }, /explicit contractVersion=2 is required/],
      [r => { r.contractVersion = '2'; }, /explicit contractVersion=2 is required/],
      [r => { delete r.review; }, /independent review must approve/],
      [r => { r.review.result = 'pending'; }, /independent review must approve/],
      [r => { r.review.result = 'rejected'; }, /independent review must approve/],
      [r => { r.review.sourceDigest = 'old'; }, /independent review must approve/],
      [r => { r.review.reviewer = ' '; }, /independent review must approve/],
      [r => { r.review.evidence = []; }, /independent review must approve/],
      [r => { r.review.evidence = [' ']; }, /independent review must approve/],
      [r => { r.scenario.id = ''; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.title = ' '; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.source = 'ftp://example.invalid/trends'; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.queryDate = '2026/10/02'; }, /scenario must include nonempty id, title, source URL and query date/],
      [r => { r.scenario.fixtures = { 'only.jpg': 'c'.repeat(64), 'clip.mp4': 'd'.repeat(64) }; }, /fixture manifest must include at least two image and one video SHA256/],
      [r => { r.scenario.fixtures = { 'a.jpg': 'c'.repeat(64), 'b.png': 'd'.repeat(64) }; }, /fixture manifest must include at least two image and one video SHA256/],
      [r => { r.cases[0].fixtureDigest = 'f'.repeat(64); }, /cases must share the scenario fixtureDigest/],
      [r => { r.cases.pop(); }, /expected exactly twelve successful cases/],
      [r => { r.cases[1].taskId = r.cases[0].taskId; }, /missing or reused task/],
      [r => { r.cases[0].entrypoint = 'canvas'; }, /incomplete assistant provenance/],
      [r => { r.cases[0].sessionId = ''; }, /incomplete assistant provenance/],
      [r => { r.cases[0].turnId = ' '; }, /incomplete assistant provenance/],
      [r => { r.cases[0].proposalId = ''; }, /incomplete assistant provenance/],
      [r => { delete r.cases[0].operationId; }, /incomplete assistant provenance/],
      [r => { r.cases[0].operationId = ' '; }, /incomplete assistant provenance/],
      [r => { r.cases[0].confirmed = false; }, /incomplete assistant provenance/],
      [r => { r.sourceDigest = 'old'; }, /receipt does not match this release source/],
      [r => { delete r.agentChecks; }, /boolean-only agent coverage is not accepted/],
      [r => { r.agentChecks = true; }, /boolean-only agent coverage is not accepted/],
      [r => { r.agentChecks.canvas_read = true; }, /boolean-only agent coverage is not accepted/],
      [r => { delete r.agentChecks.cli_mcp; }, /agentChecks must include cli_mcp/],
      [r => { r.agentChecks.budget.evidence = []; }, /agentChecks must include budget/],
      [r => { r.agentChecks.canvas_read.method = 'deterministic'; }, /agent check canvas_read must use native method/],
      [r => { r.agentChecks.multi_turn.method = 'deterministic'; }, /agent check multi_turn must use native method/],
      [r => { r.agentChecks.cli_mcp.method = 'deterministic'; }, /agent check cli_mcp must use native method/],
      [r => { r.agentChecks.session_history.sourceDigest = 'a'.repeat(64); }, /agent check session_history sourceDigest does not match this release source/],
      [r => { r.liveTestWaiver = { approvedBy: 'Ender', instruction: '没事 这轮就不用实测了' }; r.cases = []; }, /expected exactly twelve successful cases/],
    ]) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      save(invalid);
      assert.throws(() => run(), pattern);
    }

    save(valid);
    assert.match(run(), /12\/12/);

    const bunny = makeV2('v1.6.23', sourceDigest, { fixtures: BUNNY_FIXTURES });
    save({ version: 'v1.6.22', cases: [{ fixtureDigest: fixtureDigestFromManifest(BUNNY_FIXTURES) }] }, 'v1.6.22');
    save(bunny);
    assert.throws(() => run(), /copied preceding release scenario or fixtures/);

    commitVersion('v1.6.24');
    const nextDigest = run('--fingerprint').trim();
    const copied = makeV2('v1.6.24', nextDigest, { fixtures: themeFixtures() });
    copied.scenario = structuredClone(valid.scenario);
    copied.cases = makeCases('v1.6.24', fixtureDigestFromManifest(valid.scenario.fixtures));
    copied.agentChecks = makeChecks(nextDigest);
    save(copied, 'v1.6.24');
    save(valid, 'v1.6.23');
    assert.throws(() => run(), /copied preceding release scenario or fixtures/);

    copied.scenario.id = 'harbor-rain-2026';
    save(copied, 'v1.6.24');
    assert.throws(() => run(), /copied preceding release scenario or fixtures/);

    const rotated = makeV2('v1.6.24', nextDigest, { fixtures: themeFixtures('a') });
    rotated.scenario.id = 'harbor-rain-2026';
    save(rotated, 'v1.6.24');
    assert.match(run(), /12\/12/);

    save(copied, 'v1.6.24');
    rmSync(join(dir, 'docs/release-evidence/v1.6.23.json'));
    assert.match(run(), /12\/12/);

    for (const major of ['v1.7.0', 'v2.0.0']) {
      commitVersion(major);
      const digest = run('--fingerprint').trim();
      const incomplete = { version: major, sourceDigest: digest, budgetCNY: 50, spentCNY: 12, pendingCNY: 0, upgrade: { preservedData: true, generationVerified: true }, cases: makeCases(major, 'a'.repeat(64)) };
      incomplete.cases.forEach(item => { delete item.entrypoint; delete item.sessionId; delete item.turnId; delete item.proposalId; delete item.confirmed; });
      save(incomplete, major);
      assert.throws(() => run(), new RegExp(`explicit contractVersion=${releaseContractVersion(major)} is required`));
      const fixtures = themeFixtures(major === 'v1.7.0' ? 'a' : '0');
      const next = releaseContractVersion(major) === 3 ? makeV3(major, digest, { fixtures: { ...fixtures, 'voice.wav': 'f'.repeat(64) } }) : makeV2(major, digest, { fixtures });
      next.scenario.id = `${major}-theme`;
      save(next, major);
      assert.match(run(), /12\/12/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function makeDeferredV1713(sourceDigest) {
  const value = makeV3('v1.7.13', sourceDigest);
  value.ownerException = { scope: 'release-before-remaining-acceptance-20261008', approvedBy: 'Ender', instruction: '提高到100元 你可以先上线 补测剩下的', evidence: ['owner-authorization.md'] };
  Object.assign(value, { budgetCNY: 100, historicalSpentCNY: 42.413106, spentCNY: 42.413106, newSpentCNY: 0, pendingCNY: 0, knownPendingCNY: 0, liveMatrixStatus: 'pending_after_release', agentAcceptanceStatus: 'pending_after_release', releasePublished: false, acceptanceComplete: false, releaseComplete: false, cases: [] });
  const historicalDigest = 'a'.repeat(64);
  value.billingAttempts = [{ id: 'historic-cost', kind: 'other', phase: 'historical', executedSourceDigest: historicalDigest, billing: 'settled', costCNY: 42.413106, evidence: ['historical-ledger.json'] }, { id: 'historic-chat', kind: 'chat', phase: 'historical', executedSourceDigest: historicalDigest, billing: 'settled', costCNY: 0, evidence: ['historical-ledger.json'] }];
  const ids = [...REQUIRED_AGENT_CHECK_IDS, ...DURABLE_AGENT_CHECK_IDS];
  value.agentChecks = Object.fromEntries(ids.map(id => [id, { status: 'pending_after_release' }]));
  value.deferredAcceptance = { status: 'pending_after_release', caseKeys: [1, 2].flatMap(round => PATHS.map(path => `${round}/${path}`)), agentCheckIds: ids, historicalEvidence: ['media_matrix', 'agent_checks'].map(kind => ({ kind, sourceDigest: historicalDigest, evidence: ['historical-source-receipt.json'] })) };
  value.upgrade = { preservedData: true, sourceDigest, evidence: ['data-preservation.json'] };
  value.verification = Object.fromEntries(['localReleaseGate', 'ci'].map(id => [id, { status: 'passed', sourceDigest, evidence: [`${id}.json`] }]));
  value.packages = { status: 'pending_release_workflow', archives: null, platforms: ['darwin-arm64', 'darwin-amd64', 'windows-amd64'], windowsReleasedUpgradeAndRollbackBeforeUpload: true, finalArchiveSmokeBeforeUpload: true, signedManifestBeforePublish: true, publicReadbackAfterPublish: true, workflowEvidence: ['release-desktop.yml'] };
  return value;
}

test('v1.7.13 exact owner authorization defers only live acceptance and keeps CNY100 total and release gates', () => {
  const { dir, run, save } = setupRepo('v1.7.13');
  try {
    const valid = makeDeferredV1713(run('--fingerprint').trim());
    save(valid); assert.match(run(), /acceptance PENDING/);
    const superseded = structuredClone(valid);
    superseded.billingAttempts.push({ id: 'superseded-chat', kind: 'chat', phase: 'superseded_candidate', executionSourceStatus: 'known', executedSourceDigest: 'b'.repeat(64), billing: 'settled', costCNY: 0.070210, evidence: ['actual-superseded-chat-bill.json'] });
    superseded.spentCNY += 0.070210; superseded.newSpentCNY = 0.070210;
    save(superseded); assert.match(run(), /acceptance PENDING/);
    for (const mutate of [r => r.billingAttempts.at(-1).executedSourceDigest = r.sourceDigest,
      r => r.billingAttempts.at(-1).executedSourceDigest = null,
      r => r.billingAttempts.at(-1).executionSourceStatus = 'unknown',
      r => delete r.billingAttempts.at(-1).executionSourceStatus,
      r => r.billingAttempts.at(-1).billing = 'pending', r => r.billingAttempts.at(-1).evidence = [],
      r => { r.billingAttempts.at(-1).costCNY = 60; r.spentCNY = 102.413106; r.newSpentCNY = 60; },
      r => r.newSpentCNY = 0, r => r.historicalSpentCNY += 0.070210]) {
      const invalid = structuredClone(superseded); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const mutations = [
      r => r.ownerException.approvedBy = 'model', r => r.ownerException.instruction = '上线吧', r => r.ownerException.evidence = [], r => r.ownerException.scope = 'anything',
      r => r.budgetCNY = 101, r => r.historicalSpentCNY = 0, r => r.spentCNY = 0, r => r.newSpentCNY = 42.413106, r => r.pendingCNY = 1, r => r.knownPendingCNY = null,
      r => r.billingAttempts[0].billing = 'pending', r => r.billingAttempts[0].phase = 'current', r => r.billingAttempts[0].executedSourceDigest = r.sourceDigest, r => r.billingAttempts.push(r.billingAttempts[0]),
      r => r.liveMatrixStatus = 'passed', r => r.acceptanceComplete = true, r => r.releaseComplete = true,
      r => r.deferredAcceptance.caseKeys.pop(), r => r.deferredAcceptance.agentCheckIds.pop(), r => r.agentChecks.cancel.status = 'passed',
      r => r.deferredAcceptance.historicalEvidence[0].sourceDigest = r.sourceDigest, r => r.deferredAcceptance.historicalEvidence[0].kind = 'anything',
      r => r.review.independent = false, r => r.review.sourceDigest = 'old', r => r.upgrade.preservedData = false, r => r.verification.ci.status = 'pending',
      r => r.packages.platforms.pop(), r => r.packages.signedManifestBeforePublish = false, r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false, r => r.packages.publicReadbackAfterPublish = false,
    ];
    for (const mutate of mutations) { const invalid = structuredClone(valid); mutate(invalid); save(invalid); assert.throws(() => run()); }
    for (const status of ['unknown', 'not_app_execution']) {
      const honest = structuredClone(valid); honest.billingAttempts[0].executedSourceDigest = null; honest.billingAttempts[0].executionSourceStatus = status;
      save(honest); assert.match(run(), /acceptance PENDING/);
      delete honest.billingAttempts[0].executionSourceStatus; save(honest); assert.throws(() => run());
      honest.billingAttempts[0].executionSourceStatus = status; honest.billingAttempts[0].phase = 'current'; save(honest); assert.throws(() => run());
    }
    const currentReview = structuredClone(valid); currentReview.spentCNY += 0.02; currentReview.newSpentCNY = 0.02;
    currentReview.billingAttempts.push({ id: 'current-independent-review', kind: 'other', phase: 'current', executedSourceDigest: null, executionSourceStatus: 'not_app_execution', reviewedSourceDigest: valid.sourceDigest, billing: 'settled', costCNY: 0.02, evidence: ['actual-review-bill.json'] });
    save(currentReview); assert.match(run(), /acceptance PENDING/);
    for (const mutate of [r => r.billingAttempts.at(-1).kind = 'media', r => r.billingAttempts.at(-1).kind = 'chat', r => delete r.billingAttempts.at(-1).reviewedSourceDigest, r => r.billingAttempts.at(-1).reviewedSourceDigest = 'a'.repeat(64), r => r.billingAttempts.at(-1).executionSourceStatus = 'unknown', r => r.billingAttempts.at(-1).evidence = []]) {
      const invalid = structuredClone(currentReview); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const partial = structuredClone(valid);
    const item = makeCases('v1.7.13', fixtureDigestFromManifest(valid.scenario.fixtures))[0];
    Object.assign(item, { executedSourceDigest: valid.sourceDigest, evidence: ['current-media.json'] });
    partial.cases = [item]; partial.deferredAcceptance.caseKeys = partial.deferredAcceptance.caseKeys.filter(key => key !== '1/text-image');
    partial.billingAttempts.push({ id: 'current-media', taskId: item.taskId, kind: 'media', phase: 'current', executedSourceDigest: valid.sourceDigest, billing: 'settled', costCNY: 1, evidence: ['current-media-bill.json'] });
    partial.spentCNY += 1; partial.newSpentCNY = 1; save(partial); assert.match(run(), /11\/12 cases/);
    const obsoleteBill = structuredClone(partial);
    Object.assign(obsoleteBill.billingAttempts.at(-1), { phase: 'superseded_candidate', executionSourceStatus: 'known', executedSourceDigest: 'b'.repeat(64) });
    save(obsoleteBill); assert.throws(() => run());
    for (const mutate of [r => r.cases[0].executedSourceDigest = 'a'.repeat(64), r => r.cases[0].confirmed = false, r => r.cases[0].mediaOpened = false, r => r.cases[0].costCNY = 2, r => r.deferredAcceptance.caseKeys.push('1/text-image')]) {
      const invalid = structuredClone(partial); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const published = structuredClone(valid); published.releasePublished = true; published.packages.status = 'verified';
    published.packages.archives = published.packages.platforms.map(platform => ({ platform, sha256: 'b'.repeat(64), sourceDigest: valid.sourceDigest, evidence: ['actual-archive.json'] }));
    for (const id of ['signature', 'publicReadback', 'windowsReleasedUpgradeAndRollback', 'finalArchiveSmoke']) published.packages[id] = { status: 'passed', sourceDigest: valid.sourceDigest, evidence: [`actual-${id}.json`] };
    save(published); assert.match(run(), /acceptance PENDING/);
    for (const mutate of [r => r.packages.archives.pop(), r => r.packages.signature.status = 'pending', r => r.packages.windowsReleasedUpgradeAndRollback.sourceDigest = 'old']) {
      const invalid = structuredClone(published); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const completed = structuredClone(published);
    completed.deferredAcceptance.status = 'completed_after_release'; completed.deferredAcceptance.caseKeys = []; completed.deferredAcceptance.agentCheckIds = [];
    completed.liveMatrixStatus = 'passed'; completed.agentAcceptanceStatus = 'passed'; completed.acceptanceComplete = true; completed.releaseComplete = true;
    completed.cases = makeCases('v1.7.13', fixtureDigestFromManifest(valid.scenario.fixtures)).map(item => ({ ...item, executedSourceDigest: valid.sourceDigest, evidence: ['actual-current-case.json'] }));
    completed.agentChecks = Object.fromEntries([...REQUIRED_AGENT_CHECK_IDS, ...DURABLE_AGENT_CHECK_IDS].map(id => [id, { status: 'passed', method: 'native', sourceDigest: valid.sourceDigest, evidence: ['actual-current-check.json'] }]));
    completed.billingAttempts.push(...completed.cases.map(item => ({ id: item.taskId, taskId: item.taskId, kind: 'media', phase: 'current', executedSourceDigest: valid.sourceDigest, billing: 'settled', costCNY: item.costCNY, evidence: ['actual-current-bill.json'] })));
    completed.spentCNY += 12; completed.newSpentCNY = 12; save(completed); assert.match(run(), /acceptance COMPLETE: 12\/12 cases, 23\/23 checks/);
    for (const mutate of [r => { r.cases.pop(); r.deferredAcceptance.caseKeys = ['2/multi-video']; }, r => { r.agentChecks.native_audio.status = 'pending_after_release'; r.deferredAcceptance.agentCheckIds = ['native_audio']; }, r => r.releasePublished = false, r => r.budgetCNY = 101, r => r.packages.status = 'pending_release_workflow']) {
      const invalid = structuredClone(completed); mutate(invalid); save(invalid); assert.throws(() => run());
    }
    const checked = structuredClone(valid); checked.agentChecks.budget = { status: 'passed', sourceDigest: valid.sourceDigest, method: 'deterministic', evidence: ['budget.json'] }; checked.deferredAcceptance.agentCheckIds = checked.deferredAcceptance.agentCheckIds.filter(id => id !== 'budget'); save(checked); assert.match(run(), /acceptance PENDING/);
    checked.agentChecks.native_audio = { status: 'passed', sourceDigest: valid.sourceDigest, method: 'deterministic', evidence: ['audio.json'] }; checked.deferredAcceptance.agentCheckIds = checked.deferredAcceptance.agentCheckIds.filter(id => id !== 'native_audio'); save(checked); assert.throws(() => run());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1.7.13 post-release acceptance authorization never carries into another version', () => {
  for (const version of ['v1.7.12', 'v1.7.14', 'v2.0.0']) {
    const { dir, run, save } = setupRepo(version);
    try { const value = makeDeferredV1713(run('--fingerprint').trim()); value.version = version; save(value); assert.throws(() => run()); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
