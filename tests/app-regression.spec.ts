/**
 * TuiApp 生命周期缺陷回归测试（Wave 1 顺手修：跨会话残留 + dispose 泄漏）。
 *
 * 1. pendingApproval 跨会话残留：attach 会话 A 挂起审批 → 切会话 B →
 *    旧审批必须被 cancelled 结算（fail-closed），不能残留阻塞新会话请求。
 * 2. interactionDisposer 泄漏：attach 注册 provider 返回的 disposer 必须
 *    在 dispose 释放（否则 userInteraction 服务侧再次 registerProvider
 *    会抛 DUPLICATE_PROVIDER）。
 *
 * 黑盒：与 app.spec.ts 同构的 makeCtx/makeAgent 替身（独立文件，保持
 * app.spec.ts 黑盒面纯净）。
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForStdout } from './helpers/wait-for.js'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/ui/app.js'

/** 最小可渲染 stdout 替身（与 app.spec.ts makeStdout 同构）。 */
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

/** 最小 stdin 替身（与 app.spec.ts makeStdin 同构）。 */
function makeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode(v: boolean): void
    resume(): void
    setEncoding(enc: string): void
  }
  stdin.isTTY = false
  stdin.setRawMode = vi.fn()
  stdin.resume = vi.fn()
  stdin.setEncoding = vi.fn()
  stdin.pause = vi.fn()
  return stdin
}

/** 带记录字段的 ctx 替身（与 app.spec.ts makeCtx 同构）。 */
function makeCtx(): Context & {
  sessions: {
    create: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
    fork: ReturnType<typeof vi.fn>
  }
  agents: { create: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }
  agentDefaultModel: { currentSelection: ReturnType<typeof vi.fn> }
  reflect: { get: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  provide: ReturnType<typeof vi.fn>
} {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      flush: vi.fn(async () => true),
      fork: vi.fn(),
    },
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn() },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'mock', model: 'mock' })) },
    reflect: { get: vi.fn(() => undefined) },
    on: vi.fn(() => vi.fn(() => true)),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
  } as unknown as Context & {
    sessions: {
      create: ReturnType<typeof vi.fn>
      get: ReturnType<typeof vi.fn>
      list: ReturnType<typeof vi.fn>
      flush: ReturnType<typeof vi.fn>
      fork: ReturnType<typeof vi.fn>
    }
    agents: { create: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }
    agentDefaultModel: { currentSelection: ReturnType<typeof vi.fn> }
    reflect: { get: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    provide: ReturnType<typeof vi.fn>
  }
}

/** 最小 live agent 替身（与 app.spec.ts makeAgent 同构）。 */
function makeAgent(id: string): Agent {
  return {
    id: SessionId(id),
    options: {},
    session: {
      id: SessionId(id),
      header: { id: SessionId(id), version: 0, createdAt: 1 },
      events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
      requestHeader: vi.fn(() => undefined),
      requestContext: vi.fn(() => undefined),
    },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
    ctx: undefined,
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => { }),
  } as unknown as Agent
}

/** 最小 handle 替身（与 app.spec.ts makeHandle 同构）。 */
function makeHandle(agent: Agent): AgentHandle {
  return { agent, dispose: vi.fn(async () => { }) }
}

/** 从 ctx.on.mock.calls 抽取 approval/request handler。 */
function approvalHandler(ctx: ReturnType<typeof makeCtx>) {
  const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
    | ((req: unknown, next: () => Promise<string>) => Promise<string>)
    | undefined
  if (handler === undefined) throw new Error('approval/request handler not registered')
  return handler
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TuiApp 生命周期缺陷回归', () => {
  it('切会话后挂起的旧审批被 cancelled 结算（跨会话残留修复）', async () => {
    const ctx = makeCtx()
    const agentA = makeAgent('residue-A')
    ctx.agents.create.mockResolvedValue(makeHandle(agentA))
    ctx.sessions.get.mockReturnValue(agentA.session)
    const agentB = makeAgent('residue-B')
    ctx.agents.resume.mockResolvedValue(makeHandle(agentB))
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    const handler = approvalHandler(ctx)
    const outcome = handler(
      { agent: { session: { id: app.sessionId ?? agentA.session.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    // 挂起提示上屏是异步渲染：轮询等待（flaky 加固）
    await waitForStdout(stdout, '允许执行 bash')
    const written = stdout.write.mock.calls.map(c => String(c[0])).join('')
    expect(written).toContain('允许执行 bash')

    // 切到会话 B → 旧审批必须被 cancelled 结算（fail-closed）
    ctx.sessions.get.mockReturnValue(agentB.session)
    await app.switchSession(agentB.session.id)
    await expect(outcome).resolves.toBe('cancelled')
    await app.dispose()
  })

  it('dispose 释放 userQuestions answerer 的 disposer（泄漏修复）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('disposer-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    // rc.1 wire：answerer 经 ctx.on('user-questions/request') 注册，disposer 由
    // ctx.on 返回。取该次注册对应的返回值，断言 dispose 时释放。
    const on = ctx.on as unknown as ReturnType<typeof vi.fn>
    const idx = on.mock.calls.findIndex((c: unknown[]) => c[0] === 'user-questions/request')
    expect(idx).toBeGreaterThanOrEqual(0)
    const disposer = on.mock.results[idx]?.value as (() => void) | undefined
    expect(disposer).toBeTypeOf('function')
    expect(disposer).not.toHaveBeenCalled()
    await app.dispose()
    expect(disposer).toHaveBeenCalledTimes(1)
  })
})
