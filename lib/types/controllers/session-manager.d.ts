/**
 * create/resume 的 AgentOptions 模型 fallback。
 *
 * rc.1 的 AgentModel 自行按 pending model/selection → lastUsed request header →
 * AgentOptions 恢复选择。本文件只把持久化 request header 的路由段整理成完整
 * ModelSelection，供调用方构造 AgentOptions；普通 resume 不得再用它调 select()，
 * 否则可能覆盖尚未使用的 pending 选择。
 *
 * 与 `adapter/sessions.ts` 的分工：那里负责会话列表 / 分叉 / 历史加载，本文件
 * 只做「持久化路由段 → AgentOptions fallback」这一步，不读会话日志、不触发副作用。
 *
 * 历史注：本文件原名 session-manager.ts，曾承载 P3 的 `SessionManager` 多会话
 * 快照层（为未落地的 tab 栏准备）。该层从未被任何生产代码消费（TUI 至今是单
 * live-agent 模型），已随死代码清理移除——多会话 tab 栏若将来落地，应由真实
 * 消费方驱动设计，而不是复活旧账。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/controllers/session-manager
 */
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
/** AgentOptions fallback 输入：会话持久化 request header 的路由段。 */
export interface PersistedRouteConfig {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
}
/**
 * 构造 AgentOptions fallback：有 request header 时沿用其完整路由，无 header
 * （从未成功发起请求的会话）才取 agentDefaultModel 当前选择。
 * @param persisted - 目标会话的持久化路由段；undefined = 无 header。
 * @param fallback - 缺省选择的惰性取值（仅无持久化路由时调用，避免多余读取）。
 * @returns 保留显式 reasoningEffort 的初始模型选择。
 */
export declare function resumeModelSelection(persisted: PersistedRouteConfig | undefined, fallback: () => ModelSelection): ModelSelection;
