import { createHash } from 'node:crypto';
import { releaseAgentChecks } from './real-generation-release-contract.mjs';

// The candidate includes these merged PRs and direct main commits; the source
// digest and includedMain bind the complete tree, including non-PR changes.
export const V205_PULL_REQUESTS = [268, 269, 270, 273, 274, 275, 276, 280, 282, 283];
export const V205_INSTRUCTION = '本版采用免费专项验收（推荐）';

// Exact, single-release exception. Package flags require future workflow
// checks; they never assert that an unbuilt archive has passed.
export function validateV205Release(receipt, sourceDigest, proofs = {}) {
  const fail = message => { throw new Error('v2.0.5 targeted release: ' + message); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (value, expected) => Array.isArray(value) && new Set(value).size === value.length
    && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (receipt.version !== 'v2.0.5' || receipt.contractVersion !== 3
    || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.baseRelease !== 'v2.0.4' || receipt.baseCommit !== '542124baadcdbe5ce34ba9029ef7f1d192b49d16'
    || receipt.includedMain !== 'c99cba49b6518673b078991cf9d995ba14be2921'
    || !exact(receipt.includedPullRequests, V205_PULL_REQUESTS)) fail('exact release source and merged scope required');
  const bytes = proofs.authorizationBytes;
  const owner = receipt.ownerException;
  if (!bytes || owner?.authorizationSHA256 !== hash(bytes)) fail('authorization bytes must match');
  const authorization = JSON.parse(bytes);
  if (owner.approvedBy !== 'Ender' || owner.scope !== 'v2.0.5-targeted-no-paid-20261027'
    || owner.instruction !== V205_INSTRUCTION || !bound(owner)
    || authorization.version !== 'v2.0.5' || authorization.approvedBy !== 'Ender'
    || authorization.acceptanceInstruction !== V205_INSTRUCTION || authorization.observedMain !== receipt.includedMain
    || !exact(authorization.explicitlyRequestedPullRequests, [282, 280])
    || authorization.waiveCompleteGenerationMatrix !== true || authorization.targetedAcceptance !== true
    || authorization.newPaidBudgetCNY !== 0) fail('explicit single-release authorization required');
  const ids = releaseAgentChecks('v2.0.5');
  const paths = ['text-image', 'image-image', 'image-video', 'text-video', 'video-video', 'multi-video'];
  const waived = receipt.deferredAcceptance;
  if (receipt.liveMatrixStatus !== 'not_run_owner_waived' || receipt.agentAcceptanceStatus !== 'not_run_targeted_release'
    || receipt.acceptanceComplete !== false || receipt.releasePublished !== false || receipt.releaseComplete !== false
    || !Array.isArray(receipt.cases) || receipt.cases.length !== 0
    || waived?.status !== 'not_run_owner_waived'
    || !exact(waived.caseKeys, [1, 2].flatMap(round => paths.map(path => round + '/' + path)))
    || !exact(waived.agentCheckIds, ids) || !exact(Object.keys(receipt.agentChecks || {}), ids)
    || Object.values(receipt.agentChecks).some(check => check.status !== 'not_run_targeted_release' || !bound(check))) fail('waived checks must remain unexecuted');
  if (['newPaidBudgetCNY', 'newPaidSubmissions', 'newSpentCNY', 'newPendingCNY'].some(key => receipt[key] !== 0)
    || !Array.isArray(receipt.billingAttempts) || receipt.billingAttempts.length !== 0
    || ['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)
    || receipt.priorFinancialUncertainty?.status !== 'unresolved'
    || receipt.priorFinancialUncertainty.carriedFromVersion !== 'v2.0.4'
    || receipt.priorFinancialUncertainty.pendingCNY !== null
    || !evidence(receipt.priorFinancialUncertainty.evidence)) fail('no new paid attempts or clearing historical unknown bills');
  if (!proofs.priorReceiptBytes || receipt.priorReceiptSHA256 !== hash(proofs.priorReceiptBytes)
    || receipt.knownLimitations?.carriedFromVersion !== 'v2.0.4'
    || !exact(receipt.knownLimitations.inheritedFailedCheckIds, ['native_video', 'native_audio', 'media_film_review'])
    || !evidence(receipt.knownLimitations.evidence)) fail('retain prior receipt and known media failures');
  const review = receipt.review;
  if (review?.result !== 'approved' || review.independent !== true
    || !text(review.reviewer) || !bound(review)
    || proofs.reviewedSourceDigest !== sourceDigest) fail('independent review must approve the current source');
  for (const id of ['canvasPerformance', 'assistantStreaming', 'modelConfiguration', 'timeline', 'seedream', 'imageRecovery', 'imageRecoveryUI', 'videoProtocols', 'pluginRetention', 'publisher', 'ci']) {
    if (receipt.verification?.[id]?.status !== 'passed' || !bound(receipt.verification[id])) fail('missing current check: ' + id);
  }
  const local = receipt.verification?.localReleaseGate;
  if (!['passed', 'pending_release_workflow'].includes(local?.status) || local.method !== 'local-script'
    || local.beforeDraft !== true || !bound(local)
    || !local.evidence.includes('.github/workflows/release-desktop.yml')) fail('local gate must run before draft creation');
  if (receipt.upgrade?.status !== 'pending_release_workflow' || receipt.upgrade.preservedData !== null
    || receipt.upgrade.requiredBeforePublish !== true || !bound(receipt.upgrade)) fail('native data preservation remains mandatory and pending');
  const packages = receipt.packages;
  if (!exact(packages?.platforms, ['darwin-arm64', 'darwin-amd64', 'windows-amd64', 'linux-amd64'])
    || packages.status !== 'pending_release_workflow' || packages.archives !== null
    || !evidence(packages.workflowEvidence) || !packages.workflowEvidence.includes('.github/workflows/release-desktop.yml')
    || ['windowsReleasedUpgradeAndRollbackBeforeUpload', 'finalArchiveSmokeBeforeUpload', 'linuxNativeWindowBeforeUpload', 'signedManifestBeforePublish', 'publicReadbackAfterPublish'].some(key => packages[key] !== true)) fail('all four final-package safety checks remain mandatory');
}
