// 每轮步数上限：按会话记录这一轮的工具调用数，达到上限后拒绝后续步骤。
// 只有连着 BeefTV 的会话才启用；用户自己发的新消息会重新计数，不会被上限一起吞掉。

import { stepLimitNotice } from './runtime.js'

export function createStepLimit() {
  const sessions = new Map()
  let notice = null

  function sessionOf(sessionId) {
    if (!sessionId) return null
    let state = sessions.get(sessionId)
    if (!state) {
      state = { turn: null, count: 0, beefTV: false, stop: false }
      sessions.set(sessionId, state)
    }
    return state
  }

  return {
    noteToolCall({ sessionId, beefTV, limit }) {
      const state = sessionOf(sessionId)
      if (!state) return
      state.count += 1
      if (beefTV) state.beefTV = true
      if (!state.stop && state.beefTV && state.count >= limit) {
        state.stop = true
        notice = { sessionId, text: stepLimitNotice(limit) }
      }
    },

    startTurn({ sessionId, turn, beefTV }) {
      if (!sessionId) return
      sessions.set(sessionId, { turn: turn ?? null, count: 0, beefTV: Boolean(beefTV), stop: false })
    },

    endTurn(sessionId) {
      if (sessionId) sessions.delete(sessionId)
    },

    // 返回这一轮是否已经到上限。用户自己发了消息时重新计数并放行。
    decideStep({ sessionId, turn, hasUserInput }) {
      const state = sessionId ? sessions.get(sessionId) : null
      if (!state?.stop) return false
      if (state.turn !== null && turn !== state.turn) return false
      if (!hasUserInput) return true
      state.count = 0
      state.stop = false
      notice = null
      return false
    },

    // turn-stopping 只在模型已不再调用工具的收尾阶段触发，用来补齐桌面提示。
    noteStopping({ sessionId, turn, limit }) {
      const state = sessionId ? sessions.get(sessionId) : null
      if (!state?.stop) return
      if (state.turn !== null && turn !== state.turn) return
      notice = { sessionId, text: stepLimitNotice(limit) }
    },

    // 用户自己发了新消息：上限提示立即收起。
    acknowledgeUserMessage(sessionId) {
      if (notice?.sessionId === sessionId) notice = null
    },

    acknowledge() {
      notice = null
    },

    noticeText: () => notice?.text || null,

    forget(sessionId) {
      sessions.delete(sessionId)
      if (notice?.sessionId === sessionId) notice = null
    },
  }
}
