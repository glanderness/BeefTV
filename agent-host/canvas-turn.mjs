// 一轮对话的画布影响与付费生成提议：从成功的工具结果里当场累计，
// 而不是把工具结果正文留在日志里（画布读取结果很大，也没必要外发）。
//
// 供应商定义同样放在这里：协议决定用哪个 pi-ai 适配器，宿主不再假设一切都是
// OpenAI 兼容接口，地址形状由后端按协议整理好后下发。

export const SUPPORTED_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

export function newTurnAccumulator() {
  return { seq: 0, toolSeq: 0, revisionBefore: 0, revisionAfter: 0,
    createdNodeIds: [], updatedNodeIds: [], createdEdgeIds: [], proposals: [] };
}

export function resetTurnAccumulator(turn, revisionBefore) {
  turn.seq += 1;
  turn.toolSeq = 0;
  turn.revisionBefore = Number(revisionBefore || 0);
  turn.revisionAfter = 0;
  turn.createdNodeIds.length = 0;
  turn.updatedNodeIds.length = 0;
  turn.createdEdgeIds.length = 0;
  turn.proposals.length = 0;
  return turn;
}

function asStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function collectTurnEffects(turn, opID, result) {
  if (!turn || !result || typeof result !== 'object') return turn;
  if (typeof result.revision === 'number' && result.revision > turn.revisionAfter) {
    turn.revisionAfter = result.revision;
  }
  switch (opID) {
    case 'canvas.nodes.create':
      for (const node of Array.isArray(result.created) ? result.created : []) {
        if (node && node.id) turn.createdNodeIds.push(String(node.id));
      }
      break;
    case 'canvas.node.update':
      if (result.nodeId) turn.updatedNodeIds.push(String(result.nodeId));
      break;
    case 'canvas.edge.create':
      // 重复连线会幂等返回（没有新增），这时不能算作本轮新建了连线。
      if (result.created && result.edgeId) turn.createdEdgeIds.push(String(result.edgeId));
      break;
    case 'canvas.generation.propose':
      if (result.proposalId) {
        turn.proposals.push({ proposalId: String(result.proposalId), kind: String(result.kind || ''),
          nodeIds: asStringList(result.nodeIds), model: String(result.model || ''),
          modelKey: String(result.modelKey || ''), note: String(result.note || '') });
      }
      break;
    default:
      break;
  }
  return turn;
}

// turnChange 只在这一轮真的推进了画布版本时给出变更摘要；没写过画布时是 null。
export function turnChange(turn) {
  if (!turn || turn.revisionAfter <= turn.revisionBefore) return null;
  return { revisionBefore: turn.revisionBefore, revisionAfter: turn.revisionAfter,
    createdNodeIds: [...turn.createdNodeIds], updatedNodeIds: [...turn.updatedNodeIds],
    createdEdgeIds: [...turn.createdEdgeIds] };
}

// sessionTitle 用第一条用户原文当标题（截到 40 字），而不是加过画布前缀的那份。
export function sessionTitle(turns) {
  const first = (turns || []).find((turn) => String(turn?.userText || '').trim());
  const text = String(first?.userText || '').trim();
  return text.length > 40 ? text.slice(0, 40) : text;
}

// providerRegistration 构造要登记给 pi 的供应商：
// 密钥以环境变量引用形式传入，宿主进程内解析，不写进 auth.json。
export function providerRegistration({ api, baseUrl, modelId, maxTokens, contextWindow }) {
  return {
    name: 'BeefTV', baseUrl, apiKey: '$BEEFTV_AGENT_API_KEY', api,
    models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow, maxTokens }],
  };
}

// providerUnavailableReason 给出机器可读原因，交给后端的状态投影使用。
export function providerUnavailableReason({ modelId, baseUrl, apiKey, api }) {
  if (!modelId || !baseUrl || !apiKey) return 'model_not_configured';
  if (!SUPPORTED_APIS.includes(api)) return 'model_protocol_unsupported';
  return '';
}
