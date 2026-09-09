/**
 * 复现探针：#36 后续用户反馈——「Ctrl+C 打断执行后输入框消失、无法继续输入」。
 *
 * 覆盖：
 * A. agent running → Ctrl+C（handleAbort）→ 主屏下一帧是否含输入轨（╭ 框线 + ❯）
 * B. Tab（palette execute 模式）→ Enter 执行命令 → agent running → Ctrl+C → 主屏含输入轨
 * C. Tab 打开 palette 后 Ctrl+C → palette 关闭 + overlay 释放 + 主屏恢复
 *
 * 探针文件：定位后删除，断言模式并入正式测试。
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/ui/app.js'

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

function makeStdin(): NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    isTTY: false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    setEncoding: vi.fn(),
    pause: vi.fn(),
  }) as unknown as NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> }
}

/** makeCtx 的 mock 字段类型（mockResolvedValue/mockReturnValue 可断言）。 */
interface MockCtx {
  sessions: {
    create: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
    fork: ReturnType<typeof vi.fn>
  }
  agents: {
    create: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
  }
  on: ReturnType<typeof vi.fn>
  reflect: { get: ReturnType<typeof vi.fn> }
  get: ReturnType<typeof vi.fn>
  provide: ReturnType<typeof vi.fn>
}

function makeCtx(): Context & MockCtx {
  const ctx = {
    sessions: { create: vi.fn(), get: vi.fn(), list: vi.fn(() => []), flush: vi.fn(async () => true), fork: vi.fn() },
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn() },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'mock', model: 'mock' })) },
    reflect: { get: vi.fn(() => undefined) },
    on: vi.fn(() => vi.fn(() => true)),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
  } as unknown as Context & MockCtx
  return ctx
}

function makeAgent(id: string): Agent & { cancel: ReturnType<typeof vi.fn>; followup: ReturnType<typeof vi.fn> } {
  return {
    id: SessionId(id),
    options: {},
    session: { id: SessionId(id), header: { id: SessionId(id), version: 0, createdAt: 1, isSeeded: false }, events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] }, requestHeader: vi.fn(() => undefined), requestContext: vi.fn(() => undefined) },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
    ctx: { reflect: { get: vi.fn(() => undefined) } },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => { }),
  } as unknown as Agent & { cancel: ReturnType<typeof vi.fn>; followup: ReturnType<typeof vi.fn> }
}

function makeHandle(agent: Agent): AgentHandle & { dispose: ReturnType<typeof vi.fn> } {
  return { agent, dispose: vi.fn() } as unknown as AgentHandle & { dispose: ReturnType<typeof vi.fn> }
}

async function bootApp(onExit?: () => void) {
  const ctx = makeCtx()
  const agent = makeAgent('repro-1')
  ctx.agents.create.mockResolvedValue(makeHandle(agent))
  ctx.sessions.get.mockReturnValue(agent.session)
  const stdin = makeStdin()
  const stdout = makeStdout()
  const app = new TuiApp({ ctx, stdout, stdin, onExit })
  await app.attach()
  return { app, ctx, agent, stdin, stdout }
}

/** 把 liveAgent 投影推到 running（现有测试同款手法：手动触发 agent/status）。 */
function forceRunning(ctx: Context & MockCtx, app: TuiApp): void {
  const id = app.sessionId
  if (id === null) throw new Error('sessionId missing')
  const handlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: unknown[]) => call[0] === 'agent/status')
    .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
  for (const handler of handlers) handler({ agent: { id }, status: 'running' })
}

/** 断言主屏写屏（renderLive 输出）含输入轨框线（╭ = 输入框可见）。 */
function written(stdout: ReturnType<typeof makeStdout>): string {
  return stdout.write.mock.calls.map(c => `${c[0]}`).join('')
}

/** 剥离 ANSI 转义后取纯文本（颜色/光标序列不干扰子串断言）。 */
function plain(out: string): string {
  return out.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** 捕获 session/event 订阅并模拟总线广播（app.spec 同款）。 */
function sessionEventBus(ctx: Context & MockCtx): (id: SessionId, event: Record<string, unknown>) => void {
  const handlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: unknown[]) => call[0] === 'session/event')
    .map(call => call[1] as (owner: { id: SessionId }, event: unknown) => void)
  if (handlers.length === 0) throw new Error('session/event handler not registered')
  return (id, event) => {
    for (const handler of handlers) handler({ id }, event)
  }
}

describe('复现：Ctrl+C 打断后输入框可见性', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('A: running 中 Ctrl+C → abort 后主屏含输入轨（╭）', async () => {
    const { app, ctx, agent, stdin, stdout } = await bootApp()
    forceRunning(ctx, app)

    stdin.emit('data', '\x03')
    await new Promise(r => setImmediate(r))

    expect(agent.cancel).toHaveBeenCalledTimes(1)
    const out = written(stdout)
    expect(out).toContain('已取消')
    // 输入框可见性：主屏写屏含输入轨框线
    expect(out).toContain('╭')
    await app.dispose()
  })

  it('B: Tab(execute) → Enter 执行 /status → running 中 Ctrl+C → 主屏含输入轨', async () => {
    const { app, ctx, agent, stdin, stdout } = await bootApp()
    // Tab 打开 palette execute 模式
    stdin.emit('data', '\x09')
    await new Promise(r => setImmediate(r))
    // 过滤到 status 并 Enter 直接执行（/help 现打开命令面板，改用无副作用的
    // 面板切换命令——测试意图是「命令执行后 running 中 Ctrl+C 可取消」）
    stdin.emit('data', 'status')
    stdin.emit('data', '\r')
    await new Promise(r => setImmediate(r))
    forceRunning(ctx, app)

    stdin.emit('data', '\x03')
    await new Promise(r => setImmediate(r))

    expect(agent.cancel).toHaveBeenCalledTimes(1)
    const out = written(stdout)
    expect(out).toContain('已取消')
    expect(out).toContain('╭')
    await app.dispose()
  })

  it('C: palette 打开中 Ctrl+C → 关闭 palette 并释放 overlay，主屏恢复', async () => {
    const { app, stdin, stdout } = await bootApp()
    stdin.emit('data', '\x09')
    await new Promise(r => setImmediate(r))
    expect(written(stdout)).toContain('\x1B[?1049h') // alt screen（palette overlay）

    stdin.emit('data', '\x03')
    await new Promise(r => setTimeout(r, 200))

    const out = written(stdout)
    expect(out).toContain('\x1B[?1049l') // 退出 alt screen
    expect(out).toContain('╭')            // 主屏输入轨回来
    await app.dispose()
  })

  it('D: abort 后 agent 尾巴事件（text-delta）继续到达 → 主屏仍含输入轨（渲染不抛）', async () => {
    const { app, ctx, agent, stdin, stdout } = await bootApp()
    const id = app.sessionId
    if (id === null) throw new Error('no session')
    const emit = sessionEventBus(ctx)
    forceRunning(ctx, app)

    stdin.emit('data', '\x03') // abort
    await new Promise(r => setImmediate(r))
    // cancel 竞速：agent 仍发尾巴流式块与 aborted turn/end
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    emit(id, { seq: 2, time: 2, type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: '尾巴残文' } } })
    emit(id, { seq: 3, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await new Promise(r => setImmediate(r))

    const out = written(stdout)
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(out).toContain('╭') // 输入轨仍在（渲染未抛异常）
    await app.dispose()
  })

  it('F: abort 后输入链路存活——输入字符渲染进输入框', async () => {
    const { app, ctx, agent, stdin, stdout } = await bootApp()
    forceRunning(ctx, app)
    stdin.emit('data', '\x03') // abort
    await new Promise(r => setImmediate(r))
    expect(agent.cancel).toHaveBeenCalledTimes(1)

    stdin.emit('data', 'a') // abort 后输入字符
    await new Promise(r => setImmediate(r))

    const out = written(stdout)
    expect(plain(out)).toContain('❯ a') // 输入框显示内容（输入链路存活）
    await app.dispose()
  })

  it('G: abort 后宿主销毁 agent（agent/disposed → live=false）→ 主屏仍含输入轨且可输入', async () => {
    const { app, ctx, stdin, stdout } = await bootApp()
    const id = app.sessionId
    if (id === null) throw new Error('no session')
    forceRunning(ctx, app)
    stdin.emit('data', '\x03') // abort
    await new Promise(r => setImmediate(r))

    // 宿主 cancel 竞速：销毁 agent（live=false）
    const disposedHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/disposed')
      .map(call => call[1] as (payload: { agent: { id: SessionId } }) => void)
    for (const handler of disposedHandlers) handler({ agent: { id } })
    await new Promise(r => setImmediate(r))

    // live=false 后主屏仍渲染输入轨
    const out1 = written(stdout)
    expect(out1).toContain('╭')

    // 且输入链路仍可用
    stdin.emit('data', 'x')
    await new Promise(r => setImmediate(r))
    expect(plain(written(stdout))).toContain('❯ x')
    await app.dispose()
  })

  it('H: overlay 激活时 handleAbort 强制释放 overlay → 主屏（输入轨）恢复', async () => {
    const { app, stdin, stdout } = await bootApp()
    stdin.emit('data', '\x09') // Tab 打开 palette（overlay 激活）
    await new Promise(r => setImmediate(r))
    expect(written(stdout)).toContain('\x1B[?1049h')

    // 直接调 handleAbort（模拟未来路径在 overlay 激活时打断）
    app.handleAbort()
    await new Promise(r => setTimeout(r, 200))

    const out = written(stdout)
    expect(out).toContain('\x1B[?1049l') // overlay 已释放
    expect(out).toContain('╭')            // 主屏输入轨恢复
    expect(out).toContain('已取消')
    await app.dispose()
  })

  it('I: 0x03 Ctrl+C 处理后 shouldDeferSigint=true（Windows 双触发防护门）', async () => {
    const { app, stdin } = await bootApp()
    expect(app.shouldDeferSigint(Date.now())).toBe(false) // 未处理过 0x03

    stdin.emit('data', '\x03') // 空闲空输入：第一次 Ctrl+C（双击退出窗口开始）
    await new Promise(r => setImmediate(r))
    expect(app.shouldDeferSigint(Date.now())).toBe(true) // 800ms 窗口内

    await new Promise(r => setTimeout(r, 900))
    expect(app.shouldDeferSigint(Date.now())).toBe(false) // 窗口过后不再 defer
    await app.dispose()
  })
})
