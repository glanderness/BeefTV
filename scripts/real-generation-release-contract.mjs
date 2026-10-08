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
