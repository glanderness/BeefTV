import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {
  THEME_AGENT_CONTRACT_VERSION,
  REQUIRED_AGENT_CHECK_IDS,
  DETERMINISTIC_FAULT_CHECK_IDS,
  requiresThemeAgentContract,
  inspectFixtureManifest,
  findCopiedPriorTheme,
  compareReleaseVersions,
} from './real-generation-release-contract.mjs';

// Tree identities survive squash/merge commits, but change whenever shipped
// code, protocol packages, release scripts, dependencies or VERSION change.
const sourceTree = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', 'backend', 'web', 'agent-host', 'plugin-packages', 'scripts', 'assets/app-icon.png', 'VERSION', '.github/workflows'], { encoding: 'utf8' });
const sourceDigest = createHash('sha256').update(sourceTree).digest('hex');
if (process.argv.includes('--fingerprint')) {
  console.log(sourceDigest);
  process.exit(0);
}
const version = readFileSync('VERSION', 'utf8').trim();
const receipt = JSON.parse(readFileSync(`docs/release-evidence/${version}.json`, 'utf8'));
const fail = message => { throw new Error(`Real generation release gate: ${message}`); };
const nonempty = value => typeof value === 'string' && value.trim() !== '';
if (receipt.version !== version || receipt.sourceDigest !== sourceDigest) fail('receipt does not match this release source');
const downloadOnlyWaiver = version === 'v1.6.20' && receipt.liveTestWaiver?.approvedBy === 'Ender' && receipt.liveTestWaiver?.instruction === '本版豁免付费生成矩阵，review 通过就发布（推荐）';
// Owner accepted only these two failed-chat receipt gaps for v1.6.23.
// Keep unknown pending as null; this does not waive any paid media case.
const financialException = receipt.financialEvidenceException;
const acceptedFailedRequests = ['202610020816334239151708268d9d6eZ5lRPwt', '202610021242434383740578268d9d6BAoXA1u1'];
// Exact, separately approved release exceptions; never carry one forward.
const targetedWaivers = {
  'v1.7.3': ['本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布', 'byok-updater-targeted-acceptance'],
  'v1.7.5': ['合了一起发布吧', 'byok-download-resume-targeted-acceptance'],
  'v1.7.6': ['本版豁免付费矩阵，专项验收、独立复审和 CI 通过后发布', 'workspace-assets-targeted-acceptance'],
  'v1.7.7': ['本版豁免付费矩阵，专项验收、review 和 CI 通过后发布', 'reference-media-targeted-acceptance'],
};
const targetedWaiver = targetedWaivers[version];
if (targetedWaiver && receipt.liveTestWaiver?.approvedBy === 'Ender'
  && receipt.liveTestWaiver?.instruction === targetedWaiver[0]
  && receipt.liveTestWaiver?.scope === targetedWaiver[1]) {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  if (receipt.budgetCNY !== 0 || receipt.spentCNY !== 0 || receipt.newSpentCNY !== 0 || receipt.pendingCNY !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived' || !Array.isArray(receipt.cases) || receipt.cases.length !== 0) fail('v1.7.3 requires zero new paid calls and explicitly unexecuted media matrix');
  const prior = receipt.priorFinancialUncertainty;
  if (prior?.status !== 'unresolved' || prior?.carriedFromVersion !== 'v1.7.2' || prior.pendingCNY !== null
    || JSON.stringify([...(prior.failedRequestIds || [])].sort()) !== JSON.stringify([...acceptedFailedRequests].sort())
    || !evidence(prior.evidence)) fail('v1.7.3 must retain prior unresolved refund evidence separately from this zero-spend release');
  if (receipt.review?.result !== 'approved' || receipt.review?.independent !== true
    || receipt.review?.sourceDigest !== sourceDigest || !nonempty(receipt.review?.reviewer) || !evidence(receipt.review?.evidence)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade?.sourceDigest !== sourceDigest || !evidence(receipt.upgrade?.evidence)) fail('v1.7.3 requires independent review and upgrade evidence for the current source');
  const requiredChecks = version === 'v1.7.7'
    ? ['mediaAdmission', 'referenceLinks', 'preparationStage', 'configScalars', 'localReleaseGate', 'ci']
    : version === 'v1.7.6'
    ? ['uploadLifecycle', 'deleteConfirmation', 'archivedRecovery', 'mediaPreview', 'localReleaseGate', 'ci']
    : ['modelServiceFlow', 'credentialPersistence', 'saveBarrier', 'localReleaseGate', 'ci'];
  for (const id of requiredChecks) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.3 missing source-bound targeted evidence: ${id}`);
  }
  if (version === 'v1.7.5') {
    for (const id of ['fullReferenceContract', 'relativeDownload', 'nativePlaybackAndSave', 'updaterResume', 'privacyScan']) {
      const check = receipt.verification?.[id];
      if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.5 missing source-bound targeted evidence: ${id}`);
    }
    if (receipt.verification.nativePlaybackAndSave.method !== 'native') fail('v1.7.5 requires native playback and save acceptance');
  }
  const packages = receipt.packages;
  if (packages?.windowsReleasedUpgradeAndRollbackBeforeUpload !== true || packages?.finalArchiveSmokeBeforeUpload !== true
    || !evidence(packages?.workflowEvidence)) fail('v1.7.3 requires final archive and released Windows upgrade gates');
  if (packages.status === 'passed') {
    for (const platform of ['darwin-arm64', 'darwin-amd64', 'windows-amd64']) {
      const item = packages.archives?.[platform];
      if (item?.sourceDigest !== sourceDigest || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !evidence(item.evidence)) fail(`v1.7.3 missing final package: ${platform}`);
    }
  } else if (packages.status !== 'pending_release_workflow' || packages.archives != null || receipt.releaseComplete === true) {
    fail('v1.7.3 final packages must remain pending until the release workflow completes');
  }
  console.log(`Owner authorized ${version} targeted BYOK/updater release; paid matrix NOT run; new expense 0; historical refund uncertainty retained; final packages: ${packages.status}.`);
  process.exit(0);
}
// v1.7.2 only: the owner waived paid generation, not targeted acceptance or
// prior unknown refunds. Final release archives are built after this preflight.
if (version === 'v1.7.2' && receipt.liveTestWaiver?.approvedBy === 'Ender'
  && receipt.liveTestWaiver?.instruction === '本版豁免付费生成，专项验收通过后上线'
  && receipt.liveTestWaiver?.scope === 'mcp-assistant-targeted-acceptance') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const exact = (value, expected) => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
  if (receipt.budgetCNY !== 100 || receipt.spentCNY !== 43.74479 || receipt.newSpentCNY !== 0
    || receipt.pendingCNY !== null || receipt.knownPendingCNY !== 0
    || receipt.financialUncertainty?.status !== 'unresolved'
    || receipt.financialUncertainty?.carriedFromVersion !== 'v1.7.1'
    || !exact(receipt.financialUncertainty?.failedRequestIds, acceptedFailedRequests)
    || !evidence(receipt.financialUncertainty?.evidence)) fail('v1.7.2 requires carried prior financial uncertainty and no new paid calls');
  if (receipt.review?.result !== 'approved' || receipt.review?.sourceDigest !== sourceDigest
    || receipt.review?.independent !== true || !nonempty(receipt.review?.reviewer) || !evidence(receipt.review?.evidence)
    || receipt.upgrade?.preservedData !== true || receipt.upgrade?.sourceDigest !== sourceDigest || !evidence(receipt.upgrade?.evidence)
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived') fail('v1.7.2 requires independent source review, preserved data evidence and an explicitly unexecuted matrix');
  for (const id of ['mcpStartup', 'assistantRuntime', 'windowsNativeRuntime', 'packagedCLI', 'localReleaseGate', 'ci']) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || check.sourceDigest !== sourceDigest || !evidence(check.evidence)) fail(`v1.7.2 missing source-bound targeted evidence: ${id}`);
  }
  if (receipt.verification.windowsNativeRuntime.method !== 'native') fail('v1.7.2 Windows runtime acceptance must be native');
  const packaged = receipt.verification.packagedCLI;
  const platforms = ['darwin-arm64', 'darwin-amd64', 'windows-amd64'];
  if (packaged.method !== 'package-validator' || !exact(packaged.platforms, platforms)
    || packaged.finalArchiveSmokeBeforeUpload !== true || !evidence(packaged.releaseWorkflowEvidence)) fail('v1.7.2 requires three-platform package validation and mandatory release archive smoke before upload');
  if (packaged.finalArchivesStatus === 'passed') {
    for (const platform of platforms) {
      const archive = packaged.finalArchives?.[platform];
      if (archive?.status !== 'passed' || archive.sourceDigest !== sourceDigest || !evidence(archive.evidence)
        || !/^[a-f0-9]{64}$/.test(archive.sha256 || '')) fail(`v1.7.2 missing final archive evidence: ${platform}`);
    }
  } else if (packaged.finalArchivesStatus !== 'pending_release_workflow' || packaged.finalArchives != null || receipt.releaseComplete === true) {
    fail('v1.7.2 final archives must remain pending until release workflow verification');
  }
  console.log(`Owner authorized v1.7.2 targeted MCP/assistant release; media matrix NOT run; new expense 0; two prior refund terminal states remain unknown; final archives: ${packaged.finalArchivesStatus}.`);
  process.exit(0);
}
// Ender selected the reviewed model-picker release and renamed it v1.7.1.
// Only this version may use targeted acceptance instead of another media matrix.
if (version === 'v1.7.1' && receipt.liveTestWaiver?.approvedBy === 'Ender'
  && receipt.liveTestWaiver?.instruction === '上线吧 1.7.1 值得一个大版本'
  && receipt.liveTestWaiver?.scope === 'model-picker-targeted-acceptance') {
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const exactRequests = value => Array.isArray(value) && JSON.stringify([...value].sort()) === JSON.stringify(acceptedFailedRequests);
  if (receipt.budgetCNY !== 100 || receipt.spentCNY !== 43.74479 || receipt.newSpentCNY !== 0
    || receipt.pendingCNY !== null || receipt.knownPendingCNY !== 0
    || receipt.financialUncertainty?.status !== 'unresolved'
    || !exactRequests(receipt.financialUncertainty?.failedRequestIds)
    || financialException?.approvedBy !== 'Ender'
    || financialException?.instruction !== receipt.liveTestWaiver.instruction
    || financialException?.scope !== 'two-failed-chat-refund-evidence-only'
    || !exactRequests(financialException?.requestIds) || !evidence(financialException?.evidence)) fail('v1.7.1 requires the exact disclosed prior financial gaps and no new paid calls');
  if (receipt.review?.result !== 'approved' || receipt.review?.sourceDigest !== sourceDigest
    || !nonempty(receipt.review?.reviewer) || !evidence(receipt.review?.evidence)
    || !receipt.upgrade?.preservedData || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || receipt.liveMatrixStatus !== 'not_run_owner_waived') fail('v1.7.1 requires independent source review, preserved data and an explicitly unexecuted matrix');
  for (const id of ['modelPicker', 'authorizationDefaultRecovery', 'saveBarrier', 'localReleaseGate', 'ci']) {
    const check = receipt.verification?.[id];
    if (check?.status !== 'passed' || !evidence(check.evidence)) fail(`v1.7.1 missing targeted evidence: ${id}`);
  }
  console.log('Owner authorized v1.7.1 targeted model-picker release; media matrix NOT run; new expense 0; two prior refund terminal states remain unknown.');
  process.exit(0);
}
const financialEvidenceWaiver = version === 'v1.6.23'
  && financialException?.approvedBy === 'Ender' && financialException?.instruction === '上线吧'
  && financialException?.scope === 'two-failed-chat-refund-evidence-only'
  && Array.isArray(financialException?.requestIds)
  && JSON.stringify([...financialException.requestIds].sort()) === JSON.stringify(acceptedFailedRequests)
  && Array.isArray(financialException?.evidence) && financialException.evidence.length > 0 && financialException.evidence.every(nonempty)
  && receipt.pendingCNY === null && receipt.knownPendingCNY === 0
  && receipt.financialUncertainty?.status === 'unresolved'
  && Array.isArray(receipt.financialUncertainty?.failedRequestIds)
  && JSON.stringify([...receipt.financialUncertainty.failedRequestIds].sort()) === JSON.stringify(acceptedFailedRequests);
if ((financialException || receipt.financialUncertainty?.status === 'unresolved') && !financialEvidenceWaiver) fail('unresolved billing requires the exact owner exception with null total pending');
if (!Number.isFinite(receipt.budgetCNY) || !Number.isFinite(receipt.spentCNY) || !((receipt.budgetCNY > 0 || (downloadOnlyWaiver && receipt.budgetCNY === 0)) && receipt.spentCNY >= 0 && receipt.spentCNY <= receipt.budgetCNY) || (receipt.pendingCNY !== 0 && !financialEvidenceWaiver)) fail('billing not reconciled within budget');
// Ender waived only v1.6.20 paid generation after the Windows download smoke.
// This release still requires the native download regression and independent review.
if (downloadOnlyWaiver) {
  if (receipt.verification?.windowsDownloads !== 'passed' || receipt.verification?.ci !== 'passed' || receipt.review?.result !== 'approved' || !receipt.upgrade?.preservedData || receipt.spentCNY !== 0) fail('download waiver requires reviewed Windows save and upgrade evidence with no paid generation');
  console.log(`Real generation release gate waived by owner: ${version}; live matrix NOT completed; Windows downloads verified; no paid generation`);
  process.exit(0);
}
// One release only: Ender explicitly waived further live testing on 2026-10-01.
// Source binding and settled-cost checks above still apply; later releases use
// the normal twelve-case gate. Never represent this exception as a passed test.
if (version === 'v1.6.18' && receipt.liveTestWaiver?.approvedBy === 'Ender' && receipt.liveTestWaiver?.instruction === '没事 这轮就不用实测了') {
  if (receipt.verification?.windowsNativeRegression !== 'passed' || receipt.review?.result !== 'approved') fail('waiver requires reviewed Windows regression evidence');
  console.log(`Real generation release gate waived by owner: ${version}; live matrix NOT completed; CNY ${receipt.spentCNY}/${receipt.budgetCNY}`);
  process.exit(0);
}
// Ender selected direct publication after being offered the v1.6.19 matrix
// waiver. This exception does not carry forward to any later version.
if (version === 'v1.6.19' && receipt.liveTestWaiver?.approvedBy === 'Ender' && receipt.liveTestWaiver?.instruction === '发布吧') {
  if (receipt.verification?.localReleaseGate !== 'passed' || receipt.verification?.errorRegression !== 'passed' || receipt.review?.result !== 'approved' || !receipt.upgrade?.preservedData) fail('waiver requires reviewed error regression and upgrade evidence');
  console.log(`Real generation release gate waived by owner: ${version}; live matrix NOT completed; CNY ${receipt.spentCNY}/${receipt.budgetCNY}`);
  process.exit(0);
}
let themeAgent = false;
try { themeAgent = requiresThemeAgentContract(version); }
catch { fail('unparseable VERSION'); }
let scenarioDigest = '';
if (themeAgent) {
  if (!Number.isInteger(receipt.contractVersion) || receipt.contractVersion !== THEME_AGENT_CONTRACT_VERSION) fail(`explicit contractVersion=${THEME_AGENT_CONTRACT_VERSION} is required`);
  const review = receipt.review;
  if (!review || review.result !== 'approved' || review.sourceDigest !== sourceDigest || !nonempty(review.reviewer) || !Array.isArray(review.evidence) || !review.evidence.length || review.evidence.some(item => !nonempty(item))) fail('independent review must approve this release source with reviewer and evidence');
  if (receipt.agentChecks === true || receipt.agentChecks === false) fail('boolean-only agent coverage is not accepted');
  const scenario = receipt.scenario;
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario) || !nonempty(scenario.id) || !nonempty(scenario.title) || !nonempty(scenario.source) || !nonempty(scenario.queryDate) || !/^https?:\/\/\S+$/.test(scenario.source.trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(scenario.queryDate.trim())) fail('scenario must include nonempty id, title, source URL and query date');
  const inspected = inspectFixtureManifest(scenario.fixtures);
  if (!inspected.ok) fail('fixture manifest must include at least two image and one video SHA256');
  scenarioDigest = inspected.digest;
  const checks = receipt.agentChecks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) fail('boolean-only agent coverage is not accepted');
  const allowedDeterministic = new Set(DETERMINISTIC_FAULT_CHECK_IDS);
  for (const id of REQUIRED_AGENT_CHECK_IDS) {
    const check = checks[id];
    if (check === true || check === false) fail('boolean-only agent coverage is not accepted');
    if (!check || typeof check !== 'object' || Array.isArray(check) || check.status !== 'passed' || (check.method !== 'native' && check.method !== 'deterministic') || !Array.isArray(check.evidence) || !check.evidence.length || check.evidence.some(item => !nonempty(item))) fail(`agentChecks must include ${id} with passed native or deterministic evidence`);
    if (check.sourceDigest !== sourceDigest) fail(`agent check ${id} sourceDigest does not match this release source`);
    if (check.method === 'deterministic' && !allowedDeterministic.has(id)) fail(`agent check ${id} must use native method`);
  }
}
if (!Array.isArray(receipt.cases) || receipt.cases.length !== 12) fail('expected exactly twelve successful cases');
const paths = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
const taskIDs = new Set();
const caseDigests = new Set();
for (const round of [1, 2]) for (const path of paths) {
  const matches = receipt.cases.filter(item => item.round === round && item.path === path);
  if (matches.length !== 1) fail(`missing or duplicate ${round}/${path}`);
  const item = matches[0];
  if (!item.taskId || taskIDs.has(item.taskId)) fail(`missing or reused task for ${round}/${path}`);
  taskIDs.add(item.taskId);
  if (!item.providerRequestId || item.clientVersion !== version || !item.platform || !/^[a-f0-9]{64}$/.test(item.fixtureDigest || '') || !item.model) fail(`incomplete provenance for ${round}/${path}`);
  if (item.status !== 'succeeded' || !item.clientSubmitted || !item.canvasVerified || !item.mediaDecoded || !item.mediaOpened || item.billing !== 'settled' || !(item.costCNY >= 0) || !/^[a-f0-9]{64}$/.test(item.artifactSHA256 || '')) fail(`incomplete acceptance for ${round}/${path}`);
  if (themeAgent) {
    if (item.entrypoint !== 'assistant' || !nonempty(item.sessionId) || !nonempty(item.turnId) || !nonempty(item.proposalId) || !nonempty(item.operationId) || item.confirmed !== true) fail(`incomplete assistant provenance for ${round}/${path}`);
    caseDigests.add(item.fixtureDigest);
  }
}
if (themeAgent) {
  if (caseDigests.size !== 1 || [...caseDigests][0] !== scenarioDigest) fail('cases must share the scenario fixtureDigest');
  let names = [];
  try { names = readdirSync('docs/release-evidence'); } catch { names = []; }
  const priors = [];
  for (const name of names) {
    const matched = /^(v\d+\.\d+\.\d+)\.json$/.exec(name);
    if (!matched || compareReleaseVersions(matched[1], version) >= 0) continue;
    try { priors.push(JSON.parse(readFileSync(`docs/release-evidence/${name}`, 'utf8'))); }
    catch { /* missing or unrelated historical files are not a current-release error */ }
  }
  if (findCopiedPriorTheme(receipt.scenario, scenarioDigest, priors)) fail('copied preceding release scenario or fixtures');
}
if (receipt.cases.reduce((sum, item) => sum + item.costCNY, 0) > receipt.spentCNY + 0.000001) fail('case costs exceed reported spend');
if (!receipt.upgrade?.preservedData || !receipt.upgrade?.generationVerified) fail('existing database upgrade unverified');
console.log(`Real generation release gate passed: ${version}, 12/12, CNY ${receipt.spentCNY}/${receipt.budgetCNY}`);
if (financialEvidenceWaiver) console.log('Owner accepted two failed-chat refund-evidence gaps for v1.6.23 only; total pending remains unknown, all twelve media cases settled.');
