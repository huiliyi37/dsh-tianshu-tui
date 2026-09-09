import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import type { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.js'
import { TuiApp } from '../src/ui/app.js'
import { runSelfUpdate } from '../src/self-update.js'
import { spawnSelfRestart } from '../src/restart.js'

// 装配测试：runSelfUpdate / spawnSelfRestart 全部 mock（缺省 noop/true，
// 不影响现有装配用例；自动重启用例里按分支覆写返回值）。
vi.mock('../src/self-update.js', () => ({
  runSelfUpdate: vi.fn(async () => ({ kind: 'noop' })),
}))
vi.mock('../src/restart.js', () => ({
  spawnSelfRestart: vi.fn(async () => true),
}))

/** 最小可渲染 stdout 替身：宽/高/写入记录，以及 ResizeHandler 需要的 on/removeListener。 */
function makeStdout(): WriteStream {
  return {
    columns: 100,
    rows: 30,
    write: vi.fn(),
    isTTY: false,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as WriteStream
}

/** 最小 stdin 替身：可 emit 事件，InputHandler 需要的流方法齐备。 */
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

/** 带记录字段的 ctx 替身：sessions/agents 可注入，effect 记录 cleanup 并立即求值。 */
function makeCtx(): Context & {
  sessions: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> }
  effect: ReturnType<typeof vi.fn>
  reflect: { get: ReturnType<typeof vi.fn> }
} {
  const ctx = {
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
      flush: vi.fn(async () => true),
    },
    agents: {
      create: vi.fn(),
      resume: vi.fn(),
      get: vi.fn(),
    },
    on: vi.fn(() => () => { }),
    get: vi.fn(),
    provide: vi.fn(() => () => { }),
    reflect: { get: vi.fn(() => undefined) },
    // effect 立即求值回调，返回其 cleanup——与 cordis 的插件卸载语义一致。
    effect: vi.fn((cb: () => () => void) => cb()),
    // inject 立即执行回调（mock 的 sessions/agents 已可用），与 effect 语义一致；
    // 真实 Cordis 中依赖就绪时才执行。
    inject: vi.fn((_deps: string[], cb: (injected: unknown) => void) =>{  cb(ctx) }),
  } as unknown as Context & {
    sessions: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> }
    effect: ReturnType<typeof vi.fn>
    reflect: { get: ReturnType<typeof vi.fn> }
  }
  return ctx
}

/** 最小 live session 替身：flushAll 遍历它。 */
function makeSession(id: string): Session {
  return {
    id: id as Session['id'],
    header: { id: id as Session['id'], version: 0, createdAt: 1 },
    events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
  } as unknown as Session
}

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('index apply() 装配与退出生命周期', () => {
  it('插件卸载（ctx dispose）触发 app.dispose 并 flushAll', async () => {
    const ctx = makeCtx()
    const session = makeSession('runner-1')
    ctx.sessions.list.mockReturnValue([session])
    // 跳过真实 attach 的引擎装配，只验证装配与卸载路径
    const attachSpy = vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    const disposeSpy = vi.spyOn(TuiApp.prototype, 'dispose')

    apply(ctx, { stdin: makeStdin(), stdout: makeStdout() })

    expect(attachSpy).toHaveBeenCalledTimes(1)
    // effect cleanup（插件卸载路径）触发 teardown → dispose → flushAll
    const cleanup = ctx.effect.mock.results[0]?.value as (() => void) | undefined
    expect(cleanup).toBeTypeOf('function')
    cleanup?.()

    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(ctx.sessions.flush).toHaveBeenCalled()
  })

  it('stdin SIGINT 触发同一 dispose 路径', async () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    const disposeSpy = vi.spyOn(TuiApp.prototype, 'dispose')

    const stdin = makeStdin()
    apply(ctx, { stdin, stdout: makeStdout() })

    stdin.emit('SIGINT')
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('缺省 stdin/stdout 用 process 全局流', () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    const disposeSpy = vi.spyOn(TuiApp.prototype, 'dispose')

    expect(() =>{  apply(ctx) }).not.toThrow()
    // 缺省装配也注册了 effect cleanup（插件卸载路径）
    const cleanup = ctx.effect.mock.results[0]?.value as (() => void) | undefined
    expect(cleanup).toBeTypeOf('function')
    cleanup!()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('attach rejection 恢复终端（dispose 被调用，不吞错误）', async () => {
    const ctx = makeCtx()
    const attachErr = new Error('attach boom')
    vi.spyOn(TuiApp.prototype, 'attach').mockRejectedValue(attachErr)
    const disposeSpy = vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)

    const stdin = makeStdin()
    // apply 同步装配；attach 的 rejection 由 try/catch 接住并恢复终端。
    expect(() =>{  apply(ctx, { stdin, stdout: makeStdout() }) }).not.toThrow()

    // 给 attach 的 rejection 微任务留出时间
    await new Promise(resolve => setImmediate(resolve))
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('effect cleanup await dispose 完成（teardown 不等 flushAll 回归）', async () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    let disposeResolved = false
    vi.spyOn(TuiApp.prototype, 'dispose').mockImplementation(async () => { disposeResolved = true })

    const stdin = makeStdin()
    apply(ctx, { stdin, stdout: makeStdout() })

    const cleanup = ctx.effect.mock.results[0]?.value as (() => void) | undefined
    cleanup?.()
    expect(disposeResolved).toBe(true)
  })

  it('插件卸载不 process.exit（宿主自己收尾）', async () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)
    apply(ctx, { stdin: makeStdin(), stdout: makeStdout() })
    const cleanup = ctx.effect.mock.results[0]?.value as (() => void) | undefined
    cleanup?.()
    await new Promise(resolve => setImmediate(resolve))
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('SIGINT dispose 后经 appExit(0) 退出（#22 把 TTY 还给 shell）', async () => {
    const ctx = makeCtx()
    const appExit = vi.fn()
    ctx.reflect.get.mockImplementation((name: string) => name === 'appExit' ? appExit : undefined)
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)
    const stdin = makeStdin()
    apply(ctx, { stdin, stdout: makeStdout() })
    stdin.emit('SIGINT')
    await vi.waitFor(() => {
      expect(appExit).toHaveBeenCalledWith(0)
    })
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('用户退出且无 appExit 时 process.exit(0)', async () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)
    const stdin = makeStdin()
    apply(ctx, { stdin, stdout: makeStdout() })
    stdin.emit('SIGINT')
    await vi.waitFor(() => {
      expect(process.exit).toHaveBeenCalledWith(0)
    })
  })

  it('Windows 双触发防护：shouldDeferSigint=true 时 SIGINT 被忽略（不 teardown）', async () => {
    const ctx = makeCtx()
    const appExit = vi.fn()
    ctx.reflect.get.mockImplementation((name: string) => name === 'appExit' ? appExit : undefined)
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)
    vi.spyOn(TuiApp.prototype, 'shouldDeferSigint').mockReturnValue(true)
    const stdin = makeStdin()
    apply(ctx, { stdin, stdout: makeStdout() })
    stdin.emit('SIGINT')
    await new Promise(r => setTimeout(r, 100))
    expect(appExit).not.toHaveBeenCalled()
    const cleanup = ctx.effect.mock.results[0]?.value as (() => void) | undefined
    cleanup?.()
  })

  it('装配注册 process.on exit 终端恢复兜底（raw mode off best-effort）', () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    const before = process.listeners('exit').length
    apply(ctx, { stdin: makeStdin(), stdout: makeStdout() })
    expect(process.listeners('exit').length).toBeGreaterThan(before)
    const cleanup = ctx.effect.mock.results[0]?.value as (() => void) | undefined
    cleanup?.()
  })
})

describe('index apply() — 更新后自动重启装配（#34 审查补测）', () => {
  const updated = { kind: 'updated', version: '0.1.2-rc.10' } as const

  beforeEach(() => {
    vi.mocked(runSelfUpdate).mockReset().mockResolvedValue(updated)
    vi.mocked(spawnSelfRestart).mockReset().mockResolvedValue(true)
    vi.spyOn(TuiApp.prototype, 'attach').mockResolvedValue(undefined)
    vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)
  })

  it('updated + 空白会话 + autoRestart 缺省 true → 自动重启（提示 + spawn + 退出）', async () => {
    const ctx = makeCtx()
    const appExit = vi.fn()
    ctx.reflect.get.mockImplementation((name: string) => name === 'appExit' ? appExit : undefined)
    const notifyAutoRestart = vi.spyOn(TuiApp.prototype, 'notifyAutoRestart').mockReturnValue(undefined)
    vi.spyOn(TuiApp.prototype, 'isBlankSession').mockReturnValue(true)

    apply(ctx, { stdin: makeStdin(), stdout: makeStdout() })

    await vi.waitFor(() => { expect(notifyAutoRestart).toHaveBeenCalledWith('0.1.2-rc.10') })
    await vi.waitFor(() => { expect(spawnSelfRestart).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(appExit).toHaveBeenCalledWith(0) })
  })

  it('updated + 会话非空白 → 只提示（notifyPluginUpdated），不自动重启', async () => {
    const ctx = makeCtx()
    const notifyPluginUpdated = vi.spyOn(TuiApp.prototype, 'notifyPluginUpdated').mockReturnValue(undefined)
    vi.spyOn(TuiApp.prototype, 'isBlankSession').mockReturnValue(false)

    apply(ctx, { stdin: makeStdin(), stdout: makeStdout() })

    await vi.waitFor(() => { expect(notifyPluginUpdated).toHaveBeenCalledWith('0.1.2-rc.10') })
    // 留出 400ms 重启窗口，确认未触发
    await new Promise(r => setTimeout(r, 450))
    expect(spawnSelfRestart).not.toHaveBeenCalled()
  })

  it('updated + autoRestartOnUpdate=false → 只提示，不自动重启', async () => {
    const ctx = makeCtx()
    const notifyPluginUpdated = vi.spyOn(TuiApp.prototype, 'notifyPluginUpdated').mockReturnValue(undefined)

    apply(ctx, { stdin: makeStdin(), stdout: makeStdout(), autoRestartOnUpdate: false })

    await vi.waitFor(() => { expect(notifyPluginUpdated).toHaveBeenCalledWith('0.1.2-rc.10') })
    await new Promise(r => setTimeout(r, 450))
    expect(spawnSelfRestart).not.toHaveBeenCalled()
  })

  it('updated + attach 失败 → 不自动重启（attachFailed 防循环守卫）', async () => {
    const ctx = makeCtx()
    vi.spyOn(TuiApp.prototype, 'attach').mockRejectedValue(new Error('attach boom'))
    vi.spyOn(TuiApp.prototype, 'dispose').mockResolvedValue(undefined)

    apply(ctx, { stdin: makeStdin(), stdout: makeStdout() })

    // 给 attach rejection + runSelfUpdate 微任务留时间
    await new Promise(r => setTimeout(r, 50))
    expect(spawnSelfRestart).not.toHaveBeenCalled()
  })
})
