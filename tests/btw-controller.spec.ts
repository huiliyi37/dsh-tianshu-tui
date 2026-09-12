/**
 * BtwController — /btw 侧问状态机单测（P1）。
 *
 * mock ctx 模式对齐 app.spec.ts（agents.create/sessions.get/on 可注入）；
 * 事件流手动触发：捕获 ctx.on('session/event') 的 handler，按 btw session id
 * 注入 assistant/chunk + turn/end，验证状态机与收尾（dispose/折叠回调）。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/tests/btw-controller
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { BtwController, completedTurnSeed } from '../src/controllers/btw-controller.js'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

/** 会话事件工厂（seq 连续从 0 起）。 */
function event(seq: number, type: string, extra: Record<string, unknown> = {}): SessionEvent {
  return { seq, type, data: extra } as unknown as SessionEvent
}

/** 构造一个 mock ctx：捕获 session/event handler，agents.create 可配置。 */
function makeCtx(overrides: {
  events?: SessionEvent[]
  createHandle?: () => AgentHandle
  header?: { cwd?: string }
} = {}): {
  ctx: Context & {
    agents: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }
    sessions: { get: ReturnType<typeof vi.fn> }
    agentDefaultModel: { currentSelection: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
    reflect: { get: ReturnType<typeof vi.fn> }
  }
  /** 最近一次 session/event 注册的 handler（按需手动触发）。 */
  emit: (ownerId: SessionId, e: SessionEvent) => void
  /** on 返回的 disposer 台账（断言订阅释放）。 */
  released: { feed: boolean }
  handle: AgentHandle & { agent: { followup: ReturnType<typeof vi.fn> }; dispose: ReturnType<typeof vi.fn> }
} {
  let handler: ((owner: { id: SessionId }, e: SessionEvent) => void) | null = null
  let feedReleased = false
  const handle = {
    agent: { followup: vi.fn() },
    dispose: vi.fn(async () => {}),
  } as unknown as AgentHandle & { agent: { followup: ReturnType<typeof vi.fn> }; dispose: ReturnType<typeof vi.fn> }
  const ctx = {
    agents: {
      create: vi.fn(async () => overrides.createHandle?.() ?? handle),
      get: vi.fn(),
    },
    sessions: {
      get: vi.fn(() => ({
        events: overrides.events ?? [],
        snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
        header: overrides.header ?? { id: ACTIVE, version: 0, createdAt: 1, isSeeded: false },
      })),
    },
    agentDefaultModel: {
      currentSelection: vi.fn(() => ({ provider: 'mock', model: 'mock' })),
    },
    reflect: { get: vi.fn(() => undefined) },
    on: vi.fn((eventName: string, fn: (owner: { id: SessionId }, e: SessionEvent) => void) => {
      if (eventName !== 'session/event') throw new Error(`unexpected event: ${eventName}`)
      handler = fn
      return () => { feedReleased = true }
    }),
  } as unknown as Context & {
    agents: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }
    sessions: { get: ReturnType<typeof vi.fn> }
    agentDefaultModel: { currentSelection: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
    reflect: { get: ReturnType<typeof vi.fn> }
  }
  return {
    ctx,
    emit: (ownerId, e) => { handler?.({ id: ownerId }, e) },
    released: { get feed() { return feedReleased } },
    handle,
  }
}

const ACTIVE = SessionId('session-active')

describe('completedTurnSeed', () => {
  it('截取到最后一个完整 turn（turn/end），排除 open turn 之后的事件', () => {
    const events = [
      event(0, 'user/message'),
      event(1, 'turn/start'),
      event(2, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: 'a' } }] }),
      event(3, 'turn/end', { reason: { kind: 'stop' } }),
      event(4, 'user/message'),
      event(5, 'turn/start'),
      event(6, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: 'b' } }] }),
    ]
    const seed = completedTurnSeed(events)
    expect(seed).toHaveLength(4)
    expect(seed.map(e => e.seq)).toEqual([0, 1, 2, 3])
  })

  it('无完整 turn 时返回空 seed（btw 从零上下文开始）', () => {
    const events = [event(0, 'user/message'), event(1, 'turn/start')]
    expect(completedTurnSeed(events)).toEqual([])
    expect(completedTurnSeed([])).toEqual([])
  })

  it('agent 空闲（最后事件 turn/end）时全量前缀', () => {
    const events = [
      event(0, 'user/message'),
      event(1, 'turn/start'),
      event(2, 'turn/end', { reason: { kind: 'stop' } }),
    ]
    expect(completedTurnSeed(events)).toHaveLength(3)
  })
})

describe('BtwController', () => {
  it('ask 创建 btw agent（seed 正确）并 followup 侧问', async () => {
    const events = [
      event(0, 'user/message'),
      event(1, 'turn/start'),
      event(2, 'turn/end', { reason: { kind: 'stop' } }),
    ]
    const { ctx, handle } = makeCtx({ events })
    const controller = new BtwController({
      ctx,
      activeSessionId: () => ACTIVE,
      timeoutMs: 1000,
    })
    await controller.ask('这个函数的时间复杂度是多少？')

    expect(ctx.agents.create).toHaveBeenCalledTimes(1)
    const createArgs = ctx.agents.create.mock.calls[0]?.[0] as
      | { seed: readonly string[]; sessionId: SessionId; agentOptions: { provider: string; model: string } }
      | undefined
    expect(createArgs?.seed).toHaveLength(3)
    expect(createArgs?.sessionId).not.toBe(ACTIVE)
    expect(createArgs?.agentOptions).toEqual({ provider: 'mock', model: 'mock' })
    expect(handle.agent.followup).toHaveBeenCalledTimes(1)
    // followup 收到的是 identified user message（send 适配层契约）。
    const message = handle.agent.followup.mock.calls[0]?.[0] as
      | { content: Array<{ text?: string }> }
      | undefined
    expect(message?.content[0]?.text).toBe('这个函数的时间复杂度是多少？')
    expect(controller.peek()).toEqual({ status: 'loading', question: '这个函数的时间复杂度是多少？' })
    controller.dispose()
  })

  it('ask setup 对父 agent composeFrom', async () => {
    const events = [
      event(0, 'user/message'),
      event(1, 'turn/start'),
      event(2, 'turn/end', { reason: { kind: 'stop' } }),
    ]
    const composeFrom = vi.fn(() => 'standard')
    const parentCtx = { parent: 1 }
    const { ctx, handle } = makeCtx({ events })
    ctx.agents.get.mockReturnValue({ ctx: parentCtx })
    ctx.reflect.get.mockImplementation((name: string) => (
      name === 'agentPresets' ? { mount: vi.fn(), composeFrom } : undefined
    ))
    ctx.agents.create.mockImplementation(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
      await opts.setup?.({ child: 1 })
      return handle
    })
    const controller = new BtwController({
      ctx,
      activeSessionId: () => ACTIVE,
      timeoutMs: 1000,
    })
    await controller.ask('q')
    expect(composeFrom).toHaveBeenCalledWith({ child: 1 }, parentCtx)
    controller.dispose()
  })

  it('ask 把父会话 cwd 与 parentSession/isSeeded+inheritedEventCount 写入 create', async () => {
    const events = [
      event(0, 'user/message'),
      event(1, 'turn/start'),
      event(2, 'turn/end', { reason: { kind: 'stop' } }),
    ]
    const { ctx } = makeCtx({ events, header: { cwd: '/workspace' } })
    const controller = new BtwController({
      ctx,
      activeSessionId: () => ACTIVE,
      timeoutMs: 1000,
    })
    await controller.ask('q')
    const createArgs = ctx.agents.create.mock.calls[0]?.[0] as
      | { meta?: { cwd?: string; parentSession?: SessionId; isSeeded?: boolean }; inheritedEventCount?: number; seed: readonly unknown[] }
      | undefined
    expect(createArgs?.meta).toEqual({
      cwd: '/workspace',
      parentSession: ACTIVE,
      isSeeded: true,
    })
    expect(createArgs?.inheritedEventCount).toBe(3)
    controller.dispose()
  })

  it('ask 父会话无 cwd 时回退 process.cwd()', async () => {
    const { ctx } = makeCtx()
    const controller = new BtwController({
      ctx,
      activeSessionId: () => ACTIVE,
      timeoutMs: 1000,
    })
    await controller.ask('q')
    const createArgs = ctx.agents.create.mock.calls[0]?.[0] as
      | { meta?: { cwd?: string; parentSession?: SessionId; isSeeded?: boolean }; inheritedEventCount?: number }
      | undefined
    expect(createArgs?.meta).toEqual({
      cwd: process.cwd(),
      parentSession: ACTIVE,
      isSeeded: false,
    })
    expect(createArgs?.inheritedEventCount).toBe(0)
    controller.dispose()
  })

  it('答案流：text-delta 收集，turn/end 定稿为 done', async () => {
    const { ctx, emit, handle } = makeCtx()
    const onChanged = vi.fn()
    const controller = new BtwController({
      ctx,
      activeSessionId: () => ACTIVE,
      onChanged,
      timeoutMs: 1000,
    })
    await controller.ask('q')
    const btwId = (ctx.agents.create.mock.calls[0]![0] as { sessionId: SessionId }).sessionId

    emit(ACTIVE, event(0, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '答' } }] }))
    emit(btwId, event(1, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '案' } }] }))
    expect(controller.peek()?.status).toBe('loading')
    emit(btwId, event(2, 'turn/end', { reason: { kind: 'stop' } }))

    expect(controller.peek()).toEqual({ status: 'done', question: 'q', answer: '案' })
    expect(onChanged).toHaveBeenCalled()
    // 定稿后订阅释放 + handle dispose（turn 已结束，收尾安全）。
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('非 btw session 的事件不进入答案流（按 id 过滤）', async () => {
    const { ctx, emit } = makeCtx()
    const controller = new BtwController({ ctx, activeSessionId: () => ACTIVE, timeoutMs: 1000 })
    await controller.ask('q')
    const btwId = (ctx.agents.create.mock.calls[0]![0] as { sessionId: SessionId }).sessionId
    emit(ACTIVE, event(0, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '主会话' } }] }))
    emit(btwId, event(1, 'turn/end', { reason: { kind: 'stop' } }))
    expect(controller.peek()).toEqual({ status: 'done', question: 'q', answer: '' })
    controller.dispose()
  })

  it('dismiss（done）：答案折叠回调 + 状态清除', async () => {
    const { ctx, emit } = makeCtx()
    const onAnswer = vi.fn()
    const controller = new BtwController({ ctx, activeSessionId: () => ACTIVE, onAnswer, timeoutMs: 1000 })
    await controller.ask('q')
    const btwId = (ctx.agents.create.mock.calls[0]![0] as { sessionId: SessionId }).sessionId
    emit(btwId, event(0, 'assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '答案' } }] }))
    emit(btwId, event(1, 'turn/end', { reason: { kind: 'stop' } }))

    controller.dismiss()
    expect(onAnswer).toHaveBeenCalledWith({ question: 'q', answer: '答案' })
    expect(controller.peek()).toBeNull()
    expect(controller.isActive).toBe(false)
  })

  it('dismiss（loading）：取消销毁 btw agent，不折叠答案', async () => {
    const { ctx, handle, released } = makeCtx()
    const onAnswer = vi.fn()
    const controller = new BtwController({ ctx, activeSessionId: () => ACTIVE, onAnswer, timeoutMs: 1000 })
    await controller.ask('q')
    controller.dismiss()
    expect(onAnswer).not.toHaveBeenCalled()
    expect(controller.peek()).toBeNull()
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(released.feed).toBe(true)
  })

  it('重叠保护：ask 挂起时再次 ask 静默忽略', async () => {
    const { ctx } = makeCtx()
    const controller = new BtwController({ ctx, activeSessionId: () => ACTIVE, timeoutMs: 1000 })
    await controller.ask('q1')
    await controller.ask('q2')
    expect(ctx.agents.create).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('超时：loading 超时置 error（agent 已销毁）', async () => {
    const { ctx, handle, released } = makeCtx()
    const controller = new BtwController({ ctx, activeSessionId: () => ACTIVE, timeoutMs: 5 })
    await controller.ask('q')
    await vi.waitFor(() => {
      expect(controller.peek()?.status).toBe('error')
    }, { timeout: 500 })
    expect(controller.peek()?.error).toContain('超时')
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(released.feed).toBe(true)
    controller.dispose()
  })

  it('无活跃会话时 ask 抛错（命令层回显）', async () => {
    const { ctx } = makeCtx()
    const controller = new BtwController({ ctx, activeSessionId: () => null, timeoutMs: 1000 })
    await expect(controller.ask('q')).rejects.toThrow('无活跃会话')
    expect(controller.isActive).toBe(false)
  })

  it('dispose：未决 loading 直接销毁 agent，done 不折叠', async () => {
    const { ctx, emit, handle } = makeCtx()
    const onAnswer = vi.fn()
    const controller = new BtwController({ ctx, activeSessionId: () => ACTIVE, onAnswer, timeoutMs: 1000 })
    await controller.ask('q')
    const btwId = (ctx.agents.create.mock.calls[0]![0] as { sessionId: SessionId }).sessionId
    emit(btwId, event(0, 'turn/end', { reason: { kind: 'stop' } }))
    controller.dispose()
    expect(handle.dispose).toHaveBeenCalledTimes(1)
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
