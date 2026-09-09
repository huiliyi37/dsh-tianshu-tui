/**
 * Phase 7.1 工具运行计时 + 7.2 工具家族着色 — 可视化契约测试。
 *
 * - 7.1：tool/call → tool/result 的计时状态机（纯投影 fold，不写回 session log）。
 * - 7.2：工具名 → 功能家族 → 主题色 token 的映射与 tool-card 渲染接入。
 *
 * 颜色断言注入假主题（独特 hex token），断言渲染输出中的 38;2 RGB 序列——
 * 不依赖任何具体主题的具体色值，契约落在「家族 → 语义 token」层。
 */

import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RivetTheme } from '../src/theme.js'
import { getToolColorFamily, toolFamilyColor } from '../src/format/tool-family.js'
import { emptyToolTimer, applyToolTimerEvent, toolElapsedMs, formatElapsed } from '../src/format/tool-meta.js'
import { formatToolCard, formatToolCardLive } from '../src/format/tool-card.js'

/** 假主题：每个 token 一个独特 hex，便于断言 ANSI RGB 序列归属。 */
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

/** hex → ANSI 24-bit 前景序列（与 engine/ansi.ts fg() 同构）。 */
function ansi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `38;2;${r};${g};${b}`
}

describe('getToolColorFamily（7.2 家族映射）', () => {
  it('read/write/edit/glob 归文件系（蓝）', () => {
    for (const name of ['read_file', 'read_section', 'write_file', 'edit_file', 'glob', 'repo_map', 'inspect_project']) {
      expect(getToolColorFamily(name), name).toBe('file')
    }
  })

  it('bash 归 shell 系（黄）', () => {
    expect(getToolColorFamily('bash')).toBe('shell')
  })

  it('grep/ast_grep/semantic_search 归搜索系（绿）', () => {
    for (const name of ['grep', 'ast_grep', 'semantic_search', 'related_tests']) {
      expect(getToolColorFamily(name), name).toBe('search')
    }
  })

  it('apply_patch/hash_edit 归编辑系（紫）', () => {
    for (const name of ['apply_patch', 'hash_edit', 'str_replace']) {
      expect(getToolColorFamily(name), name).toBe('edit')
    }
  })

  it('web_fetch/web_search 归网络系（青）', () => {
    for (const name of ['web_fetch', 'web_search']) {
      expect(getToolColorFamily(name), name).toBe('network')
    }
  })

  it('未列工具与编排工具归 other', () => {
    for (const name of ['mystery_tool', 'run_tests', 'delegate_task', 'delegate_batch', 'ask_user_question']) {
      expect(getToolColorFamily(name), name).toBe('other')
    }
  })
})

describe('toolFamilyColor（家族 → 主题语义色）', () => {
  const theme = fakeTheme()

  it('文件系 → primary（蓝）', () => {
    expect(toolFamilyColor('read_file', theme)).toBe(theme.primary)
  })
  it('shell 系 → warning（黄）', () => {
    expect(toolFamilyColor('bash', theme)).toBe(theme.warning)
  })
  it('搜索系 → success（绿）', () => {
    expect(toolFamilyColor('grep', theme)).toBe(theme.success)
  })
  it('编辑系 → secondary（紫）', () => {
    expect(toolFamilyColor('apply_patch', theme)).toBe(theme.secondary)
  })
  it('网络系 → toolShell ?? primary（青）', () => {
    expect(toolFamilyColor('web_fetch', theme)).toBe(theme.toolShell ?? theme.primary)
  })
  it('other → dim', () => {
    expect(toolFamilyColor('mystery_tool', theme)).toBe(theme.dim)
  })
})

describe('formatElapsed — 精确耗时（迁移自 tool-elapsed 合并）', () => {
  it('<1s → 毫秒', () => {
    expect(formatElapsed(0)).toBe('0ms')
    expect(formatElapsed(123)).toBe('123ms')
    expect(formatElapsed(999)).toBe('999ms')
  })

  it('<60s → 一位小数秒', () => {
    expect(formatElapsed(1000)).toBe('1.0s')
    expect(formatElapsed(1500)).toBe('1.5s')
    expect(formatElapsed(59_900)).toBe('59.9s')
  })

  it('≥60s → 分+补零秒', () => {
    expect(formatElapsed(60_000)).toBe('1m00s')
    expect(formatElapsed(65_000)).toBe('1m05s')
    expect(formatElapsed(3_605_000)).toBe('60m05s')
  })

  it('负数 → 0ms（不出现负耗时）', () => {
    expect(formatElapsed(-100)).toBe('0ms')
  })
})

describe('工具计时状态机（7.1 tool/call → tool/result）', () => {
  it('空状态无计时记录', () => {
    expect(toolElapsedMs(emptyToolTimer(), 'c1' as ToolCallId, 0)).toBeUndefined()
  })

  it('tool/call 后按当前时间实时计时', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, { type: 'tool-call', time: 1000, callId: 'c1' as ToolCallId })
    expect(toolElapsedMs(s, 'c1' as ToolCallId, 2500)).toBe(1500)
  })

  it('tool/result 停止并定格耗时（不再随 now 增长）', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, { type: 'tool-call', time: 1000, callId: 'c1' as ToolCallId })
    s = applyToolTimerEvent(s, { type: 'tool-result', time: 2500, callId: 'c1' as ToolCallId })
    expect(toolElapsedMs(s, 'c1' as ToolCallId, 999_999)).toBe(1500)
  })

  it('未知 callId 的 result 是纯投影 no-op（不产生新状态）', () => {
    const s = emptyToolTimer()
    expect(applyToolTimerEvent(s, { type: 'tool-result', time: 1000, callId: 'ghost' as ToolCallId })).toBe(s)
  })

  it('并行工具独立计时', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, { type: 'tool-call', time: 1000, callId: 'c1' as ToolCallId })
    s = applyToolTimerEvent(s, { type: 'tool-call', time: 2000, callId: 'c2' as ToolCallId })
    expect(toolElapsedMs(s, 'c1' as ToolCallId, 3000)).toBe(2000)
    expect(toolElapsedMs(s, 'c2' as ToolCallId, 3000)).toBe(1000)
  })

  it('重复 result 幂等（保留首次定格值）', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, { type: 'tool-call', time: 1000, callId: 'c1' as ToolCallId })
    s = applyToolTimerEvent(s, { type: 'tool-result', time: 1500, callId: 'c1' as ToolCallId })
    s = applyToolTimerEvent(s, { type: 'tool-result', time: 2000, callId: 'c1' as ToolCallId })
    expect(toolElapsedMs(s, 'c1' as ToolCallId, 999)).toBe(500)
  })
})

describe('formatToolCard 家族着色 + 耗时渲染（7.2 接入）', () => {
  const theme = fakeTheme()

  it('shell 工具标题用 warning（黄）且展示耗时', () => {
    const rows = formatToolCard({ toolName: 'bash', content: 'ok\n', elapsedMs: 1500 }, theme)
    expect(rows[0]).toContain(ansi(theme.warning))
    expect(rows[0]).toContain('(1.5s)')
  })

  it('搜索工具标题用 success（绿）', () => {
    const rows = formatToolCard({ toolName: 'grep', content: 'hit\n' }, theme)
    expect(rows[0]).toContain(ansi(theme.success))
  })

  it('编辑工具标题用 secondary（紫）', () => {
    const rows = formatToolCard({ toolName: 'apply_patch', content: 'patch\n' }, theme)
    expect(rows[0]).toContain(ansi(theme.secondary))
  })

  it('未列工具标题用 dim（灰）', () => {
    const rows = formatToolCard({ toolName: 'mystery_tool', content: 'x\n' }, theme)
    expect(rows[0]).toContain(ansi(theme.dim))
  })

  it('ask_user_question 保持 warning 覆盖（不被家族色覆盖）', () => {
    const rows = formatToolCard({ toolName: 'ask_user_question', content: 'pick one\n' }, theme)
    expect(rows[0]).toContain(ansi(theme.warning))
  })
})

describe('formatToolCardLive 家族着色 + 进行中计时（7.1 实时展示）', () => {
  const theme = fakeTheme()

  it('进行中 shell 工具实时展示耗时（≥1s 才显示，Claude Code 惯例）', () => {
    const rows = formatToolCardLive({ toolName: 'bash', columns: 80, elapsedMs: 1500, tick: 0 }, theme)
    expect(rows[0]).toContain(ansi(theme.warning))
    expect(rows[0]).toContain('(1.5s)')
  })

  it('<1s 的进行中工具不刷耗时', () => {
    const rows = formatToolCardLive({ toolName: 'bash', columns: 80, elapsedMs: 400, tick: 0 }, theme)
    expect(rows[0]).not.toContain('(400ms)')
  })

  it('网络工具 live 卡用 network 色（toolShell ?? primary）', () => {
    const rows = formatToolCardLive({ toolName: 'web_fetch', columns: 80, elapsedMs: 1500, tick: 0 }, theme)
    expect(rows[0]).toContain(ansi(theme.toolShell ?? theme.primary))
  })
})

describe('formatToolCardLive compact 模式（grok-build /compact-mode 密度开关）', () => {
  const theme = fakeTheme()

  it('compact 时仅渲染标题单行（无输出 tail）', () => {
    const rows = formatToolCardLive({
      toolName: 'bash',
      toolInput: { cmd: 'ls -la' },
      outputTail: 'file1\nfile2\nfile3',
      columns: 80,
      tick: 0,
      compact: true,
    }, theme)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('Run') // toolCardTitle 把 bash 映射为 Run
    expect(rows[0]).not.toContain('file1')
  })

  it('非 compact 时行为不变（回归：tail 仍渲染）', () => {
    const rows = formatToolCardLive({
      toolName: 'bash',
      outputTail: 'file1',
      columns: 80,
      tick: 0,
    }, theme)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.join('')).toContain('file1')
  })
})
