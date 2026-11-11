// 等待/唤醒状态机的有界穷举测试。
// 每一步都检查：同一 taskId 不会同时存在两份唤醒、用户停止后这一轮不再唤醒、
// 通知不会投到别的工作区、除停止/关闭开关/切区/销毁会话/超时外待补投结果不丢、
// 连续自动唤醒不超过 3 次。事件序列长度不超过 6，2 个会话、3 个任务、2 个工作区；
// 无状态变化的分支会剪掉，相同状态（含丢失许可）只展开一次。

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAwaitState, maximumWakesPerSession, transition } from './await-machine.js'
import { createStepLimit } from './step-limit.js'

const sessions = ['s1', 's2']
const workspaces = ['w1', 'w2']
const tasks = ['t1', 't2', 't3']
const maximumDepth = 6
const maximumExplored = 500_000

function emptyLedger() {
  return {
    taskWorkspace: {}, taskSession: {}, resolved: {},
    dropped: new Set(), stopped: new Set(), stoppedTasks: {}, messageSeq: 0,
  }
}

function copyLedger(ledger) {
  return {
    taskWorkspace: { ...ledger.taskWorkspace },
    taskSession: { ...ledger.taskSession },
    resolved: { ...ledger.resolved },
    dropped: new Set(ledger.dropped),
    stopped: new Set(ledger.stopped),
    stoppedTasks: Object.fromEntries(Object.entries(ledger.stoppedTasks).map(([id, value]) => [id, new Set(value)])),
    messageSeq: ledger.messageSeq,
  }
}

function activeWorkspace(state) {
  return state.connection.phase === 'connected' ? state.connection.workspaceId : null
}

function waitTaskIds(state, sessionId) {
  return state.waits[sessionId]?.taskIds || []
}

function heldBySession(state, sessionId, taskId) {
  if (waitTaskIds(state, sessionId).includes(taskId)) return true
  if (state.sessions[sessionId]?.deferred?.outcomes.some(outcome => outcome.taskId === taskId)) return true
  return Object.values(state.messages).some(entry => entry.sessionId === sessionId
    && entry.outcomes.some(outcome => outcome.taskId === taskId))
}

// 一个任务可以停留的地方：等待队列、deferred、已投递消息、离开时清单。
function heldTasks(state) {
  const held = new Set()
  for (const wait of Object.values(state.waits)) for (const taskId of wait.taskIds) held.add(taskId)
  for (const session of Object.values(state.sessions)) for (const outcome of session.deferred?.outcomes || []) held.add(outcome.taskId)
  for (const entry of Object.values(state.messages)) for (const outcome of entry.outcomes) held.add(outcome.taskId)
  for (const entry of state.away.entries) for (const taskId of entry.taskIds) held.add(taskId)
  return held
}

function checkState(state, ledger, where) {
  for (const session of Object.values(state.sessions)) {
    assert.ok(session.wakeCount >= 0 && session.wakeCount <= maximumWakesPerSession, `${where}: 连续唤醒计数越界 ${session.wakeCount}`)
    assert.ok(!session.deferred || session.deferred.outcomes.length <= 50, `${where}: deferred 超过上限`)
  }
  // 唤醒消息里的任务必须已经记账，且同一任务不能同时出现在两条消息里。
  const live = new Map()
  for (const [messageId, entry] of Object.entries(state.messages)) {
    for (const outcome of entry.outcomes) {
      assert.equal(state.woken[outcome.taskId], true, `${where}: 消息 ${messageId} 的任务 ${outcome.taskId} 没有记账`)
      assert.equal(live.has(outcome.taskId), false, `${where}: 任务 ${outcome.taskId} 同时存在于两条唤醒消息`)
      live.set(outcome.taskId, messageId)
    }
    if (entry.state === 'pending') {
      const active = activeWorkspace(state)
      if (active && entry.workspaceId) assert.equal(entry.workspaceId, active, `${where}: 待投通知属于别的工作区`)
    }
  }
  for (const [sessionId, wait] of Object.entries(state.waits)) {
    for (const taskId of wait.taskIds) {
      assert.equal(state.woken[taskId], undefined, `${where}: 已唤醒的任务 ${taskId} 仍在等待队列`)
      assert.ok(state.sessions[sessionId], `${where}: 等待队列缺少会话状态`)
    }
  }
  for (const session of Object.values(state.sessions)) {
    for (const outcome of session.deferred?.outcomes || []) {
      assert.equal(state.woken[outcome.taskId], undefined, `${where}: 已唤醒的任务 ${outcome.taskId} 还在 deferred`)
    }
  }
  const held = heldTasks(state)
  for (const [taskId, resolved] of Object.entries(ledger.resolved)) {
    if (!resolved || state.woken[taskId] || held.has(taskId)) continue
    assert.ok(ledger.dropped.has(taskId), `${where}: 任务 ${taskId} 已结束但既没投递也没保留`)
  }
}

function checkDelivery(state, ledger, action, where) {
  assert.ok(action.outcomes.length > 0, `${where}: 空唤醒`)
  for (const outcome of action.outcomes) {
    assert.equal(state.woken[outcome.taskId], undefined, `${where}: 任务 ${outcome.taskId} 已有未撤回的唤醒`)
    if (ledger.stopped.has(action.sessionId)) assert.equal(ledger.stoppedTasks[action.sessionId]?.has(outcome.taskId) === true, false, `${where}: 用户停止后仍在唤醒这一轮的任务 ${outcome.taskId}`)
  }
  const active = activeWorkspace(state)
  if (active) assert.equal(action.workspaceId ?? null, active, `${where}: 唤醒投到了别的工作区`)
  const session = state.sessions[action.sessionId]
  assert.ok(!session || session.wakeCount < maximumWakesPerSession, `${where}: 超过连续自动唤醒上限仍在投递`)
}

// 只允许在明确的场景里失去一个仍被记着的任务；其它任何消失都直接失败。
function checkLosses(before, after, event, ledger, where) {
  const heldBefore = heldTasks(before)
  const heldAfter = heldTasks(after)
  for (const taskId of heldBefore) {
    if (heldAfter.has(taskId) || after.woken[taskId]) continue
    let allowed = false
    if (event.type === 'autoContinueOff') allowed = true
    else if (event.type === 'agentDisposed' && heldBySession(before, event.sessionId, taskId)) allowed = true
    else if ((event.type === 'userStop' || event.type === 'turnEndedByUser') && heldBySession(before, event.sessionId, taskId)) allowed = true
    else if (event.type === 'workspaceConnected' && event.workspaceId !== ledger.taskWorkspace[taskId]) allowed = true
    else if (event.type === 'userMessage' && activeWorkspace(after) && ledger.taskWorkspace[taskId] !== activeWorkspace(after)) allowed = true
    else if (event.type === 'messageDiscarded') {
      const entry = before.messages[event.messageId]
      allowed = Boolean(entry && before.sessions[entry.sessionId]?.stopped)
    } else if (event.type === 'stepEntered') {
      const target = after.connection.phase === 'connected' ? after.connection.workspaceId
        : after.connection.phase === 'connecting' ? after.connection.from?.workspaceId : null
      const entry = Object.values(before.messages).find(item => item.outcomes.some(outcome => outcome.taskId === taskId))
      allowed = Boolean(target && entry?.workspaceId && entry.workspaceId !== target)
    }
    assert.ok(allowed, `${where}: 任务 ${taskId} 在 ${event.type} 中无声丢失`)
    ledger.dropped.add(taskId)
  }
}

function settleActions(branches, actions, counter, path) {
  for (const action of actions) {
    if (action.type === 'deliver') {
      branches = branches.flatMap(branch => {
        checkDelivery(branch.state, branch.ledger, action, `${path.join('>')}>deliver`)
        return [true, false].map(ok => {
          const ledger = copyLedger(branch.ledger)
          const messageId = ok ? `wake-${++ledger.messageSeq}` : null
          const delivered = transition(branch.state, {
            type: 'delivered', sessionId: action.sessionId, messageId, ok,
            outcomes: action.outcomes, workspaceId: action.workspaceId, source: action.source,
          })
          counter.transitions += 1
          assert.ok(delivered.actions.every(item => item.type === 'persist'), 'delivered 只能触发落盘')
          return { state: delivered.state, ledger }
        })
      })
    } else if (action.type === 'withdraw') {
      branches = branches.flatMap(branch => [true, false].flatMap(removed => {
        const withdrawn = transition(branch.state, {
          type: 'withdrawn', messageId: action.messageId, removed, agentStatus: 'idle',
        })
        counter.transitions += 1
        return settleActions([{ state: withdrawn.state, ledger: copyLedger(branch.ledger) }], withdrawn.actions, counter, path).branches
      }))
    } else if (action.type === 'probeAway') {
      branches = branches.map(branch => {
        const probed = transition(branch.state, {
          type: 'awayProbed',
          // 探针结果保持 pending：away 条目继续留着，下一轮再核对。
          results: action.targets.map(target => ({
            id: target.id, remaining: [...target.taskIds, ...target.rest], completed: target.resolvedCount,
          })),
        })
        return { state: probed.state, ledger: branch.ledger }
      })
    }
  }
  return { branches }
}

function settle(state, ledger, event, counter, path) {
  counter.transitions += 1
  const result = transition(state, event)
  return settleActions([{ state: result.state, ledger: copyLedger(ledger) }], result.actions, counter, path).branches
}

function eventVariants(state) {
  const events = []
  const active = activeWorkspace(state)
  for (const workspaceId of workspaces) events.push({ type: 'workspaceConnected', workspaceId })
  events.push({ type: 'workspaceLost' })
  events.push({ type: 'connectionFailed' })
  events.push({ type: 'workspaceConnecting', fromWorkspaceId: active, sameMode: true })
  events.push({ type: 'workspaceConnecting', fromWorkspaceId: null, sameMode: false })
  if (active) {
    for (const sessionId of sessions) {
      for (const taskId of tasks) {
        // inject/followup 的投递方式不改变状态机的不变量；busy 会话另有单测覆盖。
        events.push({ type: 'tasksSubmitted', sessionId, workspaceId: active, taskIds: [taskId], agentStatus: 'idle' })
      }
    }
  }
  if (Object.keys(state.waits).length) events.push({ type: 'abandonWaits', sessionIds: Object.keys(state.waits) })
  if (!Object.keys(state.waits).length && !Object.keys(state.messages).length && !state.away.entries.length) {
    events.push({ type: 'historyLoaded', sessions: [], away: [{ workspaceId: 'w1', taskIds: ['t1'], resolvedCount: 0 }] })
  }
  for (const [messageId, entry] of Object.entries(state.messages)) {
    events.push({ type: 'messageClaimed', sessionId: entry.sessionId, messageId, sourceKind: 'beeftv-await', agentStatus: 'idle' })
  }
  for (const sessionId of sessions) {
    const wait = state.waits[sessionId]
    if (wait) {
      for (const agentStatus of ['idle', 'running']) {
        events.push({
          type: 'taskFinished', sessionId, waitToken: wait.token, agentStatus,
          outcomes: wait.taskIds.map(taskId => ({ taskId, state: 'succeeded', reason: '' })),
        })
      }
      events.push({ type: 'waitExpired', sessionId, waitToken: wait.token })
    }
    events.push({ type: 'userMessage', sessionId, agentStatus: 'idle' })
    events.push({ type: 'messageClaimed', sessionId, messageId: `user-${sessionId}`, sourceKind: 'user', agentStatus: 'idle' })
    events.push({ type: 'userStop', sessionId })
    events.push({ type: 'turnEndedByUser', sessionId })
    const claimed = Object.keys(state.messages).filter(messageId => state.messages[messageId].sessionId === sessionId)
    const stale = Object.keys(state.stale)
    for (const ids of [claimed, stale]) {
      if (!ids.length) continue
      for (const decisionKind of ['enter', 'reject']) {
        for (const stepReject of [false, true]) {
          events.push({ type: 'stepEntered', sessionId, claimed: ids, decisionKind, stepReject })
        }
      }
    }
    events.push({ type: 'turnStarted', sessionId })
    events.push({ type: 'agentIdle', sessionId, agentStatus: 'idle' })
    events.push({ type: 'agentDisposed', sessionId })
  }
  for (const [messageId, entry] of Object.entries(state.messages)) {
    if (entry.state === 'pending') events.push({ type: 'messageDiscarded', messageId })
  }
  events.push({ type: state.autoContinue ? 'autoContinueOff' : 'autoContinueOn' })
  // 恢复持久化设置只发生在启动时，不建模成运行中事件。
  if (!Object.keys(state.sessions).length && !Object.keys(state.waits).length && !Object.keys(state.messages).length) {
    events.push({ type: 'autoContinueRestored', autoContinue: false })
  }
  if (state.away.entries.length) events.push({ type: 'awaySeen', workspaceId: active })
  return events
}

function describe(event) {
  return event.type + (event.sessionId ? `:${event.sessionId}` : '') + (event.taskIds ? `:${event.taskIds.join(',')}` : '')
    + (event.workspaceId ? `@${event.workspaceId}` : '') + (event.agentStatus ? `/${event.agentStatus}` : '')
    + (event.messageId ? `#${event.messageId}` : '') + (event.waitToken ? `^${event.waitToken}` : '')
}

function updateLedger(ledger, state, event) {
  const next = copyLedger(ledger)
  if (event.type === 'tasksSubmitted') {
    for (const taskId of event.taskIds) {
      next.taskWorkspace[taskId] ??= event.workspaceId
      next.taskSession[taskId] ??= event.sessionId
    }
  } else if (event.type === 'taskFinished') {
    for (const outcome of event.outcomes) next.resolved[outcome.taskId] = true
  } else if (event.type === 'userStop' || event.type === 'turnEndedByUser') {
    next.stopped.add(event.sessionId)
    const session = state.sessions[event.sessionId]
    const stoppedTasks = new Set(next.stoppedTasks[event.sessionId] || [])
    for (const taskId of waitTaskIds(state, event.sessionId)) stoppedTasks.add(taskId)
    for (const outcome of session?.deferred?.outcomes || []) stoppedTasks.add(outcome.taskId)
    next.stoppedTasks[event.sessionId] = stoppedTasks
  } else if (event.type === 'turnStarted' || event.type === 'userMessage' || event.type === 'messageClaimed') {
    next.stopped.delete(event.sessionId)
    delete next.stoppedTasks[event.sessionId]
  } else if (event.type === 'agentDisposed') {
    next.stopped.delete(event.sessionId)
    delete next.stoppedTasks[event.sessionId]
  }
  return next
}

test('等待/唤醒状态机在长度 6 的事件序列内保持全部不变量', t => {
  const counter = { transitions: 0, sequences: 0, pruned: 0, states: 0 }
  let capped = false
  const seen = new Set()
  const ledgerKey = ledger => JSON.stringify({
    taskWorkspace: ledger.taskWorkspace, taskSession: ledger.taskSession, resolved: ledger.resolved,
    dropped: [...ledger.dropped].sort(),
    stopped: [...ledger.stopped].sort(),
    stoppedTasks: Object.fromEntries(Object.entries(ledger.stoppedTasks).sort().map(([id, set]) => [id, [...set].sort()])),
  })
  const stateKey = (state, ledger) => JSON.stringify(state).replace(/wake-\d+/g, 'wake') + '|' + ledgerKey(ledger)

  function walk(state, ledger, depth, path = []) {
    if (capped || depth === maximumDepth) return
    const key = stateKey(state, ledger)
    if (seen.has(key)) return
    seen.add(key)
    counter.states += 1
    for (const event of eventVariants(state)) {
      if (capped || counter.sequences >= maximumExplored) { capped = true; return }
      const preview = transition(state, event)
      // 状态和动作都没有真实变化时不再展开相同子树。
      if (JSON.stringify(preview.state) === JSON.stringify(state) && preview.actions.every(action => action.type === 'persist')) {
        counter.pruned += 1
        continue
      }
      counter.sequences += 1
      const nextLedger = updateLedger(ledger, state, event)
      const eventPath = [...path, describe(event)]
      for (const branch of settle(state, nextLedger, event, counter, eventPath)) {
        checkLosses(state, branch.state, event, branch.ledger, eventPath.join('>'))
        checkState(branch.state, branch.ledger, `${event.type}#${counter.sequences}`)
        walk(branch.state, branch.ledger, depth + 1, eventPath)
      }
    }
  }

  walk(createAwaitState(), emptyLedger(), 0)
  t.diagnostic(`穷举事件序列 ${counter.sequences} 条（深度 ≤ ${maximumDepth}），去重后状态 ${counter.states} 个，状态迁移 ${counter.transitions} 次，剪枝 ${counter.pruned} 条${capped ? '，达到上限提前停止' : '，已完整覆盖'}`)
  assert.ok(counter.sequences >= 10_000, `事件序列覆盖太少：${counter.sequences}`)
  assert.ok(!capped, '穷举达到上限，未能完整覆盖；应缩小事件集或加深剪枝')
})

test('步数上限不会吞掉用户自己的消息，提示只在真正拒绝时出现', () => {
  for (const limit of [5, 6]) {
    for (let count = 0; count <= limit + 1; count++) {
      for (const hasUserInput of [true, false]) {
        for (const turn of [1, 2]) {
          const step = createStepLimit()
          step.startTurn({ sessionId: 's', turn: 1, beefTV: true })
          for (let index = 0; index < count; index++) step.noteToolCall({ sessionId: 's', beefTV: true, limit })
          if (count >= limit) assert.equal(step.noticeText(), null, '还没拒绝下一步就提示先停一下')
          const reject = step.decideStep({ sessionId: 's', turn, hasUserInput })
          if (hasUserInput) assert.equal(reject, false, '用户消息被步数上限吞掉')
          else if (turn !== 1) assert.equal(reject, false, '别的轮次被上一轮上限影响')
          else assert.equal(reject, count >= limit, `步数 ${count}/${limit} 的判定不对`)
          if (reject) assert.match(step.noticeText(), /先停一下/)
          step.startTurn({ sessionId: 's', turn: 2, beefTV: true })
          assert.equal(step.noticeText(), null, '新的一轮仍显示上一轮的上限提示')
        }
      }
    }
  }
})

// 短序列复现历史复审报过的窗口，失败时能直接定位到具体场景。
test('用户停止后，这一轮的迟到结果不会唤醒', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['t1'], agentStatus: 'idle' }).state
  const token = state.waits.s1.token
  const stopped = transition(state, { type: 'userStop', sessionId: 's1' })
  assert.ok(!stopped.state.waits.s1)
  const late = transition(stopped.state, {
    type: 'taskFinished', sessionId: 's1', waitToken: token,
    outcomes: [{ taskId: 't1', state: 'succeeded', reason: '' }], agentStatus: 'idle',
  })
  assert.ok(late.actions.every(action => action.type !== 'deliver'))
})

test('切换工作区时，旧工作区已 claim 的唤醒被 pre-step 过滤', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['t1'], agentStatus: 'running' }).state
  state = transition(state, {
    type: 'delivered', sessionId: 's1', messageId: 'wake-1', ok: true,
    outcomes: [{ taskId: 't1', state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
  }).state
  // 撤回拿不回来：进入 stale，由 pre-step 过滤。
  state = transition(state, { type: 'workspaceConnecting', fromWorkspaceId: 'w1', sameMode: false }).state
  state = transition(state, { type: 'withdrawn', messageId: 'wake-1', removed: false, agentStatus: 'running' }).state
  const step = transition(state, { type: 'stepEntered', sessionId: 's1', claimed: ['wake-1'], decisionKind: 'enter', stepReject: false })
  assert.deepEqual(step.reply.exclude, ['wake-1'])
})

test('来源未知的重连不丢待补投通知', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['t1'], agentStatus: 'running' }).state
  state = transition(state, {
    type: 'delivered', sessionId: 's1', messageId: 'wake-1', ok: true,
    outcomes: [{ taskId: 't1', state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
  }).state
  state = transition(state, { type: 'workspaceLost' }).state
  state = transition(state, { type: 'workspaceConnecting', fromWorkspaceId: null, sameMode: false }).state
  const step = transition(state, { type: 'stepEntered', sessionId: 's1', claimed: ['wake-1'], decisionKind: 'enter', stepReject: false })
  // 消息不进入这一步，但结果已经记在 deferred，连回同一工作区后补投。
  assert.deepEqual(step.reply.exclude, ['wake-1'])
  assert.equal(step.state.sessions.s1.deferred.outcomes[0].taskId, 't1')
})

test('连续三次自动唤醒后第四次进入 deferred，用户消息补投', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  function wake(taskId) {
    state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: [taskId], agentStatus: 'idle' }).state
    const waitToken = state.waits.s1.token
    const finished = transition(state, {
      type: 'taskFinished', sessionId: 's1', waitToken,
      outcomes: [{ taskId, state: 'succeeded', reason: '' }], agentStatus: 'idle',
    })
    state = finished.state
    const deliver = finished.actions.find(action => action.type === 'deliver')
    if (deliver) {
      state = transition(state, {
        type: 'delivered', sessionId: 's1', messageId: `m-${taskId}`, ok: true,
        outcomes: deliver.outcomes, workspaceId: 'w1', source: 'wait',
      }).state
    }
    return Boolean(deliver)
  }
  assert.equal(wake('t1'), true)
  assert.equal(wake('t2'), true)
  assert.equal(wake('t3'), true)
  assert.equal(state.sessions.s1.wakeCount, 3)
  assert.equal(wake('t4'), false)
  assert.deepEqual(state.sessions.s1.deferred.outcomes.map(outcome => outcome.taskId), ['t4'])
  const user = transition(state, { type: 'userMessage', sessionId: 's1', agentStatus: 'idle' })
  const deliver = user.actions.find(action => action.type === 'deliver')
  assert.ok(deliver)
  assert.deepEqual(deliver.outcomes.map(outcome => outcome.taskId), ['t4'])
  assert.equal(user.state.sessions.s1.wakeCount, 0)
})

test('40 分钟超时把任务留给下次连回时核对，不再静默删除', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['t1'], agentStatus: 'idle' }).state
  const token = state.waits.s1.token
  const expired = transition(state, { type: 'waitExpired', sessionId: 's1', waitToken: token })
  assert.ok(!expired.state.waits.s1)
  assert.deepEqual(expired.state.away.entries.map(({ workspaceId, taskIds, resolvedCount }) => ({ workspaceId, taskIds, resolvedCount })),
    [{ workspaceId: 'w1', taskIds: ['t1'], resolvedCount: 0 }])
})

test('会话被销毁时把等待留给离开提示', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['t1'], agentStatus: 'idle' }).state
  const disposed = transition(state, { type: 'agentDisposed', sessionId: 's1' })
  assert.deepEqual(disposed.state.away.entries.map(({ workspaceId, taskIds, resolvedCount }) => ({ workspaceId, taskIds, resolvedCount })),
    [{ workspaceId: 'w1', taskIds: ['t1'], resolvedCount: 0 }])
})

test('关闭自动继续会撤回已注入的唤醒，撤回失败由 pre-step 过滤', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, { type: 'tasksSubmitted', sessionId: 's1', workspaceId: 'w1', taskIds: ['t1'], agentStatus: 'running' }).state
  state = transition(state, {
    type: 'delivered', sessionId: 's1', messageId: 'wake-1', ok: true,
    outcomes: [{ taskId: 't1', state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
  }).state
  const off = transition(state, { type: 'autoContinueOff' })
  assert.equal(off.actions.find(action => action.type === 'withdraw')?.reason, 'disable')
  state = transition(off.state, { type: 'withdrawn', messageId: 'wake-1', removed: false, agentStatus: 'running' }).state
  const step = transition(state, { type: 'stepEntered', sessionId: 's1', claimed: ['wake-1'], decisionKind: 'enter', stepReject: false })
  assert.deepEqual(step.reply.exclude, ['wake-1'])
})

test('deferred 超过 50 条时转入离开提示而不是静默丢弃', () => {
  let state = createAwaitState()
  for (let index = 0; index < 51; index++) {
    state = transition(state, {
      type: 'delivered', sessionId: 's1', messageId: null, ok: false,
      outcomes: [{ taskId: `t${index}`, state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
    }).state
  }
  assert.equal(state.sessions.s1.deferred.outcomes.length, 50)
  assert.equal(state.away.entries[0].taskIds[0], 't0')
  assert.equal(state.away.entries[0].workspaceId, 'w1')
})

test('插件退出时把 deferred 的完成结果转入离开提示', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, {
    type: 'delivered', sessionId: 's1', messageId: null, ok: false,
    outcomes: [{ taskId: 't1', state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
  }).state
  assert.equal(state.sessions.s1.deferred.outcomes[0].taskId, 't1')
  const stopped = transition(state, { type: 'pluginStopped' })
  assert.equal(stopped.state.sessions.s1.deferred, null)
  assert.deepEqual(stopped.state.away.entries.map(entry => entry.taskIds), [['t1']])
})

test('会话销毁时把 deferred 的完成结果转入离开提示', () => {
  let state = transition(createAwaitState(), { type: 'workspaceConnected', workspaceId: 'w1' }).state
  state = transition(state, {
    type: 'delivered', sessionId: 's1', messageId: null, ok: false,
    outcomes: [{ taskId: 't1', state: 'succeeded', reason: '' }], workspaceId: 'w1', source: 'wait',
  }).state
  const disposed = transition(state, { type: 'agentDisposed', sessionId: 's1' })
  assert.deepEqual(disposed.state.away.entries.map(entry => entry.taskIds), [['t1']])
})

test('away probe 按稳定 id 回写，不受 awaySeen 删除条目的影响', () => {
  let state = createAwaitState()
  state = transition(state, { type: 'waitExpired', sessionId: 's1', waitToken: -1 }).state
  state = transition(state, { type: 'historyLoaded', sessions: [], away: [
    { workspaceId: 'w1', taskIds: ['t1'], resolvedCount: 0 },
    { workspaceId: 'w1', taskIds: ['t2'], resolvedCount: 0 },
  ] }).state
  const connected = transition(state, { type: 'workspaceConnected', workspaceId: 'w1' })
  const probe = connected.actions.find(action => action.type === 'probeAway')
  assert.equal(probe.targets.length, 2)
  // 用户在 probe 回来前关掉提示：条目顺序/数量变化后，旧结果不能写错位置。
  const seen = transition(connected.state, { type: 'awaySeen', workspaceId: 'w1' }).state
  const reordered = [{ ...seen, away: { ...seen.away, entries: [...seen.away.entries].reverse() } }][0]
  const probed = transition(reordered, {
    type: 'awayProbed',
    results: probe.targets.map(target => ({ id: target.id, remaining: [], completed: 0 })),
  }).state
  const byId = new Map(probed.away.entries.map(entry => [entry.id, entry]))
  for (const target of probe.targets) {
    assert.deepEqual(byId.get(target.id).taskIds, [])
  }
})
