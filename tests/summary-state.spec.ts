import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  applySummaryEvent,
  emptySummaryState,
  summarizeSession,
} from '../src/summary-state.ts'

const sid = 'test-summary-1' as SessionId

function toolCall(seq: number, callId: string, name: string, turn: number, step: number): SessionEvent {
  return {
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/call',
    data: { callId: callId as ToolCallId, name, arguments: '{}', turn, step },
  }
}

function toolResult(seq: number, callId: string, turn: number, step: number, error?: { name: string; code: string }): SessionEvent {
  return {
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/result',
    data: {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId: callId as ToolCallId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(error === undefined ? {} : { error }),
    },
  } as SessionEvent
}

function turnStart(seq: number, turn: number): SessionEvent {
  return { seq: SessionSeq(seq), time: 1000 + seq, type: 'turn/start', data: { turn } }
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return { seq: SessionSeq(seq), time: 1000 + seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
}

describe('emptySummaryState', () => {
  it('starts with zero totals and an empty current turn', () => {
    const state = emptySummaryState(sid)
    expect(state.sessionId).toBe(sid)
    expect(state.totalTurns).toBe(0)
    expect(state.totalToolCalls).toBe(0)
    expect(state.totalElapsedMs).toBe(0)
    expect(state.currentTurn.toolCount).toBe(0)
    expect(state.lastCompleted).toBeUndefined()
    expect(state.byFamily).toEqual({
      file: 0, shell: 0, search: 0, edit: 0, network: 0, other: 0,
    })
  })
})

describe('applySummaryEvent', () => {
  it('folds tool calls into the current turn only', () => {
    let state = emptySummaryState(sid)
    state = applySummaryEvent(state, turnStart(1, 1))
    state = applySummaryEvent(state, toolCall(2, 'c1', 'read_file', 1, 0))
    expect(state.currentTurn.toolCount).toBe(1)
    expect(state.currentTurn.byFamily.file).toBe(1)
    // 未结束的 turn 不计入会话汇总
    expect(state.totalToolCalls).toBe(0)
  })

  it('commits a completed turn into the session totals', () => {
    let state = emptySummaryState(sid)
    state = applySummaryEvent(state, turnStart(1, 1))
    state = applySummaryEvent(state, toolCall(2, 'c1', 'read_file', 1, 0))
    state = applySummaryEvent(state, toolResult(3, 'c1', 1, 0))
    state = applySummaryEvent(state, turnEnd(4, 1))
    expect(state.totalTurns).toBe(1)
    expect(state.totalToolCalls).toBe(1)
    expect(state.totalElapsedMs).toBe(1)
    expect(state.byFamily.file).toBe(1)
    expect(state.lastCompleted?.turn).toBe(1)
    expect(state.lastCompleted?.summary.toolCount).toBe(1)
    // turn 结束后 current turn 重置
    expect(state.currentTurn.toolCount).toBe(0)
  })

  it('aggregates families across turns', () => {
    let state = emptySummaryState(sid)
    state = applySummaryEvent(state, turnStart(1, 1))
    state = applySummaryEvent(state, toolCall(2, 'c1', 'edit_file', 1, 0))
    state = applySummaryEvent(state, toolResult(3, 'c1', 1, 0))
    state = applySummaryEvent(state, turnEnd(4, 1))
    state = applySummaryEvent(state, turnStart(5, 2))
    state = applySummaryEvent(state, toolCall(6, 'c2', 'bash', 2, 0))
    state = applySummaryEvent(state, toolResult(7, 'c2', 2, 0))
    state = applySummaryEvent(state, turnEnd(8, 2))
    expect(state.totalTurns).toBe(2)
    expect(state.totalToolCalls).toBe(2)
    // 家族分类唯一来源 format/tool-family：edit_file 归 file（与着色一致）
    expect(state.byFamily.file).toBe(1)
    expect(state.byFamily.shell).toBe(1)
  })

  it('counts failed tool results in the turn summary', () => {
    let state = emptySummaryState(sid)
    state = applySummaryEvent(state, turnStart(1, 1))
    state = applySummaryEvent(state, toolCall(2, 'c1', 'bash', 1, 0))
    state = applySummaryEvent(state, toolResult(3, 'c1', 1, 0, { name: 'E2BIG', code: 'E2BIG' }))
    state = applySummaryEvent(state, turnEnd(4, 1))
    expect(state.lastCompleted?.summary.failedCount).toBe(1)
    expect(state.totalToolCalls).toBe(1)
  })

  it('ignores a tool result whose call was never recorded', () => {
    let state = emptySummaryState(sid)
    state = applySummaryEvent(state, turnStart(1, 1))
    const unchanged = applySummaryEvent(state, toolResult(2, 'ghost', 1, 0))
    expect(unchanged.currentTurn.toolCount).toBe(0)
    expect(unchanged.currentTurn.callTimes.size).toBe(0)
  })

  it('ignores a turn end when no turn is open', () => {
    const state = emptySummaryState(sid)
    const unchanged = applySummaryEvent(state, turnEnd(1, 9))
    expect(unchanged.totalTurns).toBe(0)
    expect(unchanged.lastCompleted).toBeUndefined()
  })

  it('passes non-turn events through untouched', () => {
    const state = emptySummaryState(sid)
    const unchanged = applySummaryEvent(state, {
      seq: SessionSeq(1),
      time: 1001,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi' }] },
    } as SessionEvent)
    expect(unchanged).toBe(state)
  })
})

describe('summarizeSession', () => {
  it('replays an event array into the aggregated state', () => {
    const events: SessionEvent[] = [
      turnStart(1, 1),
      toolCall(2, 'c1', 'read_file', 1, 0),
      toolResult(3, 'c1', 1, 0),
      turnEnd(4, 1),
      turnStart(5, 2),
      toolCall(6, 'c2', 'grep', 2, 0),
      toolResult(7, 'c2', 2, 0),
      turnEnd(8, 2),
    ]
    const state = summarizeSession(sid, events)
    expect(state.totalTurns).toBe(2)
    expect(state.totalToolCalls).toBe(2)
    expect(state.byFamily.file).toBe(1)
    expect(state.byFamily.search).toBe(1)
    expect(state.lastCompleted?.turn).toBe(2)
  })
})
