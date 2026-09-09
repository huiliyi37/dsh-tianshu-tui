/**
 * SessionManager — 多会话 side conversation 快照层（P3）。
 *
 * 会话快照从 live store 派生（不重复存储）：ctx.sessions.list() 是权威来源
 * （AgentRegistry 多 agent 并存 + SessionStore 多 session 天然支持），本层只
 * 做「session → 投影元数据」的派生与状态查询。tab 栏渲染消费 list()。
 *
 * 会话生命周期归属：agent 由 agent-loop factory 持有（TuiApp 切换时经
 * detachProjections({ keepHandle: true }) 让渡所有权给 registry）；本层不
 * 创建/销毁会话——退出时由 factory 统一 teardown。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/controllers/session-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** 会话投影元数据（tab 栏/列表渲染消费；不存完整 transcript）。 */
export interface SessionSnapshot {
  id: SessionId
  /** agent 生命周期状态（running = 有驱动活动）。 */
  status: 'idle' | 'running'
  /** 事件条数（live session 的事件日志长度）。 */
  messageCount: number
}

/** resume 定路输入：会话持久化 request header 的路由段（缺 reasoningEffort 视为未定）。 */
export interface PersistedRouteConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

/**
 * resume 模型定路：持久化 request header 优先（跨重启续模），无 header
 * （从未成功发起请求的会话）才落 agentDefaultModel 当前选择。
 * @param persisted - 目标会话的持久化路由段；undefined = 无 header。
 * @param fallback - 缺省选择的惰性取值（仅无持久化路由时调用，避免多余读取）。
 * @returns resume 使用的模型选择。
 */
export function resumeModelSelection(persisted: PersistedRouteConfig | undefined, fallback: () => ModelSelection): ModelSelection {
  if (persisted === undefined) return fallback()
  return {
    provider: persisted.provider,
    model: persisted.model,
    ...persisted.reasoningEffort === undefined ? {} : { reasoningEffort: persisted.reasoningEffort },
  }
}

/** 多会话快照层：从 live store（ctx.sessions/ctx.agents）派生投影元数据，不持有会话生命周期。 */
export class SessionManager {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * 全部 live 会话的投影快照（live store 派生；按创建序）。
   * @returns 每个 live 会话一条 SessionSnapshot。
   */
  list(): SessionSnapshot[] {
    const sessions = this.ctx.sessions.list()
    const snapshots: SessionSnapshot[] = []
    for (const session of sessions) {
      snapshots.push({
        id: session.id,
        status: this.ctx.agents.get(session.id)?.status ?? 'idle',
        messageCount: session.snapshotEvents().length,
      })
    }
    return snapshots
  }

  /**
   * 某会话的 agent 状态（无 live agent 视为 idle）。
   * @param id - 会话 id。
   * @returns 'running' 或 'idle'。
   */
  statusOf(id: SessionId): 'idle' | 'running' {
    return this.ctx.agents.get(id)?.status ?? 'idle'
  }
}
