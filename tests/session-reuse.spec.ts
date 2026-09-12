/**
 * session-reuse.spec.ts — 启动复用适配层（adapter/sessions.ts 新增面）。
 *
 * 覆盖：最近空会话查找（标题折叠「新对话」= 无内容；读取失败跳过；走
 * open(id,'read') detached 读而非 live 挂载——避免给该身份建档，随后同 id create 会被
 * 协调器判 "persisted state already owns this identity"）、跨 cwd 复用的旧
 * artifact 清理（locate + rm；无 locate/list 失败/删除失败时返回 false 由
 * 调用方退回全新 id）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  clearEmptySessionArtifact,
  findMostRecentEmptySession,
  REUSE_SCAN_LIMIT,
  type SessionSummary,
} from '../src/adapter/sessions.js'

// adapter 与测试共用同一 mocked rm：断言删除目标目录。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn() }
})

const rmMock = vi.mocked(rm)

beforeEach(() => {
  rmMock.mockReset()
  rmMock.mockResolvedValue(undefined)
})

function userMessage(seq: number): SessionEvent {
  return {
    seq,
    time: seq,
    type: 'user/message',
    data: { id: `m-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  } as unknown as SessionEvent
}

function header(id: string, createdAt: number, cwd?: string): SessionHeader {
  return { id: SessionId(id), version: 3, createdAt, isSeeded: false, ...(cwd === undefined ? {} : { cwd }) }
}

interface FakePersistence {
  /** 0.1.5 契约：快照包装（{header}）列表。 */
  list: ReturnType<typeof vi.fn>
  /** 复用扫描用的 detached 读句柄（无则跳过候选——live 挂载会污染身份）。 */
  open?: ReturnType<typeof vi.fn>
  locate?: ReturnType<typeof vi.fn>
}

/** 0.1.5 读句柄 mock：read(offset) 按会话 id 给事件，close 幂等。 */
function readHandle(eventsFor: (id: SessionId) => SessionEvent[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (id: SessionId) => ({
    read: vi.fn(async () => ({ events: eventsFor(id) })),
    close: vi.fn(async () => { }),
  }))
}

function makeCtx(persistence?: FakePersistence): Context {
  const ctx = {
    sessions: {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
    },
    reflect: {
      get: vi.fn((name: string) => (name === 'sessionPersistence' ? persistence : undefined)),
    },
    get: vi.fn(() => undefined),
  }
  return ctx as unknown as Context
}

function summaryOf(h: SessionHeader): SessionSummary {
  return {
    id: h.id,
    version: h.version,
    createdAt: h.createdAt,
    cwd: h.cwd,
    parentSession: undefined,
    agentPreset: undefined,
  }
}

describe('findMostRecentEmptySession', () => {
  it('返回最近（createdAt 降序首个）无聊天内容的会话', async () => {
    const persistence = {
      list: vi.fn(async () => [
        header('session-newest', 30, '/a'),
        header('session-empty', 20, '/a'),
        header('session-old-content', 10, '/a'),
      ].map(h => ({ header: h }))),
      open: readHandle((id) => {
        if (id === 'session-newest') return [userMessage(1)]
        if (id === 'session-empty') return []
        return [userMessage(1)]
      }),
    }
    const ctx = makeCtx(persistence)
    const found = await findMostRecentEmptySession(ctx)
    expect(found?.id).toBe('session-empty')
    expect(persistence.open).toHaveBeenCalledTimes(2) // 到第一个空会话即停
  })

  it('最新的空会话被最新非空会话挡住时仍能找到更早的空会话', async () => {
    const persistence = {
      list: vi.fn(async () => [
        header('session-busy', 30, '/a'),
        header('session-empty', 20, '/a'),
      ].map(h => ({ header: h }))),
      open: readHandle((id) => {
        if (id === 'session-busy') return [userMessage(1)]
        return []
      }),
    }
    const found = await findMostRecentEmptySession(makeCtx(persistence))
    expect(found?.id).toBe('session-empty')
  })

  it('读取失败（corrupt）的会话跳过，不误判为无内容', async () => {
    const persistence = {
      list: vi.fn(async () => [header('session-corrupt', 30, '/a'), header('session-empty', 20, '/a')].map(h => ({ header: h }))),
      open: vi.fn(async (id: SessionId) => {
        if (id === 'session-corrupt') throw new Error('corrupt artifact')
        return { read: vi.fn(async () => ({ events: [] })), close: vi.fn(async () => { }) }
      }),
    }
    const found = await findMostRecentEmptySession(makeCtx(persistence))
    expect(found?.id).toBe('session-empty')
  })

  it('后端无 open（detached 读）→ 候选跳过（live 挂载会污染身份，不冒险）', async () => {
    const persistence = {
      list: vi.fn(async () => [header('session-empty', 20, '/a')]),
    }
    expect(await findMostRecentEmptySession(makeCtx(persistence))).toBeUndefined()
  })

  it('无候选（全部有内容 / 列表为空）返回 undefined', async () => {
    const busy = {
      list: vi.fn(async () => [header('session-busy', 30, '/a')]),
      readFrom: vi.fn(async () => ({ events: [userMessage(1)] })),
    }
    expect(await findMostRecentEmptySession(makeCtx(busy))).toBeUndefined()
    expect(await findMostRecentEmptySession(makeCtx())).toBeUndefined() // 无 persistence → live store 空
  })

  it('只扫描最近 REUSE_SCAN_LIMIT 个会话（更早的空会话不触发全量读取）', async () => {
    const headers = Array.from({ length: REUSE_SCAN_LIMIT + 1 }, (_, i) =>
      header(`session-recent-${i}`, 100 - i, '/a'))
    headers.push(header('session-old-empty', 1, '/a'))
    const persistence = {
      list: vi.fn(async () => headers.map(h => ({ header: h }))),
      open: readHandle(() => [userMessage(1)]), // 最近 N 个全有内容
    }
    const found = await findMostRecentEmptySession(makeCtx(persistence))
    expect(found).toBeUndefined()
    expect(persistence.open).toHaveBeenCalledTimes(REUSE_SCAN_LIMIT)
  })
})

describe('clearEmptySessionArtifact', () => {
  it('旧 cwd 下存在物化记录 → locate 并删除 artifact 目录', async () => {
    const old = header('session-empty', 10, '/old/dir')
    const persistence = {
      list: vi.fn(async () => [old]),
      locate: vi.fn(() => ({ path: '/root/--old-dir--/session-empty/session.jsonl' })),
    }
    const ok = await clearEmptySessionArtifact(makeCtx(persistence), summaryOf(old))
    expect(ok).toBe(true)
    expect(persistence.locate).toHaveBeenCalledWith(old)
    expect(rmMock).toHaveBeenCalledWith('/root/--old-dir--/session-empty', { recursive: true, force: true })
  })

  it('无物化记录（惰性后端）→ 视为已清理（true）', async () => {
    const persistence = {
      list: vi.fn(async () => []),
      locate: vi.fn(),
    }
    const ok = await clearEmptySessionArtifact(makeCtx(persistence), summaryOf(header('session-empty', 10, '/old/dir')))
    expect(ok).toBe(true)
    expect(persistence.locate).not.toHaveBeenCalled()
  })

  it('list 失败 → false（无法确认状态，不冒险复用）', async () => {
    const persistence = {
      list: vi.fn(async () => { throw new Error('backend down') }),
      locate: vi.fn(),
    }
    const ok = await clearEmptySessionArtifact(makeCtx(persistence), summaryOf(header('session-empty', 10, '/old/dir')))
    expect(ok).toBe(false)
  })

  it('无 persistence / 无 locate / locate undefined / 删除失败 → false', async () => {
    expect(await clearEmptySessionArtifact(makeCtx(), summaryOf(header('s1', 1, '/old')))).toBe(false)

    const noLocate = { list: vi.fn(async () => [header('s1', 1, '/old')]) }
    expect(await clearEmptySessionArtifact(makeCtx(noLocate), summaryOf(header('s1', 1, '/old')))).toBe(false)

    const locateUndefined = {
      list: vi.fn(async () => [header('s1', 1, '/old')]),
      locate: vi.fn(() => undefined),
    }
    expect(await clearEmptySessionArtifact(makeCtx(locateUndefined), summaryOf(header('s1', 1, '/old')))).toBe(false)

    rmMock.mockRejectedValueOnce(new Error('EACCES'))
    const rmFail = {
      list: vi.fn(async () => [header('s1', 1, '/old')]),
      locate: vi.fn(() => ({ path: '/root/--old--/s1/session.jsonl' })),
    }
    expect(await clearEmptySessionArtifact(makeCtx(rmFail), summaryOf(header('s1', 1, '/old')))).toBe(false)
  })
})
