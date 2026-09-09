/**
 * Phase 6.1 Slash 命令系统 — RED 基线。
 *
 * 覆盖：
 * - resolveSlashCommand：/ 前缀检测 + 最小唯一前缀解析（歧义/未知 → null）
 * - SlashCommandRegistry：注册/列举/覆盖/反注册 + 实例解析 + 内联 hint
 * - 内置命令：/theme /clear /session(new|list) /compact 的执行行为
 *   （/steer 已在 steer.spec.ts 覆盖，这里只验证注册表包含它）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  BUILTIN_COMMAND_NAMES,
  SlashCommandRegistry,
  createBuiltinCommands,
  resolveSlashCommand,
  suggestCommands,
  type SlashCommand,
} from '../src/commands/registry.js'
import { getActiveThemeName, setTheme } from '../src/theme.js'

/** 最小 ctx 替身：/session list 需要的 sessions.list + get('sessionPersistence')。 */
function makeCtx(overrides: Partial<Record<'sessions' | 'agents' | 'compact' | 'agentDefaultModel' | 'goals' | 'tasks' | 'agentPresets' | 'llm', unknown>> = {}): Context {
  const ctx = {
    sessions: {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
    },
    agents: {
      get: vi.fn(() => undefined),
    },
    // Cordis 4 注入代理：可选服务必须经 reflect.get 读取（属性访问抛 without inject）
    reflect: {
      get: vi.fn((name: string) => (overrides as Record<string, unknown>)[name]),
    },
    get: vi.fn(() => undefined),
    ...overrides,
  } as unknown as Context
  return ctx
}

/** 执行命令的 args 构造（echo/rerender 可断言）。 */
function makeArgs(overrides: Partial<Parameters<ReturnType<typeof createBuiltinCommands>[number]['run']>[0]> = {}) {
  const echo = vi.fn()
  const rerender = vi.fn()
  const args = {
    text: '',
    ctx: makeCtx(),
    sessionId: null as SessionId | null,
    echo,
    rerender,
    ...overrides,
  }
  return { args, echo, rerender }
}

function commandByName(name: string) {
  const deps = {
    onThemeChanged: vi.fn(),
    newSession: vi.fn(),
    forkSession: vi.fn(),
    switchLiveModel: vi.fn(() => true),
    clearScrollback: vi.fn(),
    toggleTaskPanel: vi.fn(),
    toggleSubagentsPanel: vi.fn(),
    toggleWorkflowPanel: vi.fn(),
    rewindSession: vi.fn(() => true),
    askBtw: vi.fn(async () => true),
    openMemoryBrowser: vi.fn(async () => true),
    openScrollPager: vi.fn(),
    switchSession: vi.fn(async () => undefined),
    exportTranscript: vi.fn(async (path?: string) => path ?? '/tmp/dsh-export-s1.md'),
    requestExit: vi.fn(),
    requestRestart: vi.fn(),
    listCommands: vi.fn<() => SlashCommand[]>(() => []),
    currentAgent: vi.fn<() => Agent | null>(() => null),
    isBlankSession: vi.fn(() => true),
    setYoloMode: vi.fn(),
    openModelPicker: vi.fn(),
    openThemePicker: vi.fn(),
    openEffortPicker: vi.fn(),
    onThemeApplied: vi.fn(),
    applyThemeAuto: vi.fn(),
    exportTheme: vi.fn((): string => 'exported'),
    persistPresetDefault: vi.fn(),
    currentDefaultPreset: vi.fn(() => undefined),
    openSessionPicker: vi.fn(),
    openKeyDialog: vi.fn(),
    checkForUpdate: vi.fn(),
    openCommandPalette: vi.fn(),
    sessionCostReport: vi.fn<() => string[]>(() => []),
  }
  const commands = createBuiltinCommands(deps)
  const cmd = commands.find(c => c.name === name)
  if (cmd === undefined) throw new Error(`builtin command not found: ${name}`)
  return { cmd, deps, commands }
}

beforeEach(() => {
  setTheme('graphite')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveSlashCommand — / 前缀检测与最小唯一前缀解析', () => {
  it('非斜杠输入返回 null', () => {
    expect(resolveSlashCommand('hello', BUILTIN_COMMAND_NAMES)).toBeNull()
  })

  it('孤立斜杠返回 null', () => {
    expect(resolveSlashCommand('/', BUILTIN_COMMAND_NAMES)).toBeNull()
  })

  it('完整命令名解析并剥离参数', () => {
    const parsed = resolveSlashCommand('/theme paper', BUILTIN_COMMAND_NAMES)
    expect(parsed).not.toBeNull()
    expect(parsed?.command.name).toBe('theme')
    expect(parsed?.text).toBe('paper')
  })

  it('无参数命令 text 为空串', () => {
    const parsed = resolveSlashCommand('/clear', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('clear')
    expect(parsed?.text).toBe('')
  })

  it('最小唯一前缀解析（/ste → steer；/st 因 status 加入而歧义）', () => {
    // /st 现在同时命中 steer/status → 歧义拒绝；/ste 才是 steer 的最小唯一前缀。
    expect(resolveSlashCommand('/st', BUILTIN_COMMAND_NAMES)).toBeNull()
    const parsed = resolveSlashCommand('/ste 收敛', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('steer')
    expect(parsed?.text).toBe('收敛')
  })

  it('歧义前缀返回 null（/c 在 clear/compact 间不猜）', () => {
    expect(resolveSlashCommand('/c', BUILTIN_COMMAND_NAMES)).toBeNull()
  })

  it('歧义消除后的长前缀可解析（/cl → clear, /comp → compact, /conf → config）', () => {
    // config 加入 BUILTIN_COMMAND_NAMES 后 /co 在 compact/config 间歧义；
    // compact 最小唯一前缀退化为 /comp，config 为 /conf。
    expect(resolveSlashCommand('/cl', BUILTIN_COMMAND_NAMES)?.command.name).toBe('clear')
    expect(resolveSlashCommand('/co', BUILTIN_COMMAND_NAMES)).toBeNull()
    expect(resolveSlashCommand('/comp', BUILTIN_COMMAND_NAMES)?.command.name).toBe('compact')
    expect(resolveSlashCommand('/conf', BUILTIN_COMMAND_NAMES)?.command.name).toBe('config')
  })

  it('未知名命令返回 null', () => {
    expect(resolveSlashCommand('/zzz', BUILTIN_COMMAND_NAMES)).toBeNull()
    expect(resolveSlashCommand('/xyzzy', BUILTIN_COMMAND_NAMES)).toBeNull()
  })

  it('参数尾随空格 trim 掉', () => {
    const parsed = resolveSlashCommand('/theme   paper  ', BUILTIN_COMMAND_NAMES)
    expect(parsed?.text).toBe('paper')
  })

  it('内置命令集含 /steer（复用既有入口）', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('steer')
  })
})

describe('SlashCommandRegistry — 注册/列举/解析', () => {
  it('register 后 list/get 可见', () => {
    const registry = new SlashCommandRegistry()
    const cmd = { name: 'ping', description: '测试命令', run: vi.fn() }
    registry.register(cmd)
    expect(registry.list()).toHaveLength(1)
    expect(registry.get('ping')).toBe(cmd)
  })

  it('同名 register 覆盖旧命令', () => {
    const registry = new SlashCommandRegistry()
    registry.register({ name: 'ping', description: '旧', run: vi.fn() })
    const replacement = { name: 'ping', description: '新', run: vi.fn() }
    registry.register(replacement)
    expect(registry.get('ping')).toBe(replacement)
    expect(registry.list()).toHaveLength(1)
  })

  it('unregister 移除命令', () => {
    const registry = new SlashCommandRegistry()
    registry.register({ name: 'ping', description: '', run: vi.fn() })
    registry.unregister('ping')
    expect(registry.get('ping')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('空名或含空格的命令名 register 抛错', () => {
    const registry = new SlashCommandRegistry()
    expect(() =>{  registry.register({ name: '', description: '', run: vi.fn() }) }).toThrow()
    expect(() =>{  registry.register({ name: 'a b', description: '', run: vi.fn() }) }).toThrow()
  })

  it('resolve 使用实例注册的命令（扩展方注册后可解析）', () => {
    const registry = new SlashCommandRegistry()
    registry.register({ name: 'ping', description: '', run: vi.fn() })
    const parsed = registry.resolve('/ping localhost')
    expect(parsed?.command.name).toBe('ping')
    expect(parsed?.text).toBe('localhost')
  })

  it('hint：/ 开头且有匹配时返回命令提示', () => {
    const registry = new SlashCommandRegistry()
    registry.register({ name: 'theme', description: '切换主题', argsHint: '<name>', run: vi.fn() })
    registry.register({ name: 'clear', description: '清空', run: vi.fn() })
    expect(registry.hint('/th')).toContain('/theme <name>')
    expect(registry.hint('/c')).toContain('/clear')
  })

  it('hint：非 / 输入、孤立 / 返回 null；无匹配返回空态引导（路径类输入静默）', () => {
    const registry = new SlashCommandRegistry()
    registry.register({ name: 'clear', description: '', run: vi.fn() })
    expect(registry.hint('hello')).toBeNull()
    expect(registry.hint('/')).toBeNull()
    expect(registry.hint('/xyz')).toBe('无匹配命令（Enter 提交查看相近建议）')
    // 类路径/参数输入不误报无匹配（/src/main.ts、/tmp/foo bar）
    expect(registry.hint('/src/main.ts')).toBeNull()
    expect(registry.hint('/tmp/foo bar')).toBeNull()
  })
})

describe('内置命令 — /theme', () => {
  it('有效主题名仅本会话（不写 prefs）', async () => {
    const { cmd, deps } = commandByName('theme')
    const { args, echo } = makeArgs({ text: 'paper' })
    await cmd.run(args)
    expect(getActiveThemeName()).toBe('paper')
    expect(deps.onThemeApplied).not.toHaveBeenCalled()
    expect(deps.onThemeChanged).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))
  })

  it('/theme paper default 才写启动默认', async () => {
    const { cmd, deps } = commandByName('theme')
    const { args, echo } = makeArgs({ text: 'paper default' })
    await cmd.run(args)
    expect(getActiveThemeName()).toBe('paper')
    expect(deps.onThemeApplied).toHaveBeenCalledWith('paper')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认主题：paper'))
  })

  it('/theme default 保存当前主题为启动默认', async () => {
    const { cmd, deps } = commandByName('theme')
    const { args, echo } = makeArgs({ text: 'default' })
    await cmd.run(args)
    expect(deps.onThemeApplied).toHaveBeenCalledWith('graphite')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认主题：graphite'))
  })

  it('未知主题回显错误且不改当前主题', async () => {
    const { cmd } = commandByName('theme')
    const { args, echo } = makeArgs({ text: 'no-such-theme' })
    await cmd.run(args)
    expect(getActiveThemeName()).toBe('graphite')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('未知主题: no-such-theme'))
  })

  it('空参数打开主题选择器（#31，替代用法回显）', async () => {
    const { cmd, deps } = commandByName('theme')
    const { args, echo } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(deps.openThemePicker).toHaveBeenCalled()
    expect(echo).not.toHaveBeenCalled()
  })
})

describe('内置命令 — /clear', () => {
  it('清空 scrollback 并回显', async () => {
    const { cmd, deps } = commandByName('clear')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.clearScrollback).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已清空'))
  })
})

describe('内置命令 — /scroll', () => {
  it('打开分页查看器（deps 透传一次，不回显）', async () => {
    const { cmd, deps } = commandByName('scroll')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.openScrollPager).toHaveBeenCalledTimes(1)
    expect(echo).not.toHaveBeenCalled()
  })
})

describe('内置命令 — /session', () => {
  it('list 直接逐行打印已知会话（旧版样式，不进交互界面）', async () => {
    const { cmd, deps } = commandByName('session')
    const sid = 'session-red-1' as SessionId
    const other = 'session-red-2' as SessionId
    const ctx = makeCtx({
      sessions: {
        list: vi.fn(() => [
          { id: other, header: { id: other, version: 0, createdAt: 2 } },
          { id: sid, header: { id: sid, version: 0, createdAt: 1 } },
        ]),
        get: vi.fn(() => undefined),
      },
    })
    const { args, echo } = makeArgs({ text: 'list', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-red-1'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-red-2'))
    expect(deps.openSessionPicker).not.toHaveBeenCalled()
  })

  it('list 空会话回显占位', async () => {
    const { cmd } = commandByName('session')
    const { args, echo } = makeArgs({ text: 'list' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('无会话'))
  })

  it('new 走 deps.newSession 并回显新会话 id', async () => {
    const { cmd, deps } = commandByName('session')
    deps.newSession.mockResolvedValue('session-new-1')
    const { args, echo } = makeArgs({ text: 'new' })
    await cmd.run(args)
    expect(deps.newSession).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-new-1'))
  })

  it('未知子命令回显用法', async () => {
    const { cmd, deps } = commandByName('session')
    const { args, echo } = makeArgs({ text: 'fork' })
    await cmd.run(args)
    expect(deps.newSession).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('/session new|list'))
  })
})

describe('内置命令 — /session list 会话标题（官方 session/title 事件 fold + fallback）', () => {
  /** 一条带真人用户消息与可选标题事件的 live 会话替身。 */
  function liveSession(sid: SessionId, question: string, title?: string): { id: SessionId; events: SessionEvent[]; snapshotEvents(this: { events?: unknown[] }): unknown[] } {
    const events = [
      {
        seq: 1,
        time: 1001,
        type: 'user/message',
        data: { content: [{ type: 'text', text: question }], source: { kind: 'user' } },
      },
    ] as unknown as SessionEvent[]
    if (title !== undefined) {
      events.push({
        seq: 2,
        time: 1002,
        type: 'session/title',
        data: { title, messageSeqs: [1], source: { kind: 'provider', provider: 'session-title-llm' } },
      } as unknown as SessionEvent)
    }
    return { id: sid, events, snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] } }
  }

  function listRows(sid: SessionId, createdAt = 1): Array<{ id: SessionId; header: { id: SessionId; version: number; createdAt: number } }> {
    return [{ id: sid, header: { id: sid, version: 0, createdAt } }]
  }


  it('list 展示官方 session/title 事件折叠出的标题', async () => {
    const { cmd } = commandByName('session')
    const sid = 'session-title-1' as SessionId
    const live = liveSession(sid, '评估某模型的识别准确率', '评估某模型的识别准确率')
    const ctx = makeCtx({
      sessions: {
        list: vi.fn(() => listRows(sid)),
        get: vi.fn(() => live),
      },
    })
    const { args, echo } = makeArgs({ text: 'list', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining(`session-title-1 · 评估某模型的识别准确率 · ${new Date(1).toISOString()}`))
  })

  it('list 无标题事件时展示首条真人消息的确定性 fallback', async () => {
    const { cmd } = commandByName('session')
    const sid = 'session-title-2' as SessionId
    const live = liveSession(sid, '写个脚本计算两个数组的交集')
    const ctx = makeCtx({
      sessions: {
        list: vi.fn(() => listRows(sid)),
        get: vi.fn(() => live),
      },
    })
    const { args, echo } = makeArgs({ text: 'list', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-title-2 · 写个脚本计算两个数组的交集 ·'))
  })

  it('list 无聊天记录的会话展示「新对话」', async () => {
    const { cmd } = commandByName('session')
    const sid = 'session-title-3' as SessionId
    const ctx = makeCtx({
      sessions: {
        list: vi.fn(() => listRows(sid)),
        get: vi.fn(() => ({ id: sid, events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] } })),
      },
    })
    const { args, echo } = makeArgs({ text: 'list', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-title-3 · 新对话 ·'))
  })

  it('list 不发起任何 llm 调用（纯只读展示）', async () => {
    const { cmd } = commandByName('session')
    const sid = 'session-title-4' as SessionId
    const live = liveSession(sid, '问题', '标题')
    const ctx = makeCtx({
      sessions: {
        list: vi.fn(() => listRows(sid)),
        get: vi.fn(() => live),
      },
    })
    const { args, echo } = makeArgs({ text: 'list', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalled()
    expect(ctx.reflect.get).not.toHaveBeenCalledWith('llm', false)
  })
})

describe('内置命令 — /fork 与 /branch（A3 会话分叉）', () => {
  it('/fork 走 deps.forkSession 并回显新会话 id', async () => {
    const { cmd, deps } = commandByName('fork')
    deps.forkSession.mockResolvedValue('session-fork-1')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.forkSession).toHaveBeenCalledTimes(1)
    expect(deps.forkSession).toHaveBeenCalledWith()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-fork-1'))
  })

  it('/fork 带文本 → directive 传 forkSession 作为分叉后首条 prompt', async () => {
    const { cmd, deps } = commandByName('fork')
    deps.forkSession.mockResolvedValue('session-fork-1')
    const { args, echo } = makeArgs({ text: '探索另一种方案' })
    await cmd.run(args)
    expect(deps.forkSession).toHaveBeenCalledTimes(1)
    expect(deps.forkSession).toHaveBeenCalledWith({ directive: '探索另一种方案' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-fork-1'))
  })

  it('/fork 无会话（forkSession 抛错）时向上抛，由分发层回显失败', async () => {
    const { cmd, deps } = commandByName('fork')
    deps.forkSession.mockRejectedValue(new Error('当前无会话可分叉'))
    const { args, echo } = makeArgs()
    await expect(cmd.run(args)).rejects.toThrow('当前无会话可分叉')
    expect(echo).not.toHaveBeenCalled()
  })

  it('/branch 是 /fork 的别名（同一 handler 行为）', async () => {
    const { cmd, deps } = commandByName('branch')
    deps.forkSession.mockResolvedValue('session-branch-1')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.forkSession).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('session-branch-1'))
  })
})

describe('内置命令 — /rewind（C3 项 3 回退）', () => {
  it('/rewind 打开 rewind overlay（deps.rewindSession 返回 true）', async () => {
    const { cmd, deps } = commandByName('rewind')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.rewindSession).toHaveBeenCalledTimes(1)
    expect(echo).not.toHaveBeenCalled() // overlay 已接管，无回显
  })

  it('/rewind 无会话时 rewindSession 返回 false → 回显不可用', async () => {
    const { cmd, deps } = commandByName('rewind')
    deps.rewindSession.mockReturnValue(false)
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前无可回退的会话'))
  })
})

describe('内置命令 — /compact', () => {
  it('compact 服务未加载时回显不可用', async () => {
    const { cmd } = commandByName('compact')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('不可用'))
  })

  it('compact 服务存在时调用 compactIfNeeded 并回显结果', async () => {
    const { cmd } = commandByName('compact')
    const sid = 'session-compact-1' as SessionId
    const compactIfNeeded = vi.fn(async (_agent: unknown) => null)
    const ctx = makeCtx({
      sessions: { list: vi.fn(() => []), get: vi.fn(() => ({ id: sid })) },
      agents: { get: vi.fn(() => ({ options: { provider: 'p', model: 'm' } })) },
      compact: { compactIfNeeded },
    })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: sid })
    await cmd.run(args)
    expect(compactIfNeeded).toHaveBeenCalledTimes(1)
    const agentArg = compactIfNeeded.mock.calls[0]?.[0] as { session: { id: string }; options: unknown }
    expect(agentArg.session.id).toBe(sid)
    expect(agentArg.options).toEqual({ provider: 'p', model: 'm' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('无需压缩'))
  })

  it('compact 只在 agent isolate 时走 serviceFor，不再误报不可用', async () => {
    const { cmd } = commandByName('compact')
    const sid = 'session-compact-iso' as SessionId
    const compactIfNeeded = vi.fn(async () => null)
    const isolated = { compactIfNeeded }
    const agent = { options: { provider: 'p', model: 'm' } }
    const ctx = makeCtx({
      sessions: { list: vi.fn(() => []), get: vi.fn(() => ({ id: sid })) },
      agents: { get: vi.fn(() => agent) },
      agentPresets: { serviceFor: (_a: unknown, name: string) => name === 'compact' ? isolated : undefined },
    })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: sid })
    await cmd.run(args)
    expect(compactIfNeeded).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('无需压缩'))
  })
})

describe('内置命令 — /model', () => {
  it('无参数打开模型选择器且不写选择（#31，替代回显）', async () => {
    const { cmd, deps } = commandByName('model')
    const currentSelection = vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' }))
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({ agentDefaultModel: { currentSelection, saveSelection } })
    const { args, echo } = makeArgs({ text: '', ctx })
    await cmd.run(args)
    expect(deps.openModelPicker).toHaveBeenCalled()
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).not.toHaveBeenCalled()
  })

  it('provider/model 仅本会话热切，不写默认', async () => {
    const { cmd, deps } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'openai/gpt-5', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))
  })

  it('/model x/y default 才 saveSelection', async () => {
    const { cmd, deps } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'openai/gpt-5 default', ctx })
    await cmd.run(args)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认模型'))
  })

  it('/model default 保存当前选择为启动默认', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'default', ctx })
    await cmd.run(args)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认模型：deepseek/v4-flash'))
  })

  it('含斜杠的模型 id（openrouter 风格）：按首个斜杠分割不截断', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'openrouter/stealth/ox-alpha', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('openrouter/stealth/ox-alpha'))
  })

  it('裸模型名沿用当前 provider', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'v4-max', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('deepseek/v4-max'))
  })

  it('spark-flash 别名 → deepseek-official/deepseek-v4-flash 一键切换', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'spark-flash', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('deepseek-official/deepseek-v4-flash'))
  })

  it('spark-pro 别名 → deepseek-official/deepseek-v4-pro 一键切换', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'spark-pro', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('deepseek-official/deepseek-v4-pro'))
  })

  it('effort 参数：/model p/m high → 热切带 reasoningEffort，不写默认', async () => {
    const { cmd, deps } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'deepseek/v4-flash high', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('effort: high'))
  })

  it('/model p/m high default → saveSelection 带 reasoningEffort', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args } = makeArgs({ text: 'deepseek/v4-flash high default', ctx })
    await cmd.run(args)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' })
  })

  it('effort 参数与别名组合：/model spark-flash max', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args } = makeArgs({ text: 'spark-flash max', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('不带 effort 参数：热切不含 reasoningEffort（清除语义，回 provider 默认）', async () => {
    const { cmd, deps } = commandByName('model')
    const saveSelection = vi.fn(async (_selection: Record<string, unknown>) => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' })),
        saveSelection,
      },
    })
    const { args } = makeArgs({ text: 'deepseek/v4-pro', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-pro' })
  })

  it('非法 effort：报错且不调用 saveSelection', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'deepseek/v4-flash turbo', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('turbo'))
  })

  it('无参打开模型选择器（#31；effort 信息由选择器 current 高亮承载）', async () => {
    const { cmd, deps } = commandByName('model')
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek-spark', model: 'v4-flash', reasoningEffort: 'high' })),
        saveSelection: vi.fn(async () => {}),
      },
    })
    const { args } = makeArgs({ text: '', ctx })
    await cmd.run(args)
    expect(deps.openModelPicker).toHaveBeenCalled()
  })

  it('C2 项 4：切换模型热切当前会话（switchLiveModel 被调，回显仅本会话）', async () => {
    const { cmd, deps } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'deepseek/v4-max', ctx })
    await cmd.run(args)
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-max' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))
  })

  it('C2 项 4：registry 兜底会话不可热切（switchLiveModel false → 回显默认生效）', async () => {
    const { cmd, deps } = commandByName('model')
    deps.switchLiveModel.mockReturnValue(false)
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'v4-flash' })),
        saveSelection,
      },
    })
    const { args, echo } = makeArgs({ text: 'deepseek/v4-max', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前会话不可热切'))
  })

  it('agent-default-model 服务缺失时回显不可用', async () => {
    const { cmd } = commandByName('model')
    const { args, echo } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('不可用'))
  })

  // 目录校验（对标 Claude Code：拼写错误不切换）。llm facet 经 makeCtx 的
  // reflect.get mock 注入；未注入时跳过校验（上方既有用例即此路径）。
  const llmCatalog = (providers: string[], models: Record<string, string[]>) => ({
    listProviders: vi.fn(() => providers.map(id => ({ id }))),
    listModels: vi.fn(async (provider: string) => (models[provider] ?? []).map(id => ({ id }))),
  })
  const modelFacet = (saveSelection: ReturnType<typeof vi.fn>) => ({
    currentSelection: vi.fn(() => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })),
    saveSelection,
  })
  const OFFICIAL_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

  it('未知 provider 硬拒绝并列出已注册路由', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: modelFacet(saveSelection),
      llm: llmCatalog(['deepseek-official'], { 'deepseek-official': OFFICIAL_MODELS }),
    })
    const { args, echo } = makeArgs({ text: 'opanai/gpt-5', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('未知 provider: opanai'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('deepseek-official'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('未切换'))
  })

  it('目录外模型名硬拒绝并就近建议（写错不切换）', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: modelFacet(saveSelection),
      llm: llmCatalog(['deepseek-official'], { 'deepseek-official': OFFICIAL_MODELS }),
    })
    const { args, echo } = makeArgs({ text: 'deepseek-official/deepseek-v4-pr', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('没有模型 deepseek-v4-pr'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('deepseek-official/deepseek-v4-pro'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前仍是 deepseek-official/deepseek-v4-flash'))
  })

  it('目录为空的 provider 放行（llm 目录为 advisory，空目录无法证伪）', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: modelFacet(saveSelection),
      llm: llmCatalog(['openai-compatible'], { 'openai-compatible': [] }),
    })
    const { args } = makeArgs({ text: 'openai-compatible/gpt-5', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('裸模型名沿用当前 provider 并按其目录校验', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: modelFacet(saveSelection),
      llm: llmCatalog(['deepseek-official'], { 'deepseek-official': OFFICIAL_MODELS }),
    })
    const { args, echo } = makeArgs({ text: 'deepseek-v4-mx', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('没有模型 deepseek-v4-mx'))
  })

  it('空段路由（a/ 一类）落裸模型路径后由目录校验拦下', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: modelFacet(saveSelection),
      llm: llmCatalog(['deepseek-official'], { 'deepseek-official': OFFICIAL_MODELS }),
    })
    const { args, echo } = makeArgs({ text: 'a/', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('没有模型 a/'))
  })

  it('spark 别名目标 provider 未注册时硬拒绝（loud，不再静默保存死路由）', async () => {
    const { cmd } = commandByName('model')
    const saveSelection = vi.fn(async () => {})
    const ctx = makeCtx({
      agentDefaultModel: modelFacet(saveSelection),
      llm: llmCatalog(['other-provider'], { 'other-provider': ['m-1'] }),
    })
    const { args, echo } = makeArgs({ text: 'spark-flash', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('未知 provider: deepseek-official'))
  })

  it('内置命令集含 /model', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('model')
  })
})

describe('内置命令 — /export（T3 会话导出）', () => {
  it('无参数：exportTranscript() 无 path 调用并回显导出路径', async () => {
    const { cmd, deps } = commandByName('export')
    const { args, echo } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(deps.exportTranscript).toHaveBeenCalledWith(undefined)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('/tmp/dsh-export-s1.md'))
  })

  it('带 path：exportTranscript(path) 传入并回显', async () => {
    const { cmd, deps } = commandByName('export')
    const { args, echo } = makeArgs({ text: './notes.md' })
    await cmd.run(args)
    expect(deps.exportTranscript).toHaveBeenCalledWith('./notes.md')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('./notes.md'))
  })

  it('内置命令集含 /export', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('export')
  })
})

describe('内置命令 — /exit', () => {
  it('内置命令集含 /exit，完整名与 /exi 前缀可解析', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('exit')
    expect(resolveSlashCommand('/exit', BUILTIN_COMMAND_NAMES)?.command.name).toBe('exit')
    expect(resolveSlashCommand('/exi', BUILTIN_COMMAND_NAMES)?.command.name).toBe('exit')
  })

  it('/ex 在 exit/export 间歧义，不猜命令', () => {
    expect(resolveSlashCommand('/ex', BUILTIN_COMMAND_NAMES)).toBeNull()
    expect(resolveSlashCommand('/exp', BUILTIN_COMMAND_NAMES)?.command.name).toBe('export')
  })

  it('/exit 调用 requestExit（与 Ctrl+Q 同路径）', async () => {
    const { cmd, deps } = commandByName('exit')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.requestExit).toHaveBeenCalledTimes(1)
    expect(echo).not.toHaveBeenCalled()
  })
})

describe('内置命令 — /restart（#34）', () => {
  it('内置命令集含 /restart，完整名与 /rest 前缀可解析', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('restart')
    expect(resolveSlashCommand('/restart', BUILTIN_COMMAND_NAMES)?.command.name).toBe('restart')
    expect(resolveSlashCommand('/rest', BUILTIN_COMMAND_NAMES)?.command.name).toBe('restart')
  })

  it('/restart 调用 requestRestart（dispose + 同命令重启）', async () => {
    const { cmd, deps } = commandByName('restart')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.requestRestart).toHaveBeenCalledTimes(1)
    expect(echo).not.toHaveBeenCalled()
  })
})

describe('内置命令 — /yolo', () => {
  it('内置命令集含 /yolo', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('yolo')
  })

  it('/yolo 无参默认开启全放行（调用 setYoloMode(true)）', async () => {
    const { cmd, deps } = commandByName('yolo')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.setYoloMode).toHaveBeenCalledWith(true)
    expect(echo).toHaveBeenCalled()
  })

  it('/yolo on 开启；/yolo off 关闭', async () => {
    const { cmd, deps } = commandByName('yolo')
    await cmd.run(makeArgs({ text: 'on' }).args)
    expect(deps.setYoloMode).toHaveBeenLastCalledWith(true)
    await cmd.run(makeArgs({ text: 'off' }).args)
    expect(deps.setYoloMode).toHaveBeenLastCalledWith(false)
  })

  it('/yolo 未知参数回显用法，不调 setYoloMode', async () => {
    const { cmd, deps } = commandByName('yolo')
    const { args, echo } = makeArgs({ text: 'maybe' })
    await cmd.run(args)
    expect(deps.setYoloMode).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('用法'))
  })
})

describe('内置命令 — /cost', () => {
  it('内置命令集含 /cost', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('cost')
  })

  it('/cost 无数据 → 占位提示行（formatSessionCostReport 空桶语义）', async () => {
    const { cmd, deps } = commandByName('cost')
    deps.sessionCostReport.mockReturnValue(['会话成本统计', '（本会话尚无用量数据）'])
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('（本会话尚无用量数据）')
  })

  it('/cost 有数据 → 逐行 echo 报告', async () => {
    const { cmd, deps } = commandByName('cost')
    deps.sessionCostReport.mockReturnValue(['会话成本统计', '· deepseek-v4-flash — $0.53', '合计:输入 1.00M'])
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(echo).toHaveBeenNthCalledWith(1, '会话成本统计')
    expect(echo).toHaveBeenNthCalledWith(2, '· deepseek-v4-flash — $0.53')
    expect(echo).toHaveBeenNthCalledWith(3, '合计:输入 1.00M')
  })
})

describe('/key 与 /login（审查修复 — 命令行为）', () => {
  it('/key 无参：经 deps.openKeyDialog 打开 API Key 设置对话框', async () => {
    const { cmd, deps } = commandByName('key')
    const { args } = makeArgs()
    await cmd.run(args)
    expect(deps.openKeyDialog).toHaveBeenCalledTimes(1)
  })

  it('/login 是 /key 别名：同样经 deps.openKeyDialog', async () => {
    const { cmd, deps } = commandByName('login')
    const { args } = makeArgs()
    await cmd.run(args)
    expect(deps.openKeyDialog).toHaveBeenCalledTimes(1)
  })

  it('BUILTIN_COMMAND_NAMES 含 key 与 login（/help 列表可见）', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('key')
    expect(BUILTIN_COMMAND_NAMES).toContain('login')
  })
})

describe('/update（审查修复 — 命令行为）', () => {
  it('/update 发现新版：回显版本对 + 手动更新命令', async () => {
    const { cmd, deps } = commandByName('update')
    const { args, echo } = makeArgs()
    vi.mocked(deps.checkForUpdate).mockResolvedValue({
      kind: 'latest',
      latest: '0.1.2-rc.15',
      current: '0.1.2-rc.14',
    })
    await cmd.run(args)
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('发现新版本 0.1.2-rc.15（当前 0.1.2-rc.14）'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('@huiliyi37/dsh-tianshu-tui@latest'))
  })

  it('/update 已最新：回显当前版本', async () => {
    const { cmd, deps } = commandByName('update')
    const { args, echo } = makeArgs()
    vi.mocked(deps.checkForUpdate).mockResolvedValue({ kind: 'current', current: '0.1.2-rc.14' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('已是最新版本（0.1.2-rc.14）')
  })

  it('/update 检查失败：回显失败原因（不抛）', async () => {
    const { cmd, deps } = commandByName('update')
    const { args, echo } = makeArgs()
    vi.mocked(deps.checkForUpdate).mockResolvedValue({ kind: 'failed', error: 'registry timeout' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('⚠ 更新检查失败：registry timeout')
  })

  it('BUILTIN_COMMAND_NAMES 含 update（/help 列表可见）', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('update')
  })
})

describe('内置命令 — /help', () => {
  it('内置命令集含 /help', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('help')
  })

  it('/help 无参：打开命令面板（不再 echo 刷屏全列表）+ 提示单条详情入口', async () => {
    const { cmd, deps } = commandByName('help')
    const registry = new SlashCommandRegistry()
    for (const c of createBuiltinCommands(deps)) registry.register(c)
    vi.mocked(deps.listCommands).mockReturnValue(registry.list())
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(deps.openCommandPalette).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('命令面板已打开'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('/help <cmd> 查看单条详情'))
    // 不再逐条 echo 全命令列表（面板承担浏览/过滤）
    expect(echo).not.toHaveBeenCalledWith(expect.stringContaining('全部命令（'))
  })

  it('/help <cmd>：单条详情；未知命令回显提示', async () => {
    const { cmd, deps } = commandByName('help')
    const registry = new SlashCommandRegistry()
    for (const c of createBuiltinCommands(deps)) registry.register(c)
    vi.mocked(deps.listCommands).mockReturnValue(registry.list())
    const detail = makeArgs({ text: 'model' })
    await cmd.run(detail.args)
    expect(detail.echo).toHaveBeenCalledWith(expect.stringContaining('/model [provider/model | spark-flash | spark-pro] [effort] [default]'))
    const unknown = makeArgs({ text: 'nope' })
    await cmd.run(unknown.args)
    expect(unknown.echo).toHaveBeenCalledWith('未知命令: /nope（/help 查看全部命令）')
  })

  it('#36 回归：不访问 ctx.tui（Cordis 注入代理下属性访问抛 without inject），正常打开面板', async () => {
    const { cmd, deps } = commandByName('help')
    const registry = new SlashCommandRegistry()
    for (const c of createBuiltinCommands(deps)) registry.register(c)
    vi.mocked(deps.listCommands).mockReturnValue(registry.list())
    const { args, echo } = makeArgs() // makeCtx 无 tui 属性——模拟无 tui.commands 服务的真实环境
    await cmd.run(args)
    expect(deps.openCommandPalette).toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('命令面板已打开'))
    expect(echo).not.toHaveBeenCalledWith(expect.stringContaining('命令执行失败'))
  })
})

describe('内置命令 — /goal', () => {
  const sid = 'session-goal-1' as SessionId
  /** 带 goal 服务 + 可解析 agent 的 ctx。 */
  function goalCtx(goals: Record<string, unknown>) {
    return makeCtx({
      goals,
      agents: { get: vi.fn(() => ({ id: sid })) },
    })
  }
  const currentView = {
    id: 'goal-1',
    revision: 3,
    objective: '写周报',
    phase: 'active',
    roundsStarted: 1,
    maxGoalRounds: 256,
  }

  it('内置命令集含 /goal', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('goal')
  })

  it('/goal 无参解析透传空文本', () => {
    const parsed = resolveSlashCommand('/goal', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('goal')
    expect(parsed?.text).toBe('')
  })

  it('/goal create 透传目标文本', () => {
    const parsed = resolveSlashCommand('/goal create 写周报', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('goal')
    expect(parsed?.text).toBe('create 写周报')
  })

  it('goal 服务缺失时报不可用（fails loud，不静默）', async () => {
    const { cmd } = commandByName('goal')
    const get = vi.fn()
    // 不透传 goals → reflect.get('goals') 返回 undefined
    const bare = makeCtx({ agents: { get: vi.fn(() => ({ id: sid })) } })
    const { args, echo } = makeArgs({ text: '', ctx: bare, sessionId: sid })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('不可用'))
    expect(get).not.toHaveBeenCalled()
  })

  it('无参查看当前目标（渲染目标行）', async () => {
    const { cmd } = commandByName('goal')
    const get = vi.fn(() => currentView)
    const ctx = goalCtx({ get })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: sid })
    await cmd.run(args)
    expect(get).toHaveBeenCalledWith({ id: sid })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('写周报'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('active'))
  })

  it('无参且无当前目标时回显占位', async () => {
    const { cmd } = commandByName('goal')
    const get = vi.fn(() => undefined)
    const ctx = goalCtx({ get })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: sid })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('无目标'))
  })

  it('无当前会话时回显不可用', async () => {
    const { cmd } = commandByName('goal')
    const ctx = goalCtx({ get: vi.fn() })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: null })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('无会话'))
  })

  it('create 透传 objective 创建目标', async () => {
    const { cmd } = commandByName('goal')
    const create = vi.fn(() => ({ ...currentView, objective: '写周报', phase: 'active' }))
    const ctx = goalCtx({ create })
    const { args, echo } = makeArgs({ text: 'create 写周报', ctx, sessionId: sid })
    await cmd.run(args)
    expect(create).toHaveBeenCalledWith({ id: sid }, { objective: '写周报' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('写周报'))
  })

  it('pause|resume|complete 动词透传当前 ref', async () => {
    for (const verb of ['pause', 'resume', 'complete'] as const) {
      const { cmd } = commandByName('goal')
      const mutate = vi.fn(() => ({ ...currentView, phase: verb === 'pause' ? 'paused' : verb === 'complete' ? 'complete' : 'active' }))
      const ctx = goalCtx({ get: vi.fn(() => currentView), [verb]: mutate })
      const { args, echo } = makeArgs({ text: verb, ctx, sessionId: sid })
      await cmd.run(args)
      expect(mutate).toHaveBeenCalledWith({ id: sid }, { id: 'goal-1', revision: 3 })
      expect(echo).toHaveBeenCalledWith(expect.stringContaining('写周报'))
    }
  })

  it('block 动词透传 ref 与用户理由', async () => {
    const { cmd } = commandByName('goal')
    const block = vi.fn(() => ({ ...currentView, phase: 'blocked' }))
    const ctx = goalCtx({ get: vi.fn(() => currentView), block })
    const { args, echo } = makeArgs({ text: 'block 等依赖上线', ctx, sessionId: sid })
    await cmd.run(args)
    expect(block).toHaveBeenCalledWith({ id: sid }, { id: 'goal-1', revision: 3 }, {
      code: 'user-requested',
      message: '等依赖上线',
    })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('写周报'))
  })

  it('未知子动词回显用法', async () => {
    const { cmd } = commandByName('goal')
    const ctx = goalCtx({ get: vi.fn() })
    const { args, echo } = makeArgs({ text: 'fork', ctx, sessionId: sid })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('/goal'))
  })
})

describe('内置命令 — /status', () => {
  it('内置命令集含 /status', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('status')
  })

  it('/status 解析透传（无参）', () => {
    const parsed = resolveSlashCommand('/status', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('status')
    expect(parsed?.text).toBe('')
  })

  it('/status 参数透传', () => {
    const parsed = resolveSlashCommand('/status on', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('status')
    expect(parsed?.text).toBe('on')
  })
})

describe('内置命令 — /tasks（T2.3 后台任务区 + task kill）', () => {
  it('内置命令集含 /tasks', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('tasks')
  })

  it('/tasks 无参切换任务窗格（deps.toggleTaskPanel）', async () => {
    const { cmd, deps } = commandByName('tasks')
    const { args } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(deps.toggleTaskPanel).toHaveBeenCalledTimes(1)
  })

  it('kill <id> 透传 ctx.tasks.kill 并回显', async () => {
    const { cmd } = commandByName('tasks')
    const kill = vi.fn(() => 'requested')
    const ctx = makeCtx({ tasks: { kill, list: vi.fn(), onTaskDone: vi.fn(), attachSurface: vi.fn() } })
    const { args, echo } = makeArgs({ text: 'kill bash-3', ctx, sessionId: 'session-t-1' as SessionId })
    await cmd.run(args)
    expect(kill).toHaveBeenCalledWith('bash-3')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('bash-3'))
  })

  it('kill 已结束任务回显 already-finished', async () => {
    const { cmd } = commandByName('tasks')
    const kill = vi.fn(() => 'already-finished')
    const ctx = makeCtx({ tasks: { kill, list: vi.fn(), onTaskDone: vi.fn(), attachSurface: vi.fn() } })
    const { args, echo } = makeArgs({ text: 'kill bash-9', ctx, sessionId: 'session-t-1' as SessionId })
    await cmd.run(args)
    expect(kill).toHaveBeenCalledWith('bash-9')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已结束'))
  })

  it('kill 缺 id 回显用法', async () => {
    const { cmd } = commandByName('tasks')
    const kill = vi.fn()
    const ctx = makeCtx({ tasks: { kill, list: vi.fn(), onTaskDone: vi.fn(), attachSurface: vi.fn() } })
    const { args, echo } = makeArgs({ text: 'kill', ctx, sessionId: 'session-t-1' as SessionId })
    await cmd.run(args)
    expect(kill).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('/tasks kill'))
  })

  it('tasks 服务缺失时 kill 报不可用（fails loud）', async () => {
    const { cmd } = commandByName('tasks')
    const { args, echo } = makeArgs({ text: 'kill bash-3', sessionId: 'session-t-1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('不可用'))
  })

  it('未知子动词回显用法', async () => {
    const { cmd } = commandByName('tasks')
    const { args, echo } = makeArgs({ text: 'ls', sessionId: 'session-t-1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('/tasks'))
  })
})

describe('内置命令 — /subagents（T2.1 委派树面板）', () => {
  it('内置命令集含 /subagents', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('subagents')
  })

  it('/subagents 无参切换委派树面板（deps.toggleSubagentsPanel）', async () => {
    const { cmd, deps } = commandByName('subagents')
    const { args } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(deps.toggleSubagentsPanel).toHaveBeenCalledTimes(1)
  })
})

describe('内置命令 — /workflow（T2.2 运行中缓存面板）', () => {
  it('内置命令集含 /workflow', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('workflow')
  })

  it('/workflow 无参切换面板（deps.toggleWorkflowPanel）', async () => {
    const { cmd, deps } = commandByName('workflow')
    const { args } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(deps.toggleWorkflowPanel).toHaveBeenCalledTimes(1)
  })
})

describe('最小唯一前缀 — /subagents /workflow 不破坏既有命令', () => {
  it('/sub → subagents；/work → workflow', () => {
    expect(resolveSlashCommand('/sub', BUILTIN_COMMAND_NAMES)?.command.name).toBe('subagents')
    expect(resolveSlashCommand('/work', BUILTIN_COMMAND_NAMES)?.command.name).toBe('workflow')
  })

  it('既有命令前缀不回归（/status /steer /session /tasks）', () => {
    expect(resolveSlashCommand('/status', BUILTIN_COMMAND_NAMES)?.command.name).toBe('status')
    expect(resolveSlashCommand('/ste 收敛', BUILTIN_COMMAND_NAMES)?.command.name).toBe('steer')
    expect(resolveSlashCommand('/session', BUILTIN_COMMAND_NAMES)?.command.name).toBe('session')
    expect(resolveSlashCommand('/tasks', BUILTIN_COMMAND_NAMES)?.command.name).toBe('tasks')
  })

  it('/s 仍歧义（session/steer/status/subagents 共前缀）', () => {
    expect(resolveSlashCommand('/s', BUILTIN_COMMAND_NAMES)).toBeNull()
  })

  it('/t 仍歧义（theme/tasks 共前缀）；/task 唯一命中 tasks', () => {
    expect(resolveSlashCommand('/t', BUILTIN_COMMAND_NAMES)).toBeNull()
    expect(resolveSlashCommand('/task', BUILTIN_COMMAND_NAMES)?.command.name).toBe('tasks')
  })
})

describe('内置命令 — /compact 边界分支', () => {
  it('compact 服务存在但无会话时回显无会话', async () => {
    const { cmd } = commandByName('compact')
    const compactIfNeeded = vi.fn(async () => null)
    const ctx = makeCtx({ compact: { compactIfNeeded } })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: null })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前无会话'))
    expect(compactIfNeeded).not.toHaveBeenCalled()
  })

  it('compact 服务存在、会话 id 给定但会话不存在时回显', async () => {
    const { cmd } = commandByName('compact')
    const compactIfNeeded = vi.fn(async () => null)
    const ctx = makeCtx({
      compact: { compactIfNeeded },
      sessions: { get: vi.fn(() => undefined) },
    })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: 'session-missing' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('会话不存在'))
    expect(compactIfNeeded).not.toHaveBeenCalled()
  })

  it('compact 服务存在、会话存在但 result 非 null 时回显压缩完成', async () => {
    const { cmd } = commandByName('compact')
    const compactIfNeeded = vi.fn(async () => ({ ok: true }))
    const ctx = makeCtx({
      compact: { compactIfNeeded },
      sessions: { get: vi.fn(() => ({ id: 'session-c1', header: {} })) },
      agents: { get: vi.fn(() => ({ options: {} })) },
    })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: 'session-c1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('压缩完成'))
  })
})

describe('内置命令 — /goal 分支', () => {
  it('goal 服务未加载时回显不可用', async () => {
    const { cmd } = commandByName('goal')
    const { args, echo } = makeArgs({ text: 'create x' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('goal 服务不可用'))
  })

  it('goal 服务存在但无会话时回显无会话', async () => {
    const { cmd } = commandByName('goal')
    const goals = {
      get: vi.fn(() => undefined),
      create: vi.fn(() => ({ objective: 'x', phase: 'active' })),
      pause: vi.fn(() => ({ objective: 'x' })),
      resume: vi.fn(() => ({ objective: 'x', phase: 'active' })),
      complete: vi.fn(() => ({ objective: 'x' })),
      block: vi.fn(() => ({ objective: 'x' })),
    }
    const ctx = makeCtx({ goals })
    const { args, echo } = makeArgs({ text: 'create x', ctx, sessionId: null })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前无会话'))
  })

  it('goal 服务存在、有会话但 agent 缺失时回显会话不存在', async () => {
    const { cmd } = commandByName('goal')
    const goals = { get: vi.fn(() => undefined), create: vi.fn() }
    const ctx = makeCtx({ goals })
    const { args, echo } = makeArgs({ text: 'create x', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('会话不存在'))
  })

  it('无参且无当前目标时回显占位', async () => {
    const { cmd } = commandByName('goal')
    const goals = { get: vi.fn(() => undefined) }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    const { args, echo } = makeArgs({ text: '', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前无目标'))
  })

  it('create 缺 objective 回显用法', async () => {
    const { cmd } = commandByName('goal')
    const goals = { get: vi.fn(() => undefined), create: vi.fn() }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    const { args, echo } = makeArgs({ text: 'create', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('用法: /goal create'))
  })

  it('create 有 objective 时创建并回显', async () => {
    const { cmd } = commandByName('goal')
    const goals = {
      get: vi.fn(() => undefined),
      create: vi.fn(() => ({ objective: '目标X', phase: 'active' })),
    }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    const { args, echo } = makeArgs({ text: 'create 目标X', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(goals.create).toHaveBeenCalledWith({}, { objective: '目标X' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('目标已创建'))
  })

  it('未知动词回显用法', async () => {
    const { cmd } = commandByName('goal')
    const goals = { get: vi.fn(() => undefined) }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    const { args, echo } = makeArgs({ text: 'unknown', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('用法: /goal'))
  })

  it('mutation 无当前目标时回显占位', async () => {
    const { cmd } = commandByName('goal')
    const goals = { get: vi.fn(() => undefined) }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    const { args, echo } = makeArgs({ text: 'pause', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前无目标，无法执行该操作'))
  })

  it('pause/resume/complete/block 各回显对应文案', async () => {
    const current = { id: 'goal-1', revision: 1, objective: '目标Y', phase: 'active' }
    const goals = {
      get: vi.fn(() => current),
      pause: vi.fn(() => ({ objective: '目标Y' })),
      resume: vi.fn(() => ({ objective: '目标Y', phase: 'active' })),
      complete: vi.fn(() => ({ objective: '目标Y' })),
      block: vi.fn(() => ({ objective: '目标Y' })),
    }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    for (const [verb, expected] of [
      ['pause', '目标已暂停'],
      ['resume', '目标已恢复'],
      ['complete', '目标已完成'],
      ['block', '目标已阻塞'],
    ] as const) {
      const { cmd } = commandByName('goal')
      const { args, echo } = makeArgs({ text: verb, ctx, sessionId: 'session-g1' as SessionId })
      await cmd.run(args)
      expect(echo).toHaveBeenCalledWith(expect.stringContaining(expected))
    }
  })

  it('block 带 message 时透传 message', async () => {
    const current = { id: 'goal-1', revision: 1, objective: '目标Z', phase: 'active' }
    const goals = {
      get: vi.fn(() => current),
      block: vi.fn(() => ({ objective: '目标Z' })),
    }
    const ctx = makeCtx({ goals, agents: { get: vi.fn(() => ({})) } })
    const { cmd } = commandByName('goal')
    const { args, echo } = makeArgs({ text: 'block 因为依赖缺失', ctx, sessionId: 'session-g1' as SessionId })
    await cmd.run(args)
    expect(goals.block).toHaveBeenCalledWith({}, { id: 'goal-1', revision: 1 }, { code: 'user-requested', message: '因为依赖缺失' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('目标已阻塞'))
  })
})

describe('内置命令 — /tasks 边界分支', () => {
  it('kill 无 id 回显用法', async () => {
    const { cmd } = commandByName('tasks')
    const tasks = { kill: vi.fn() }
    const ctx = makeCtx({ tasks })
    const { args, echo } = makeArgs({ text: 'kill', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('用法: /tasks kill <id>'))
    expect(tasks.kill).not.toHaveBeenCalled()
  })

  it('kill 有 id 但 tasks 服务不可用时回显', async () => {
    const { cmd } = commandByName('tasks')
    const { args, echo } = makeArgs({ text: 'kill task-1' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('tasks 服务不可用'))
  })

  it('kill 有 id 且已结束时回显已结束', async () => {
    const { cmd } = commandByName('tasks')
    const tasks = { kill: vi.fn(() => 'already-finished') }
    const ctx = makeCtx({ tasks })
    const { args, echo } = makeArgs({ text: 'kill task-1', ctx })
    await cmd.run(args)
    expect(tasks.kill).toHaveBeenCalledWith('task-1')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('任务已结束'))
  })
})

describe('/doctor 终端诊断命令', () => {
  it('fix <id> 有效：回显修复指引', async () => {
    const { cmd } = commandByName('doctor')
    const { args, echo } = makeArgs({ text: 'fix 1' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('[1] tmux 剪贴板配置'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('set-clipboard on'))
  })

  it('fix <id> 未知 id：回显未知修复项', async () => {
    const { cmd } = commandByName('doctor')
    const { args, echo } = makeArgs({ text: 'fix 99' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('未知修复项: 99')
  })

  it('fix 缺 id 或非数字：回显用法', async () => {
    const { cmd } = commandByName('doctor')
    for (const text of ['fix', 'fix abc']) {
      const { args, echo } = makeArgs({ text })
      await cmd.run(args)
      expect(echo).toHaveBeenCalledWith('用法: /doctor fix <id>')
    }
  })

  it('未知子命令：回显用法', async () => {
    const { cmd } = commandByName('doctor')
    const { args, echo } = makeArgs({ text: 'frobnicate' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('用法: /doctor [fix <id>]')
  })

  it('无参：渲染诊断报告（尺寸/背景行）', async () => {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true })
    vi.stubEnv('COLORFGBG', '15;0')
    const { cmd } = commandByName('doctor')
    const { args, echo } = makeArgs()
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('终端诊断报告:')
    const lines = echo.mock.calls.map(c => String(c[0]))
    expect(lines.some(l => l.includes('终端尺寸: 120×40'))).toBe(true)
    expect(lines.some(l => l.includes('终端背景: 已检测'))).toBe(true)
    vi.unstubAllEnvs()
  })
})

describe('/mcp MCP 状态命令', () => {
  function mockMcpTable(table: Map<string, { serverName: string; getToolCount(): number; listToolNames(): string[] }> | undefined) {
    const ctx = makeCtx()
    ;(ctx.reflect.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(table)
    return ctx
  }

  it('未装配（mcp.status undefined）→ 回显不可用', async () => {
    const { cmd } = commandByName('mcp')
    const { args, echo } = makeArgs({ ctx: mockMcpTable(undefined) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('⚠ 无 MCP server 连接（检查 cordis.yml 中 mcp-client 插件配置）')
  })

  it('空表 → 回显不可用', async () => {
    const { cmd } = commandByName('mcp')
    const { args, echo } = makeArgs({ ctx: mockMcpTable(new Map()) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('⚠ 无 MCP server 连接（检查 cordis.yml 中 mcp-client 插件配置）')
  })

  it('有 server：按名列出工具数', async () => {
    const table = new Map([
      ['fs', { serverName: 'fs', getToolCount: () => 2, listToolNames: () => ['read', 'write'] }],
      ['github', { serverName: 'github', getToolCount: () => 3, listToolNames: () => ['a', 'b', 'c'] }],
    ])
    const { cmd } = commandByName('mcp')
    const { args, echo } = makeArgs({ ctx: mockMcpTable(table) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('MCP servers (2):')
    expect(echo).toHaveBeenCalledWith('  fs: 2 工具')
    expect(echo).toHaveBeenCalledWith('  github: 3 工具')
  })

  it('tools <server>：列出工具名（排序）', async () => {
    const table = new Map([
      ['fs', { serverName: 'fs', getToolCount: () => 2, listToolNames: () => ['write', 'read'] }],
    ])
    const { cmd } = commandByName('mcp')
    const { args, echo } = makeArgs({ text: 'tools fs', ctx: mockMcpTable(table) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('fs (2 工具):')
    expect(echo).toHaveBeenCalledWith('  read')
    expect(echo).toHaveBeenCalledWith('  write')
  })

  it('tools 未知 server：回显可用列表', async () => {
    const table = new Map([
      ['fs', { serverName: 'fs', getToolCount: () => 0, listToolNames: () => [] }],
    ])
    const { cmd } = commandByName('mcp')
    const { args, echo } = makeArgs({ text: 'tools nope', ctx: mockMcpTable(table) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('未知 MCP server: nope。可用: fs')
  })

  it('tools 缺 server 名：回显用法', async () => {
    const table = new Map([
      ['fs', { serverName: 'fs', getToolCount: () => 0, listToolNames: () => [] }],
    ])
    const { cmd } = commandByName('mcp')
    const { args, echo } = makeArgs({ text: 'tools', ctx: mockMcpTable(table) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('用法: /mcp tools <server>')
  })
})

describe('内置命令 — /effort', () => {
  const effortByName = () => commandByName('effort')

  function effortCtx(overrides: { current?: { provider: string; model: string; reasoningEffort?: string } } = {}) {
    const saveSelection = vi.fn(async (_selection: Record<string, unknown>) => {})
    const ctx = makeCtx({
      agentDefaultModel: {
        currentSelection: vi.fn(() => overrides.current ?? { provider: 'deepseek', model: 'v4-flash' }),
        saveSelection,
      },
    })
    return { saveSelection, ctx }
  }

  it('/effort max 仅本会话热切，不写默认', async () => {
    const { cmd, deps } = effortByName()
    const { saveSelection, ctx } = effortCtx()
    const { args, echo } = makeArgs({ text: 'max', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'max' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))
  })

  it('/effort max default 才 saveSelection', async () => {
    const { cmd, deps } = effortByName()
    const { saveSelection, ctx } = effortCtx()
    const { args, echo } = makeArgs({ text: 'max default', ctx })
    await cmd.run(args)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'max' })
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'max' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认推理等级：max'))
  })

  it('/effort auto 仅本会话清除 effort', async () => {
    const { cmd, deps } = effortByName()
    const { saveSelection, ctx } = effortCtx({ current: { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' } })
    const { args, echo } = makeArgs({ text: 'auto', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(deps.switchLiveModel).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))
  })

  it('/effort default 保存当前档为启动默认（≠ /effort auto）', async () => {
    const { cmd, deps } = effortByName()
    const { saveSelection, ctx } = effortCtx({ current: { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' } })
    const { args, echo } = makeArgs({ text: 'default', ctx })
    await cmd.run(args)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' })
    expect(deps.switchLiveModel).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认推理等级：high'))
  })

  it('/effort 在 registry 兜底会话（不可热切）：仅本会话回显不可热切', async () => {
    const deps = {
      newSession: vi.fn(),
      forkSession: vi.fn(),
      switchLiveModel: vi.fn(() => false),
      clearScrollback: vi.fn(),
      toggleTaskPanel: vi.fn(),
      toggleSubagentsPanel: vi.fn(),
      toggleWorkflowPanel: vi.fn(),
      rewindSession: vi.fn(() => true),
      askBtw: vi.fn(async () => true),
      openMemoryBrowser: vi.fn(async () => true),
      openScrollPager: vi.fn(),
      switchSession: vi.fn(async () => undefined),
      exportTranscript: vi.fn(async (path?: string) => path ?? '/tmp/dsh-export-s1.md'),
      requestExit: vi.fn(),
    requestRestart: vi.fn(),
    listCommands: vi.fn<() => SlashCommand[]>(() => []),
      currentAgent: vi.fn(() => null),
      isBlankSession: vi.fn(() => true),
      setYoloMode: vi.fn(),
      openModelPicker: vi.fn(),
      openThemePicker: vi.fn(),
      openEffortPicker: vi.fn(),
      onThemeApplied: vi.fn(),
      applyThemeAuto: vi.fn(),
      exportTheme: vi.fn((): string => 'exported'),
      persistPresetDefault: vi.fn(),
      currentDefaultPreset: vi.fn(() => undefined),
      openSessionPicker: vi.fn(),
    openKeyDialog: vi.fn(),
    checkForUpdate: vi.fn(),
      openCommandPalette: vi.fn(),
      sessionCostReport: vi.fn<() => string[]>(() => []),
    }
    const cmd = createBuiltinCommands(deps).find(c => c.name === 'effort')
    if (cmd === undefined) throw new Error('builtin command not found: effort')
    const { saveSelection, ctx } = effortCtx()
    const { args, echo } = makeArgs({ text: 'high', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前会话不可热切'))
  })

  it('/effort 无参打开推理等级选择器', async () => {
    const { cmd, deps } = effortByName()
    const { ctx } = effortCtx({ current: { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' } })
    const { args, echo } = makeArgs({ text: '', ctx })
    await cmd.run(args)
    expect(deps.openEffortPicker).toHaveBeenCalled()
    expect(echo).not.toHaveBeenCalled()
  })

  it('/effort 非法值：报错且不调用 saveSelection / switchLiveModel', async () => {
    const { cmd, deps } = effortByName()
    const { saveSelection, ctx } = effortCtx()
    const { args, echo } = makeArgs({ text: 'turbo', ctx })
    await cmd.run(args)
    expect(saveSelection).not.toHaveBeenCalled()
    expect(deps.switchLiveModel).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('turbo'))
  })

  it('内置命令集含 /effort', () => {
    const { cmd } = effortByName()
    expect(cmd.name).toBe('effort')
  })
})

describe('内置命令 — /preset（agent 预设模式切换）', () => {
  const presetByName = () => commandByName('preset')

  /** 带 agentPresets 服务的 ctx（makeCtx overrides + reflect 注入，/model 同机制）。 */
  function presetCtx() {
    const presets = {
      list: vi.fn<() => Promise<Array<{ id: string; name?: string; description?: string }>>>(async () => []),
      composedPreset: vi.fn<() => string | undefined>(() => undefined),
      recompose: vi.fn<() => Promise<{ id: string; name?: string }>>(async () => ({ id: 'minimal' })),
    }
    const ctx = makeCtx({ agentPresets: presets })
    return { presets, ctx }
  }

  /** 当前会话 agent 替身（recompose 的 agentCtx + append 落日志）。 */
  function makeAgent(): Agent {
    const append = vi.fn()
    return { ctx: {}, session: { append, events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] } } } as unknown as Agent
  }

  it('内置命令集含 /preset 且无前缀冲突', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('preset')
    const parsed = resolveSlashCommand('/preset', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('preset')
    expect(resolveSlashCommand('/p', BUILTIN_COMMAND_NAMES)?.command.name).toBe('preset')
  })

  it('#47 /presets 不是 /preset：token 更长，前缀解析不命中', () => {
    expect(resolveSlashCommand('/presets', BUILTIN_COMMAND_NAMES)).toBeNull()
    expect(BUILTIN_COMMAND_NAMES).not.toContain('presets')
  })

  it('无参：列出全部预设并标记当前项', async () => {
    const { cmd, deps } = presetByName()
    const { presets, ctx } = presetCtx()
    presets.list.mockResolvedValue([
      { id: 'standard', name: '标准模式', description: '功能完整' },
      { id: 'minimal', name: '极简模式', description: '双工具' },
      { id: 'cordis', name: '创造模式', description: '创作预设' },
    ])
    presets.composedPreset.mockReturnValue('minimal')
    const agent = makeAgent()
    deps.currentAgent.mockReturnValue(agent)
    const { args, echo } = makeArgs({ text: '', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('agent 预设'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('标准模式'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('极简模式'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('创造模式'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前: minimal · 极简'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('工具: bash · str_replace_editor'))
    // 当前项带星标：极简行以 * 开头
    const starred = echo.mock.calls.map(c => String(c[0])).find(l => l.includes('极简模式'))
    expect(starred?.startsWith(' *')).toBe(true)
  })

  it('无参且无当前 agent：回显未装配默认', async () => {
    const { cmd } = presetByName()
    const { presets, ctx } = presetCtx()
    presets.list.mockResolvedValue([{ id: 'standard', name: '标准模式' }])
    const { args, echo } = makeArgs({ text: '', ctx })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('当前: 未装配'))
  })

  it('切换成功：recompose 成功后 append 落日志并回显', async () => {
    const { cmd, deps } = presetByName()
    const { presets, ctx } = presetCtx()
    presets.recompose.mockResolvedValue({ id: 'minimal', name: '极简模式' })
    const agent = makeAgent()
    deps.currentAgent.mockReturnValue(agent)
    deps.isBlankSession.mockReturnValue(true)
    const { args, echo } = makeArgs({ text: 'minimal', ctx })
    await cmd.run(args)
    expect(presets.recompose).toHaveBeenCalledWith(agent.ctx, 'minimal')
    const append = agent.session.append as unknown as ReturnType<typeof vi.fn>
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0]![0]).toBe('agent-preset/selected')
    expect(append.mock.calls[0]![1]).toEqual({ agentPreset: 'minimal' })
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))
    expect(deps.persistPresetDefault).not.toHaveBeenCalled()
  })

  it('/preset minimal default 切换并写启动默认', async () => {
    const { cmd, deps } = presetByName()
    const { presets, ctx } = presetCtx()
    presets.recompose.mockResolvedValue({ id: 'minimal', name: '极简模式' })
    const agent = makeAgent()
    deps.currentAgent.mockReturnValue(agent)
    deps.isBlankSession.mockReturnValue(true)
    const { args, echo } = makeArgs({ text: 'minimal default', ctx })
    await cmd.run(args)
    expect(presets.recompose).toHaveBeenCalledWith(agent.ctx, 'minimal')
    expect(deps.persistPresetDefault).toHaveBeenCalledWith('minimal')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已设为默认预设'))
  })

  it('/preset code 折到官方 id ptc（rc.1 起 Code Mode 更名 PTC）', async () => {
    const { cmd, deps } = presetByName()
    const { presets, ctx } = presetCtx()
    presets.list.mockResolvedValue([{ id: 'ptc', name: 'PTC 模式' }])
    presets.recompose.mockResolvedValue({ id: 'ptc', name: 'PTC 模式' })
    const agent = makeAgent()
    deps.currentAgent.mockReturnValue(agent)
    deps.isBlankSession.mockReturnValue(true)
    const { args } = makeArgs({ text: 'code', ctx })
    await cmd.run(args)
    expect(presets.recompose).toHaveBeenCalledWith(agent.ctx, 'ptc')
  })

  it('非 blank 会话拒绝切换：不调 recompose / append', async () => {
    const { cmd, deps } = presetByName()
    const { presets, ctx } = presetCtx()
    const agent = makeAgent()
    deps.currentAgent.mockReturnValue(agent)
    deps.isBlankSession.mockReturnValue(false)
    const { args, echo } = makeArgs({ text: 'minimal', ctx })
    await cmd.run(args)
    expect(presets.recompose).not.toHaveBeenCalled()
    const append = agent.session.append as unknown as ReturnType<typeof vi.fn>
    expect(append).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('空白会话'))
  })

  it('无当前会话时拒绝切换', async () => {
    const { cmd } = presetByName()
    const { presets, ctx } = presetCtx()
    const { args, echo } = makeArgs({ text: 'minimal', ctx })
    await cmd.run(args)
    expect(presets.recompose).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('无会话'))
  })

  it('agent-presets 服务缺失时回显不可用（fails loud）', async () => {
    const { cmd } = presetByName()
    const { args, echo } = makeArgs({ text: '' })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('不可用'))
  })

  it('recompose 失败（未知预设/损坏组成）：回显错误且不 append', async () => {
    const { cmd, deps } = presetByName()
    const { presets, ctx } = presetCtx()
    presets.recompose.mockRejectedValue(new Error('UnknownPresetError: no-such'))
    const agent = makeAgent()
    deps.currentAgent.mockReturnValue(agent)
    deps.isBlankSession.mockReturnValue(true)
    const { args, echo } = makeArgs({ text: 'no-such', ctx })
    await cmd.run(args)
    const append = agent.session.append as unknown as ReturnType<typeof vi.fn>
    expect(append).not.toHaveBeenCalled()
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('切换失败'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('no-such'))
  })
})

describe('内置命令 — /todos', () => {
  it('内置命令集含 /todos（TuiApp 内注册：无参显隐 + all 明细展开）', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('todos')
  })

  it('/tod 唯一命中 todos；/t 因 theme/tasks/todos 同前缀而歧义', () => {
    // /t 同时命中 theme/tasks/todos → 歧义拒绝；/tod 才是 todos 的最小唯一前缀。
    expect(resolveSlashCommand('/t', BUILTIN_COMMAND_NAMES)).toBeNull()
    const parsed = resolveSlashCommand('/tod all', BUILTIN_COMMAND_NAMES)
    expect(parsed?.command.name).toBe('todos')
    expect(parsed?.text).toBe('all')
  })
})

describe('/preset（agent-presets 可选服务降级 + 切换链路）', () => {
  const facet = {
    list: vi.fn(async () => [
      { id: 'standard', name: '标准', description: '默认工具面' },
      { id: 'ptc', name: 'PTC' },
    ]),
    composedPreset: vi.fn(() => 'standard'),
    recompose: vi.fn(async (_agentCtx: unknown, id: string) => ({ id, name: 'PTC' })),
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('服务未装配（reflect 无 agentPresets）→ 优雅提示，不抛', async () => {
    const { cmd } = commandByName('preset')
    const { args, echo } = makeArgs() // 默认 makeCtx：reflect.get 返回 undefined
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('⚠ agent-presets 服务不可用（host 未装配 agent 预设）')
  })

  it('服务在场 + 无参 → 列出预设与当前态（无会话时当前行未装配）', async () => {
    const { cmd } = commandByName('preset')
    const { args, echo } = makeArgs({ ctx: makeCtx({ agentPresets: facet }) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('agent 预设 (2):')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('标准 (standard)'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('默认工具面'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('PTC (ptc)'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('工具:'))
    expect(echo).toHaveBeenCalledWith('当前: 未装配（host 默认）')
  })

  it('有参 + 无会话 → 无法切换', async () => {
    const { cmd } = commandByName('preset')
    const { args, echo } = makeArgs({ text: 'ptc', ctx: makeCtx({ agentPresets: facet }) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('当前无会话，无法切换预设')
    expect(facet.recompose).not.toHaveBeenCalled()
  })

  it('有参 + 会话非空白 → 拒绝切换（官方 recompose 契约）', async () => {
    const { cmd, deps } = commandByName('preset')
    vi.mocked(deps.currentAgent).mockReturnValue({ ctx: {} } as unknown as Agent)
    vi.mocked(deps.isBlankSession).mockReturnValue(false)
    const { args, echo } = makeArgs({ text: 'ptc', ctx: makeCtx({ agentPresets: facet }) })
    await cmd.run(args)
    expect(echo).toHaveBeenCalledWith('⚠ 会话已产生内容，无法切换预设（仅空白会话可换；新会话默认仍用当前预设）')
    expect(facet.recompose).not.toHaveBeenCalled()
  })

  it('有参 + 空白会话 → recompose 成功回显；recompose 失败回显原因', async () => {
    const { cmd, deps } = commandByName('preset')
    vi.mocked(deps.currentAgent).mockReturnValue({ ctx: {}, session: { append: vi.fn() } } as unknown as Agent)
    vi.mocked(deps.isBlankSession).mockReturnValue(true)
    const { args, echo } = makeArgs({ text: 'ptc', ctx: makeCtx({ agentPresets: facet }) })
    await cmd.run(args)
    expect(facet.recompose).toHaveBeenCalledWith({}, 'ptc')
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('已切换为 PTC (ptc)'))
    expect(echo).toHaveBeenCalledWith(expect.stringContaining('仅本会话'))

    // 失败路径：recompose 抛错 → 回显原因，不留切换痕迹
    const failing = { ...facet, recompose: vi.fn(async () => { throw new Error('compose rejected') }) }
    const { args: args2, echo: echo2 } = makeArgs({ text: 'ptc', ctx: makeCtx({ agentPresets: failing }) })
    await cmd.run(args2)
    expect(echo2).toHaveBeenCalledWith('切换失败: compose rejected')
  })
})

describe('suggestCommands — 未知命令相近建议（闭环引导）', () => {
  const ALL: readonly SlashCommand[] = [
    { name: 'theme', description: '', run: vi.fn() },
    { name: 'status', description: '', run: vi.fn() },
    { name: 'steer', description: '', run: vi.fn() },
    { name: 'glance', description: '', run: vi.fn() },
    { name: 'session', description: '', run: vi.fn() },
    { name: 'density', description: '', run: vi.fn() },
    { name: 'help', description: '', run: vi.fn() },
  ]

  it('编辑距离命中笔误（/glans → glance）', () => {
    const hits = suggestCommands('/glans', ALL)
    expect(hits.map(c => c.name)).toContain('glance')
    expect(hits[0]!.name).toBe('glance')
  })

  it('公共前缀命中歧义缩写（/st → status/steer 并列建议）', () => {
    const hits = suggestCommands('/st', ALL)
    const names = hits.map(c => c.name)
    expect(names).toContain('status')
    expect(names).toContain('steer')
  })

  it('单字符/空输入无建议（不猜命令）', () => {
    expect(suggestCommands('/t', ALL)).toEqual([])
    expect(suggestCommands('/', ALL)).toEqual([])
    expect(suggestCommands('/  ', ALL)).toEqual([])
  })

  it('limit 截断与顺序稳定（距离升序、短名优先）', () => {
    const hits = suggestCommands('/st', ALL, 1)
    expect(hits).toHaveLength(1)
  })

  it('大小写不敏感且忽略 / 前缀', () => {
    const hits = suggestCommands('GLANCE', ALL)
    expect(hits[0]?.name).toBe('glance')
  })

  it('完全无关输入返回空（引导 /help）', () => {
    expect(suggestCommands('/zzz', ALL)).toEqual([])
  })
})
