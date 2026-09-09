/**
 * fork-agent — child create 的 setup 走 composeFrom。
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createForkedAgent } from '../src/adapter/fork-agent.js'

describe('createForkedAgent setup', () => {
  it('setup 对父 agent composeFrom', async () => {
    const composeFrom = vi.fn(() => 'standard')
    const parentCtx = { parent: 1 }
    const parent = {
      events: [], snapshotEvents(this: { events?: unknown[] }) { return this.events ?? [] },
      header: { cwd: '/w' },
      requestHeader: () => undefined,
    }
    const ctx = {
      agents: {
        get: vi.fn(() => ({ ctx: parentCtx })),
        create: vi.fn(async (opts: { setup?: (c: unknown) => void | Promise<void> }) => {
          await opts.setup?.({ on: vi.fn(() => () => {}) })
          return { agent: { session: parent }, dispose: vi.fn() }
        }),
      },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'p', model: 'm' })) },
      reflect: { get: vi.fn((name: string) => name === 'agentPresets' ? { mount: vi.fn(), composeFrom } : undefined) },
    }
    await createForkedAgent(ctx as never, parent as never, SessionId('session-parent'), '/w')
    expect(composeFrom).toHaveBeenCalledWith(expect.anything(), parentCtx)
  })
})
