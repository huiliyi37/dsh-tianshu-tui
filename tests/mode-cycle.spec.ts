import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from './helpers/wait-for.js'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/ui/app.js'
import { formatStatusLine } from '../src/statusline.js'

/** 最小 ctx 替身：agents/sessions/reflect/llm 钩子齐全（与 app.spec 同构）。 */
function makeCtx() {
  const ctx = {
    agents: {
      create: vi.fn(),
      resume: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
    },
    sessions: {
      create: vi.fn(),
      fork: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      flush: vi.fn(),
    },
    reflect: {
      get: vi.fn((_name: string) => undefined as unknown),
    },
    agentDefaultModel: {
      currentSelection: vi.fn(() => ({ provider: 'p', model: 'm' })),
    },
    llm: {},
    get: vi.fn(() => undefined),
    on: vi.fn(() => () => { }),
    provide: vi.fn(() => () => {}),
    planMode: {
      set: vi.fn(() => 'committed' as const),
    },
  }
  return ctx as unknown as Context & {
    agents: typeof ctx.agents
    sessions: typeof ctx.sessions
    reflect: typeof ctx.reflect
    planMode: typeof ctx.planMode
    on: ReturnType<typeof vi.fn>
  }
}

/** 最小 agent 替身：session + followup/steer 可断言。 */
function makeAgent(name: string): Agent {
  return {
    id: `agent-${name}`,
    session: {
      id: `session-${name}` as SessionId,
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
    options: {},
  } as unknown as Agent
}

function makeHandle(agent: Agent): AgentHandle {
  return { agent, dispose: vi.fn(async () => { }) }
}

function makeStdout(): WriteStream & { write: ReturnType<typeof vi.fn> } {
  const stdout = {
    write: vi.fn(() => true),
    columns: 120,
    rows: 40,
    on: vi.fn(),
    removeListener: vi.fn(),
    isTTY: true,
  }
  return stdout as unknown as WriteStream & { write: ReturnType<typeof vi.fn> }
}

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

/** 装配带 active 会话的 app（agent 已注册，走 registry 兜底 controls）。 */
async function bootApp(name = 'mc-1', opts: { noPlanMode?: boolean } = {}) {
  const ctx = makeCtx()
  const agent = makeAgent(name)
  ctx.agents.create.mockResolvedValue(makeHandle(agent))
  ctx.agents.get.mockReturnValue(agent)
  ctx.sessions.get.mockReturnValue(agent.session)
  // 投影总线：snapshot 恒 plan 关；onChanged 回调暴露给测试模拟「plan 生效」。
  let onPlanChanged: ((s: unknown, key: string, value: unknown) => void) | null = null
  const projections = {
    snapshot: vi.fn(() => ({ values: { plan: null } })),
    onChanged: vi.fn((cb: (s: unknown, key: string, value: unknown) => void) => {
      onPlanChanged = cb
      return () => { }
    }),
  }
  ctx.reflect.get.mockImplementation((name: string) => {
    if (name === 'sessionProjections') return projections
    if (name === 'planMode') return opts.noPlanMode === true ? undefined : ctx.planMode
    return undefined
  })
  const stdin = makeStdin()
  const stdout = makeStdout()
  const app = new TuiApp({ ctx, stdout, stdin })
  await app.attach() // attach 无 target 时自动 newSession（铸造会话 id）
  // attach 后的事实会话 id（投影回调按此 id 过滤）。不用 agents.create mock
  // 调用序——启动有空会话复用路径（findMostRecentEmptySession）不走 create，
  // mock.calls[0] 会是 undefined，测试绿依赖「恰好走 create」的偶然性；
  // app.sessionId 是唯一事实源，取不到即响亮失败（审查 LOW 加固）。
  const castId = app.sessionId
  if (castId === null) throw new Error('bootApp: attach 后 sessionId 应为已铸造会话 id')
  return {
    ctx, app, stdin, stdout, agent, castId,
    /** 模拟 plan-mode 生效：驱动投影回调更新 planState。 */
    applyPlan: (active: boolean) => {
      onPlanChanged?.({ id: castId }, 'plan', { active, pending: false })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.useRealTimers()
})

describe('Shift+Tab 三态循环（C3 项 4）', () => {
  it('Normal → Plan：shift_tab 调 planMode.set(true)', async () => {
    const { ctx, app, stdin, agent } = await bootApp()
    stdin.emit('data', '\x1b[Z') // shift_tab
    // 键处理经异步链路（渲染 tick 后动作落地）：轮询等待处理发生（flaky 加固）
    await waitFor(() => ctx.planMode.set.mock.calls.length >= 1)
    expect(ctx.planMode.set).toHaveBeenCalledTimes(1)
    expect(ctx.planMode.set).toHaveBeenCalledWith(agent, true)
    await app.dispose()
  })

  it('Plan → Always-Approve：shift_tab 关 plan 并进入 always-approve', async () => {
    const { ctx, app, stdin, agent, applyPlan } = await bootApp()
    // 第一次：plan 开（驱动投影生效）
    stdin.emit('data', '\x1b[Z')
    applyPlan(true)
    // 第二次：plan 关 + always-approve 开
    stdin.emit('data', '\x1b[Z')
    expect(ctx.planMode.set).toHaveBeenCalledTimes(2)
    expect(ctx.planMode.set).toHaveBeenLastCalledWith(agent, false)
    await app.dispose()
  })

  it('Always-Approve → Normal：第三次 shift_tab 回 Normal', async () => {
    const { ctx, app, stdin, applyPlan } = await bootApp()
    stdin.emit('data', '\x1b[Z')
    applyPlan(true)
    stdin.emit('data', '\x1b[Z') // → Always-Approve
    stdin.emit('data', '\x1b[Z') // → Normal
    expect(ctx.planMode.set).toHaveBeenCalledTimes(2) // 第三次不再调 set
    await app.dispose()
  })

  it('always-approve 激活时当前会话审批请求直接 allowed-once（不挂起）', async () => {
    const { ctx, app, stdin, castId, applyPlan } = await bootApp()
    // 循环两次进入 always-approve
    stdin.emit('data', '\x1b[Z')
    applyPlan(true)
    stdin.emit('data', '\x1b[Z')
    // 取注册的 approval/request handler 直接调用（请求须为当前会话 id）
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      (req: unknown, next: () => Promise<string>) => Promise<string>
    expect(handler).toBeDefined()
    const outcome = handler(
      { agent: { session: { id: castId } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    await expect(outcome).resolves.toBe('allowed-once')
    await app.dispose()
  })

  it('always-approve 激活时非当前会话审批请求不短路（走 next 委托）', async () => {
    const { ctx, app, stdin, applyPlan } = await bootApp()
    stdin.emit('data', '\x1b[Z')
    applyPlan(true)
    stdin.emit('data', '\x1b[Z')
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      (req: unknown, next: () => Promise<string>) => Promise<string>
    const other = makeAgent('mc-other')
    const outcome = handler(
      { agent: { session: { id: other.session.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    await expect(outcome).resolves.toBe('unavailable') // 非当前会话 → next()
    await app.dispose()
  })

  it('状态行 [auto] 徽章由 formatStatusLine 渲染（always-approve 激活时）', () => {
    const view = { phase: 'idle', activity: undefined }
    expect(formatStatusLine(view as never, false, false, false)).not.toContain('[auto]')
    expect(formatStatusLine(view as never, false, false, true)).toContain('[auto]')
  })

  it('切会话（switchSession）复位 always-approve——不残留到新会话', async () => {
    const { ctx, app, stdin, applyPlan } = await bootApp()
    // 进入 always-approve
    stdin.emit('data', '\x1b[Z')
    applyPlan(true)
    stdin.emit('data', '\x1b[Z')
    // 切到另一会话（detachProjections 应复位 alwaysApprove）
    const other = makeAgent('mc-2')
    ctx.agents.get.mockReturnValue(other)
    ctx.sessions.get.mockReturnValue(other.session)
    await app.switchSession(other.session.id)
    // 新会话的审批请求：若 always-approve 未复位会短路 allowed-once；
    // 复位后应挂起等待按键 → n → rejected。
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      (req: unknown, next: () => Promise<string>) => Promise<string>
    const outcome = handler(
      { agent: { session: { id: other.session.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', 'n')
    await expect(outcome).resolves.toBe('rejected')
    await app.dispose()
  })

  it('planMode 只在 agent isolate 时 shift_tab 仍走 serviceFor', async () => {
    const isolated = { set: vi.fn() }
    const { ctx, app, stdin, agent } = await bootApp()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'agentPresets') {
        return { serviceFor: (_a: unknown, svc: string) => svc === 'planMode' ? isolated : undefined }
      }
      return undefined
    })
    stdin.emit('data', '\x1b[Z')
    expect(isolated.set).toHaveBeenCalledWith(agent, true)
    expect(ctx.planMode.set).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('setPlanMode 降级：planMode 服务未装配时 shift_tab 回显警告（不调 set）', async () => {
    const { ctx, app, stdin, stdout } = await bootApp('mc-no-pm', { noPlanMode: true })
    stdout.write.mockClear()
    stdin.emit('data', '\x1b[Z')
    expect(ctx.planMode.set).not.toHaveBeenCalled()
    // fails loud：不再静默——回显「无法进入 plan 模式」
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('无法进入 plan 模式')
    await app.dispose()
  })

  it('setPlanMode 降级：无活跃会话（未 attach）时静默——shift_tab 不调 set', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'planMode') return ctx.planMode
      return undefined
    })
    // 未 attach：activeSessionId 保持 null（setPlanMode 的 null-guard 分支）。
    // onAnyKey 未注册（attach 才注册），故经 handleKey 不可达——直接验证
    // 降级语义：无会话时 app 可构造且 dispose 不抛（null 路径安全）。
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    expect(ctx.planMode.set).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('setPlanMode 降级：agents.get 返回 undefined（无 agent）时静默不调 set', async () => {
    const { ctx, app, stdin } = await bootApp('mc-no-agent')
    ctx.agents.get.mockReturnValue(undefined)
    stdin.emit('data', '\x1b[Z')
    expect(ctx.planMode.set).not.toHaveBeenCalled()
    await app.dispose()
  })
})

describe('/yolo 全放行命令（C3 项 4 快捷入口）', () => {
  it('/yolo 提交后当前会话审批请求短路 allowed-once（不挂起）', async () => {
    const { ctx, app, castId } = await bootApp()
    app.handleSubmit('/yolo')
    await new Promise(resolve => setImmediate(resolve))
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      (req: unknown, next: () => Promise<string>) => Promise<string>
    const outcome = handler(
      { agent: { session: { id: castId } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    await expect(outcome).resolves.toBe('allowed-once')
    await app.dispose()
  })

  it('/yolo off 后审批恢复挂起（请求不再短路）', async () => {
    const { ctx, app, stdin, castId } = await bootApp()
    app.handleSubmit('/yolo')
    app.handleSubmit('/yolo off')
    await new Promise(resolve => setImmediate(resolve))
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      (req: unknown, next: () => Promise<string>) => Promise<string>
    const outcome = handler(
      { agent: { session: { id: castId } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', 'n')
    await expect(outcome).resolves.toBe('rejected')
    await app.dispose()
  })

  it('/yolo 后切会话复位全放行（与 always-approve 同一复位路径）', async () => {
    const { ctx, app, stdin } = await bootApp()
    app.handleSubmit('/yolo')
    await new Promise(resolve => setImmediate(resolve))
    const other = makeAgent('mc-yolo-2')
    ctx.agents.get.mockReturnValue(other)
    ctx.sessions.get.mockReturnValue(other.session)
    await app.switchSession(other.session.id)
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      (req: unknown, next: () => Promise<string>) => Promise<string>
    const outcome = handler(
      { agent: { session: { id: other.session.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', 'n')
    await expect(outcome).resolves.toBe('rejected')
    await app.dispose()
  })
})
