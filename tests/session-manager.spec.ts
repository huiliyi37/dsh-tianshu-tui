/**
 * session-manager 单测：AgentOptions fallback 与 rc.1 持久化模型选择。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/tests/session-manager
 */

import { describe, expect, it, vi } from 'vitest'
import { AgentModel, modelSelectionProjectionDefinition, type ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { resumeModelSelection } from '../src/controllers/session-manager.js'

function readModelState(session: Session): ModelSelectionProjectionState {
  let state = modelSelectionProjectionDefinition.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) {
    state = modelSelectionProjectionDefinition.apply(state, event)
  }
  return state
}

describe('resumeModelSelection', () => {
  it('有持久化路由时原样采用，不调用 fallback', () => {
    const fallback = vi.fn(() => ({ provider: 'default', model: 'd' }))
    expect(resumeModelSelection({ provider: 'p', model: 'm' }, fallback)).toEqual({ provider: 'p', model: 'm' })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('持久化路由带 reasoningEffort 时一并带上（AgentOptions 保留完整初始选择）', () => {
    expect(
      resumeModelSelection({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }, () => ({ provider: 'x', model: 'y' })),
    ).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('缺 reasoningEffort 时不落该键（条件展开，非 undefined 值）', () => {
    const selection = resumeModelSelection({ provider: 'p', model: 'm' }, () => ({ provider: 'x', model: 'y' }))
    expect('reasoningEffort' in selection).toBe(false)
  })

  it('无持久化路由（从未成功发起请求的会话）落 fallback', () => {
    const fallback = vi.fn(() => ({ provider: 'cur', model: 'cur-m' }))
    expect(resumeModelSelection(undefined, fallback)).toEqual({ provider: 'cur', model: 'cur-m' })
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('AgentModel seed 恢复', () => {
  it('完整 seed 中 pending 覆盖旧 request header 与新 AgentOptions', () => {
    const parent = Session.create(SessionId('session-model-parent'))
    parent.append('request/header', {
      header: canonicalHeader({
        config: { provider: 'used-p', model: 'used-m', reasoningEffort: ReasoningEffortId('high') },
      }),
      reason: 'initial',
    })
    const parentModel = new AgentModel(() => readModelState(parent), parent, { provider: 'parent-option', model: 'parent-option' })
    const pending = { provider: 'pending-p', model: 'pending-m', reasoningEffort: ReasoningEffortId('low') }
    parentModel.select(pending)

    const seed = parent.snapshotEvents()
    const child = Session.create(
      SessionId('session-model-child'),
      seed,
      { ...parent.header, id: SessionId('session-model-child'), isSeeded: true },
      SessionLogOffset(seed.length),
    )
    const childModel = new AgentModel(() => readModelState(child), child, { provider: 'new-default', model: 'new-default' })

    expect(child.requestHeader()?.config).toMatchObject({ provider: 'used-p', model: 'used-m', reasoningEffort: 'high' })
    expect(childModel.current()).toEqual(pending)
  })
})
