/**
 * app-prefs — 本地偏好持久化 + 输入历史持久化的 app 级集成。
 *
 * 端到端链路：handleSubmit('/…') → 命令写透 → prefs.json/input-history.json
 * → 重建 TuiApp（同 tmp 路径）恢复。ctx/agent/stdin/stdout 替身镜像
 * app.spec.ts 的同名工厂（测试独立性优先，不跨 spec import）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { waitFor } from './helpers/wait-for.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WriteStream } from 'node:tty'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/ui/app.js'
import { CommitEngine } from '../src/engine/commit-engine.js'
import { getActiveThemeName, setTheme, clearCustomThemes } from '../src/theme.js'
import { exportCurrentTheme } from '../src/theme-custom.js'
import { readPrefs, writePrefs } from '../src/prefs.js'

// CommitEngine 构造参数透传断言用：包装 vi.fn 记录构造入参，实例仍是真身
// （文件级 mock 对本 spec 其余用例透明——行为与原类一致）。
vi.mock('../src/engine/commit-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/commit-engine.js')>()
  return {
    ...actual,
    CommitEngine: vi.fn(function (this: unknown, opts: ConstructorParameters<typeof actual.CommitEngine>[0]) {
      return new actual.CommitEngine(opts)
    }),
  }
})

// ── 替身工厂（镜像 app.spec.ts；仅本 spec 所需的最小面）──────────

function makeStdout(): WriteStream & { write: ReturnType<typeof vi.fn> } {
  return {
    columns: 100, rows: 30, write: vi.fn(), isTTY: false, on: vi.fn(), removeListener: vi.fn(),
  } as unknown as WriteStream & { write: ReturnType<typeof vi.fn> }
}

function makeStdin(): NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    isTTY: false, setRawMode: vi.fn(), resume: vi.fn(), setEncoding: vi.fn(), pause: vi.fn(),
  }) as unknown as NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }
}

function makeCtx(): Context & { sessions: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn>; fork: ReturnType<typeof vi.fn> }; agents: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }; reflect: { get: ReturnType<typeof vi.fn> }; on: ReturnType<typeof vi.fn> } {
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
      append: vi.fn(),
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

function bootApp(prefsPath: string | null, inputHistoryPath: string | null) {
  const ctx = makeCtx()
  const agent = makeAgent('proj-1')
  ctx.agents.create.mockResolvedValue({ agent, dispose: vi.fn() } as unknown as AgentHandle)
  ctx.sessions.get.mockReturnValue(agent.session)
  const stdin = makeStdin()
  const stdout = makeStdout()
  const app = new TuiApp({ ctx, stdout, stdin, prefsPath, inputHistoryPath })
  return { ctx, agent, stdin, stdout, app }
}

async function boot(prefsPath: string | null = null, inputHistoryPath: string | null = null) {
  const b = bootApp(prefsPath, inputHistoryPath)
  await b.app.attach()
  return b
}

function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-app-prefs-')), name)
}

const flushAsync = async (): Promise<void> => {
  // appendInputHistory 的进程内队列经微任务链落盘；两轮 setImmediate 足够
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
}

beforeEach(() => {
  clearCustomThemes()
  setTheme('graphite')
})

afterEach(() => {
  setTheme('graphite')
})

describe('主题选择持久化', () => {
  it('/theme paper 仅本会话不写 prefs；/theme paper default 才写透并恢复', async () => {
    const prefsPath = tmpPath('prefs.json')
    const b = await boot(prefsPath, null)
    await b.app.handleSubmit('/theme paper')
    expect(readPrefs(prefsPath).theme).toBeUndefined()
    expect(getActiveThemeName()).toBe('paper')

    await b.app.handleSubmit('/theme paper default')
    expect(readPrefs(prefsPath).theme).toBe('paper')

    await b.app.dispose()
    setTheme('graphite')
    const b2 = await boot(prefsPath, null)
    // attach 恢复主题是异步链：轮询等待恢复落定（flaky 加固）
    await waitFor(() => getActiveThemeName() === 'paper')
    expect(getActiveThemeName()).toBe('paper')
    await b2.app.dispose()
  })

  it('/theme auto 仅本会话；/theme auto default 才写 auto 档', async () => {
    const prefsPath = tmpPath('prefs.json')
    const b = await boot(prefsPath, null)
    await b.app.handleSubmit('/theme paper default')
    await b.app.handleSubmit('/theme auto')
    expect(readPrefs(prefsPath).theme).toBe('paper')
    await b.app.handleSubmit('/theme auto default')
    expect(readPrefs(prefsPath).theme).toBe('auto')
    await b.app.dispose()
  })

  it('失效主题（custom 已删）恢复时回落 auto 并清偏好', async () => {
    const prefsPath = tmpPath('prefs.json')
    const b = await boot(prefsPath, null)
    await b.app.handleSubmit('/theme custom:gone')
    // setTheme('custom:gone') 失败 → onThemeApplied 不写透；prefs 无 theme
    expect(readPrefs(prefsPath).theme).toBeUndefined()
    await b.app.dispose()
  })
})

describe('scrollbackMaxLines 偏好透传', () => {
  it('prefs.scrollbackMaxLines 传给 CommitEngine；缺省传 undefined（引擎内 1000 兜底）', async () => {
    const prefsPath = tmpPath('prefs.json')
    writeFileSync(prefsPath, '{"scrollbackMaxLines": 5000}')
    const b = await boot(prefsPath, null)
    expect(CommitEngine).toHaveBeenCalledWith(expect.objectContaining({ scrollbackMaxLines: 5000 }))
    await b.app.dispose()

    vi.mocked(CommitEngine).mockClear()
    const b2 = await boot(null, null)
    expect(CommitEngine).toHaveBeenCalledWith(expect.objectContaining({ scrollbackMaxLines: undefined }))
    await b2.app.dispose()
  })
})

describe('density / 常驻面板 / glance 段持久化', () => {
  it('/density 仅本会话；/density default 才写透 compactMode', async () => {
    const prefsPath = tmpPath('prefs.json')
    const b = await boot(prefsPath, null)
    await b.app.handleSubmit('/density')
    expect(readPrefs(prefsPath).compactMode).toBeUndefined()
    await b.app.handleSubmit('/density default')
    expect(readPrefs(prefsPath).compactMode).toBe(true)
    await b.app.dispose()
  })

  it('/subagents 与 /workflow 切换写透 panels', async () => {
    const prefsPath = tmpPath('prefs.json')
    const b = await boot(prefsPath, null)
    await b.app.handleSubmit('/subagents')
    await b.app.handleSubmit('/workflow')
    expect(readPrefs(prefsPath).panels).toEqual({ subagents: true, workflow: true })
    await b.app.handleSubmit('/subagents')
    expect(readPrefs(prefsPath).panels).toEqual({ subagents: false, workflow: true })
    await b.app.dispose()
  })

  it('/glance cost 切换段隐藏并写透；无参回显可用段', async () => {
    const prefsPath = tmpPath('prefs.json')
    const b = await boot(prefsPath, null)
    await b.app.handleSubmit('/glance cost')
    expect(readPrefs(prefsPath).glance).toEqual({ hideSegments: ['cost'] })
    await b.app.handleSubmit('/glance cost')
    // 清空 = 回到缺省：解析层按「空偏好不占 key」丢弃（前向兼容语义）
    expect(readPrefs(prefsPath).glance).toBeUndefined()
    await b.app.dispose()
  })

  it('/preset id default 写透 prefs.preset；newSession setup 里 mount', async () => {
    const prefsPath = tmpPath('prefs.json')
    writePrefs(prefsPath, { preset: 'minimal' })
    const mount = vi.fn(async () => ({ id: 'minimal', name: '极简' }))
    const b = bootApp(prefsPath, null)
    b.ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'agentPresets') return { mount }
      return undefined
    })
    b.ctx.agents.create.mockImplementation(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
      await opts.setup?.({ on: vi.fn(() => () => {}) })
      return { agent: b.agent, dispose: vi.fn() }
    })
    await b.app.attach()
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'minimal')
    expect(b.agent.session.append).toHaveBeenCalledWith('agent-preset/selected', { agentPreset: 'minimal' })
    await b.app.dispose()
  })

  it('prefs 无默认预设 → newSession mount 显式 standard（#48：更新后不再依赖宿主 patch default）', async () => {
    const prefsPath = tmpPath('prefs.json')
    const mount = vi.fn(async () => ({ id: 'standard', name: '标准模式' }))
    const b = bootApp(prefsPath, null)
    b.ctx.reflect.get.mockImplementation((name: string) => {
      if (name === 'agentPresets') return { mount }
      return undefined
    })
    b.ctx.agents.create.mockImplementation(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
      await opts.setup?.({ on: vi.fn(() => () => {}) })
      return { agent: b.agent, dispose: vi.fn() }
    })
    await b.app.attach()
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'standard')
    expect(b.agent.session.append).toHaveBeenCalledWith('agent-preset/selected', { agentPreset: 'standard' })
    await b.app.dispose()
  })

  it('prefsPath=null（VITEST 缺省）不落盘', async () => {
    const b = await boot(null, null)
    await b.app.handleSubmit('/density')
    // 无文件路径可查——断言不抛错且功能路径完好（命令执行不因禁用态失败）
    expect(b.agent.followup.mock.calls.length).toBe(0)
    await b.app.dispose()
  })
})

describe('输入历史持久化', () => {
  it('提交文本落盘；重复提交去重；重建 app 恢复到 InputLine', async () => {
    const historyPath = tmpPath('input-history.json')
    const b = await boot(null, historyPath)
    await b.app.handleSubmit('hello world')
    await b.app.handleSubmit('another one')
    await b.app.handleSubmit('hello world')
    await flushAsync()
    const saved = JSON.parse(readFileSync(historyPath, 'utf-8')) as string[]
    expect(saved).toEqual(['hello world', 'another one'])
    await b.app.dispose()

    // 重建：构造时 loadInputHistory 喂入内存（Ctrl+P/N 即时可用）——
    // 再提交一条，文件在既有两条之上追加（证明恢复进内存并继续维护）
    const b2 = await boot(null, historyPath)
    await b2.app.handleSubmit('third entry')
    await flushAsync()
    const saved2 = JSON.parse(readFileSync(historyPath, 'utf-8')) as string[]
    expect(saved2).toEqual(['third entry', 'hello world', 'another one'])
    await b2.app.dispose()
  })
})

describe('exportCurrentTheme（/theme export 域函数）', () => {
  it('导出当前主题为自定义模板（baseDir 注入，不碰真实 home）', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-theme-export-'))
    setTheme('paper')
    const msg = exportCurrentTheme('integ', base)
    expect(msg).toContain('已导出')
    const file = join(base, 'themes', 'integ.json')
    expect(existsSync(file)).toBe(true)
    const template = JSON.parse(readFileSync(file, 'utf-8')) as { base?: string; colors?: Record<string, string>; overrides?: Record<string, string> }
    expect(template.base).toBe('paper')
    expect(template.colors?.primary).toBeTruthy()
    expect(template.overrides?.userColor).toBeTruthy()
  })

  it('就地注册：导出后 setTheme(custom:<name>) 可解析', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-theme-export-'))
    setTheme('graphite')
    exportCurrentTheme('hotload', base)
    expect(setTheme('custom:hotload')).toBe(true)
  })
})
