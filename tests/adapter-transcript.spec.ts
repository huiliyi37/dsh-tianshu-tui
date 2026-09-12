import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { applyTranscriptEvent, createTranscript, emptyTranscript } from '../src/adapter/transcript.js'

const sid = 'test-session-1' as SessionId

function ev(partial: SessionEvent): SessionEvent {
  return partial
}

function userMessage(seq: number, text: string, _turn = 0): SessionEvent {
  return ev({
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'user/message',
    data: { content: [{ type: 'text', text }] },
  } as SessionEvent)
}

function chunk(seq: number, turn: number, step: number, text: string, kind: 'text-delta' | 'reasoning-delta' = 'text-delta'): SessionEvent {
  // 0.1.5：流式增量打包为 assistant/attempt（原始 chunk 记录形态）
  return ev({
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'assistant/attempt',
    data: { turn, step, stream: [{ type: 'chunk', time: 1000 + seq, chunk: { type: kind, text } }] },
  } as unknown as SessionEvent)
}

function assistantMessage(seq: number, turn: number, step: number, text: string): SessionEvent {
  return ev({
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'assistant/message',
    data: { turn, step, message: { content: [{ type: 'text', text }] } },
  } as SessionEvent)
}

function toolCall(seq: number, callId: string, name: string, raw: string, turn: number, step: number): SessionEvent {
  return ev({
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/call',
    data: { callId: callId as ToolCallId, name, arguments: raw, turn, step },
  })
}

function toolResult(seq: number, callId: string, _content: string, error?: { name: string; code: string }): SessionEvent {
  return ev({
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/result',
    data: {
      turn: 0,
      step: 0,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: callId as ToolCallId },
        content: [{ type: 'tool', toolCallId: callId }],
      },
      ...(error === undefined ? {} : { error }),
    },
  } as unknown as SessionEvent)
}

function turnStart(seq: number, turn: number): SessionEvent {
  return ev({ seq: SessionSeq(seq), time: 1000 + seq, type: 'turn/start', data: { turn } })
}

describe('emptyTranscript', () => {
  it('starts with empty surfaces and a closed turn', () => {
    const view = emptyTranscript(sid)
    expect(view.sessionId).toBe(sid)
    expect(view.messages).toEqual([])
    expect(view.tools).toEqual([])
    expect(view.streaming).toBeUndefined()
    expect(view.turn).toBe(-1)
    expect(view.seq).toBe(-1)
  })
})

describe('applyTranscriptEvent', () => {
  it('folds user messages under the open turn', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, turnStart(1, 3))
    view = applyTranscriptEvent(view, userMessage(2, 'hello'))
    expect(view.turn).toBe(3)
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ kind: 'user', turn: 3, text: 'hello', seq: 2 })
  })

  it('accumulates same-step chunks into one streaming text', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, chunk(1, 1, 0, 'Hel'))
    view = applyTranscriptEvent(view, chunk(2, 1, 0, 'lo'))
    expect(view.streaming).toMatchObject({ turn: 1, step: 0, text: 'Hello' })
  })

  it('resets aggregation when a chunk arrives for a different step', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, chunk(1, 1, 0, 'old'))
    view = applyTranscriptEvent(view, chunk(2, 1, 1, 'new'))
    expect(view.streaming).toMatchObject({ turn: 1, step: 1, text: 'new' })
  })

  it('folds reasoning-delta chunks into the separate reasoning field', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, chunk(1, 1, 0, 'think', 'reasoning-delta'))
    view = applyTranscriptEvent(view, chunk(2, 1, 0, 'text'))
    expect(view.streaming?.reasoning).toBe('think')
    expect(view.streaming?.text).toBe('text')
  })

  it('ignores non-delta chunks in the streaming text', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, ev({
      seq: SessionSeq(1),
      time: 1001,
      type: 'assistant/attempt',
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1001, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] },
    } as unknown as SessionEvent))
    expect(view.streaming).toMatchObject({ turn: 1, step: 0, text: '' })
  })

  it('folds text and reasoning blocks into separate fields', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, ev({
      seq: SessionSeq(1),
      time: 1001,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 0,
        message: {
          content: [
            { type: 'text', text: 'answer' },
            { type: 'reasoning', text: 'hidden', summary: [] },
          ],
        },
      },
    } as SessionEvent))
    expect(view.messages[0]?.text).toBe('answer')
    expect(view.messages[0]?.reasoning).toBe('hidden')
  })

  it('closes the stream when its assistant message commits', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, chunk(1, 1, 0, 'Hello'))
    view = applyTranscriptEvent(view, assistantMessage(2, 1, 0, 'Hello'))
    expect(view.streaming).toBeUndefined()
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ kind: 'assistant', turn: 1, step: 0, text: 'Hello' })
  })

  it('keeps an unrelated stream open when another step commits', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, chunk(1, 1, 0, 'Hello'))
    view = applyTranscriptEvent(view, assistantMessage(2, 1, 1, 'other'))
    expect(view.streaming).toMatchObject({ turn: 1, step: 0 })
  })

  it('registers tool calls in order', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, toolCall(1, 'c1', 'read_file', '{"path":"/x"}', 1, 0))
    view = applyTranscriptEvent(view, toolCall(2, 'c2', 'grep', '{}', 1, 0))
    expect(view.tools.map(t => t.callId)).toEqual(['c1', 'c2'])
    expect(view.tools[0]).toMatchObject({ name: 'read_file', arguments: '{"path":"/x"}', turn: 1, step: 0 })
    expect(view.tools[0]?.result).toBeUndefined()
  })

  it('pairs tool results back to their calls', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, toolCall(1, 'c1', 'read_file', '{}', 1, 0))
    view = applyTranscriptEvent(view, toolResult(2, 'c1', 'file contents'))
    expect(view.tools[0]?.result?.type).toBe('tool/result')
    expect(view.tools[0]?.error).toBeUndefined()
  })

  it('records internal tool failure identity', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, toolCall(1, 'c1', 'bash', '{}', 1, 0))
    view = applyTranscriptEvent(view, toolResult(2, 'c1', '', { name: 'HarnessError', code: 'E_NOPE' }))
    expect(view.tools[0]?.error).toEqual({ name: 'HarnessError', code: 'E_NOPE' })
  })

  it('leaves unmatched results alone and advances the watermark', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, toolResult(1, 'ghost', 'x'))
    expect(view.tools).toHaveLength(0)
    expect(view.seq).toBe(1)
  })

  it('pairs a result to its call and leaves sibling calls untouched', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, toolCall(1, 'c1', 'read_file', '{}', 1, 0))
    view = applyTranscriptEvent(view, toolCall(2, 'c2', 'grep', '{}', 1, 0))
    view = applyTranscriptEvent(view, toolResult(3, 'c1', 'file contents'))
    expect(view.tools[0]?.result?.seq).toBe(3)
    expect(view.tools[1]?.result).toBeUndefined()
  })

  it('advances only the seq watermark for boundary and bookkeeping events', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, ev({ seq: SessionSeq(5), time: 1005, type: 'step/start', data: { turn: 1, step: 0 } }))
    view = applyTranscriptEvent(view, ev({ seq: SessionSeq(6), time: 1006, type: 'todo/write', data: { todos: [] } }))
    expect(view.seq).toBe(6)
    expect(view.messages).toHaveLength(0)
    expect(view.streaming).toBeUndefined()
  })

  it('folds a full turn sequence end to end', () => {
    let view = emptyTranscript(sid)
    for (const e of [
      turnStart(1, 1),
      userMessage(2, 'list files'),
      chunk(3, 1, 0, 'Sure, '),
      chunk(4, 1, 0, 'here:'),
      toolCall(5, 't1', 'fs_list', '{}', 1, 0),
      toolResult(6, 't1', 'a.txt'),
      assistantMessage(7, 1, 0, 'Sure, here:'),
    ]) view = applyTranscriptEvent(view, e)
    expect(view.seq).toBe(7)
    expect(view.turn).toBe(1)
    expect(view.messages.map(m => m.kind)).toEqual(['user', 'assistant'])
    expect(view.tools).toHaveLength(1)
    expect(view.tools[0]?.result?.seq).toBe(6)
    expect(view.streaming).toBeUndefined()
  })
})

describe('createTranscript', () => {
  interface CapturedHandler {
    (owner: { id: SessionId }, event: SessionEvent): void
  }

  function fakeCtx() {
    const handlers = new Map<string, CapturedHandler[]>()
    const dispose = vi.fn()
    const ctx = {
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

  it('replays the session log and folds live events for the same session', () => {
    const { ctx } = fakeCtx()
    const session = { id: sid, events: [userMessage(1, 'replayed')], snapshotEvents: () => [userMessage(1, 'replayed')] } as never
    const t = createTranscript(ctx as never, session)
    expect(t.view.messages).toHaveLength(1)
    expect(t.view.messages[0]?.text).toBe('replayed')

    const handler = ctx.handlers.get('session/event')?.[0]
    if (handler === undefined) throw new Error('session/event handler not registered')
    handler({ id: sid }, assistantMessage(2, 1, 0, 'live'))
    expect(t.view.messages).toHaveLength(2)
    expect(t.view.messages[1]?.kind).toBe('assistant')
  })

  it('ignores events published for other sessions', () => {
    const { ctx } = fakeCtx()
    const session = { id: sid, events: [], snapshotEvents: () => [] } as never
    const t = createTranscript(ctx as never, session)
    const handler = ctx.handlers.get('session/event')?.[0]
    if (handler === undefined) throw new Error('session/event handler not registered')
    handler({ id: 'other-session' as SessionId }, userMessage(1, 'foreign'))
    expect(t.view.messages).toHaveLength(0)
  })

  it('dispose detaches the session/event subscription', () => {
    const { ctx, dispose } = fakeCtx()
    const session = { id: sid, events: [], snapshotEvents: () => [] } as never
    const t = createTranscript(ctx as never, session)
    t.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('firstInTurnTime', () => {
  it('turn/start 后首条 user 消息折叠时记录时间；同 turn 后续消息不覆盖', () => {
    let view = emptyTranscript(sid)
    expect(view.firstInTurnTime).toBeUndefined()
    view = applyTranscriptEvent(view, turnStart(1, 5))
    expect(view.firstInTurnTime).toBeUndefined() // turn 刚开，尚无消息
    view = applyTranscriptEvent(view, userMessage(2, 'hi')) // time = 1002
    expect(view.firstInTurnTime).toBe(1002)
    view = applyTranscriptEvent(view, chunk(3, 5, 0, 'Hel'))
    view = applyTranscriptEvent(view, assistantMessage(4, 5, 0, 'Hello'))
    expect(view.firstInTurnTime).toBe(1002) // 不被第二条消息覆盖
  })

  it('assistant/message 也可作为当前 turn 首条消息记录（无 user 消息场景）', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, turnStart(1, 7))
    view = applyTranscriptEvent(view, assistantMessage(2, 7, 0, 'direct')) // time = 1002
    expect(view.firstInTurnTime).toBe(1002)
  })

  it('turn/start 重置 firstInTurnTime——新 turn 重新计时', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, turnStart(1, 5))
    view = applyTranscriptEvent(view, userMessage(2, 'first')) // time = 1002
    expect(view.firstInTurnTime).toBe(1002)
    view = applyTranscriptEvent(view, turnStart(3, 6))
    expect(view.firstInTurnTime).toBeUndefined() // 新 turn 重置
    view = applyTranscriptEvent(view, userMessage(4, 'second')) // time = 1004
    expect(view.firstInTurnTime).toBe(1004)
  })

  it('assistant/message 的 turn 与 view.turn 不一致时（跨 turn 迟到）不设置', () => {
    let view = emptyTranscript(sid)
    view = applyTranscriptEvent(view, turnStart(1, 5))
    view = applyTranscriptEvent(view, turnStart(2, 6))
    // 迟到一条 turn=5 的 assistant 消息：不属于当前 turn 6，不记录
    view = applyTranscriptEvent(view, assistantMessage(3, 5, 0, 'stale'))
    expect(view.firstInTurnTime).toBeUndefined()
  })
})
