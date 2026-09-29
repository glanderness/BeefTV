// 会话动作身份：把「哪一个会话 + 哪一次工具调用」映射成一个稳定的 operationId 前缀。
//
// 身份必须绑定在单个会话上，不能用宿主进程级变量：同一进程里 A、B 两个画布会各建一条
// 会话，全局变量会让后建的会话覆盖前一个的身份，使 A 的写入带上 B 的前缀（同一
// toolCallId 在两条会话里也可能撞成同一个 operationId）。
//
// 优先用官方 SessionManager 的持久 session id：进程重启后同一会话的未确认动作仍映射到
// 同一 operationId，不会因为换了一次 RUN_ID 而被重复执行。官方未暴露 id 时才退回 RUN_ID，
// 此时日志会说明来源，并且不静默重放。

export function sessionActionIdentity({ persistedId, runId }) {
  const persisted = String(persistedId || '').trim();
  if (persisted) return { prefix: persisted, source: 'persistent-session-id' };
  return { prefix: `run:${String(runId || '').trim()}`, source: 'run-id' };
}

export function toolOperationId(prefix, toolCallId, fallback) {
  const identity = String(prefix || '').trim();
  const call = String(toolCallId || '').trim() || String(fallback || '').trim();
  return `${identity}:${call}`;
}
