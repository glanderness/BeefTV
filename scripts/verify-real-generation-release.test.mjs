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

for (const version of ['v1.7.3', 'v1.7.5', 'v1.7.6', 'v1.7.7']) test(`${version} waiver requires current targeted evidence and cannot carry forward`, () => {
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
    save(valid); assert.match(run(), /paid matrix NOT run/);
    for (const mutate of [
      r => r.liveTestWaiver.approvedBy = 'other', r => r.review.independent = false,
      r => r.review.sourceDigest = 'stale', r => r.upgrade.preservedData = false,
      r => r.newSpentCNY = 1, r => r.cases = [{}], r => r.priorFinancialUncertainty.pendingCNY = 0,
      r => r.verification[version === 'v1.7.7' ? 'referenceLinks' : version === 'v1.7.6' ? 'archivedRecovery' : 'credentialPersistence'].status = 'failed', r => r.verification.ci.sourceDigest = 'stale',
      r => r.packages.windowsReleasedUpgradeAndRollbackBeforeUpload = false,
      r => r.releaseComplete = true, r => r.packages.status = 'passed',
    ]) {
      const changed = structuredClone(valid); mutate(changed); save(changed); assert.throws(() => run());
    }
    const next = version === 'v1.7.3' ? 'v1.7.4' : version === 'v1.7.5' ? 'v1.7.6' : version === 'v1.7.6' ? 'v1.7.7' : 'v1.7.8';
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
      assert.throws(() => run(), /explicit contractVersion=2 is required/);
      const next = makeV2(major, digest, { fixtures: themeFixtures(major === 'v1.7.0' ? 'a' : '0') });
      next.scenario.id = `${major}-theme`;
      save(next, major);
      assert.match(run(), /12\/12/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
