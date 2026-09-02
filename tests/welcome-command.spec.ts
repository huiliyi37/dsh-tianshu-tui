/**
 * welcome-command.spec.ts — /welcome 斜杠命令（star/retro 切换写 prefs，
 * 下次启动生效）与 BUILTIN_COMMAND_NAMES 登记。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WriteStream } from 'node:tty'
import { TuiApp } from '../src/ui/app.js'
import { BUILTIN_COMMAND_NAMES, type SlashCommand } from '../src/commands/registry.js'

vi.mock('../src/os-notify.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyOs: vi.fn(),
  applyNotifyOsPref: vi.fn(),
}))

/** 测试需要的最小 app 面（TuiApp 私有成员经窄接口访问）。 */
interface WelcomeAppAccess {
  slash: { get(name: string): SlashCommand | undefined }
  prefs: { welcomeStyle?: string }
  dispose(): Promise<void>
}

function makeStdout(): WriteStream {
  return {
    columns: 100, rows: 30, write: vi.fn(), isTTY: false,
    on: vi.fn(), removeListener: vi.fn(),
  } as unknown as WriteStream
}

function makeStdin(): NodeJS.ReadStream {
  return {
    isTTY: false, on: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn(),
    setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn(), setEncoding: vi.fn(),
  } as unknown as NodeJS.ReadStream
}

function makeCtx(): Context {
  return {
    on: vi.fn(() => vi.fn(() => true)),
    get: vi.fn(),
    provide: vi.fn(() => () => {}),
    reflect: { get: vi.fn(() => undefined) },
    sessions: { list: vi.fn(() => []) },
  } as unknown as Context
}

function makeApp(opts: Record<string, unknown> = {}): WelcomeAppAccess {
  return new TuiApp({
    ctx: makeCtx(),
    stdout: makeStdout(),
    stdin: makeStdin(),
    ...opts,
  }) as unknown as WelcomeAppAccess
}

function runWelcome(app: WelcomeAppAccess, text = ''): string[] {
  const lines: string[] = []
  const cmd = app.slash.get('welcome')
  if (!cmd) throw new Error('/welcome 未注册')
  cmd.run({ text, ctx: undefined as never, sessionId: null, echo: (t: string) => { lines.push(t) }, rerender: () => {} })
  return lines
}

describe('/welcome 命令（star/retro 切换）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-welcome-'))
  const prefsPath = join(dir, 'prefs.json')

  afterEach(() => {
    try { rmSync(prefsPath) } catch { /* ignore */ }
  })

  it('无参：显示当前风格（缺省 star）与可选值', async () => {
    const app = makeApp({ prefsPath })
    const out = runWelcome(app).join('')
    expect(out).toContain('star')
    expect(out).toContain('retro')
    await app.dispose()
  })

  it('retro/star 写 prefs 落盘；非法参数不落盘', async () => {
    const app = makeApp({ prefsPath })

    runWelcome(app, 'retro')
    expect(JSON.parse(readFileSync(prefsPath, 'utf-8')).welcomeStyle).toBe('retro')

    runWelcome(app, 'star')
    expect(JSON.parse(readFileSync(prefsPath, 'utf-8')).welcomeStyle).toBe('star')

    runWelcome(app, 'bogus')
    expect(JSON.parse(readFileSync(prefsPath, 'utf-8')).welcomeStyle).toBe('star')
    await app.dispose()
  })

  it('echo 提示下次启动生效', async () => {
    const app = makeApp({ prefsPath })
    expect(runWelcome(app, 'retro').join('')).toContain('下次启动生效')
    await app.dispose()
  })

  it('BUILTIN_COMMAND_NAMES 已登记 welcome', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('welcome')
  })
})
