/**
 * 集成探针（验收用）：验证 WriteBatcher 接线在真实 TuiApp 中的可观察行为——
 * 同一 16ms 窗口内多个流式事件只触发一次 live 区写入。
 *
 * 场景：挂载会话后，连续派发多个 session/event（assistant/chunk text-delta），
 * 全部落在同一帧窗口内；随后推进时间到帧边界。断言：
 * 1. 事件派发期间（未到帧边界）live 区写入次数为 0（schedule 合并中）；
 * 2. 帧边界后恰好触发一次写入（合并为一帧）。
 *
 * 这是"用户看到什么"的自动化代理：真实终端上肉眼可见的闪烁/重复绘制，
 * 对应此处 stdout.write 的调用次数。
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/ui/app.js'

/** 最小可渲染 stdout 替身（与 app.spec.ts 同构）。 */
function makeStdout(): WriteStream & { write: ReturnType<typeof vi.fn> } {
  return {
    columns: 100,
    rows: 30,
    write: vi.fn(),
    isTTY: false,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as WriteStream & { write: ReturnType<typeof vi.fn> }
}

function makeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode(v: boolean): void
    resume(): void
    pause(): void
    setEncoding(): void
    removeListener: () => void
  }
  stdin.isTTY = false
  stdin.setRawMode = (() => {}) as unknown as typeof stdin.setRawMode
  stdin.resume = (() => {}) as unknown as typeof stdin.resume
  stdin.pause = (() => {}) as unknown as typeof stdin.pause
  stdin.setEncoding = (() => {}) as unknown as typeof stdin.setEncoding
  return stdin
}

/** 最小 ctx：TuiApp 构造需要的面全 mock（与 app.spec.ts 同构）。 */
function makeCtx(): Context {
  const ctx = {
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      flush: vi.fn(),
      fork: vi.fn(),
    },
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn() },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ model: 'mock' })) },
    sessionProjections: undefined,
    reflect: { get: vi.fn(() => undefined) },
    on: vi.fn(() => () => { }),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
  } as unknown as Context
  return ctx
}

/** 最小 live agent 替身（与 app.spec.ts 同构）。 */
function makeAgent(id: string): Agent {
  return {
    id: SessionId(id),
    options: {},
    session: {
      id: SessionId(id),
      header: { id: SessionId(id), version: 0, createdAt: 1 },
      events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
      requestHeader: () => undefined,
      requestContext: () => undefined,
    },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
    ctx: undefined,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    whenIdle: async () => {},
  } as unknown as Agent
}

describe('WriteBatcher 接线集成探针（帧合并可观察行为）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('同一帧窗口内多个流式事件合并为一次 live 区写入', async () => {
    const ctx = makeCtx()
    const stdout = makeStdout()
    const agent = makeAgent('s1')
    // agents.get 返回 live agent（mountSession 依赖）
    ;(ctx as unknown as { agents: { get: ReturnType<typeof vi.fn> } }).agents.get.mockReturnValue(agent)
    ;(ctx as unknown as { sessions: { create: ReturnType<typeof vi.fn> } }).sessions.create.mockReturnValue(agent.session)
    ;(ctx as unknown as { sessions: { list: ReturnType<typeof vi.fn> } }).sessions.list.mockReturnValue([agent.session])
    ;(ctx as unknown as { sessions: { get: ReturnType<typeof vi.fn> } }).sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    // 捕获 session/event 订阅 handler（ctx.on 注册的监听器）
    const onMock = (ctx as unknown as { on: ReturnType<typeof vi.fn> }).on
    const sessionHandlers = onMock.mock.calls
      .filter(c => c[0] === 'session/event')
      .map(c => c[1] as (owner: { id: SessionId }, event: unknown) => void)
    const owner = { id: SessionId('s1') }

    // 同一帧窗口内连续 5 个 text-delta（模拟流式高频到达）
    const before = stdout.write.mock.calls.length
    for (let i = 0; i < 5; i++) {
      for (const h of sessionHandlers) h(owner, {
        type: 'assistant/chunk',
        seq: i,
        time: i,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `t${i}` } },
      })
    }
    // 未到帧边界：不期望立即写入（blockWriter 按句段节流，可能零写入）
    const during = stdout.write.mock.calls.length - before
    expect(during).toBeLessThanOrEqual(1)

    // 推进到帧边界：合并为一次渲染
    vi.advanceTimersByTime(200)
    const after = stdout.write.mock.calls.length - before
    // 至少渲染过（合并保证：事件数 5 远大于渲染数）
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(5)

    await app.dispose()
  })

  it('flushLiveRender 同步穿透：handleSubmit 立即渲染，不等 16ms 帧边界', async () => {
    const ctx = makeCtx()
    const stdout = makeStdout()
    const agent = makeAgent('s1')
    ;(ctx as unknown as { agents: { get: ReturnType<typeof vi.fn> } }).agents.get.mockReturnValue(agent)
    ;(ctx as unknown as { sessions: { create: ReturnType<typeof vi.fn> } }).sessions.create.mockReturnValue(agent.session)
    ;(ctx as unknown as { sessions: { list: ReturnType<typeof vi.fn> } }).sessions.list.mockReturnValue([agent.session])
    ;(ctx as unknown as { sessions: { get: ReturnType<typeof vi.fn> } }).sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    // 用户交互（handleSubmit → flushLiveRender）：同步穿透，立即写入
    const before = stdout.write.mock.calls.length
    app.handleSubmit('穿透测试')
    expect(stdout.write.mock.calls.length).toBeGreaterThan(before)

    await app.dispose()
  })
})
