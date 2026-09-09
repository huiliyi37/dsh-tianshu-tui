import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  applyTurnEvent,
  emptyTurnSummary,
  formatTurnSummary,
  summarizeTurn,
  type ToolCallRecord,
} from '../src/turn-summary.ts'

function turnStart(seq: number, turn: number): SessionEvent {
  return { seq: SessionSeq(seq), time: 1000 + seq, type: 'turn/start', data: { turn } }
}

function toolCall(seq: number, callId: string, name: string, turn: number, step: number): SessionEvent {
  return {
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/call',
    data: { callId: callId as ToolCallId, name, arguments: '{}', turn, step },
  }
}

function toolResult(seq: number, callId: string, error?: { name: string; code: string }, turn = 1): SessionEvent {
  return {
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/result',
    data: {
      turn,
      step: 0,
      message: {
        source: { kind: 'tool', callId: callId as ToolCallId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [] }],
      },
      ...(error === undefined ? {} : { error }),
    },
  } as SessionEvent
}

describe('emptyTurnSummary', () => {
  it('starts with zeroed counters and all families at zero', () => {
    const summary = emptyTurnSummary(3)
    expect(summary.turn).toBe(3)
    expect(summary.calls).toEqual([])
    expect(summary.toolCount).toBe(0)
    expect(summary.failedCount).toBe(0)
    expect(summary.totalElapsedMs).toBe(0)
    expect(summary.byFamily).toEqual({
      file: 0, shell: 0, search: 0, edit: 0, network: 0, other: 0,
    })
  })
})

describe('applyTurnEvent — tool/call', () => {
  it('records the call with family classification and bumps counters', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'edit_file', 1, 0))
    expect(summary.toolCount).toBe(1)
    // 家族分类唯一来源 format/tool-family：edit_file 归 file（与着色一致）
    expect(summary.byFamily.file).toBe(1)
    expect(summary.byFamily.edit).toBe(0)
    expect(summary.calls).toHaveLength(1)
    expect(summary.calls[0]).toMatchObject({ callId: 'c1', name: 'edit_file', family: 'file' })
  })

  it('classifies bash under shell and web_fetch under network', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    summary = applyTurnEvent(summary, toolCall(3, 'c2', 'web_fetch', 1, 1))
    expect(summary.byFamily.shell).toBe(1)
    expect(summary.byFamily.network).toBe(1)
  })

  it('falls back to other for unknown tools', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'mystery_tool', 1, 0))
    expect(summary.byFamily.other).toBe(1)
  })
})

describe('applyTurnEvent — tool/result pairing', () => {
  it('computes elapsed from call and result times', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    summary = applyTurnEvent(summary, toolResult(12, 'c1'))
    const record: ToolCallRecord | undefined = summary.calls[0]
    expect(record?.startedAt).toBe(1002)
    expect(record?.elapsedMs).toBe(10)
    expect(summary.totalElapsedMs).toBe(10)
  })

  it('marks a result with error as failed and counts it', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    summary = applyTurnEvent(summary, toolResult(8, 'c1', { name: 'E2BIG', code: 'E2BIG' }))
    expect(summary.calls[0]?.failed).toBe(true)
    expect(summary.failedCount).toBe(1)
  })

  it('ignores results for unknown call ids', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    const unchanged = applyTurnEvent(summary, toolResult(8, 'ghost'))
    expect(unchanged).toBe(summary)
  })

  it('pairs only the matching call and leaves other records untouched', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    summary = applyTurnEvent(summary, toolCall(3, 'c2', 'read_file', 1, 1))
    summary = applyTurnEvent(summary, toolResult(12, 'c1'))
    // map 对不匹配的 c2 走 `: c` 原样保留分支
    expect(summary.calls[0]?.elapsedMs).toBe(10)
    expect(summary.calls[1]?.elapsedMs).toBeUndefined()
    expect(summary.totalElapsedMs).toBe(10)
  })

  it('ignores unrelated event types (default branch returns state unchanged)', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    const unchanged = applyTurnEvent(
      summary,
      { seq: 5, time: 1005, type: 'assistant/message', data: { content: [] } } as SessionEvent,
    )
    expect(unchanged).toBe(summary)
  })
})

describe('applyTurnEvent — turn boundary', () => {
  it('resets the summary when a new turn opens', () => {
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    summary = applyTurnEvent(summary, turnStart(10, 2))
    expect(summary.turn).toBe(2)
    expect(summary.toolCount).toBe(0)
    expect(summary.calls).toEqual([])
  })
})

describe('summarizeTurn', () => {
  it('replays only events of the requested turn', () => {
    const events: SessionEvent[] = [
      turnStart(1, 1),
      toolCall(2, 'c1', 'read_file', 1, 0),
      toolResult(9, 'c1'),
      turnStart(10, 2),
      toolCall(11, 'c2', 'bash', 2, 0),
      toolResult(20, 'c2'),
    ]
    const summary = summarizeTurn(1, events)
    expect(summary.turn).toBe(1)
    expect(summary.toolCount).toBe(1)
    expect(summary.byFamily.file).toBe(1)
    expect(summary.totalElapsedMs).toBe(7)
  })

  it('skips tool/result events from other turns', () => {
    const events: SessionEvent[] = [
      turnStart(1, 1),
      toolCall(2, 'c1', 'read_file', 1, 0),
      toolResult(9, 'c1'),
      turnStart(10, 2),
      toolCall(11, 'c2', 'bash', 2, 0),
      toolResult(20, 'c2', undefined, 2),
    ]
    const summary = summarizeTurn(1, events)
    expect(summary.turn).toBe(1)
    expect(summary.toolCount).toBe(1)
    expect(summary.calls).toHaveLength(1)
  })
})

describe('formatTurnSummary', () => {
  it('formats an empty summary', () => {
    expect(formatTurnSummary(emptyTurnSummary(1))).toBe('0 tools')
  })

  it('formats count, elapsed and family distribution', () => {
    // SessionEvent.time 是 epoch 毫秒：c1 耗时 1200ms（1002 → 2202）→ 1.2s
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'read_file', 1, 0))
    summary = applyTurnEvent(summary, toolResult(1202, 'c1'))
    summary = applyTurnEvent(summary, toolCall(1215, 'c2', 'edit_file', 1, 1))
    expect(formatTurnSummary(summary)).toBe('2 tools · 1.2s · file×2')
  })

  it('appends failed count when present', () => {
    // c1 耗时 500ms（1002 → 1502）→ 0.5s
    let summary = emptyTurnSummary(1)
    summary = applyTurnEvent(summary, toolCall(2, 'c1', 'bash', 1, 0))
    summary = applyTurnEvent(summary, toolResult(502, 'c1', { name: 'X', code: 'X' }))
    expect(formatTurnSummary(summary)).toBe('1 tool · 0.5s · shell×1 · 1 failed')
  })
})
