/**
 * fork-agent — child create 的 preset、模型继承与 rc.1 setup 接线。
 */
import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createForkedAgent } from '../src/adapter/fork-agent.js'

describe('createForkedAgent', () => {
  it('优先继承父 Agent 的 pending 完整选择，setup 只安装提示并 composeFrom', async () => {
    const composeFrom = vi.fn(() => 'standard')
    const parentCtx = { parent: 1 }
    const pending = { provider: 'parent-p', model: 'pending-m', reasoningEffort: ReasoningEffortId('low') }
    const parentAgent = {
      ctx: parentCtx,
      model: { current: vi.fn(() => pending), select: vi.fn() },
    }
    const parent = {
      events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
      header: { cwd: '/w' },
      requestHeader: () => ({ config: { provider: 'used-p', model: 'used-m', reasoningEffort: 'high' } }),
    }
    const agentCtx = { on: vi.fn((_name: string, _handler: unknown) => () => { }) }
    const ctx = {
      agents: {
        get: vi.fn(() => parentAgent),
        create: vi.fn(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
          await opts.setup?.(agentCtx)
          return { agent: { session: parent }, dispose: vi.fn() }
        }),
      },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'default-p', model: 'default-m' })) },
      reflect: { get: vi.fn((name: string) => name === 'agentPresets' ? { mount: vi.fn(), composeFrom } : undefined) },
    }

    const result = await createForkedAgent(ctx as never, parent as never, SessionId('session-parent'), '/w')

    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: pending,
      seed: parent.events,
    }))
    expect(ctx.agentDefaultModel.currentSelection).not.toHaveBeenCalled()
    expect(agentCtx.on.mock.calls.map(call => call[0])).toEqual(['agent/pre-step'])
    expect(composeFrom).toHaveBeenCalledWith(expect.anything(), parentCtx)
    expect(result).not.toHaveProperty('ref')
  })

  it('父 Agent 不在 registry 时以 request header 构造完整 fallback', async () => {
    const parent = {
      events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
      header: { cwd: '/w' },
      requestHeader: () => ({ config: { provider: 'used-p', model: 'used-m', reasoningEffort: 'high' } }),
    }
    const ctx = {
      agents: {
        get: vi.fn(() => undefined),
        create: vi.fn(async () => ({ agent: { session: parent }, dispose: vi.fn() })),
      },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'default-p', model: 'default-m' })) },
      reflect: { get: vi.fn(() => undefined) },
    }

    await createForkedAgent(ctx as never, parent as never, SessionId('session-parent'), '/w')

    expect(ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'used-p', model: 'used-m', reasoningEffort: 'high' },
    }))
    expect(ctx.agentDefaultModel.currentSelection).not.toHaveBeenCalled()
  })
})
