/**
 * format/tool-card.ts — 工具卡片渲染契约测试。
 *
 * 覆盖：标题动词/参数摘要（toolCardTitle）、家族默认展开高度、
 * formatToolCard 各状态 bullet（成功/失败/进行中/待答）、无输出、diff 分支
 * （内联/折叠摘要）、普通输出与 read 族头尾预览、截断判定、
 * live 进行中卡（tick/elapsed/compact/tail 截断）、formatToolGroup 折叠/展开、
 * parseToolArguments 容错。
 */

import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RivetTheme } from '../src/theme.js'
import { resetTermCapsCache } from '../src/term-caps.js'
import {
  formatToolCard,
  formatToolCardLive,
  formatToolGroup,
  getDefaultMaxLines,
  isToolCardTruncated,
  toolCardTitle,
} from '../src/format/tool-card.js'
import { applyToolGroupEvent, emptyToolGroups, type ToolGroup, type ToolGroupState } from '../src/format/tool-group.js'
import { pinTuiEnvBaseline } from './env-baseline.ts'

function fakeTheme(): RivetTheme {
  return {
    primary: '#111111', secondary: '#222222', success: '#333333',
    warning: '#444444', error: '#555555', dim: '#666666', muted: '#777777',
    pulseQuiet: '#888888', pulseActive: '#999999', pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb', assistantColor: '#cccccc', systemColor: '#dddddd',
    brandColor: '#eeeeee', toolColor: () => '#000000', contextColor: () => '#000000',
  }
}

function plain(lines: readonly string[]): string[] {
  return lines.map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

// 包级环境基线：RIVET_ASCII_UI 清除 + 探测缓存重置收敛到一处。
pinTuiEnvBaseline()

describe('toolCardTitle', () => {
  it('工具参数摘要进标题（Run(npm test)）', () => {
    expect(toolCardTitle('bash', { command: 'npm test' })).toBe('Run(npm test)')
  })

  it('无 toolInput 时用 rawPath basename', () => {
    expect(toolCardTitle('read_file', undefined, '/a/b/foo.ts')).toBe('Read(foo.ts)')
  })

  it('无参数也无路径：仅动词', () => {
    expect(toolCardTitle('bash')).toBe('Run')
  })

  it('未知工具动词首字母大写（Tool）', () => {
    expect(toolCardTitle('unknown_tool')).toBe('Tool')
  })
})

describe('getDefaultMaxLines', () => {
  it('按家族给默认展开高度', () => {
    expect(getDefaultMaxLines('bash')).toBe(8)          // run
    expect(getDefaultMaxLines('grep')).toBe(6)          // find
    expect(getDefaultMaxLines('edit_file')).toBe(20)    // write
    expect(getDefaultMaxLines('read_file')).toBe(8)     // read: 3+5
    expect(getDefaultMaxLines('ask_user_question')).toBe(4) // other
  })
})

describe('formatToolCard', () => {
  it('成功 header：› 绿色 bullet + 标题', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'ok' }, fakeTheme())
    expect(plain(lines)[0]).toContain('› Run')
  })

  it('错误输出（ascii 轨）：x 红色 bullet + error 正文', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'boom', isError: true }, fakeTheme())
    expect(plain(lines)[0]).toContain('x')
  })

  it('unicode 轨（非 ascii）：✗/⠋ 字形', () => {
    process.env.RIVET_ASCII_UI = '0'
    resetTermCapsCache()
    const err = formatToolCard({ toolName: 'bash', content: 'boom', isError: true }, fakeTheme())
    expect(plain(err)[0]).toContain('✗')
    const stream = formatToolCard({ toolName: 'bash', content: 'x', streaming: true }, fakeTheme())
    expect(plain(stream)[0]).toContain('⠋')
    const live = formatToolCardLive({ toolName: 'bash', tick: 0, columns: 80 }, fakeTheme())
    expect(plain(live)[0]).toContain('⠋')
  })

  it('流式中（ascii 轨）：- bullet + … 后缀', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'x', streaming: true }, fakeTheme())
    expect(plain(lines)[0]).toContain('-')
    expect(plain(lines)[0]).toContain('…')
  })

  it('待答问（ask_user_question）：? bullet + 完整展示不截断', () => {
    const content = Array.from({ length: 20 }, (_, i) => `opt ${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'ask_user_question', content }, fakeTheme())
    expect(plain(lines)[0]).toContain('?')
    // 全部选项都渲染（不截断）
    expect(plain(lines).join('\n')).toContain('opt 19')
  })

  it('elapsedMs：header 附 (耗时)', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'x', elapsedMs: 1500 }, fakeTheme())
    expect(plain(lines)[0]).toContain('(1.5s)')
  })

  it('无输出：⎿ (无输出)', () => {
    const lines = formatToolCard({ toolName: 'bash', content: '' }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('(无输出)')
  })

  it('write 族 diff 内容：内联渲染（adds+dels ≤ 10）', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'
    const lines = formatToolCard({ toolName: 'apply_patch', content: diff }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('+1 −1')
  })

  it('write 族大 diff：折叠为摘要行（hunks>0 → N 处修改）', () => {
    const diff = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,20 +1,20 @@',
      ...Array.from({ length: 20 }, (_, i) => `+line${i}`),
    ].join('\n')
    const lines = formatToolCard({ toolName: 'apply_patch', content: diff }, fakeTheme())
    const text = plain(lines).join('\n')
    expect(text).toContain('1 处修改')
    expect(text).toContain('+20 −0')
    expect(text).not.toContain('ctrl+o')
  })

  it('write 族大 diff 无 hunk：N 行修改摘要', () => {
    const diff = [
      '--- a/x',
      '+++ b/x',
      ...Array.from({ length: 20 }, (_, i) => `+line${i}`),
    ].join('\n')
    const lines = formatToolCard({ toolName: 'apply_patch', content: diff }, fakeTheme())
    const text = plain(lines).join('\n')
    expect(text).toContain('20 行修改')
    expect(text).toContain('+20 −0')
    expect(text).not.toContain('ctrl+o')
  })

  it('expanded：大 diff 也完整渲染', () => {
    const diff = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,20 +1,20 @@',
      ...Array.from({ length: 20 }, (_, i) => `+line${i}`),
    ].join('\n')
    const lines = formatToolCard({ toolName: 'apply_patch', content: diff, expanded: true }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('+line19')
  })

  it('普通输出超 maxLines：截断计数提示', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'bash', content, maxLines: 3 }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('… +7 行')
  })

  it('read 族超量：头 3 + 尾 5 预览', () => {
    const content = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'read_file', content }, fakeTheme())
    const text = plain(lines).join('\n')
    expect(text).toContain('l0')
    expect(text).toContain('l19')
    expect(text).toContain('… +12 行')
  })

  it('rawPath：正文后附 raw: 行', () => {
    const lines = formatToolCard({ toolName: 'read_file', content: 'x', rawPath: '/a/b.ts' }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('raw: b.ts')
  })

  it('depth：缩进前缀', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'x', depth: 2 }, fakeTheme())
    expect(plain(lines)[0]).toMatch(/^ {4}/)
  })
})

describe('isToolCardTruncated', () => {
  it('ask_user_question 恒不截断', () => {
    const content = Array.from({ length: 30 }, (_, i) => `x${i}`).join('\n')
    expect(isToolCardTruncated({ toolName: 'ask_user_question', content })).toBe(false)
  })

  it('空内容不截断', () => {
    expect(isToolCardTruncated({ toolName: 'bash', content: '' })).toBe(false)
    expect(isToolCardTruncated({ toolName: 'bash', content: '\n\n' })).toBe(false)
  })

  it('write 族 diff 按 adds+dels 判定', () => {
    const small = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'
    expect(isToolCardTruncated({ toolName: 'apply_patch', content: small })).toBe(false)
    const big = ['--- a/x', '+++ b/x', '@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, (_, i) => `+l${i}`)].join('\n')
    expect(isToolCardTruncated({ toolName: 'apply_patch', content: big })).toBe(true)
  })

  it('普通输出按行数判定', () => {
    expect(isToolCardTruncated({ toolName: 'bash', content: 'a\nb' })).toBe(false)
    expect(isToolCardTruncated({ toolName: 'bash', content: Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n') })).toBe(true)
  })
})

describe('formatToolCardLive', () => {
  it('dim ⠋ 标题 + 末 N 行 tail（无 tick 的进行中形，卡片语言统一）', () => {
    process.env.RIVET_ASCII_UI = '0'
    resetTermCapsCache()
    const lines = formatToolCardLive({ toolName: 'bash', outputTail: 'a\nb\nc\nd', columns: 80 }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('⠋ Run')
    expect(plain(lines).join('\n')).toContain('d')
  })

  it('elapsedMs ≥ 1000 显示耗时；< 1000 不显示', () => {
    const withElapsed = formatToolCardLive({ toolName: 'bash', elapsedMs: 2000, columns: 80 }, fakeTheme())
    expect(plain(withElapsed)[0]).toContain('(2.0s)')
    const noElapsed = formatToolCardLive({ toolName: 'bash', elapsedMs: 500, columns: 80 }, fakeTheme())
    expect(plain(noElapsed)[0]).not.toContain('(0.5s)')
  })

  it('tick 驱动 braille 帧（unicode 轨）', () => {
    process.env.RIVET_ASCII_UI = '0'
    resetTermCapsCache()
    const lines = formatToolCardLive({ toolName: 'bash', tick: 0, columns: 80 }, fakeTheme())
    expect(plain(lines)[0]).toContain('⠋')
  })

  it('compact：仅标题单行', () => {
    const lines = formatToolCardLive({ toolName: 'bash', outputTail: 'a\nb\nc\nd', columns: 80, compact: true }, fakeTheme())
    expect(lines).toHaveLength(1)
  })

  it('outputTailLines 预切分行直接使用', () => {
    const lines = formatToolCardLive({ toolName: 'bash', outputTailLines: ['p1', 'p2'], tailLines: 2, columns: 80 }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('p1')
  })

  it('无输出时补占位 … 行', () => {
    const lines = formatToolCardLive({ toolName: 'bash', columns: 80 }, fakeTheme())
    expect(plain(lines).join('\n')).toContain('…')
  })

  it('tail 区定高：内容不足时垫到 tailLines，避免卡片随输出涨缩', () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      outputTail: 'only-one',
      tailLines: 3,
      columns: 80,
    }, fakeTheme())
    expect(lines).toHaveLength(1 + 3)
    expect(plain(lines).join('\n')).toContain('only-one')
  })

  it('无输出时占位后仍垫到 tailLines', () => {
    const lines = formatToolCardLive({ toolName: 'bash', tailLines: 3, columns: 80 }, fakeTheme())
    expect(lines).toHaveLength(1 + 3)
    expect(plain(lines).join('\n')).toContain('…')
  })

  it('tailLines=0：无 tail 行', () => {
    const lines = formatToolCardLive({ toolName: 'bash', outputTail: 'a', tailLines: 0, columns: 80 }, fakeTheme())
    expect(lines).toHaveLength(1)
  })

  it('超宽 tail 行截断不破版', () => {
    const lines = formatToolCardLive({ toolName: 'bash', outputTail: 'x'.repeat(200), columns: 20 }, fakeTheme())
    for (const l of lines) expect(l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').length).toBeLessThanOrEqual(20)
  })
})

describe('formatToolGroup', () => {
  function makeState(): { state: ToolGroupState; group: ToolGroup } {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, { type: 'tool-call', callId: 'c1' as ToolCallId, turn: 1, step: 2, name: 'read_file', arguments: '{"file_path":"a.ts"}' })
    s = applyToolGroupEvent(s, { type: 'tool-call', callId: 'c2' as ToolCallId, turn: 1, step: 2, name: 'grep', arguments: '{"pattern":"TODO"}' })
    s = applyToolGroupEvent(s, { type: 'tool-result', callId: 'c1' as ToolCallId, content: 'ok', isError: false })
    const group = s.groups.get('1:2')!
    return { state: s, group }
  }

  it('折叠态：▶ + 摘要 + 工具名清单', () => {
    const { group } = makeState()
    const rows = plain(formatToolGroup({ group, expanded: false, theme: fakeTheme() }))
    expect(rows[0]).toContain('▶')
    expect(rows[1]).toContain('read_file ×1')
  })

  it('折叠态空组：无 names 行（仅 header）', () => {
    const group: ToolGroup = { turn: 1, step: 2, entries: [] }
    const rows = plain(formatToolGroup({ group, expanded: false, theme: fakeTheme() }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('▶')
  })

  it('展开态：▼ + 逐工具完整卡片', () => {
    const { group } = makeState()
    const rows = plain(formatToolGroup({ group, expanded: true, theme: fakeTheme() }))
    expect(rows[0]).toContain('▼')
    expect(rows.join('\n')).toContain('Read(a.ts)')
    expect(rows.join('\n')).toContain('ok')
  })

  it('arguments 非法 JSON：容错为 undefined，标题无参数摘要', () => {
    let s = emptyToolGroups()
    s = applyToolGroupEvent(s, { type: 'tool-call', callId: 'c1' as ToolCallId, turn: 1, step: 2, name: 'bash', arguments: '{broken' })
    const group = s.groups.get('1:2')!
    const rows = plain(formatToolGroup({ group, expanded: true, theme: fakeTheme() }))
    expect(rows.join('\n')).toContain('Run')
  })

  it('arguments 空串/非对象 JSON：容错 undefined，仍渲染标题', () => {
    for (const raw of ['', '[1,2]', '"str"']) {
      let s = emptyToolGroups()
      s = applyToolGroupEvent(s, { type: 'tool-call', callId: 'c1' as ToolCallId, turn: 1, step: 2, name: 'bash', arguments: raw })
      const group = s.groups.get('1:2')!
      const rows = plain(formatToolGroup({ group, expanded: true, theme: fakeTheme() }))
      expect(rows.join('\n')).toContain('Run')
    }
  })
})

describe('isDelegationPreviewActive', () => {
  it('基础版恒 false（不做任务预览）', async () => {
    const { isDelegationPreviewActive } = await import('../src/format/tool-card.js')
    expect(isDelegationPreviewActive('delegate_task')).toBe(false)
  })
})
