/**
 * /export 导出纯函数测试：session events → Markdown 文本（确定性、截断、结构）。
 * @module @deepseek-ai/dsh-tianshu-tui/tests/export
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderSessionExport } from '../src/format/export.ts'

/** 构造含用户/助手（推理+文本+工具调用）/工具结果的事件序列。 */
function fixtureEvents(): SessionEvent[] {
  return [
    {
      type: 'user/message',
      data: createUserMessage({
        content: [{ type: 'text', text: '帮我修 bug' }],
        source: { kind: 'user' },
      }),
      time: 1,
      seq: 0,
    } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看错误' },
            { type: 'text', text: '我来定位' },
            { type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"file":"a.ts"}' },
          ],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      },
      time: 2,
      seq: 1,
    } as unknown as SessionEvent,
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c1'),
          content: [{ type: 'text', text: '文件内容 abc' }],
          isError: false,
        }),
      },
      time: 3,
      seq: 2,
    } as unknown as SessionEvent,
  ]
}

describe('renderSessionExport', () => {
  it('渲染会话头（id + 工作区）', () => {
    const out = renderSessionExport(fixtureEvents(), { sessionId: 's1', cwd: '/repo' })
    expect(out).toContain('# Session export — s1')
    expect(out).toContain('工作区: /repo')
  })

  it('用户消息渲染为 ## 用户 + 文本', () => {
    const out = renderSessionExport(fixtureEvents(), { sessionId: 's1' })
    expect(out).toContain('## 用户')
    expect(out).toContain('帮我修 bug')
  })

  it('助手消息渲染文本 + 推理引用 + 工具调用', () => {
    const out = renderSessionExport(fixtureEvents(), { sessionId: 's1' })
    expect(out).toContain('## Assistant')
    expect(out).toContain('我来定位')
    expect(out).toContain('> 推理: 先看错误')
    expect(out).toContain('read({"file":"a.ts"})')
  })

  it('工具结果渲染文本', () => {
    const out = renderSessionExport(fixtureEvents(), { sessionId: 's1' })
    expect(out).toContain('文件内容 abc')
  })

  it('超长工具结果截断（5000 字符 + 标记）', () => {
    const long = 'x'.repeat(6000)
    const events: SessionEvent[] = [{
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c1'),
          content: [{ type: 'text', text: long }],
          isError: false,
        }),
      },
      time: 1,
      seq: 0,
    } as unknown as SessionEvent]
    const out = renderSessionExport(events, { sessionId: 's1' })
    expect(out).toContain('+1000 字符')
    expect(out.length).toBeLessThan(long.length + 200)
  })

  it('确定性：同输入同输出', () => {
    const events = fixtureEvents()
    const a = renderSessionExport(events, { sessionId: 's1' })
    const b = renderSessionExport(events, { sessionId: 's1' })
    expect(a).toBe(b)
  })

  it('空会话输出头 + 空提示', () => {
    const out = renderSessionExport([], { sessionId: 's1' })
    expect(out).toContain('# Session export — s1')
    expect(out).toContain('（无消息）')
  })

  it('未知事件类型静默丢弃（merge-extensible 事件表：不崩、无痕迹）', () => {
    const events = [
      ...fixtureEvents(),
      // 未来的扩展事件类型（如新插件合并进 SessionEventMap）——渲染器必须容忍。
      { type: 'future/unknown-event', seq: 99, time: 99, data: { payload: 'x' } },
    ] as unknown as SessionEvent[]
    const out = renderSessionExport(events, { sessionId: 's1' })
    // 头 + 已知事件照常渲染，未知事件不产生输出、不抛错。
    expect(out).toContain('# Session export — s1')
    expect(out).toContain('帮我修 bug')
    expect(out).not.toContain('future/unknown-event')
    expect(out).not.toContain('payload')
  })
})
