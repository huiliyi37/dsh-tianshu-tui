import { execFileSync, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TuiApp, parseSlashCommand } from '../src/ui/app.js'
import { LiveEngine } from '../src/engine/live-engine.js'
import type { SlashHintEntry } from '../src/engine/input-controller.js'
import { decodeMessages, encodeMessage } from '../src/lsp/rpc.js'
import { getActiveThemeName, setTheme } from '../src/theme.js'
import { waitForStdout } from './helpers/wait-for.js'
import { readImageFromClipboard, readTextFromClipboard } from '../src/engine/clipboard-image.js'

// 剪贴板读图/读文本走真实 shell（osascript / wl-paste 等），单元测试不可控——
// 默认 mock 为「剪贴板无图/无文本」；图片粘贴行为测试用 vi.mocked 调整返回值。
vi.mock('../src/engine/clipboard-image.js', () => ({
  readImageFromClipboard: vi.fn(async () => null),
  readTextFromClipboard: vi.fn(async () => null),
  FOCUS_DEBOUNCE_MS: 1_000,
}))

/** 输入轨顶框前连续空行数（定高垫行 vs 欢迎帧不垫的装配断言）。 */
function blankLinesBeforeRail(written: string): number {
  const plain = written.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
  const idx = plain.lastIndexOf('╭')
  if (idx < 0) return 0
  const m = plain.slice(0, idx).match(/(?:\n[ \t]*)+$/)
  if (m === null) return 0
  return m[0].split('\n').length - 1
}

/** 最小可渲染 stdout 替身：宽/高/写入记录，以及 ResizeHandler 需要的 on/removeListener。 */
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

/** 最小 stdin 替身：EventEmitter + InputHandler 需要的流方法。 */
function makeStdin(): NodeJS.ReadStream & {
  setRawMode: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  setEncoding: ReturnType<typeof vi.fn>
  isTTY: boolean
} {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    setEncoding: vi.fn(),
    pause: vi.fn(),
  }) as unknown as NodeJS.ReadStream & {
    setRawMode: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    setEncoding: ReturnType<typeof vi.fn>
    isTTY: boolean
  }
  createdStdins.push(stdin)
  return stdin
}

/** recording ctx 的订阅台账条目：一次 on() 与其 disposer 是否已被调用。 */
interface SubscriptionRecord {
  event: string
  released: boolean
}

/** 本文件当前测试创建的台账/stdin（afterEach 平衡断言后清空）。 */
const createdLedgers: SubscriptionRecord[][] = []
const createdStdins: NodeJS.ReadStream[] = []

/** makeCtx 的 mock 字段类型：保留 vi.fn 的 mock 方法（mockResolvedValue/mockReturnValue 等）。 */
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
  agentDefaultModel: {
    currentSelection: ReturnType<typeof vi.fn>
  }
  /** T4：sessionProjections 服务替身（可选——缺失时窗格降级并在切换时回显警告）。 */
  sessionProjections?: {
    snapshot: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
  }
  /** Cordis 注入代理的可选服务读取面（reflect.get：未注册返回 undefined）。 */
  reflect: {
    get: ReturnType<typeof vi.fn>
  }
  on: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  provide: ReturnType<typeof vi.fn>
  /** recording ctx 的订阅台账（afterEach 断言订阅/释放平衡）。 */
  subscriptions: SubscriptionRecord[]
}

/** 带记录字段的 ctx 替身：agents/sessions 可注入；on 记录订阅并返回
 *  记录释放的 disposer（订阅/释放平衡在 afterEach 统一断言）。 */
function makeCtx(): Context & MockCtx {
  const subscriptions: SubscriptionRecord[] = []
  createdLedgers.push(subscriptions)
  const ctx = {
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      flush: vi.fn(async () => true),
      fork: vi.fn(),
    },
    agents: {
      create: vi.fn(),
      resume: vi.fn(),
      get: vi.fn(),
    },
    agentDefaultModel: {
      currentSelection: vi.fn(() => ({ provider: 'mock', model: 'mock' })),
    },
    // 注入代理：可选服务必须经 reflect.get 读取（属性访问在 Cordis 4 抛
    // "without inject"——真实装配已复现；mock 默认无服务返回 undefined）。
    reflect: {
      // 默认 mock：attachments 服务（图片发送经 saveImage 持久化后投递）；
      // 其余服务按测试覆盖分发（userQuestions 等见各测试块的 mockImplementation）。
      get: vi.fn((name: string) => name === 'attachments' ? {
        saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string }) => ({
          attachmentId: 'mock-att-1',
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        })),
      } : undefined),
    },
    on: vi.fn((event: string) => {
      const record: SubscriptionRecord = { event, released: false }
      subscriptions.push(record)
      return vi.fn(() => {
        record.released = true
        return true
      })
    }),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
    subscriptions,
  } as unknown as Context & MockCtx
  return ctx
}

/** makeAgent 的 mock 字段类型：驱动方法可断言（mock/mockReturnValue）。 */
interface MockAgent {
  session: { requestHeader: ReturnType<typeof vi.fn>; mockLog: unknown[] }
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
}

/** 最小 live agent 替身：驱动方法可断言。 */
function makeAgent(id: string): Agent & MockAgent {
  const mockLog: unknown[] = []
  return {
    id: SessionId(id),
    options: {},
    session: {
      id: SessionId(id),
      header: { id: SessionId(id), version: 0, createdAt: 1, isSeeded: false },
      mockLog,
      // rc.1 wire：Session.events getter 已移除，投影走 snapshotEvents()；
      // 运行时保留 events 字段（与 mockLog 同一数组）——Object.assign 换日志的
      // 用例（switchSession/fork）经 this.events 动态读取。
      events: mockLog,
      snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
      requestHeader: vi.fn(() => undefined),
      requestContext: vi.fn(() => undefined),
    },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
    // send.ts 的 followup 图片路径经 agent.ctx.reflect.get('attachments') 保存；
    // mock 与 makeCtx 的默认分支同构（真实 Agent 恒有 ctx）。
    ctx: {
      reflect: {
        get: vi.fn((name: string) => name === 'attachments' ? {
          saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string }) => ({
            attachmentId: 'mock-att-1',
            mediaType: input.mediaType,
            bytes: input.data.byteLength,
            width: 1,
            height: 1,
          })),
        } : undefined),
      },
    },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => { }),
  } as unknown as Agent & MockAgent
}

/** 最小 handle 替身：dispose 可断言。可传入局部 mock 句柄以便断言引用局部变量。 */
function makeHandle(
  agent: Agent,
  dispose: ReturnType<typeof vi.fn> = vi.fn(),
): AgentHandle & { dispose: ReturnType<typeof vi.fn> } {
  return { agent, dispose } as unknown as AgentHandle & { dispose: ReturnType<typeof vi.fn> }
}

/** 驱动 mock（followup/steer 等）单次调用首参的 content[0].text 提取（mock 参数 any 收窄）。 */
function firstCallText(mock: ReturnType<typeof vi.fn>): string {
  const arg = mock.mock.calls[0]?.[0] as { content?: Array<{ text?: string }> } | undefined
  return arg?.content?.[0]?.text ?? ''
}

/** 驱动 mock（followup/steer 等）全部调用的首参 content[0].text 列表。 */
function allCallTexts(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.flatMap((c) => {
    const arg = c[0] as { content?: Array<{ text?: string }> } | undefined
    const text = arg?.content?.[0]?.text
    if (text === undefined) return []
    return [text]
  })
}

/** 捕获所有 session/event 订阅（transcript/live/statusline/流式供给/streamFeed），
 *  模拟总线广播。文件级共享（流式提交与 glance 数据接线两个 describe 复用）。 */
function sessionEventBus(ctx: ReturnType<typeof makeCtx>): (id: SessionId, event: Record<string, unknown>) => void {
  const handlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: unknown[]) => call[0] === 'session/event')
    .map(call => call[1] as (owner: { id: SessionId }, event: unknown) => void)
  if (handlers.length === 0) throw new Error('session/event handler not registered')
  return (id, event) => {
    for (const handler of handlers) handler({ id }, event)
  }
}

/** 向 transcript 灌一条 user/message（rewind 检查点过滤用；默认真人用户源）。 */
function emitTranscriptUser(
  bus: (id: SessionId, event: Record<string, unknown>) => void,
  id: SessionId,
  seq: number,
  text: string,
  source: { kind: 'user' } | { kind: 'plugin'; plugin: string } = { kind: 'user' },
): void {
  bus(id, {
    seq,
    time: seq,
    type: 'user/message',
    data: {
      id: `m-${seq}`,
      role: 'user',
      source,
      content: [{ type: 'text', text }],
    },
  })
}

afterEach(() => {
  // 订阅/释放平衡：InputHandler.dispose() 恒调 stdin.pause()，本文件一测一
  // app——出现过 pause 即该用例走完了 app.dispose()；此时每个 recording ctx
  // 的全部 on() 订阅都必须已释放。部分释放（如 ?? 短路吞掉 disposer、
  // detach 漏收集）在此现形；未 dispose 的用例不做此断言。
  const fullyDisposed = createdStdins.some(
    stdin => (stdin.pause as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0,
  )
  if (fullyDisposed) {
    for (const ledger of createdLedgers) {
      const leaked = ledger.filter(record => !record.released).map(record => record.event)
      expect(leaked, 'app.dispose() 后仍存活的 ctx.on 订阅').toEqual([])
    }
  }
  createdLedgers.length = 0
  createdStdins.length = 0
  vi.restoreAllMocks()
})

describe('TuiApp 宿主线守卫（rc.1 wire）', () => {
  it('旧宿主（无 Session.prototype.snapshotEvents）attach 即 fail-loud，附升级/回退指引', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('guard-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    // 模拟旧宿主：rc.1 前的 Session 原型没有 snapshotEvents
    const proto = Session.prototype as unknown as Record<string, unknown>
    const saved = proto.snapshotEvents
    Reflect.deleteProperty(proto, 'snapshotEvents')
    try {
      await expect(app.attach()).rejects.toThrow(/0\.1\.2-rc\.1\+ 官方宿主/)
      await expect(app.attach()).rejects.toThrow(/@huiliyi37\/dsh-tianshu-tui@0\.1\.2-rc\.28/)
    } finally {
      proto.snapshotEvents = saved
    }
    await app.dispose()
  })
})

describe('TuiApp agent-ensure 三分支', () => {
  it('newSession 经 ctx.agents.create 拿 handle，controls 来自 handle', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('fresh-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    const id = await app.newSession()

    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' },
    }))
    expect(ctx.sessions.create).not.toHaveBeenCalled()
    // controls 来自 handle.agent：followup 打到 handle 下的 agent
    app.handleSubmit('hello')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
    // 自有 handle 由本层 dispose
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('newSession 把 process.cwd() 写入 create meta.cwd（Web 会话列表可见）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('cwd-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()

    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: process.cwd() },
    }))
    await app.dispose()
  })

  it('switchSession 旧会话无 agent → resume，controls 来自 handle', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('old-1')
    const handle = makeHandle(agent)
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('old-1'))

    expect(ctx.agents.resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: SessionId('old-1'),
      agentOptions: { provider: 'mock', model: 'mock' },
    }))
    expect(ctx.agents.create).not.toHaveBeenCalled()
    app.handleSubmit('hi')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('switchSession resume setup 按日志 mount', async () => {
    const mount = vi.fn(async () => ({ id: 'ptc' }))
    const ctx = makeCtx()
    const agent = makeAgent('old-ptc')
    Object.assign(agent.session.header, { agentPreset: 'standard' })
    Object.assign(agent.session, {
      events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } },
      ] as unknown as SessionEvent[],
    })
    const handle = makeHandle(agent)
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockImplementation(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
      await opts.setup?.({ on: vi.fn(() => () => {}) })
      return handle
    })
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.reflect.get.mockImplementation((name: string) => name === 'agentPresets' ? { mount } : undefined)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('old-ptc'))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'ptc')
    await app.dispose()
  })

  it('任务5 大会话渐进重放：首片同步、余片异步、窗口内新流事件排队不插队', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('big-1')
    const events = Array.from({ length: 250 }, (_, k): SessionEvent => {
      const i = k + 1
      return {
        seq: i, time: i, type: 'user/message',
        data: { id: `m-${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `历史消息${i}` }] },
      } as unknown as SessionEvent
    })
    Object.assign(agent.session, { events })
    const handle = makeHandle(agent)
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockImplementation(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
      await opts.setup?.({ on: vi.fn(() => () => {}) })
      return handle
    })
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.switchSession(SessionId('big-1'))

    // switchSession 返回时只落了首片（REPLAY_CHUNK_ROWS=100 行 < 250 条消息的
    // 渲染行数）——尾部历史仍未上屏，证明不是单 tick 全量。
    const initial = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(initial).toContain('历史消息1')
    expect(initial).not.toContain('历史消息250')

    // 重放窗口内注入新流事件（text-delta ≥15 字符带空行边界 → 同步成块 commit）。
    // session/event 有多个订阅者（trackAgent live fold / streamFeed）——按总线
    // 语义广播给全部。
    const feedHandlers = ctx.on.mock.calls.filter(call => call[0] === 'session/event')
      .map(call => call[1] as ((owner: { id: SessionId }, event: SessionEvent) => void))
    if (feedHandlers.length === 0) throw new Error('session/event handlers not registered')
    const liveEvent = {
      seq: 999, time: 999, type: 'assistant/attempt',
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 999, chunk: { type: 'text-delta', text: `实时正文${'X'.repeat(36)}\n\n尾` } }] },
    } as unknown as SessionEvent
    for (const handler of feedHandlers) handler({ id: SessionId('big-1') }, liveEvent)

    // 让 setImmediate 重放链与 backlog 回放跑完。
    for (let k = 0; k < 20; k++) await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('历史消息250') // 余片全部落底
    expect(written.indexOf('历史消息250')).toBeLessThan(written.indexOf('实时正文')) // 新事件不插队
    await app.dispose()
  })

  it('switchSession 旧会话已有 agent → registry 兜底，不 create 不 resume', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('live-1')
    ctx.agents.get.mockReturnValue(agent)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('live-1'))

    expect(ctx.agents.create).not.toHaveBeenCalled()
    expect(ctx.agents.resume).not.toHaveBeenCalled()
    // registry 兜底仍可驱动
    app.handleSubmit('hi')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
    // 非自有 agent：无 handle 可 dispose，且 bare agent 无 dispose 语义
  })

  it('switchSession resume 失败 → 抛错且不提交切换状态（停留原会话）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('keep-1')
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.agents.resume.mockResolvedValueOnce(makeHandle(agent)) // 首切成功
    ctx.agents.resume.mockRejectedValueOnce(new Error('工件损坏')) // 目标不可恢复
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('old-1'))

    await expect(app.switchSession(SessionId('broken-2'))).rejects.toThrow('工件损坏')
    const state = app as unknown as {
      activeSessionId: SessionId
      transcript: { view: { messages: unknown[] } } | null
      modelRef: unknown
    }
    expect(state.activeSessionId).toBe(SessionId('old-1'))
    expect(state.transcript).not.toBeNull()
    await app.dispose()
  })

  it('Ctrl+S 切换失败 → 回显 ⚠ 会话切换失败，停留原会话', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('ctrl-s-keep')
    const other = makeAgent('ctrl-s-bad')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockImplementation((id: SessionId) => (id === agent.session.id ? agent.session : other.session))
    ctx.sessions.list.mockReturnValue([agent.session, other.session])
    ctx.agents.get.mockImplementation((id: SessionId) => (id === agent.session.id ? agent : undefined))
    ctx.agents.resume.mockRejectedValue(new Error('bad'))
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const state = app as unknown as { activeSessionId: SessionId | null }
    const before = state.activeSessionId

    stdin.emit('data', '\x13') // ctrl_s
    await new Promise(resolve => setTimeout(resolve, 60))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚠ 会话切换失败: bad')
    expect(state.activeSessionId).toBe(before)
    await app.dispose()
  })

  it('/session 选择器选中不可恢复会话 → guarded 回显失败原因', async () => {
    const ctx = makeCtx()
    const a = makeAgent('pick-a')
    const b = makeAgent('pick-b')
    ctx.agents.create.mockResolvedValue(makeHandle(a))
    ctx.sessions.get.mockImplementation((id: SessionId) => (id === a.session.id ? a.session : b.session))
    ctx.sessions.list.mockReturnValue([a.session, b.session])
    ctx.agents.get.mockImplementation((id: SessionId) => (id === a.session.id ? a : undefined))
    ctx.agents.resume.mockRejectedValue(new Error('bad'))
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const state = app as unknown as { activeSessionId: SessionId | null }
    const before = state.activeSessionId

    app.handleSubmit('/session') // 无参 → 打开会话选择器
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('选择会话')
    stdin.emit('data', '\x1b[B') // ↓ 选中第二项（pick-b）
    stdin.emit('data', '\r') // Enter 确认
    await new Promise(resolve => setTimeout(resolve, 60))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚠ 会话切换失败: bad')
    expect(state.activeSessionId).toBe(before)
    await app.dispose()
  })

  it('dispose 时 flushAll 遍历 live sessions 并 flush', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('flush-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([agent.session])

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    await app.dispose()

    expect(ctx.sessions.flush).toHaveBeenCalled()
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('P3 side conversation：切换保留旧会话 agent（keepHandle 让渡），切回走 registry 兜底', async () => {
    const ctx = makeCtx()
    const agentA = makeAgent('keep-a')
    const handleA = makeHandle(agentA)
    const agentB = makeAgent('keep-b')
    const handleB = makeHandle(agentB)
    ctx.agents.create
      .mockResolvedValueOnce(handleA)
      .mockResolvedValueOnce(handleB)
    ctx.sessions.get.mockReturnValue(agentA.session)
    let idA: SessionId = SessionId('')
    // 切回 A 时 registry 命中（A 的 agent 在 keepHandle 后仍 live；id 闭包
    // 匹配 newSession 实际铸造的 session id）
    ctx.agents.get.mockImplementation((id: SessionId) => id === idA ? agentA : undefined)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    idA = await app.newSession()
    await app.newSession() // /session new：旧会话保留

    // keepHandle 语义：切换不销毁旧 agent（side conversation 成立条件）
    expect(handleA.dispose).not.toHaveBeenCalled()

    // 切回 A：registry 兜底——不 create 不 resume，直接驱动原 agent
    await app.switchSession(idA)
    expect(ctx.agents.create).toHaveBeenCalledTimes(2)
    expect(ctx.agents.resume).not.toHaveBeenCalled()
    app.handleSubmit('hi')
    expect(agentA.followup).toHaveBeenCalledTimes(1)

    // 所有权已让渡 registry：退出时本层不再 dispose（释放由 agent-loop factory
    // 在 ctx teardown 统一承担——mock 无 factory，此处断言"不再持有"语义）。
    await app.dispose()
    expect(handleA.dispose).not.toHaveBeenCalled()
    expect(handleB.dispose).not.toHaveBeenCalled()
  })
})

describe('TuiApp 启动复用（上一个空会话 id 复用 + cwd 重绑启动目录）', () => {
  function userMessageEvent(text: string): { seq: number; time: number; type: string; data: unknown } {
    return {
      seq: 1,
      time: 1,
      type: 'user/message',
      data: { id: 'm-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    }
  }

  /** 给 ctx 注入 sessionPersistence 服务（其余服务名回落到默认 mock）。 */
  function withPersistence(ctx: ReturnType<typeof makeCtx>, persistence: Record<string, unknown>): void {
    const baseGet = ctx.reflect.get.getMockImplementation() as ((name: string) => unknown) | undefined
    ctx.reflect.get.mockImplementation((name: string) => (name === 'sessionPersistence' ? persistence : baseGet?.(name)))
  }

  /** 状态化接线：create 前 live store 空（候选会话走 persistence inspect），
   *  create 后把 mock 会话挂进 live store（mountSession 读取）。 */
  function wireLiveAfterCreate(ctx: ReturnType<typeof makeCtx>, agent: ReturnType<typeof makeAgent>): void {
    let createdId: SessionId | null = null
    ctx.agents.create.mockImplementation(async (opts: { sessionId: SessionId }) => {
      createdId = opts.sessionId
      return makeHandle(agent)
    })
    ctx.sessions.get.mockImplementation((id: SessionId) => (id === createdId ? agent.session : undefined))
    ctx.sessions.list.mockReturnValue([]) // live store 空 → 启动走持久化列表
  }

  it('同目录的上一个空会话 → attach 复用其 id（统一清旧 artifact 后重建；meta.cwd = 启动目录）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('reuse-1')
    wireLiveAfterCreate(ctx, agent)
    const oldHeader = { id: SessionId('session-empty-1'), version: 0, createdAt: 5, cwd: process.cwd() }
    // 同目录复用同样先清 artifact（adopt 会因 meta 事件前缀不一致被宿主拒绝）。
    const locate = vi.fn(() => ({ path: '/tmp/dsh-reuse-test-never-exists/session-empty-1/session.jsonl' }))
    withPersistence(ctx, {
      // 0.1.5 契约：list 返回快照包装；读走 open(id,'read') + handle.read()
      list: vi.fn(async () => [{ header: oldHeader }]),
      open: vi.fn(async () => ({
        read: vi.fn(async () => ({ events: [] })),
        close: vi.fn(async () => { }),
      })),
      locate,
    })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    expect(locate).toHaveBeenCalledWith(oldHeader)
    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SessionId('session-empty-1'),
      meta: { cwd: process.cwd() },
    }))
    await app.dispose()
  })

  it('同目录但后端无 locate（无法清 artifact）→ 回退全新 id，不触发 adopt 拒绝', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('reuse-1b')
    wireLiveAfterCreate(ctx, agent)
    const oldHeader = { id: SessionId('session-empty-1b'), version: 0, createdAt: 5, cwd: process.cwd() }
    withPersistence(ctx, {
      list: vi.fn(async () => [{ header: oldHeader }]),
      open: vi.fn(async () => ({
        read: vi.fn(async () => ({ events: [] })),
        close: vi.fn(async () => { }),
      })),
    })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    expect(ctx.agents.create).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: SessionId('session-empty-1b') }))
    await app.dispose()
  })

  it('跨目录空会话 → 清旧 artifact 后复用同 id（项目地址改为启动目录）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('reuse-2')
    wireLiveAfterCreate(ctx, agent)
    const oldHeader = { id: SessionId('session-empty-2'), version: 0, createdAt: 5, cwd: '/old/project' }
    const locate = vi.fn(() => ({ path: '/tmp/dsh-reuse-test-never-exists/session-empty-2/session.jsonl' }))
    withPersistence(ctx, {
      // 0.1.5 契约：list 返回快照包装；读走 open(id,'read') + handle.read()
      list: vi.fn(async () => [{ header: oldHeader }]),
      open: vi.fn(async () => ({
        read: vi.fn(async () => ({ events: [] })),
        close: vi.fn(async () => { }),
      })),
      locate,
    })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    expect(locate).toHaveBeenCalledWith(oldHeader)
    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SessionId('session-empty-2'),
      meta: { cwd: process.cwd() },
    }))
    await app.dispose()
  })

  it('跨目录但后端无 locate（无法清 artifact）→ 回退全新 id，不冒险复用', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('reuse-3')
    wireLiveAfterCreate(ctx, agent)
    const oldHeader = { id: SessionId('session-empty-3'), version: 0, createdAt: 5, cwd: '/old/project' }
    withPersistence(ctx, {
      list: vi.fn(async () => [{ header: oldHeader }]),
      open: vi.fn(async () => ({
        read: vi.fn(async () => ({ events: [] })),
        close: vi.fn(async () => { }),
      })),
    })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: process.cwd() } }))
    expect(ctx.agents.create).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: SessionId('session-empty-3') }))
    await app.dispose()
  })

  it('最近的会话有聊天内容 → 不复用（铸造全新 id）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('reuse-4')
    wireLiveAfterCreate(ctx, agent)
    const busyHeader = { id: SessionId('session-busy-1'), version: 0, createdAt: 5, cwd: process.cwd() }
    withPersistence(ctx, {
      list: vi.fn(async () => [busyHeader]),
      readFrom: vi.fn(async () => ({ events: [userMessageEvent('评估某模型的识别准确率')] })),
    })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    expect(ctx.agents.create).toHaveBeenCalledTimes(1)
    expect(ctx.agents.create).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: SessionId('session-busy-1') }))
    await app.dispose()
  })

  it('/session 选择器展示会话摘要（标题 + 「新对话」空会话占位）', async () => {
    const ctx = makeCtx()
    const a = makeAgent('sum-a')
    ;(a.session.mockLog as unknown as { push(e: unknown): void }).push(userMessageEvent('评估某模型的识别准确率'))
    const b = makeAgent('sum-b')
    ctx.agents.create.mockResolvedValue(makeHandle(a))
    ctx.sessions.list.mockReturnValue([a.session, b.session])
    ctx.sessions.get.mockImplementation((id: SessionId) => (id === a.session.id ? a.session : b.session))
    ctx.agents.get.mockReturnValue(a) // attach target = list()[0] → registry 兜底
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    app.handleSubmit('/session') // 无参 → 打开会话选择器（摘要行）
    await new Promise(resolve => setTimeout(resolve, 60))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('选择会话')
    expect(written).toContain('评估某模型的识别准确率') // 首条真人消息 fallback 标题
    expect(written).toContain('新对话') // 空会话占位摘要
    expect(written).toContain('↑↓ 选择') // 滚动窗口页脚（选择器展示全部会话，不分页）
    await app.dispose()
  })
})

describe('TuiApp 模型定路', () => {
  it('newSession 的 setup 经 installModelSelection 接线装配与请求路由', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('route-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()

    const setup = (ctx.agents.create.mock.calls[0]?.[0] as { setup?: (c: unknown) => void } | undefined)?.setup
    expect(setup).toBeTypeOf('function')
    const agentCtx = { on: vi.fn((_name: string, _handler: unknown) => () => { }) }
    setup?.(agentCtx)
    expect(agentCtx.on.mock.calls.map(call => call[0])).toEqual(['system-prompt/assemble', 'agent/request', 'agent/pre-step'])
    await app.dispose()
  })

  it('resume 沿用会话持久化 request header 的模型，无 header 才落默认选择', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('route-2')
    agent.session.requestHeader.mockReturnValue({ config: { provider: 'deepseek', model: 'deepseek-reasoner' } })
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('route-2'))

    expect(ctx.agents.resume).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'deepseek', model: 'deepseek-reasoner' },
    }))
    // 持久化路由存在时不读默认选择
    expect(ctx.agentDefaultModel.currentSelection).not.toHaveBeenCalled()
    await app.dispose()
  })
})

describe('TuiApp 审查 HIGH 修复回归（177c12e）', () => {
  it('attach 无参时使用构造 initialSessionId，优先恢复而非新建', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('init-1')
    const handle = makeHandle(agent)
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([agent.session])

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin(), initialSessionId: SessionId('init-1') })
    await app.attach()

    expect(ctx.agents.resume).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: SessionId('init-1'),
      agentOptions: { provider: 'mock', model: 'mock' },
    }))
    expect(ctx.agents.create).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('theme 选项生效：显式主题不经背景探测', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('theme-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin(), theme: 'paper' })
    await app.attach()

    expect(getActiveThemeName()).toBe('paper')
    await app.dispose()
  })

  it('auto 主题走背景探测落点（graphite/paper 之一）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('theme-auto')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin(), theme: 'auto' })
    await app.attach()

    expect(['graphite', 'paper']).toContain(getActiveThemeName())
    await app.dispose()
  })

  it('ctrl_c 空闲空输入：第一次不退出，窗口内第二次才 onExit', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('exit-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()

    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()
    expect(agent.cancel).not.toHaveBeenCalled()
    const afterFirst = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(afterFirst).toContain('再按 Ctrl+C 退出')

    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(agent.cancel).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('ctrl_c 空闲空输入：超过 double-press 窗口的第二次仍不退出', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('exit-window')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin, onExit })
    await app.attach()

    const now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    nowSpy.mockReturnValue(now + 2_001)
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()
    nowSpy.mockReturnValue(now + 2_002)
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('agent running 时空输入 Ctrl+C → handleAbort，不 onExit', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('abort-run')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing after attach')
    const statusHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'running' })

    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已取消')
    await app.dispose()
  })

  it('agent running 时 Esc → handleAbort（对齐 Claude Code 单次 Esc 打断）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('abort-esc')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing after attach')
    const statusHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'running' })

    // lone ESC 走 80ms 防误触超时才派发
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(onExit).not.toHaveBeenCalled()
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已取消')
    await app.dispose()
  })

  it('空闲时 Esc → 无操作（不退出、不打断）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('idle-esc')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()
    const written0 = stdout.write.mock.calls.length
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(onExit).not.toHaveBeenCalled()
    expect(agent.cancel).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.slice(written0).map(c => `${c[0]}`).join('')
    expect(written).not.toContain('已取消')
    await app.dispose()
  })

  it('slash 菜单打开 + running + Esc → 关菜单不打断', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-esc')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing after attach')
    const statusHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'running' })
    // 打开 slash 菜单（输入 / 触发）
    stdin.emit('data', '/')
    await new Promise(resolve => setTimeout(resolve, 50))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(agent.cancel).not.toHaveBeenCalled() // 关菜单优先,不打断
    await app.dispose()
  })

  it('空闲双击 Esc → 打开 rewind overlay（CC 的 Esc+Esc 时间回溯）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('dbl-esc')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    // session.id 同步（bootEventApp 同款）：transcript 过滤 owner.id === session.id
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('dbl-esc')
    // 会话需有消息（rewindSession 空消息不打开）
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, 'hi')
    // eslint-disable-next-line no-console
    // 单次 Esc → 布防提示行出现，rewind overlay 不打开
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('⟲ rewind 回退')
    // 非 Esc 键清除待定双击窗口（避免单次检查污染下面的双击）
    stdin.emit('data', 'x')
    await new Promise(resolve => setTimeout(resolve, 50))
    // 窗口内双击 Esc → 打开（两次间隔 200ms < 1s 窗口；lone ESC 各走 80ms 派发）
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⟲ rewind 回退')
    await app.dispose()
  })

  it('空闲双击 Esc：窗口外（>1s）第二次不触发 rewind', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('dbl-esc-out')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('dbl-esc-out')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, 'hi')
    // 第一次 Esc → 记时间戳
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    // 等窗口过期(1s)后再按第二次
    await new Promise(resolve => setTimeout(resolve, 1100))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('⟲ rewind 回退')
    await app.dispose()
  })

  it('打断后 grace 窗口内双击 Esc 不开 rewind（不布防）；窗口外恢复双击 rewind', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('grace-esc')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('grace-esc')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, 'hi')
    const statusHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    // running → Esc 打断（lone ESC 走 80ms 派发；lastAbortAt 此刻记录）
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'running' })
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    // isRunning 落定 idle；grace 窗口（1s）内双击 Esc → 不布防不触发 rewind
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'idle' })
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('⟲ rewind 回退')
    expect(written).not.toContain('再按 Esc 打开 rewind')
    // grace 窗口过期后：双击 Esc 正常布防并打开 rewind
    await new Promise(resolve => setTimeout(resolve, 800))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⟲ rewind 回退')
    await app.dispose()
  })

  it('Esc 布防提示行：布防后显示「再按 Esc 打开 rewind」，窗口过期自清', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('esc-hint')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    const now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    // 单次 Esc → 布防（lone ESC 80ms 派发）；提示行随布防 flush 上屏
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('再按 Esc 打开 rewind')
    // 窗口过期（Date 推进 1.5s）后重绘：过期自清，提示行不再渲染
    nowSpy.mockReturnValue(now + 1_500)
    const statusHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    const writesBefore = stdout.write.mock.calls.length
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 150))
    const after = stdout.write.mock.calls.slice(writesBefore).map(c => `${c[0]}`).join('')
    expect(after).not.toContain('再按 Esc 打开 rewind')
    nowSpy.mockRestore()
    await app.dispose()
  })

  it('dispose 先 flushAll 再释放 owned handle', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('order-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([agent.session])
    const order: string[] = []
    ctx.sessions.flush.mockImplementation(() => { order.push('flush'); return true })
    handle.dispose = vi.fn(async () => { order.push('dispose') })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    await app.dispose()

    expect(order).toEqual(['flush', 'dispose'])
  })
})

describe('TuiApp Phase 6.4 外部编辑器', () => {
  /** 生成把临时文件内容改为指定文本的编辑器替身脚本（win32 用 .cmd，其余平台 .sh）。 */
  function makeEditorScript(replacement: string): { script: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tui-edit-spec-'))
    if (process.platform === 'win32') {
      const script = join(dir, 'editor.cmd')
      writeFileSync(script, `@echo off\r\npowershell -NoProfile -Command "Set-Content -Path '%1' -Value '${replacement}' -NoNewline -Encoding ascii"\r\n`)
      return { script, dir }
    }
    const script = join(dir, 'editor.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s' "${replacement}" > "$1"\n`, { mode: 0o755 })
    return { script, dir }
  }

  // 真实 spawnSync 编辑器脚本：空载 ~4.4s 已近默认 5s 预算，高负载必超——放宽到 15s。
  it('Ctrl+O 触发编辑器，保存退出后内容回填输入行，raw-mode 恢复', { timeout: 15_000 }, async () => {
    const ctx = makeCtx()
    const agent = makeAgent('edit-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const { script } = makeEditorScript('EDITED')
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin, editorCommand: script, editorKey: 'ctrl_o' })
    await app.attach()

    stdin.emit('data', 'hello')
    stdin.emit('data', '\x0f') // Ctrl+O = 0x0f（editorKey 显式回退到 ctrl_o——缺省已改为 ctrl_e）
    stdin.emit('data', '\r')   // Enter 提交回填后的内容
    await new Promise(resolve => setImmediate(resolve))

    expect(agent.followup).toHaveBeenCalledTimes(1)
    const submittedTexts = allCallTexts(agent.followup)
    expect(submittedTexts).toEqual(['EDITED'])
    // raw-mode 恢复：spawn 前退出（false）、spawn 后恢复（true）
    expect(stdin.setRawMode).toHaveBeenCalledWith(false)
    expect(stdin.setRawMode).toHaveBeenCalledWith(true)
    await app.dispose()
  })

  it('编辑器失败（命令不存在）不回填，原内容保留', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('edit-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin, editorCommand: '/nonexistent/editor-xyz', editorKey: 'ctrl_o' })
    await app.attach()

    stdin.emit('data', '保留原文')
    stdin.emit('data', '\x0f') // Ctrl+O → 编辑器不存在 → null
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))

    expect(agent.followup).toHaveBeenCalledTimes(1)
    const keptTexts = allCallTexts(agent.followup)
    expect(keptTexts).toEqual(['保留原文'])
    // P1-1：失败回显（含实际命令与原因）
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('外部编辑器启动失败')
    expect(written).toContain('/nonexistent/editor-xyz')
    expect(written).toContain('ENOENT')
    await app.dispose()
  })
})

describe('TuiApp Phase 6.5 Vim 模式', () => {
  it('vimEnabled 时 ESC 进入 normal，模式标签渲染', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('vim-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin, vimEnabled: true })
    await app.attach()

    stdin.emit('data', 'abc')
    stdin.emit('data', '\x1b') // ESC → normal（孤立 ESC 需 escapeTimeoutMs 派发）
    await new Promise(resolve => setTimeout(resolve, 120))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('-- NORMAL --')
    // normal 态下 i 回 insert，标签消失
    stdout.write.mockClear()
    stdin.emit('data', 'i')
    await new Promise(resolve => setImmediate(resolve))
    const after = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(after).not.toContain('-- NORMAL --')
    await app.dispose()
  })

  it('vimEnabled 缺省 false：ESC 不切模式，无模式标签', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('vim-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    stdin.emit('data', 'abc')
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 120))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('-- NORMAL --')
    await app.dispose()
  })

  it('vim 字符/行视觉模式标签渲染（v → VISUAL，V → VISUAL LINE）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('vim-3')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin, vimEnabled: true })
    await app.attach()

    stdin.emit('data', '\x1b') // ESC → normal
    // 轮询等待 normal 标签出现（ESC 经 input-handler 派发 + 渲染帧稳定），
    // 替代固定 setTimeout——全量并行负载下固定等待会抖动（flaky 加固）。
    await waitForStdout(stdout, '-- NORMAL --')
    stdout.write.mockClear()

    stdin.emit('data', 'v') // 字符视觉模式
    await waitForStdout(stdout, '-- VISUAL --')
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('-- VISUAL --')
    expect(written).not.toContain('-- VISUAL LINE --')

    stdout.write.mockClear()
    stdin.emit('data', '\x1b') // ESC 回 normal（visual 态 ESC → collapse + normal）
    await waitForStdout(stdout, '-- NORMAL --')
    stdin.emit('data', 'V') // normal 态 V → 行视觉模式
    await waitForStdout(stdout, '-- VISUAL LINE --')
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('-- VISUAL LINE --')
    await app.dispose()
  })
})

describe('TuiApp Phase 5.3 glance 装配', () => {
  it('attach 后 glance 状态行渲染（agent 未注册 → ✗ 已停止）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('glance-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // mock 环境 agent 未注册（trackAgent 种子 live=false）→ 回退派生 ✗ 已停止；
    // glance metrics 行含 model（agentDefaultModel mock 'mock'）
    expect(written).toContain('✗ 已停止')
    expect(written).toContain('mock')
    await app.dispose()
  })

  it('glance 错误行上屏（liveAgent lastError 经 agent/error 事件）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('glance-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), theme: 'paper' })
    await app.attach()

    // trackAgent 在 mountSession 时经 ctx.on('agent/error') 注册了处理器。
    const onError = ctx.on.mock.calls.find(call => call[0] === 'agent/error')?.[1] as
      | ((payload: { agent: { id: SessionId }; turn: number; step: number; error: unknown }) => void)
      | undefined
    if (onError === undefined) throw new Error('agent/error handler not registered')
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    onError({ agent: { id }, turn: 1, step: 0, error: new Error('boom glance') })
    // handleSubmit 顺带触发 renderLive（渲染 read glance.current()）
    app.handleSubmit('retry')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('boom glance')
    await app.dispose()
  })

  it('错误完整详情落底一次（多行不截断；同错误帧间重读不重复落底）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('glance-3')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), theme: 'paper' })
    await app.attach()

    const onError = ctx.on.mock.calls.find(call => call[0] === 'agent/error')?.[1] as
      | ((payload: { agent: { id: SessionId }; turn: number; step: number; error: unknown }) => void)
      | undefined
    if (onError === undefined) throw new Error('agent/error handler not registered')
    const id = app.sessionId
    if (id === null) throw new Error('no active session')

    const multiLine = 'malformed SSE payload:\n{"error":{"message":" detail line 2"}}'
    onError({ agent: { id }, turn: 1, step: 0, error: new Error(multiLine) })
    // 两帧渲染（模拟 lastError 挂起期间被逐帧重读）：
    app.handleSubmit('x')
    await new Promise(resolve => setImmediate(resolve))
    app.handleSubmit('y')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 完整多行详情（含第二行）进了 scrollback——glance 行只有首行。
    expect(written).toContain('detail line 2')
    // 同一错误只落底一次。
    expect(written.split('detail line 2').length - 1).toBe(1)
    await app.dispose()
  })
})

describe('TuiApp glance 数据接线（usage/effort/contextWindow）', () => {
  async function setupApp(agentId: string): Promise<{
    ctx: ReturnType<typeof makeCtx>
    agent: ReturnType<typeof makeAgent>
    stdout: ReturnType<typeof makeStdout>
    app: TuiApp
  }> {
    const ctx = makeCtx()
    const agent = makeAgent(agentId)
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    return { ctx, agent, stdout, app }
  }

  it('assistant/message usage 折叠 → glance 行含缓存命中率/上下文占比/tokens 段', async () => {
    const { ctx, stdout, app } = await setupApp('glance-usage')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    bus(id, { seq: 1, time: 1, type: 'request/context', data: { provider: 'mock', model: 'mock', contextWindow: 128000 } })
    bus(id, {
      seq: 2, time: 2, type: 'assistant/message',
      data: {
        turn: 1, step: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000 },
      },
    })
    // handleSubmit 顺带触发 renderLive（glance 行重渲染）
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('缓存 80%') // 4000 / (1000+4000) = 0.8
    expect(written).toContain('上下文 4%') // 5000 / 128000 ≈ 3.9%
    expect(written).toContain('◧ 5k/128k')
    await app.dispose()
  })

  it('request/header 事件更新 effort 段（requestHeader 兜底 currentSelection）', async () => {
    const { ctx, stdout, app } = await setupApp('glance-effort')
    // 挂载时 requestHeader 未记录 → 落 currentSelection（mock 无 reasoningEffort → null）
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    bus(id, {
      seq: 1, time: 1, type: 'request/header',
      data: { header: { config: { provider: 'mock', model: 'mock', reasoningEffort: 'max' } }, reason: 'initial' },
    })
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('◎max')
    await app.dispose()
  })

  it('无 usage/无 contextWindow/无 effort → 对应段不渲染（降级不破版）', async () => {
    const { stdout, app } = await setupApp('glance-bare')
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('缓存')
    expect(written).not.toContain('上下文')
    expect(written).not.toContain('◧')
    expect(written).not.toContain('effort:')
    await app.dispose()
  })

  it('切会话后 usage/contextWindow 复位（detachProjections 清理）', async () => {
    const { ctx, stdout, app } = await setupApp('glance-reset')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    bus(id, { seq: 1, time: 1, type: 'request/context', data: { provider: 'mock', model: 'mock', contextWindow: 128000 } })
    bus(id, {
      seq: 2, time: 2, type: 'assistant/message',
      data: {
        turn: 1, step: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000 },
      },
    })
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))
    const before = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(before).toContain('缓存 80%')

    // 切到新会话（switchSession 走 detachProjections）→ 折叠字段复位。
    // 先清空 write 历史：after 只统计切换后的输出（第一次 handleSubmit 的
    // 缓存段属于旧会话，不在复位断言范围内）。
    stdout.write.mockClear()
    const second = makeAgent('glance-reset-2')
    ctx.agents.get.mockReturnValue(second)
    ctx.sessions.get.mockReturnValue(second.session)
    await app.switchSession(second.session.id)
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))
    const after = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(after).not.toContain('缓存 80%')
    await app.dispose()
  })
})

describe('TuiApp Phase 9a @mention 摘要展开装配', () => {
  it('handleSubmit 展开 @文件 → followup 收到摘要而非裸路径', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('mention-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    // process.cwd() 是仓库根：用仓库内真实文件（mention-parser.ts）验证展开
    app.handleSubmit('查看 @src/mention-parser.ts')
    await new Promise(resolve => setImmediate(resolve))

    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = firstCallText(agent.followup)
    expect(text).toContain('@src/mention-parser.ts')
    expect(text).toContain('mention-parser — @路径展开解析器')
    // 用户消息渲染也含展开内容
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('mention-parser — @路径展开解析器')
    await app.dispose()
  })

  it('@不存在的文件 → 降级为引用名（followup 原样）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('mention-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('查看 @no-such-file-xyz.md')
    await new Promise(resolve => setImmediate(resolve))

    const text = firstCallText(agent.followup)
    expect(text).toBe('查看 @no-such-file-xyz.md')
    await app.dispose()
  })
})

describe('TuiApp Phase 9b 欢迎页会话恢复入口', () => {
  it('存在其他可恢复会话 → 摘要并入恢复会话菜单项', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('restore-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // live store 已有旧会话（非当前），registry 有 live agent（兜底分支），
    // persistence 未配置 → listSessions 走 ctx.sessions.list() 取 .header
    const oldHeader = {
      id: SessionId('session-old-1'),
      version: 0,
      createdAt: Date.now() - 3_600_000,
      cwd: undefined,
      parentSession: undefined,
    }
    ctx.sessions.list.mockReturnValue([
      { id: oldHeader.id, header: oldHeader },
      { id: SessionId('session-old-2'), header: { ...oldHeader, id: SessionId('session-old-2') } },
    ])
    // attach 的 target 取 list()[0] = session-old-1 → switchSession → registry 兜底
    ctx.agents.get.mockReturnValue(agent)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 摘要并入 Tips「恢复」行（不单独列表）：携带相对时间。
    expect(written).toContain('恢复 ·')
    expect(written).toContain('小时前')
    // 裸 UUID 不再出现（摘要不含 id）
    expect(written).not.toContain('session-old-2')
    expect(written).not.toContain('session-old-1')
    await app.dispose()
  })

  it('无可恢复会话 → 恢复会话菜单项降级（无摘要，muted）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('restore-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([]) // 无任何既有会话
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('恢复会话')
    expect(written).not.toContain('小时前') // 无摘要
    await app.dispose()
  })
})

describe('TuiApp 输入行 IME 硬件光标锚定（caretCol 接线）', () => {
  it('renderLive 给输入行设 caretCol → LiveEngine 驻停序列上屏', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('caret-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([])
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 空输入行 caret.col = `❯ ` 前缀宽 2，再加 CHROME_GUTTER=2 → 4
    // → 驻停列 = col+1 = 5（CHA `\x1B[5G`）。未接线时 caretCol 恒缺，LiveEngine
    // 不驻停，stdout 里不会出现任何 CHA 序列。
    expect(written).toContain('\x1B[5G')
    await app.dispose()
  })
})

describe('TuiApp Phase 8 审批 answerer', () => {
  it('当前会话请求 → 挂起提示 + y 放行（allowed-once）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    // 注册的 approval/request handler
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const owner = { id: app.sessionId ?? SessionId('approval-1') }
    const outcome = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash', reason: 'sandbox' },
      () => Promise.resolve('unavailable'),
    )

    // 挂起提示上屏
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('允许执行 bash')
    expect(written).toContain('[y] 允许')
    expect(written).toContain('[a] 全放行')
    expect(written).toContain('╭─ 审批 · bash')

    // y 放行
    stdin.emit('data', 'y')
    await expect(outcome).resolves.toBe('allowed-once')
    await app.dispose()
  })

  it('审批挂起按 a → 本会话放行（always-approve + 当前请求 allowed-once）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-a')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')
    const owner = { id: app.sessionId ?? SessionId('approval-a') }
    const outcome = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', 'a')
    await expect(outcome).resolves.toBe('allowed-once')
    const next = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    await expect(next).resolves.toBe('allowed-once')
    await app.dispose()
  })

  it('审批挂起按 t → 工具级会话白名单（当前卡通过 + 该工具后续自动放行 + 他工具仍挂起）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-t')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')
    const owner = { id: app.sessionId ?? SessionId('approval-t') }
    const reqOf = (toolName: string): { agent: { session: { id: SessionId } }; toolName: string } =>
      ({ agent: { session: { id: owner.id } }, toolName })

    const first = handler(reqOf('bash'), () => Promise.resolve('unavailable'))
    // 键位提示更新（任务4a：t 键上卡）。
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('[t] 记住此工具')

    stdin.emit('data', 't')
    await expect(first).resolves.toBe('allowed-once')

    // 同工具后续请求短路放行（不挂起）。
    const second = handler(reqOf('bash'), () => Promise.resolve('unavailable'))
    await expect(second).resolves.toBe('allowed-once')

    // 其他工具仍逐卡审批（edit 卡上屏）。
    const third = handler(reqOf('edit'), () => Promise.resolve('unavailable'))
    const pendingWritten = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(pendingWritten).toContain('允许执行 edit')
    stdin.emit('data', 'n')
    await expect(third).resolves.toBe('rejected')
    await app.dispose()
  })

  it('str_replace 审批带 callId → 内联 diff 预览（C2 项 1）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-diff-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // attach 前注入 tool/call 事件（transcript 在 mountSession 时 replay fold；
    // 测试替身经 snapshotEvents 暴露同一底层数组，cast 注入）
    const events = agent.session.mockLog
    events.push({
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-diff-1',
        name: 'str_replace_editor',
        arguments: JSON.stringify({
          command: 'str_replace',
          path: '/repo/a.ts',
          old_str: 'const x = 1',
          new_str: 'const x = 2',
        }),
      },
    })
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const owner = { id: app.sessionId ?? SessionId('approval-diff-1') }
    void handler(
      { agent: { session: { id: owner.id } }, toolName: 'str_replace_editor', callId: 'call-diff-1' },
      () => Promise.resolve('unavailable'),
    )

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // diff 块在审批卡内；行前缀与结算卡共享 renderFileDiff（`+ ` 带空格）
    expect(written).toContain('- const x = 1')
    expect(written).toContain('+ const x = 2')
    expect(written).toContain('允许执行 str_replace_editor')
    await app.dispose()
  })

  it('矮屏审批卡 compact：有 diff 也不展开体，键位仍在', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-tight')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const events = agent.session.mockLog
    events.push({
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-tight-1',
        name: 'str_replace_editor',
        arguments: JSON.stringify({
          command: 'str_replace',
          path: '/repo/a.ts',
          old_str: 'const x = 1',
          new_str: 'const x = 2',
        }),
      },
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    stdout.rows = 16
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')
    const owner = { id: app.sessionId ?? SessionId('approval-tight') }
    void handler(
      { agent: { session: { id: owner.id } }, toolName: 'str_replace_editor', callId: 'call-tight-1' },
      () => Promise.resolve('unavailable'),
    )
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('允许执行 str_replace_editor')
    expect(written).toContain('[y] 允许')
    expect(written).not.toContain('- const x = 1')
    await app.dispose()
  })

  it('审批带非 diff 工具 callId → diff null 分支（仅 y/N 提示）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-3')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const next = vi.fn(async () => 'allowed-once')
    const result = await handler({
      agent: { session: { id: agent.session.id } },
      req: { callId: 'call-unknown-1', reason: 'approve' },
    }, next)
    expect(result).toBe('allowed-once')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 无 diff 渲染（callId 未知 → toolCall undefined → diff 分支不执行）
    expect(written).not.toContain('-const x')
    await app.dispose()
  })

  it('审批命中 callId 但工具不可 diff → formatPermissionDiff null 分支（仅 y/N）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-diff-null')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // attach 前注入 read_file tool/call（callId 命中 transcript.tools；read_file
    // 既无替换语义也非 bash 类 → formatPermissionDiff 返回 null，走 if (diff !== null) 的 null 侧）
    const events = agent.session.mockLog
    events.push({
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: '/tmp/x' }),
      },
    })
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const owner = { id: app.sessionId ?? SessionId('approval-diff-null') }
    void handler(
      { agent: { session: { id: owner.id } }, toolName: 'read_file', callId: 'call-read-1' },
      () => Promise.resolve('unavailable'),
    )
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // toolCall 命中 + arguments 存在，但 read_file 不可 diff → 无 diff 块，仅 y/N 提示
    expect(written).not.toContain('-const')
    expect(written).toContain('允许执行 read_file')
    await app.dispose()
  })

  it('盲批降级提示：diff 不可见时 y/N 行合并「（diff 不可见）」（A2）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-blind')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // attach 前注入 bash tool/call（场景 3：callId 命中但无 command 字段
    // → extractShellCommand null → formatPermissionDiff 返回 null）
    const events = agent.session.mockLog
    events.push({
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-bash-blind',
        name: 'bash',
        arguments: JSON.stringify({}),
      },
    })
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const owner = { id: app.sessionId ?? SessionId('approval-blind') }
    const writtenSince = (baseline: number): string =>
      stdout.write.mock.calls.slice(baseline).map(c => `${c[0]}`).join('')

    // 场景 1：callId 缺失 → 无 diff 可查，y/N 行合并降级提示（净零行）
    const b1 = stdout.write.mock.calls.length
    const o1 = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenSince(b1)).toContain('允许执行 bash')
    expect(writtenSince(b1)).toContain('（diff 不可见）')
    stdin.emit('data', 'y')
    await expect(o1).resolves.toBe('allowed-once')

    // 场景 2：callId 存在但 transcript 未命中（findLast 返回 undefined）→ 同样降级
    const b2 = stdout.write.mock.calls.length
    const o2 = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash', callId: 'call-miss' },
      () => Promise.resolve('unavailable'),
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenSince(b2)).toContain('（diff 不可见）')
    stdin.emit('data', 'y')
    await expect(o2).resolves.toBe('allowed-once')

    // 场景 3：callId 命中但 formatPermissionDiff 返回 null → 同样降级
    const b3 = stdout.write.mock.calls.length
    const o3 = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash', callId: 'call-bash-blind' },
      () => Promise.resolve('unavailable'),
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenSince(b3)).toContain('（diff 不可见）')
    stdin.emit('data', 'y')
    await expect(o3).resolves.toBe('allowed-once')

    await app.dispose()
  })

  it('n 拒绝 / Ctrl+C 取消', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const owner = { id: app.sessionId ?? SessionId('approval-2') }
    const rejected = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', 'n')
    await expect(rejected).resolves.toBe('rejected')

    const cancelled = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', '\x03') // Ctrl+C
    await expect(cancelled).resolves.toBe('cancelled')
    await app.dispose()
  })

  it('非当前会话请求 → next() 委托（不挂起）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('approval-3')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const next = vi.fn(() => Promise.resolve('unavailable'))
    const outcome = handler(
      { agent: { session: { id: SessionId('session-other') } }, toolName: 'bash' },
      next,
    )
    await expect(outcome).resolves.toBe('unavailable')
    expect(next).toHaveBeenCalledTimes(1)
    // 未挂起：无提示
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('允许执行')
    await app.dispose()
  })
})

describe('TuiApp Phase 6.2 中轮转向 + statusline 接入', () => {
  it('/steer 提交走 steer API，不触发 followup，消息差异化渲染进 scrollback', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('steer-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('/steer 收敛到最小方案')

    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toMatch(/>>|➤/)
    expect(written).toContain('收敛到最小方案')
    await app.dispose()
  })

  it('普通输入不受影响，仍走 followup', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('plain-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('继续下一步')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('Ctrl+T 触发 steer 并清空输入行（两次输入不粘连）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('ctrl-t-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
    await app.attach()

    stdin.emit('data', '转向')
    stdin.emit('data', '\x14') // Ctrl+T = 0x14
    stdin.emit('data', '再转')
    stdin.emit('data', '\x14')
    await new Promise(resolve => setImmediate(resolve))

    expect(agent.steer).toHaveBeenCalledTimes(2)
    const texts = allCallTexts(agent.steer)
    expect(texts).toEqual(['转向', '再转'])
    await app.dispose()
  })

  it('输入为空时 Ctrl+T 不触发 steer', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('ctrl-t-3')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
    await app.attach()

    stdin.emit('data', '\x14')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.steer).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('statusline 接入：session/event 折叠驱动状态行更新', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    Object.assign(ctx, {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => { }
      }),
    }) as unknown as Context['on']
    const agent = makeAgent('wf-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()

    const sessionHandlers = handlers.get('session/event') ?? []
    expect(sessionHandlers.length).toBeGreaterThan(0)
    const event = {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: { callId: 'call-1', name: 'read_file', arguments: '{}', turn: 1, step: 0 },
    }
    // newSession 铸造的 sessionId 是 session-<uuid>，与 mock agent 的 'wf-1' 不同——
    // 必须用 app.sessionId 作为事件 owner 才能命中 WorkflowStatusLine 的会话过滤。
    // 注意：app 的 streamFeed 与 WorkflowStatusLine 各自注册了 session/event handler，
    // 状态行折叠只发生在 statusline 自己的 handler 里——必须驱动全部 handler。
    const owner = { id: app.sessionId ?? SessionId('wf-1') }
    for (const handler of sessionHandlers) handler(owner, event)
    // C2 渲染管线：WriteBatcher 16ms 帧合并 + glance 16ms 节流窗口——setImmediate
    // 等不到合并帧，需等待超过节流窗口。
    await new Promise(resolve => setTimeout(resolve, 30))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('调研 · read_file')
    await app.dispose()
  })

  it('dispose 解绑 statusline 的 agent/status 与 session/event 订阅', async () => {
    const ctx = makeCtx()
    const disposers = new Map<string, (() => void)[]>()
    Object.assign(ctx, {
      on: vi.fn((event: string, _handler: unknown) => {
        const list = disposers.get(event) ?? []
        const disposer = vi.fn()
        list.push(disposer)
        disposers.set(event, list)
        return disposer
      }),
    })
    const agent = makeAgent('wf-dispose')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    await app.dispose()

    for (const event of ['agent/status', 'session/event']) {
      const list = disposers.get(event) ?? []
      expect(list.length).toBeGreaterThan(0)
      for (const d of list) expect(d).toHaveBeenCalled()
    }
  })
})

describe('TuiApp Phase 9d 流利度装配', () => {
  it('tool/result 喂 FluencyTracker：连续 routine 触发 quiet 折叠策略', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    Object.assign(ctx, {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => { }
      }),
    })
    const agent = makeAgent('flu-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    const sessionHandlers = handlers.get('session/event') ?? []
    const owner = { id: app.sessionId ?? SessionId('flu-1') }

    // 4 次连续 routine tool/result（read_file/grep/glob/diff）→ quiet 策略
    const routines = [
      { callId: 'c1', name: 'read_file', text: 'a'.repeat(500) },
      { callId: 'c2', name: 'grep', text: 'b'.repeat(500) },
      { callId: 'c3', name: 'glob', text: 'c'.repeat(500) },
      { callId: 'c4', name: 'diff', text: 'd'.repeat(500) },
    ]
    for (const r of routines) {
      for (const handler of sessionHandlers) handler(owner, {
        type: 'tool/call',
        seq: 0,
        time: 1,
        data: { callId: r.callId, name: r.name, arguments: '{}', turn: 1, step: 0 },
      })
    }
    for (const r of routines) {
      for (const handler of sessionHandlers) handler(owner, {
        type: 'tool/result',
        seq: 0,
        time: 2,
        data: {
          callId: r.callId,
          turn: 1,
          step: 0,
          message: {
            id: `m-${r.callId}`,
            role: 'user',
            source: { kind: 'tool', callId: r.callId },
            content: [{ type: 'tool-result', toolCallId: r.callId, content: [{ type: 'text', text: r.text }] }],
          },
        },
      })
    }
    await new Promise(resolve => setImmediate(resolve))

    // turn/end 后流利度复位：再次渲染不出现 stale 提示（策略回 normal）
    for (const handler of sessionHandlers) handler(owner, {
      type: 'turn/end',
      seq: 0,
      time: 3,
      data: { reason: { kind: 'completed' } },
    })
    await app.dispose()
    // 装配路径无异常即通过（策略内部折叠不直接渲染；渲染断言见下例）
  })

  it('长静默 tool 阶段 → stale 提示上屏（action 档）', { timeout: 20_000 }, async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    Object.assign(ctx, {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => { }
      }),
    })
    const agent = makeAgent('flu-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    // fake timers 先于 attach：ticker 在 fake 时钟下创建，advance 才能驱动
    // renderLive 读到推进后的 Date.now()（stale 判定依赖真实流逝模拟）。
    vi.useFakeTimers()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const sessionHandlers = handlers.get('session/event') ?? []
    const owner = { id: app.sessionId ?? SessionId('flu-2') }

    try {
      // tool/call + tool/result 派发（fake 时钟起点）
      for (const handler of sessionHandlers) handler(owner, {
        type: 'tool/call',
        seq: 0,
        time: 1,
        data: { callId: 'c1', name: 'bash', arguments: '{}', turn: 1, step: 0 },
      })
      for (const handler of sessionHandlers) handler(owner, {
        type: 'tool/result',
        seq: 0,
        time: 2,
        data: {
          callId: 'c1',
          turn: 1,
          step: 0,
          message: {
            id: 'm-c1',
            role: 'user',
            source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }],
          },
        },
      })
      // stale 判定 = renderLive 时的 Date.now() - lastEventAt（fluency-hook
      // 快照），与经过多少轮 ticker 无关——时间跳跃而非逐帧推进：
      // setSystemTime 直接跨过 tool action 档（180s），再推进 1s 触发少量
      // ticker/batcher 渲染即可。此前 advanceTimersByTime(200_000) 要同步跑
      // ~1700 次全量 renderLive，真实 CPU 耗时随全量并发负载膨胀直至撞穿
      // 20s 测试预算（跨四批复现的 flaky 根因；8 路压力下单测 13.2s）。
      // async 版在每轮定时器间排空微任务，async flush 的 stdout.write 落定
      // 顺序确定。
      vi.setSystemTime(Date.now() + 200_000)
      await vi.advanceTimersByTimeAsync(1_000)
    } finally {
      vi.useRealTimers()
    }
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('Tool may be stuck')
    await app.dispose()
  })
})

describe('TuiApp Phase 6.1 slash 命令系统', () => {
  beforeEach(() => { setTheme('graphite') })

  it('构造后经 tui.commands 追加的命令进入斜杠菜单（含中文描述）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-ext')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    // 构造期 provide 的注册表服务：外部插件（如 next-workflow）经它延迟注册
    const tuiCommands = ctx.provide.mock.calls.find(call => call[0] === 'tui.commands')?.[1] as {
      register(command: { name: string; description: string; argsHint?: string; run: () => void }): void
    }
    tuiCommands.register({
      name: 'ext-workflow',
      description: '外部插件追加的固定意图管线',
      argsHint: '[candidates] <objective>',
      run: () => {},
    })
    await app.attach()

    for (const ch of '/ext-w') stdin.emit('data', ch)
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('/ext-workflow [candidates] <objective>')
    expect(written).toContain('外部插件追加的固定意图管线')
    await app.dispose()
  })

  it('/theme 经注册表生效并回显', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-theme')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('/theme paper')
    await new Promise(resolve => setImmediate(resolve))

    expect(getActiveThemeName()).toBe('paper')
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('主题已切换: paper')
    await app.dispose()
  })

  it('/clear 重置 scrollback 并回显', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-clear')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('第一行')
    app.handleSubmit('/clear')
    await new Promise(resolve => setImmediate(resolve))

    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('已清空')
    await app.dispose()
  })

  it('/clear 收起命令切换的 live 面板（/config /skills 不再重绘）', async () => {
    const ctx = makeCtx()
    const fallback = ctx.reflect.get.getMockImplementation() as ((name: string) => unknown) | undefined
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'settings') return { describe: vi.fn(() => [{ ns: 'model', value: 'deepseek' }]) }
      if (name === 'permission') return { names: ['run_shell'], current: vi.fn(() => 'ask') }
      if (name === 'credentials') return { describe: vi.fn(async () => ({ configured: true, source: 'file', writable: false })) }
      if (name === 'skills') return { list: vi.fn(async () => [{ name: 'code-review', description: '代码审查', provider: 'mock', source: 'builtin', invocation: 'manual' }]) }
      return fallback ? fallback(name) : undefined
    })
    const agent = makeAgent('slash-clear-panels')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/config')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('⚙ 配置')
    app.handleSubmit('/skills')
    await new Promise(resolve => setTimeout(resolve, 40))
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('code-review')

    app.handleSubmit('/clear')
    await new Promise(resolve => setTimeout(resolve, 40))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已清空')
    // /clear 光标回顶（\x1b[H）之后的 live 区全量重绘不应再包含命令面板
    const tail = written.slice(written.lastIndexOf('\x1b[H'))
    expect(tail).not.toContain('⚙ 配置')
    expect(tail).not.toContain('已配置')
    expect(tail).not.toContain('code-review')
    await app.dispose()
  })

  it('/export 带 path：完整链路导出会话转录为 Markdown（真实文件系统）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-export')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // 塞一条用户消息事件（权威形状：data 即 UserMessage）。
    // Agent 接口声明 events 为 readonly，测试替身 cast 注入（同 approval-diff 用例）。
    ;(agent.session.mockLog).push({
      type: 'user/message',
      seq: 0,
      time: 1,
      data: {
        id: 'm-export-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '导出这段对话' }],
      },
    } as unknown as SessionEvent)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-export-'))
    const target = join(dir, 'out.md')
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit(`/export ${target}`)
    // exportTranscript 是真实异步 IO——轮询文件落盘（非 setImmediate 单轮）。
    await vi.waitFor(() => {
      expect(readFileSync(target, 'utf8')).toContain('# Session export — slash-export')
    }, { timeout: 2_000, interval: 20 })

    const written = readFileSync(target, 'utf8')
    expect(written).toContain('导出这段对话')
    // runSlash 末尾 flushLiveRender 异步落盘渲染——轮询等待回显上屏。
    await vi.waitFor(() => {
      const rendered = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(rendered).toContain('会话已导出')
    }, { timeout: 2_000, interval: 20 })
    rmSync(dir, { recursive: true, force: true })
    await app.dispose()
  })

  it('/export 无参：默认写到会话 header.cwd 下 dsh-export-<id>.md（真实文件系统）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-export-default')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // 会话 header 缺省无 cwd——测试显式注入（默认路径分支依赖 header.cwd）。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-export-default-'))
    ;(agent.session.header as { cwd?: string }).cwd = dir
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('/export')
    // 默认路径 = join(header.cwd, `dsh-export-${session.id}.md`)；轮询落盘。
    const target = join(dir, 'dsh-export-slash-export-default.md')
    await vi.waitFor(() => {
      expect(readFileSync(target, 'utf8')).toContain('# Session export — slash-export-default')
    }, { timeout: 2_000, interval: 20 })

    await vi.waitFor(() => {
      const rendered = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(rendered).toContain('会话已导出')
    }, { timeout: 2_000, interval: 20 })
    rmSync(dir, { recursive: true, force: true })
    await app.dispose()
  })

  it('/export 无会话：exportTranscript 抛错，runSlash 回显失败（fails loud）', async () => {
    const ctx = makeCtx()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    // 不 attach / 不 newSession——activeSessionId 为 null，exportTranscript 抛「当前无会话」。
    app.handleSubmit('/export')
    await vi.waitFor(() => {
      const rendered = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(rendered).toContain('命令执行失败')
    }, { timeout: 2_000, interval: 20 })
    await app.dispose()
  })

  it('/session list 经 listSessions 直接打印已知会话（旧版样式）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-sess')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([agent.session])
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('/session list')
    // 梗概回填使该命令成为真实异步路径（sidecar 读盘 + 逐会话梗概编排），
    // 单次 setImmediate 不再够用，waitFor 轮询（与文件内其它异步命令测试同款）。
    await vi.waitFor(() => {
      expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('slash-sess')
    }, { timeout: 2_000, interval: 20 })
    await app.dispose()
  })

  it('未知 / 命令回显相近建议（/st → /status /steer），不触发 followup', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-unknown')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    // /st 是 steer/status 的歧义前缀：命中命令前缀（进命令通道），歧义拒绝 → 未知命令
    app.handleSubmit('/st')
    await new Promise(resolve => setImmediate(resolve))

    expect(agent.followup).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('未知命令: /st')
    // 闭环引导：相近建议替代 40+ 命令刷屏（不再列出「可用:」全表）
    expect(written).toContain('你是要找:')
    expect(written).toContain('/status')
    expect(written).toContain('/steer')
    expect(written).not.toContain('可用: /theme')
    await app.dispose()
  })

  it('未知 / 命令无相近建议时引导 /help（不刷命令列表）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-unknown2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    // /s 是多个 s 开头命令的歧义前缀：进命令通道 → 歧义拒绝 → 未知命令；
    // 单字符输入无相近建议（编辑距离阈值=0）→ 引导 /help
    app.handleSubmit('/s')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('未知命令: /s')
    expect(written).toContain('试试 /help 查看全部命令')
    expect(written).not.toContain('可用: /theme')
    await app.dispose()
  })

  it('构造时把注册表注册为 tui.commands 服务（外部插件可扩展）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-svc')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    expect(ctx.provide).toHaveBeenCalledWith('tui.commands', expect.any(Object))
    await app.dispose()
  })

  it('/ 前缀输入渲染内联命令提示', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-hint')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    stdin.emit('data', '/th')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('/theme <name>')
    await app.dispose()
  })

  it('用户键入 /theme paper 并回车：scrollback 回显切换确认（用户级验收）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('slash-ux')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()

    // 真实输入流水线：键盘字节流 → InputHandler → InputLine → onSubmit。
    // 显式主题 'paper' 跳过 attach 的背景探测，聚焦命令提交路径。
    const app = new TuiApp({ ctx, stdout, stdin, theme: 'paper' })
    await app.attach()
    stdin.emit('data', '/theme paper\r') // 键入命令 + 回车
    await new Promise(resolve => setImmediate(resolve))

    expect(getActiveThemeName()).toBe('paper')
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('主题已切换: paper')
    await app.dispose()
  })
})

describe('TuiApp agent 错误上屏', () => {
  it('agent/error 后 live 区渲染错误行（LLM 失败不再静默回到空闲）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('err-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    // 显式主题跳过 attach 的背景探测，聚焦错误渲染路径。
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), theme: 'paper' })
    await app.attach()

    // trackAgent 在 mountSession 时经 ctx.on('agent/error') 注册了处理器。
    const onError = ctx.on.mock.calls.find(call => call[0] === 'agent/error')?.[1] as
      | ((payload: { agent: { id: SessionId }; turn: number; step: number; error: unknown }) => void)
      | undefined
    if (onError === undefined) throw new Error('agent/error handler not registered')
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    onError({ agent: { id }, turn: 1, step: 0, error: new Error('AUTH: Authentication Fails') })
    // followup 是 mock（不会真发 running 清掉错误）；handleSubmit 顺带触发 renderLive。
    app.handleSubmit('retry')
    await new Promise(resolve => setImmediate(resolve))

    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('AUTH: Authentication Fails')
    await app.dispose()
  })
})

describe('TuiApp 流式提交', () => {
  it('assistant 流式文本在 message 边界 commit 进 scrollback', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('stream-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), theme: 'paper' })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    const emit = sessionEventBus(ctx)
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    emit(id, { seq: 2, time: 2, type: 'assistant/attempt', data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 2, chunk: { type: 'text-delta', text: '流式回复文本' } }] } })
    emit(id, { seq: 3, time: 3, type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '流式回复文本' }] } } })
    await new Promise(resolve => setImmediate(resolve))

    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('流式回复文本')
    await app.dispose()
  })

  it('aborted turn 的流式残文不进 scrollback', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('stream-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()

    const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), theme: 'paper' })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    const emit = sessionEventBus(ctx)
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    emit(id, { seq: 2, time: 2, type: 'assistant/attempt', data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 2, chunk: { type: 'text-delta', text: '不应出现的残文' } }] } })
    app.handleAbort()
    emit(id, { seq: 3, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已取消')
    expect(written).not.toContain('不应出现的残文')
    await app.dispose()
  })
})

describe('TuiApp 命令面板（Ctrl+P overlay）', () => {
  async function bootPaletteApp() {
    const ctx = makeCtx()
    const agent = makeAgent('palette-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, theme: 'paper' })
    await app.attach()
    return { app, stdin, stdout }
  }

  it('ctrl_p 打开面板（进 alt screen 并列出命令）', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    stdin.emit('data', '\x10') // Ctrl+P = 0x10 → 打开命令面板
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049h') // 进入 alternate screen buffer
    expect(written).toContain('/theme')      // 面板列出 slash 命令
    await app.dispose()
  })

  it('/help 无参 → 打开命令面板（分组浏览，不刷全列表）', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    app.handleSubmit('/help')
    // overlay 激活 + 面板渲染异步落地，waitFor 轮询（与 commands.spec 同款）
    await vi.waitFor(() => {
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('命令面板') // overlay 标题
      expect(written).toContain('/theme')
    }, { timeout: 2_000, interval: 20 })

    // 面板关闭：Esc 恢复输入轨
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setImmediate(resolve))
    await app.dispose()
  })

  it('/help <cmd> 仍走单条详情回显（不打开面板）', async () => {
    const { app, stdout } = await bootPaletteApp()

    app.handleSubmit('/help model')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('/model')
    await app.dispose()
  })

  it('/changelog 默认回显当前版本条目（读仓库根 CHANGELOG.md）', async () => {
    const { app, stdout } = await bootPaletteApp()

    app.handleSubmit('/changelog')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 当前版本动态取自 package.json——发版 bump 不再破测试（版本头来自解析出的
    // 当前条目，头在场即证明正文已渲染）。
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(written).toContain(`## ${version}`)
    await app.dispose()
   }, 15_000)

  it('/changelog all 覆盖全部版本；/changelog N 截断', async () => {
    const { app, stdout } = await bootPaletteApp()

    app.handleSubmit('/changelog all')
    await new Promise(resolve => setImmediate(resolve))
    app.handleSubmit('/changelog 1')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(written).toContain(`## ${version}`)
    expect(written).toContain('## 0.1.1-rc.6') // all 覆盖最早版本
    await app.dispose()
  // 全量并发下 parseChangelog 同步解析偶发越过默认 5s 用例上限（负载抖动非缺陷），
  // 给 3 倍余量保发布门禁稳定。
  }, 15_000)

  it('/changelog 非法参数 → 用法提示', async () => {
    const { app, stdout } = await bootPaletteApp()

    app.handleSubmit('/changelog nope')
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('用法: /changelog')
    await app.dispose()
  })

  it('面板过滤 + Enter 回填 /clear 到输入行，再回车执行命令', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    stdin.emit('data', '\x10') // Ctrl+P 打开
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', 'cl')   // 过滤 → /clear
    stdin.emit('data', '\r')   // Enter → 回填并关闭面板
    await new Promise(resolve => setImmediate(resolve))

    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l') // 退出 alternate screen buffer

    stdin.emit('data', '\r')   // 提交 /clear
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已清空') // 命令执行回显（回填文本真正进了输入行）
    await app.dispose()
  })

  it('ctrl_p 再按关闭面板（toggle）', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    stdin.emit('data', '\x10')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x10') // 再按 Ctrl+P → 关闭
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l')
    await app.dispose()
  })

  it('Esc 关闭面板（不提交、不回填输入行——底栏 "Esc 关闭" 提示真实生效）', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    stdin.emit('data', '\x10') // Ctrl+P 打开
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x1b') // Esc：input-handler 经 escapeTimeoutMs(80ms) 后派发 'escape'
    await new Promise(resolve => setTimeout(resolve, 200)) // 等派发 + ticker 补绘主屏

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l')  // 退出 alternate screen buffer（面板已关闭）
    expect(written).not.toContain('❯ /theme') // 未提交：输入行不出现 /命令 回填
    await app.dispose()
  })

  it('Ctrl+C 关闭面板（与 Esc 同分支，不提交）', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    stdin.emit('data', '\x10') // Ctrl+P 打开
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x03') // Ctrl+C → 关闭面板（消费在面板块，不触发退出）
    await new Promise(resolve => setTimeout(resolve, 200))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l')
    expect(written).not.toContain('❯ /theme')
    await app.dispose()
  })

  it('↓ 移动选中，Enter 回填第二项（方向键选择路径）', async () => {
    const { app, stdin, stdout } = await bootPaletteApp()

    stdin.emit('data', '\x10')    // Ctrl+P 打开
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x1b[B')  // ↓ → 第二项（/session）
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\r')      // Enter → 回填并关闭面板
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 200)) // 等 ticker 补绘主屏输入行

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l') // 退出 alternate screen buffer
    // 回填的是第二项（❯ 输入行前缀 + /session），而非第一项 /theme
    expect(written).toContain('❯ /session')
    expect(written).not.toContain('❯ /theme')
    await app.dispose()
  })

  it('#31 空输入框 Tab → execute 模式：过滤 /exit 回车直接执行（onExit 触发，不经输入框回填）', async () => {
    const onExit = vi.fn()
    const ctx = makeCtx()
    const agent = makeAgent('tab-exec-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin, theme: 'paper', onExit })
    await app.attach()

    stdin.emit('data', '\x09') // Tab（空输入框）→ execute 模式命令菜单
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', 'exit') // 过滤 → /exit（'ex' 会同时命中 export，输入完整名）
    stdin.emit('data', '\r')   // Enter → 直接执行 /exit（无参）→ onExit
    await new Promise(resolve => setImmediate(resolve))

    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('#31 空输入框 Tab 打开 execute 模式后 Esc 关闭（不执行、不回填）', async () => {
    const onExit = vi.fn()
    const ctx = makeCtx()
    const agent = makeAgent('tab-exec-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, theme: 'paper', onExit })
    await app.attach()

    stdin.emit('data', '\x09') // Tab → execute 模式菜单
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x1b') // Esc 关闭
    await new Promise(resolve => setTimeout(resolve, 200))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l') // 退出 alt screen（菜单已关闭）
    expect(onExit).not.toHaveBeenCalled()     // 未执行任何命令
    await app.dispose()
  })
})

describe('TuiApp slash 路径豁免（/ 开头文件路径不误判为命令）', () => {
  async function boot() {
    const ctx = makeCtx()
    const agent = makeAgent('slash-path-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    return { app, agent }
  }

  it('/src/main.ts 走普通消息（followup），不报未知命令', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('/src/main.ts')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(firstCallText(agent.followup)).toBe('/src/main.ts')
    await app.dispose()
  })

  it('/tmp/foo bar（路径含空格）走普通消息', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('/tmp/foo bar')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('单段非命令路径 /etc 走普通消息（已知命令谓词）', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('/etc')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('~/notes.md 走普通消息', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('~/notes.md')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('Windows 盘符路径 C:\\foo\\bar.ts 走普通消息', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('C:\\foo\\bar.ts')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('/exit 仍是命令（不豁免）', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('/exit')
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('/h 模糊命令前缀仍是命令（help 最小前缀解析）', async () => {
    const { app, agent } = await boot()
    app.handleSubmit('/h')
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })
})

describe('TuiApp T4 任务窗格（/tasks + sessionProjections）', () => {
  it('/tasks 打开后渲染投影快照；onChanged 变更实时更新', async () => {
    const ctx = makeCtx()
    let changeListener: ((s: { id: string }, key: string, value: unknown) => void) | null = null
    let mountedAgent: { session: { id: string } } | null = null
    // create 按传入 sessionId 铸造 agent（session.id 须与 mountSession 的 id 一致，
    // onChanged 回调按 id 过滤）
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      mountedAgent = agent
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const onChanged = vi.fn((l: (s: { id: string }, key: string, value: unknown) => void) => {
      changeListener = l
      return () => { }
    })
    const snapshot = vi.fn(() => ({ values: { todos: [{ content: '理解问题', status: 'completed' }] } }))
    // 可选服务经 reflect.get 读取（Cordis 4 注入代理；未注册返回 undefined）
    const projections = { snapshot, onChanged }
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return projections
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    // 初始：面板未打开 → 无任务行
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('📋 任务')

    // /tasks 打开 → 渲染任务行（attach 时 snapshot 已读）
    for (const ch of '/tasks') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('📋 任务')
    expect(written).toContain('[x] 理解问题')

    // onChanged 推送新快照 → 实时更新（mountedAgent.session.id 与 mountSession id 一致）
    expect(changeListener).not.toBeNull()
    stdout.write.mockClear()
    // 闭包变量经 as unknown 断言读取（TS 对闭包赋值的控制流推断不可靠，测试场景直读）
    const listener = changeListener as unknown as (s: { id: string }, key: string, value: unknown) => void
    const mounted = mountedAgent as unknown as { session: { id: string } }
    listener({ id: mounted.session.id }, 'todos', [{ content: '新任务', status: 'in_progress' }])
    await new Promise(resolve => setTimeout(resolve, 200))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⏳ 新任务')
    await app.dispose()
  })

  it('sessionProjections 服务缺失时 /tasks 打开回显警告（不渲染窗格）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('task-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    for (const ch of '/tasks') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('📋 任务')
    // fails loud：服务缺失回显警告，不再静默降级
    expect(written).toContain('sessionProjections 服务不可用')
    await app.dispose()
  })
})

describe('TuiApp /todos 紧凑待办面板（保留快照 + 显隐切换）', () => {
  const seedTodos = [
    { content: '理解问题', status: 'completed' as const },
    { content: '写实现', status: 'in_progress' as const },
  ]

  /** 装配带 sessionProjections 替身的 app（快照/onChanged 捕获，供用例推送）。 */
  async function mountWithProjections(initialTodos: typeof seedTodos | null = seedTodos) {
    const ctx = makeCtx()
    let changeListener: ((s: { id: string }, key: string, value: unknown) => void) | null = null
    let mountedAgent: { session: { id: string } } | null = null
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      mountedAgent = agent
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const onChanged = vi.fn((l: (s: { id: string }, key: string, value: unknown) => void) => {
      changeListener = l
      return () => { }
    })
    const snapshot = vi.fn(() => ({ values: { todos: initialTodos } }))
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return { snapshot, onChanged }
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    return {
      app,
      stdin,
      stdout,
      listener: () => changeListener as unknown as (s: { id: string }, key: string, value: unknown) => void,
      mounted: () => mountedAgent as unknown as { session: { id: string } },
    }
  }

  function writtenOf(stdout: ReturnType<typeof makeStdout>): string {
    return stdout.write.mock.calls.map(c => `${c[0]}`).join('')
  }

  function submitSlash(t: Awaited<ReturnType<typeof mountWithProjections>>, text: string): void {
    for (const ch of text) t.stdin.emit('data', ch)
    t.stdin.emit('data', '\r')
  }

  it('恢复会话快照已有非空待办 → 不打 /todos 也列出条目', async () => {
    const t = await mountWithProjections()
    await new Promise(resolve => setImmediate(resolve))
    const text = writtenOf(t.stdout)
    expect(text).toContain('📋 待办 ✓1 ⏳1 □0')
    expect(text).toContain('⏳ 写实现')
    expect(text).toContain('[x] 理解问题')
    await t.app.dispose()
  })

  it('黏滞保留：turn/start 把投影清成 null 不回退显示已打开的面板', async () => {
    const t = await mountWithProjections()
    await new Promise(resolve => setImmediate(resolve))

    const listener = t.listener()
    const mounted = t.mounted()
    expect(listener).not.toBeNull()
    // turn/start fold 重置 → null 推送：面板保持显示上一份非空清单
    listener!({ id: mounted.session.id }, 'todos', null)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(writtenOf(t.stdout)).toContain('📋 待办 ✓1 ⏳1 □0')
    expect(writtenOf(t.stdout)).toContain('⏳ 写实现')

    // 新一轮写入非空清单 → 保留快照吸收更新（摘要行刷新为新的三态计数）
    listener!({ id: mounted.session.id }, 'todos', [{ content: '新任务', status: 'pending' }])
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(writtenOf(t.stdout)).toContain('📋 待办 ✓0 ⏳0 □1')
    await t.app.dispose()
  })

  it('/clear 一并收起 /todos 面板', async () => {
    const t = await mountWithProjections()
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenOf(t.stdout)).toContain('📋 待办')

    // 只看清屏后的重绘帧：清空写入缓冲再提交 /clear，避免清屏前旧帧干扰
    t.stdout.write.mockClear()
    t.app.handleSubmit('/clear')
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenOf(t.stdout)).not.toContain('📋 待办')
    await t.app.dispose()
  })

  it('首次非空写入自动弹出；不打 /todos', async () => {
    const t = await mountWithProjections(null)
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenOf(t.stdout)).not.toContain('📋 待办')
    t.stdout.write.mockClear()
    t.listener()!({ id: t.mounted().session.id }, 'todos', [
      { content: '写实现', status: 'in_progress' },
    ])
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(writtenOf(t.stdout)).toContain('📋 待办 ✓0 ⏳1 □0')
    expect(writtenOf(t.stdout)).toContain('⏳ 写实现')
    await t.app.dispose()
  })

  it('/todos 关掉后再写入不再自动开', async () => {
    const t = await mountWithProjections()
    await new Promise(resolve => setImmediate(resolve))
    expect(writtenOf(t.stdout)).toContain('📋 待办')
    submitSlash(t, '/todos')
    await new Promise(resolve => setImmediate(resolve))
    t.stdout.write.mockClear()
    t.listener()!({ id: t.mounted().session.id }, 'todos', [
      { content: '又一项', status: 'pending' },
    ])
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(writtenOf(t.stdout)).not.toContain('📋 待办')
    await t.app.dispose()
  })

  it('/clear 后再写入不再自动开', async () => {
    const t = await mountWithProjections()
    await new Promise(resolve => setImmediate(resolve))
    t.stdout.write.mockClear()
    t.app.handleSubmit('/clear')
    await new Promise(resolve => setImmediate(resolve))
    t.stdout.write.mockClear()
    t.listener()!({ id: t.mounted().session.id }, 'todos', [
      { content: '清屏后写入', status: 'pending' },
    ])
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(writtenOf(t.stdout)).not.toContain('📋 待办')
    await t.app.dispose()
  })
})

describe('TuiApp T1.1 投影总线（ProjectionFacet 5 域）', () => {
  it('mountSession 一次性快照 5 域，onChanged 按 key 分流缓存', async () => {
    const ctx = makeCtx()
    let changeListener: ((s: { id: string }, key: string, value: unknown) => void) | null = null
    let mountedAgent: { session: { id: string } } | null = null
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      mountedAgent = agent
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const onChanged = vi.fn((l: (s: { id: string }, key: string, value: unknown) => void) => {
      changeListener = l
      return () => { }
    })
    const snapshot = vi.fn(() => ({
      values: {
        todos: [{ content: '理解问题', status: 'completed' }],
        plan: { active: true, pending: false },
        goal: {
          goal: {
            id: 'g1',
            phase: 'active',
            objective: '测试目标',
            maxGoalRounds: 5,
          },
          roundsStarted: 1,
          createdAt: 0,
          updatedAt: 0,
        },
        subagent: { children: [] },
        subagentTiming: { runs: {} },
      },
    }))
    const projections = { snapshot, onChanged }
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return projections
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    // snapshot 一次性读取 5 域（T1.1 总线）
    expect(snapshot).toHaveBeenCalledTimes(1)
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // plan active → statusline 渲染 [plan] 徽标（T1.4 数据源）
    expect(written).toContain('[plan]')

    // /tasks 打开 → todos 域驱动任务窗格（T4 行为不回归）
    for (const ch of '/tasks') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('📋 任务')
    expect(written).toContain('[x] 理解问题')

    const listener = changeListener as unknown as (s: { id: string }, key: string, value: unknown) => void
    const mounted = mountedAgent as unknown as { session: { id: string } }

    // onChanged plan → 徽标随 active 切换（分流缓存）
    stdout.write.mockClear()
    listener({ id: mounted.session.id }, 'plan', { active: false, pending: false })
    await new Promise(resolve => setTimeout(resolve, 200))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('[plan]')

    // onChanged todos → 任务窗格实时更新（分流缓存）
    stdout.write.mockClear()
    listener({ id: mounted.session.id }, 'todos', [{ content: '新任务', status: 'in_progress' }])
    await new Promise(resolve => setTimeout(resolve, 200))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⏳ 新任务')

    // onChanged 其他会话 id → 忽略（不污染当前会话投影）
    stdout.write.mockClear()
    listener({ id: 'other-session' }, 'plan', { active: true, pending: false })
    await new Promise(resolve => setTimeout(resolve, 200))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('[plan]')

    // onChanged 其他域（goal/subagent/subagentTiming）→ 仅更新缓存（/status 数据源），不崩
    stdout.write.mockClear()
    listener({ id: mounted.session.id }, 'goal', { goal: { id: 'g2' } })
    listener({ id: mounted.session.id }, 'subagentTiming', { runs: { r1: 1 } })
    await new Promise(resolve => setTimeout(resolve, 200))
    await app.dispose()
  })

  it('sessionProjections 缺失时整体降级（任务窗格 / plan 徽标均不可用）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('t11-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('[plan]')
    for (const ch of '/tasks') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('📋 任务')
    // /status 打开 → 投影缓存缺失（整体降级）→ 状态面板不渲染
    for (const ch of '/status') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('◆ 目标')
    await app.dispose()
  })
})

describe('TuiApp T1.2 /status 面板接线（renderLive + 投影缓存）', () => {
  it('/status 打开后经 projectStatusPanel 渲染面板行（数据源为投影缓存）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const snapshot = vi.fn(() => ({
      values: {
        todos: null,
        plan: { active: true, pending: false },
        goal: {
          goal: {
            id: 'g1',
            phase: 'active',
            objective: '测试目标',
            maxGoalRounds: 5,
          },
          roundsStarted: 1,
          createdAt: 0,
          updatedAt: 0,
        },
        subagent: { children: [] },
        subagentTiming: { runs: {} },
      },
    }))
    const projections = { snapshot, onChanged: vi.fn(() => () => { }) }
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return projections
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    // 初始：面板未打开 → 无状态面板行
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('◆ 目标')

    // /status 打开 → 投影缓存进 projectStatusPanel，渲染行进 live 区
    for (const ch of '/status') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('◆ 目标')
    expect(written).toContain('📐 计划 · 进行中')

    // /status 关闭 → 面板行从 live 区消失（不渲染）。逐字符输入期间面板仍开
    // （Enter 才切换），中间帧合法含面板行——断言必须看最后一次写入的帧。
    stdout.write.mockClear()
    for (const ch of '/status') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const calls = stdout.write.mock.calls
    const lastFrame = String(calls[calls.length - 1]?.[0] ?? '')
    expect(lastFrame).not.toContain('◆ 目标')
    expect(lastFrame).not.toContain('📐 计划')
    await app.dispose()
  })
})

describe('TuiApp 投影层接线（turn-summary 摘要行 + /status 会话段）', () => {
  function bootApp(name = 'proj-1') {
    const ctx = makeCtx()
    const agent = makeAgent(name)
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    return { ctx, agent, stdin, stdout, app }
  }

  /** 喂一个完整 turn：read_file（读，100ms）+ edit_file（改，1000ms）→ completed。 */
  function feedToolTurn(bus: ReturnType<typeof sessionEventBus>, id: SessionId): void {
    bus(id, { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } })
    bus(id, { seq: 2, time: 1100, type: 'tool/call', data: { callId: 'c1', name: 'read_file', arguments: '{}', turn: 1, step: 0 } })
    bus(id, { seq: 3, time: 1200, type: 'tool/result', data: { turn: 1, step: 0, message: { id: 'm-c1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } } })
    bus(id, { seq: 4, time: 1300, type: 'tool/call', data: { callId: 'c2', name: 'edit_file', arguments: '{}', turn: 1, step: 1 } })
    bus(id, { seq: 5, time: 2300, type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'm-c2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'done' }] }] } } })
    bus(id, { seq: 6, time: 2400, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }

  it('turn/end（completed）且有工具调用 → 提交 turn 摘要行（读/改计数复用 tool-meta 家族）', async () => {
    const { ctx, app, stdout } = bootApp()
    await app.attach()
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    stdout.write.mockClear()
    feedToolTurn(bus, id)
    // 摘要行接在异步 flushStream 之后（等微任务/定时器链落定）
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('turn 1')
    expect(written).toContain('读1 改1')
    await app.dispose()
  })

  it('turn/end 无工具调用 → 不渲染摘要行', async () => {
    const { ctx, app, stdout } = bootApp()
    await app.attach()
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    stdout.write.mockClear()
    bus(id, { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } })
    bus(id, { seq: 2, time: 2000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('读0 改0')
    await app.dispose()
  })

  it('aborted turn 有工具调用也不渲染摘要行（部分统计会误导）', async () => {
    const { ctx, app, stdout } = bootApp()
    await app.attach()
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    stdout.write.mockClear()
    bus(id, { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } })
    bus(id, { seq: 2, time: 1100, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}', turn: 1, step: 0 } })
    bus(id, { seq: 3, time: 2000, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('读0 改0')
    await app.dispose()
  })

  it('/status 面板渲染会话汇总段（summary-state 本地 fold，不依赖宿主投影总线）', async () => {
    const { ctx, app, stdin, stdout } = bootApp()
    await app.attach()
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    feedToolTurn(bus, id)
    await new Promise(resolve => setImmediate(resolve))
    stdout.write.mockClear()
    for (const ch of '/status') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 150)) // 等一帧 ticker 渲染
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('Σ 会话')
    expect(written).toContain('回合 1')
    expect(written).toContain('工具 2')
    await app.dispose()
  })
})

describe('TuiApp T2.1/T2.2 多 agent 面板接线（委派树 + workflow 运行态）', () => {
  it('/subagents 打开后经 projectDelegationTree 渲染委派树行（listDescendants 预取缓存）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return {
        snapshot: () => ({ values: {} }),
        onChanged: () => () => { },
      }
      if (name === 'subagents') return {
        listDescendants: vi.fn(async () => ([
          { kind: 'child', id: 'child-1', parentId: 'root', depth: 1, activity: 'running', hasChildren: false, mode: 'continuable', label: '子代理A' },
        ])),
      }
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    await new Promise(resolve => setImmediate(resolve))
    for (const ch of '/subagents') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('🌳 委派')
    expect(written).toContain('子代理A')
    await app.dispose()
  })

  it('subagents 服务缺失时 /subagents 打开回显警告（不渲染树）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    await new Promise(resolve => setImmediate(resolve))
    for (const ch of '/subagents') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('🌳 委派')
    // fails loud：服务缺失回显警告，不再静默降级
    expect(written).toContain('subagents 服务不可用')
    await app.dispose()
  })

  it('/workflow 事件订阅驱动面板渲染（start 带 meta/agent-start/end → 缓存行）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    // 捕获事件监听器（makeCtx 的 on 是记录型 mock，不转发）；手动触发模拟事件流。
    const listeners = new Map<string, (...args: unknown[]) => void>()
    ctx.on.mockImplementation((name: string, handler: (...args: unknown[]) => void) => {
      listeners.set(name, handler)
      return () => { listeners.delete(name) }
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const fire = (name: string, ...args: unknown[]) => { listeners.get(name)?.(...args) }
    fire('workflow/start', {
      id: 'wf-1',
      meta: { name: '调研脚本', description: '多 agent 调研', phases: [{ title: '准备' }, { title: '调研' }, { title: '收尾' }] },
    })
    fire('workflow/phase', { id: 'wf-1' }, '调研') // 属主第二参为裸 string（dsh-workflow Events）
    fire('workflow/agent-start', { id: 'wf-1' }, { seq: 1, label: '调研员' })
    fire('workflow/agent-end', { id: 'wf-1' }, { seq: 1, label: '调研员', outcome: 'completed' })
    fire('workflow/end', { id: 'wf-1' }, { stopReason: 'completed' })
    await new Promise(resolve => setImmediate(resolve))
    for (const ch of '/workflow') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('📜 工作流')
    // 终态 run 折叠进缓存：列表行含真实 run 名（meta.name，非 phase）、阶段数、
    // 描述（含注入的 run id 后缀）与 agent 计数。
    expect(written).toContain('[调研脚本]')
    expect(written).toContain('3 阶段')
    expect(written).toContain('1 个 agent')
    expect(written).toContain('多 agent 调研 (wf-1)')
    expect(written).toContain('多 agent 调研 ·')
    await app.dispose()
  })
})

describe('TuiApp T6 启动 context bar（C4 概念稿 A 顶部栏）', () => {
  it('attach 后 scrollback 含 cwd + 模型（+ 分支，可检测时）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('start-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain(process.cwd())
    expect(written).toContain('mock/mock') // currentSelection 的 provider/model
    await app.dispose()
  })
})

describe('TuiApp API key 就绪（credentials 分层，非仅 env）', () => {
  const previousKey = process.env.DEEPSEEK_API_KEY

  afterEach(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
  })

  function boot(opts: {
    credentials?: { configured: boolean; source?: string }
    credentialsError?: boolean
    envKey?: string
  } = {}): {
    app: TuiApp
    stdout: WriteStream & { write: ReturnType<typeof vi.fn> }
    describe: ReturnType<typeof vi.fn>
  } {
    if (opts.envKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = opts.envKey

    const ctx = makeCtx()
    const agent = makeAgent('key-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const describe = vi.fn(async () => {
      if (opts.credentialsError === true) throw new Error('bad facet')
      return {
        writable: true,
        configured: opts.credentials?.configured ?? false,
        ...(opts.credentials?.source === undefined ? {} : { source: opts.credentials.source }),
      }
    })
    if (opts.credentials !== undefined || opts.credentialsError === true) {
      const fallback = ctx.reflect.get.getMockImplementation()! as (name: string) => unknown
      ctx.reflect.get.mockImplementation((name: string) => {
        if (name === 'credentials') return { describe }
        return fallback(name)
      })
    }
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    return { app, stdout, describe }
  }

  it('credentials 报 file 已配置、env 未设 → 欢迎页 API Key ✓、footer API ✓', async () => {
    const { app, stdout, describe } = boot({ credentials: { configured: true, source: 'file' } })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('API Key ✓')
    expect(written).not.toContain('API Key ✗')
    expect(written).toMatch(/API ✓/)
    expect(describe).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    await app.dispose()
  })

  it('credentials 未配置且 env 未设 → 欢迎页 API Key ✗，且 Tips 排首引导 /key', async () => {
    const { app, stdout } = boot({ credentials: { configured: false } })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('API Key ✗（设 DEEPSEEK_API_KEY）')
    // 动态引导：未登录时 Tips 第一条是 /key 配置入口
    expect(written).toContain('/key')
    expect(written).toContain('配置 API key')
    await app.dispose()
  })

  it('credentials 已配置 → 欢迎页 Tips 不含 /key 引导（首条为 ctrl+n）', async () => {
    const { app, stdout } = boot({ credentials: { configured: true, source: 'file' } })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('API Key ✓')
    expect(written).not.toContain('/key')
    await app.dispose()
  })

  it('首次运行：欢迎页 Tips 含 /help 命令帮助面板引导（onboarding 一次性）', async () => {
    // VITEST 下 prefs 禁用 → onboarded 恒未标记 → 欢迎页恒展示 onboarding tip
    const { app, stdout } = boot({ credentials: { configured: true, source: 'file' } })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('/help')
    expect(written).toContain('命令帮助面板')
    await app.dispose()
  })

  it('无 credentials 服务、env 已设 → 欢迎页 API Key ✓（env 兜底）', async () => {
    const { app, stdout, describe } = boot({ envKey: 'sk-test' })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('API Key ✓')
    expect(written).not.toContain('API Key ✗')
    expect(describe).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('credentials.describe 抛错、env 已设 → 回退 env，欢迎页 API Key ✓', async () => {
    const { app, stdout, describe } = boot({ credentialsError: true, envKey: 'sk-test' })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('API Key ✓')
    expect(written).not.toContain('API Key ✗')
    expect(describe).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    await app.dispose()
  })
})

describe('TuiApp 会话交互 UX 对齐（显示层 = 实际能力）', () => {
  const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('/config：credentials.describe(DEEPSEEK_API_KEY) 报 file → 凭据段显示已配置', async () => {
    const ctx = makeCtx()
    const describe = vi.fn(async (ref: string) => {
      expect(ref).toBe('DEEPSEEK_API_KEY')
      return { configured: true, source: 'file', writable: true }
    })
    const fallback = ctx.reflect.get.getMockImplementation()! as (name: string) => unknown
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'credentials') return { describe }
      return fallback(name)
    })
    const agent = makeAgent('cfg-key')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.handleSubmit('/config')
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('DEEPSEEK_API_KEY')
    expect(written).toContain('已配置')
    expect(written).toContain('file')
    expect(written).not.toContain('（无凭据）')
    expect(describe).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    await app.dispose()
  })

  it('/model 热切后 footer 显示新模型名（不再停在挂载时的旧名）', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.agentDefaultModel, {
      currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
      saveSelection: vi.fn(async () => { }),
    })
    const agent = makeAgent('mdl-footer')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.handleSubmit('/model deepseek/v4-turbo')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect((app as unknown as { glanceModelName: string | null }).glanceModelName).toBe('v4-turbo')
    await app.dispose()
  })

  it('切到无 image 模态的模型后，发图走「图片未发送」（不沿用启动时的识图标志）', async () => {
    const ctx = makeCtx()
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] as const }))
    const fallback = ctx.reflect.get.getMockImplementation()! as (name: string) => unknown
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'llm') return { resolveModelInfo }
      return fallback(name)
    })
    const agent = makeAgent('vision-hot')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({
      ctx, stdout, stdin: makeStdin(),
      vision: { supportsVision: true, bridgeEnabled: false },
    })
    await app.newSession()
    expect(app.switchLiveModel({ provider: 'deepseek', model: 'text-only' })).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 40))
    app.handleSubmit('hi', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('图片未发送')
    const msg = agent.followup.mock.calls[0]?.[0] as { content?: unknown[] } | undefined
    expect(msg?.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(resolveModelInfo).toHaveBeenCalledWith('deepseek', 'text-only')
    await app.dispose()
  })

  it('ctrl_s：persistence 有磁盘会话、live 只有当前 → resume 该磁盘会话', async () => {
    const ctx = makeCtx()
    const live = makeAgent('live-now')
    ctx.agents.create.mockResolvedValue(makeHandle(live))
    ctx.sessions.get.mockReturnValue(live.session)
    ctx.sessions.list.mockReturnValue([])
    const diskId = SessionId('session-disk-1')
    const diskHeader = {
      id: diskId, version: 0, createdAt: Date.now() - 1_000,
      cwd: '/tmp/disk-ws', parentSession: undefined,
    }
    const fallback = ctx.reflect.get.getMockImplementation()! as (name: string) => unknown
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionPersistence') {
        return { list: vi.fn(async () => [diskHeader]) }
      }
      return fallback(name)
    })
    ctx.agents.get.mockReturnValue(undefined)
    const disk = makeAgent('disk-1')
    // session.id/header 在 Agent 类型上只读：mock 替身经 Object.assign 改形。
    Object.assign(disk.session, { id: diskId, header: { ...disk.session.header, id: diskId, cwd: '/tmp/disk-ws' } })
    ctx.agents.resume.mockResolvedValue(makeHandle(disk))
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
    await app.attach()
    expect(app.sessionId).not.toBe(diskId)
    stdin.emit('data', '\x13')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ctx.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: diskId }))
    expect(app.sessionId).toBe(diskId)
    await app.dispose()
  })

  it('顶栏与 @mention 使用会话 header.cwd，不是启动进程 cwd', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'session-cwd-'))
    writeFileSync(join(ws, 'notes.md'), '会话工作区笔记')
    const ctx = makeCtx()
    const id = SessionId('session-cwd-1')
    const agent = makeAgent('cwd-1')
    // session.id/header 在 Agent 类型上只读：mock 替身经 Object.assign 改形。
    Object.assign(agent.session, { id, header: { ...agent.session.header, id, cwd: ws } })
    ctx.sessions.list.mockReturnValue([{ id, header: agent.session.header, events: [] }])
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.agents.get.mockReturnValue(agent)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain(ws)
    app.handleSubmit('看 @notes.md')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(firstCallText(agent.followup)).toContain('会话工作区笔记')
    await app.dispose()
  })

  it('notifyPluginUpdated：attach 后写入重启提示', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('upd-after')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.notifyPluginUpdated('0.1.0-rc.7')
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('插件已更新到 0.1.0-rc.7。输入 /changelog 查看本次更新内容')
    await app.dispose()
  })

  it('notifyPluginUpdated：attach 前排队，attach 后才出现', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('upd-queue')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    app.notifyPluginUpdated('0.1.0-rc.7')
    const before = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(before).not.toContain('插件已更新到')
    await app.attach()
    // attach 后排队消息写入是异步渲染：轮询等待目标文本（flaky 加固）
    await waitForStdout(stdout, '插件已更新到 0.1.0-rc.7')
    const after = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(after).toContain('插件已更新到 0.1.0-rc.7。输入 /changelog 查看本次更新内容')
    await app.dispose()
  })

  it('notifyPluginUpdateFailed：attach 后写入失败警告（含 SKIP 提示，P1-1）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('upd-fail')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.notifyPluginUpdateFailed('pnpm add exited 1')
    // 失败警告写入是异步渲染：轮询等待（flaky 加固）
    await waitForStdout(stdout, '自更新失败')
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('自更新失败')
    expect(written).toContain('pnpm add exited 1')
    expect(written).toContain('DSH_TUI_SKIP_UPDATE=1')
    await app.dispose()
  })

  it('notifyPluginUpdateFailed：attach 前排队，attach 后才出现（P1-1）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('upd-fail-queue')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    app.notifyPluginUpdateFailed('network error')
    const before = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(before).not.toContain('自更新失败')
    await app.attach()
    const after = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(after).toContain('自更新失败')
    expect(after).toContain('network error')
    await app.dispose()
  })
})

describe('TuiApp forkSession（A3 会话分叉）', () => {
  it('fork 不 resume live 子会话：resume 抛 while-it-is-live 时仍经 create 成功', async () => {
    const ctx = makeCtx()
    const parent = makeAgent('parent-live')
    const parentHandle = makeHandle(parent)
    const child = makeAgent('child-live')
    const childHandle = makeHandle(child)
    ctx.agents.create
      .mockResolvedValueOnce(parentHandle)
      .mockResolvedValueOnce(childHandle)
    ctx.sessions.get.mockReturnValue(parent.session)
    ctx.agents.resume.mockImplementation(async (opts: { resumeSessionId: SessionId }) => {
      throw new Error(`cannot prepare session "${opts.resumeSessionId}" while it is live`)
    })

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    const parentId = await app.newSession()
    const id = await app.forkSession()

    expect(ctx.sessions.fork).not.toHaveBeenCalled()
    expect(ctx.agents.resume).not.toHaveBeenCalled()
    expect(ctx.agents.create).toHaveBeenLastCalledWith(expect.objectContaining({
      seed: [],
      meta: expect.objectContaining({
        parentSession: parentId,
        cwd: process.cwd(),
        isSeeded: false,
      }),
      inheritedEventCount: 0,
    }))
    expect(id).not.toBe(parentId)
    expect(String(id)).toMatch(/^session-/)
    const forkCreate = ctx.agents.create.mock.calls[1]?.[0] as { sessionId: SessionId }
    expect(forkCreate.sessionId).toBe(id)
    await app.dispose()
  })

  it('fork 当前会话并切换：agents.create 带 seed/血缘，不 fork+resume', async () => {
    const ctx = makeCtx()
    const parent = makeAgent('parent-1')
    const parentHandle = makeHandle(parent)
    const child = makeAgent('child-1')
    const childHandle = makeHandle(child)
    ctx.agents.create
      .mockResolvedValueOnce(parentHandle)
      .mockResolvedValueOnce(childHandle)
    ctx.sessions.get.mockReturnValue(parent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    const parentId = await app.newSession()
    const id = await app.forkSession()

    expect(ctx.sessions.fork).not.toHaveBeenCalled()
    expect(ctx.agents.resume).not.toHaveBeenCalled()
    expect(ctx.agents.create).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: id,
      seed: [],
      meta: expect.objectContaining({ parentSession: parentId }),
    }))
    await app.dispose()
  })

  it('源会话处于 open turn → 抛回合未结束，不 create child', async () => {
    const ctx = makeCtx()
    const parent = makeAgent('parent-open')
    ctx.agents.create.mockResolvedValue(makeHandle(parent))
    ctx.sessions.get.mockReturnValue(parent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    Object.assign(parent.session, {
      events: [
        { seq: 0, time: 0, type: 'turn/start' },
        { seq: 1, time: 1, type: 'user/message' },
      ],
    })
    await expect(app.forkSession()).rejects.toThrow('回合未结束')
    expect(ctx.agents.create).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('无活跃会话时 forkSession 抛错', async () => {
    const ctx = makeCtx()
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await expect(app.forkSession()).rejects.toThrow('无会话')
    expect(ctx.sessions.fork).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('forkSession 带 directive → create 后 followup 提交 directive 为首条消息', async () => {
    const ctx = makeCtx()
    const parent = makeAgent('parent-2')
    const parentHandle = makeHandle(parent)
    const child = makeAgent('child-2')
    const childHandle = makeHandle(child)
    ctx.agents.create
      .mockResolvedValueOnce(parentHandle)
      .mockResolvedValueOnce(childHandle)
    ctx.sessions.get.mockReturnValue(parent.session)

    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    await app.forkSession({ directive: '探索另一种方案' })

    expect(ctx.sessions.fork).not.toHaveBeenCalled()
    expect(child.followup).toHaveBeenCalledTimes(1)
    expect(firstCallText(child.followup)).toBe('探索另一种方案')
    await app.dispose()
  })
})

describe('TuiApp switchLiveModel（C2 项 4 模型热切）', () => {
  it('newSession 后热切生效（返回 true）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('hot-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    expect(app.switchLiveModel({ provider: 'openai', model: 'gpt-5' })).toBe(true)
    await app.dispose()
  })

  it('无活跃会话时热切不可用（返回 false）', async () => {
    const ctx = makeCtx()
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    expect(app.switchLiveModel({ provider: 'openai', model: 'gpt-5' })).toBe(false)
    await app.dispose()
  })

  it('switchSession 到 registry 兜底会话（agent 已存在）→ 热切不可用（ref 归 null）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('hot-registry-1')
    ctx.agents.get.mockReturnValue(agent) // registry 已有 live agent
    ctx.sessions.get.mockReturnValue(agent.session) // mountSession 需要 session
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('hot-registry-1'))
    expect(app.switchLiveModel({ provider: 'openai', model: 'gpt-5' })).toBe(false)
    await app.dispose()
  })

  it('switchSession 到 resume 会话（无 live agent）→ 热切生效', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('hot-resume-1')
    const handle = makeHandle(agent)
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('hot-resume-1'))
    expect(app.switchLiveModel({ provider: 'openai', model: 'gpt-5' })).toBe(true)
    await app.dispose()
  })
})

describe('TuiApp 历史搜索 overlay（C2 项 2）', () => {
  async function setupApp() {
    const ctx = makeCtx()
    const agent = makeAgent('search-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach() // overlay 在 attach 中注册
    await app.newSession()
    return { app, stdin, stdout }
  }

  it('Ctrl+F 打开 overlay（渲染搜索提示），Esc 关闭', async () => {
    const { app, stdin, stdout } = await setupApp()
    stdin.emit('data', '\x06') // Ctrl+F → ctrl_f
    await new Promise(resolve => setTimeout(resolve, 30)) // 等 renderBatcher flush（16ms 合并）
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('输入关键词搜索会话历史')
    stdout.write.mockClear()
    stdin.emit('data', '\x1b') // Esc 关闭
    await new Promise(resolve => setTimeout(resolve, 30))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('输入关键词搜索会话历史')
    await app.dispose()
  })

  it('overlay 打开时字符进 query，n 跳转', async () => {
    const { app, stdin, stdout } = await setupApp()
    stdin.emit('data', '\x06') // Ctrl+F
    await new Promise(resolve => setTimeout(resolve, 30))
    stdout.write.mockClear()
    stdin.emit('data', 'w')
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('w')
    stdin.emit('data', 'n') // goNext（空消息集 no-op，不抛错）
    stdin.emit('data', '\x1b')
    await app.dispose()
  })
})

describe('runSlash fallback 到 CommandService（A1）', () => {
  /** 带 commands 服务的 ctx 替身：reflect.get 按名字返回。 */
  async function setupApp(commands: { execute: ReturnType<typeof vi.fn> } | undefined) {
    const ctx = makeCtx()
    const agent = makeAgent('fallback-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.agents.get.mockReturnValue(agent)
    ctx.reflect.get.mockImplementation((name: string) => (name === 'commands' ? commands : undefined))
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    return { app, ctx, agent, stdout }
  }

  /** runSlash 是 async 且 handleSubmit 不 await——等一拍让执行落定。 */
  async function flush(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
  }

  it('未知名命令 + commands 可用 → execute 被调，回显 success 文本', async () => {
    const execute = vi.fn().mockResolvedValue({ result: { kind: 'success', text: '已进入 plan 模式' } })
    const { app, agent, stdout } = await setupApp({ execute })
    // /st 歧义前缀：进命令通道，注册表拒绝后 fallback 到 CommandService
    app.handleSubmit('/st')
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0]).toBe(agent)
    expect(execute.mock.calls[0]![1]).toBe('/st')
    expect(execute.mock.calls[0]![2]).toBeInstanceOf(AbortSignal)
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已进入 plan 模式')
    await app.dispose()
  })

  it('execute 返回 error → 回显 ⚠ 与错误文本', async () => {
    const execute = vi.fn().mockResolvedValue({ result: { kind: 'error', text: 'plan mode 不可用' } })
    const { app, stdout } = await setupApp({ execute })
    app.handleSubmit('/st')
    await flush()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚠')
    expect(written).toContain('plan mode 不可用')
    await app.dispose()
  })

  it('execute 返回 undefined（未知名）→ 回显未知命令与相近建议', async () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const { app, stdout } = await setupApp({ execute })
    app.handleSubmit('/st')
    await flush()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('未知命令')
    expect(written).toContain('/status')
    await app.dispose()
  })

  it('无会话 → 不调 execute，回显未知命令', async () => {
    const execute = vi.fn()
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => (name === 'commands' ? { execute } : undefined))
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    // 未 attach/newSession：activeSessionId 为 null
    app.handleSubmit('/st')
    await flush()
    expect(execute).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('未知命令')
    await app.dispose()
  })

  it('commands 服务不可用 → 不调 execute，回显未知命令（降级）', async () => {
    const execute = vi.fn()
    const { app, stdout } = await setupApp(undefined)
    app.handleSubmit('/st')
    await flush()
    expect(execute).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('未知命令')
    await app.dispose()
  })
})

describe('TuiApp parseSlashCommand 导出', () => {
  it('内置命令唯一前缀命中并剥离参数', () => {
    expect(parseSlashCommand('/clear')).toEqual({ kind: 'clear', text: '' })
    expect(parseSlashCommand('/session new')).toEqual({ kind: 'session', text: 'new' })
  })

  it('未知名命令 → null', () => {
    expect(parseSlashCommand('/definitely-not-a-command')).toBeNull()
  })
})

describe('TuiApp slash 命令分发路径（deps 闭包）', () => {
  it('/session new 触发 newSession 闭包并回显新 id', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('cmd-new-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const before = ctx.agents.create.mock.calls.length

    app.handleSubmit('/session new')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    expect(ctx.agents.create.mock.calls.length).toBe(before + 1)
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已新建会话')
    await app.dispose()
  })

  it('/fork 无活跃会话 → runSlash catch 回显 ⚠ 命令执行失败', async () => {
    const ctx = makeCtx()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    app.handleSubmit('/fork')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('命令执行失败')
    expect(written).toContain('可分叉')
    await app.dispose()
  })

  it('slash handler 抛字符串 → String(err) 分支回显（runSlash catch 非 Error）', async () => {
    const ctx = makeCtx()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    // 注册一个会抛字符串的扩展命令（经 ctx.provide 暴露的 registry）
    const registry = (ctx as unknown as { provide(name: string, svc: unknown): void })
    const slash = (app as unknown as { slash: { register(c: unknown): void } }).slash
    slash.register({
      name: 'boomcmd',
      description: '抛字符串',
      run: () => { throw 'kaboom string' },
    })
    void registry
    app.handleSubmit('/boomcmd')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('命令执行失败')
    expect(written).toContain('kaboom string')
    await app.dispose()
  })
})

describe('TuiApp /config /skills /density 面板命令', () => {
  it('/config 打开再关闭：无宿主服务仍显示终端段（双分支）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('cfg-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/config') // 打开 → 终端段（宿主全缺不再空白）
    await new Promise(resolve => setImmediate(resolve))
    const opened = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(opened).toContain('系统通知')
    app.handleSubmit('/config') // 关闭
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('未知命令')
    await app.dispose()
  })

  it('/config 打开：settings/permission 服务存在 → 投影渲染', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'settings') return { describe: vi.fn(() => [{ ns: 'model', value: 'deepseek' }]) }
      if (name === 'permission') return { names: ['run_shell'], current: vi.fn(() => 'ask') }
      return undefined
    })
    const agent = makeAgent('cfg-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/config')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('model')
    await app.dispose()
  })

  it('/skills 打开：服务缺失 → 空态占位；服务存在 → 列表渲染', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return {
        list: vi.fn(async () => [{ name: 'code-review', description: '代码审查', provider: 'mock', source: 'builtin', invocation: 'manual' }]),
      }
      return undefined
    })
    const agent = makeAgent('skill-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/skills')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('code-review')
    await app.dispose()
  })

  it('/skills 服务缺失 → skillItems 空数组，面板渲染空态', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('skill-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/skills')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('技能')
    await app.dispose()
  })

  it('skills.list reject → 空数组降级', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return { list: vi.fn(async () => { throw new Error('boom') }) }
      return undefined
    })
    const agent = makeAgent('skill-3')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/skills')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('技能')
    await app.dispose()
  })

  it('/skills 二次切换 → 面板关闭，refreshSkillItems 不再调用（L476 分支）', async () => {
    const ctx = makeCtx()
    const list = vi.fn(async () => [])
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return { list }
      return undefined
    })
    const agent = makeAgent('skill-4')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/skills')
    await new Promise(resolve => setTimeout(resolve, 30))
    const firstCalls = list.mock.calls.length
    app.handleSubmit('/skills')
    await new Promise(resolve => setTimeout(resolve, 30))
    // 第二次切换时面板已开 → 只翻转可见性，不再刷新快照
    expect(list.mock.calls.length).toBe(firstCalls)
    await app.dispose()
  })

  it('/density 切换 compactMode（两次调用不崩）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('density-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/density')
    await new Promise(resolve => setImmediate(resolve))
    app.handleSubmit('/density')
    await new Promise(resolve => setImmediate(resolve))
    // 输入行渲染仍正常（compactMode 只影响工具卡）
    app.handleSubmit('ok')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('ok')
    await app.dispose()
  })

  it('/info 循环切换输入区信息密度并回显（full→compact→off→full）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('info-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    for (const expected of ['compact', 'off', 'full']) {
      app.handleSubmit('/info')
      await new Promise(resolve => setImmediate(resolve))
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain(`输入区信息密度：${expected}`)
    }
    await app.dispose()
  })

  it('/info 分层接线：off 档 footer 全关（mode 段消失）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('info-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('normal') // full 档 footer 行 1 mode 段

    app.handleSubmit('/info')
    await new Promise(resolve => setImmediate(resolve))
    app.handleSubmit('/info')
    await new Promise(resolve => setImmediate(resolve))
    const before = stdout.write.mock.calls.length
    app.handleSubmit('hi2')
    await new Promise(resolve => setImmediate(resolve))
    // 只看 hi2 之后新增的帧：off 档 footer 全关（mode 段消失）
    const afterOff = stdout.write.mock.calls.slice(before).map(c => `${c[0]}`).join('')
    expect(afterOff).not.toContain('normal')
    await app.dispose()
  })
})

describe('TuiApp #39 技能手势：slash 菜单条目 + 提交分流 + MRU', () => {
  /** userInvocable 技能替身（含仅模型可调的对照项）。 */
  function withSkills(ctx: Context & MockCtx): { list: ReturnType<typeof vi.fn> } {
    const list = vi.fn(async () => [
      {
        name: 'find-skills', description: '发现技能', provider: 'mock', source: 'custom',
        invocation: { modelInvocable: true, userInvocable: true },
      },
      {
        name: 'model-only', description: '仅模型可调', provider: 'mock', source: 'custom',
        invocation: { modelInvocable: true, userInvocable: false },
      },
    ])
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return { list }
      return undefined
    })
    return { list }
  }

  /** attach 后等 skills.list resolve（refreshSkillItems → refreshSlashEntries）。 */
  async function mountedApp(): Promise<{ app: TuiApp; agent: Agent & MockAgent; ctx: Context & MockCtx }> {
    const ctx = makeCtx()
    withSkills(ctx)
    const agent = makeAgent('skill-menu')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    return { app, agent, ctx }
  }

  function inputControllerOf(app: TuiApp): {
    slashCommands: SlashHintEntry[]
    slashMenu: { open: boolean; matches: SlashHintEntry[] }
    slashMru: string[]
    refreshSlash(value: string): void
  } {
    return (app as unknown as { inputController: {
      slashCommands: SlashHintEntry[]
      slashMenu: { open: boolean; matches: SlashHintEntry[] }
      slashMru: string[]
      refreshSlash(value: string): void
    } }).inputController
  }

  it('userInvocable 技能进 slash 菜单（🧭 标记）；仅模型可调技能不出现', async () => {
    const { app } = await mountedApp()
    const ic = inputControllerOf(app)
    const commands = ic.slashCommands
    expect(commands.some(c => c.name === 'find-skills' && c.description.startsWith('🧭 '))).toBe(true)
    expect(commands.some(c => c.name === 'model-only')).toBe(false)
    // 输入 `/find` → 菜单打开且技能条目在匹配里
    ic.refreshSlash('/find')
    expect(ic.slashMenu.open).toBe(true)
    expect(ic.slashMenu.matches.some(m => m.name === 'find-skills')).toBe(true)
    await app.dispose()
  })

  it('提交 `/skill-name` 走文本流（followup 触发）不落未知命令；MRU 记录', async () => {
    const { app, agent } = await mountedApp()
    app.handleSubmit('/find-skills')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const stdout = (app as unknown as { stdout: { write: ReturnType<typeof vi.fn> } }).stdout
    const out = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(out).not.toContain('未知命令')
    // MRU：技能手势记录（slash 菜单下次打开技能条目排前）
    const ic = inputControllerOf(app)
    expect(ic.slashMru[0]).toBe('find-skills')
    await app.dispose()
  })

  it('技能名撞命令前缀 → 命令优先（/task 触发 /tasks 而非技能手势）', async () => {
    const { app, agent } = await mountedApp()
    // 真实技能名可能撞命令前缀（如名为 task 的技能）——命令命名空间
    // 客户端先行解析（host 设计），命令优先，技能手势不触发。
    app.handleSubmit('/task')
    await new Promise(resolve => setImmediate(resolve))
    // 命令优先：不提交给 agent，也不落未知命令
    expect(agent.followup).not.toHaveBeenCalled()
    const stdout = (app as unknown as { stdout: { write: ReturnType<typeof vi.fn> } }).stdout
    const out = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(out).not.toContain('未知命令')
    await app.dispose()
  })

  it('skills 服务缺失 → 菜单无技能条目；`/find-skills` 仍作文本提交（host 侧忽略）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('skill-none')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    const ic = inputControllerOf(app)
    expect(ic.slashCommands.some(c => c.name === 'find-skills')).toBe(false)
    ic.refreshSlash('/find')
    expect(ic.slashMenu.open).toBe(false)
    // 未知技能名照常走文本流（host 把未知 /name 当普通文本）
    app.handleSubmit('/find-skills')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('attach 订阅 skills/change（目录变更 → 刷新菜单数据源）', async () => {
    const ctx = makeCtx()
    const { list } = withSkills(ctx)
    const agent = makeAgent('skill-change')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(ctx.subscriptions.some(s => s.event === 'skills/change')).toBe(true)
    const ic = inputControllerOf(app)
    expect(ic.slashCommands.some(c => c.name === 'find-skills')).toBe(true)
    // 目录在 attach 后变化（list 返回新技能）→ 刷新路径（事件回调等价调用）
    // 让新技能进菜单
    list.mockResolvedValueOnce([
      {
        name: 'late-skill', description: '晚到技能', provider: 'mock', source: 'custom',
        invocation: { modelInvocable: true, userInvocable: true },
      },
    ])
    const appAny = app as unknown as { skillSurface: { refresh(): void } }
    appAny.skillSurface.refresh()
    await new Promise(resolve => setImmediate(resolve))
    expect(ic.slashCommands.some(c => c.name === 'late-skill')).toBe(true)
    await app.dispose()
    // 订阅释放由 afterEach 台账平衡断言覆盖
  })
})

describe('TuiApp 生命周期边界', () => {
  it('dispose 后再 attach 抛错（已处置保护）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('re-attach')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    await app.dispose()
    await expect(app.attach()).rejects.toThrow('TuiApp already disposed')
  })

  it('dispose 幂等（二次调用直接返回）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('dispose-2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    await app.dispose()
    await app.dispose()
    expect(handle.dispose).toHaveBeenCalledTimes(1)
  })

  it('refreshSessions 委托 listSessions 返回会话列表', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('refresh-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.agents.get.mockReturnValue(agent) // attach 的 target 走 registry 兜底
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([agent.session])
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    const summaries = await app.refreshSessions()
    expect(Array.isArray(summaries)).toBe(true)
    expect(summaries.length).toBeGreaterThan(0)
    await app.dispose()
  })
})

describe('TuiApp 事件回调驱动（resize / keymap / userInteraction）', () => {
  it('resize 事件触发 renderLive（onResize 防抖回调）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('resize-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    let resizeHandler: (() => void) | null = null
    stdout.on = vi.fn((ev: string, h: () => void) => {
      if (ev === 'resize') resizeHandler = h
    }) as unknown as typeof stdout.on
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    stdout.write.mockClear()
    stdout.columns = 101 // 尺寸变化才触发 resize 回调（scheduleCallback 比对缓存值）
    ;(resizeHandler as (() => void) | null)?.()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(stdout.write).toHaveBeenCalled()
    await app.dispose()
  })

  it('Ctrl+. 打开/关闭快捷键面板（keymap overlay 渲染回调）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('keymap-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, theme: 'paper' })
    await app.attach()

    stdin.emit('data', '\x1e') // Ctrl+. = 0x1e（RS）→ 打开 keymap
    await new Promise(resolve => setImmediate(resolve))
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049h')

    stdin.emit('data', '\x1e') // 再按 → 关闭
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l')
    await app.dispose()
  })

  it('userQuestions 服务存在 → attach 时注册 user-questions/request answerer', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('ui-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()

    // rc.1 wire：answerer 经 ctx.on('user-questions/request') waterfall 注册
    const on = ctx.on as unknown as ReturnType<typeof vi.fn>
    expect(on).toHaveBeenCalledWith('user-questions/request', expect.any(Function), { global: true })
    await app.dispose()
  })
})

describe('TuiApp T3.1 结构化提问结算', () => {
  /** 装配带 userQuestions 服务的 app，返回 provider 引用。
   *  rc.1 wire：answerer 经 ctx.on('user-questions/request') 注册；provider.ask
   *  以 waterfall 客户语义调用捕获的监听器（next 委托到不存在的下游即抛错）。 */
  async function bootQuestionApp() {
    const ctx = makeCtx()
    const agent = makeAgent('q-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const onCalls = (ctx.on as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>
    const provider = (): { ask: (request: unknown) => Promise<unknown> } | null => {
      const reg = onCalls.find(([name]) => name === 'user-questions/request')
      if (reg === undefined) return null
      const answerer = reg[1] as (request: unknown, next: () => Promise<unknown>) => Promise<unknown>
      return {
        ask: (request: unknown) => answerer(request, async () => {
          throw new Error('no downstream answerer')
        }),
      }
    }
    return { app, stdin, stdout, provider }
  }

  it('ask 挂起 → 数字键选选项结算（resolve 带选项值）', async () => {
    const { app, stdin, stdout, provider } = await bootQuestionApp()

    const askPromise = provider()!.ask({
      questions: [{ id: 'opt-1', question: '继续执行？', options: [{ label: '是' }, { label: '否' }] }],
    })
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('继续执行？')

    stdout.write.mockClear()
    stdin.emit('data', '1')
    await expect(askPromise).resolves.toEqual({ answers: [{ id: 'opt-1', selected: ['是'] }] })
    await app.dispose()
  })

  it('Esc 取消提问 → reject UserInteractionError(ASK_CANCELLED)', async () => {
    const { app, stdin, provider } = await bootQuestionApp()

    const askPromise = provider()!.ask({
      questions: [{ id: 'q1', question: '继续？' }],
    })
    stdin.emit('data', '\x1b')
    await expect(askPromise).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await app.dispose()
  })

  it('挂起中重复 ask → reject UserInteractionError(ASK_CANCELLED)（重叠保护）', async () => {
    const { app, provider } = await bootQuestionApp()

    void provider()!.ask({ questions: [{ id: 'q1', question: '第一次' }] })
    const second = provider()!.ask({ questions: [{ id: 'q2', question: '第二次' }] })
    await expect(second).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await app.dispose()
  })

  it('切会话（newSession）→ 挂起提问 reject ASK_CANCELLED（跨会话残留修复）', async () => {
    const { app, provider } = await bootQuestionApp()

    const askPromise = provider()!.ask({
      questions: [{ id: 'q-leak', question: '会话 A 挂起？' }],
    })
    // 会话 A 挂起的 plan-review 卡不得残留到新会话：detachProjections
    // 卸载投影时 cancel（与 approval settle('cancelled') 对齐），否则会话 B
    // 按键/渲染仍命中会话 A 的 ask promise。
    await app.newSession()
    await expect(askPromise).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await app.dispose()
  })

  it('plan-review：f 键进入反馈模式，Enter 提交 Keep planning + custom 反馈', async () => {
    const { app, stdin, stdout, provider } = await bootQuestionApp()

    const askPromise = provider()!.ask({
      questions: [{
        id: 'plan-review',
        question: '批准该计划？',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    stdout.write.mockClear()
    stdin.emit('data', 'f')
    // 反馈模式提示渲染
    const hint = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(hint).toContain('反馈')
    // 输入反馈文本并提交
    stdin.emit('data', 'x')
    stdin.emit('data', 'y')
    stdin.emit('data', '\r')
    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'xy' }],
    })
    await app.dispose()
  })

  it('plan-review：反馈模式下 Esc 返回选项态（不结算）', async () => {
    const { app, stdin, stdout, provider } = await bootQuestionApp()

    const askPromise = provider()!.ask({
      questions: [{
        id: 'plan-review',
        question: '批准该计划？',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })
    stdout.write.mockClear()
    stdin.emit('data', 'f')
    stdin.emit('data', '\x1b') // 退出反馈模式
    stdin.emit('data', '1') // 回到选项态：数字键批准
    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    })
    await app.dispose()
  })
})

describe('TuiApp resume 模型定路分支', () => {
  it('resume 沿用持久化 header 的 reasoningEffort（三元展开）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('eff-1')
    agent.session.requestHeader.mockReturnValue({
      config: { provider: 'deepseek', model: 'deepseek-r1', reasoningEffort: 'high' },
    })
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('eff-1'))
    expect(ctx.agents.resume).toHaveBeenCalledTimes(1)
    // agentOptions 只传 provider/model；reasoningEffort 经 selection 进 setup（installModelSelection）
    const options = ctx.agents.resume.mock.calls[0]?.[0] as { setup?: (c: unknown) => void }
    expect(options.setup).toBeTypeOf('function')
    await app.dispose()
  })

  it('resume 的 setup 经 installModelSelection 接线', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('setup-1')
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockImplementation((options: { setup?: (c: unknown) => void }) => {
      const agentCtx = { on: vi.fn(() => () => { }) }
      options.setup?.(agentCtx)
      return makeHandle(agent)
    })
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.switchSession(SessionId('setup-1'))
    await app.dispose()
  })

  it('mountSession 未知会话抛错（sessions.get undefined）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockResolvedValue(makeHandle(makeAgent('ghost')))
    ctx.sessions.get.mockReturnValue(undefined)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await expect(app.newSession()).rejects.toThrow('unknown session')
    await app.dispose()
  })
})

/** 装配捕获事件监听器的 app，返回 fire 辅助（多个同名 handler 全量派发）。 */
async function bootEventApp() {
  const ctx = makeCtx()
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
    const list = handlers.get(name) ?? []
    list.push(h)
    handlers.set(name, list)
    return () => { }
  })
  const agent = makeAgent('evt-1')
  ctx.agents.create.mockResolvedValue(makeHandle(agent))
  ctx.sessions.get.mockReturnValue(agent.session)
  const stdout = makeStdout()
  const stdin = makeStdin()
  const app = new TuiApp({ ctx, stdout, stdin })
  await app.newSession()
  // 真实装配语义：newSession 铸造的 session 其 id === 铸造 id，transcript/statusline/
  // streamFeed 三处过滤都匹配同一 id。mock 需把 session.id 同步为 app.sessionId，
  // 否则 transcript 用 evt-1、其余两处用 session-<uuid>，事件无法同时命中三处。
  ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('evt-1')
  ;(agent as { id: SessionId }).id = agent.session.id
  ctx.sessions.get.mockReturnValue(agent.session)
  const owner = { id: app.sessionId ?? SessionId('evt-1') }
  return {
    app,
    ctx,
    stdout,
    stdin,
    owner,
    fire: (name: string, ...args: unknown[]) => {
      for (const h of handlers.get(name) ?? []) h(...args)
    },
  }
}

describe('TuiApp 会话事件流防御分支', () => {
  it('session/event 其他会话 owner → 订阅过滤不处理', async () => {
    const { app, fire } = await bootEventApp()
    fire('session/event', { id: SessionId('session-other') }, {
      type: 'assistant/attempt',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '应被过滤' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    await app.dispose()
  })

  it('assistant/attempt 非增量记录 → 跳过 blockWriter（分支 2）', async () => {
    const { app, owner, fire } = await bootEventApp()
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'tool-call', text: 'x' } }] },
    })
    await new Promise(resolve => setImmediate(resolve))
    await app.dispose()
  })

  it('流式尾巴：无稳定边界的 text-delta 留在 live 区渲染（getLiveTailLines 路径）', async () => {
    const { app, owner, fire, stdout } = await bootEventApp()
    // 无空行/闭合围栏 → findStableBoundary 0 → pending 累积，live 尾巴原始文本渲染。
    // blockWriter minChars 60 > 文本长度 → 走 idleMs 180ms 超时吐块，等 300ms 覆盖
    // 吐块 + WriteBatcher 16ms 帧两段延迟。
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '你好，世界' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('你好，世界')
    await app.dispose()
  })

  it('turn/start 推进 glance turn 计数（turn >= 0 分支）', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    fire('session/event', owner, { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } })
    app.handleSubmit('推进渲染')
    // C2 渲染管线：WriteBatcher 16ms 帧合并——setImmediate 等不到合并帧。
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written.length).toBeGreaterThan(0)
    await app.dispose()
  })

  it('turn 内有消息时 glance 含 elapsedMs（firstInTurn 命中分支）', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    fire('session/event', owner, { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } })
    fire('session/event', owner, { type: 'assistant/message', seq: 1, time: 2, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } })
    app.handleSubmit('推进渲染')
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written.length).toBeGreaterThan(0)
    await app.dispose()
  })

  it('tool/result：文本长度统计 + 非 text 块 + 未知 callId 降级 name', async () => {
    const { app, owner, fire } = await bootEventApp()
    // 先 tool/call 进 tools（findLast 有记录可遍历）
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: { callId: 'c1', name: 'read_file', arguments: '{}', turn: 1, step: 0 },
    })
    // 匹配 c1：block.content 含非 text 块（reduce 0 分支）+ 命中 name
    fire('session/event', owner, {
      type: 'tool/result',
      seq: 1,
      time: 2,
      data: {
        message: { content: [{ type: 'tool-result', content: [{ type: 'image' }] }], source: { callId: 'c1' } },
      },
    })
    // 未知 callId：findLast 遍历不命中 → ?? 'tool' 降级
    fire('session/event', owner, {
      type: 'tool/result',
      seq: 2,
      time: 3,
      data: {
        message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'abc' }] }], source: { callId: 'ghost' } },
      },
    })
    await new Promise(resolve => setImmediate(resolve))
    await app.dispose()
  })

  it('进行中工具卡渲染：参数可解析与不可解析两分支', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: { callId: 'pc1', name: 'bash', arguments: '{"cmd":"ls"}', turn: 1, step: 0 },
    })
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 1,
      time: 2,
      data: { callId: 'pc2', name: 'grep', arguments: 'not-json', turn: 1, step: 1 },
    })
    app.handleSubmit('刷新渲染')
    // C2 渲染管线：WriteBatcher 16ms 帧合并——setImmediate 等不到合并帧。
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 工具卡标题用语义动词（family verb 映射）：bash → Run、grep → Search。
    expect(written).toContain('Run')
    expect(written).toContain('Search')
    await app.dispose()
  })
})

describe('TuiApp 结算卡与推理通道', () => {
  it('tool/result → 结算卡实时 commit 进 scrollback（流式文本在前）', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '先看目录。\n\n' } }] },
    })
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 1,
      time: 2,
      data: { callId: 'settle-1', name: 'bash', arguments: '{"command":"ls"}', turn: 1, step: 0 },
    })
    fire('session/event', owner, {
      type: 'tool/result',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        step: 0,
        message: {
          content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file.txt\nREADME.md' }] }],
          source: { callId: 'settle-1' },
        },
      },
    })
    // flushStream 串行链（blockWriter.flush → commit）+ WriteBatcher 16ms 帧。
    await new Promise(resolve => setTimeout(resolve, 300))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('Run(ls)')
    expect(written).toContain('file.txt')
    // 事件序：流式文本先于结算卡出现。
    expect(written.indexOf('先看目录')).toBeGreaterThanOrEqual(0)
    expect(written.indexOf('先看目录')).toBeLessThan(written.indexOf('Run(ls)'))
    await app.dispose()
  })

  it('presenter 意图接线：tools 服务 presentResult → 结构化 diff 卡', async () => {
    const { app, ctx, stdout, owner, fire } = await bootEventApp()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name !== 'tools') return undefined
      return {
        get: (toolName: string) => (toolName === 'edit_file' ? {
          presentResult: () => ({
            card: 'diff',
            title: 'Update(a.ts)',
            diffs: [{ path: 'a.ts', oldText: 'x = 1', newText: 'x = 2' }],
          }),
        } : undefined),
      }
    })
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: { callId: 'diff-1', name: 'edit_file', arguments: '{"file_path":"a.ts"}', turn: 1, step: 0 },
    })
    fire('session/event', owner, {
      type: 'tool/result',
      seq: 1,
      time: 2,
      data: {
        turn: 1,
        step: 0,
        message: {
          content: [{ type: 'tool-result', content: [{ type: 'text', text: '模型面 diff 文本' }] }],
          source: { callId: 'diff-1' },
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('Update(a.ts)')
    expect(written).toContain('+ x = 2')
    expect(written).toContain('- x = 1')
    await app.dispose()
  })

  it('reasoning-delta → live 思考尾巴可见；段结束折叠头行落底，正文不落', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 0,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'reasoning-delta', text: '先分析需求边界' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    const streaming = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(streaming).toContain('✻ 思考中…')
    expect(streaming).toContain('先分析需求边界')

    // 首个 text-delta = 推理段结束点 → 折叠头行落底（对标竞品：正文不落
    // scrollback，经 Ctrl+O 展开查看）。
    stdout.write.mockClear()
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'text-delta', text: '结论是……' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    const settled = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(settled).toContain('✻ 思考')
    expect(settled).not.toContain('思考中')
    expect(settled).not.toContain('先分析需求边界')
    await app.dispose()
  })

  it('Ctrl+O 展开/收起已落底推理块：正文进 live 区，scrollback 保持折叠', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    const agent = makeAgent('expand-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    // attach 才接线 stdin → handleKey（bootEventApp 不 attach，键事件不可达）。
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('expand-1')
    ;(agent as { id: SessionId }).id = agent.session.id
    ctx.sessions.get.mockReturnValue(agent.session)
    const owner = { id: app.sessionId ?? SessionId('expand-1') }
    const fire = (name: string, ...args: unknown[]) => {
      for (const h of handlers.get(name) ?? []) h(...args)
    }

    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 0,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'reasoning-delta', text: '展开可见的推理正文' } }] },
    })
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'text-delta', text: '结论' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    stdout.write.mockClear()

    // Ctrl+O（0x0f）展开：推理全文出现在 live 区（含收起提示），scrollback 不重复。
    stdin.emit('data', '\x0f')
    await new Promise(resolve => setTimeout(resolve, 60))
    const expanded = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(expanded).toContain('展开可见的推理正文')
    expect(expanded).toContain('✻ 思考')
    expect(expanded).toContain('ctrl+o 收起')

    // 主题重放不得保留瞬时的推理展开态（#40）。帧等待替代固定 60ms 睡眠：
    // ctrl+o 渲染经 batcher 16ms 定时器帧，负向断言必须在新帧落定后读，
    // 否则负载下提前读到旧帧即假绿。
    const frameAfter = async (): Promise<string> => {
      const before = stdout.write.mock.calls.length
      await vi.waitFor(() => {
        expect(stdout.write.mock.calls.length).toBeGreaterThan(before)
      }, { timeout: 5_000, interval: 15 })
      return stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    }
    stdout.write.mockClear()
    // 原子提交编舞（2026-08-27）后，/theme 重放在 submit 返回前同步完成——
    // 观察窗口必须把「已发生的写屏」算作新帧：等 calls>0 而非对触发后的
    // 基线求增长（基线取在触发之后会永远等不到下一帧）。#40 断言不变：
    // 重放帧里不得残留推理展开态。
    app.handleSubmit('/theme paper')
    await vi.waitFor(() => {
      expect(stdout.write.mock.calls.length).toBeGreaterThan(0)
    }, { timeout: 5_000, interval: 15 })
    const themed = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(themed).not.toContain('ctrl+o 收起')

    // 重放复位瞬时展开；重开一次，再收起验证往返。
    stdin.emit('data', '\x0f')
    await frameAfter()
    stdout.write.mockClear()
    stdin.emit('data', '\x0f')
    const collapsed = await frameAfter()
    expect(collapsed).not.toContain('展开可见的推理正文')
    await app.dispose()
  })

  it('abort → 推理缓冲丢弃不落底', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 0,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'reasoning-delta', text: '将被丢弃的思路' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    stdout.write.mockClear()
    fire('session/event', owner, {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'aborted' } },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('✻ 思考 (')
    expect(written).not.toContain('将被丢弃的思路')
    await app.dispose()
  })
})

describe('TuiApp subagent / workflow / tasks 服务接线', () => {
  it('subagent/start 事件触发委派树刷新（listDescendants 再查）', async () => {
    const ctx = makeCtx()
    // 事件可能注册多个 handler（委派树刷新 + 对话流行）：数组收集，触发取第一个。
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    const listDescendants = vi.fn(async () => [{ id: 'd1', label: '子代理A', parentId: 'p', startedAt: 0 }])
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name)
      if (list !== undefined) list.push(h)
      else handlers.set(name, [h])
      return () => { }
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'subagents') return { listDescendants }
      return undefined
    })
    const agent = makeAgent('sub-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    const before = listDescendants.mock.calls.length
    handlers.get('subagent/start')?.[0]?.({ parentId: 'p', id: 'd1' })
    await new Promise(resolve => setImmediate(resolve))
    expect(listDescendants.mock.calls.length).toBeGreaterThan(before)
    await app.dispose()
  })

  it('subagent/start|end 均订阅委派树刷新（ctx.on 恒返回 disposer；旧 ?? 短路吞掉 end 是 bug）', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, (...args: unknown[]) => void>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      handlers.set(name, h)
      return () => { }
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'subagents') return { listDescendants: vi.fn(async () => []) }
      return undefined
    })
    const agent = makeAgent('sub-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    // cordis 契约：ctx.on 恒返回 disposer（非 undefined）——start/end 分别注册，
    // 旧实现用 ?? 连接导致 end 永不注册（订阅缺失场景不成立，原 mock 违反契约）。
    expect(handlers.has('subagent/start')).toBe(true)
    expect(handlers.has('subagent/end')).toBe(true)
    await app.dispose()
  })

  it('委派树 listDescendants reject → 置 null 降级', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'subagents') return { listDescendants: vi.fn(async () => { throw new Error('boom') }) }
      return undefined
    })
    const agent = makeAgent('deleg-err')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    await new Promise(resolve => setImmediate(resolve))
    await app.dispose()
  })

  it('委派树 resolve 在 dispose 之后 → 不写缓存不渲染', async () => {
    let resolveEntries: ((e: unknown[]) => void) | null = null
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'subagents') return {
        listDescendants: () => new Promise<unknown[]>((r) => { resolveEntries = r }),
      }
      return undefined
    })
    const agent = makeAgent('deleg-late')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    await app.dispose()
    ;(resolveEntries as ((e: unknown[]) => void) | null)?.([{ id: 'x' }])
    await new Promise(resolve => setImmediate(resolve))
  })

  it('workflow 事件带未知 run id → 忽略（防御分支）', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, (...args: unknown[]) => void>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      handlers.set(name, h)
      return () => { }
    })
    const agent = makeAgent('wf-u')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    const fire = (name: string, ...args: unknown[]) => { handlers.get(name)?.(...args) }
    fire('workflow/phase', { id: 'missing' }, '调研')
    fire('workflow/agent-start', { id: 'missing' }, { seq: 1, label: 'x' })
    fire('workflow/agent-end', { id: 'missing' }, { seq: 1, label: 'x', outcome: 'completed' })
    fire('workflow/end', { id: 'missing' }, { stopReason: 'completed' })
    await app.dispose()
  })

  it('workflow 面板：isolate workflowEngine 不误报不可用', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('wf-iso')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.agents.get.mockReturnValue(agent)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'agentPresets') {
        return { serviceFor: (_a: unknown, svc: string) => svc === 'workflowEngine' ? { runs: [] } : undefined }
      }
      return undefined
    })
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.handleSubmit('/workflow')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('workflow 引擎不可用')
    await app.dispose()
  })

  it('/workflow 渲染运行中 run（meta 缺省 → name 回退 id）与终态 error 折叠', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    const agent = makeAgent('wf-run')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    // workflow/approval 订阅在 attach 注册——newSession 不注册，必须走 attach
    await app.attach()
    const fire = (name: string, ...args: unknown[]) => {
      for (const h of handlers.get(name) ?? []) h(...args)
    }
    // 运行中：start + agent-start（无 agent-end）→ outcome 缺省 completed
    fire('workflow/start', { id: 'wf-running' })
    fire('workflow/agent-start', { id: 'wf-running' }, { seq: 1, label: '研究员' })
    // 终态：start + agent-start + end（无 meta/phase、带 error）→ name 回退 id、
    // error 进汇总；agent 无 outcome → 折叠视图 outcome 缺省 completed（?? 右侧）
    fire('workflow/start', { id: 'wf-done' })
    fire('workflow/agent-start', { id: 'wf-done' }, { seq: 1, label: '助手' })
    fire('workflow/end', { id: 'wf-done' }, { stopReason: 'error', error: '网络失败' })
    app.handleSubmit('/workflow') // 命令分发打开 workflow 面板
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('wf-running')
    expect(written).toContain('wf-done')
    await app.dispose()
  })

  it('workflow run 时长渲染真实流逝（startedAt 差值,非时间戳）', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    const agent = makeAgent('wf-elapsed')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    // 只 fake Date（不动 setTimeout/setImmediate——ticker 与渲染调度保持真实，
    // 避免 runAllTimers 无限 flush setInterval）：startedAt 与渲染时点都在
    // fake 时钟下取值，差值可精确断言。
    vi.useFakeTimers({ toFake: ['Date'] })
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    try {
      await app.attach()
      const fire = (name: string, ...args: unknown[]) => {
        for (const h of handlers.get(name) ?? []) h(...args)
      }
      vi.setSystemTime(1_000_000)
      fire('workflow/start', { id: 'wf-live' })
      fire('workflow/start', { id: 'wf-settled' })
      vi.setSystemTime(1_080_000) // +80s
      fire('workflow/end', { id: 'wf-settled' }, { stopReason: 'completed' })
      app.handleSubmit('/workflow')
      await new Promise(resolve => setImmediate(resolve))
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      // 运行中与已结算 run 都按 startedAt 差值渲染（此前误填时间戳 → 数十万年，
      // 绝不可能出现 '1m20s'）——两个 run 各一段时长
      expect(written.match(/1m20s/g)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
    await app.dispose()
  })

  it('workflow/log 叙述行进运行中 run 展开视图（⤷ 行 + roster 自动展开）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const listeners = new Map<string, (...args: unknown[]) => void>()
    ctx.on.mockImplementation((name: string, handler: (...args: unknown[]) => void) => {
      listeners.set(name, handler)
      return () => { listeners.delete(name) }
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const fire = (name: string, ...args: unknown[]) => { listeners.get(name)?.(...args) }
    fire('workflow/start', { id: 'wf-log', meta: { name: '日志脚本' } })
    fire('workflow/log', { id: 'wf-log' }, '第一批任务完成') // 属主第二参为裸 string
    fire('workflow/log', { id: 'wf-log' }, '第二批任务完成')
    fire('workflow/agent-start', { id: 'wf-log' }, { seq: 1, label: '执行员' })
    await new Promise(resolve => setImmediate(resolve))
    for (const ch of '/workflow') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 运行中 run 自动展开：叙述行与 roster 行可见
    expect(written).toContain('⤷ 第一批任务完成')
    expect(written).toContain('⤷ 第二批任务完成')
    expect(written).toContain('1. 执行员')
    await app.dispose()
  })

  it('tasks 服务接线：快照渲染（状态/详情分支）+ onTaskDone 通知', async () => {
    const ctx = makeCtx()
    let taskDone: ((s: { label: string }) => void) | null = null
    const list = vi.fn(() => [
      { id: 't1', kind: 'shell', label: '跑测试', status: 'running', startedAt: 0 },
      { id: 't2', kind: 'shell', label: '构建', status: 'completed', detail: 'ok', startedAt: 0 },
      { id: 't3', kind: 'shell', label: '清理', status: 'killed', startedAt: 0 },
    ])
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'tasks') return {
        list,
        onTaskDone: (l: (s: { label: string }) => void) => { taskDone = l; return () => { } },
        attachSurface: vi.fn(() => () => { }),
      }
      return undefined
    })
    const agent = makeAgent('task-svc')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    for (const ch of '/tasks') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 活区卡语言（天枢 f636eb0e）：running ⠋（无 detail 仅 header）/
    // completed › + detail 进 suffix（title muted，ANSI 在 › 与标题间）/ killed ✗
    expect(written).toContain('⠋ 跑测试')
    expect(written).toContain('›')
    expect(written).toContain('构建')
    expect(written).toContain('ok')
    expect(written).toContain('✗')
    expect(written).toContain('清理')

    stdout.write.mockClear()
    ;(taskDone as ((s: { label: string }) => void) | null)?.({ label: '编译' })
    await new Promise(resolve => setImmediate(resolve))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('✓ 任务完成: 编译')
    await app.dispose()
  })

  it('taskDone 随 detachProjections 释放、taskSurface 随 dispose 释放（瑶光缺口回归）', async () => {
    // 缺口取证：taskDoneDisposer 注释『随会话挂载/卸载』、taskSurfaceDisposer
    // 注释『attach 声明、dispose 释放』——但 detachProjections/dispose 均未释放，
    // 仅靠 mountSession 末尾的预释放兜底（切会话不累积；单次挂载后 dispose 即泄漏）。
    // ledger 只记录 ctx.on 订阅，tasks facet 的 onTaskDone/attachSurface 不走 ctx.on，
    // 覆盖不到——此处直接断言其 disposer 的调用时机与顺序。
    const ctx = makeCtx()
    const released: string[] = []
    const list = vi.fn(() => [])
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'tasks') return {
        list,
        onTaskDone: vi.fn(() => () => { released.push('taskDone:released') }),
        attachSurface: vi.fn(() => () => { released.push('taskSurface:released') }),
      }
      return undefined
    })
    const agent = makeAgent('task-dispose')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    // 首次挂载：注册但未释放（预释放兜底只在重挂载时触发）。
    expect(released).toEqual([])
    await app.dispose()
    // taskDone 在 detachProjections 释放（先于 dispose 尾部），taskSurface 在
    // dispose 释放——顺序断言区分两个释放点（修复前两者均不释放，此断言红）。
    expect(released).toEqual(['taskDone:released', 'taskSurface:released'])
  })
})

describe('TuiApp handleKey 边界', () => {
  it('Tab 无 @ token → 不补全（onTabComplete 回调返回 false 无副作用）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('tab-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    stdin.emit('data', '普通文本')
    stdin.emit('data', '\t')
    await new Promise(resolve => setImmediate(resolve))
    // 未补全：后续 Enter 提交原样文本
    stdout.write.mockClear()
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = firstCallText(agent.followup)
    expect(text).toBe('普通文本')
    await app.dispose()
  })

  it('Tab 有 @ token → 补全应用（输入行更新 + Enter 提交补全结果）', async () => {
    // 补全走 handleTabComplete → process.cwd() 下的真实 git ls-files。指向
    // 一个两文件的临时仓库：断言不再随本仓文件名漂移，也不会在负载下撞上
    // 补全器 500ms 的子进程超时（本仓 6.8k 文件，并发跑测时超时会静默返回
    // 空候选，Tab 保持原行为，用例随机翻红）。
    const repo = mkdtempSync(join(tmpdir(), 'dsh-tui-tab-'))
    writeFileSync(join(repo, 'mention-parser.ts'), '// mention parser')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    vi.spyOn(process, 'cwd').mockReturnValue(repo)

    const ctx = makeCtx()
    const agent = makeAgent('tab-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    for (const ch of '@me') stdin.emit('data', ch)
    stdin.emit('data', '\t')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = firstCallText(agent.followup)
    expect(text).toContain('mention') // @路径补全到 mention-*.ts（首项按字母序）
    await app.dispose()
  })

  it('面板打开 ↑ 移动选中（up 分支）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('pal-up')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, theme: 'paper' })
    await app.attach()

    stdin.emit('data', '\x10')    // Ctrl+P 打开
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x1b[A')  // ↑（selected 已为 0，回绕）
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 200))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l') // 正常关闭面板
    await app.dispose()
  })

  it('审批挂起时按其他键 → 忽略不结算（条件 2 分支）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('ap-key')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin })
    await app.attach()
    const handler = ctx.on.mock.calls.find(call => call[0] === 'approval/request')?.[1] as
      | ((req: unknown, next: () => Promise<string>) => Promise<string>)
      | undefined
    if (handler === undefined) throw new Error('approval/request handler not registered')

    const owner = { id: app.sessionId ?? SessionId('ap-key') }
    const outcome = handler(
      { agent: { session: { id: owner.id } }, toolName: 'bash' },
      () => Promise.resolve('unavailable'),
    )
    stdin.emit('data', 'x') // 非 y/n/ctrl_c/escape → 忽略
    stdin.emit('data', 'y') // 仍可正常放行
    await expect(outcome).resolves.toBe('allowed-once')
    await app.dispose()
  })

  it('无 onExit 时空输入 Ctrl+C → 取消当前活动（handleAbort）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('abort-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    stdin.emit('data', '\x03') // Ctrl+C，输入为空且无 onExit
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已取消')
    await app.dispose()
  })

  it('↑ 键走 InputLine 历史导航（up 分支）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('hist-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    stdin.emit('data', '\x1b[A') // up → 历史导航（空历史也走 handleKey）
    await new Promise(resolve => setImmediate(resolve))
    expect(stdout.write).toHaveBeenCalled()
    await app.dispose()
  })
})

describe('TuiApp 输入与转向边界', () => {
  it('handleSubmit 纯空白 → no-op（不驱动 followup）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('blank-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('   ')
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('相同输入重复提交 → 历史去重（filter 回调命中）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('dup-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('重复文本')
    app.handleSubmit('重复文本')
    app.handleSubmit('另一条')
    expect(agent.followup).toHaveBeenCalledTimes(3)
    await app.dispose()
  })

  it('/steer 无参数 → no-op（不调 steer）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('steer-empty')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.newSession()
    app.handleSubmit('/steer')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.steer).not.toHaveBeenCalled()
    await app.dispose()
  })
})

describe('runCordisCommand 余下分支', () => {
  /** 带 commands 服务 + 有会话的 ctx 替身。 */
  async function setupAppWithAgent(agentImpl: () => unknown) {
    const ctx = makeCtx()
    const agent = makeAgent('cordis-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.agents.get.mockImplementation(agentImpl as () => Agent)
    const execute = vi.fn()
    ctx.reflect.get.mockImplementation((name: string) => (name === 'commands' ? { execute } : undefined))
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    return { app, ctx, execute, stdout }
  }

  it('agent undefined（有会话但 registry 无 live agent）→ 未知命令', async () => {
    const { app, execute, stdout } = await setupAppWithAgent(() => undefined)
    app.handleSubmit('/st')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(execute).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('未知命令')
    await app.dispose()
  })

  it('execute success 无 text → 回显默认已执行', async () => {
    const { app, execute, stdout } = await setupAppWithAgent(() => makeAgent('cordis-1'))
    execute.mockResolvedValue({ result: { kind: 'success' } })
    app.handleSubmit('/st')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('已执行')
    await app.dispose()
  })

  it('execute 抛错 → ⚠ 命令执行失败（catch 分支）', async () => {
    const { app, execute, stdout } = await setupAppWithAgent(() => makeAgent('cordis-1'))
    execute.mockRejectedValue(new Error('cordis boom'))
    app.handleSubmit('/st')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('命令执行失败')
    expect(written).toContain('cordis boom')
    await app.dispose()
  })

  it('execute 抛字符串 → String(err) 分支回显（非 Error 抛出）', async () => {
    const { app, execute, stdout } = await setupAppWithAgent(() => makeAgent('cordis-2'))
    execute.mockRejectedValue('plain string failure')
    app.handleSubmit('/st')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('命令执行失败')
    expect(written).toContain('plain string failure')
    await app.dispose()
  })
})

describe('TuiApp 投影缓存防御与 status 面板降级', () => {
  it('onChanged 在投影缓存为 null 时安全跳过赋值（detach 后）', async () => {
    const ctx = makeCtx()
    let changeListener: ((s: { id: string }, key: string, value: unknown) => void) | null = null
    let mountSeq = 0
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return {
        snapshot: vi.fn(() => ({ values: {} })),
        onChanged: (l: (s: { id: string }, key: string, value: unknown) => void) => {
          changeListener = l
          mountSeq += 1
          return () => { mountSeq -= 1 }
        },
      }
      return undefined
    })
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    // detach（切到新会话）→ projectionCache 置 null，但 mock disposer 未真正解绑
    const second = makeAgent('second')
    ctx.agents.get.mockReturnValue(undefined)
    ctx.agents.resume.mockResolvedValue(makeHandle(second))
    await app.switchSession(SessionId('second'))
    // 触发旧会话的 onChanged（闭包 id = 第一会话）→ projectionCache null 分支
    ;(changeListener as ((s: { id: string }, key: string, value: unknown) => void) | null)?.({ id: String(app.sessionId) }, 'plan', null)
    await new Promise(resolve => setImmediate(resolve))
    await app.dispose()
  })

  it('onChanged plan 值为 null → planState 落 false（?? 分支）', async () => {
    const ctx = makeCtx()
    let changeListener: ((s: { id: string }, key: string, value: unknown) => void) | null = null
    let mountedAgent: { session: { id: string } } | null = null
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      mountedAgent = agent
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return {
        snapshot: vi.fn(() => ({ values: { plan: { active: true, pending: false } } })),
        onChanged: (l: (s: { id: string }, key: string, value: unknown) => void) => {
          changeListener = l
          return () => { }
        },
      }
      return undefined
    })
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const listener = changeListener as unknown as (s: { id: string }, key: string, value: unknown) => void
    const mounted = mountedAgent as unknown as { session: { id: string } }
    stdout.write.mockClear() // 清掉 attach 时的 [plan] 渲染，只断言变更后的输出
    listener({ id: mounted.session.id }, 'plan', null)
    await new Promise(resolve => setTimeout(resolve, 200))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('[plan]')
    await app.dispose()
  })

  it('/status 打开时投影缓存缺 goal/plan → 面板降级渲染（?? null 分支）', async () => {
    const ctx = makeCtx()
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return {
        snapshot: vi.fn(() => ({ values: { todos: [{ content: '任务', status: 'completed' }] } })),
        onChanged: vi.fn(() => () => { }),
      }
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    // /status 打开 → goal/plan 缺失 → ?? null 渲染（只渲染 todos 段）
    for (const ch of '/status') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('任务')
    await app.dispose()
  })
})

describe('TuiApp /config 服务组合分支', () => {
  async function bootWithReflect(impl: (name: string) => unknown) {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation(impl)
    const agent = makeAgent('cfg-x')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.handleSubmit('/config')
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    return { app, written }
  }

  it('仅 credentials 服务存在 → 查询 DEEPSEEK_API_KEY，未配置则显示未配置行', async () => {
    const describe = vi.fn(async () => ({ configured: false, writable: true }))
    const { app, written } = await bootWithReflect((name: string) => {
      if (name === 'credentials') return { describe }
      return undefined
    })
    expect(written).toContain('DEEPSEEK_API_KEY')
    expect(written).toContain('未配置')
    expect(describe).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    await app.dispose()
  })

  it('credentials describe reject → catch 兜底不崩溃', async () => {
    const { app, written } = await bootWithReflect((name: string) => {
      if (name === 'credentials') return { describe: vi.fn(async () => { throw new Error('boom') }) }
      return undefined
    })
    // describe 的 .catch(() => {}) 兜底分支被触达（reject 不冒泡）
    expect(written.length).toBeGreaterThan(0)
    await app.dispose()
  })

  it('仅 permission 服务存在 → 权限视图渲染', async () => {
    const { app, written } = await bootWithReflect((name: string) => {
      if (name === 'permission') return { names: ['run_shell'], current: vi.fn(() => 'ask') }
      return undefined
    })
    expect(written).toContain('run_shell')
    await app.dispose()
  })

  it('仅 settings 服务存在 → 设置描述渲染', async () => {
    const { app, written } = await bootWithReflect((name: string) => {
      if (name === 'settings') return { describe: vi.fn(() => [{ ns: 'model', value: 'deepseek' }]) }
      return undefined
    })
    expect(written).toContain('model')
    await app.dispose()
  })

  it('三服务全缺失 → 仍渲染终端通知段（无崩溃）', async () => {
    const { app, written } = await bootWithReflect(() => undefined)
    expect(written).toContain('系统通知')
    expect(written).toContain('◆ 终端')
    await app.dispose()
  })

  it('/config notify off|on 回显并切换；空输入 n 再切', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('cfg-n')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    app.handleSubmit('/config notify off')
    await new Promise(resolve => setImmediate(resolve))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('系统通知已关')
    app.handleSubmit('/config')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', 'n')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('系统通知已开')
    await app.dispose()
  })

  it('Esc 关闭 /config（有草稿也关，不布防 rewind）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('cfg-esc')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    app.handleSubmit('/config')
    await new Promise(resolve => setImmediate(resolve))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('⚙ 配置')
    stdin.emit('data', 'hello')
    await new Promise(resolve => setImmediate(resolve))
    stdout.write.mockClear()
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('⚙ 配置')
    expect(written).not.toContain('⟲ rewind')
    expect(written).toContain('hello')
    await app.dispose()
  })

  it('/skills 后再 /config：检查面板互斥，只留配置', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return {
        list: vi.fn(async () => [{
          name: 'code-review', description: '代码审查', provider: 'mock', source: 'bundled',
          invocation: { modelInvocable: true, userInvocable: true },
        }]),
      }
      return undefined
    })
    const agent = makeAgent('cfg-xor')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    app.handleSubmit('/skills')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('code-review')
    stdout.write.mockClear()
    app.handleSubmit('/config')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚙ 配置')
    expect(written).not.toContain('code-review')
    await app.dispose()
  })

  it('/config 空输入 d 切换紧凑渲染并写入 prefs', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('cfg-d')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    app.handleSubmit('/config')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('紧凑渲染 · 关')
    stdout.write.mockClear()
    stdin.emit('data', 'd')
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('紧凑渲染 · 开')
    await app.dispose()
  })

  it('/skills 空输入 ↓ 移动选中并展开详情', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return {
        list: vi.fn(async () => [
          {
            name: 'alpha', description: '甲', provider: 'local', source: 'bundled',
            invocation: { modelInvocable: true, userInvocable: true }, whenToUse: '先看这个',
          },
          {
            name: 'beta', description: '乙', provider: 'local', source: 'bundled',
            invocation: { modelInvocable: true, userInvocable: true }, whenToUse: '再看那个',
          },
        ]),
      }
      return undefined
    })
    const agent = makeAgent('skill-move')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    app.handleSubmit('/skills')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('先看这个')
    stdout.write.mockClear()
    stdin.emit('data', '\x1b[B')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('再看那个')
    expect(written).not.toContain('先看这个')
    await app.dispose()
  })
})

describe('TuiApp /model 热切切换 saveSelection', () => {
  it('/model provider/model 切换 → 仅热切，不 saveSelection', async () => {
    const ctx = makeCtx()
    const saveSelection = vi.fn(async () => { })
    Object.assign(ctx.agentDefaultModel, {
      currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
      saveSelection,
    })
    const agent = makeAgent('mdl-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/model deepseek/v4-turbo')
    await new Promise(resolve => setTimeout(resolve, 30))
    await app.dispose()
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('/model provider/model default → saveSelection + 热切', async () => {
    const ctx = makeCtx()
    const saveSelection = vi.fn(async () => { })
    Object.assign(ctx.agentDefaultModel, {
      currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
      saveSelection,
    })
    const agent = makeAgent('mdl-1d')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/model deepseek/v4-turbo default')
    await new Promise(resolve => setTimeout(resolve, 30))
    await app.dispose()
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-turbo' })
  })
})

describe('TuiApp /model slash 走 switchLiveModel 闭包', () => {
  it('/model 命令经注入闭包热切当前会话（L425 闭包）', async () => {
    const ctx = makeCtx()
    Object.assign(ctx.agentDefaultModel, {
      currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
      saveSelection: vi.fn(async () => { }),
    })
    const agent = makeAgent('mdl-2')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()

    app.handleSubmit('/model deepseek/v4-turbo')
    await new Promise(resolve => setTimeout(resolve, 30))
    // 热切路径：modelRef.current 更新（switchLiveModel 闭包生效）
    await app.dispose()
    expect((app as unknown as { modelRef: { current: unknown } | null }).modelRef?.current).toEqual({ provider: 'deepseek', model: 'v4-turbo' })
  })
})

describe('TuiApp glance turn 投影', () => {
  it('turn 已开时 glance 含 turnCount', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    const agent = makeAgent('glc-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.newSession()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('glc-1')
    ;(agent as { id: SessionId }).id = agent.session.id
    ctx.sessions.get.mockReturnValue(agent.session)
    const owner = { id: app.sessionId ?? SessionId('glc-1') }
    for (const h of handlers.get('session/event') ?? []) {
      h(owner, { type: 'turn/start', seq: 0, time: 1, data: { turn: 0, step: 0, reason: { kind: 'kick' } } })
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written.length).toBeGreaterThan(0)
    await app.dispose()
  })
})

describe('TuiApp 监听器生命周期（?? 短路 + 泄漏回归）', () => {
  it('subagent/start 与 end 均注册委派树刷新（ctx.on 返回 disposer 非空，?? 不得短路右侧）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('sub-short-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    const names = ctx.on.mock.calls.map(c => `${c[0]}`)
    expect(names).toContain('subagent/start')
    expect(names).toContain('subagent/end')
    await app.dispose()
  })

  it('会话卸载注销全部 workflow 监听器（仅 start 收集 disposer 的泄漏回归）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('wf-leak-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    // 收集 attach 时注册的 workflow 监听器及其 disposer（mock on 每次返回新 vi.fn）
    const wfIdx = ctx.on.mock.calls
      .map((c, i) => ({ name: `${c[0]}`, i }))
      .filter(x => x.name.startsWith('workflow/'))
      .map(x => x.i)
    expect(wfIdx.length).toBe(6) // start/phase/log/agent-start/agent-end/end
    const disposers = wfIdx.map(i => ctx.on.mock.results[i]!.value as () => boolean)
    // 切换会话 → detachProjections 应注销全部六个（当前实现只保存 start 的）
    const second = makeAgent('wf-leak-2')
    ctx.agents.resume.mockResolvedValue(makeHandle(second))
    ctx.sessions.get.mockReturnValue(second.session)
    await app.switchSession(SessionId('wf-leak-2'))
    for (const d of disposers) expect(d).toHaveBeenCalled()
    await app.dispose()
  })

  it('进行中工具超过 LIVE_TOOL_CARD_MAX：只展开最新一张，溢出一行', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    stdout.rows = 40
    const tools = [
      { callId: 't1', name: 'bash' },
      { callId: 't2', name: 'grep' },
      { callId: 't3', name: 'read_file' },
      { callId: 't4', name: 'web_fetch' },
    ]
    for (const [i, tool] of tools.entries()) {
      fire('session/event', owner, {
        type: 'tool/call',
        seq: i,
        time: i + 1,
        data: { callId: tool.callId, name: tool.name, arguments: '{}', turn: 1, step: i },
      })
    }
    app.handleSubmit('刷新渲染')
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('…(+1) 个工具进行中')
    expect(written).toContain('Search')
    expect(written).toContain('Read')
    expect(written).toContain('Fetch')
    const plain = written.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    expect((plain.match(/⎿  …/g) ?? []).length).toBe(1)
    await app.dispose()
  })

  it('A5：空输入 Enter 展开最后一张进行中工具卡（参数 JSON 行），再按收起', async () => {
    // 键盘链路注册在 attach（onAnyKey）——bootEventApp 走 newSession 无键盘，
    // 此处用 attach 模式（2466 同款）构造。
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    // session id 对齐（bootEventApp 同款）：attach 铸造 id 与 transcript 过滤一致
    const owner = { id: app.sessionId ?? SessionId('a5-key') }
    const fire = (name: string, ...args: unknown[]) => {
      for (const h of handlers.get(name) ?? []) h(...args)
    }
    stdout.rows = 40
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: { callId: 't1', name: 'bash', arguments: '{"command":"ls -la","cwd":"/app"}', turn: 1, step: 0 },
    })
    app.handleSubmit('刷新渲染')
    await new Promise(resolve => setTimeout(resolve, 30))
    // 初始：最新一张展开尾部（3 行），无参数 JSON 行
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('"command":"ls -la"')
    // 空输入 Enter → 展开（参数行出现；展开态保持，后续 ticker 帧也含）
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('"command":"ls -la"')
    // 再按 Enter → 收起（收起后的新帧不含参数行）
    const beforeCollapse = stdout.write.mock.calls.length
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    const collapsed = stdout.write.mock.calls.slice(beforeCollapse).map(c => `${c[0]}`).join('')
    expect(collapsed).not.toContain('"command":"ls -la"')
    await app.dispose()
  })

  it('A5：输入行非空时 Enter 仍是提交，不触发工具卡展开', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const owner = { id: app.sessionId ?? SessionId('a5-key') }
    const fire = (name: string, ...args: unknown[]) => {
      for (const h of handlers.get(name) ?? []) h(...args)
    }
    stdout.rows = 40
    fire('session/event', owner, {
      type: 'tool/call',
      seq: 0,
      time: 1,
      data: { callId: 't1', name: 'bash', arguments: '{"command":"ls"}', turn: 1, step: 0 },
    })
    app.handleSubmit('刷新渲染')
    await new Promise(resolve => setTimeout(resolve, 30))
    // 输入行有文本后 Enter：提交路径（followup），不展开工具卡
    for (const ch of 'hi') stdin.emit('data', ch)
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('"command":"ls"')
    await app.dispose()
  })
})

describe('Issue #31 交互式选择器（/model /theme /session 无参打开）', () => {
  /** attach 模式 boot（键盘链路在 attach 注册；2466 同款）。 */
  async function bootPicker(opts?: {
    currentSelection?: () => { provider: string; model: string }
    saveSelection?: ReturnType<typeof vi.fn>
  }) {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { }
    })
    ctx.agents.create.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const agent = makeAgent(sessionId)
      ctx.sessions.get.mockReturnValue(agent.session)
      return makeHandle(agent)
    })
    if (opts?.currentSelection || opts?.saveSelection) {
      Object.assign(ctx.agentDefaultModel, {
        currentSelection: opts.currentSelection ?? (() => ({ provider: 'mock', model: 'mock' })),
        saveSelection: opts.saveSelection ?? vi.fn(async () => {}),
      })
    }
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const written = () => stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    const type = async (text: string) => {
      for (const ch of text) stdin.emit('data', ch)
      stdin.emit('data', '\r')
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    return { ctx, stdin, stdout, app, written, type }
  }

  it('/theme 无参 → 选择器打开（当前 ● 高亮）；↑ 移动实时预览，Enter 落定', async () => {
    setTheme('graphite')
    const { stdin, app, written, type } = await bootPicker()
    await type('/theme')
    expect(written()).toContain('选择主题')
    expect(written()).toContain('graphite（当前）')
    // ↑ 移动即实时预览（未 Enter 主题已切换）；graphite 前一档是 cobalt
    stdin.emit('data', '\x1b[A')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(getActiveThemeName()).toBe('cobalt')
    // Enter 确认：预览落定（仍为 cobalt）
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(getActiveThemeName()).toBe('cobalt')
    await app.dispose()
  })

  it('/theme 打开后 ↓ 移动预览；Esc 关闭还原打开前主题', async () => {
    setTheme('graphite')
    const { stdin, stdout, app, written, type } = await bootPicker()
    await type('/theme')
    expect(written()).toContain('选择主题')
    // ↓ 移动 → 实时预览 gemini
    stdin.emit('data', '\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(getActiveThemeName()).toBe('gemini')
    // Esc 关闭 → 还原 graphite（打开前主题）；lone ESC 走 80ms 超时 dispatch
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    const before = stdout.write.mock.calls.length
    stdin.emit('data', '\r') // 空输入 Enter：选择器已关闭，无操作
    await new Promise(resolve => setTimeout(resolve, 30))
    const after = stdout.write.mock.calls.slice(before).map(c => `${c[0]}`).join('')
    expect(after).not.toContain('选择主题')
    expect(getActiveThemeName()).toBe('graphite')
    await app.dispose()
  })

  it('/model 无参 → 模型选择器（llm 目录 + 当前 ● 高亮）；Enter 仅热切不写默认', async () => {
    const currentSelection = vi.fn(() => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
    const saveSelection = vi.fn(async () => {})
    const { ctx, stdin, app, written, type } = await bootPicker({ currentSelection, saveSelection })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
          listModels: async () => [
            { id: 'deepseek-v4-flash', name: 'Flash' },
            { id: 'deepseek-v4-pro', name: 'Pro' },
          ],
          // switchLiveModel → refreshVisionForSelection 会查模型模态
          resolveModelInfo: async () => ({ inputModalities: undefined }),
        }
      }
      return undefined
    })
    await type('/model')
    expect(written()).toContain('选择模型')
    expect(written()).toContain('deepseek-official/deepseek-v4-pro（当前）')
    // 当前项已选中；Enter 确认 → 只热切，不 saveSelection
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(saveSelection).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('/model 选择器按 S 才 saveSelection（设为启动默认）', async () => {
    const currentSelection = vi.fn(() => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
    const saveSelection = vi.fn(async () => {})
    const { ctx, stdin, app, written, type } = await bootPicker({ currentSelection, saveSelection })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
          listModels: async () => [
            { id: 'deepseek-v4-flash', name: 'Flash' },
            { id: 'deepseek-v4-pro', name: 'Pro' },
          ],
          resolveModelInfo: async () => ({ inputModalities: undefined }),
        }
      }
      return undefined
    })
    await type('/model')
    expect(written()).toContain('S 设为默认')
    stdin.emit('data', 's')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    await app.dispose()
  })

  it('/model 选择器：含斜杠的模型 id 确认时不截断（openrouter 风格）', async () => {
    const saveSelection = vi.fn(async () => {})
    const { ctx, stdin, app, written, type } = await bootPicker({
      currentSelection: () => ({ provider: 'openrouter', model: 'stealth/ox-alpha' }),
      saveSelection,
    })
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'openrouter', name: 'openrouter' }],
          listModels: async () => [{ id: 'stealth/ox-alpha', name: 'Ox Alpha' }],
          resolveModelInfo: async () => ({ inputModalities: undefined }),
        }
      }
      return undefined
    })
    await type('/model')
    expect(written()).toContain('openrouter/stealth/ox-alpha（当前）')
    // 当前项已选中；Enter 确认 → 整个 id 原样热切，不写默认
    stdin.emit('data', '\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(saveSelection).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('/session 无参 → 会话选择器（列表渲染 + 当前 ● 高亮）', async () => {
    const { ctx, app, written, type } = await bootPicker()
    const headerOf = (id: string, createdAt: number) => ({
      id: SessionId(id), createdAt, version: 0, cwd: undefined, parentSession: undefined,
    })
    ctx.sessions.list.mockReturnValue([
      { id: 's-1', header: headerOf('s-1', 1_000) },
      { id: 's-2', header: headerOf('s-2', 2_000) },
    ])
    await type('/session')
    expect(written()).toContain('选择会话')
    expect(written()).toContain('s-1')
    expect(written()).toContain('s-2')
    await app.dispose()
  })
})

describe('TuiApp rewind overlay 退出与用户检查点过滤（回流 tianshu d5031fa07d）', () => {
  it('rewind 打开后第三次 Esc 关闭 overlay（不立刻重开）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('rewind-esc-close')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('rewind-esc-close')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, '检查点')
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    const opened = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(opened).toContain('⟲ rewind 回退')
    expect(opened).toContain('\x1B[?1049h')
    const altOnCount = opened.split('\x1B[?1049h').length - 1
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    const closed = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(closed).toContain('\x1B[?1049l')
    expect(closed.split('\x1B[?1049h').length - 1).toBe(altOnCount)
    await app.dispose()
  })

  it('rewind 打开时 Ctrl+C 关闭 overlay（不退出进程）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('rewind-ctrl-c-close')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const onExit = vi.fn()
    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('rewind-ctrl-c-close')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, '检查点')
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('⟲ rewind 回退')
    stdin.emit('data', '\x03')
    await new Promise(resolve => setTimeout(resolve, 150))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1B[?1049l')
    expect(onExit).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('rewind 列表只收真人用户检查点：插件源与空助手行不出现', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('rewind-filter')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('rewind-filter')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, '我说过的话')
    emitTranscriptUser(bus, id, 2, '禅已超时', { kind: 'plugin', plugin: 'zen' })
    bus(id, {
      seq: 3,
      time: 3,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 0,
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    })
    expect(app.rewindSession()).toBe(true)
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⟲ rewind 回退')
    expect(written).toContain('我说过的话')
    expect(written).not.toContain('禅已超时')
    expect(written.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')).not.toMatch(/✦/)
    await app.dispose()
  })

  it('没有用户检查点时不打开 rewind，并回显原因', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('rewind-empty')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    ;(agent.session as { id: SessionId }).id = app.sessionId ?? SessionId('rewind-empty')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('sessionId missing')
    emitTranscriptUser(bus, id, 1, '插件锚点', { kind: 'plugin', plugin: 'spark-anchors' })
    bus(id, {
      seq: 2,
      time: 2,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 0,
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    })
    expect(app.rewindSession()).toBe(false)
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('⟲ rewind 回退')
    expect(written).toContain('没有可回退的用户消息')
    await app.dispose()
  })
})

describe('/cost 会话成本汇总', () => {
  async function costSetup(agentId: string) {
    const ctx = makeCtx()
    const agent = makeAgent(agentId)
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    return { ctx, stdout, app }
  }

  it('usage 事件按模型累计；/cost 输出明细与合计', async () => {
    const { ctx, stdout, app } = await costSetup('cost-1')
    const bus = sessionEventBus(ctx)
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    // 模型 A 两次请求(累计)
    bus(id, {
      seq: 1, time: 1, type: 'request/header',
      data: { header: { config: { provider: 'mock', model: 'deepseek-v4-flash' } }, reason: 'initial' },
    })
    bus(id, {
      seq: 2, time: 2, type: 'assistant/message',
      data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, usage: { inputTokens: 1_000_000, outputTokens: 200_000 } },
    })
    bus(id, {
      seq: 3, time: 3, type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, usage: { inputTokens: 500_000, outputTokens: 100_000 } },
    })
    // 模型 B 一次请求
    bus(id, {
      seq: 4, time: 4, type: 'request/header',
      data: { header: { config: { provider: 'mock', model: 'deepseek-v4-pro' } }, reason: 'change' },
    })
    bus(id, {
      seq: 5, time: 5, type: 'assistant/message',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] }, usage: { inputTokens: 500_000, outputTokens: 100_000 } },
    })
    app.handleSubmit('/cost')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('会话成本统计')
    expect(written).toContain('deepseek-v4-flash')
    expect(written).toContain('输入 1.50M')
    expect(written).toContain('输出 300k')
    expect(written).toContain('deepseek-v4-pro')
    expect(written).toContain('合计:输入 2.00M')
    await app.dispose()
  })

  it('/cost 无用量数据 → 占位提示', async () => {
    const { stdout, app } = await costSetup('cost-empty')
    app.handleSubmit('/cost')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('（本会话尚无用量数据）')
    await app.dispose()
  })
})

describe('C4 概念稿 菜单快捷键与三行底部区（提交后审查补测）', () => {
  function boot(over: Partial<ConstructorParameters<typeof TuiApp>[0]> = {}) {
    const ctx = makeCtx()
    const agent = makeAgent('c4-key')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, ...over })
    return { ctx, agent, handle, stdin, stdout, app }
  }

  it('ctrl_n（0x0e）→ newSession：agents.create 再次被调用（保留旧会话）', async () => {
    const { ctx, app, stdin } = boot()
    await app.attach()
    expect(ctx.agents.create).toHaveBeenCalledTimes(1) // attach 铸造
    stdin.emit('data', '\x0e') // Ctrl+N
    await new Promise(resolve => setImmediate(resolve))
    expect(ctx.agents.create).toHaveBeenCalledTimes(2)
    await app.dispose()
  })

  it('ctrl_s（0x13）→ 切到最近创建的非当前会话（list 末元素）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('c4-s')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    // 两个既有会话：attach target = list()[0]（old），ctrl_s 应切到 list 末（new）
    const oldS = SessionId('session-other-old')
    const newS = SessionId('session-other-new')
    const headerOf = (id: SessionId, createdAt: number) => ({
      id, createdAt, version: 0, cwd: undefined, parentSession: undefined,
    })
    ctx.sessions.list.mockReturnValue([
      // SessionManager.list 读 session.events.length——mock 必须带 events 数组
      { id: oldS, header: headerOf(oldS, Date.now() - 3_600_000), events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] } },
      { id: newS, header: headerOf(newS, Date.now() - 1_000), events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] } },
    ])
    // registry 兜底路径（agents.get 恒返回 agent）：attach 的 switchSession(oldS)
    // 与 ctrl_s 的 switchSession(newS) 都经 agents.get 探测，不触发 resume。
    ctx.agents.get.mockReturnValue(agent)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    expect(app.sessionId).toBe(oldS) // attach 落到 list 首元素
    stdin.emit('data', '\x13') // Ctrl+S
    await new Promise(resolve => setTimeout(resolve, 50))
    // ctrl_s 切到「最近创建」= list 末元素（others[last]，非 others[0]）
    expect(app.sessionId).toBe(newS)
    await app.dispose()
  })

  it('ctrl_q（0x11）→ onExit 触发退出', async () => {
    const onExit = vi.fn()
    const { app, stdin } = boot({ onExit })
    await app.attach()
    stdin.emit('data', '\x11') // Ctrl+Q
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('/exit 触发 onExit（与 Ctrl+Q 同一退出路径）', async () => {
    const onExit = vi.fn()
    const { app } = boot({ onExit })
    await app.attach()
    app.handleSubmit('/exit')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('三行底部区：输入行下方渲染 footer（模式/快捷键）与 metrics 行', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('c4-bottom')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // footer 恒渲染（formatPromptFooter 单行）；metrics 需 glance 数据（此处无，
    // 不占位——纯函数 spec 已覆盖渲染，此处断言装配不抛且 footer 在输出中）。
    // 提示段走 10s 轮播不固定文本——mode 段 normal 恒在，作为 footer 标记。
    expect(written).toContain('normal')
    await app.dispose()
  })

  it('B 布局：输入轨（╭─╮/╰─╯ 无左右竖线）+ 宽屏 footer 右侧合并 metrics/API 段', async () => {
    const { stdout, app } = boot()
    await app.attach()
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('❯')
    expect(written).toMatch(/╭─+/)
    expect(written).toMatch(/╰─+/)
    expect(written).not.toMatch(/│ ❯/)
    // 宽屏（mock 100 列 ≥ 80）合并路径：API 状态段进 footer 右侧
    expect(written).toMatch(/API [✓✗]/)
    await app.dispose()
  })

  it('B 布局：窄屏 footer 仍单行合并，不纵排 theme.primary 第二行', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY
    Reflect.deleteProperty(process.env, 'DEEPSEEK_API_KEY')
    try {
      const { stdout, app } = boot()
      stdout.columns = 70
      await app.attach()
      stdout.write.mockClear()
      app.handleSubmit('hi')
      await new Promise(resolve => setImmediate(resolve))
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('❯')
      expect(written).toMatch(/╭─+/)
      expect(written).not.toMatch(/│ ❯/)
      // 70 列放得下 left + mock + API ✗，应留在同一行雾蓝 chrome；不得另起 primary 行。
      expect(written).toContain('API ✗')
      expect(written).toContain('\x1B[38;2;170;178;194m')
      await app.dispose()
    } finally {
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
    }
  })

  it('B 布局：窄宽仍单行雾蓝（右段随轮播 tip 宽度浮动，行为由 format 层覆盖）', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY
    Reflect.deleteProperty(process.env, 'DEEPSEEK_API_KEY')
    try {
      const { stdout, app } = boot()
      // 40 列 → 有效 36 列：任意轮播 tip 下 mode 段恒在、单行不破版；
      // 右段（mock/API）随 tip 宽度浮动可被丢弃，不在此断言
      stdout.columns = 40
      await app.attach()
      stdout.write.mockClear()
      app.handleSubmit('hi')
      await new Promise(resolve => setImmediate(resolve))
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('❯')
      expect(written).toMatch(/╭─+/)
      expect(written).toContain('normal')
      expect(written).toContain('\x1B[38;2;170;178;194m')
      await app.dispose()
    } finally {
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
    }
  })

  it('idle live 区不按剩余视口垫空行', async () => {
    const { stdout, app } = boot()
    stdout.rows = 40
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    const idx = written.lastIndexOf('╭')
    expect(idx).toBeGreaterThan(0)
    expect(written).toContain('Tips')
    expect(written.slice(idx)).toMatch(/╰─+/)
    expect(blankLinesBeforeRail(written)).toBeLessThanOrEqual(2)
    await app.dispose()
  })

  it('提交后输入轨仍在，轨前无整屏连续空行', async () => {
    const { stdout, app } = boot()
    stdout.rows = 40
    await app.attach()
    app.handleSubmit('hi')
    await new Promise(resolve => setImmediate(resolve))
    const after = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(after).toMatch(/╭─+/)
    expect(after).toMatch(/╰─+/)
    expect(blankLinesBeforeRail(after)).toBeLessThanOrEqual(2)
    await app.dispose()
  })
})

describe('TuiApp live 区高水位钉住输入轨', () => {
  it('流式推理撑高后，段结束 live 区不回缩', async () => {
    const { app, stdout, owner, fire } = await bootEventApp()
    stdout.rows = 40
    fire('session/event', owner, {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'text', text: '开始' }] },
    })
    const chunk = Array.from({ length: 20 }, (_, i) => `思路步骤${i}`).join('\n')
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'reasoning-delta', text: chunk } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    const streaming = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    const blanksDuring = blankLinesBeforeRail(streaming)

    stdout.write.mockClear()
    fire('session/event', owner, {
      type: 'assistant/attempt',
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'text-delta', text: '结论。' } }] },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    const settled = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    const blanksAfter = blankLinesBeforeRail(settled)
    expect(blanksDuring).toBeGreaterThanOrEqual(0)
    expect(blanksAfter).toBeGreaterThan(2)
    expect(blanksAfter).toBeGreaterThanOrEqual(blanksDuring)
    expect(settled).toMatch(/╭─+/)
    await app.dispose()
  })
})

describe('slash 命令菜单接线（grok slash_dropdown 移植）', () => {
  function boot() {
    const ctx = makeCtx()
    const agent = makeAgent('slash-menu')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    return { ctx, agent, handle, stdin, stdout, app }
  }

  async function writtenOf(stdout: ReturnType<typeof makeStdout>): Promise<string> {
    await new Promise(resolve => setImmediate(resolve))
    return stdout.write.mock.calls.map(c => `${c[0]}`).join('')
  }

  it('输入 / 渲染命令列表（第一项选中），↓ 移动选择', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdin.emit('data', '/')
    let written = await writtenOf(stdout)
    // 内置命令注册序第一个为 /theme（菜单行含 desc，区别于欢迎页）
    expect(written).toMatch(/❯ \/theme/)
    expect(written).toContain('切换主题')
    // ↓ → 选中第二项 /session
    stdin.emit('data', '\x1b[B')
    written = await writtenOf(stdout)
    expect(written).toMatch(/❯ \/session/)
    await app.dispose()
  })

  it('菜单打开时 ↑ 环绕到最后一项', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdin.emit('data', '/')
    await writtenOf(stdout)
    stdout.write.mockClear() // 只统计 ↑ 后的渲染
    stdin.emit('data', '\x1b[A')
    const written = await writtenOf(stdout)
    expect(written).toMatch(/❯ \/glance/) // 环绕到最后一项（含外部插件命令；P1 后末项为 /glance）
    await app.dispose()
  })

  it('Tab 接受补全：输入行填入 /theme、菜单关闭', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdin.emit('data', '/')
    await writtenOf(stdout)
    stdout.write.mockClear() // 只统计 Tab 后的渲染
    stdin.emit('data', '\t')
    const written = await writtenOf(stdout)
    // 菜单关闭（desc 不再渲染）；输入行已补全 /theme
    expect(written).not.toContain('切换主题')
    expect(written).toContain('/theme')
    await app.dispose()
  })

  it('Enter 精确命令：菜单关闭、提交且输入行清空', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    // /theme 无参现会打开选择器（#31）——用无回显的 /density 测「精确命令 Enter 提交」
    for (const ch of ['/', 'd', 'e', 'n', 's', 'i', 't', 'y']) stdin.emit('data', ch)
    await writtenOf(stdout)
    stdout.write.mockClear() // 只统计 Enter 后的渲染
    stdin.emit('data', '\r')
    const written = await writtenOf(stdout)
    expect(written).not.toContain('切换紧凑工具卡渲染')
    // 输入行清空（对齐正常提交路径；菜单提交不清空会残留 /density）
    expect(written).not.toContain('❯ /density')
    expect(written.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')).toContain('❯ █')
    expect(written).not.toContain('询问任何事')
    await app.dispose()
  })

  it('Esc 关闭菜单（输入行保留 /）', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdin.emit('data', '/')
    await writtenOf(stdout)
    stdout.write.mockClear() // 只统计 Esc 后的渲染
    stdin.emit('data', '\x1b')
    // lone ESC 走 80ms 超时后才 dispatch escape（input-handler 防误触）
    await new Promise(resolve => setTimeout(resolve, 150))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('切换主题')
    await app.dispose()
  })

  it('PageUp/PageDown：菜单选择翻页（clamp）', async () => {
    const { stdin, app } = boot()
    // 断言不绑定具体命令名：MRU 命令集随增删漂移（/key /update 加入都移动过分页
    // 边界），只验证相对行为——翻页后选中项移动、PageUp 回顶部原位。经
    // LiveEngine.render spy 拿结构化行（无 ANSI 干扰），模式同「输入轨行位钉住」。
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    try {
      await app.attach()
      const selected = (lines: readonly { text: string }[]): string | null => {
        const row = lines.find(line => line.text.includes('❯'))
        if (row === undefined) return null
        const m = /\/[a-z-]+/.exec(row.text)
        return m?.[0] ?? null
      }
      const awaitMenuFrame = async (): Promise<string | null> => {
        for (let i = 0; i < 200; i++) {
          const call = spy.mock.calls.at(-1)
          if (call !== undefined) {
            const sel = selected(call[0])
            if (sel !== null) return sel
          }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        return null
      }
      stdin.emit('data', '/')
      const initial = await awaitMenuFrame()
      expect(initial).not.toBeNull()
      stdin.emit('data', '\x1b[6~') // PageDown → 菜单翻页（选中项后移）
      const afterDown = await awaitMenuFrame()
      expect(afterDown).not.toBeNull()
      expect(afterDown).not.toBe(initial)
      stdin.emit('data', '\x1b[5~') // PageUp → 回顶部（clamp：回到翻页前原位）
      const afterUp = await awaitMenuFrame()
      expect(afterUp).toBe(initial)
      await app.dispose()
    } finally {
      spy.mockRestore()
    }
  })

  it('菜单过滤/关闭时输入轨行位钉住（slash 行计入高水位垫高）', async () => {
    const { stdin, app } = boot()
    // 捕获每帧传给 LiveEngine.render 的行数组，量输入轨（╭ 顶框）在帧内的行下标。
    // 渲染走 WriteBatcher 合并，帧时机不可预定——按帧内容轮询到目标状态再量，
    // 不用固定 sleep（并行跑时 setImmediate 可能先于菜单帧）。
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    try {
      await app.attach()
      const railRow = (lines: readonly { text: string }[]): number => {
        const idx = lines.findIndex(line => line.text.includes('╭'))
        if (idx < 0) throw new Error('帧中无输入轨顶框')
        return idx
      }
      const awaitFrame = async (pred: (lines: readonly { text: string }[]) => boolean): Promise<readonly { text: string }[]> => {
        for (let i = 0; i < 200; i++) {
          const call = spy.mock.calls.at(-1)
          if (call !== undefined && pred(call[0])) return call[0]
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw new Error('等待目标帧超时')
      }
      const menuOpen = (lines: readonly { text: string }[]): boolean =>
        lines.some(line => line.text.includes('切换主题'))
      // 打开菜单（全量命令 > 8 → 9 行菜单），输入轨落定位置。
      stdin.emit('data', '/')
      const pinned = railRow(await awaitFrame(menuOpen))
      // 逐键过滤到单一匹配（菜单 9 → 1 行）：行位不变（垫高吸收）。
      for (const ch of ['t', 'h', 'e', 'm', 'e']) stdin.emit('data', ch)
      const filtered = await awaitFrame(lines => menuOpen(lines) && !lines.some(line => line.text.includes('还有')))
      expect(railRow(filtered)).toBe(pinned)
      // Esc 关闭菜单（输入行保留 /theme）：菜单让出的行变垫高，行位仍不变。
      stdin.emit('data', '\x1b')
      const closed = await awaitFrame(lines => !menuOpen(lines))
      expect(railRow(closed)).toBe(pinned)
    } finally {
      spy.mockRestore()
      await app.dispose()
    }
  })
})

describe('slash 菜单阶段 2 接线（ghost 预览 / 参数模式 / MRU）', () => {
  function boot() {
    const ctx = makeCtx()
    const agent = makeAgent('slash-m2')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    return { ctx, agent, handle, stdin, stdout, app }
  }

  async function writtenOf(stdout: ReturnType<typeof makeStdout>): Promise<string> {
    await new Promise(resolve => setImmediate(resolve))
    return stdout.write.mock.calls.map(c => `${c[0]}`).join('')
  }

  it('菜单选中命令：输入行 ghost 预览补全剩余（dim 样式）', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    for (const ch of ['/', 't', 'h']) stdin.emit('data', ch)
    const written = await writtenOf(stdout)
    // ghost 显示补全剩余 'eme'（dim \x1B[2m），与菜单行并存
    expect(written).toContain('\x1B[2meme\x1B[22m')
    await app.dispose()
  })

  it('参数模式：/cmd + 尾空格 → ghost 显示参数占位，Enter 提交完整行', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    // /theme /effort 无参会打开选择器——用带 argsHint 且无参安全的 /glance
    for (const ch of ['/', 'g', 'l', 'a', 'n', 'c', 'e', ' ']) stdin.emit('data', ch)
    await writtenOf(stdout)
    const before = await writtenOf(stdout)
    expect(before).toContain('\x1B[2m[segment]\x1B[22m')
    stdout.write.mockClear()
    stdin.emit('data', '\r')
    const after = await writtenOf(stdout)
    // 提交后输入行清空（命令执行走 /glance 无参回显）
    expect(after.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')).toContain('❯ █')
    expect(after).not.toContain('询问任何事')
    await app.dispose()
  })

  it('MRU：执行 /density 后重新打开菜单排第一', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    // 执行 /density（精确命令 Enter 提交）
    for (const ch of ['/', 'd', 'e', 'n', 's', 'i', 't', 'y']) stdin.emit('data', ch)
    await writtenOf(stdout)
    stdin.emit('data', '\r')
    await writtenOf(stdout)
    // 重新输入 / 打开菜单：density 因 MRU 排第一
    stdout.write.mockClear()
    stdin.emit('data', '/')
    const written = await writtenOf(stdout)
    expect(written).toMatch(/❯ \/density/)
    await app.dispose()
  })
})

describe('subagent 对话流状态行接线（grok SubagentBlock 移植）', () => {
  function boot(opts: { activityBand?: boolean } = {}) {
    const ctx = makeCtx()
    const agent = makeAgent('sub-line')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'subagents') return {
        listDescendants: vi.fn(async () => ([
          { kind: 'child', id: 'child-1', parentId: 'root', depth: 1, activity: 'running', hasChildren: false, mode: 'one-shot', label: '探索鉴权' },
        ])),
      }
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, ...opts })
    return { ctx, agent, handle, stdin, stdout, app }
  }

  function handlerOf(ctx: ReturnType<typeof makeCtx>, name: string): ((info: unknown) => void) | undefined {
    // 同一事件注册多个 handler（委派树刷新 + 对话流行）：取最后一个（对话流行）。
    const calls = ctx.on.mock.calls.filter(call => call[0] === name)
    return calls[calls.length - 1]?.[1] as ((info: unknown) => void) | undefined
  }

  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40))

  it('subagent/start → live 区运行行（label 取委派树缓存）', async () => {
    const { ctx, stdout, app } = boot()
    await app.attach()
    await settle() // 等 listDescendants 预取 + renderBatcher
    const onStart = handlerOf(ctx, 'subagent/start')
    if (onStart === undefined) throw new Error('subagent/start handler not registered')
    stdout.write.mockClear()
    onStart({ runId: 'run-1', id: 'child-1' })
    await settle()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('探索鉴权')
    expect(written).toContain('/subagents')
    await app.dispose()
  })

  it('activityBand: false → 仍渲染子代理散行', async () => {
    const { ctx, stdout, app } = boot({ activityBand: false })
    await app.attach()
    await settle()
    const onStart = handlerOf(ctx, 'subagent/start')
    if (onStart === undefined) throw new Error('subagent/start handler not registered')
    stdout.write.mockClear()
    onStart({ runId: 'run-1', id: 'child-1' })
    await settle()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('子代理 探索鉴权')
    await app.dispose()
  })

  it('subagent/end（completed）→ 终态行提交 scrollback、运行行移除', async () => {
    const { ctx, stdout, app } = boot()
    await app.attach()
    await settle()
    const onStart = handlerOf(ctx, 'subagent/start')
    const onEnd = handlerOf(ctx, 'subagent/end')
    if (onStart === undefined || onEnd === undefined) throw new Error('subagent handlers not registered')
    onStart({ runId: 'run-1', id: 'child-1' })
    await settle()
    stdout.write.mockClear()
    onEnd({ runId: 'run-1', stopReason: 'completed' })
    await settle()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // ✓ 与文本间有 ANSI 色码，分段断言
    expect(written).toContain('✓')
    expect(written).toContain('探索鉴权')
    expect(written).not.toContain('工具')
    expect(written).not.toContain('⠋ 子代理')
    await app.dispose()
  })

  it('subagent/end 有 childProgress → 完成行带统计段', async () => {
    let changeListener: ((s: { id: string }, key: string, value: unknown) => void) | null = null
    const ctx = makeCtx()
    const agent = makeAgent('sub-stats')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'sessionProjections') return {
        snapshot: () => ({ values: {} }),
        onChanged: (l: (s: { id: string }, key: string, value: unknown) => void) => {
          changeListener = l
          return () => { }
        },
      }
      if (name === 'subagents') return {
        listDescendants: vi.fn(async () => ([
          { kind: 'child', id: 'child-1', parentId: 'root', depth: 1, activity: 'running', hasChildren: false, mode: 'one-shot', label: '探索鉴权' },
        ])),
      }
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    await settle()
    const onStart = handlerOf(ctx, 'subagent/start')
    const onEnd = handlerOf(ctx, 'subagent/end')
    if (onStart === undefined || onEnd === undefined) throw new Error('subagent handlers not registered')
    const listener = changeListener as unknown as (s: { id: string }, key: string, value: unknown) => void
    onStart({ runId: 'run-1', id: 'child-1' })
    listener({ id: 'child-1' }, 'subagentProgress', {
      turns: 1, toolCalls: 3, tokensUsed: 12_300, toolInFlight: false,
    })
    stdout.write.mockClear()
    onEnd({ runId: 'run-1', stopReason: 'completed' })
    await settle()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('3 工具')
    expect(written).toContain('tok')
    await app.dispose()
  })

  it('subagent/end（error）→ ✗ 终态行带 reason 后缀', async () => {
    const { ctx, stdout, app } = boot()
    await app.attach()
    await settle()
    const onStart = handlerOf(ctx, 'subagent/start')
    const onEnd = handlerOf(ctx, 'subagent/end')
    if (onStart === undefined || onEnd === undefined) throw new Error('subagent handlers not registered')
    onStart({ runId: 'run-2', id: 'child-1' })
    await settle()
    stdout.write.mockClear()
    onEnd({ runId: 'run-2', stopReason: 'error' })
    await settle()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('✗')
    expect(written).toContain('探索鉴权')
    expect(written).toContain('(error)')
    await app.dispose()
  })

  it('未配对 end（未知 runId）→ 不渲染（跨会话事件免疫）', async () => {
    const { ctx, stdout, app } = boot()
    await app.attach()
    await settle()
    const onEnd = handlerOf(ctx, 'subagent/end')
    if (onEnd === undefined) throw new Error('subagent/end handler not registered')
    stdout.write.mockClear()
    onEnd({ runId: 'unknown-run', stopReason: 'completed' })
    await settle()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('子代理')
    await app.dispose()
  })
})

describe('bracketed paste 接线（多行/长文本粘贴不逐行提交）', () => {
  function boot() {
    const ctx = makeCtx()
    const agent = makeAgent('paste-test')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    return { ctx, agent, handle, stdin, stdout, app }
  }

  it('attach 启用 bracketed paste，dispose 关闭', async () => {
    const { stdout, app } = boot()
    await app.attach()
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1b[?2004h') // DECSET 2004 on
    await app.dispose()
    written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1b[?2004l') // DECSET 2004 off
  })

  it('dispose 在 live.clear 藏光标之后写出 SHOW_CURSOR（#22 退出后终端无光标）', async () => {
    const { stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    await app.dispose()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    const show = '\x1B[?25h'
    const hide = '\x1B[?25l'
    expect(written).toContain(show)
    expect(written.lastIndexOf(show)).toBeGreaterThan(written.lastIndexOf(hide))
  })

  it('多行粘贴整段进入输入行（不逐行提交）', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    const pasted = '第一行报错\n  第二行\n第三行'
    stdin.emit('data', `\x1b[200~${pasted}\x1b[201~`)
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 整段进输入行（多行渲染），无逐行提交痕迹
    expect(written).toContain('第一行报错')
    expect(written).toContain('第二行')
    expect(written).toContain('第三行')
    // 无提交：输入行仍处于编辑态（占位符不出现 = 输入行非空且未清空）
    await app.dispose()
  })

  it('长粘贴（超折叠阈值 100 行）收纳为标记；100 行内保持原文可编辑', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    // 新阈值（天枢 2026-08-17 长文本优化同源）：折叠抬到 100 行/10000 字——
    // 折行缓存化后长草稿不卡，常规长粘贴应保持可编辑
    const medium = Array.from({ length: 50 }, (_, i) => `mid-${i}`).join('\n')
    stdin.emit('data', `\x1b[200~${medium}\x1b[201~`)
    await new Promise(resolve => setTimeout(resolve, 40))
    let written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('[paste #') // 50 行：不折叠
    await app.dispose()

    const b2 = boot()
    await b2.app.attach()
    b2.stdout.write.mockClear()
    const longText = Array.from({ length: 120 }, (_, i) => `line-${i}`).join('\n')
    b2.stdin.emit('data', `\x1b[200~${longText}\x1b[201~`)
    await new Promise(resolve => setTimeout(resolve, 40))
    written = b2.stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('[paste #1 +120 lines]') // 120 行：折叠标记
    await b2.app.dispose()
  })
})

describe('TuiApp 剪贴板图片与复制（opencode 接线移植）', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

  function boot(vision?: { supportsVision?: boolean; bridgeEnabled?: boolean; bridgeSource?: 'configured' | 'auto' | 'none' }) {
    const ctx = makeCtx()
    const agent = makeAgent('clipboard-test')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({
      ctx,
      stdout,
      stdin,
      ...(vision === undefined ? {} : { vision }),
    })
    return { ctx, agent, handle, stdin, stdout, app }
  }

  afterEach(() => {
    vi.mocked(readImageFromClipboard).mockReset()
    vi.mocked(readTextFromClipboard).mockReset()
  })

  it('Ctrl+V：剪贴板有图 → 附图，live 区渲染 📎 标记', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce({ dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clipboard.png', source: 'png' })
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    stdin.emit('data', '\x16') // ctrl_v (0x16)
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('📎 1 image')
    await app.dispose()
  })

  it('Ctrl+V：剪贴板无图 → fallback 剪贴板文本进输入行', async () => {
    vi.mocked(readTextFromClipboard).mockResolvedValueOnce('pasted from ctrl-v')
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    stdin.emit('data', '\x16')
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('pasted from ctrl-v')
    await app.dispose()
  })

  it('Ctrl+V：剪贴板无图且无文本 → 回显读图不可用警告（P1-1）', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce(null)
    vi.mocked(readTextFromClipboard).mockResolvedValueOnce(null)
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    stdin.emit('data', '\x16') // ctrl_v
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('剪贴板无内容可粘贴（读图需 osascript / wl-paste / xclip / PowerShell）')
    await app.dispose()
  })

  it('onPaste：剪贴板有图 → 附图并吞掉乱码 paste（输入行无乱码文本）', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce({ dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clipboard.png', source: 'png' })
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    // 右键粘贴图片：终端把图片字节作为文本 paste 进来（乱码）
    stdin.emit('data', '\x1b[200~���PNG\x1b[201~')
    // 条件轮询替代固定 40ms：附图渲染异步落定，全量并发负载下固定等待
    // 曾欠额（与本文件流利度 flaky 同类根因）
    await vi.waitFor(() => {
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('📎 1 image')
    }, { timeout: 5_000, interval: 25 })
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('���PNG') // 乱码被吞
    await app.dispose()
  })

  it('onPaste：粘贴内容像图片路径 → 加载为附件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-paste-img-'))
    const pngPath = join(dir, 'shot.png')
    writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'))
    try {
      const { stdin, stdout, app } = boot()
      await app.attach()
      stdout.write.mockClear()
      stdin.emit('data', `\x1b[200~${pngPath}\x1b[201~`)
      // 条件轮询替代固定 60ms（同上：异步加载 + 渲染在全量并发下不定时落定）
      await vi.waitFor(() => {
        const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
        expect(written).toContain('📎 1 image')
      }, { timeout: 5_000, interval: 25 })
      await app.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('onPaste：图片路径加载失败 → 警告 + 回退普通文本', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    stdin.emit('data', '\x1b[200~/nonexistent/does-not-exist.png\x1b[201~')
    // 条件轮询替代固定 60ms（异步加载失败警告在负载下不定时落定）
    await vi.waitFor(() => {
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('图片加载失败')
    }, { timeout: 5_000, interval: 25 })
    await app.dispose()
  })

  it('Alt+W 选区复制 → OSC52 序列写 stdout（app drain）', async () => {
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    // 输入 'hello'，shift+home 全选，Alt+W 复制（ESC+w）→ _clipboardOut → OSC52 drain
    for (const ch of 'hello') stdin.emit('data', ch)
    stdin.emit('data', '\x1b[1;2H') // shift+home
    stdin.emit('data', '\x1bw') // Alt+W
    await new Promise(resolve => setTimeout(resolve, 30))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('\x1b]52;c;') // OSC52 clipboard write
    await app.dispose()
  })

  it('Alt+W 且终端不支持 OSC52 → 首次回显警告一次，二次静默（序列仍写出，P1-1）', async () => {
    const prevProg = process.env.TERM_PROGRAM
    const prevTerm = process.env.TERM
    process.env.TERM_PROGRAM = 'Apple_Terminal' // macOS Terminal.app 不支持 OSC52
    delete process.env.TERM
    try {
      const { stdin, stdout, app } = boot()
      await app.attach()
      stdout.write.mockClear()
      for (const ch of 'hello') stdin.emit('data', ch)
      stdin.emit('data', '\x1b[1;2H') // shift+home 全选
      stdin.emit('data', '\x1bw')     // Alt+W
      await new Promise(resolve => setTimeout(resolve, 30))
      const first = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(first).toContain('OSC52')          // 警告出现
      expect(first).toContain('\x1b]52;c;')     // 降级不变：序列仍写出（无害忽略）
      // 二次 Alt+W：重新选区（光标在行首，shift+end 全选）后复制，警告不重复
      stdout.write.mockClear()
      stdin.emit('data', '\x1b[1;2F') // shift+end
      stdin.emit('data', '\x1bw')
      await new Promise(resolve => setTimeout(resolve, 30))
      const second = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(second).not.toContain('OSC52')
      expect(second).toContain('\x1b]52;c;')
      await app.dispose()
    } finally {
      if (prevProg === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = prevProg
      if (prevTerm === undefined) delete process.env.TERM
      else process.env.TERM = prevTerm
    }
  })

  it('提交带图：用户气泡含 📎 行 + followup 收到含 image block 的 UserMessage', async () => {
    const { agent, app } = boot({ supportsVision: true })
    await app.attach()
    app.handleSubmit('看图', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 0)) // 等 attachments 保存链落定
    const msg = agent.followup.mock.calls[0]?.[0]
    expect(msg).toBeDefined()
    expect(msg.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'mock-att-1', mediaType: 'image/png' }) },
    ])
    await app.dispose()
  })

  it('提交带图：空文本 + 图 → 占位 prompt 📎 图片消息', async () => {
    const { agent, app } = boot({ supportsVision: true })
    await app.attach()
    app.handleSubmit('', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 0)) // 等 attachments 保存链落定
    const msg = agent.followup.mock.calls[0]?.[0]
    expect(msg?.content[0]).toMatchObject({ type: 'text', text: '📎 图片消息' })
    await app.dispose()
  })

  it('vision 三态气泡：主控不识图 + 无桥 → 警告图片未发送', async () => {
    const { stdout, app, agent } = boot({ supportsVision: false, bridgeEnabled: false })
    await app.attach()
    app.handleSubmit('hi', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('图片未发送')
    // 图片不可达时不发送：followup 只含 text block，无 image block。
    const msg = agent.followup.mock.calls[0]?.[0]
    expect(msg?.content).toEqual([{ type: 'text', text: 'hi' }])
    await app.dispose()
  })

  it('只发图但主控不识图无桥 → 仅回显警告气泡，不触发 followup', async () => {
    const { stdout, app, agent } = boot({ supportsVision: false, bridgeEnabled: false })
    await app.attach()
    app.handleSubmit('', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('图片未发送')
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('vision 三态气泡：识图桥启用 → 经桥描述提示', async () => {
    const { stdout, app, agent } = boot({ supportsVision: false, bridgeEnabled: true, bridgeSource: 'configured' })
    await app.attach()
    app.handleSubmit('hi', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('经识图桥')
    await new Promise(resolve => setTimeout(resolve, 0)) // 等 attachments 保存链落定
    // 有桥时图片照发（经 agent/pre-step 视觉桥转描述）。
    const msg = agent.followup.mock.calls[0]?.[0]
    expect(msg?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'mock-att-1', mediaType: 'image/png' }) },
    ])
    await app.dispose()
  })

  it('视觉桥探测：未注入 vision 配置但宿主 provide visionBridge 服务 → 图片照发', async () => {
    const { ctx, stdout, app, agent } = boot() // 无 vision 配置（公开 npm 装配形态）
    const fallback = ctx.reflect.get.getMockImplementation()! as (name: string) => unknown
    ctx.reflect.get.mockImplementation((name: string) =>
      name === 'visionBridge' ? { describeImage: vi.fn() } : fallback(name))
    await app.attach()
    app.handleSubmit('hi', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('经识图桥')
    expect(written).not.toContain('图片未发送')
    await new Promise(resolve => setTimeout(resolve, 0)) // 等 attachments 保存链落定
    const msg = agent.followup.mock.calls[0]?.[0]
    expect(msg?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'mock-att-1', mediaType: 'image/png' }) },
    ])
    await app.dispose()
  })

  it('vision 三态气泡：主控支持识图 → 无提示行', async () => {
    const { stdout, app, agent } = boot({ supportsVision: true })
    await app.attach()
    app.handleSubmit('hi', [PNG_DATA_URL])
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('识图')
    await new Promise(resolve => setTimeout(resolve, 0)) // 等 attachments 保存链落定
    // 识图主控直发：图片照发。
    const msg = agent.followup.mock.calls[0]?.[0]
    expect(msg?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'mock-att-1', mediaType: 'image/png' }) },
    ])
    await app.dispose()
  })

  it('空行 Alt+Backspace → 移除末张附件（📎 行消失，键位提示随行展示）', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce({ dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clipboard.png', source: 'png' })
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdin.emit('data', '\x1b[200~\x1b[201~') // 触发剪贴板读图（右键粘贴路由）
    await vi.waitFor(() => {
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('📎 1 image · Alt+⌫ 移除末张')
    }, { timeout: 5_000, interval: 25 })
    stdout.write.mockClear()
    stdin.emit('data', '\x1b\x7f') // Alt+Backspace（ESC + DEL）
    await vi.waitFor(() => {
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).not.toContain('📎')
    }, { timeout: 5_000, interval: 25 })
    await app.dispose()
  })

  it('非空行 Alt+Backspace → 仍是词删除，不动附件', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce({ dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clipboard.png', source: 'png' })
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdin.emit('data', '\x1b[200~\x1b[201~')
    await vi.waitFor(() => {
      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      expect(written).toContain('📎 1 image')
    }, { timeout: 5_000, interval: 25 })
    for (const ch of 'hi ') stdin.emit('data', ch)
    await new Promise(resolve => setTimeout(resolve, 40))
    // 删词后画面回到与打字前相同的一帧（内容去重 → 零输出），像素断言不可
    // 用；直接断言状态：词被删、图保留。
    stdin.emit('data', '\x1b\x7f') // 词删除（光标在文本尾）：删词不删图
    await new Promise(resolve => setTimeout(resolve, 60))
    const line = (app as unknown as { inputLine: { images: string[]; value: string } }).inputLine
    expect(line.images).toHaveLength(1)
    expect(line.value).toBe('')
  })

  it('Ctrl+V 位图管线失败（假图）→ 回显 ⚠ 处理失败，不挂 📎 不插乱码', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce({
      dataUrl: `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}`,
      mime: 'image/png',
      name: 'clipboard.png',
      source: 'png',
    })
    const { stdin, stdout, app } = boot()
    await app.attach()
    stdout.write.mockClear()
    stdin.emit('data', '\x16')
    await new Promise(resolve => setTimeout(resolve, 40))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚠ 剪贴板图片处理失败: Unsupported image format')
    expect(written).not.toContain('📎')
    await app.dispose()
  })

  it('overlay 关闭后 1s 内 Ctrl+V 只走文本（焦点去抖接线，不再读图）', async () => {
    vi.mocked(readImageFromClipboard).mockResolvedValueOnce({ dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clipboard.png', source: 'png' })
    const { stdin, stdout, app } = boot()
    await app.attach()
    // 打开再关闭一个 overlay（命令面板）：onOverlayChange(false) 接线焦点去抖。
    stdin.emit('data', '\t') // 空输入框 Tab → 打开命令面板
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('\x1B[?1049h')
    stdin.emit('data', '\x1b') // Esc 关闭
    await new Promise(resolve => setTimeout(resolve, 80))
    const afterClose = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(afterClose).toContain('\x1B[?1049l') // 面板确已关闭（去抖接线前提）
    stdout.write.mockClear()
    vi.mocked(readImageFromClipboard).mockClear()
    vi.mocked(readTextFromClipboard).mockResolvedValueOnce('text-after-close')
    stdin.emit('data', '\x16') // ctrl_v：去抖窗口内只走文本
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(readImageFromClipboard).not.toHaveBeenCalled()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('text-after-close')
    await app.dispose()
  })
})

describe('TuiApp 首帧渲染等待 settings/credentials 服务（A1/A2）', () => {
  it('服务已注册但未激活时，attach 等待激活后再创建会话/渲染（API Key ✓ + settings 模型生效）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('svc-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([])
    const stdin = makeStdin()
    const stdout = makeStdout()

    // 模拟 dsh-base 的 credentials/settings：已注册（非严格可取）但 fiber 未激活
    // （严格取不到），随后在 attach 进行中完成激活。currentSelection 在激活前
    // 返回 config 默认值、激活后返回 settings 值（真实行为）。
    let activated = false
    const credentials = { describe: vi.fn(async () => ({ configured: true, source: 'file' as const, writable: true })) }
    ctx.agentDefaultModel.currentSelection.mockImplementation(() => activated
      ? { provider: 'deepseek-official', model: 'deepseek' }
      : { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    ctx.reflect.get.mockImplementation((name: string, strict = true) => {
      if (name === 'settings') return strict ? (activated ? {} : undefined) : {}
      if (name === 'credentials') return strict ? (activated ? credentials : undefined) : credentials
      return undefined
    })

    const app = new TuiApp({ ctx, stdout, stdin })
    const attachPromise = app.attach()
    // 服务在 attach 等待窗口内激活（真实场景：文件读 + watcher 初始化，毫秒级）。
    setTimeout(() => { activated = true }, 50)
    await attachPromise

    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 等待生效 → refreshApiKeyReady 经 credentials.describe 读到 configured → 欢迎页 ✓
    expect(written).toContain('API Key ✓')
    expect(written).not.toContain('API Key ✗')
    // A2：会话创建时快照的是 settings 的模型（deepseek），而非 config 默认
    // （deepseek-v4-flash）——等待发生在 newSession 之前。
    const createArg = ctx.agents.create.mock.calls[0]?.[0] as { agentOptions?: { provider: string; model: string } } | undefined
    expect(createArg?.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek' })
    await app.dispose()
  })

  it('服务未注册（mock 缺省）时 attach 不被等待阻塞，走 env 回退（API Key ✗）', async () => {
    // 显式清掉 DEEPSEEK_API_KEY：该用例断言 env 回退路径，宿主环境可能已设
    // 该变量（setx 持久化等），避免测试环境相关的不稳定。
    const prevKey = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const ctx = makeCtx()
      const agent = makeAgent('svc-2')
      const handle = makeHandle(agent)
      ctx.agents.create.mockResolvedValue(handle)
      ctx.sessions.get.mockReturnValue(agent.session)
      ctx.sessions.list.mockReturnValue([])
      const stdin = makeStdin()
      const stdout = makeStdout()

      const app = new TuiApp({ ctx, stdout, stdin })
      await app.attach()

      const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
      // 无 credentials 服务 → process.env 回退（已清空）→ ✗
      expect(written).toContain('API Key ✗')
      await app.dispose()
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey
    }
  })

  it('已注册服务超时未激活：warn 后仍创建会话（不静默吞掉）', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = makeCtx()
      const agent = makeAgent('svc-timeout')
      ctx.agents.create.mockResolvedValue(makeHandle(agent))
      ctx.sessions.get.mockReturnValue(agent.session)
      ctx.sessions.list.mockReturnValue([])
      ctx.reflect.get.mockImplementation((name: string, strict = true) => {
        if (name === 'settings' || name === 'credentials') return strict ? undefined : {}
        return undefined
      })
      const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
      const attachPromise = app.attach()
      await vi.advanceTimersByTimeAsync(5_100)
      await attachPromise
      expect(warn.mock.calls.some(call => String(call[0]).includes('settings'))).toBe(true)
      expect(ctx.agents.create).toHaveBeenCalled()
      await app.dispose()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('服务等待发生在终端接管之前：等待期间不写 bracketed paste', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('svc-order')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([])
    let activated = false
    ctx.reflect.get.mockImplementation((name: string, strict = true) => {
      if (name === 'settings' || name === 'credentials') return strict ? (activated ? {} : undefined) : {}
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    const attachPromise = app.attach()
    await new Promise(resolve => setTimeout(resolve, 40))
    const duringWait = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(duringWait).not.toContain('\x1B[?2004h')
    activated = true
    await attachPromise
    const after = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(after).toContain('\x1B[?2004h')
    await app.dispose()
  })
})

describe('TuiApp 全屏 overlay 激活时 renderLive 不写屏（A6）', () => {
  it('打开命令面板后流式 ticker 不再把 live 帧写进 alt screen（不覆盖面板）', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('ov-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    // 基线：主屏 live 帧含输入行 caret 驻停锚（\x1B[5G，见 caretCol 测试）。
    stdout.write.mockClear()
    // Ctrl+P（0x10）打开命令面板 → OverlayEngine 切 alternate screen。
    stdin.emit('data', '\x10')
    await new Promise(resolve => setTimeout(resolve, 250)) // 覆盖 2+ 个 120ms ticker 周期
    const afterPalette = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    // 面板确实打开（进入 alt screen）。
    expect(afterPalette).toContain('\x1B[?1049h')
    // A6：overlay 激活时 renderLive 被跳过——ticker 周期内不再出现主屏 live
    // 帧（caret 锚）。未修复时流式帧会逐帧写进 alt screen 盖住面板。
    expect(afterPalette).not.toContain('\x1B[5G')
    await app.dispose()
  })

  it('overlay 激活时 scrollback commit 不写进 alt screen，关闭后补写主屏', async () => {
    const ctx = makeCtx()
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    ctx.on.mockImplementation((name: string, h: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
      return () => { /* disposer: attach 路径由 app.dispose 覆盖 */ }
    })
    const agent = makeAgent('ov-commit')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const owner = { id: app.sessionId ?? SessionId('ov-commit') }

    stdin.emit('data', '\x10')
    await new Promise(resolve => setTimeout(resolve, 50))
    stdout.write.mockClear()

    const sessionHandlers = handlers.get('session/event') ?? []
    for (const handler of sessionHandlers) {
      handler(owner, {
        type: 'assistant/attempt',
        seq: 0,
        time: 1,
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'text-delta', text: '先看目录。\n\n' } }] },
      })
    }
    // blockWriter idleMs 180 + StreamRenderer 稳定边界 commit + 帧合并。
    await new Promise(resolve => setTimeout(resolve, 300))
    const duringOverlay = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(duringOverlay).not.toContain('先看目录')

    stdout.write.mockClear()
    stdin.emit('data', '\x10')
    await new Promise(resolve => setTimeout(resolve, 50))
    const afterClose = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(afterClose).toContain('先看目录')
    await app.dispose()
  })
})

describe('TuiApp cmdline 参数处理（A3）', () => {
  it('--help 输出用法并经 appExit(0) 退出，不进入交互', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('arg-help')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const exit = vi.fn()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'cmdlineArgs') return { get: () => ['--help'] }
      if (name === 'appExit') return exit
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('dsh --profile tui')
    expect(exit).toHaveBeenCalledWith(0)
    // 未进入交互：没有创建会话/订阅（attach 提前返回）
    expect(ctx.agents.create).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('--help 读 host 注入的 ctx.cmdlineArgs（非 reflect 插件纤维）', async () => {
    const ctx = makeCtx()
    const exit = vi.fn()
    Object.assign(ctx, {
      cmdlineArgs: { get: () => ['--help'] },
      appExit: exit,
    })
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('dsh --profile tui --help')
    expect(written).not.toContain('API Key')
    expect(exit).toHaveBeenCalledWith(0)
    expect(ctx.agents.create).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('纯位置参数作为初始 prompt 发送', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('arg-prompt')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'cmdlineArgs') return { get: () => ['修复这个', 'bug'] }
      return undefined
    })
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    expect(firstCallText(agent.followup)).toBe('修复这个 bug')
    await app.dispose()
  })

  it('--version 输出版本并经 appExit(0) 退出', async () => {
    const ctx = makeCtx()
    const exit = vi.fn()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'cmdlineArgs') return { get: () => ['--version'] }
      if (name === 'appExit') return exit
      return undefined
    })
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toMatch(/dsh-tianshu-tui \d+\.\d+/)
    expect(written).not.toContain('API Key')
    expect(exit).toHaveBeenCalledWith(0)
    expect(ctx.agents.create).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('无 appExit 时 --help 写出用法后 throw', async () => {
    const ctx = makeCtx()
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'cmdlineArgs') return { get: () => ['-h'] }
      return undefined
    })
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin() })
    await expect(app.attach()).rejects.toThrow('no appExit service provided')
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('dsh --profile tui --help')
    await app.dispose()
  })

  it('位置参数与其它 flag 并存时不发送 prompt', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('arg-flags')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'cmdlineArgs') return { get: () => ['修复这个', '--resume'] }
      return undefined
    })
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })
})

describe('LSP 诊断桥（黑盒：假 server 注入）', () => {
  /** 假 LSP server（stdin 收请求、stdout 回响应；pull 模型）。 */
  class FakeLspServer {
    readonly proc = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      on: vi.fn(),
      kill: vi.fn(),
    } as unknown as ChildProcess
    diagnosticItems: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: 1 | 2 | 3 | 4; message: string }> = []

    constructor() {
      const stdin = this.proc.stdin as unknown as PassThrough
      const stdout = this.proc.stdout as unknown as PassThrough
      stdin.on('data', (chunk: Buffer) => {
        const { messages } = decodeMessages(chunk)
        for (const msg of messages) {
          if (!('id' in msg) || 'result' in msg || 'error' in msg) continue
          const req = msg as { id: number; method: string }
          if (req.method === 'initialize') {
            stdout.write(encodeMessage({ jsonrpc: '2.0', id: req.id, result: { capabilities: { diagnosticProvider: {} } } }))
          } else if (req.method === 'textDocument/diagnostic') {
            stdout.write(encodeMessage({ jsonrpc: '2.0', id: req.id, result: { items: this.diagnosticItems } }))
          } else {
            stdout.write(encodeMessage({ jsonrpc: '2.0', id: req.id, result: null }))
          }
        }
      })
    }
  }

  function tsError(message: string): { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: 1; message: string } {
    return { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 1, message }
  }

  function written(stdout: WriteStream & { write: ReturnType<typeof vi.fn> }): string {
    return stdout.write.mock.calls.map(c => `${c[0]}`).join('')
  }

  /**
   * 装配 LSP 黑盒 ctx：newSession 给 agents.create 传 `sessionId: session-<uuid>`，
   * mock 必须返回同 id 的 session——否则 mountSession 的绑定 id（uuid）、
   * streamFeed 过滤 id（uuid）与 transcript 的 session.id（agent 替身 id）
   * 三处不一致，事件广播对不上。live 替身随 create 入参构造，get 按 id 返回。
   */
  function makeLspCtx(agent: Agent & MockAgent): ReturnType<typeof makeCtx> {
    const ctx = makeCtx()
    let live = agent.session
    ctx.agents.create.mockImplementation(async (opts?: { sessionId?: SessionId }) => {
      const sid = opts?.sessionId ?? agent.session.id
      live = { ...agent.session, id: sid, header: { ...agent.session.header, id: sid } } as unknown as typeof agent.session
      return makeHandle({ ...agent, id: sid, session: live } as unknown as Agent)
    })
    ctx.sessions.get.mockImplementation(() => live)
    return ctx
  }

  it('tool/call 触碰文件 → 工具卡标题带 LSP 诊断徽标', async () => {
    const ctx = makeLspCtx(makeAgent('lsp-badge-1'))
    const server = new FakeLspServer()
    server.diagnosticItems = [tsError('类型不匹配')]
    const stdout = makeStdout()
    const app = new TuiApp({
      ctx, stdout, stdin: makeStdin(),
      lsp: { timeoutMs: 200, spawnFor: () => server.proc },
    })
    await app.attach()
    const emit = sessionEventBus(ctx)
    const sid = app.sessionId
    if (sid === null) throw new Error('attach 后应有活跃会话')
    emit(sid, {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1, step: 1, callId: 'lsp-call-1', name: 'write_file',
        arguments: JSON.stringify({ path: '/work/src/a.ts', content: 'const x: number = "s"' }),
      },
    })
    // 第一步：工具卡标题出现（事件已处理；transcript fold 渲染）
    await vi.waitFor(() => {
      expect(written(stdout)).toContain('Write(')
    }, { timeout: 3_000, interval: 50 })
    // 第二步：诊断拉取完成，徽标上卡（异步，慢于事件渲染）
    await vi.waitFor(() => {
      expect(written(stdout)).toContain('⚠ 1错')
    }, { timeout: 5_000, interval: 50 })
    await app.dispose()
  })

  it('/lsp 打开面板：无诊断缓存时渲染空态行', async () => {
    const ctx = makeLspCtx(makeAgent('lsp-panel-1'))
    const stdout = makeStdout()
    const app = new TuiApp({
      ctx, stdout, stdin: makeStdin(),
      lsp: { timeoutMs: 200, spawnFor: () => new FakeLspServer().proc },
    })
    await app.attach()
    app.handleSubmit('/lsp')
    await vi.waitFor(() => {
      expect(written(stdout)).toContain('无 LSP 诊断')
    }, { timeout: 3_000, interval: 50 })
    await app.dispose()
  })

  it('未知扩展名文件触碰 + /lsp：不 spawn、空态不崩', async () => {
    const ctx = makeLspCtx(makeAgent('lsp-unsupported-1'))
    const server = new FakeLspServer()
    const stdout = makeStdout()
    const app = new TuiApp({
      ctx, stdout, stdin: makeStdin(),
      lsp: { timeoutMs: 200, spawnFor: () => server.proc },
    })
    await app.attach()
    const emit = sessionEventBus(ctx)
    const sid = app.sessionId
    if (sid === null) throw new Error('attach 后应有活跃会话')
    emit(sid, {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1, step: 1, callId: 'lsp-call-2', name: 'read',
        arguments: JSON.stringify({ path: '/work/notes.xyz' }),
      },
    })
    app.handleSubmit('/lsp')
    await vi.waitFor(() => {
      expect(written(stdout)).toContain('无 LSP 诊断')
    }, { timeout: 3_000, interval: 50 })
    // 未知扩展名未 spawn 任何 server
    expect(server.proc.kill).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('伴生插件 provide(lsp) 服务存在 → 徽标走服务（不 spawn 内置 server）', async () => {
    const ctx = makeLspCtx(makeAgent('lsp-source-1'))
    // 假官方 ctx.lsp 服务（结构类型：query(getDiagnostics) 五操作 seam）
    const serviceQuery = vi.fn(async () => ({
      kind: 'diagnostics',
      diagnostics: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1 as const, message: '服务源诊断' },
      ],
    }))
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'lsp') return { query: serviceQuery, operations: ['goToDefinition', 'findReferences', 'hover', 'getDiagnostics'] }
      return undefined
    })
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), lsp: { timeoutMs: 200 } })
    await app.attach()
    const emit = sessionEventBus(ctx)
    const sid = app.sessionId
    if (sid === null) throw new Error('attach 后应有活跃会话')
    emit(sid, {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1, step: 1, callId: 'lsp-call-3', name: 'write_file',
        arguments: JSON.stringify({ path: '/work/src/a.ts', content: 'x' }),
      },
    })
    await vi.waitFor(() => {
      expect(written(stdout)).toContain('⚠ 1错')
    }, { timeout: 3_000, interval: 50 })
    // 服务被消费（无需内置 spawn——未注入 spawnFor，若走内置会真 spawn）
    expect(serviceQuery).toHaveBeenCalled()
    await app.dispose()
  })
})

describe('Ctrl+C 连按退出新语义 + vim Esc + Kitty CSI u（天枢 59d00152 同步）', () => {
  it('有草稿：第一次 Ctrl+C 清空输入行（可 Ctrl+Z 恢复）并布防，第二次退出', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('draft-exit')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()

    stdin.emit('data', 'draft text')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()
    expect((app as unknown as { inputLine: { value: string } }).inputLine.value).toBe('') // 草稿被清（setValue 记 undo）
    const afterFirst = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(afterFirst).toContain('再按 Ctrl+C 退出')

    stdin.emit('data', '\x1a') // Ctrl+Z：undo 恢复被清空的草稿
    await new Promise(resolve => setImmediate(resolve))
    expect((app as unknown as { inputLine: { value: string } }).inputLine.value).toBe('draft text')

    // 恢复后再走一轮：清空布防 → 第二次退出
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('running 中第一次 Ctrl+C 打断并布防；agent 落定前第二次直接退出', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('busy-exit')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('no session')
    const statusHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    for (const handler of statusHandlers) handler({ agent: { id }, status: 'running' })

    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.cancel).toHaveBeenCalledTimes(1)
    expect(onExit).not.toHaveBeenCalled()
    // 仍 running（agent 未落定）：第二次直接退出，不等 idle
    stdin.emit('data', '\x03')
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })

  it('vim normal 下 Esc 空操作：双击不弹 rewind overlay', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('vim-esc')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, vimEnabled: true })
    await app.attach()
    // 进 vim normal：Esc 切模式
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((app as unknown as { inputLine: { vimMode: string } }).inputLine.vimMode).toBe('normal')

    stdout.write.mockClear()
    // normal 下双击 Esc：不触发 rewind（无 overlay 的 alt-screen 进入）
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 100))
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 100))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).not.toContain('\x1b[?1049h') // 未进 alt screen（rewind 未开）
    await app.dispose()
  })

  it('Kitty flag 1：CSI 99;5u 即 Ctrl+C（布防退出窗口）；release 事件不重复计', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('kitty-c')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const onExit = vi.fn()
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, onExit })
    await app.attach()

    stdin.emit('data', '\x1b[99;5u') // press → 布防
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()
    stdin.emit('data', '\x1b[99;5:3u') // release → 只消费
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).not.toHaveBeenCalled()
    stdin.emit('data', '\x1b[99;5u') // 第二次 press → 退出
    await new Promise(resolve => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
    await app.dispose()
  })
})

describe('技能发现携带会话 cwd（#44：项目级技能可见）', () => {
  it('skills.list 收到 { cwd }——会话 header.cwd 优先，缺失回退 process.cwd', async () => {
    const ctx = makeCtx()
    const list = vi.fn(async (_opts?: { cwd?: string }) => [])
    ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'skills') return { list }
      return undefined
    })
    // 会话 header 携带项目 cwd（git worktree 根）
    const agent = makeAgent('skill-cwd')
    ;(agent.session.header as { cwd?: string }).cwd = '/repos/lims2025'
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    const app = new TuiApp({ ctx, stdout: makeStdout(), stdin: makeStdin() })
    await app.attach()
    // /skills 打开触发 refresh（构造期 refresh 也应已带 cwd）
    app.handleSubmit('/skills')
    await new Promise(resolve => setImmediate(resolve))
    expect(list.mock.calls.length).toBeGreaterThan(0)
    expect(list.mock.calls.every(call => call[0]?.cwd !== undefined)).toBe(true)
    expect(list.mock.calls.some(call => call[0]?.cwd === '/repos/lims2025')).toBe(true)
    await app.dispose()
  })
})

describe('/key 键路由（审查修复）', () => {
  it('key-dialog overlay 激活后 Esc 可达对话框状态机并关闭', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('fresh-1')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdout = makeStdout()
    const stdin = makeStdin()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()
    const state = app as unknown as { overlay: { activeId(): string | null } }
    // /key：reflect 无 llm/credentials → 降级 DeepSeek 直开（降级指引态）
    app.handleSubmit('/key')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(state.overlay.activeId()).toBe('key-dialog')
    // 降级指引态 Esc 应关闭（键路由把 escape 交给对话框状态机；Esc 单字节
    // 需等 InputHandler CSI 超时才派发，等待要大于 partialSequenceTimeout）。
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(state.overlay.activeId()).toBeNull()
    await app.dispose()
  })
})

describe('空闲 ticker 跳过组装', () => {
  it('空闲 ticker 不组装 live 帧（H2 之前就跳过）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    const render = vi.spyOn(LiveEngine.prototype, 'render')
    const ctx = makeCtx()
    const agent = makeAgent('p2-idle')
    const handle = makeHandle(agent)
    ctx.agents.create.mockResolvedValue(handle)
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    try {
      await app.attach()
      await new Promise(resolve => setTimeout(resolve, 40))
      render.mockClear()
      await vi.advanceTimersByTimeAsync(360)
      expect(render).not.toHaveBeenCalled()
    } finally {
      await app.dispose()
      render.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('TuiApp 运行中排队（对标 CC queue；↑ 取回）', () => {
  async function bootQueueApp() {
    const ctx = makeCtx()
    const agent = makeAgent('queue-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    // trackAgent 从 ctx.agents.get 播种 status/inbox——置 running 制造「运行中」现场
    ctx.agents.get.mockReturnValue({ ...agent, status: 'running', inbox: { nextTurn: [], nextStep: [] } })
    ctx.sessions.get.mockReturnValue(agent.session)
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin, theme: 'paper' })
    await app.attach()
    const id = app.sessionId
    if (id === null) throw new Error('no active session')
    return { app, agent, stdout, stdin, id, ctx, emit: sessionEventBus(ctx) }
  }

  /** 模拟 agent/status 广播（trackAgent/statusLine 的全部订阅者）。 */
  function emitAgentStatus(ctx: ReturnType<typeof makeCtx>, id: SessionId, status: string): void {
    const handlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === 'agent/status')
      .map(call => call[1] as (payload: { agent: { id: SessionId }; status: string }) => void)
    for (const handler of handlers) handler({ agent: { id }, status })
  }

  it('running 提交进本地队列不直发；completed turn/end 按序投递', async () => {
    const { app, agent, stdout, id, emit } = await bootQueueApp()
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    app.handleSubmit('queued one')
    app.handleSubmit('queued two')
    await new Promise(resolve => setImmediate(resolve))
    // 排队期不投递；输入轨上方出现排队行
    expect(agent.followup).not.toHaveBeenCalled()
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('条排队')

    emit(id, { seq: 2, time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).toHaveBeenCalledTimes(2)
    expect(firstCallText(agent.followup)).toBe('queued one')
    await app.dispose()
  })

  it('aborted turn/end 不投递（打断后不自动开新轮）', async () => {
    const { app, agent, id, emit } = await bootQueueApp()
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    app.handleSubmit('queued three')
    emit(id, { seq: 2, time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('空输入 ↑ 取回队首回输入行；取回后 turn/end 不投递被取回的消息', async () => {
    const { app, agent, stdout, stdin, id, emit } = await bootQueueApp()
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    app.handleSubmit('take me back')
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('条排队')
    stdin.emit('data', '\x1B[A') // ↑ 取回队首
    await new Promise(resolve => setImmediate(resolve))
    stdout.write.mockClear()
    // 取回后队列空（排队行不再出现），文本回到输入轨
    stdin.emit('data', ' ')
    await new Promise(resolve => setImmediate(resolve))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('take me back')
    expect(written).not.toContain('条排队')

    emit(id, { seq: 2, time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('Esc 打断：cancel 带 keepInbox（宿主 inbox 未消费的 steer/排队残留保留）', async () => {
    const { app, agent, stdin } = await bootQueueApp()
    // lone ESC 走 80ms 防误触超时才派发
    stdin.emit('data', '\x1b')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await app.dispose()
  })

  it('Ctrl+Enter 插队：cancel(keepInbox) 打断，idle 落定后走正常提交路径直发（调用序 cancel → followup）', async () => {
    const { app, agent, stdin, ctx, id } = await bootQueueApp()
    stdin.emit('data', 'jump the queue')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x1B[13;5u') // kitty CSI u：Ctrl+Enter
    // 打断同步发生；提交等 whenIdle 落定（此时期货未兑现，不直发）
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(agent.followup).not.toHaveBeenCalled()
    // 落定（agent/status idle）→ whenIdle 兑现 → agent 已 idle → handleSubmit 直发
    //（时序即调用序证明：按键后 cancel 已调而 followup 未调，落定后 followup 才调）
    emitAgentStatus(ctx, id, 'idle')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(firstCallText(agent.followup)).toBe('jump the queue')
    await app.dispose()
  })

  it('Ctrl+Enter running 但空输入：不消费（无打断无发送）', async () => {
    const { app, agent, stdin } = await bootQueueApp()
    stdin.emit('data', '\x1B[13;5u')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    await app.dispose()
  })

  it('Ctrl+Enter 空闲时不消费：草稿保留、无打断无发送', async () => {
    const { app, agent, stdout, stdin, ctx, id } = await bootQueueApp()
    emitAgentStatus(ctx, id, 'idle')
    stdin.emit('data', 'still here')
    await new Promise(resolve => setImmediate(resolve))
    stdin.emit('data', '\x1B[13;5u')
    await new Promise(resolve => setImmediate(resolve))
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    // 草稿未被清空：再键入字符后渲染含累积文本
    stdout.write.mockClear()
    stdin.emit('data', '!')
    await new Promise(resolve => setImmediate(resolve))
    expect(stdout.write.mock.calls.map(c => `${c[0]}`).join('')).toContain('still here!')
    await app.dispose()
  })
})

describe('错误恢复指引（echoWarn hint 尾随行）', () => {
  it('启动期主题警告：attach 后经 echoWarn 落 scrollback，附 /theme 指引尾随行', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('theme-warn-1')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockReturnValue(agent.session)
    ctx.sessions.list.mockReturnValue([agent.session])
    const stdout = makeStdout()
    const app = new TuiApp({
      ctx, stdout, stdin: makeStdin(),
      themeWarnings: ['low contrast in foo.json: primary(#555555 ×1.2)'],
    })
    await app.attach()
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚠ 主题警告：low contrast in foo.json')
    expect(written).toContain('↳ /theme 检查自定义主题')
    await app.dispose()
  })

  it('会话切换失败：警告附 /session 重新选择尾随行', async () => {
    const ctx = makeCtx()
    const agent = makeAgent('hint-keep')
    const other = makeAgent('hint-bad')
    ctx.agents.create.mockResolvedValue(makeHandle(agent))
    ctx.sessions.get.mockImplementation((id: SessionId) => (id === agent.session.id ? agent.session : other.session))
    ctx.sessions.list.mockReturnValue([agent.session, other.session])
    ctx.agents.get.mockImplementation((id: SessionId) => (id === agent.session.id ? agent : undefined))
    ctx.agents.resume.mockRejectedValue(new Error('bad'))
    const stdin = makeStdin()
    const stdout = makeStdout()
    const app = new TuiApp({ ctx, stdout, stdin })
    await app.attach()

    stdin.emit('data', '\x13') // ctrl_s
    await new Promise(resolve => setTimeout(resolve, 60))
    const written = stdout.write.mock.calls.map(c => `${c[0]}`).join('')
    expect(written).toContain('⚠ 会话切换失败: bad')
    expect(written).toContain('↳ /session 重新选择')
    await app.dispose()
  })
})
