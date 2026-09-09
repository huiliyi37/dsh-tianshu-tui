/**
 * SessionManager 单测（P3 side conversation 快照层）。
 *
 * 快照从 live store 派生：mock ctx.sessions.list() + ctx.agents.get() 注入，
 * 验证 list() 派生（id/status/messageCount）与 statusOf() 查询。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/tests/session-manager
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionManager } from '../src/controllers/session-manager.js'

/** 最小 live session 替身（events 长度可配；rc.1 wire 走 snapshotEvents）。 */
function makeSession(id: string, eventCount = 0): { id: SessionId; events: unknown[]; snapshotEvents(): unknown[] } {
  const events = new Array(eventCount)
  return { id: SessionId(id), events, snapshotEvents: () => events }
}

function makeCtx(opts: {
  sessions?: Array<{ id: SessionId; events: unknown[] }>
  agents?: Map<string, { status: 'idle' | 'running' }>
} = {}): Context {
  const sessions = opts.sessions ?? []
  const agents = opts.agents ?? new Map()
  return {
    sessions: {
      list: vi.fn(() => sessions),
    },
    agents: {
      get: vi.fn((id: SessionId) => agents.get(String(id)) as { status: 'idle' | 'running' } | undefined),
    },
  } as unknown as Context
}

describe('SessionManager', () => {
  it('list() 从 live store 派生快照（id/status/messageCount）', () => {
    const sessions = [makeSession('s1', 3), makeSession('s2', 0)]
    const ctx = makeCtx({
      sessions,
      agents: new Map([['s1', { status: 'running' }], ['s2', { status: 'idle' }]]),
    })
    const manager = new SessionManager(ctx)
    const snapshots = manager.list()
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toEqual({ id: SessionId('s1'), status: 'running', messageCount: 3 })
    expect(snapshots[1]).toEqual({ id: SessionId('s2'), status: 'idle', messageCount: 0 })
  })

  it('list() 空 store 返回空数组', () => {
    const manager = new SessionManager(makeCtx())
    expect(manager.list()).toEqual([])
  })

  it('statusOf()：有 live agent 返回其状态；无 agent 视为 idle', () => {
    const ctx = makeCtx({ agents: new Map([['live', { status: 'running' }]]) })
    const manager = new SessionManager(ctx)
    expect(manager.statusOf(SessionId('live'))).toBe('running')
    expect(manager.statusOf(SessionId('gone'))).toBe('idle')
  })
})
