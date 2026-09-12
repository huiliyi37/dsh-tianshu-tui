/**
 * mid-stream 提交原子编舞回归守卫（输入框闪烁根修，2026-08-27）。
 *
 * 缺陷：旧序里 clearForCommit 同步直写擦掉整个 live 区（含待办卡/输入轨/footer），
 * 重绘却交给 WriteBatcher 的 16ms 尾沿——每个段落/思考块落底后屏幕上真实缺席一帧
 * chrome，推理期段边界密集即呈现为「输入框消失几帧又出现」。
 *
 * 守卫方式：把全部 stdout 写入按序拼接后做 CSI 2026 嵌套深度扫描——
 * - 落底文本与思考块折叠头行必须出现在同步窗内（旧实现直写窗外，深度恒 0）；
 * - 同一窗收口前输入轨（╭）必须已重绘——擦除中间态没有任何可见窗口；
 * - 扫描终点深度归零——窗口必须收口，否则支持 2026 的终端会永久停帧。
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WriteStream } from 'node:tty'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../src/ui/app.js'

/** 最小可渲染 stdout 替身（同 app.spec makeStdout）。 */
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

/** 最小 stdin 替身（同 app.spec makeStdin）。 */
function makeStdin(): NodeJS.ReadStream {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    setEncoding: vi.fn(),
    pause: vi.fn(),
  }) as unknown as NodeJS.ReadStream
  createdStdins.push(stdin)
  return stdin
}

const createdStdins: NodeJS.ReadStream[] = []

afterEach(() => {
  createdStdins.length = 0
  vi.restoreAllMocks()
})

/** 最小 ctx 替身（订阅返回可释放 disposer）。 */
function makeCtx(): Context {
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
    on: vi.fn((event: string) => vi.fn(() => { void event })),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
  } as unknown as Context
}

/** 最小 live agent 替身。 */
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

function makeHandle(agent: Agent): AgentHandle {
  return { agent, dispose: vi.fn() } as unknown as AgentHandle
}

/** 捕获 session/event 订阅并模拟总线广播（同 app.spec sessionEventBus）。 */
function sessionEventBus(ctx: Context): (id: SessionId, event: Record<string, unknown>) => void {
  const handlers = (ctx.on as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: unknown[]) => call[0] === 'session/event')
    .map(call => call[1] as (owner: { id: SessionId }, event: unknown) => void)
  if (handlers.length === 0) throw new Error('session/event handler not registered')
  return (id, event) => {
    for (const handler of handlers) handler({ id }, event)
  }
}

/** pos 之前尚未收口的 CSI 2026 begin 数量（嵌套计数，floor 0）。 */
function syncWindowDepthAt(written: string, pos: number): number {
  let depth = 0
  const pattern = /\x1B\[\?2026[hl]/g
  for (let m = pattern.exec(written); m !== null && m.index < pos; m = pattern.exec(written)) {
    depth += m[0].endsWith('h') ? 1 : -1
    if (depth < 0) depth = 0
  }
  return depth
}

async function bootApp(): Promise<{ app: TuiApp; stdout: ReturnType<typeof makeStdout>; emit: (id: SessionId, event: Record<string, unknown>) => void }> {
  const ctx = makeCtx()
  const agent = makeAgent('choreo-1')
  ;(ctx.agents.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeHandle(agent))
  ;(ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(agent.session)
  const stdout = makeStdout()
  const app = new TuiApp({ ctx, stdout, stdin: makeStdin(), theme: 'paper' })
  await app.attach()
  const id = app.sessionId
  if (id === null) throw new Error('no active session')
  return { app, stdout, emit: sessionEventBus(ctx) }
}

describe('mid-stream 提交原子编舞（输入框闪烁守卫）', () => {
  it('流式段落落底：文本在同步窗内写入，且窗收口前输入轨已重绘', async () => {
    const { app, stdout, emit } = await bootApp()
    const id = app.sessionId as SessionId
    // 单个 delta 即同步成块的门槛：空行索引需 ≥ floor(60/2)=30（BlockStreamWriter
    // 段界条件，app 装配 minChars=60）；首块门槛 minChars 已放宽到 15。
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    emit(id, {
      seq: 2, time: 2, type: 'assistant/attempt',
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 2, chunk: { type: 'text-delta', text: `落底标记甲${'甲'.repeat(30)}\n\n尾段未完` } }] },
    })
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map((c: unknown[]) => `${c[0]}`).join('')
    const posMark = written.indexOf('落底标记甲')
    expect(posMark).toBeGreaterThan(-1) // 已 commit 进 scrollback
    expect(syncWindowDepthAt(written, posMark)).toBeGreaterThanOrEqual(1) // 且在同步窗内
    const posRail = written.indexOf('╭', posMark)
    expect(posRail).toBeGreaterThan(-1) // 窗内随后重绘了输入轨
    expect(syncWindowDepthAt(written, posRail)).toBeGreaterThanOrEqual(1)
    await app.dispose()
  })

  it('思考块落底：折叠头行在同步窗内写入，窗收口前输入轨已重绘', async () => {
    const { app, stdout, emit } = await bootApp()
    const id = app.sessionId as SessionId
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    emit(id, {
      seq: 2, time: 2, type: 'assistant/attempt',
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 2, chunk: { type: 'reasoning-delta', text: '先想想怎么修闪烁问题' } }] },
    })
    // 正文 delta 是思考段的段边界：commitReasoningBlock 整块落底。
    emit(id, {
      seq: 3, time: 3, type: 'assistant/attempt',
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 3, chunk: { type: 'text-delta', text: '正文开始' } }] },
    })
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map((c: unknown[]) => `${c[0]}`).join('')
    // 取最后一次出现：前面的「思考」可能来自 live 区 shimmer 帧（窗外合法），
    // 最后一次必然是落底的折叠头行。
    const posHead = written.lastIndexOf('思考')
    expect(posHead).toBeGreaterThan(-1)
    expect(syncWindowDepthAt(written, posHead)).toBeGreaterThanOrEqual(1)
    const posRail = written.indexOf('╭', posHead)
    expect(posRail).toBeGreaterThan(-1)
    expect(syncWindowDepthAt(written, posRail)).toBeGreaterThanOrEqual(1)
    await app.dispose()
  })

  it('同步窗必须收口：全部写屏完成后 CSI 2026 深度归零', async () => {
    const { app, stdout, emit } = await bootApp()
    const id = app.sessionId as SessionId
    emit(id, { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
    emit(id, {
      seq: 2, time: 2, type: 'assistant/attempt',
      data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 2, chunk: { type: 'text-delta', text: `再落一段${'乙'.repeat(30)}\n\n完了` } }] },
    })
    await new Promise(resolve => setImmediate(resolve))

    const written = stdout.write.mock.calls.map((c: unknown[]) => `${c[0]}`).join('')
    const pattern = /\x1B\[\?2026[hl]/g
    let depth = 0
    for (let m = pattern.exec(written); m !== null; m = pattern.exec(written)) {
      depth += m[0].endsWith('h') ? 1 : -1
      if (depth < 0) depth = 0
    }
    expect(depth).toBe(0)
    await app.dispose()
  })
})
