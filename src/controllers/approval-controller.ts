/**
 * ApprovalController — 待审批挂起状态机（Wave 1 从 ui/app.ts 提取）。
 *
 * 持有 pendingApproval 挂起态（req + resolve 句柄）与 alwaysApprove 短路标志。
 * handle() 是 approval/request 订阅的 answerer 入口，语义与 user-approval
 * waterfall 对齐：
 * - alwaysApprove 且当前会话 → 短路放行 allowed-once（不挂起、不消费）。
 * - 工具/命令前缀会话白名单（t/p 键）命中且当前会话 → 同样短路放行。
 * - 非当前会话或已有挂起 → 委托 next()（fail-closed：TUI 一次只呈现一个确认，
 *   apiproxy 等链上 answerer 处理远端转发）。
 * - 当前会话无挂起 → 挂起，返回等用户 y/N 的 promise。
 *
 * 决策分层（阶段 2）新增两件本地态：
 * - allowedPrefixes：bash 类工具的命令前缀白名单（p 键「此命令前缀不再问」），
 *   前缀由注入的 getCommandPrefix 在 handle() 时一次性提取缓存（transcript
 *   查找 + JSON 解析不随渲染重复）。协议层只有 allowed-once，前缀记忆是纯
 *   TUI 本地态短路（与 allowedTools 同型）。
 * - feedback：拒绝反馈输入态（f 键进入，复刻 question-controller 范式）；
 *   settle 时复位。反馈文本的 steer 旁路投递由 app 侧组装，controller 不碰。
 *
 * 会话归属经 getCurrentSessionId() getter 注入（app.ts 持有 activeSessionId），
 * 渲染经 peek() 快照消费；不 import app.ts、不碰渲染。
 *
 * 超时由 controller 内建承担（ApprovalPeek.since 仅为信息性字段，渲染侧
 * 不负责超时判定）：挂起超过 timeoutMs 无人应答 → fail-closed 自动结算
 * cancelled，卡片不会无限挂起。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/controllers/approval-controller
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** 审批 answerer 的本地请求形状（与 user-approval 词汇对齐；字段子集——TUI 只需展示所需）。 */
export interface PendingApprovalRequest {
  agent: { session: { id: SessionId } }
  toolName: string
  reason?: string
  /** C2 项 1：关联的精确工具调用（user-approval 运行时携带，用于审批 diff 查找）。 */
  callId?: ToolCallId
  /**
   * 请求撤销信号（user-approval `ApprovalRequest.signal` 透传）：abort 时挂起
   * 自动结算为 cancelled——asker 侧已把 abort 竞速为 cancelled，卡片必须同步
   * 消失，否则用户按 y 见卡片消失实际被拒且无提示（UI/outcome 不一致）。
   */
  signal?: AbortSignal
}

/** 用户决定（与 user-approval ApprovalOutcome 对齐）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 挂起态快照（renderLive 消费；无挂起时 peek() 返回 null）。 */
export interface ApprovalPeek {
  /** 待决审批请求。 */
  req: PendingApprovalRequest
  /** 挂起时间戳（ms；信息性字段——超时判定由 controller 内建 timeoutMs 承担，渲染侧不读）。 */
  since: number
  /** 拒绝反馈输入态（f 键进入；结算时复位；渲染侧据此显示反馈提示行）。 */
  feedbackMode: boolean
}

/** 审批挂起默认超时（ms）：挂起超过即 fail-closed 自动结算 cancelled（可经 options.timeoutMs 覆盖）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/** ApprovalController 的依赖注入（当前会话读取、状态变化回调）。 */
export interface ApprovalControllerOptions {
  /** 当前会话 id 读取函数（app.ts 注入 activeSessionId；null = 尚未 attach）。 */
  getCurrentSessionId: () => SessionId | null
  /** 状态实际变化（挂起/结算）后回调（app 侧触发重绘）。 */
  onChanged?: () => void
  /** 挂起超时毫秒数（超过即自动结算 cancelled，fail-closed；缺省 DEFAULT_APPROVAL_TIMEOUT_MS）。 */
  timeoutMs?: number
  /**
   * 命令前缀提取（p 键「此命令前缀不再问」数据源）：app 侧注入
   * callId → transcript → command 首 token；非 bash 类工具/提取失败返回 null。
   * handle() 时一次性调用并缓存进挂起态（前缀白名单短路 + p 键守卫共用）。
   */
  getCommandPrefix?: (req: PendingApprovalRequest) => string | null
}

/**
 * 待审批挂起状态机：handle() 按短路放行 / next() 委托 / 挂起三选一，
 * settle() 结算用户决定，peek() 给 renderLive 出快照（见模块注释语义）。
 * 挂起超过 timeoutMs 无人应答时自动结算 cancelled（fail-closed）。
 */
export class ApprovalController {
  private pending: {
    req: PendingApprovalRequest
    resolve: (outcome: ApprovalOutcome) => void
    since: number
    /** handle() 时一次性提取的命令前缀（p 键守卫/投影读取；非 bash 类 null）。 */
    prefix: string | null
    /** 挂起时注册的 abort 监听（settle 时移除，防泄漏/防二次结算）。 */
    onAbort?: () => void
    /** 挂起超时 timer（settle 时清除，防二次结算）。 */
    timer: ReturnType<typeof setTimeout> | undefined
  } | null = null
  private alwaysApproveFlag = false
  /**
   * 会话级工具白名单（任务4a，2026-08-27）：`t` 键「本会话允许此工具」加入，
   * 命中请求短路放行——其他工具仍逐卡审批（与 alwaysApprove 的全放行互补）。
   * 会话切换时 app 侧调 clearSessionGrants() 复位（跨会话残留清理节）。
   */
  private readonly allowedTools = new Set<string>()
  /**
   * 会话级命令前缀白名单（决策分层阶段 2）：`p` 键「此命令前缀不再问」加入，
   * bash 类工具后续同前缀请求短路放行——比 t 键整工具放行再收敛一档。
   */
  private readonly allowedPrefixes = new Set<string>()
  /** 拒绝反馈输入态（f 键进入；settle 复位——复刻 question-controller 范式）。 */
  private feedback = false
  private readonly getCurrentSessionId: () => SessionId | null
  private readonly onChanged: (() => void) | undefined
  private readonly timeoutMs: number
  private readonly getCommandPrefix: ((req: PendingApprovalRequest) => string | null) | undefined

  constructor(options: ApprovalControllerOptions) {
    this.getCurrentSessionId = options.getCurrentSessionId
    this.onChanged = options.onChanged
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.getCommandPrefix = options.getCommandPrefix
  }

  /** 是否有挂起的审批（handleKey 分支入口判断）。 */
  get isPending(): boolean {
    return this.pending !== null
  }

  /** C3 项 4：always-approve 模式激活标志（三态循环读写；退出/切会话时 app 侧复位）。 */
  get alwaysApprove(): boolean {
    return this.alwaysApproveFlag
  }

  /**
   * 设置 always-approve 模式（C3 项 4 三态循环；statusLine 徽标由 app 侧同步）。
   * @param flag - true 时当前会话的审批请求短路放行。
   */
  setAlwaysApprove(flag: boolean): void {
    this.alwaysApproveFlag = flag
  }

  /** 会话级工具白名单只读视图（渲染/调试用）。 */
  get allowedToolNames(): readonly string[] {
    return [...this.allowedTools]
  }

  /** 白名单是否命中该工具（handleKey 决定键位提示可省；短路判定以 handle 为准）。 */
  isToolAllowed(toolName: string): boolean {
    return this.allowedTools.has(toolName)
  }

  /** 把工具加入会话白名单（`t` 键；该工具后续请求自动放行）。 */
  allowTool(toolName: string): void {
    this.allowedTools.add(toolName)
  }

  /** 命令前缀是否已加白（调试/测试用；短路判定以 handle 为准）。 */
  isPrefixAllowed(prefix: string): boolean {
    return this.allowedPrefixes.has(prefix)
  }

  /** 把命令前缀加入会话白名单（`p` 键；bash 类同前缀请求后续自动放行）。 */
  allowCommandPrefix(prefix: string): void {
    this.allowedPrefixes.add(prefix)
  }

  /**
   * 清空会话级授权（工具白名单 + 命令前缀白名单；会话切换时 app 侧复位——
   * 白名单语义限于单个会话）。
   */
  clearSessionGrants(): void {
    this.allowedTools.clear()
    this.allowedPrefixes.clear()
  }

  /** 挂起请求的命令前缀（handle 时提取缓存；无挂起/非 bash 类 null）。 */
  get pendingCommandPrefix(): string | null {
    return this.pending?.prefix ?? null
  }

  /** 拒绝反馈输入态（f 键进入；结算时复位）。 */
  get feedbackMode(): boolean {
    return this.feedback
  }

  /**
   * 进入/退出拒绝反馈输入态（f 键 / Esc 返回选项态；不触发结算）。
   * @param flag - true 进入反馈输入态，false 返回选项态。
   */
  setFeedbackMode(flag: boolean): void {
    this.feedback = flag
  }

  /**
   * `t` 键复合操作：挂起请求的工具入会话白名单并结算 allowed-once。
   * @returns false = 无挂起（未结算）。
   */
  approveWithTool(): boolean {
    const pending = this.pending
    if (pending === null) return false
    this.allowTool(pending.req.toolName)
    this.settle('allowed-once')
    return true
  }

  /**
   * `p` 键复合操作：挂起请求的命令前缀入会话白名单并结算 allowed-once。
   * @returns false = 无挂起或无前缀可提（未结算）。
   */
  approveWithPrefix(): boolean {
    const prefix = this.pendingCommandPrefix
    if (prefix === null) return false
    this.allowCommandPrefix(prefix)
    this.settle('allowed-once')
    return true
  }

  /**
   * 审批 answerer 入口：短路放行 / 委托 next() / 挂起，三选一。
   * @param req - 待决审批请求（approval/request 事件 payload）。
   * @param next - waterfall 委托（不处理时调用；链上其他 answerer 兜底）。
   * @returns 用户决定（allowed-once/rejected/cancelled）或 next() 结果。
   */
  handle(req: PendingApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const current = this.getCurrentSessionId()
    // C3 项 4：always-approve 短路放行（不挂起提示，不消费 pendingApproval）。
    // 仅限当前会话：非当前会话的请求必须 next() 委托（apiproxy 等链上 answerer），
    // 否则 TUI 会截胡远端转发的审批。
    if (this.alwaysApproveFlag && req.agent.session.id === current) {
      return Promise.resolve('allowed-once')
    }
    // 任务4a：工具级会话白名单短路——`t` 键加过的工具自动放行，其他工具仍
    // 逐卡审批。作用域与 always-approve 相同（仅当前会话）。
    if (this.allowedTools.has(req.toolName) && req.agent.session.id === current) {
      return Promise.resolve('allowed-once')
    }
    // 决策分层阶段 2：命令前缀会话白名单短路——`p` 键加过的前缀自动放行。
    // 前缀在此一次性提取（transcript 查找 + JSON 解析），挂起后缓存复用。
    const prefix = req.agent.session.id === current
      ? this.getCommandPrefix?.(req) ?? null
      : null
    if (prefix !== null && this.allowedPrefixes.has(prefix)) {
      return Promise.resolve('allowed-once')
    }
    if (req.agent.session.id !== current || this.pending !== null) {
      return next()
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const signal = req.signal
      // 已撤销的请求不呈现、不挂起：asker 侧已把 abort 竞速为 cancelled，
      // 挂起只会让卡片滞留（UI/outcome 不一致）——直接 fail-closed 结算。
      if (signal !== undefined && signal.aborted) {
        resolve('cancelled')
        return
      }
      const onAbort = (): void => { this.settle('cancelled') }
      // 挂起超时：超过 timeoutMs 无人应答 → fail-closed 自动结算 cancelled，
      // 卡片不无限挂起（settle 时清除 timer，防用户结算后二次结算）。
      // 有限值守卫：Node setTimeout 对 > 2^31-1 ms 的值溢出为 1ms 立即触发。
      const timer = Number.isFinite(this.timeoutMs)
        ? setTimeout(() => { this.settle('cancelled') }, this.timeoutMs)
        : undefined
      this.pending = {
        req,
        resolve,
        since: Date.now(),
        prefix,
        timer,
        ...(signal !== undefined ? { onAbort } : {}),
      }
      // 挂起时监听请求撤销：agent 取消（abort）→ 自动结算 cancelled，
      // 与 asker 拿到的 cancelled 对齐，卡片经 onChanged 同步消失。
      signal?.addEventListener('abort', onAbort, { once: true })
      this.onChanged?.()
    })
  }

  /**
   * 结算挂起的审批请求（用户按键 y/N/Ctrl+C；会话卸载时 cancel 为 cancelled；
   * 请求 signal abort 时自动结算为 cancelled；挂起超过 timeoutMs 时自动结算为 cancelled）。
   * @param outcome - 用户决定。
   */
  settle(outcome: ApprovalOutcome): void {
    const pending = this.pending
    /* v8 ignore next -- settle 仅在 pendingApproval 非 null 的调用点可达 */
    if (pending === null) return
    this.pending = null
    // 拒绝反馈输入态随结算复位（与 question-controller settle 复位 feedback 同型）。
    this.feedback = false
    // 清除挂起超时 timer：已结算后不得再被超时二次结算
    // （timer 已触发时 clearTimeout 是 no-op，安全）。
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer)
    }
    // 移除挂起时注册的 abort 监听：用户已结算后 agent 再取消不得二次结算
    // （once 语义由 settle 侧保证，而非依赖 { once: true } 的时序）。
    const onAbort = pending.onAbort
    if (onAbort !== undefined) {
      pending.req.signal?.removeEventListener('abort', onAbort)
    }
    pending.resolve(outcome)
    this.onChanged?.()
  }

  /**
   * 当前挂起态快照（renderLive 审批段消费）。
   * @returns { req, since, feedbackMode }；无挂起 null。
   */
  peek(): ApprovalPeek | null {
    if (this.pending === null) return null
    return { req: this.pending.req, since: this.pending.since, feedbackMode: this.feedback }
  }
}
