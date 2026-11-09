/**
 * adapter/tool-view — presenter 桥软降级契约测试。
 *
 * 桥的全部失败路径都必须归于「无意图」空对象：tools 服务缺失、工具未注册、
 * scoped 调用缺 Agent scope、参数 JSON 不可解析、presenter 抛错或返回 undefined。
 * 成功路径转发 scope，把 presentCall / presentResult 的产物原样透出，meta 从事件
 * 透传给 presentResult。展示层失败绝不冒泡（会话流不受渲染意图影响）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolPresenterSource } from '../src/adapter/tool-view.js'
import { resolveToolViews } from '../src/adapter/tool-view.js'

function sourceWith(definition: ReturnType<ToolPresenterSource['get']>): ToolPresenterSource {
  return { get: (name: string) => (name === 'bash' ? definition : undefined) }
}

const REQUEST = { name: 'bash', argumentsRaw: '{"command":"ls"}' }
const RESULT = {
  content: [{ type: 'text' as const, text: 'file.txt' }],
  isError: false,
}

describe('resolveToolViews', () => {
  it('tools 服务缺失 → 空意图', () => {
    expect(resolveToolViews(undefined, REQUEST)).toEqual({})
  })

  it('工具未注册 → 空意图', () => {
    expect(resolveToolViews(sourceWith(undefined), { ...REQUEST, name: 'ghost' })).toEqual({})
  })

  it('presentCall + presentResult 意图透出；meta 透传', () => {
    const presentResult = vi.fn(() => ({ card: 'terminal' as const, title: 'ls', output: 'file.txt' }))
    const views = resolveToolViews(sourceWith({
      presentCall: () => ({ card: 'terminal' as const, title: 'ls' }),
      presentResult,
    }), { ...REQUEST, result: { ...RESULT, meta: { exitCode: 0 } } })
    expect(views.call).toEqual({ card: 'terminal', title: 'ls' })
    expect(views.result).toEqual({ card: 'terminal', title: 'ls', output: 'file.txt' })
    expect(presentResult).toHaveBeenCalledWith(
      { command: 'ls' },
      { content: RESULT.content, isError: false, meta: { exitCode: 0 } },
    )
  })

  it('Agent scope 转发给 tools.get；缺 scope 的 scoped 工具降级', () => {
    const scope = {} as Agent
    const get = vi.fn((name: string, agent?: Agent) => (name === 'bash' && agent === scope ? {
      presentCall: () => ({ card: 'generic' as const, title: 'Scoped run' }),
    } : undefined))
    const tools: ToolPresenterSource = { get }
    expect(resolveToolViews(tools, REQUEST)).toEqual({})
    expect(resolveToolViews(tools, { ...REQUEST, scope }).call).toEqual({ card: 'generic', title: 'Scoped run' })
    expect(get).toHaveBeenNthCalledWith(1, 'bash', undefined)
    expect(get).toHaveBeenNthCalledWith(2, 'bash', scope)
  })

  it('无 result 请求只解析 presentCall', () => {
    const presentResult = vi.fn()
    const views = resolveToolViews(sourceWith({
      presentCall: () => ({ card: 'generic' as const, title: 'Run' }),
      presentResult,
    }), REQUEST)
    expect(views.call?.title).toBe('Run')
    expect(views.result).toBeUndefined()
    expect(presentResult).not.toHaveBeenCalled()
  })

  it('参数 JSON 不可解析 → 空意图（presenter 不被调用）', () => {
    const presentCall = vi.fn()
    const views = resolveToolViews(sourceWith({ presentCall }), { name: 'bash', argumentsRaw: 'not-json' })
    expect(views).toEqual({})
    expect(presentCall).not.toHaveBeenCalled()
  })

  it('presenter 抛错 → 空意图（软降级不冒泡）', () => {
    const views = resolveToolViews(sourceWith({
      presentCall: () => { throw new Error('presenter boom') },
    }), REQUEST)
    expect(views).toEqual({})
  })

  it('presenter 返回 undefined / 槽位缺失 → 空意图', () => {
    expect(resolveToolViews(sourceWith({ presentCall: () => undefined }), REQUEST)).toEqual({})
    expect(resolveToolViews(sourceWith({}), { ...REQUEST, result: RESULT })).toEqual({})
  })
})
