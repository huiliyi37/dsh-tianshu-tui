import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import { applyLiveEvent, emptyLiveState, trackAgent } from '../src/adapter/live.js'

const sid = 'test-live-1' as SessionId

function toolCall(seq: number, callId: string, name: string, argsRaw: string, turn: number, step: number): SessionEvent {
  return {
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/call',
    data: { callId: callId as ToolCallId, name, arguments: argsRaw, turn, step },
  }
}

function toolResult(seq: number, callId: string, turn: number, step: number): SessionEvent {
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
    },
  } as SessionEvent
}

describe('emptyLiveState', () => {
  it('starts with no activity', () => {
    const state = emptyLiveState(sid)
    expect(state.activity).toBeUndefined()
    expect(state.status).toBe('idle')
    expect(state.live).toBe(true)
  })
})

describe('applyLiveEvent activity projection', () => {
  it('records the current tool name and raw arguments on tool-call', () => {
    let state = emptyLiveState(sid)
    state = applyLiveEvent(state, {
      type: 'tool-call',
      turn: 1,
      step: 0,
      callId: 'c1' as ToolCallId,
      name: 'read_file',
      arguments: '{"file_path":"src/a.ts"}',
    })
    expect(state.activity).toEqual({
      callId: 'c1',
      name: 'read_file',
      arguments: '{"file_path":"src/a.ts"}',
      turn: 1,
      step: 0,
    })
  })

  it('clears activity when its call result arrives', () => {
    let state = emptyLiveState(sid)
    state = applyLiveEvent(state, { type: 'tool-call', turn: 1, step: 0, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{}' })
    state = applyLiveEvent(state, { type: 'tool-result', callId: 'c1' as ToolCallId })
    expect(state.activity).toBeUndefined()
  })

  it('keeps activity when an unrelated call result arrives', () => {
    let state = emptyLiveState(sid)
    state = applyLiveEvent(state, { type: 'tool-call', turn: 1, step: 0, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{}' })
    state = applyLiveEvent(state, { type: 'tool-result', callId: 'ghost' as ToolCallId })
    expect(state.activity?.callId).toBe('c1')
  })

  it('does not disturb status/inbox when folding activity', () => {
    let state = emptyLiveState(sid)
    state = applyLiveEvent(state, { type: 'status', status: 'running' })
    state = applyLiveEvent(state, { type: 'tool-call', turn: 2, step: 1, callId: 'c1' as ToolCallId, name: 'run_tests', arguments: '{}' })
    expect(state.status).toBe('running')
    expect(state.activity?.name).toBe('run_tests')
  })
})

describe('applyLiveEvent error projection', () => {
  it('records agent errors as lastError with turn/step', () => {
    let state = emptyLiveState(sid)
    const err = new Error('boom')
    state = applyLiveEvent(state, { type: 'error', turn: 2, step: 1, error: err })
    expect(state.lastError).toEqual({ turn: 2, step: 1, error: err })
  })

  it('clears lastError when the agent starts running again', () => {
    let state = emptyLiveState(sid)
    state = applyLiveEvent(state, { type: 'error', turn: 1, step: 0, error: new Error('x') })
    state = applyLiveEvent(state, { type: 'status', status: 'running' })
    expect(state.lastError).toBeUndefined()
  })

  it('keeps lastError across the idle status after a failed turn', () => {
    let state = emptyLiveState(sid)
    state = applyLiveEvent(state, { type: 'status', status: 'running' })
    state = applyLiveEvent(state, { type: 'error', turn: 1, step: 0, error: new Error('x') })
    state = applyLiveEvent(state, { type: 'status', status: 'idle' })
    expect(state.lastError).toBeDefined()
  })
})

describe('trackAgent session/event projection', () => {
  interface CapturedHandler {
    (owner: { id: SessionId }, event: SessionEvent): void
  }

  function fakeCtx(agentStatus: AgentStatus) {
    const handlers = new Map<string, CapturedHandler[]>()
    const dispose = vi.fn()
    const ctx = {
      agents: { get: vi.fn(() => ({ status: agentStatus, inbox: { nextTurn: [], nextStep: [] } })) },
      on: vi.fn((channel: string, handler: CapturedHandler) => {
        const list = handlers.get(channel) ?? []
        list.push(handler)
        handlers.set(channel, list)
        return dispose
      }),
      handlers,
    }
    return { ctx, dispose }
  }

  it('folds tool/call events for the tracked session into activity', () => {
    const { ctx } = fakeCtx('running')
    const live = trackAgent(ctx as never, sid)
    const handler = ctx.handlers.get('session/event')?.[0]
    if (handler === undefined) throw new Error('session/event handler not registered')
    handler({ id: sid }, toolCall(1, 'c1', 'edit_file', '{}', 3, 2))
    expect(live.state.activity?.name).toBe('edit_file')
    expect(live.state.activity?.turn).toBe(3)
  })

  it('ignores tool/call events published for other sessions', () => {
    const { ctx } = fakeCtx('running')
    const live = trackAgent(ctx as never, sid)
    const handler = ctx.handlers.get('session/event')?.[0]
    if (handler === undefined) throw new Error('session/event handler not registered')
    handler({ id: 'other-session' as SessionId }, toolCall(1, 'c1', 'bash', '{}', 1, 0))
    expect(live.state.activity).toBeUndefined()
  })

  it('clears activity on the matching tool/result', () => {
    const { ctx } = fakeCtx('running')
    const live = trackAgent(ctx as never, sid)
    const handler = ctx.handlers.get('session/event')?.[0]
    if (handler === undefined) throw new Error('session/event handler not registered')
    handler({ id: sid }, toolCall(1, 'c1', 'bash', '{}', 1, 0))
    handler({ id: sid }, toolResult(2, 'c1', 1, 0))
    expect(live.state.activity).toBeUndefined()
  })

  it('dispose detaches both agent and session subscriptions', () => {
    const { ctx, dispose } = fakeCtx('running')
    const live = trackAgent(ctx as never, sid)
    live.dispose()
    // agent/* 各事件 + session/event 各注册过一次 dispose
    expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
