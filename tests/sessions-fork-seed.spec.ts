import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { forkAgentSpec, liveForkSeed } from '../src/adapter/sessions.js'

function ev(type: string): SessionEvent {
  return { seq: 0, time: 0, type } as SessionEvent
}

describe('liveForkSeed', () => {
  it('空日志 → 空 seed', () => {
    expect(liveForkSeed([])).toEqual([])
  })

  it('无 open turn → 原样返回（含 turn/end 之后的标题事件）', () => {
    const events = [ev('turn/start'), ev('user/message'), ev('turn/end'), ev('session/title')]
    expect(liveForkSeed(events)).toBe(events)
  })

  it('open turn → 抛「回合未结束」', () => {
    expect(() => liveForkSeed([ev('turn/start'), ev('user/message')])).toThrow('回合未结束')
  })
})

describe('forkAgentSpec', () => {
  it('拼 seed + 血缘 meta；cwd 缺失回落 fallback', () => {
    const log = [ev('turn/start'), ev('turn/end')]
    const parent = {
      id: 'session-parent' as SessionId,
      header: { id: 'session-parent', version: 0, createdAt: 1, isSeeded: false },
      events: log,
      snapshotEvents: () => log,
    } as unknown as Session
    const spec = forkAgentSpec(parent, '/ws')
    expect(spec.seed).toHaveLength(2)
    // rc.1 wire：seedLength 变为 meta.isSeeded 标记 + 顶层 inheritedEventCount
    expect(spec.meta).toEqual({
      cwd: '/ws',
      parentSession: 'session-parent',
      isSeeded: true,
    })
    expect(spec.inheritedEventCount).toBe(2)
  })
})
