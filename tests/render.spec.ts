/**
 * ui/render — 转录渲染纯函数层契约测试。
 *
 * - renderMessageRows：user → formatUserMessage（▌ 导轨），assistant →
 *   思考块（reasoning 折叠）+ formatMarkdown；kind 标记区分。
 * - renderToolRows：call → result 配对渲染卡片行（presenter 意图经
 *   resolveViews 注入分派 diff/terminal 卡；缺省文本折叠；首块非
 *   tool-result → 空内容；error → 错误态；无 result → streaming）。
 * - renderTranscript：按事件 seq 交错 messages 与 tools（resume 与 live
 *   提交同序）。
 * - parseToolArguments：容错 JSON 解析（对象通过，数组/标量/非法/空 → undefined）。
 *
 * 纯函数层：零 IO、零全局状态，输入 TranscriptView + 主题 + 列数 → ANSI 行数组。
 */

import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { RivetTheme } from '../src/theme.js'
import type { TranscriptMessage, TranscriptToolCall, TranscriptView } from '../src/adapter/transcript.js'
import {
  parseToolArguments,
  renderMessageRows,
  renderToolRows,
  renderTranscript,
} from '../src/ui/render.js'

/** 假主题：每个 token 一个独特 hex（与 tool-group.spec.ts 同构）。 */
function fakeTheme(): RivetTheme {
  return {
    primary: '#111111',
    secondary: '#222222',
    success: '#333333',
    warning: '#444444',
    error: '#555555',
    dim: '#666666',
    muted: '#777777',
    pulseQuiet: '#888888',
    pulseActive: '#999999',
    pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb',
    assistantColor: '#cccccc',
    systemColor: '#dddddd',
    brandColor: '#eeeeee',
    toolColor: () => '#000000',
    contextColor: () => '#000000',
  }
}

/** 剥离 ANSI 转义，得到纯文本行。 */
function plain(lines: readonly { ansi: string }[]): string[] {
  return lines.map(l => l.ansi.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

function userMessage(text: string, seq = 1): TranscriptMessage {
  return {
    seq,
    time: 1000 + seq,
    kind: 'user',
    turn: 1,
    step: undefined,
    text,
    reasoning: '',
    event: {} as SessionEvent,
  }
}

function assistantMessage(text: string, seq = 2, reasoning = ''): TranscriptMessage {
  return {
    seq,
    time: 1000 + seq,
    kind: 'assistant',
    turn: 1,
    step: 0,
    text,
    reasoning,
    event: {} as SessionEvent,
  }
}

/** tool/result 事件：message.content[0] 为 tool-result 块（嵌套 text 折叠）。 */
function toolResultEvent(
  callId: string,
  blocks: Array<{ type: string; text?: string; content?: Array<{ type: string; text: string }> }>,
  error?: unknown,
): SessionEvent<'tool/result'> {
  return {
    seq: 10,
    time: 2000,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 0,
      toolCallId: callId,
      message: { role: 'tool', content: blocks },
      ...(error === undefined ? {} : { error }),
    },
  } as unknown as SessionEvent<'tool/result'>
}

function tool(callId: string, name: string, args: string, result?: SessionEvent<'tool/result'>, seq = 5): TranscriptToolCall {
  return {
    callId: callId as ToolCallId,
    name,
    arguments: args,
    turn: 1,
    step: 0,
    seq,
    time: 1500,
    result,
    error: result === undefined ? undefined : (result.data as { error?: unknown }).error === undefined
      ? undefined
      : { name: 'err', code: 'E1' },
  }
}

function view(messages: readonly TranscriptMessage[], tools: readonly TranscriptToolCall[]): TranscriptView {
  return {
    sessionId: 's1' as SessionId,
    messages,
    streaming: undefined,
    tools,
    turn: 1,
    firstInTurnTime: undefined,
    seq: 100,
  }
}

describe('renderMessageRows', () => {
  it('user 消息 → formatUserMessage 行，kind user', () => {
    const rows = renderMessageRows(userMessage('你好世界'), fakeTheme(), 80)
    expect(rows.every(r => r.kind === 'user')).toBe(true)
    expect(plain(rows).join('\n')).toContain('你好世界')
  })

  it('user 消息隐藏运行时 system-reminder，只保留真实用户内容', () => {
    const rows = renderMessageRows(userMessage('<system-reminder>内部规则</system-reminder>请查看项目'), fakeTheme(), 80)
    const text = plain(rows).join('\n')
    expect(text).toContain('请查看项目')
    expect(text).not.toContain('内部规则')
    expect(text).not.toContain('system-reminder')
  })

  it('#40 runtime context 快照行（plugin/snapshot source）整行隐藏，不渲染内容', () => {
    const event = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent DSH file policy: workspace-write.\nApproval policy: ask. Operations fail closed.' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] },
      },
    } as unknown as SessionEvent
    const rows = renderMessageRows({ ...userMessage('Current runtime context...'), event }, fakeTheme(), 80)
    expect(rows).toEqual([])
  })

  it('#40 非 snapshot 的 plugin 行（如 form=notice）不隐藏，按普通用户行渲染', () => {
    const event = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '插件通知' }],
        source: { kind: 'plugin', plugin: 'x', form: 'notice' },
      },
    } as unknown as SessionEvent
    const rows = renderMessageRows({ ...userMessage('插件通知'), event }, fakeTheme(), 80)
    expect(rows.every(r => r.kind === 'user')).toBe(true)
    expect(plain(rows).join('\n')).toContain('插件通知')
  })

  it('assistant 消息 → formatMarkdown 行，kind assistant', () => {
    const rows = renderMessageRows(assistantMessage('回答内容'), fakeTheme(), 80)
    expect(rows.every(r => r.kind === 'assistant')).toBe(true)
    expect(plain(rows).join('\n')).toContain('回答内容')
  })

  it('assistant 带 reasoning → 思考块折叠（✻ 头 · N 行，正文不渲染）先于正文', () => {
    const rows = renderMessageRows(assistantMessage('正文', 2, '第一步\n第二步'), fakeTheme(), 80)
    const text = plain(rows)
    const headIdx = text.findIndex(l => l.includes('✻ 思考'))
    const answerIdx = text.findIndex(l => l.includes('正文'))
    expect(headIdx).toBeGreaterThanOrEqual(0)
    expect(headIdx).toBeLessThan(answerIdx)
    // 折叠缺省：推理正文不进 scrollback（对标竞品；展开查看走 Ctrl+O live 视图）
    expect(text.join('\n')).not.toContain('第二步')
  })

  it('compact 模式：思考块仅头行，正文跳过', () => {
    const rows = renderMessageRows(assistantMessage('正文', 2, '内心戏'), fakeTheme(), 80, { compact: true })
    const text = plain(rows).join('\n')
    expect(text).toContain('✻ 思考')
    expect(text).not.toContain('内心戏')
  })

  it('#39 skill-invocation 注入行 → 摘要 chip（🧭 使用技能: name），不渲染正文', () => {
    const event = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<skill_content>...' }],
        source: { kind: 'skill-invocation', name: 'find-skills', form: 'instructions' },
      },
    } as unknown as SessionEvent
    const rows = renderMessageRows({ ...userMessage('<skill_content>...'), event }, fakeTheme(), 80)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('system')
    expect(plain(rows).join('\n')).toContain('🧭 使用技能: find-skills')
    expect(plain(rows).join('\n')).not.toContain('skill_content')
  })

  it('#39 skill-catalog 注入行 → 一行 dim 提示（含条数）', () => {
    const event = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<system-reminder>...' }],
        source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }] },
      },
    } as unknown as SessionEvent
    const rows = renderMessageRows({ ...userMessage('<system-reminder>...'), event }, fakeTheme(), 80)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('system')
    expect(plain(rows).join('\n')).toContain('🧭 技能目录已更新（2 项）')
    expect(plain(rows).join('\n')).not.toContain('system-reminder')
  })

  it('#39 source.kind=user（普通用户消息）→ 仍按用户气泡渲染', () => {
    const event = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '普通提问' }],
        source: { kind: 'user' },
      },
    } as unknown as SessionEvent
    const rows = renderMessageRows({ ...userMessage('普通提问'), event }, fakeTheme(), 80)
    expect(rows.every(r => r.kind === 'user')).toBe(true)
    expect(plain(rows).join('\n')).toContain('普通提问')
  })

  it('#39 注入行 source 形状未知（无 data/source）→ 回落普通渲染不抛错', () => {
    const malformed = { type: 'user/message' } as unknown as SessionEvent
    const rows = renderMessageRows({ ...userMessage('你好'), event: malformed }, fakeTheme(), 80)
    expect(rows.every(r => r.kind === 'user')).toBe(true)
    expect(plain(rows).join('\n')).toContain('你好')
  })
})

describe('renderToolRows', () => {
  it('tool/result 折叠 text 块 → 卡片行，kind tool', () => {
    const result = toolResultEvent('c1', [{ type: 'tool-result', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }])
    const rows = renderToolRows(tool('c1', 'read_file', '{"file_path":"a.ts"}', result), fakeTheme())
    expect(rows.every(r => r.kind === 'tool')).toBe(true)
    const text = plain(rows).join('\n')
    expect(text).toContain('Read')
    expect(text).toContain('line1')
    expect(text).toContain('line2')
  })

  it('result 首块非 tool-result → 内容为空（卡片仍渲染标题）', () => {
    const result = toolResultEvent('c2', [{ type: 'text', text: '裸文本' }])
    const rows = renderToolRows(tool('c2', 'bash', '{}', result), fakeTheme())
    expect(rows.length).toBeGreaterThan(0)
    expect(plain(rows).join('\n')).not.toContain('裸文本')
  })

  it('result 带 error → isError 错误态（非静默）', () => {
    const result = toolResultEvent('c3', [{ type: 'tool-result', content: [{ type: 'text', text: 'boom' }] }], { name: 'Error', code: 'E1' })
    const rows = renderToolRows(tool('c3', 'bash', '{}', result), fakeTheme())
    expect(rows.length).toBeGreaterThan(0)
  })

  it('无 result（进行中）→ streaming 标记渲染', () => {
    const rows = renderToolRows(tool('c4', 'grep', '{"pattern":"x"}', undefined), fakeTheme())
    expect(rows.length).toBeGreaterThan(0)
    expect(plain(rows).join('\n')).toContain('Search')
  })

  it('arguments 为非法 JSON → 解析失败走空 toolInput 分支（卡片仍渲染）', () => {
    const rows = renderToolRows(tool('c4', 'bash', '{bad json', undefined), fakeTheme())
    expect(rows.length).toBeGreaterThan(0)
  })

  it('expanded 展开卡片体', () => {
    const result = toolResultEvent('c5', [{ type: 'tool-result', content: [{ type: 'text', text: '详情' }] }])
    const collapsed = renderToolRows(tool('c5', 'bash', '{}', result), fakeTheme())
    const expanded = renderToolRows(tool('c5', 'bash', '{}', result), fakeTheme(), { expanded: true })
    expect(expanded.length).toBeGreaterThanOrEqual(collapsed.length)
  })

  it('resolveViews 注入 diff 意图 → 结构化 diff 卡（+/- 行 + presenter 标题）', () => {
    const result = toolResultEvent('c6', [{ type: 'tool-result', content: [{ type: 'text', text: '模型面文本' }] }])
    const rows = renderToolRows(tool('c6', 'edit_file', '{"file_path":"a.ts"}', result), fakeTheme(), {
      resolveViews: () => ({
        result: { card: 'diff', title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'x = 1', newText: 'x = 2' }] },
      }),
    })
    const text = plain(rows).join('\n')
    expect(text).toContain('Edit a.ts')
    expect(text).toContain('- x = 1')
    expect(text).toContain('+ x = 2')
    expect(text).not.toContain('模型面文本')
  })
})

describe('renderTranscript', () => {
  it('按事件 seq 交错 messages 与 tools（文本 → 卡 → 文本）', () => {
    const rows = renderTranscript(
      view(
        [userMessage('问题', 1), assistantMessage('答案', 2), assistantMessage('后续', 9)],
        [tool('c1', 'bash', '{}', undefined, 5)],
      ),
      fakeTheme(),
      80,
    )
    const text = plain(rows)
    const q = text.findIndex(l => l.includes('问题'))
    const a = text.findIndex(l => l.includes('答案'))
    const card = rows.findIndex(r => r.kind === 'tool')
    const follow = text.findIndex(l => l.includes('后续'))
    expect(q).toBeGreaterThanOrEqual(0)
    expect(a).toBeGreaterThan(q)
    expect(card).toBeGreaterThan(a)
    expect(follow).toBeGreaterThan(card)
  })

  it('空 view → 零行', () => {
    expect(renderTranscript(view([], []), fakeTheme(), 80)).toEqual([])
  })
})

describe('parseToolArguments', () => {
  it('合法对象 → 返回记录', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
  })

  it('数组 / 标量 / null → undefined', () => {
    expect(parseToolArguments('[1,2]')).toBeUndefined()
    expect(parseToolArguments('"str"')).toBeUndefined()
    expect(parseToolArguments('42')).toBeUndefined()
    expect(parseToolArguments('null')).toBeUndefined()
  })

  it('非法 JSON / 空串 → undefined', () => {
    expect(parseToolArguments('{bad')).toBeUndefined()
    expect(parseToolArguments('')).toBeUndefined()
  })
})
