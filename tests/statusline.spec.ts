import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import {
  emptyWorkflowView,
  applyWorkflowEvent,
  inferPhaseFromTool,
  formatStatusLine,
  WorkflowStatusLine,
} from '../src/statusline.js'

const sid = 'test-session-1' as SessionId

function ev(partial: SessionEvent): SessionEvent {
  return partial
}

function turnStart(seq: number, turn: number): SessionEvent {
  return ev({ seq: SessionSeq(seq), time: 1000 + seq, type: 'turn/start', data: { turn } })
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return ev({ seq: SessionSeq(seq), time: 1000 + seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

function toolCall(seq: number, callId: string, name: string, raw: string, turn: number, step: number): SessionEvent {
  return ev({
    seq: SessionSeq(seq),
    time: 1000 + seq,
    type: 'tool/call',
    data: { callId: callId as ToolCallId, name, arguments: raw, turn, step },
  })
}

function todoWrite(seq: number): SessionEvent {
  return ev({ seq: SessionSeq(seq), time: 1000 + seq, type: 'todo/write', data: { todos: [] } })
}

describe('inferPhaseFromTool', () => {
  it('maps read/search tools to research (调研)', () => {
    for (const name of ['read_file', 'grep', 'glob', 'semantic_search', 'web_fetch']) {
      expect(inferPhaseFromTool(name)).toBe('research')
    }
  })

  it('maps write/edit tools to implement (实施)', () => {
    for (const name of ['edit_file', 'write_file', 'apply_patch', 'bash']) {
      expect(inferPhaseFromTool(name)).toBe('implement')
    }
  })

  it('maps run_tests to verify (验证)', () => {
    expect(inferPhaseFromTool('run_tests')).toBe('verify')
  })

  it('returns undefined for unknown tools (不改变阶段)', () => {
    expect(inferPhaseFromTool('mystery_tool')).toBeUndefined()
  })
})

describe('applyWorkflowEvent', () => {
  it('starts a turn in understand phase (理解)', () => {
    const view = applyWorkflowEvent(emptyWorkflowView(sid), turnStart(1, 3))
    expect(view.phase).toBe('understand')
    expect(view.turn).toBe(3)
  })

  it('projects tool/call into the current phase and activity', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, toolCall(2, 'c1', 'grep', '{"pattern":"foo"}', 1, 0))
    expect(view.phase).toBe('research')
    expect(view.activity).toEqual({ name: 'grep', arguments: '{"pattern":"foo"}', turn: 1, step: 0 })
  })

  it('shifts to implement on edit tools', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, toolCall(2, 'c1', 'edit_file', '{}', 1, 0))
    expect(view.phase).toBe('implement')
  })

  it('todo/write sets decompose phase (拆解)', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, todoWrite(2))
    expect(view.phase).toBe('decompose')
  })

  it('turn/end completed sets wrapup phase (收尾)', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, turnEnd(2, 1))
    expect(view.phase).toBe('wrapup')
  })

  it('unknown tool does not change the phase', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, toolCall(2, 'c1', 'mystery', '{}', 1, 0))
    expect(view.phase).toBe('understand')
  })
})

describe('formatStatusLine', () => {
  it('renders phase and active tool name', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, toolCall(2, 'c1', 'grep', '{}', 1, 0))
    expect(formatStatusLine(view)).toContain('调研')
    expect(formatStatusLine(view)).toContain('grep')
  })

  it('renders idle when no activity', () => {
    const view = emptyWorkflowView(sid)
    expect(formatStatusLine(view)).toContain('理解')
  })
})

describe('formatStatusLine plan 徽标（T1.4）', () => {
  it('planActive 时渲染 [plan] 徽标，非 active 不渲染', () => {
    expect(formatStatusLine(emptyWorkflowView(sid), true)).toContain('[plan]')
    expect(formatStatusLine(emptyWorkflowView(sid), false)).not.toContain('[plan]')
  })

  it('plan 徽标与阶段/活动并存', () => {
    let view = emptyWorkflowView(sid)
    view = applyWorkflowEvent(view, turnStart(1, 1))
    view = applyWorkflowEvent(view, toolCall(2, 'c1', 'grep', '{}', 1, 0))
    const text = formatStatusLine(view, true)
    expect(text).toContain('[plan]')
    expect(text).toContain('调研')
    expect(text).toContain('grep')
  })

  it('pending 切换时渲染 [plan…]（A1：轮内切换待生效反馈）', () => {
    // 进入 plan 模式待生效：active 还是旧值 false，pending 提示意图
    expect(formatStatusLine(emptyWorkflowView(sid), false, true)).toContain('[plan…]')
    // 退出 plan 模式待生效：active 仍 true，pending 提示退出意图
    expect(formatStatusLine(emptyWorkflowView(sid), true, true)).toContain('[plan…]')
    // pending 优先级高于 active 徽标：不渲染稳定的 [plan]
    expect(formatStatusLine(emptyWorkflowView(sid), true, true)).not.toContain('[plan] ')
  })

  it('非 pending 非 active 不渲染徽标', () => {
    expect(formatStatusLine(emptyWorkflowView(sid), false, false)).not.toContain('plan')
  })
})

describe('formatStatusLine 授权模式徽标', () => {
  it('approvalPolicy never → [yolo]（宿主 user-approval 的 never = 自动拒绝，非放行）', () => {
    expect(formatStatusLine(emptyWorkflowView(sid), false, false, false, 'never')).toContain('[yolo]')
  })

  it('approvalPolicy ask（显式记录）→ [ask]', () => {
    expect(formatStatusLine(emptyWorkflowView(sid), false, false, false, 'ask')).toContain('[ask]')
  })

  it('policy 未记录（null）→ 不渲染授权徽标', () => {
    const text = formatStatusLine(emptyWorkflowView(sid))
    expect(text).not.toContain('[yolo]')
    expect(text).not.toContain('[ask]')
  })

  it('permission preset 装配 → 预设名徽标优先于 policy', () => {
    const text = formatStatusLine(emptyWorkflowView(sid), false, false, false, 'never', 'danger-full-access')
    expect(text).toContain('[danger-full-access]')
    expect(text).not.toContain('[yolo]')
  })

  it('授权徽标与 [plan]/[auto] 并存', () => {
    const text = formatStatusLine(emptyWorkflowView(sid), true, false, true, 'never')
    expect(text).toContain('[plan]')
    expect(text).toContain('[auto]')
    expect(text).toContain('[yolo]')
  })
})

describe('WorkflowStatusLine (自包含事件订阅)', () => {
  interface CapturedHandler {
    (...args: unknown[]): void
  }

  function fakeCtx() {
    const handlers = new Map<string, CapturedHandler[]>()
    const ctx = {
      on: vi.fn((channel: string, handler: CapturedHandler) => {
        const list = handlers.get(channel) ?? []
        list.push(handler)
        handlers.set(channel, list)
        return () => { /* noop */ }
      }),
      handlers,
    }
    return { ctx: ctx as unknown as Context & { on: ReturnType<typeof vi.fn> }, handlers }
  }

  it('subscribes to agent/status and session/event', () => {
    const { ctx } = fakeCtx()
    new WorkflowStatusLine(ctx, sid, () => { /* noop */ })
    expect(ctx.on).toHaveBeenCalledWith('agent/status', expect.any(Function))
    expect(ctx.on).toHaveBeenCalledWith('session/event', expect.any(Function))
  })

  it('updates from session/event tool/call projections', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))

    const sessionHandler = handlers.get('session/event')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')
    sessionHandler({ id: sid }, turnStart(1, 1))
    sessionHandler({ id: sid }, toolCall(2, 'c1', 'grep', '{}', 1, 0))

    expect(line.current).not.toBeNull()
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates[updates.length - 1]).toContain('grep')
  })

  it('ignores session/event for other sessions', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))

    const sessionHandler = handlers.get('session/event')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')
    sessionHandler({ id: 'other-session' as SessionId }, toolCall(2, 'c1', 'grep', '{}', 1, 0))

    expect(updates).toHaveLength(0)
    expect(line.current).toBeNull()
  })

  it('dispose detaches subscriptions', () => {
    const { ctx } = fakeCtx()
    const line = new WorkflowStatusLine(ctx, sid, () => { /* noop */ })
    expect(() =>{  line.dispose() }).not.toThrow()
  })

  it('setPlanState 切换 [plan] 徽标并推送更新（T1.4 + A1）', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))
    const sessionHandler = handlers.get('session/event')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')
    sessionHandler({ id: sid }, turnStart(1, 1))
    updates.length = 0

    line.setPlanState({ active: true, pending: false })
    expect(updates[updates.length - 1]).toContain('[plan]')
    expect(line.current).toContain('[plan]')

    // 幂等：相同值不重复推送
    line.setPlanState({ active: true, pending: false })
    expect(updates).toHaveLength(1)

    // pending 切换待生效：渲染 [plan…]
    line.setPlanState({ active: true, pending: true })
    expect(updates[updates.length - 1]).toContain('[plan…]')
    expect(line.current).toContain('[plan…]')

    line.setPlanState({ active: false, pending: false })
    expect(updates[updates.length - 1]).not.toContain('plan')
    expect(line.current).not.toContain('plan')
  })

  it('折叠 approval/policy 与 permission/preset 事件为授权徽标', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))
    const sessionHandler = handlers.get('session/event')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')

    sessionHandler({ id: sid }, ev({ seq: SessionSeq(1), time: 1000, type: 'approval/policy', data: { policy: 'never' } }))
    expect(updates[updates.length - 1]).toContain('[yolo]')
    expect(line.current).toContain('[yolo]')

    // preset 装配后优先显示预设名，policy 徽标让位
    sessionHandler({ id: sid }, ev({ seq: SessionSeq(2), time: 1001, type: 'permission/preset', data: { preset: 'danger-full-access' } }))
    expect(updates[updates.length - 1]).toContain('[danger-full-access]')
    expect(updates[updates.length - 1]).not.toContain('[yolo]')
    expect(line.current).toContain('[danger-full-access]')
  })

  it('其他会话的 approval/policy 事件不折叠（会话隔离）', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))
    const sessionHandler = handlers.get('session/event')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')

    sessionHandler({ id: 'other-session' as SessionId }, ev({ seq: SessionSeq(1), time: 1000, type: 'approval/policy', data: { policy: 'never' } }))
    expect(updates).toHaveLength(0)
    expect(line.current).toBeNull()
  })

  it('A5：turn/end 收尾在 agent idle 时不占据状态行（回到空闲不占位）', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))
    const sessionHandler = handlers.get('session/event')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')

    sessionHandler({ id: sid }, turnStart(1, 1))
    sessionHandler({ id: sid }, turnEnd(2, 1))
    // agent 默认 idle：收尾相位保留在视图里，但状态行回到空闲（null，不占位）。
    expect(updates[updates.length - 1]).toBeNull()
    expect(line.current).toBeNull()
  })

  it('A5：agent running 时 turn/end 仍显示收尾；completed 后清除', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))
    const sessionHandler = handlers.get('session/event')?.[0]
    const statusHandler = handlers.get('agent/status')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')
    if (statusHandler === undefined) throw new Error('agent/status handler not registered')

    statusHandler({ agent: { id: sid }, status: 'running' })
    sessionHandler({ id: sid }, turnStart(1, 1))
    sessionHandler({ id: sid }, turnEnd(2, 1))
    expect(line.current).toContain('收尾')

    statusHandler({ agent: { id: sid }, status: 'completed' })
    expect(line.current).toBeNull()
    expect(updates[updates.length - 1]).toBeNull()
  })

  it('A5：idle+wrapup 时授权/模式徽标仍保留（不整体清空——安全反馈不消失）', () => {
    const { ctx, handlers } = fakeCtx()
    const updates: (string | null)[] = []
    const line = new WorkflowStatusLine(ctx, sid, text => updates.push(text))
    const sessionHandler = handlers.get('session/event')?.[0]
    const statusHandler = handlers.get('agent/status')?.[0]
    if (sessionHandler === undefined) throw new Error('session/event handler not registered')
    if (statusHandler === undefined) throw new Error('agent/status handler not registered')

    sessionHandler({ id: sid }, turnStart(1, 1))
    sessionHandler({ id: sid }, turnEnd(2, 1))
    // 无徽标：空闲不占位（与既有 A5 语义一致）
    expect(line.current).toBeNull()

    // always-approve 开启：徽标在 idle+wrapup 下仍可见，但"收尾"阶段文本隐藏
    line.setAlwaysApprove(true)
    expect(line.current).toContain('[auto]')
    expect(line.current).not.toContain('收尾')

    // plan 徽标同理
    line.setPlanState({ active: true, pending: false })
    expect(line.current).toContain('[plan]')
    expect(line.current).not.toContain('收尾')

    // permission preset 徽标（安全可见性关键）在 idle 下保留
    sessionHandler({ id: sid }, ev({ seq: SessionSeq(3), time: 1002, type: 'permission/preset', data: { preset: 'danger-full-access' } }))
    expect(line.current).toContain('[danger-full-access]')

    // running 恢复后回到完整阶段文本（收尾 + 徽标）
    statusHandler({ agent: { id: sid }, status: 'running' })
    expect(line.current).toContain('收尾')
    expect(line.current).toContain('[plan]')
    expect(line.current).toContain('[danger-full-access]')
  })
})
