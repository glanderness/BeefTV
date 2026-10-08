import { createHash } from 'node:crypto';

// Completeness contract only. The reporter still has to prove the evidence is true.
// Contract 2 is historical; contract 3 applies from v1.7.13. Unknown versions fail closed.
// Theme identity uses v2 receipts; fixture digests also inspect historical cases
// so the first v2 release cannot reuse the old fixed material set.
export const THEME_AGENT_CONTRACT_VERSION = 2;
export const THEME_AGENT_SINCE = 'v1.6.23';
export const DURABLE_AGENT_SINCE = 'v1.7.13';
export const DURABLE_AGENT_CONTRACT_VERSION = 3;
export const DURABLE_AGENT_CHECK_IDS = Object.freeze([
  'durable_resume', 'native_video', 'native_audio', 'skill_version', 'skill_files',
  'permission_modes', 'external_business', 'media_film_review',
]);
export function releaseContractVersion(version) {
  const comparison = compareReleaseVersions(version, DURABLE_AGENT_SINCE);
  if (comparison == null) throw new Error('unparseable VERSION');
  return comparison >= 0 ? DURABLE_AGENT_CONTRACT_VERSION : THEME_AGENT_CONTRACT_VERSION;
}
export function releaseAgentChecks(version) {
  return releaseContractVersion(version) === 3 ? [...REQUIRED_AGENT_CHECK_IDS, ...DURABLE_AGENT_CHECK_IDS] : [...REQUIRED_AGENT_CHECK_IDS];
}
export function releaseDeterministicChecks(version) {
  return releaseContractVersion(version) === 3 ? [...DETERMINISTIC_FAULT_CHECK_IDS, 'durable_resume'] : [...DETERMINISTIC_FAULT_CHECK_IDS];
}
export const REQUIRED_AGENT_CHECK_IDS = Object.freeze([
  'canvas_read',
  'asset_reference',
  'canvas_mutation',
  'multi_turn',
  'proposal_decline',
  'proposal_stale',
  'proposal_idempotency',
  'session_history',
  'session_restart',
  'cancel',
  'conflict_undo',
  'host_recovery',
  'scope_isolation',
  'budget',
  'cli_mcp',
]);
export const DETERMINISTIC_FAULT_CHECK_IDS = Object.freeze([
  'budget',
  'scope_isolation',
  'host_recovery',
  'conflict_undo',
]);

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /\.(?:jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(?:mp4|mov|webm|m4v)$/i;
const AUDIO = /\.wav$/i;

export function parseReleaseVersion(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return null;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function requiresThemeAgentContract(version) {
  const cmp = compareReleaseVersions(version, THEME_AGENT_SINCE);
  if (cmp == null) throw new Error('unparseable VERSION');
  return cmp >= 0;
}

export function fixtureDigestFromManifest(manifest) {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function inspectFixtureManifest(manifest, contractVersion = 2) {
  if (![2, 3].includes(contractVersion)) return { ok: false, digest: '', images: 0, videos: 0, audios: 0 };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, digest: '', images: 0, videos: 0 };
  const names = Object.keys(manifest);
  if (!names.length) return { ok: false, digest: '', images: 0, videos: 0 };
  const seen = new Set();
  let images = 0;
  let videos = 0;
  let audios = 0;
  for (const name of names) {
    const digest = manifest[name];
    if (!name || !SHA256.test(digest) || seen.has(digest)) return { ok: false, digest: '', images, videos };
    seen.add(digest);
    if (IMAGE.test(name)) images += 1;
    else if (VIDEO.test(name)) videos += 1;
    else if (contractVersion === 3 && AUDIO.test(name)) audios += 1;
    else return { ok: false, digest: '', images, videos };
  }
  const digest = fixtureDigestFromManifest(manifest);
  return { ok: images >= 2 && videos >= 1 && (contractVersion !== 3 || audios >= 1), digest, images, videos, audios };
}

export function findCopiedPriorTheme(scenario, digest, priors) {
  const id = typeof scenario?.id === 'string' ? scenario.id.trim() : '';
  for (const prior of priors) {
    if (Array.isArray(prior?.cases) && prior.cases.some(item => item?.fixtureDigest === digest)) return prior;
    if (![2, 3].includes(prior?.contractVersion) || !prior.scenario || typeof prior.scenario !== 'object') continue;
    const priorId = typeof prior.scenario.id === 'string' ? prior.scenario.id.trim() : '';
    const sameId = Boolean(id && priorId && priorId === id);
    const inspected = inspectFixtureManifest(prior.scenario.fixtures, prior.contractVersion);
    if (sameId || (inspected.ok && inspected.digest === digest)) return prior;
  }
  return null;
}

// One owner-authorized release ordering exception. It records missing tests,
// never promotes historical execution to current-source acceptance.
export function validateDeferredV1713(receipt, sourceDigest) {
  const fail = message => { throw new Error(`v1.7.13 deferred acceptance: ${message}`); };
  const nonempty = value => typeof value === 'string' && value.trim() !== '';
  const hash = value => /^[a-f0-9]{64}$/.test(value || '');
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(nonempty);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exactSet = (actual, expected) => Array.isArray(actual) && actual.length === new Set(actual).size && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const owner = receipt.ownerException;
  if (receipt.version !== 'v1.7.13' || receipt.contractVersion !== 3 || receipt.sourceDigest !== sourceDigest
    || owner?.scope !== 'release-before-remaining-acceptance-20261008' || owner.approvedBy !== 'Ender'
    || owner.instruction !== '提高到100元 你可以先上线 补测剩下的' || !evidence(owner.evidence)
    || receipt.liveTestWaiver || receipt.financialEvidenceException || receipt.financialUncertainty?.status === 'unresolved') fail('exact version and owner authorization required');
  if (receipt.budgetCNY !== 100 || receipt.historicalSpentCNY !== 42.413106
    || !Number.isFinite(receipt.spentCNY) || receipt.spentCNY < receipt.historicalSpentCNY || receipt.spentCNY > 100
    || !Number.isFinite(receipt.newSpentCNY) || Math.abs(receipt.newSpentCNY - (receipt.spentCNY - receipt.historicalSpentCNY)) > 0.000001
    || receipt.pendingCNY !== 0 || receipt.knownPendingCNY !== 0) fail('all historical and new costs must fit total CNY100 with no pending');
  const attempts = receipt.billingAttempts;
  if (!Array.isArray(attempts) || !attempts.length) fail('all billing attempts required');
  const ids = new Set(); let total = 0, historical = 0;
  for (const item of attempts) {
    const sourceValid = item.phase === 'current'
      ? item.executedSourceDigest === sourceDigest
        || (item.kind === 'other' && item.executedSourceDigest === null && item.executionSourceStatus === 'not_app_execution' && item.reviewedSourceDigest === sourceDigest)
      : item.phase === 'superseded_candidate'
        ? item.executionSourceStatus === 'known' && hash(item.executedSourceDigest) && item.executedSourceDigest !== sourceDigest
      : (hash(item.executedSourceDigest) && item.executedSourceDigest !== sourceDigest)
        || (item.executedSourceDigest === null && ['unknown', 'not_app_execution'].includes(item.executionSourceStatus));
    if (!nonempty(item.id) || ids.has(item.id) || !['media', 'chat', 'other'].includes(item.kind)
      || !['settled', 'refunded'].includes(item.billing) || !['historical', 'current', 'superseded_candidate'].includes(item.phase)
      || !sourceValid || !evidence(item.evidence) || !Number.isFinite(item.costCNY) || item.costCNY < 0) fail('invalid, unresolved or relabeled billing attempt');
    ids.add(item.id); total += item.costCNY;
    if (item.phase === 'historical') historical += item.costCNY;
  }
  if (!attempts.some(item => item.kind === 'chat') || Math.abs(total - receipt.spentCNY) > 0.000001 || Math.abs(historical - 42.413106) > 0.000001) fail('billing ledger must reconcile including historical baseline and chat');
  if (receipt.review?.result !== 'approved' || receipt.review.independent !== true || !nonempty(receipt.review.reviewer) || !bound(receipt.review)
    || receipt.upgrade?.preservedData !== true || !bound(receipt.upgrade)) fail('current independent review and data preservation required');
  for (const id of ['localReleaseGate', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail(`current ${id} evidence required`);
  }
  const scenario = receipt.scenario;
  const inspected = inspectFixtureManifest(scenario?.fixtures, 3);
  if (!inspected.ok || !nonempty(scenario?.id) || !nonempty(scenario.title) || !/^https?:\/\/\S+$/.test(scenario.source || '') || !/^\d{4}-\d{2}-\d{2}$/.test(scenario.queryDate || '')) fail('explicit scenario and native audio/video fixture manifest required');
  const caseKeys = [1, 2].flatMap(round => ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'].map(path => `${round}/${path}`));
  const accepted = new Set(), tasks = new Set();
  if (!Array.isArray(receipt.cases)) fail('current cases must be an array, even when empty');
  for (const item of receipt.cases) {
    const key = `${item.round}/${item.path}`;
    if (!caseKeys.includes(key) || accepted.has(key) || !nonempty(item.taskId) || tasks.has(item.taskId)
      || item.executedSourceDigest !== sourceDigest || item.fixtureDigest !== inspected.digest || item.clientVersion !== 'v1.7.13'
      || item.status !== 'succeeded' || item.billing !== 'settled' || item.entrypoint !== 'assistant' || item.confirmed !== true
      || !['sessionId', 'turnId', 'proposalId', 'operationId', 'providerRequestId', 'platform', 'model'].every(field => nonempty(item[field]))
      || !['clientSubmitted', 'canvasVerified', 'mediaDecoded', 'mediaOpened'].every(field => item[field] === true)
      || !hash(item.artifactSHA256) || !evidence(item.evidence) || !Number.isFinite(item.costCNY) || item.costCNY < 0) fail('invalid or historical current-source media case');
    const billed = attempts.filter(attempt => attempt.phase === 'current' && attempt.kind === 'media' && attempt.taskId === item.taskId);
    if (billed.length !== 1 || billed[0].billing !== 'settled' || Math.abs(billed[0].costCNY - item.costCNY) > 0.000001) fail('current case requires exact settled task bill');
    accepted.add(key); tasks.add(item.taskId);
  }
  const required = releaseAgentChecks('v1.7.13'), pendingChecks = [], checks = receipt.agentChecks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || !exactSet(Object.keys(checks), required)) fail('all 23 checks must be explicitly recorded');
  for (const id of required) {
    const check = checks[id];
    if (check?.status === 'pending_after_release') { pendingChecks.push(id); continue; }
    if (check?.status !== 'passed' || !bound(check) || !['native', 'deterministic'].includes(check.method)
      || (check.method === 'deterministic' && !releaseDeterministicChecks('v1.7.13').includes(id))) fail(`invalid or historical passed check: ${id}`);
  }
  const deferred = receipt.deferredAcceptance;
  const missing = caseKeys.filter(key => !accepted.has(key));
  if (!['pending_after_release', 'completed_after_release'].includes(deferred?.status)
    || !exactSet(deferred.caseKeys, missing) || !exactSet(deferred.agentCheckIds, pendingChecks)
    || typeof receipt.releasePublished !== 'boolean') fail('all remaining tests must be explicitly recorded');
  const complete = deferred.status === 'completed_after_release';
  if (complete) {
    if (missing.length || pendingChecks.length || receipt.releasePublished !== true || receipt.acceptanceComplete !== true || receipt.releaseComplete !== true
      || receipt.liveMatrixStatus !== 'passed' || receipt.agentAcceptanceStatus !== 'passed') fail('completion requires published release and all current 12/23 acceptance');
  } else if ((!missing.length && !pendingChecks.length) || receipt.liveMatrixStatus !== 'pending_after_release' || receipt.agentAcceptanceStatus !== 'pending_after_release'
    || receipt.acceptanceComplete !== false || receipt.releaseComplete !== false) fail('pending tests must never be labeled complete');
  const history = deferred.historicalEvidence;
  if (!Array.isArray(history) || !history.length || !history.some(item => item.kind === 'media_matrix') || !history.some(item => item.kind === 'agent_checks')
    || history.some(item => !['media_matrix', 'agent_checks', 'native_film', 'targeted_native'].includes(item.kind) || !hash(item.sourceDigest) || item.sourceDigest === sourceDigest || !evidence(item.evidence))) fail('original historical source evidence required without relabeling');
  const packages = receipt.packages;
  if (!packages || !exactSet(packages.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64'])
    || !['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].every(field => packages[field] === true)
    || !evidence(packages.workflowEvidence)) fail('all final platform, signature, archive, Windows upgrade/rollback and public readback gates remain mandatory');
  if (!receipt.releasePublished) {
    if (packages.status !== 'pending_release_workflow' || packages.archives != null) fail('unpublished preflight must not invent final archives');
  } else {
    if (packages.status !== 'verified' || !Array.isArray(packages.archives) || packages.archives.length !== 3
      || !exactSet(packages.archives.map(item => item.platform), packages.platforms)
      || packages.archives.some(item => !hash(item.sha256) || !bound(item))) fail('published release requires actual source-bound final archives');
    for (const id of ['signature', 'publicReadback', 'windowsReleasedUpgradeAndRollback', 'finalArchiveSmoke']) {
      if (packages[id]?.status !== 'passed' || !bound(packages[id])) fail(`published release requires actual ${id} evidence`);
    }
  }
  return { pendingCases: missing.length, pendingChecks: pendingChecks.length, complete };
}
