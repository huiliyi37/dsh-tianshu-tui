/**
 * 用户面 /fork /branch：用 agents.create({ seed, meta }) 铸 child，
 * 避免 sessions.fork 后再 resume 触发「cannot prepare session while it is live」。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/adapter/fork-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { installModelSelection, type AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { randomUUID } from 'node:crypto'
import { resumeModelSelection } from '../controllers/session-manager.js'
import { forkAgentSpec } from './sessions.js'
import { joinPreset, presetJoinFacet } from './preset-join.js'

export interface ForkedAgent {
  childId: SessionId
  handle: AgentHandle
}

/**
 * 从父会话铸一个带历史的 child agent（create 失败不改父会话）。
 * @param ctx - 提供 agents.create / agentDefaultModel。
 * @param parent - 源 live 会话。
 * @param parentSessionId - 血缘 id（当前活跃会话，不一定等于 parent.id）。
 * @param fallbackCwd - header.cwd 缺失时的工作区。
 */
export async function createForkedAgent(
  ctx: Context,
  parent: Session,
  parentSessionId: SessionId,
  fallbackCwd: string,
): Promise<ForkedAgent> {
  const spec = forkAgentSpec(parent, fallbackCwd, parentSessionId)
  const parentAgent = ctx.agents.get(parentSessionId)
  // live Agent 的 pending 选择优先；seed 由 AgentModel 自己折出 pending/lastUsed，
  // agentOptions 只兜底 options-only 或 registry 中已不存在父 agent 的情况。
  const selection = parentAgent?.model?.current() ?? resumeModelSelection(
    parent.requestHeader()?.config,
    () => ctx.agentDefaultModel.currentSelection(),
  )
  const childId = SessionId(`session-${randomUUID()}`)
  const handle = await ctx.agents.create({
    sessionId: childId,
    seed: spec.seed,
    meta: spec.meta,
    inheritedEventCount: spec.inheritedEventCount,
    agentOptions: { ...selection },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx)
      await joinPreset({
        facet: presetJoinFacet(ctx),
        agentCtx,
        mode: 'child',
        parentCtx: parentAgent?.ctx,
      })
    },
  })
  return { childId, handle }
}
