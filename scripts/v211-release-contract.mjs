import { createHash } from 'node:crypto';
import { releaseAgentChecks } from './real-generation-release-contract.mjs';

export const V211_PULL_REQUESTS = [343, 344, 345, 346, 347, 348, 349, 350, 351, 352, 353, 354, 355, 356];
export const V211_INSTRUCTION = 'v2.1.1 采用免费专项验收（豁免重跑 12 次付费生成矩阵与 23 项助手实测，保留 DSH 独立审查、专项单测/集成测试、CI 与四平台打包/增量更新/双源镜像校验）';

export function validateV211Release(receipt, sourceDigest, proofs = {}) {
  const fail = message => { throw new Error('v2.1.1 targeted release: ' + message); };
  const text = value => typeof value === 'string' && value.trim() !== '';
  const evidence = value => Array.isArray(value) && value.length > 0 && value.every(text);
  const bound = value => value?.sourceDigest === sourceDigest && evidence(value.evidence);
  const exact = (value, expected) => Array.isArray(value) && new Set(value).size === value.length
    && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (receipt.version !== 'v2.1.1' || receipt.contractVersion !== 3
    || !/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest
    || receipt.baseRelease !== 'v2.1.0' || receipt.baseCommit !== 'fd2fc7c107dc31bce3b8a79559da4e58efe8bd93'
    || receipt.includedMain !== 'e901afbe42cc829dd54c8073a415076b1cdc074f'
    || !exact(receipt.includedPullRequests, V211_PULL_REQUESTS)) fail('exact release source and merged scope required');
  const bytes = proofs.authorizationBytes;
  const owner = receipt.ownerException;
  if (!bytes || owner?.authorizationSHA256 !== hash(bytes)) fail('authorization bytes must match');
  const authorization = JSON.parse(bytes);
  if (owner.approvedBy !== 'Ender' || owner.scope !== 'v2.1.1-targeted-no-paid-20261101'
    || owner.instruction !== V211_INSTRUCTION || !bound(owner)
    || authorization.version !== 'v2.1.1' || authorization.approvedBy !== 'Ender'
    || authorization.acceptanceInstruction !== V211_INSTRUCTION || authorization.observedMain !== receipt.includedMain
    || !exact(authorization.explicitlyRequestedPullRequests, V211_PULL_REQUESTS)
    || authorization.waiveCompleteGenerationMatrix !== true || authorization.targetedAcceptance !== true
    || authorization.newPaidBudgetCNY !== 0) fail('explicit single-release authorization required');
  const ids = releaseAgentChecks('v2.1.1');
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
    || ['budgetCNY', 'spentCNY', 'pendingCNY'].some(key => receipt[key] !== null)) fail('no new paid attempts allowed in targeted release');
  if (!proofs.priorReceiptBytes || receipt.priorReceiptSHA256 !== hash(proofs.priorReceiptBytes)
    || receipt.knownLimitations?.carriedFromVersion !== 'v2.1.0'
    || !evidence(receipt.knownLimitations.evidence)) fail('retain prior v2.1.0 receipt');
  const review = receipt.review;
  if (review?.result !== 'approved' || review.independent !== true
    || !text(review.reviewer) || !bound(review)
    || proofs.reviewedSourceDigest !== sourceDigest) fail('independent review must approve the current source');
  for (const id of ['seedanceAndCanvasCapabilities', 'agentHostCacheAndSkills', 'canvasSizingAndTaskBinding', 'externalMcpAndProtocolValidation', 'publisher', 'ci']) {
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
