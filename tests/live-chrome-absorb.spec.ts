/**
 * live-chrome-absorb — 定高视口「chrome 开合吸收」帧级契约（项 5）。
 *
 * 吸收段（chrome 前缀 todos/提问/审批/slash 菜单）行数计入动态段高水位记账：
 * - 短内容期（高水位无余量）：首次打开向下落定一次（动态段不动、卡占新行）；
 *   关闭回缩由垫高吸收——输入轨行位与帧总高不变。
 * - 高水位有余量（开过一轮后）：再开不再推高总高（垫高行就地让给卡），
 *   开→关全程输入轨不动。
 *
 * 断言方式：spy LiveEngine.prototype.render 逐帧取行数组，输入轨 Y = 帧内最后
 * 一个含 ╭ 的行下标（审批卡 ╭ 在轨上方；formatFooterInfo 无 ╭）。
 * ctx/agent/stdin/stdout 替身镜像 app.spec.ts 的同名工厂（测试独立性优先）。
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from './helpers/wait-for.js'
import type { WriteStream } from 'node:tty'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/ui/app.js'
import { LiveEngine, type LiveRegionLine } from '../src/engine/live-engine.js'

type Frame = string[]

/** 最小可渲染 stdout 替身（镜像 app.spec.ts）。 */
function makeStdout(): WriteStream & { write: ReturnType<typeof vi.fn> } {
  return {
    columns: 100, rows: 30, write: vi.fn(), isTTY: false, on: vi.fn(), removeListener: vi.fn(),
  } as unknown as WriteStream & { write: ReturnType<typeof vi.fn> }
}

/** 最小 stdin 替身：EventEmitter + InputHandler 需要的流方法。 */
function makeStdin(): NodeJS.ReadStream {
  return Object.assign(new EventEmitter(), {
    isTTY: false, setRawMode: vi.fn(), resume: vi.fn(), setEncoding: vi.fn(), pause: vi.fn(),
  }) as unknown as NodeJS.ReadStream
}

function makeCtx(): Context & {
  sessions: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn>; fork: ReturnType<typeof vi.fn> }
  agents: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
  reflect: { get: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
} {
  return {
    sessions: {
      create: vi.fn(), get: vi.fn(), list: vi.fn(() => []), flush: vi.fn(async () => true), fork: vi.fn(),
    },
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn() },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'mock', model: 'mock' })) },
    reflect: { get: vi.fn(() => undefined) },
    on: vi.fn(() => vi.fn(() => true)),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
  } as unknown as ReturnType<typeof makeCtx>
}

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
    ctx: { reflect: { get: vi.fn(() => undefined) } },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => { }),
  } as unknown as Agent
}

/** 输入轨 Y：帧内最后一个含 ╭ 的行下标（轨线 ╭─╮ 是帧末唯一圆角框顶）。 */
function railIndex(frame: Frame): number {
  let idx = -1
  for (const [i, text] of frame.entries()) if (text.includes('╭')) idx = i
  return idx
}

/** spy LiveEngine.render 并取最后一帧的行文本数组（callThrough，不影响真实渲染）。 */
function lastFrame(spy: { mock: { calls: unknown[][] } }): Frame {
  const call = spy.mock.calls.at(-1)
  if (call === undefined) throw new Error('live.render 尚未被调用')
  return (call[0] as readonly LiveRegionLine[]).map(l => l.text)
}

/** 装配带审批 answerer 的 app，返回发当前会话审批请求的驱动函数。 */
async function bootApprovalApp() {
  const ctx = makeCtx()
  const agent = makeAgent('absorb-a')
  ctx.agents.create.mockResolvedValue({ agent, dispose: vi.fn() } as unknown as AgentHandle)
  ctx.sessions.get.mockReturnValue(agent.session)
  const stdin = makeStdin()
  const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
  await app.attach()
  const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
    | ((req: unknown, next: () => Promise<string>) => Promise<string>)
    | undefined
  if (handler === undefined) throw new Error('approval/request handler not registered')
  const owner = { id: app.sessionId ?? SessionId('absorb-a') }
  const request = (): Promise<string> => handler(
    { agent: { session: { id: owner.id } }, toolName: 'bash', reason: 'sandbox' },
    () => Promise.resolve('unavailable'),
  )
  return { app, stdin, request }
}

/** 装配带 userQuestions 服务的 app（镜像 app.spec.ts bootQuestionApp）。
 *  rc.1 wire：answerer 经 ctx.on('user-questions/request') 注册，捕获后以
 *  waterfall 客户语义暴露 ask。 */
async function bootQuestionApp() {
  const ctx = makeCtx()
  const agent = makeAgent('absorb-q')
  ctx.agents.create.mockResolvedValue({ agent, dispose: vi.fn() } as unknown as AgentHandle)
  ctx.sessions.get.mockReturnValue(agent.session)
  const stdin = makeStdin()
  const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
  await app.attach()
  const onCalls = (ctx.on as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>
  const reg = onCalls.find(([name]) => name === 'user-questions/request')
  if (reg === undefined) throw new Error('userQuestions answerer not registered')
  const answerer = reg[1] as (request: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const ask = (request: unknown): Promise<unknown> => answerer(request, async () => {
    throw new Error('no downstream answerer')
  })
  return { app, stdin, ask }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('定高视口 chrome 开合吸收（审批卡）', () => {
  it('短内容期：首次开落定一次，关→由垫高吸收不动', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin, request } = await bootApprovalApp()

    const before = lastFrame(spy)
    const beforeCalls = spy.mock.calls.length
    const outcome = request()
    // 审批请求的渲染帧经异步链路落地：轮询等新帧再取（flaky 加固）
    await waitFor(() => spy.mock.calls.length > beforeCalls)
    const opened = lastFrame(spy)
    // 高水位尚无余量：首次打开向下落定（动态段原样，卡占据新增行）。
    expect(railIndex(opened)).toBeGreaterThan(railIndex(before))

    stdin.emit('data', 'y')
    await expect(outcome).resolves.toBe('allowed-once')
    const closed = lastFrame(spy)
    // 关闭回缩由垫高吸收：输入轨行位与帧总高不变。
    expect(railIndex(closed)).toBe(railIndex(opened))
    expect(closed.length).toBe(opened.length)
    await app.dispose()
  })

  it('高水位有余量后：再开→关全程输入轨不动', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin, request } = await bootApprovalApp()

    // 先开→关一轮，高水位留下卡高等量余量（垫高行常驻）。
    const first = request()
    stdin.emit('data', 'y')
    await expect(first).resolves.toBe('allowed-once')
    const settled = lastFrame(spy)

    const second = request()
    const reopened = lastFrame(spy)
    // 打开不推高总高：垫高行就地让给审批卡，输入轨不动。
    expect(railIndex(reopened)).toBe(railIndex(settled))
    expect(reopened.length).toBe(settled.length)

    stdin.emit('data', 'y')
    await expect(second).resolves.toBe('allowed-once')
    const reclosed = lastFrame(spy)
    expect(railIndex(reclosed)).toBe(railIndex(reopened))
    expect(reclosed.length).toBe(reopened.length)
    await app.dispose()
  })
})

describe('定高视口 chrome 开合吸收（提问面板）', () => {
  const askRequest = (id: string): unknown => ({
    questions: [{ id, question: '继续执行？', options: [{ label: '是' }, { label: '否' }] }],
  })

  it('短内容期：首次开落定一次，Esc 关→由垫高吸收不动', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin, ask } = await bootQuestionApp()

    const before = lastFrame(spy)
    const askPromise = ask(askRequest('absorb-q1'))
    const opened = lastFrame(spy)
    expect(railIndex(opened)).toBeGreaterThan(railIndex(before))

    stdin.emit('data', '\x1b')
    await expect(askPromise).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const closed = lastFrame(spy)
    expect(railIndex(closed)).toBe(railIndex(opened))
    expect(closed.length).toBe(opened.length)
    await app.dispose()
  })

  it('高水位有余量后：再开→关全程输入轨不动', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin, ask } = await bootQuestionApp()

    const first = ask(askRequest('absorb-q2'))
    stdin.emit('data', '\x1b')
    await expect(first).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const settled = lastFrame(spy)

    const second = ask(askRequest('absorb-q3'))
    const reopened = lastFrame(spy)
    expect(railIndex(reopened)).toBe(railIndex(settled))
    expect(reopened.length).toBe(settled.length)

    stdin.emit('data', '\x1b')
    await expect(second).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const reclosed = lastFrame(spy)
    expect(railIndex(reclosed)).toBe(railIndex(reopened))
    expect(reclosed.length).toBe(reopened.length)
    await app.dispose()
  })
})
