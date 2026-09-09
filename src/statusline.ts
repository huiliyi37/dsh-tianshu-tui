/**
 * 可脚本化 statusline — 对齐 Claude Code statusLine 协议的字段子集。
 *
 * config `ui.statusLine.command` 指定用户脚本；每次刷新把会话状态 JSON 写入
 * 脚本 stdin，取 stdout 首行渲染在输入框上方的独立行。
 *
 * 协议 payload（CC 字段子集 + rivet 扩展）：
 * ```json
 * {
 *   "session_id": "…",
 *   "model": { "display_name": "deepseek-v4" },
 *   "workspace": { "current_dir": "/path/to/project" },
 *   "git": { "branch": "main" },
 *   "context": { "ratio": 0.42, "estimated_tokens": 54000, "max_tokens": 128000 },
 *   "cost": { "total_yuan": 0.1234 },
 *   "turn": 7
 * }
 * ```
 *
 * 安全/稳态约束：
 * - 节流（默认 3s）+ 单飞（前一次未返回则跳过本次）
 * - 超时 kill（默认 2s），脚本失败/超时保留上一次输出（不闪断）
 * - 输出截断到 300 字符、去掉换行——渲染层再按终端宽度 clamp
 */

import { spawn } from 'node:child_process'

// rc.1 起 'todo/write' 的类型声明随官方 dsh-tool-todo 外移出核心 SessionEventMap；
// TUI 只做 switch 相位收窄，不消费 payload——本地合并同款官方结构（TodoItem：
// content + 三态 status）保住事件判别。
declare module '@deepseek-ai/dsh-session' {
  interface TodoItem {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
  }
  interface SessionEventMap {
    'todo/write': { todos: TodoItem[] }
  }
}

/** 写入脚本 stdin 的协议 payload（CC 字段子集 + rivet 扩展；见模块头示例）。 */
export interface StatusLinePayload {
  session_id: string
  model: { display_name: string }
  workspace: { current_dir: string }
  git?: { branch?: string }
  context?: { ratio: number; estimated_tokens?: number; max_tokens?: number }
  cost?: { total_yuan?: number }
  turn?: number
}

/** 用户脚本 statusline 配置（ui.statusLine）。 */
export interface StatusLineConfig {
  /** 用户脚本命令（shell 语义执行）。 */
  command: string
  /** 两次执行的最小间隔（毫秒）。默认 3000。 */
  intervalMs?: number
  /** 单次执行超时（毫秒），超时 kill。默认 2000。 */
  timeoutMs?: number
}

/**
 * 用户脚本 statusline 执行器：节流 + 单飞 + 超时 kill；输出经 `onUpdate`
 * 推送（截断 300 字符、取 stdout 首行）。失败/超时静默保留上一次输出。
 */
export class StatusLineRunner {
  private readonly command: string
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private lastRunMs = 0
  private inFlight = false
  private lastOutput: string | null = null

  constructor(config: StatusLineConfig, private readonly onUpdate: (text: string | null) => void) {
    this.command = config.command
    this.intervalMs = config.intervalMs ?? 3000
    this.timeoutMs = config.timeoutMs ?? 2000
  }

  /** 当前缓存的 statusline 文本（脚本 stdout 首行）。 */
  get current(): string | null {
    return this.lastOutput
  }

  /**
   * 请求刷新。节流 + 单飞；实际执行时把 payload JSON 写入脚本 stdin。
   * 失败/超时静默保留上一次输出。
   * @param payload - 写入脚本 stdin 的会话状态。
   */
  refresh(payload: StatusLinePayload): void {
    const now = Date.now()
    if (this.inFlight || now - this.lastRunMs < this.intervalMs) return
    this.lastRunMs = now
    this.inFlight = true

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      this.inFlight = false
      return
    }

    let stdout = ''
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      this.inFlight = false
      const firstLine = stdout.split('\n')[0]?.trim() ?? ''
      if (firstLine) {
        this.lastOutput = firstLine.slice(0, 300)
        this.onUpdate(this.lastOutput)
      }
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already dead */ }
      settle()
    }, this.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.on('error', () => { settle() })
    child.on('close', () => { settle() })
    try {
      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
    } catch { /* stdin 已关：脚本可能不读输入，无妨 */ }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 5.1 阶段指示器 + 5.2 活动标签（自包含事件订阅投影）
//
// 纯投影：从 `agent/status` + session log（`session/event` firehose）推断
// 工作流阶段与当前工具活动，不发明事件类型、不写回 session log。
// ─────────────────────────────────────────────────────────────────────

import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// 事件声明合并：approval/policy（user-approval）与 permission/preset
// （permission）扩展 SessionEventMap——本类折叠这两个会话事件为授权徽标。
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'

/** 六阶段工作流：理解 → 调研 → 拆解 → 实施 → 验证 → 收尾。 */
export type WorkflowPhase = 'understand' | 'research' | 'decompose' | 'implement' | 'verify' | 'wrapup'

/** 当前正在执行的工具调用（tool/call 投影，未解析的原始参数 JSON）。 */
export interface WorkflowActivity {
  readonly name: string
  readonly arguments: string
  readonly turn: number
  readonly step: number
}

/** 从 session log turn 结构推断出的工作流视图。 */
export interface WorkflowView {
  readonly sessionId: SessionId
  readonly phase: WorkflowPhase
  readonly turn: number
  readonly activity: WorkflowActivity | undefined
}

/**
 * 空工作流视图：尚未收到任何 turn 事件，处于理解阶段。
 * @param sessionId - 归属会话 id。
 * @returns 初始视图（turn = -1，无活动）。
 */
export function emptyWorkflowView(sessionId: SessionId): WorkflowView {
  return { sessionId, phase: 'understand', turn: -1, activity: undefined }
}

/**
 * 工具名 → 工作流阶段。未知名工具返回 undefined（不改变当前阶段）。
 * 分类依据：读/搜 → 调研；写/改/执行 → 实施；测试 → 验证。
 * @param toolName - 工具名。
 * @returns 推断阶段；未知工具返回 undefined。
 */
export function inferPhaseFromTool(toolName: string): WorkflowPhase | undefined {
  switch (toolName) {
    case 'read_file':
    case 'grep':
    case 'glob':
    case 'diff':
    case 'semantic_search':
    case 'web_fetch':
    case 'repo_map':
    case 'inspect_project':
      return 'research'
    case 'edit_file':
    case 'write_file':
    case 'apply_patch':
    case 'bash':
      return 'implement'
    case 'run_tests':
      return 'verify'
    default:
      return undefined
  }
}

/**
 * Fold 一个 session 事件进入工作流视图（纯函数，返回新视图）。
 * turn/start 重置为理解；todo/write → 拆解；turn/end(completed) → 收尾；
 * tool/call 投影阶段与活动。其余事件（chunk/assistant 等）不改变视图。
 * @param view - 当前视图。
 * @param event - 会话事件。
 * @returns 新视图。
 */
export function applyWorkflowEvent(view: WorkflowView, event: SessionEvent): WorkflowView {
  switch (event.type) {
    case 'turn/start':
      return { ...view, phase: 'understand', turn: event.data.turn, activity: undefined }
    case 'tool/call': {
      const phase = inferPhaseFromTool(event.data.name)
      return {
        ...view,
        phase: phase ?? view.phase,
        activity: { name: event.data.name, arguments: event.data.arguments, turn: event.data.turn, step: event.data.step },
      }
    }
    case 'todo/write':
      return { ...view, phase: 'decompose' }
    case 'turn/end':
      return event.data.reason.kind === 'completed'
        ? { ...view, phase: 'wrapup', activity: undefined }
        : view
    default:
      return view
  }
}

const PHASE_LABELS: Record<WorkflowPhase, string> = {
  understand: '理解',
  research: '调研',
  decompose: '拆解',
  implement: '实施',
  verify: '验证',
  wrapup: '收尾',
}

/** 授权/模式徽标后缀：[plan…] / [plan] / [auto] / [preset] / [yolo] / [ask]。
 *  注意：approvalPolicy 'never'（宿主 user-approval 写入）的语义是「自动拒绝
 *  所有需审批的操作」（宿主 decide() 返回 rejected），并非放行——[yolo] 是
 *  宿主 policy 词汇的展示，不代表「全放行」；TUI 全放行是 always-approve
 *  （[auto] 徽标，allowed-once 短路）。 */
function formatStatusSuffix(
  planActive = false,
  planPending = false,
  alwaysApprove = false,
  approvalPolicy: 'ask' | 'never' | null = null,
  permissionPreset: string | null = null,
): string {
  const badge = planPending ? ' [plan…]' : planActive ? ' [plan]' : ''
  const auto = alwaysApprove ? ' [auto]' : ''
  const preset = permissionPreset !== null ? ` [${permissionPreset}]` : ''
  const policy = preset === '' && approvalPolicy !== null
    ? (approvalPolicy === 'never' ? ' [yolo]' : ' [ask]')
    : ''
  return `${badge}${auto}${preset}${policy}`
}

/**
 * 渲染 statusline：`阶段 · 工具名`，无活动时仅阶段；后缀为授权/模式徽标。
 * @param view - 工作流视图。
 * @param planActive - plan 模式已生效（渲染 [plan]）。
 * @param planPending - plan 切换待请求边界落地（渲染 [plan…]，优先于 planActive）。
 * @param alwaysApprove - always-approve 生效（渲染 [auto]）。
 * @param approvalPolicy - approval/policy 折叠值；null = 未记录不显示徽标。
 * @param permissionPreset - permission/preset 折叠值；非 null 时压过 approvalPolicy 徽标。
 * @returns statusline 文本。
 */
export function formatStatusLine(
  view: WorkflowView,
  planActive = false,
  planPending = false,
  alwaysApprove = false,
  approvalPolicy: 'ask' | 'never' | null = null,
  permissionPreset: string | null = null,
): string {
  const phase = PHASE_LABELS[view.phase]
  const suffix = formatStatusSuffix(planActive, planPending, alwaysApprove, approvalPolicy, permissionPreset)
  return view.activity === undefined ? `${phase}${suffix}` : `${phase}${suffix} · ${view.activity.name}`
}

/**
 * 自包含 statusline：订阅 `agent/status` + 本 session 的 `session/event`，
 * 折叠出工作流阶段与实时工具活动，每次变更经 `onUpdate` 推送渲染文本。
 * 不依赖 ui/app.ts 喂数据——事件即事实源，纯投影。
 */
export class WorkflowStatusLine {
  private view: WorkflowView
  private planState: { active: boolean; pending: boolean } = { active: false, pending: false }
  private alwaysApprove = false
  /** 会话内最后一条 approval/policy 折叠值（null = 未记录，默认 ask 语义不显示徽标）。 */
  private approvalPolicy: 'ask' | 'never' | null = null
  /** 会话内最后一条 permission/preset 折叠值（permission 服务装配时；null = 未记录）。 */
  private permissionPreset: string | null = null
  /** agent 是否不在 running。收尾相位在 idle 时不占状态行（否则 ◆ 收尾一直挂着像卡住）。 */
  private agentIdle = true
  private lastText: string | null = null
  private readonly onUpdate: (text: string | null) => void
  private readonly disposers: (() => void)[]

  constructor(ctx: Context, sessionId: SessionId, onUpdate: (text: string | null) => void) {
    this.view = emptyWorkflowView(sessionId)
    this.onUpdate = onUpdate
    const onStatus = (_payload: { agent: { id: SessionId }; status: AgentStatus }): void => {
      if (_payload.agent.id !== sessionId) return
      this.agentIdle = _payload.status !== 'running'
      // 状态变化本身不改变阶段/活动，仅触发一次重渲染（保持 current 新鲜）。
      this.emit()
    }
    const onSessionEvent = (owner: { id: SessionId }, event: SessionEvent): void => {
      if (owner.id !== sessionId) return
      this.view = applyWorkflowEvent(this.view, event)
      // 授权模式折叠：approval/policy（user-approval 写）与 permission/preset
      // （permission 服务写）都是会话事件流事实，本类只读不改。
      if (event.type === 'approval/policy') {
        this.approvalPolicy = event.data.policy
      } else if (event.type === 'permission/preset') {
        this.permissionPreset = event.data.preset
      }
      this.emit()
    }
    this.disposers = [
      ctx.on('agent/status', onStatus),
      ctx.on('session/event', onSessionEvent),
    ]
  }

  /**
   * T1.4 + A1：设置 plan 徽标态（plan 投影的 active/pending）。数据由装配方
   * （ui/app.ts 的投影总线）提供，本类不订阅 plan 投影。
   * pending=true 表示有切换意图待请求边界落地（轮内 /plan），渲染 [plan…]。
   * 相同状态幂等不推送。
   * @param state - plan 投影的 active/pending 态。
   */
  setPlanState(state: { active: boolean; pending: boolean }): void {
    if (this.planState.active === state.active && this.planState.pending === state.pending) return
    this.planState = { active: state.active, pending: state.pending }
    this.emit()
  }

  /**
   * C3 项 4：always-approve 徽标态（Shift+Tab 循环第三态）。数据由装配方
   * （ui/app.ts 的 cycleMode）提供，本类不持有策略。相同状态幂等不推送。
   * @param active - always-approve 是否生效。
   */
  setAlwaysApprove(active: boolean): void {
    if (this.alwaysApprove === active) return
    this.alwaysApprove = active
    this.emit()
  }

  /** 当前缓存的 statusline 文本；无事件时 null。 */
  get current(): string | null {
    return this.lastText
  }

  private emit(): void {
    // turn/end completed 把相位留在 wrapup（收尾）是工作流事实；agent 已 idle
    // 时继续展示会让状态行永远停在 ◆ 收尾，像请求还在途。空闲不占位——
    // 但授权/模式徽标（[plan]/[auto]/[danger-full-access] 等）仍要保留：
    // 它们是安全可见性反馈，回合间消失会让 Shift+Tab / preset 切换无感知。
    if (this.agentIdle && this.view.phase === 'wrapup') {
      const suffix = formatStatusSuffix(
        this.planState.active,
        this.planState.pending,
        this.alwaysApprove,
        this.approvalPolicy,
        this.permissionPreset,
      )
      if (suffix === '') {
        if (this.lastText !== null) {
          this.lastText = null
          this.onUpdate(null)
        }
        return
      }
      const text = suffix.trim()
      if (this.lastText !== text) {
        this.lastText = text
        this.onUpdate(text)
      }
      return
    }
    const text = formatStatusLine(
      this.view,
      this.planState.active,
      this.planState.pending,
      this.alwaysApprove,
      this.approvalPolicy,
      this.permissionPreset,
    )
    this.lastText = text
    this.onUpdate(text)
  }

  /** 解绑两个订阅；幂等。 */
  dispose(): void {
    for (const dispose of this.disposers) dispose()
  }
}
