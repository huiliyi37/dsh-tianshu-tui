/**
 * Phase 7.3 并行工具分组折叠 — 契约测试（RED→GREEN）。
 *
 * - 分组聚合：tool/call + tool/result 事件流按 (turn, step) 分组，同 step
 *   内并行调用聚合为一组；result 按 callId 绑定（乱序到达也正确）。
 * - 展开/折叠状态机：纯函数 toggle，只影响目标组。
 * - 部分完成渲染：折叠态显示计数与部分完成状态，展开态逐个渲染每个工具。
 *
 * 纯投影纪律：fold 只消费事件、不写回 session log；未知 callId 的 result
 * 是 no-op（返回原状态引用）。
 */

import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RivetTheme } from '../src/theme.js'
import {
  applyToolGroupEvent,
  buildToolGroupSummary,
  emptyToolGroups,
  groupKey,
  groupStats,
  isGroupExpanded,
  toggleGroupExpanded,
  type ToolGroup,
  type ToolGroupEvent,
  type ToolGroupState,
} from '../src/format/tool-group.js'
import { formatToolGroup } from '../src/format/tool-card.js'

/** 假主题：每个 token 一个独特 hex（与 tool-viz.spec.ts 同构）。 */
function fakeTheme(over: Partial<RivetTheme> = {}): RivetTheme & { toolShell?: string } {
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
    toolShell: '#131313',
    ...over,
  }
}

/** 剥离 ANSI 转义，得到纯文本行。 */
function plain(lines: readonly string[]): string[] {
  return lines.map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

/** 构造一个 tool/call 事件。 */
function call(callId: string, turn: number, step: number, name: string, args = '{}'): ToolGroupEvent {
  return { type: 'tool-call', callId: callId as ToolCallId, turn, step, name, arguments: args }
}

/** 构造一个 tool/result 事件（content 为折叠后的文本）。 */
function result(callId: string, content = 'ok', isError = false): ToolGroupEvent {
  return { type: 'tool-result', callId: callId as ToolCallId, content, isError }
}

/** 按 (turn, step) 取组；不存在则测试失败。 */
function groupOf(state: ToolGroupState, turn: number, step: number): ToolGroup {
  const g = state.groups.get(groupKey(turn, step))
  expect(g, `group ${groupKey(turn, step)} should exist`).toBeDefined()
  return g!
}

describe('分组聚合（tool/call + tool/result 按 step 折叠）', () => {
  it('空状态无分组', () => {
    expect(emptyToolGroups().groups.size).toBe(0)
  })

  it('同 step 的两个并行 tool/call 聚合为一组', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file', '{"file_path":"a.ts"}'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep', '{"pattern":"TODO"}'))
    const group = groupOf(s, 1, 2)
    expect(group.entries).toHaveLength(2)
    expect(group.entries.map(e => e.name)).toEqual(['read_file', 'grep'])
  })

  it('不同 step 的调用分成不同组', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 1, 'read_file'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'bash'))
    s = applyToolGroupEvent(s, call('c3', 2, 1, 'grep'))
    expect(s.groups.size).toBe(3)
    expect(groupOf(s, 1, 1).entries).toHaveLength(1)
    expect(groupOf(s, 1, 2).entries).toHaveLength(1)
    expect(groupOf(s, 2, 1).entries).toHaveLength(1)
  })

  it('tool/result 按 callId 绑定到所属 entry（乱序到达也正确）', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file', '{"file_path":"a.ts"}'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'read_file', '{"file_path":"b.ts"}'))
    // result(B) 先到，再 result(A)
    s = applyToolGroupEvent(s, result('c2', 'content B'))
    s = applyToolGroupEvent(s, result('c1', 'content A'))
    const group = groupOf(s, 1, 2)
    expect(group.entries.map(e => e.completed)).toEqual([true, true])
    expect(group.entries[0]!.content).toBe('content A')
    expect(group.entries[1]!.content).toBe('content B')
  })

  it('未知 callId 的 tool/result 是纯投影 no-op（返回原状态引用）', () => {
    const s = emptyToolGroups()
    expect(applyToolGroupEvent(s, result('ghost', 'x'))).toBe(s)
  })

  it('tool-call 缺 turn/step/name/arguments：兜底 UNKNOWN/-1 与默认值', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, { type: 'tool-call', callId: 'c0' as ToolCallId })
    const group = groupOf(s, -1, -1)
    expect(group.entries[0]).toMatchObject({ name: 'tool', arguments: '', turn: -1, step: -1 })
  })

  it('tool-result 缺 content/isError：兜底空串/false', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, { type: 'tool-result', callId: 'c1' as ToolCallId })
    expect(groupOf(s, 1, 2).entries[0]).toMatchObject({ content: '', isError: false, completed: true })
  })

  it('重复 tool/result 幂等（保留首次定格）', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, result('c1', 'first'))
    const afterFirst = s
    s = applyToolGroupEvent(s, result('c1', 'second', true))
    const group = groupOf(s, 1, 2)
    expect(group.entries[0]!.content).toBe('first')
    expect(group.entries[0]!.isError).toBe(false)
    expect(s).toBe(afterFirst)
  })

  it('tool/result 保留 isError 标记', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'bash'))
    s = applyToolGroupEvent(s, result('c1', 'boom', true))
    expect(groupOf(s, 1, 2).entries[0]!.isError).toBe(true)
  })

  it('groupStats 统计 total/completed/pending', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, call('c3', 1, 2, 'grep'))
    s = applyToolGroupEvent(s, result('c1', 'a'))
    const stats = groupStats(groupOf(s, 1, 2))
    expect(stats.total).toBe(3)
    expect(stats.completed).toBe(1)
    expect(stats.pending).toBe(2)
  })
})

describe('展开/折叠状态机', () => {
  it('默认全部折叠', () => {
    const s = emptyToolGroups()
    expect(isGroupExpanded(s, groupKey(1, 2))).toBe(false)
  })

  it('toggle 展开，再 toggle 折叠', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    const key = groupKey(1, 2)
    const opened = toggleGroupExpanded(s, key)
    expect(isGroupExpanded(opened, key)).toBe(true)
    const closed = toggleGroupExpanded(opened, key)
    expect(isGroupExpanded(closed, key)).toBe(false)
  })

  it('toggle 只影响目标组', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 1, 'read_file'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep'))
    const keyA = groupKey(1, 1)
    const keyB = groupKey(1, 2)
    const toggled = toggleGroupExpanded(s, keyA)
    expect(isGroupExpanded(toggled, keyA)).toBe(true)
    expect(isGroupExpanded(toggled, keyB)).toBe(false)
  })

  it('toggle 不存在的组 key 是 no-op（返回原状态引用）', () => {
    const s = emptyToolGroups()
    expect(toggleGroupExpanded(s, groupKey(9, 9))).toBe(s)
  })
})

describe('buildToolGroupSummary（折叠计数与部分完成状态）', () => {
  it('部分完成：进行体 + 完成计数', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep'))
    s = applyToolGroupEvent(s, result('c1', 'a'))
    expect(buildToolGroupSummary(groupOf(s, 1, 2))).toBe('2 个工具并行执行中 (1/2 完成)')
  })

  it('全部进行中：进行体、无完成计数', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, call('c3', 1, 2, 'grep'))
    expect(buildToolGroupSummary(groupOf(s, 1, 2))).toBe('3 个工具并行执行中')
  })

  it('全部完成：过去体（无「中」）', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep'))
    s = applyToolGroupEvent(s, result('c1', 'a'))
    s = applyToolGroupEvent(s, result('c2', 'b'))
    expect(buildToolGroupSummary(groupOf(s, 1, 2))).toBe('2 个工具并行执行')
  })

  it('单工具组也归并行分组文案', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file'))
    s = applyToolGroupEvent(s, result('c1', 'a'))
    expect(buildToolGroupSummary(groupOf(s, 1, 2))).toBe('1 个工具并行执行')
  })
})

describe('formatToolGroup 渲染（tool-card 接入分组）', () => {
  const theme = fakeTheme()

  it('折叠态：▶ 指示器 + 计数摘要 + 工具名摘要行', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file', '{"file_path":"a.ts"}'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'read_file', '{"file_path":"b.ts"}'))
    s = applyToolGroupEvent(s, call('c3', 1, 2, 'grep', '{"pattern":"TODO"}'))
    s = applyToolGroupEvent(s, result('c1', 'a'))
    const rows = plain(formatToolGroup({ group: groupOf(s, 1, 2), expanded: false, theme }))
    expect(rows[0]).toContain('▶')
    expect(rows[0]).toContain('3 个工具并行执行中 (1/3 完成)')
    // 折叠态不逐个渲染工具卡片
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('read_file ×2')
    expect(rows[1]).toContain('grep ×1')
  })

  it('折叠态全完成：过去体摘要，不含进行体', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file', '{"file_path":"a.ts"}'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep', '{"pattern":"TODO"}'))
    s = applyToolGroupEvent(s, result('c1', 'a'))
    s = applyToolGroupEvent(s, result('c2', 'b'))
    const rows = plain(formatToolGroup({ group: groupOf(s, 1, 2), expanded: false, theme }))
    expect(rows[0]).toContain('2 个工具并行执行')
    expect(rows[0]).not.toContain('中')
  })

  it('展开态：▼ 指示器 + 逐工具渲染完整卡片', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file', '{"file_path":"a.ts"}'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep', '{"pattern":"TODO"}'))
    s = applyToolGroupEvent(s, result('c1', 'content A'))
    s = applyToolGroupEvent(s, result('c2', 'match B'))
    const rows = plain(formatToolGroup({ group: groupOf(s, 1, 2), expanded: true, theme }))
    expect(rows[0]).toContain('▼')
    expect(rows[0]).toContain('2 个工具并行执行')
    // 每个工具独立卡片：标题 + 内容都出现
    expect(rows.join('\n')).toContain('Read(a.ts)')
    expect(rows.join('\n')).toContain('content A')
    expect(rows.join('\n')).toContain('Search(TODO)')
    expect(rows.join('\n')).toContain('match B')
  })

  it('展开态下进行中 entry 显示流式标记（不显示耗时）', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, call('c1', 1, 2, 'read_file', '{"file_path":"a.ts"}'))
    s = applyToolGroupEvent(s, call('c2', 1, 2, 'grep', '{"pattern":"TODO"}'))
    s = applyToolGroupEvent(s, result('c1', 'content A'))
    // c2 未完成 → 展开态下仍显示为流式
    const rows = plain(formatToolGroup({ group: groupOf(s, 1, 2), expanded: true, theme }))
    expect(rows.join('\n')).toContain('Search(TODO) …')
  })
})
