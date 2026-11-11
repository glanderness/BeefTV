// 等待、唤醒、待补投通知、停止与工作区切换的纯状态机。
// transition(state, event) 不调用 DSH、不读盘、不设定时器；它只返回下一份状态和要执行的动作。
// 真正的 followup/inject、inbox 撤回、task.wait 轮询与 awaiting.json 落盘都在 await-runner.js。

export const maximumWakesPerSession = 3
const maximumDeferredOutcomes = 50

export function createAwaitState({ autoContinue = true } = {}) {
  return {
    seq: 0,
    autoContinue,
    // phase: disconnected | connecting | connected。connecting 时 from 记录切换前的工作区。
    connection: { phase: 'disconnected', workspaceId: null, from: null },
    sessions: {},
    // messageId → { sessionId, outcomes, workspaceId, state: 'pending'|'withdrawing', reason }
    messages: {},
    // 已从会话撤回失败、只能靠 pre-step 过滤的唤醒消息。
    stale: {},
    // 已成功投递过的 taskId；撤回消息时移除，因此同一任务不会同时存在两份唤醒。
    woken: {},
    // sessionId → { token, workspaceId, taskIds }
    waits: {},
    // 离开期间完成的任务；entries 原样落盘，count 是当前应提示的数量。
    away: { entries: [], count: 0 },
  }
}

function sessionOf(state, sessionId) {
  if (!sessionId) return null
  return state.sessions[sessionId] ??= { wakeCount: 0, stopped: false, deferred: null }
}

function messagesOf(state, sessionId) {
  return Object.entries(state.messages).filter(([, entry]) => entry.sessionId === sessionId)
}

function activeWorkspace(state) {
  return state.connection.phase === 'connected' ? state.connection.workspaceId : null
}

function dedupeOutcomes(outcomes) {
  const seen = new Set()
  const result = []
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (!outcome || typeof outcome.taskId !== 'string' || !outcome.taskId || seen.has(outcome.taskId)) continue
    seen.add(outcome.taskId)
    result.push({ taskId: outcome.taskId, state: outcome.state || 'pending', reason: outcome.reason || '' })
  }
  return result
}

function waitHasTask(state, taskId) {
  return Object.values(state.waits).some(wait => wait.taskIds.includes(taskId))
}

function pendingHasTaskAnywhere(state, taskId) {
  return Object.values(state.messages).some(entry => entry.outcomes.some(outcome => outcome.taskId === taskId))
}

function deferredHasTaskAnywhere(state, taskId) {
  return Object.values(state.sessions).some(session => session.deferred?.outcomes.some(outcome => outcome.taskId === taskId))
}

function markWoken(state, outcomes) {
  for (const outcome of outcomes) state.woken[outcome.taskId] = true
}

function unmarkWoken(state, outcomes) {
  for (const outcome of outcomes) delete state.woken[outcome.taskId]
}

function removeMessage(state, messageId) {
  delete state.messages[messageId]
}

function defer(state, sessionId, outcomes, workspaceId) {
  const session = sessionOf(state, sessionId)
  if (!session) return
  const list = dedupeOutcomes(outcomes)
  if (!list.length) return
  const previous = session.deferred && session.deferred.workspaceId === (workspaceId ?? null)
    ? session.deferred.outcomes
    : []
  const merged = [...previous]
  for (const outcome of list) {
    if (!merged.some(item => item.taskId === outcome.taskId)) merged.push(outcome)
  }
  while (merged.length > maximumDeferredOutcomes) merged.shift()
  session.deferred = { workspaceId: workspaceId ?? null, outcomes: merged }
}

// 投进模型前的撤回：先把消息移出账本，再让薄壳调 inbox.remove。
// 撤回成功就直接丢弃/重投；拿不回来（已被 claim）时切工作区要留 stale 由 pre-step 过滤。
function withdraw(state, entry, messageId, reason, actions) {
  entry.state = 'withdrawing'
  entry.reason = reason
  actions.push({ type: 'withdraw', sessionId: entry.sessionId, messageId, reason })
}

function abandonWaits(state, sessionIds, actions, out) {
  for (const sessionId of sessionIds) {
    const wait = state.waits[sessionId]
    if (!wait) continue
    if (wait.taskIds.length) {
      state.away.entries.push({ workspaceId: wait.workspaceId ?? null, taskIds: [...wait.taskIds], resolvedCount: 0 })
    }
    delete state.waits[sessionId]
    actions.push({ type: 'abortWait', sessionId, token: wait.token })
    out.persist = true
  }
}

function stopSession(state, sessionId, actions, out) {
  const session = sessionOf(state, sessionId)
  if (!session) return
  session.stopped = true
  session.deferred = null
  const wait = state.waits[sessionId]
  if (wait) {
    delete state.waits[sessionId]
    actions.push({ type: 'abortWait', sessionId, token: wait.token })
    out.persist = true
  }
  for (const [messageId] of messagesOf(state, sessionId)) removeMessage(state, messageId)
}

function userMessage(state, sessionId, agentStatus, actions) {
  const session = sessionOf(state, sessionId)
  if (!session) return
  // 用户亲自发消息：连续自动唤醒预算重新开始，被上限挡住的结果这时补投。
  session.wakeCount = 0
  session.stopped = false
  const active = activeWorkspace(state)
  const deferred = session.deferred
  if (!deferred?.outcomes.length) return
  if (active && deferred.workspaceId && deferred.workspaceId !== active) {
    session.deferred = null
    return
  }
  if (!active) return
  const outcomes = deferred.outcomes.filter(outcome =>
    !state.woken[outcome.taskId] && !waitHasTask(state, outcome.taskId) && !pendingHasTaskAnywhere(state, outcome.taskId))
  const leftover = deferred.outcomes.filter(outcome => !outcomes.includes(outcome))
  session.deferred = leftover.length ? { workspaceId: deferred.workspaceId, outcomes: leftover } : null
  if (!outcomes.length) return
  actions.push({
    type: 'deliver', sessionId, outcomes, workspaceId: active,
    mode: agentStatus === 'running' ? 'inject' : 'followup', source: 'deferred',
  })
}

function classifyClaimed(state, messageId) {
  const entry = state.messages[messageId]
  if (!entry && !state.stale[messageId]) return null
  const switching = state.connection.phase === 'connecting'
  const from = state.connection.from
  const sourceUnknown = switching && !from?.workspaceId
  if (sourceUnknown && entry?.workspaceId) return 'uncertain'
  if (state.stale[messageId]) return 'stale'
  const workspaceId = entry?.workspaceId
  if (!workspaceId) return 'fresh'
  if (switching) {
    if (from?.sameMode) return workspaceId === from.workspaceId ? 'fresh' : 'stale'
    return 'stale'
  }
  const active = activeWorkspace(state)
  return active && workspaceId !== active ? 'stale' : 'fresh'
}

// 把已 claim 的唤醒消息分到 stale（丢弃）、uncertain（先补投记录）和 fresh（照常进入）。
function classifyStep(state, event, out) {
  const stale = []
  const uncertain = []
  const fresh = []
  for (const messageId of Array.isArray(event.claimed) ? event.claimed : []) {
    const kind = classifyClaimed(state, messageId)
    if (kind === 'stale') stale.push(messageId)
    else if (kind === 'uncertain') uncertain.push(messageId)
    else if (kind === 'fresh') fresh.push(messageId)
  }
  for (const messageId of [...stale, ...uncertain]) {
    const entry = state.messages[messageId]
    const session = entry ? sessionOf(state, entry.sessionId) : null
    if (entry) {
      unmarkWoken(state, entry.outcomes)
      if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
      if (uncertain.includes(messageId)) defer(state, entry.sessionId, entry.outcomes, entry.workspaceId)
    }
    removeMessage(state, messageId)
    delete state.stale[messageId]
  }
  const deferredFresh = event.decisionKind !== 'enter' || event.stepReject
  if (deferredFresh) {
    for (const messageId of fresh) {
      const entry = state.messages[messageId]
      if (!entry) continue
      unmarkWoken(state, entry.outcomes)
      const session = sessionOf(state, entry.sessionId)
      if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
      defer(state, entry.sessionId, entry.outcomes, entry.workspaceId)
      removeMessage(state, messageId)
    }
  } else {
    for (const messageId of fresh) removeMessage(state, messageId)
  }
  const excluded = [...stale, ...uncertain]
  if (event.decisionKind !== 'enter') return { enter: false, exclude: excluded }
  if (event.stepReject) return { enter: false, reject: true, exclude: excluded }
  return { enter: true, exclude: excluded }
}

export function transition(state, event) {
  const next = structuredClone(state)
  const actions = []
  const out = { persist: false, reply: null }
  const type = event?.type
  const finish = () => {
    if (out.persist) actions.push({ type: 'persist' })
    return { state: next, actions, reply: out.reply }
  }

  if (type === 'historyLoaded') {
    for (const entry of Array.isArray(event.sessions) ? event.sessions : []) {
      if (!entry?.taskIds?.length && !entry?.resolvedCount) continue
      next.away.entries.push({ workspaceId: entry.workspaceId ?? null, taskIds: [...(entry.taskIds || [])], resolvedCount: entry.resolvedCount || 0 })
      out.persist = true
    }
    for (const entry of Array.isArray(event.away) ? event.away : []) {
      if (!entry?.taskIds?.length && !entry?.resolvedCount) continue
      next.away.entries.push({ workspaceId: entry.workspaceId ?? null, taskIds: [...(entry.taskIds || [])], resolvedCount: entry.resolvedCount || 0 })
      out.persist = true
    }
  } else if (type === 'workspaceConnecting') {
    next.connection = {
      phase: 'connecting', workspaceId: null,
      from: { workspaceId: event.fromWorkspaceId ?? null, sameMode: event.sameMode === true },
    }
  } else if (type === 'connectionFailed' || type === 'workspaceLost') {
    next.connection = { phase: 'disconnected', workspaceId: null, from: null }
  } else if (type === 'workspaceConnected') {
    const workspaceId = event.workspaceId ?? null
    next.connection = { phase: 'connected', workspaceId, from: null }
    for (const [messageId, entry] of Object.entries(next.messages)) {
      if (!entry.workspaceId || entry.workspaceId === workspaceId) continue
      withdraw(next, entry, messageId, 'switch', actions)
    }
    const targets = []
    next.away.entries.forEach((entry, index) => {
      if (entry.workspaceId && entry.workspaceId !== workspaceId) return
      const taskIds = entry.taskIds.slice(0, 20)
      targets.push({ index, taskIds, rest: entry.taskIds.slice(20), resolvedCount: entry.resolvedCount || 0 })
    })
    if (!next.away.entries.length) next.away.count = 0
    if (targets.length) actions.push({ type: 'probeAway', workspaceId, targets })
    else if (next.away.entries.length) {
      next.away.count = 0
      out.persist = true
    }
  } else if (type === 'abandonWaits') {
    abandonWaits(next, Array.isArray(event.sessionIds) ? event.sessionIds : [], actions, out)
  } else if (type === 'tasksSubmitted') {
    const session = sessionOf(next, event.sessionId)
    if (!session || !next.autoContinue || session.stopped || next.connection.phase !== 'connected') return finish()
    const fresh = (Array.isArray(event.taskIds) ? event.taskIds : []).filter(taskId =>
      typeof taskId === 'string' && taskId && !next.woken[taskId]
      && !pendingHasTaskAnywhere(next, taskId) && !deferredHasTaskAnywhere(next, taskId)
      && !waitHasTask(next, taskId))
    if (!fresh.length) return finish()
    let wait = next.waits[event.sessionId]
    if (wait && wait.workspaceId !== (event.workspaceId ?? null)) {
      actions.push({ type: 'abortWait', sessionId: event.sessionId, token: wait.token })
      wait = null
    }
    if (!wait) {
      wait = { token: ++next.seq, workspaceId: event.workspaceId ?? null, taskIds: [] }
      next.waits[event.sessionId] = wait
    }
    for (const taskId of fresh) if (!wait.taskIds.includes(taskId)) wait.taskIds.push(taskId)
    actions.push({
      type: 'poll', sessionId: event.sessionId, token: wait.token, workspaceId: wait.workspaceId,
      taskIds: [...wait.taskIds], resetDeadline: true,
    })
    out.persist = true
  } else if (type === 'taskFinished') {
    const wait = next.waits[event.sessionId]
    if (!wait || wait.token !== event.waitToken) return finish()
    delete next.waits[event.sessionId]
    const session = sessionOf(next, event.sessionId)
    const outcomes = dedupeOutcomes(event.outcomes).filter(outcome =>
      !next.woken[outcome.taskId] && !pendingHasTaskAnywhere(next, outcome.taskId)
      && !deferredHasTaskAnywhere(next, outcome.taskId))
    const workspaceId = wait.workspaceId ?? null
    const active = activeWorkspace(next)
    if (outcomes.length && next.autoContinue && (!active || workspaceId === active)) {
      if (session.wakeCount >= maximumWakesPerSession) {
        defer(next, event.sessionId, outcomes, workspaceId)
      } else {
        actions.push({
          type: 'deliver', sessionId: event.sessionId, outcomes, workspaceId,
          mode: event.agentStatus === 'running' ? 'inject' : 'followup', source: 'wait',
        })
      }
    }
    out.persist = true
  } else if (type === 'waitExpired') {
    const wait = next.waits[event.sessionId]
    if (wait && wait.token === event.waitToken) {
      delete next.waits[event.sessionId]
      actions.push({ type: 'abortWait', sessionId: event.sessionId, token: wait.token })
      out.persist = true
    }
  } else if (type === 'delivered') {
    const session = sessionOf(next, event.sessionId)
    if (!session) return finish()
    if (!event.ok) {
      defer(next, event.sessionId, event.outcomes, event.workspaceId)
      return finish()
    }
    const outcomes = dedupeOutcomes(event.outcomes)
    markWoken(next, outcomes)
    session.wakeCount += 1
    if (event.messageId) {
      next.messages[event.messageId] = {
        sessionId: event.sessionId, outcomes,
        workspaceId: event.workspaceId ?? activeWorkspace(next),
        state: 'pending', reason: null,
      }
    }
    // 兜底清理：同一任务只允许留在一处。正常路径在投递前已经过滤。
    for (const outcome of outcomes) {
      for (const [id, wait] of Object.entries(next.waits)) {
        if (!wait.taskIds.includes(outcome.taskId)) continue
        wait.taskIds = wait.taskIds.filter(taskId => taskId !== outcome.taskId)
        if (wait.taskIds.length) continue
        delete next.waits[id]
        actions.push({ type: 'abortWait', sessionId: id, token: wait.token })
        out.persist = true
      }
      for (const item of Object.values(next.sessions)) {
        if (!item.deferred) continue
        item.deferred.outcomes = item.deferred.outcomes.filter(candidate => candidate.taskId !== outcome.taskId)
        if (!item.deferred.outcomes.length) item.deferred = null
      }
    }
    if (event.source === 'deferred') session.deferred = null
  } else if (type === 'withdrawn') {
    const entry = next.messages[event.messageId]
    if (!entry || entry.state !== 'withdrawing') return finish()
    if (!event.removed) {
      if (entry.reason === 'switch') {
        const session = sessionOf(next, entry.sessionId)
        if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
        unmarkWoken(next, entry.outcomes)
        next.stale[event.messageId] = entry.sessionId
        removeMessage(next, event.messageId)
      } else {
        entry.state = 'pending'
        entry.reason = null
      }
      return finish()
    }
    const session = sessionOf(next, entry.sessionId)
    if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
    unmarkWoken(next, entry.outcomes)
    const outcomes = entry.outcomes
    const workspaceId = entry.workspaceId ?? activeWorkspace(next)
    removeMessage(next, event.messageId)
    if (entry.reason === 'switch') return finish()
    actions.push({
      type: 'deliver', sessionId: entry.sessionId, outcomes, workspaceId,
      mode: event.agentStatus === 'running' ? 'inject' : 'followup', source: 'withdraw',
    })
  } else if (type === 'agentIdle') {
    const active = activeWorkspace(next)
    if (!next.sessions[event.sessionId]) return finish()
    for (const [messageId, entry] of messagesOf(next, event.sessionId)) {
      if (entry.state !== 'pending') continue
      if (!entry.workspaceId || entry.workspaceId !== active) continue
      withdraw(next, entry, messageId, 'idle', actions)
    }
  } else if (type === 'messageClaimed') {
    if (event.sourceKind === 'beeftv-await' || next.messages[event.messageId] || next.stale[event.messageId]) return finish()
    if (event.sourceKind !== 'user') return finish()
    userMessage(next, event.sessionId, event.agentStatus, actions)
  } else if (type === 'userMessage') {
    userMessage(next, event.sessionId, event.agentStatus, actions)
  } else if (type === 'messageDiscarded') {
    const entry = next.messages[event.messageId]
    if (!entry || entry.state === 'withdrawing') return finish()
    const session = sessionOf(next, entry.sessionId)
    if (session) session.wakeCount = Math.max(0, session.wakeCount - 1)
    unmarkWoken(next, entry.outcomes)
    removeMessage(next, event.messageId)
    if (session?.stopped) return finish()
    defer(next, entry.sessionId, entry.outcomes, entry.workspaceId)
  } else if (type === 'stepEntered') {
    out.reply = classifyStep(next, event, out)
  } else if (type === 'userStop' || type === 'turnEndedByUser') {
    stopSession(next, event.sessionId, actions, out)
  } else if (type === 'turnStarted') {
    const session = next.sessions[event.sessionId]
    if (session) session.stopped = false
  } else if (type === 'agentDisposed') {
    stopSession(next, event.sessionId, actions, out)
    delete next.sessions[event.sessionId]
    for (const [messageId, owner] of Object.entries(next.stale)) {
      if (owner === event.sessionId) delete next.stale[messageId]
    }
  } else if (type === 'autoContinueOff') {
    next.autoContinue = false
    for (const sessionId of Object.keys(next.waits)) {
      const wait = next.waits[sessionId]
      delete next.waits[sessionId]
      actions.push({ type: 'abortWait', sessionId, token: wait.token })
    }
    for (const session of Object.values(next.sessions)) session.deferred = null
    for (const messageId of Object.keys(next.messages)) removeMessage(next, messageId)
    out.persist = true
  } else if (type === 'autoContinueOn') {
    next.autoContinue = true
  } else if (type === 'awaySeen') {
    const workspaceId = event.workspaceId ?? null
    next.away.entries = next.away.entries.flatMap(entry => {
      if (workspaceId && entry.workspaceId && entry.workspaceId !== workspaceId) return [entry]
      return entry.taskIds.length ? [{ workspaceId: entry.workspaceId ?? null, taskIds: entry.taskIds, resolvedCount: 0 }] : []
    })
    next.away.count = 0
    out.persist = true
  } else if (type === 'awayProbed') {
    const results = new Map((Array.isArray(event.results) ? event.results : []).map(result => [result.index, result]))
    next.away.entries = next.away.entries.map((entry, index) => {
      const result = results.get(index)
      if (!result) return entry
      return { workspaceId: entry.workspaceId ?? null, taskIds: result.remaining || [], resolvedCount: result.completed || 0 }
    })
    next.away.count = [...results.values()].reduce((sum, result) => sum + (result.completed || 0), 0)
    out.persist = true
  }

  return finish()
}

// awaiting.json 的形状只由状态机决定，薄壳负责写盘。
export function awaitingSnapshot(state) {
  const sessions = {}
  for (const [sessionId, wait] of Object.entries(state.waits)) {
    if (!wait.taskIds.length) continue
    sessions[sessionId] = { workspaceId: wait.workspaceId ?? null, taskIds: [...wait.taskIds] }
  }
  return { sessions, away: state.away.entries.map(entry => ({ ...entry, taskIds: [...entry.taskIds] })) }
}
