/**
 * 用户面 /fork /branch：用 agents.create({ seed, meta }) 铸 child，
 * 避免 sessions.fork 后再 resume 触发「cannot prepare session while it is live」。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/adapter/fork-agent
 */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import { type AgentHandle } from '@deepseek-ai/dsh-agent';
export interface ForkedAgent {
    childId: SessionId;
    handle: AgentHandle;
}
/**
 * 从父会话铸一个带历史的 child agent（create 失败不改父会话）。
 * @param ctx - 提供 agents.create / agentDefaultModel。
 * @param parent - 源 live 会话。
 * @param parentSessionId - 血缘 id（当前活跃会话，不一定等于 parent.id）。
 * @param fallbackCwd - header.cwd 缺失时的工作区。
 */
export declare function createForkedAgent(ctx: Context, parent: Session, parentSessionId: SessionId, fallbackCwd: string): Promise<ForkedAgent>;
