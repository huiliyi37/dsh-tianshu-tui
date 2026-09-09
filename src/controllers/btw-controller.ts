/**
 * BtwController — /btw 侧问状态机（P1 提取，对齐 Question/Approval controller 模式）。
 *
 * 语义：用户可在主 agent 运行中途提出一个独立问题。btw 走本地 Cordis 旁路——
 * 从当前会话 fork 一个「最后完整 turn」的事件前缀（seed）创建临时 btw agent
 * （独立 session，不赋值 ownedHandle、不经过 switchSession），单轮问答后销毁。
 * 答案经 session/event 流收集（text-delta → turn/end 定稿），渲染快照经 peek()
 * 由 renderLive 消费；Esc 由 app 侧 handleKey 仲裁后调 dismiss()。
 *
 * 关键约束（与主对话流的隔离）：
 * - seed 只含完整 turn：fork 语义禁止 ending inside open turn（SessionStore.fork
 *   的 OPEN_TURN 检查同构）——主 agent 运行中（open turn）侧问不污染主上下文。
 * - 不持 ownedHandle：btw agent 是 registry 级旁路（switchSession 兜底分支同款），
 *   dispose 由本控制器在收尾时显式执行（dismiss/超时/完成）。
 * - 事件订阅按 btw session id 过滤，不干扰主会话的 streamFeed。
 *
 * 状态机：idle → loading → done | error →（dismiss）idle。
 * - done：答案定稿后等待 Esc 折叠（app 经 onAnswer 写 scrollback）。
 * - error：超时/失败后仍可 Esc 关闭。
 * - loading 时 Esc：取消并销毁 btw agent（无答案可写）。
 * 重叠保护：ask 期间再次 ask 静默忽略（一次只跑一个侧问）。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/controllers/btw-controller
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { controlsFromHandle } from '../adapter/send.js'
import { joinPreset, presetJoinFacet } from '../adapter/preset-join.js'

/** btw 挂起态快照（renderLive 消费；无挂起时 peek() 返回 null）。 */
export interface BtwPeek {
  /** loading：等待答案；done：答案定稿待折叠；error：超时/失败。 */
  status: 'loading' | 'done' | 'error'
  /** 侧问原文（用户输入，不经 @mention 展开）。 */
  question: string
  /** done 时的答案全文（text-delta 拼接；可为空串）。 */
  answer?: string
  /** error 时的失败信息。 */
  error?: string
}

/** BtwController 的依赖注入（服务上下文、活跃会话读取、状态回调、超时）。 */
export interface BtwControllerOptions {
  /** 服务上下文（agents.create / sessions.get / on 消费）。 */
  ctx: Context
  /** 当前活跃会话 id 读取（app 注入；null = 无会话，/btw 不可用）。 */
  activeSessionId: () => SessionId | null
  /** 状态实际变化（发起/完成/失败/关闭）后回调（app 侧触发重绘）。 */
  onChanged?: () => void
  /** 答案折叠回调（Esc 关闭 done 态时调用；app 写 scrollback 持久化）。 */
  onAnswer?: (entry: { question: string; answer: string }) => void
  /** 等待超时毫秒数（loading 超过即 error；缺省 30_000）。 */
  timeoutMs?: number
}

/**
 * 从会话事件日志计算 btw 的 fork seed：最后一个 turn/end 之前的完整前缀。
 * fork 语义要求 seed 是 balanced completed-turn prefix（SessionStore.fork 的
 * OPEN_TURN 检查同构）——主 agent 运行中（open turn）时截到上一个完整 turn，
 * 无任何完整 turn 时为空 seed（btw 从零上下文开始）。
 * @param events - 源会话事件日志（seq 连续从 0 开始，数组下标即 seq）。
 * @returns 完整 turn 前缀（可直接作 agents.create 的 seed）。
 */
export function completedTurnSeed(events: readonly SessionEvent[]): readonly SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && event.type === 'turn/end') {
      return events.slice(0, i + 1)
    }
  }
  return []
}

/**
 * /btw 侧问状态机：fork 完整 turn 前缀创建临时 btw agent，单轮问答后销毁；
 * 状态流 idle → loading → done|error →（dismiss）idle（见模块注释约束）。
 */
export class BtwController {
  private state: BtwPeek | null = null
  /** 当前 btw agent 的 owned handle（本控制器持有，收尾时 dispose）。 */
  private handle: AgentHandle | null = null
  /** btw session 事件订阅 disposer（随收尾释放）。 */
  private feed: (() => void) | null = null
  /** loading 超时定时器（finish/fail/dismiss 时清除）。 */
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly ctx: Context
  private readonly activeSessionId: () => SessionId | null
  private readonly onChanged: (() => void) | undefined
  private readonly onAnswer: ((entry: { question: string; answer: string }) => void) | undefined
  private readonly timeoutMs: number

  constructor(options: BtwControllerOptions) {
    this.ctx = options.ctx
    this.activeSessionId = options.activeSessionId
    this.onChanged = options.onChanged
    this.onAnswer = options.onAnswer
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** 是否有挂起的侧问（handleKey Esc 分支入口判断）。 */
  get isActive(): boolean {
    return this.state !== null
  }

  /**
   * 当前挂起态快照（renderLive btw 段消费）。
   * @returns 挂起态；无挂起侧问为 null。
   */
  peek(): BtwPeek | null {
    return this.state
  }

  /**
   * 发起一次侧问：fork 完整 turn 前缀 → agents.create（btw session，不持
   * ownedHandle）→ 订阅答案流 → followup 单轮。已有挂起时静默忽略（一次一个）。
   * @param question - 侧问文本（已 trim；空文本由命令层拦截）。
   * @throws 无活跃会话/会话不存在/创建失败（命令分发层回显失败）。
   */
  async ask(question: string): Promise<void> {
    if (this.state !== null) return
    const activeId = this.activeSessionId()
    if (activeId === null) throw new Error('当前无活跃会话，无法发起侧问')
    const session = this.ctx.sessions.get(activeId)
    if (session === undefined) throw new Error(`unknown session: ${activeId}`)
    const btwId = SessionId(`session-btw-${randomUUID()}`)
    const seed = completedTurnSeed(session.snapshotEvents())
    const selection = this.ctx.agentDefaultModel.currentSelection()
    // 与 SessionStore.fork 同构：继承父会话 cwd（无则回退启动目录），并记下血缘。
    // 缺 cwd 的 btw 会话同样会掉进 `_no-cwd/`，Web 列表不可见（issue #5）。
    const parentAgent = this.ctx.agents.get(activeId)
    const handle = await this.ctx.agents.create({
      sessionId: btwId,
      seed,
      meta: {
        cwd: session.header.cwd ?? process.cwd(),
        parentSession: activeId,
        isSeeded: seed.length > 0,
      },
      inheritedEventCount: SessionLogOffset(seed.length),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await joinPreset({
          facet: presetJoinFacet(this.ctx),
          agentCtx,
          mode: 'child',
          parentCtx: parentAgent?.ctx,
        })
      },
    })
    // 答案流订阅：text-delta 收集进 buffer，turn/end 定稿（与主会话 streamFeed
    // 同款事件词汇，按 btw session id 过滤，互不干扰）。
    const buffer: string[] = []
    const feed = this.ctx.on('session/event', (owner: { id: SessionId }, event: SessionEvent) => {
      if (owner.id !== btwId) return
      if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
        buffer.push(event.data.chunk.text)
      } else if (event.type === 'turn/end') {
        this.finish(buffer.join(''))
      }
    })
    this.handle = handle
    this.feed = feed
    this.state = { status: 'loading', question }
    this.timer = setTimeout(() => { this.fail('等待侧问回答超时（无响应）') }, this.timeoutMs)
    try {
      await controlsFromHandle(handle).followup(question)
    } catch (err) {
      this.teardown()
      this.state = null
      throw err
    }
    this.onChanged?.()
  }

  /**
   * 关闭挂起的侧问（Esc/Ctrl+C）。done 态把答案折叠进 scrollback（onAnswer
   * 回调）；loading 态取消并销毁 btw agent；error 态直接清除。
   */
  dismiss(): void {
    const current = this.state
    if (current === null) return
    if (current.status === 'done') {
      this.onAnswer?.({ question: current.question, answer: current.answer ?? '' })
    }
    this.teardown()
    this.state = null
    this.onChanged?.()
  }

  /**
   * 总清理（app dispose 时）：未决侧问（loading/error）直接销毁 btw agent，
   * done 态不折叠（答案未确认，丢弃——退出即弃，与 always-approve 同生命周期）。
   */
  dispose(): void {
    if (this.state === null) return
    this.teardown()
    this.state = null
  }

  /** 答案定稿（turn/end 触发）：释放订阅与 agent（turn 已结束，dispose 安全）。 */
  private finish(answer: string): void {
    const current = this.state
    // 已关闭/已失败后的迟到 turn/end（teardown 已释放订阅，理论上不可达；
    // 防御同会话事件在释放窗口内并发到达）。
    if (current === null || current.status !== 'loading') return
    this.teardown()
    this.state = { status: 'done', question: current.question, answer }
    this.onChanged?.()
  }

  /** 失败（超时）：销毁 btw agent，置 error 态（Esc 关闭）。 */
  private fail(message: string): void {
    const current = this.state
    if (current === null || current.status !== 'loading') return
    this.teardown()
    this.state = { status: 'error', question: current.question, error: message }
    this.onChanged?.()
  }

  /** 释放订阅 + dispose btw agent handle（幂等：收尾后再次调用 no-op）。 */
  private teardown(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    this.feed?.()
    this.feed = null
    const handle = this.handle
    this.handle = null
    if (handle !== null) void handle.dispose()
  }
}
