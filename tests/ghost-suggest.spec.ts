/**
 * ghost-suggest — fish 式历史建议（项 6）app 级契约。
 *
 * ghost 槽位汇合（slash 补全优先、历史建议其次）与接受手势（→）端到端：
 * 前缀建议上屏 / → 接受整条 / 键入即弃 / slash 优先 / vim normal 抑制 /
 * prefs ghostSuggest:false 隐身 / 光标不在末尾不显示。
 *
 * ghost 以 `\x1B[2m…\x1B[22m` 包裹（input-line GHOST_DIM_OPEN/CLOSE）上屏，
 * 帧断言取 LiveEngine.render spy 最后一帧。ctx/agent/stdin/stdout 替身镜像
 * app.spec.ts 的同名工厂（测试独立性优先，不跨 spec import）。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WriteStream } from 'node:tty'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/ui/app.js'
import { LiveEngine, type LiveRegionLine } from '../src/engine/live-engine.js'

function makeStdout(): WriteStream & { write: ReturnType<typeof vi.fn> } {
  return {
    columns: 100, rows: 30, write: vi.fn(), isTTY: false, on: vi.fn(), removeListener: vi.fn(),
  } as unknown as WriteStream & { write: ReturnType<typeof vi.fn> }
}

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

function makeAgent(id: string): Agent & { followup: ReturnType<typeof vi.fn> } {
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
  } as unknown as Agent & { followup: ReturnType<typeof vi.fn> }
}

/** 装配 app；history/prefs 经 tmp 文件预载（与生产同一路径）。 */
async function boot(opts: { history?: string[]; prefsJson?: string; vim?: boolean } = {}) {
  const ctx = makeCtx()
  const agent = makeAgent('ghost-1')
  ctx.agents.create.mockResolvedValue({ agent, dispose: vi.fn() } as unknown as AgentHandle)
  ctx.sessions.get.mockReturnValue(agent.session)
  const stdin = makeStdin()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ghost-'))
  let inputHistoryPath: string | null = null
  if (opts.history !== undefined) {
    inputHistoryPath = join(dir, 'input-history.json')
    writeFileSync(inputHistoryPath, JSON.stringify(opts.history))
  }
  let prefsPath: string | null = null
  if (opts.prefsJson !== undefined) {
    prefsPath = join(dir, 'prefs.json')
    writeFileSync(prefsPath, opts.prefsJson)
  }
  const app = new TuiApp({
    ctx, stdout: makeStdout(), stdin, inputHistoryPath, prefsPath,
    ...(opts.vim === true ? { vimEnabled: true } : {}),
  })
  await app.attach()
  return { app, stdin, agent }
}

type RenderSpy = { mock: { calls: unknown[][] } }

/** 最后一帧全部行文本（换行连接；ghost 的 dim 包裹序列保留）。 */
function lastFrameText(spy: RenderSpy): string {
  const call = spy.mock.calls.at(-1)
  if (call === undefined) throw new Error('live.render 尚未被调用')
  return (call[0] as readonly LiveRegionLine[]).map(l => l.text).join('\n')
}

const GHOST = (text: string): string => `\x1B[2m${text}\x1B[22m`

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fish 式历史建议（ghost）', () => {
  it('前缀匹配建议上屏；→ 接受整条后 Enter 提交完整条目', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin, agent } = await boot({ history: ['hello world'] })

    stdin.emit('data', 'hel')
    expect(lastFrameText(spy)).toContain(GHOST('lo world'))

    stdin.emit('data', '\x1b[C') // → 接受
    stdin.emit('data', '\r')
    const arg = agent.followup.mock.calls[0]?.[0] as { content?: Array<{ text?: string }> } | undefined
    expect(arg?.content?.[0]?.text).toBe('hello world')
    await app.dispose()
  })

  it('键入即弃：继续键入无匹配时 ghost 消失（自然重算）', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin } = await boot({ history: ['hello world'] })

    stdin.emit('data', 'hel')
    expect(lastFrameText(spy)).toContain(GHOST('lo world'))
    stdin.emit('data', 'x') // helx 无前缀匹配
    expect(lastFrameText(spy)).not.toContain('lo world')
    await app.dispose()
  })

  it('光标不在末尾不显示（左移后 ghost 隐藏）', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin } = await boot({ history: ['hello world'] })

    stdin.emit('data', 'hel')
    expect(lastFrameText(spy)).toContain(GHOST('lo world'))
    stdin.emit('data', '\x1b[D') // 光标左移一格
    expect(lastFrameText(spy)).not.toContain('lo world')
    await app.dispose()
  })

  it('slash 补全优先：/ 前缀输入不出历史建议（同槽位 slash 占先）', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin } = await boot({ history: ['/theme dark'] })

    stdin.emit('data', '/th')
    // 历史条目剩余是 'eme dark'；slash ghost 占槽位时只剩补全（不含 dark）
    expect(lastFrameText(spy)).not.toContain('dark')
    await app.dispose()
  })

  it('vim normal 态抑制（Esc 进 normal 后 ghost 隐藏）', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin } = await boot({ history: ['hello world'], vim: true })

    stdin.emit('data', 'hel')
    expect(lastFrameText(spy)).toContain(GHOST('lo world'))
    stdin.emit('data', '\x1b') // Esc → vim normal（lone ESC 走 80ms 超时派发）
    await new Promise(r => setTimeout(r, 120))
    expect(lastFrameText(spy)).not.toContain('lo world')
    await app.dispose()
  })

  it('prefs ghostSuggest:false → 建议隐身', async () => {
    const spy = vi.spyOn(LiveEngine.prototype, 'render')
    const { app, stdin } = await boot({ history: ['hello world'], prefsJson: '{"ghostSuggest": false}' })

    stdin.emit('data', 'hel')
    expect(lastFrameText(spy)).not.toContain('lo world')
    await app.dispose()
  })
})
