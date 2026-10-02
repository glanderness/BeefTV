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
const sourceTree = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', 'backend', 'web', 'agent-host', 'plugin-packages', 'scripts', 'VERSION', '.github/workflows'], { encoding: 'utf8' });
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
if (!Number.isFinite(receipt.budgetCNY) || !Number.isFinite(receipt.spentCNY) || !((receipt.budgetCNY > 0 || (downloadOnlyWaiver && receipt.budgetCNY === 0)) && receipt.spentCNY >= 0 && receipt.spentCNY <= receipt.budgetCNY) || receipt.pendingCNY !== 0) fail('billing not reconciled within budget');
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
    if (item.entrypoint !== 'assistant' || !nonempty(item.sessionId) || !nonempty(item.turnId) || !nonempty(item.proposalId) || item.confirmed !== true) fail(`incomplete assistant provenance for ${round}/${path}`);
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
