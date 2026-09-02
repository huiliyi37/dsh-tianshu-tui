/**
 * Phase 6.1 Slash 命令系统 — Cordis 服务式命令注册表与内置命令。
 *
 * 职责划分：
 * - `resolveSlashCommand`：纯函数最小唯一前缀解析（/ 前缀检测、歧义/未知 → null）。
 * - `SlashCommandRegistry`：实例化命令注册表（register/list/get/unregister/resolve/hint），
 *   由 TuiApp 持有（this.slash）；/help 经 BuiltinCommandDeps.listCommands 注入取用。
 *   （头注释曾写「经 ctx.provide('tui.commands') 暴露」——该 provide 从未实现，
 *   外部插件扩展命令的通道是设计意图，未落地；直接访问 ctx.tui 会触发 Cordis
 *   注入代理 "without inject" 抛错，见 #36。）
 * - `createBuiltinCommands`：内置命令工厂（/theme /session /clear /compact；/steer 由
 *   TuiApp 直接复用既有入口，注册表只保留其名字参与前缀解析与提示）。
 *
 * dsh 纪律：命令执行只改 UI 状态（主题/滚动区/会话切换）或调用既有服务，不写回 session
 * log、不发明事件类型。命令文本经 `/` 前缀在输入层分流，未知命令回显提示而非提交给 agent。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

// agent-preset/selected 事件由 host 的 dsh-agent-presets 声明扩展（官方同款
// declare module）；插件本地声明同型合并——host 包进入依赖后 interface 合并
// 且属性类型一致（{ agentPreset: string }），无冲突。此扩展使
// Session.append('agent-preset/selected', ...) 获得完整类型检查。
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-preset/selected': { agentPreset: string }
  }
}
import { getActiveThemeName } from '../theme.js'
import { serviceForAgent } from '../adapter/agent-scope-service.js'
import { listSessions, loadHistory } from '../adapter/sessions.js'
import { sessionTitleFor } from '../adapter/session-title.js'
import { formatSessionListLines } from '../restore-session.js'
import { collectDoctorReport, getDoctorFixGuidance } from '../format/doctor-report.js'
import { TUI_PACKAGE, type UpdateCheckResult } from '../self-update.js'
import {
  createEffortCommand,
  createModelCommand,
  createPresetCommand,
  createThemeCommand,
  type StartupCommandDeps,
} from './startup-commands.js'

/**
 * Slash 命令执行上下文——TuiApp 在分发时注入。
 */
export interface SlashCommandArgs {
  /** 参数文本（命令名后已 trim；无参数为空串）。 */
  text: string
  /** 服务上下文（提供方 ctx）。 */
  ctx: Context
  /** 当前会话 id；尚未 attach 时为 null。 */
  sessionId: SessionId | null
  /** 回显一行命令结果到 scrollback。 */
  echo: (text: string) => void
  /** 请求重绘 live 区（命令执行后统一调用）。 */
  rerender: () => void
}

/** 内置命令分组（命令面板展示组名；未标注的命令归「其他」）。 */
export type SlashCommandCategory = '会话' | '配置' | '认证' | '面板' | '系统'

/** 一条 slash 命令。 */
export interface SlashCommand {
  /** 命令名（不含 / 前缀；小写，互不为前缀歧义时才能唯一解析）。 */
  name: string
  /** 命令面板/提示展示描述。 */
  description: string
  /** 可选参数 ghost 提示（如 `<name>`）。 */
  argsHint?: string
  /** 命令面板分组（数据源单一事实：注册时携带；缺省归「其他」）。 */
  category?: SlashCommandCategory
  /** 执行命令。可 async；抛错由分发层捕获并回显失败信息。 */
  run(args: SlashCommandArgs): void | Promise<void>
}

/** 解析结果：命中的命令与剥离后的参数文本。 */
export interface SlashParse {
  command: SlashCommand
  text: string
}

/** /compact 所需的最小 compact 服务面（不引入 dsh-compact 依赖）。 */
interface CompactFacet {
  compactIfNeeded(
    agent: { session: { id: SessionId }; options: { provider?: string; model?: string } },
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ): Promise<unknown>
}

/** /model 所需的最小 agent-default-model 服务面（不引入 dsh-agent-default-model 依赖）。 */
export interface ModelFacet {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

/** /goal 所需的最小目标 ref（CAS 身份，取自当前 view）。 */
interface GoalRefFacet {
  readonly id: string
  readonly revision: number
}

/** /goal 所需的最小目标 view（get/create/动词的返回面）。 */
interface GoalViewFacet extends GoalRefFacet {
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly roundsStarted: number
  readonly maxGoalRounds: number
}

/** /goal 所需的最小 goal 服务面（不引入 dsh-goal 依赖）。 */
interface GoalFacet {
  get(agent: unknown): GoalViewFacet | undefined
  create(agent: unknown, request: { objective: string }): GoalViewFacet
  pause(agent: unknown, ref: GoalRefFacet): GoalViewFacet
  resume(agent: unknown, ref: GoalRefFacet): GoalViewFacet
  complete(agent: unknown, ref: GoalRefFacet): GoalViewFacet
  block(agent: unknown, ref: GoalRefFacet, reason: { code: string; message: string }): GoalViewFacet
}

/** /tasks kill 所需的最小 tasks 服务面（不引入 dsh-tasks 依赖；id 运行时即 string）。 */
interface TasksFacet {
  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
}

/** /remember、/memory 所需的最小 memory 服务面（不引入 dsh-memory 依赖；
 *  reflect.get 动态获取——TUI 编译面约定）。 */
interface MemoryFacet {
  save(entry: { text: string; scope: string; tags: string[]; source: string }): Promise<{ id: string }>
  list(opts?: { scope?: string; limit?: number }): Promise<Array<{ id: string; text: string; tags: string[]; createdAt: number }>>
  delete(id: string): Promise<void>
}

/**
 * 内置命令名（解析 + 提示的单一事实来源；描述/argsHint 见 createBuiltinCommands）。
 * 含 /steer：TuiApp 复用既有 handleSteer 入口，此处只参与前缀匹配。
 * /status 同款：注册表只声明名字参与前缀解析/提示，实际显隐切换 handler 由
 * TuiApp 经 register 接线（见 ui/app.ts）。
 * /subagents、/workflow、/tasks 的命令定义在 createBuiltinCommands（deps 注入
 * TuiApp 的显隐切换）；/status、/todos 保持 TuiApp 内注册（/todos：无参显隐 +
 * all 明细展开，数据源为 todos 投影保留快照）。
 */
export const BUILTIN_COMMAND_NAMES = ['theme', 'session', 'fork', 'branch', 'clear', 'scroll', 'compact', 'steer', 'model', 'effort', 'key', 'login', 'preset', 'tasks', 'density', 'glance', 'info', 'changelog', 'goal', 'status', 'todos', 'subagents', 'workflow', 'config', 'skills', 'rewind', 'btw', 'doctor', 'mcp', 'remember', 'memory', 'export', 'exit', 'restart', 'update', 'yolo', 'help', 'cost', 'vim', 'welcome'] as const

/**
 * 最小唯一前缀解析：`/` 前缀 + 命令名 `startsWith` 匹配。
 * 歧义（多命令同前缀）或未知名返回 null——不猜命令。
 * @param input - 输入行原始文本。
 * @param commands - 命令名集合（字符串或带 name 的对象，registry 实例与静态名表共用）。
 * @returns 命中的命令与剥离后的参数文本；无匹配返回 null。
 */
export function resolveSlashCommand(
  input: string,
  commands: readonly (string | { name: string })[],
): { command: { name: string }; text: string } | null {
  if (!input.startsWith('/')) return null
  const spaceIdx = input.indexOf(' ')
  const token = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)
  const rest = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim()
  if (token === '') return null
  const nameOf = (c: string | { name: string }): string => (typeof c === 'string' ? c : c.name)
  const matches = commands.filter(c => nameOf(c).startsWith(token))
  if (matches.length !== 1) return null
  const match = matches[0]
  /* v8 ignore next -- length===1 保证 [0] 必有值；noUncheckedIndexedAccess 收窄防御 */
  if (match === undefined) return null
  return { command: { name: nameOf(match) }, text: rest }
}

/**
 * 命令注册表——register/unregister/list/get/resolve/hint。
 * 同名 register 覆盖旧命令；空名或含空格的命令名 register 抛错。
 * 实例经 `ctx.provide('tui.commands', registry)` 暴露为 Cordis 服务。
 */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommand>()

  /**
   * 注册（或覆盖同名）命令。
   * @param command - 命令定义；空名或含空格的名字抛错。
   */
  register(command: SlashCommand): void {
    if (command.name === '' || command.name.includes(' ')) {
      throw new Error(`invalid slash command name: ${JSON.stringify(command.name)}`)
    }
    this.commands.set(command.name, command)
  }

  /**
   * 反注册命令；不存在时 no-op。
   * @param name - 命令名（不含 / 前缀）。
   */
  unregister(name: string): void {
    this.commands.delete(name)
  }

  /**
   * 按注册顺序列出全部命令。
   * @returns 命令数组（注册顺序）。
   */
  list(): SlashCommand[] {
    return [...this.commands.values()]
  }

  /**
   * 按名取命令；未注册返回 undefined。
   * @param name - 命令名（不含 / 前缀，精确匹配）。
   * @returns 命中的命令；未注册为 undefined。
   */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  /**
   * 最小唯一前缀解析（委托 resolveSlashCommand，用实例注册表）。
   * @param input - 输入行原始文本。
   * @returns 命中的命令与参数文本；未知/歧义/非 slash 输入为 null。
   */
  resolve(input: string): SlashParse | null {
    const parsed = resolveSlashCommand(input, this.list())
    /* v8 ignore next -- resolveSlashCommand 只在命令存在时返回对象，get 必命中；双查防御 */
    if (parsed === null) return null
    const command = this.commands.get(parsed.command.name)
    /* v8 ignore next -- 同上：parsed 来自本注册表命令名，get 恒非 undefined；双查防御 */
    if (command === undefined) return null
    return { command, text: parsed.text }
  }

  /**
   * 内联提示：输入以 / 开头且有匹配命令时返回提示行；否则 null。
   * 展示在 live 区输入行上方（最小内联提示，不启用 overlay-engine 全屏面板）。
   * @param input - 输入行原始文本。
   * @returns 一行 `命令: /a /b …` 提示；无匹配为 null。
   */
  hint(input: string): string | null {
    if (!input.startsWith('/')) return null
    const token = input.slice(1)
    if (token === '') return null
    const matches = this.list().filter(c => c.name.startsWith(token))
    if (matches.length === 0) {
      // 空态引导：类路径/参数输入（/src/main.ts、/tmp/foo bar）静默不误报；
      // 其余无匹配提示 Enter 提交看相近建议（纠错闭环入口）。
      if (token.includes('/') || token.includes('.') || token.includes(' ')) return null
      return '无匹配命令（Enter 提交查看相近建议）'
    }
    const parts = matches.map(c => `/${c.name}${c.argsHint === undefined ? '' : ` ${c.argsHint}`}`)
    return `命令: ${parts.join('   ')}`
  }
}

/**
 * 内置命令工厂依赖——TuiApp 私有能力注入（会话铸造、滚动区重置、面板显隐切换）。
 */
export interface BuiltinCommandDeps extends StartupCommandDeps {
  /** /session new：新建会话并挂载（TuiApp.newSession）。 */
  newSession(): Promise<SessionId>
  /** /fork、/branch（A3）：分叉当前会话（复制历史）并切换（TuiApp.forkSession）。 */
  forkSession(opts?: { directive?: string }): Promise<SessionId>
  /** /clear：清空当前会话 scrollback（CommitEngine.reset）。 */
  clearScrollback(): void
  /** /tasks 无参：切换任务窗格显隐（TuiApp 私有状态 + renderLive）。 */
  toggleTaskPanel(): void
  /** /subagents：切换委派树面板显隐（T2.1；数据源为委派树缓存）。 */
  toggleSubagentsPanel(): void
  /** /workflow：切换 workflow 运行中面板显隐（T2.2；数据源为运行中缓存）。 */
  toggleWorkflowPanel(): void
  /** /rewind（C3 项 3）：打开 rewind overlay；返回是否已打开（无会话或无可回退用户消息时 false）。 */
  rewindSession(): boolean
  /** /btw（P1）：发起侧问；返回是否已发起（无会话/已有挂起侧问时 false）。 */
  askBtw(question: string): Promise<boolean>
  /** /memory（P2）：打开记忆浏览器 overlay；返回是否已打开（无 memory 服务时 false）。 */
  openMemoryBrowser(): Promise<boolean>
  /** /session switch（P3）：切换到既有 live 会话（id 字符串；app 侧转 SessionId）。 */
  switchSession(id: string): Promise<void>
  /** /export（T3）：导出当前会话转录为 Markdown；path 缺省由实现决定；返回导出文件路径。 */
  exportTranscript(path?: string): Promise<string>
  /** /exit：请求退出 TUI（与 Ctrl+Q 同一 onExit 路径）。 */
  requestExit(): void
  /** /restart：以相同命令重启当前 dsh 进程（dispose → spawn 同 argv → 退出）。 */
  requestRestart(): void
  /** /help：当前注册表的全部命令（TuiApp 是注册表所有者，经 deps 注入而非 ctx 服务）。 */
  listCommands(): SlashCommand[]
  /** /help 无参：打开命令面板（分组浏览 + 过滤 + Enter 回填；backfill 模式不执行）。 */
  openCommandPalette(): void
  /** /yolo：开启/关闭全放行模式（approval always-approve 快捷入口；返回开启后提示）。 */
  setYoloMode(flag: boolean): void
  /** #31：打开会话选择器。 */
  openSessionPicker(): void
  /** /scroll：打开分页查看器 overlay（scrollback 全文只读浏览 + 搜索跳转）。 */
  openScrollPager(): void
  /** /key、/login：打开 API Key 设置对话框（掩码输入 + 联网验证 + 落盘）。 */
  openKeyDialog(): void
  /** /cost：当前会话累计用量与成本报告行（app 侧汇总；无数据时返回占位行）。 */
  sessionCostReport(): string[]
  /** /update：对照 npm latest 的只查不装更新检查（结果回显用；失败不抛）。 */
  checkForUpdate(): Promise<UpdateCheckResult>
}

/**
 * 装配内置命令（/theme /session /clear /compact）。
 * /steer 不在此列——TuiApp 复用既有 handleSteer 入口。
 * @param deps - TuiApp 私有能力。
 * @returns 内置命令数组（含描述/argsHint，供注册表与提示使用）。
 */
export function createBuiltinCommands(deps: BuiltinCommandDeps): SlashCommand[] {
  return [
    createThemeCommand(deps),
    {
      name: 'session',
      category: '会话',
      description: '会话管理：new 新建，list 列出，switch 切换',
      argsHint: 'new|list|switch <id>',
      run: async ({ text, echo, ctx }) => {
        /* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
        const sub = text.split(/\s+/)[0] ?? ''
        if (sub === '') {
          // #31：无参打开会话选择器（上下键选择替代命令输入；当前会话 ● 高亮）。
          deps.openSessionPicker()
          return
        }
        if (sub === 'new') {
          const id = await deps.newSession()
          echo(`已新建会话: ${id}`)
          return
        }
        if (sub === 'list') {
          const rows = await listSessions(ctx)
          if (rows.length === 0) {
            echo('（当前无会话）')
            return
          }
          // 标题数据源与选择器同款（title 事件 fold → 首条真人消息 → 「新对话」）。
          // 按今天/昨天/本周/更早分组后逐行打印（不进交互界面）。
          const titled = []
          for (const row of rows) {
            const events = await loadHistory(ctx, row.id)
            titled.push({ id: row.id, createdAt: row.createdAt, title: sessionTitleFor(events) })
          }
          for (const line of formatSessionListLines(titled, Date.now())) echo(line)
          return
        }
        if (sub === 'switch') {
          // P3：多会话切换——目标 id 必须是 live store 中已存在的会话。
          const id = text.slice(sub.length).trim()
          if (id === '') {
            echo('用法: /session switch <id>（/session list 查看 id）')
            return
          }
          await deps.switchSession(id)
          echo(`已切换会话: ${id}`)
          return
        }
        echo('用法: /session new|list|switch <id>')
      },
    },
    {
      name: 'fork',
      category: '会话',
      description: '分叉当前会话（复制历史到新会话并切换）',
      argsHint: '[directive]',
      run: async ({ text, echo }) => {
        const directive = text.trim()
        const id = directive === '' ? await deps.forkSession() : await deps.forkSession({ directive })
        echo(`已分叉会话: ${id}`)
      },
    },
    {
      name: 'rewind',
      category: '面板',
      description: '回退到一条用户消息（C3 项 3：会话截断 + 可选文件回退）',
      argsHint: '',
      run: ({ echo }) => {
        if (!deps.rewindSession()) {
          echo('⚠ 当前无可回退的会话')
        }
      },
    },
    {
      name: 'branch',
      category: '会话',
      description: '分叉当前会话（/fork 别名）',
      run: async ({ echo }) => {
        const id = await deps.forkSession()
        echo(`已分叉会话: ${id}`)
      },
    },
    createModelCommand(deps),
    {
      name: 'key',
      category: '认证',
      description: '配置模型供应商 API 密钥（选择供应商 → 掩码输入 + 联网验证；保存即生效）',
      run: () => { deps.openKeyDialog() },
    },
    {
      name: 'login',
      category: '认证',
      description: '配置模型供应商 API 密钥（/key 别名）',
      run: () => { deps.openKeyDialog() },
    },
    {
      name: 'update',
      category: '系统',
      description: '检查插件更新（对照 npm latest；发现新版提示手动更新命令）',
      run: async ({ echo }) => {
        const result = await deps.checkForUpdate()
        if (result.kind === 'latest') {
          echo(`发现新版本 ${result.latest}（当前 ${result.current}）。手动更新：npx -y @deepseek-ai/dsh plugin --profile tui add ${TUI_PACKAGE}@latest；或重启后自动更新`)
        } else if (result.kind === 'current') {
          echo(`已是最新版本（${result.current}）`)
        } else {
          echo(`⚠ 更新检查失败：${result.error}`)
        }
      },
    },
    createEffortCommand(deps),
    createPresetCommand(deps),
    {
      name: 'clear',
      category: '会话',
      description: '清空当前会话滚动区并收起命令面板',
      run: ({ echo }) => {
        deps.clearScrollback()
        echo('已清空当前会话滚动区')
      },
    },
    {
      name: 'scroll',
      category: '会话',
      description: '分页查看会话转录（滚动 / 搜索 / n·N 跳转）',
      run: () => {
        deps.openScrollPager()
      },
    },
    {
      name: 'compact',
      category: '会话',
      description: '压缩当前会话（需 compact 服务）',
      run: async ({ text: _text, echo, ctx, sessionId }) => {
        // reflect.get 读取可选服务（Cordis 4 注入代理：属性访问未注册服务
        // 抛 "without inject"——与 T4 sessionProjections 同款修复）
        const agent = sessionId === null ? undefined : ctx.agents.get(sessionId)
        const compact = serviceForAgent(ctx, agent, 'compact') as CompactFacet | undefined
        if (compact === undefined) {
          echo('⚠ compact 服务不可用（未加载 compact 插件）')
          return
        }
        if (sessionId === null) {
          echo('⚠ 当前无会话')
          return
        }
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          echo('⚠ 会话不存在')
          return
        }
        /* v8 ignore next -- agent 已在上方 undefined 检查放行，此处仅类型收窄；noUncheckedIndexedAccess 防御 */
        const result = await compact.compactIfNeeded(
          { session, options: agent?.options ?? {} },
          'pressure',
          new AbortController().signal,
        )
        echo(result === null ? '无需压缩（或无可压缩范围）' : '压缩完成')
      },
    },
    {
      name: 'goal',
      category: '面板',
      description: '目标管理：查看/创建/暂停/恢复/完成/阻塞（需 goal 服务）',
      argsHint: '[create <objective>|pause|resume|complete|block]',
      run: ({ text, echo, ctx, sessionId }) => {
        // reflect.get 读取可选服务（与 /compact 同款：goal 插件未装配时
        // 返回 undefined，命令报不可用——fails loud，禁止静默空操作）。
        const goals = ctx.reflect.get('goals', false) as GoalFacet | undefined
        if (goals === undefined) {
          echo('⚠ goal 服务不可用（未加载 goal 插件）')
          return
        }
        if (sessionId === null) {
          echo('⚠ 当前无会话')
          return
        }
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) {
          echo('⚠ 会话不存在')
          return
        }
        /* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
        const verb = text.split(/\s+/)[0] ?? ''
        const rest = verb === '' ? '' : text.slice(verb.length).trim()
        if (verb === '') {
          // 无参：查看当前目标（渲染到 live 区；runSlash 在 run 后统一
          // renderLive 刷新）。
          const view = goals.get(agent)
          if (view === undefined) {
            echo('（当前无目标）')
            return
          }
          echo(formatGoalView(view))
          return
        }
        if (verb === 'create') {
          if (rest === '') {
            echo('用法: /goal create <objective>')
            return
          }
          const view = goals.create(agent, { objective: rest })
          echo(`目标已创建: ${view.objective}（phase: ${view.phase}）`)
          return
        }
        const MUTATIONS = ['pause', 'resume', 'complete', 'block'] as const
        if (!(MUTATIONS as readonly string[]).includes(verb)) {
          echo('用法: /goal [create <objective>|pause|resume|complete|block]')
          return
        }
        const current = goals.get(agent)
        if (current === undefined) {
          echo('（当前无目标，无法执行该操作）')
          return
        }
        const ref: GoalRefFacet = { id: current.id, revision: current.revision }
        if (verb === 'pause') {
          const view = goals.pause(agent, ref)
          echo(`目标已暂停: ${view.objective}`)
          return
        }
        if (verb === 'resume') {
          const view = goals.resume(agent, ref)
          echo(`目标已恢复: ${view.objective}（phase: ${view.phase}）`)
          return
        }
        if (verb === 'complete') {
          const view = goals.complete(agent, ref)
          echo(`目标已完成: ${view.objective}`)
          return
        }
        /* v8 ignore next -- MUTATIONS 过滤 + 前三 if 提前 return，此处 verb 恒为 'block'，false 侧不可达 */
        if (verb === 'block') {
          const view = goals.block(agent, ref, {
            code: 'user-requested',
            message: rest === '' ? 'blocked by user via /goal' : rest,
          })
          echo(`目标已阻塞: ${view.objective}`)
          return
        }
      },
    },
    {
      name: 'tasks',
      category: '面板',
      description: '任务窗格：无参切换；kill <id> 终止后台任务',
      argsHint: '[kill <id>]',
      run: ({ text, echo, ctx }) => {
        /* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
        const sub = text.split(/\s+/)[0] ?? ''
        if (sub === 'kill') {
          // T2.3：task kill 接线 ctx.tasks.kill（reflect.get 读取可选服务；
          // 与 /compact /goal 同款——tasks 插件未装配时报不可用，fails loud）。
          const id = text.slice(sub.length).trim()
          if (id === '') {
            echo('用法: /tasks kill <id>')
            return
          }
          const tasks = ctx.reflect.get('tasks', false) as TasksFacet | undefined
          if (tasks === undefined) {
            echo('⚠ tasks 服务不可用（未加载 tasks 插件）')
            return
          }
          const result = tasks.kill(id)
          echo(result === 'already-finished' ? `任务已结束: ${id}` : `已请求终止任务: ${id}`)
          return
        }
        if (sub !== '') {
          echo('用法: /tasks [kill <id>]')
          return
        }
        deps.toggleTaskPanel()
      },
    },
    {
      name: 'subagents',
      category: '面板',
      description: '切换委派树面板（subagent 层级投影）',
      run: () => { deps.toggleSubagentsPanel() },
    },
    {
      name: 'workflow',
      category: '面板',
      description: '切换 workflow 运行中面板',
      run: () => { deps.toggleWorkflowPanel() },
    },
    {
      name: 'btw',
      category: '会话',
      description: '侧问：向后台 agent 提问（不中断当前对话）',
      argsHint: '<question>',
      run: async ({ text, echo }) => {
        const question = text.trim()
        if (question === '') {
          echo('用法: /btw <question>')
          return
        }
        const started = await deps.askBtw(question)
        if (!started) echo('⚠ 当前无会话或已有挂起的侧问')
      },
    },
    {
      name: 'remember',
      category: '会话',
      description: '保存一条项目记忆（写入 .dsh/memory/global.md）',
      argsHint: '<text>',
      run: async ({ text, echo, ctx }) => {
        const memory = ctx.reflect.get('memory', false) as MemoryFacet | undefined
        if (memory === undefined) {
          echo('⚠ memory 服务不可用（未加载 memory 插件）')
          return
        }
        const content = text.trim()
        if (content === '') {
          echo('用法: /remember <text>')
          return
        }
        const entry = await memory.save({ text: content, scope: 'global', tags: [], source: 'user' })
        echo(`已保存记忆: ${entry.id}`)
      },
    },
    {
      name: 'memory',
      category: '会话',
      description: '打开记忆浏览器；delete <id> 直接删除',
      argsHint: '[delete <id>]',
      run: async ({ text, echo, ctx }) => {
        const memory = ctx.reflect.get('memory', false) as MemoryFacet | undefined
        if (memory === undefined) {
          echo('⚠ memory 服务不可用（未加载 memory 插件）')
          return
        }
        /* v8 ignore next -- split(/\s+/) 恒返回非空数组，[0] 必有值；noUncheckedIndexedAccess 收窄防御 */
        const sub = text.split(/\s+/)[0] ?? ''
        if (sub === 'delete') {
          const id = text.slice(sub.length).trim()
          if (id === '') {
            echo('用法: /memory delete <id>')
            return
          }
          await memory.delete(id)
          echo(`已删除记忆: ${id}`)
          return
        }
        if (sub !== '') {
          echo('用法: /memory [delete <id>]')
          return
        }
        if (!await deps.openMemoryBrowser()) {
          echo('⚠ 无法打开记忆浏览器')
        }
      },
    },
    {
      name: 'doctor',
      category: '系统',
      description: '终端诊断：检测终端能力并输出报告；fix <id> 查看修复指引',
      argsHint: '[fix <id>]',
      run: ({ text, echo }) => {
        const sub = text.trim()
        if (sub.startsWith('fix')) {
          const idStr = sub.slice(3).trim()
          const id = Number(idStr)
          if (Number.isNaN(id) || idStr === '') {
            echo('用法: /doctor fix <id>')
            return
          }
          const guidance = getDoctorFixGuidance(id)
          if (guidance === null) {
            echo(`未知修复项: ${id}`)
            return
          }
          echo(guidance)
          return
        }
        if (sub !== '') {
          echo('用法: /doctor [fix <id>]')
          return
        }
        const cols = process.stdout.columns
        const rows = process.stdout.rows
        const background = process.env.COLORFGBG !== undefined ? '已检测' : '未检测'
        const checks = collectDoctorReport(cols, rows, background)
        echo('终端诊断报告:')
        for (const c of checks) {
          const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : 'ℹ'
          const fixTag = c.fixId !== undefined ? ` [修复 ${c.fixId}]` : ''
          echo(`  ${icon} ${c.name}: ${c.value}${fixTag}`)
        }
        const fixable = checks.filter(c => c.fixId !== undefined)
        if (fixable.length > 0) {
          echo('')
          echo('可修复项:')
          for (const c of fixable) {
            const id = c.fixId
            if (id === undefined) continue
            const fix = getDoctorFixGuidance(id)
            if (fix !== null) echo(`  [${id}] ${fix.split('\n')[0]}`)
          }
          echo('运行 /doctor fix <id> 查看详细修复指引')
        }
      },
    },
    {
      name: 'mcp',
      category: '系统',
      description: 'MCP 状态：列出已连接 server 与工具数；tools <name> 查看工具清单',
      argsHint: '[tools <server>]',
      run: ({ text, echo, ctx }) => {
        // 读 mcp-client 的聚合状态表（'mcp.status'：serverName → status）；
        // 经 reflect.get 动态获取——不静态依赖 mcp-client 包。未装配时
        // undefined 兜底（fails loud 禁止静默空操作）。
        const table = ctx.reflect.get('mcp.status', false) as
          | Map<string, { serverName: string; getToolCount(): number; listToolNames(): string[] }>
          | undefined
        if (table === undefined || table.size === 0) {
          echo('⚠ 无 MCP server 连接（检查 cordis.yml 中 mcp-client 插件配置）')
          return
        }
        const sub = text.trim()
        if (sub.startsWith('tools')) {
          const target = sub.slice(5).trim()
          if (target === '') {
            echo('用法: /mcp tools <server>')
            return
          }
          const status = table.get(target)
          if (status === undefined) {
            echo(`未知 MCP server: ${target}。可用: ${[...table.keys()].join(', ')}`)
            return
          }
          const names = status.listToolNames().sort()
          echo(`${target} (${names.length} 工具):`)
          for (const name of names) echo(`  ${name}`)
          return
        }
        if (sub !== '') {
          echo('用法: /mcp [tools <server>]')
          return
        }
        const servers = [...table.values()].sort((a, b) => a.serverName.localeCompare(b.serverName))
        echo(`MCP servers (${servers.length}):`)
        for (const s of servers) {
          echo(`  ${s.serverName}: ${s.getToolCount()} 工具`)
        }
      },
    },
    {
      name: 'export',
      category: '会话',
      description: '导出当前会话转录为 Markdown 文件（T3）',
      argsHint: '[path]',
      run: async ({ text, echo }) => {
        // path 缺省由 TuiApp.exportTranscript 决定（会话 cwd 下 dsh-export-<id>.md）；
        // 空串按缺省处理。写文件失败向上抛，由分发层回显失败（fails loud）。
        const path = text.trim() === '' ? undefined : text.trim()
        const written = await deps.exportTranscript(path)
        echo(`会话已导出: ${written}`)
      },
    },
    {
      name: 'exit',
      category: '会话',
      description: '退出 TUI（与 Ctrl+Q 相同）',
      run: () => { deps.requestExit() },
    },
    {
      name: 'restart',
      category: '会话',
      description: '重启当前 dsh 进程（同命令重新启动；插件更新后无需手动重跑）',
      run: () => { deps.requestRestart() },
    },
    {
      name: 'yolo',
      category: '配置',
      description: '全放行模式：审批不再逐项询问（on 开启 / off 关闭；等价 Shift+Tab 进 always-approve）',
      argsHint: 'on|off',
      run: ({ text, echo }) => {
        const arg = text.trim().toLowerCase()
        if (arg === 'off' || arg === '0' || arg === 'false') {
          deps.setYoloMode(false)
          echo('全放行模式已关闭（恢复逐项审批）')
          return
        }
        // on / 缺省（无参）均视为开启——与 Shift+Tab 进 always-approve 同语义。
        if (arg !== '' && arg !== 'on' && arg !== '1' && arg !== 'true') {
          echo('用法: /yolo [on|off]（缺省 on；off 关闭全放行）')
          return
        }
        deps.setYoloMode(true)
        echo('全放行模式已开启：后续审批请求自动放行（/yolo off 关闭，退出会话复位）')
      },
    },
    {
      name: 'help',
      category: '系统',
      description: '列出全部命令与用法（/help <cmd> 查看单条详情）',
      argsHint: '[cmd]',
      run: ({ text, echo }) => {
        // 注册表经 deps 注入（TuiApp 持有 this.slash 实例）——不访问 ctx 属性：
        // Cordis 注入代理对未声明属性直接抛 "without inject"（#36 根因）。
        const all = deps.listCommands()
        const target = text.trim()
        if (target !== '') {
          const command = all.find(c => c.name === target)
          if (command === undefined) {
            echo(`未知命令: /${target}（/help 查看全部命令）`)
            return
          }
          echo(`/${command.name}${command.argsHint === undefined ? '' : ` ${command.argsHint}`} — ${command.description}`)
          return
        }
        // 无参：打开命令面板（分组浏览 + 过滤 + Enter 回填），替代 40+ 条
        // echo 刷屏；/help <cmd> 单条详情保留。
        deps.openCommandPalette()
        echo('命令面板已打开：分组浏览 + 过滤（/help <cmd> 查看单条详情）')
      },
    },
    {
      name: 'cost',
      category: '系统',
      description: '当前会话累计用量与成本估算（按模型分桶）',
      argsHint: '',
      run: ({ echo }) => {
        for (const line of deps.sessionCostReport()) echo(line)
      },
    },
  ]
}

/** 渲染一行当前目标（/goal 无参视图）。 */
function formatGoalView(view: GoalViewFacet): string {
  return `目标: ${view.objective}（phase: ${view.phase}，rounds: ${view.roundsStarted}/${view.maxGoalRounds}）`
}

export { getActiveThemeName }

/**
 * 未知命令的相近建议（闭环引导）：编辑距离命中（≤ 2 且 ≤ 输入长度一半——
 * 短输入只信前缀，防 /st 误建议 btw/cost），其次公共前缀 ≥ 2。
 * 歧义前缀（如 /st → steer/status）与笔误（如 /glans → glance）都能命中；
 * 无相近命令返回空数组（调用方回退「/help 查看全部」引导）。
 * @param input - 完整 slash 输入（含 / 前缀；大小写不敏感）。
 * @param commands - 命令列表。
 * @param limit - 建议条数上限（缺省 3）。
 * @returns 建议命令（匹配度升序；距离相同时短名优先）。
 */
export function suggestCommands(
  input: string,
  commands: readonly SlashCommand[],
  limit = 3,
): SlashCommand[] {
  const name = input.replace(/^\//, '').trim().toLowerCase()
  if (name === '') return []
  const scored: Array<{ cmd: SlashCommand; score: number }> = []
  for (const cmd of commands) {
    const d = levenshteinDistance(name, cmd.name)
    const prefix = commonPrefixLength(name, cmd.name)
    if (d <= 2 && d <= Math.floor(name.length / 2)) scored.push({ cmd, score: d })
    else if (prefix >= 2) scored.push({ cmd, score: 3 })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.cmd.name.length !== b.cmd.name.length) return a.cmd.name.length - b.cmd.name.length
    return a.cmd.name.localeCompare(b.cmd.name)
  })
  return scored.slice(0, limit).map(s => s.cmd)
}

/** 编辑距离（经典 DP；len 乘积空间，命令名短小足够）。 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const curr = [i, ...Array(n)]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    prev = curr
  }
  return prev[n]!
}

/** 最长公共前缀长度。 */
function commonPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
