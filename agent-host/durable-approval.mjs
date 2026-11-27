// 中央工具审批与权限门控扩展：
// 1. 通过 Pi 官方 ToolHooks.beforeTool 统一收口模型直调、codemode 嵌套调用（call.parent）、
//    MCP 工具与插件工具的权限/中止/付费预算预检；
// 2. 任何预检错误或异常都在 try/catch 内显式返回 { block }（fail-closed，绝不依赖 throw 拦工具）；
// 3. 付费工具需要用户确认时以 api.memo(turnId:callId) 幂等记录 proposalId 并返回 { sleep: { signals } }，
//    原地休眠等待 Go 投递 ApprovalDecision 信号，同回合无缝恢复（执行时 Go 再次原子核验 SQLite）；
// 4. 通过 Pi 1.6.0 官方 GenerationHooks.afterTools 在整批工具结束后统一判定是否因提案而收口回合
//    （兼容串行、并行及 codemode 嵌套调用，彻底消除对工具执行顺序的猜测）；
// 5. 统一管理共享 Photon Worker 图片预压缩扩展（createFitImagesExtension）。
import {
  GenerationTask,
  LiveDoc,
  ToolTask,
  defineExtension,
  defineTask,
  hook,
  hookTask,
} from '@earendil-works/pi-durable';
import { createFitImagesExtension } from '@earendil-works/pi-durable/images/fit';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { ApprovalDecision } from './durable-signals.mjs';
import { toolOperationId } from './session-identity.mjs';

export const DEFAULT_APPROVAL_SLEEP_MS = 24 * 60 * 60 * 1000;

const READ_ONLY_BUILTIN_TOOLS = new Set([
  'tool_search',
  'codemode',
  'read_mcp_resource',
  'plan_update',
]);

const CANVAS_MULTI_READ_TOOLS = new Set([
  'canvas_get',
  'canvas_nodes_get',
  'canvas_search',
  'canvas_create',
]);

export const ProposalTerminateTask = defineTask({
  name: 'beeftv.proposal_terminate',
  version: 1,
  initial: (input) => ({ phase: 'decide', terminate: Boolean(input?.terminate) }),
  phases: {
    decide: async (task, runtime, context) => {
      const result = task.state.checkpoint.terminate ? { terminate: true } : {};
      await runtime.commit(() => ({
        status: 'terminal',
        outcome: { status: 'completed', result },
      }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: 'terminal',
      outcome: { status: 'aborted' },
    }), context);
  },
});

function isPendingScriptProposalResult(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.details && typeof msg.details === 'object') {
    if (msg.details.status === 'pending' || msg.details.proposal?.status === 'pending') return true;
  }
  const text = Array.isArray(msg.content)
    ? msg.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim()
    : '';
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (parsed.status === 'pending' || parsed.proposal?.status === 'pending') return true;
    }
  } catch {
    // 非 JSON 文本忽略
  }
  return false;
}

const PROPOSAL_COMPANION_TOOLS = new Set([
  'plan_update',
  'canvas_generation_propose',
  'skill_script_run',
]);

async function roundProducedProposal(results, api, entry, context) {
  const resultIds = Array.isArray(results) ? results : [];
  if (resultIds.length === 0) return false;
  let hasSuccessfulProposal = false;
  let hasCodemode = false;
  let hasDisallowedSibling = false;

  for (const entryId of resultIds) {
    const record = typeof api?.entry === 'function'
      ? await api.entry(entryId, context).catch(() => null)
      : null;
    const messages = Array.isArray(record?.model) ? record.model : [];
    for (const msg of messages) {
      if (!msg || msg.role !== 'toolResult') continue;
      if (msg.toolName === 'canvas_generation_propose') {
        if (msg.isError !== true) hasSuccessfulProposal = true;
        else hasDisallowedSibling = true;
        continue;
      }
      if (msg.toolName === 'skill_script_run') {
        if (msg.isError !== true && isPendingScriptProposalResult(msg)) hasSuccessfulProposal = true;
        else hasDisallowedSibling = true;
        continue;
      }
      if (msg.toolName === 'plan_update') {
        if (msg.isError === true) hasDisallowedSibling = true;
        continue;
      }
      if (msg.toolName === 'codemode') {
        if (msg.isError === true) hasDisallowedSibling = true;
        else hasCodemode = true;
        continue;
      }
      // 其他写入或读取工具与提案同批发出时（例如 [propose, configure]），保持继续把结果交回模型，不提前截断。
      hasDisallowedSibling = true;
    }
  }
  if (hasDisallowedSibling) return false;

  if (hasCodemode) {
    const live = typeof api?.snapshot === 'function'
      ? await api.snapshot(LiveDoc, api.conversationId, context).catch(() => null)
      : null;
    const nestedSlots = Array.isArray(live?.nestedTools) ? live.nestedTools : [];
    let nestedProposal = false;
    for (const slot of nestedSlots) {
      if (slot?.status !== 'done' || slot?.summary?.isError === true) continue;
      if (slot.name === 'canvas_generation_propose') {
        nestedProposal = true;
      } else if (slot.name === 'skill_script_run') {
        const pending = slot.details?.status === 'pending'
          || slot.details?.proposal?.status === 'pending'
          || (Array.isArray(entry?.turn?.scriptProposals) && entry.turn.scriptProposals.some((p) => p?.status === 'pending'));
        if (pending) nestedProposal = true;
      } else if (!PROPOSAL_COMPANION_TOOLS.has(slot.name)) {
        // codemode 内部还执行了其他工具时，把最终程序输出交回模型，除非仅做方案与计划提交。
        return false;
      }
    }
    if (nestedProposal) hasSuccessfulProposal = true;
  }

  return hasSuccessfulProposal;
}

let sharedPhotonPromise = null;
let sharedPhotonInstance = null;

export async function getSharedPhotonImages() {
  if (!sharedPhotonPromise) {
    sharedPhotonPromise = createNodePhotonImages({ idleMs: 30_000 })
      .then((processor) => {
        sharedPhotonInstance = processor;
        return processor;
      })
      .catch((error) => {
        sharedPhotonPromise = null;
        throw error;
      });
  }
  return sharedPhotonPromise;
}

export async function createSharedFitImagesExtension() {
  const processor = await getSharedPhotonImages();
  return createFitImagesExtension(processor);
}

export async function closeSharedPhotonImages() {
  const instance = sharedPhotonInstance;
  sharedPhotonInstance = null;
  sharedPhotonPromise = null;
  if (instance && typeof instance.close === 'function') {
    await instance.close().catch(() => {});
  }
}

export function resolvePaidOpForTool(call) {
  const name = String(call?.name || '').trim();
  if (name === 'canvas_generation_submit') return 'canvas.generation.submit';
  if (name === 'canvas_generation_regenerate') return 'canvas.generation.regenerate';
  if (name === 'media_review') return 'media.review';
  if (name === 'business_call') {
    const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    const targetTool = String(args.tool || '').trim();
    const model = String(args.body?.model || '').trim();
    if (targetTool === 'business_post_timeline_transcriptions' && model !== '') {
      return 'business.call';
    }
  }
  return '';
}

function isAllowedInReadOnlyMode(entry, toolName) {
  if (READ_ONLY_BUILTIN_TOOLS.has(toolName)) return true;
  if (entry?.readOnlyToolNames?.has(toolName)) return true;
  return false;
}

async function publishApprovalSlotDetails(runtime, approvalMeta, context) {
  try {
    await runtime.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, runtime.conversationId);
      const allSlots = [...(live?.tools || []), ...(live?.nestedTools || [])];
      const slot = allSlots.find((item) => item?.taskId === runtime.taskId);
      if (slot) {
        slot.details = {
          ...(slot.details && typeof slot.details === 'object' ? slot.details : {}),
          beeftvApproval: approvalMeta,
        };
      }
      return undefined;
    }, context);
  } catch {
    // 槽位详情写入失败不阻塞审批休眠，Go 侧 /history 仍会从 SQLite 恢复审批卡。
  }
}

async function clearApprovalSlotDetails(runtime, context) {
  try {
    await runtime.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, runtime.conversationId);
      const allSlots = [...(live?.tools || []), ...(live?.nestedTools || [])];
      const slot = allSlots.find((item) => item?.taskId === runtime.taskId);
      if (slot?.details?.beeftvApproval) {
        const nextDetails = { ...slot.details };
        delete nextDetails.beeftvApproval;
        slot.details = nextDetails;
      }
      return undefined;
    }, context);
  } catch {
    // 忽略清理失败，槽位状态会随执行推进覆盖。
  }
}

export function createDurableApprovalExtension({
  entry,
  opsRequest = null,
  precheckTool = null,
  authorization = null,
  approvalSleepMs = DEFAULT_APPROVAL_SLEEP_MS,
} = {}) {
  const runPrecheck = typeof precheckTool === 'function'
    ? precheckTool
    : typeof opsRequest === 'function'
      ? async (payload, signal, turnId) => opsRequest('POST', '/assistant/runtime/tool-precheck', payload, signal, turnId)
      : null;

  return defineExtension({
    name: 'beeftv.approval.v1',
    tasks: [ProposalTerminateTask],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, runtime, context) => {
          // 关键安全规则：Pi scheduler 会吞掉钩子抛错；所有权限校验与 Go 预检必须包在 try/catch 内，
          // 任何异常、拒绝或不确定状态一律显式返回 { block: reason }（fail-closed）。
          try {
            if (entry?.generation?.aborted || context?.abortSignal?.aborted) {
              return { block: 'aborted' };
            }
            if (entry?.generation?.pendingInputError) {
              return { block: entry.generation.pendingInputError.reason || 'turn_intent_changed' };
            }
            const turnId = String(entry?.turn?.turnId || '').trim();
            const memoKey = `beeftv.approval:${turnId}:${call.id}`;
            const existingMemo = typeof runtime?.memo === 'function'
              ? await runtime.memo(memoKey, context)
              : undefined;
            if (entry?.generation?.pendingInput?.state === 'pending' && !existingMemo?.proposalId) {
              return { block: 'supplement_preparation_pending' };
            }

            // 必须先执行回合授权检查，再做 permissionMode 与 canvasId 门控，防止授权撤销后凭旧模式放行。
            if (turnId && typeof authorization === 'function') {
              await authorization(entry, turnId);
            }

            const currentMode = entry?.permissionMode || entry?.generation?.permissionMode || 'canvas';
            if (currentMode === 'read-only' && !isAllowedInReadOnlyMode(entry, call.name)) {
              return { block: `scope_denied: 本轮助手只能读取（禁止调用 ${call.name}）` };
            }

            if (
              currentMode === 'canvas' &&
              call.name.startsWith('canvas_') &&
              !CANVAS_MULTI_READ_TOOLS.has(call.name) &&
              call.arguments &&
              typeof call.arguments === 'object' &&
              call.arguments.canvasId !== undefined &&
              entry?.canvasId &&
              call.arguments.canvasId !== entry.canvasId
            ) {
              return { block: `scope_denied: 画布参数与当前会话不一致（${call.arguments.canvasId} ≠ ${entry.canvasId}）` };
            }

            const paidOp = resolvePaidOpForTool(call);
            if (!paidOp) {
              return undefined;
            }
            // 付费工具缺少预检通道时必须 fail-closed，严禁静默放行。
            if (!runPrecheck) {
              return { block: 'tool_precheck_unavailable' };
            }

          const effectiveCallId = entry?.sessionId && runtime?.taskId
            ? toolOperationId(entry.sessionId, String(runtime.taskId))
            : call.id;
          const precheckPayload = {
            canvasId: String(entry?.canvasId || ''),
            sessionId: String(entry?.sessionId || ''),
            turnId,
            durableTaskId: Number(runtime?.taskId || 0),
            toolName: call.name,
            opName: paidOp,
            callId: effectiveCallId,
            params: call.arguments && typeof call.arguments === 'object' ? call.arguments : {},
          };

          // 若此前已因等待审批休眠过（含重启或扩展重装触发的 gatedCall 提前唤醒），
          // 先读已到达的 ApprovalDecision 信号；绝不重复创建审批单。
          if (existingMemo?.proposalId) {
            const signalState = typeof runtime?.readSignal === 'function'
              ? await runtime.readSignal(ApprovalDecision, existingMemo.proposalId, context)
              : undefined;
            if (signalState) {
              if (signalState.expired === true) {
                await clearApprovalSlotDetails(runtime, context);
                return { block: '审批等待已超时，请重新确认后继续' };
              }
              const payload = signalState.value && typeof signalState.value === 'object' ? signalState.value : null;
              if (payload?.decision === 'reject') {
                await clearApprovalSlotDetails(runtime, context);
                return { block: payload.reason || '用户已拒绝该操作' };
              }
              if (payload?.decision === 'approve') {
                await clearApprovalSlotDetails(runtime, context);
                return undefined;
              }
              await clearApprovalSlotDetails(runtime, context);
              return { block: '无效的审批结果' };
            }
            // 无信号但被唤醒（如宿主重启）：向 Go 幂等核对最新审批状态，若仍待审则继续原地休眠。
            const refreshed = await runPrecheck(precheckPayload, context?.abortSignal, turnId);
            if (refreshed?.decision === 'allow') {
              await clearApprovalSlotDetails(runtime, context);
              return undefined;
            }
            if (refreshed?.decision === 'deny') {
              await clearApprovalSlotDetails(runtime, context);
              return { block: refreshed.message || refreshed.reason || '用户已拒绝该操作' };
            }
            if (refreshed?.decision === 'approval_required') {
              const updatedMeta = {
                ...existingMemo,
                durableTaskId: Number(runtime?.taskId || existingMemo.durableTaskId || 0),
              };
              await publishApprovalSlotDetails(runtime, updatedMeta, context);
              return {
                sleep: {
                  signals: [ApprovalDecision.key(existingMemo.proposalId)],
                  until: runtime.now() + approvalSleepMs,
                },
              };
            }
            return { block: refreshed?.message || refreshed?.reason || 'tool_precheck_failed' };
          }

          // 首次付费工具预检
          const precheck = await runPrecheck(precheckPayload, context?.abortSignal, turnId);
          if (precheck?.decision === 'allow') {
            return undefined;
          }
          if (precheck?.decision === 'deny') {
            return { block: precheck.message || precheck.reason || 'tool_denied' };
          }
          if (precheck?.decision === 'approval_required' && precheck.proposalId) {
            const approvalMeta = {
              proposalId: String(precheck.proposalId),
              canvasId: String(entry?.canvasId || ''),
              sessionId: String(entry?.sessionId || ''),
              turnId,
              durableTaskId: Number(runtime?.taskId || 0),
              toolCallId: call.id,
              toolName: call.name,
              opName: paidOp,
              summary: String(precheck.summary || ''),
              reason: String(precheck.reason || 'approval_required'),
              message: String(precheck.message || ''),
              ...(precheck.estimatedCny !== undefined ? { estimatedCny: precheck.estimatedCny } : {}),
              ...(precheck.unquotedCount !== undefined ? { unquotedCount: precheck.unquotedCount } : {}),
              ...(Array.isArray(precheck.kinds) ? { kinds: precheck.kinds } : {}),
              ...(precheck.suggestedCapCny !== undefined ? { suggestedCapCny: precheck.suggestedCapCny } : {}),
              ...(Array.isArray(precheck.approval?.nodeIds) ? { nodeIds: precheck.approval.nodeIds } : {}),
            };
            const memoized = typeof runtime?.memo === 'function'
              ? await runtime.memo(memoKey, approvalMeta, context)
              : approvalMeta;
            await publishApprovalSlotDetails(runtime, memoized, context);
            return {
              sleep: {
                signals: [ApprovalDecision.key(memoized.proposalId)],
                until: runtime.now() + approvalSleepMs,
              },
            };
          }
          return { block: precheck?.message || precheck?.reason || 'tool_precheck_failed' };
        } catch (error) {
          return { block: error?.message || error?.reason || 'tool_gate_error' };
        }
      },
    }),
    hook(GenerationTask, {
      afterTools: async (_assistant, results, api, context) => {
        if (await roundProducedProposal(results, api, entry, context)) {
          return { tasks: [hookTask(ProposalTerminateTask, { terminate: true })] };
        }
        return undefined;
      },
    })],
  });
}
