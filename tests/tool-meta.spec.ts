/**
 * format/tool-meta.ts — 工具元数据与计时器契约测试。
 *
 * 覆盖：家族判定（getToolFamily）、参数摘要（toolArgSummary 各 case）、
 * 耗时格式化（formatElapsed 三分支）、委派工具识别、ToolTimer 投影
 * （call/result 折叠、未知 callId no-op、elapsed 查询）。
 */

import { describe, expect, it } from 'vitest'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  applyToolTimerEvent,
  emptyToolTimer,
  formatElapsed,
  getToolFamily,
  isDelegationTool,
  toolArgSummary,
  toolElapsedMs,
  type ToolTimerEvent,
} from '../src/format/tool-meta.js'

describe('getToolFamily', () => {
  it('已知工具返回对应 family/verb', () => {
    expect(getToolFamily('read_file')).toEqual({ family: 'read', verb: 'read' })
    expect(getToolFamily('bash')).toEqual({ family: 'run', verb: 'run' })
    expect(getToolFamily('write_file')).toEqual({ family: 'write', verb: 'write' })
    expect(getToolFamily('grep')).toEqual({ family: 'find', verb: 'search' })
    expect(getToolFamily('delegate_task')).toEqual({ family: 'run', verb: 'delegate' })
    // PTC 单一执行工具与 Minimal 锚定编辑工具（梁神/官方极简 preset 的工具面）。
    expect(getToolFamily('run_code')).toEqual({ family: 'run', verb: 'run' })
    expect(getToolFamily('str_replace_editor')).toEqual({ family: 'write', verb: 'patch' })
  })

  it('未知名工具落 other/tool', () => {
    expect(getToolFamily('nope')).toEqual({ family: 'other', verb: 'tool' })
  })
})

describe('toolArgSummary', () => {
  it('read/write/edit 族取 basename（POSIX/Windows 分隔符都认）', () => {
    expect(toolArgSummary('read_file', { file_path: '/a/b/c.ts' })).toBe('c.ts')
    expect(toolArgSummary('write_file', { path: 'C:\\x\\y.ts' })).toBe('y.ts')
  })

  it('read 族缺失 file_path 时回退 path', () => {
    expect(toolArgSummary('read_file', { path: '/x/y.ts' })).toBe('y.ts')
  })

  it('read 族 file_path 与 path 都缺失：pathBasename(undefined) 回退空', () => {
    expect(toolArgSummary('edit_file', {})).toBe('')
  })

  it('bash 取 command 首行', () => {
    expect(toolArgSummary('bash', { command: 'npm test\n--watch' })).toBe('npm test')
  })

  it('run_code 取 code 首行；缺失 code 回退 description', () => {
    expect(toolArgSummary('run_code', { code: 'console.log(1)\n// more', description: 'run it' })).toBe('console.log(1)')
    expect(toolArgSummary('run_code', { description: 'run it' })).toBe('run it')
  })

  it('run_code 缺失 code 与 description 回退空串', () => {
    expect(toolArgSummary('run_code', {})).toBe('')
  })

  it('bash 缺失 command 回退空串', () => {
    expect(toolArgSummary('bash', {})).toBe('')
  })

  it('grep/glob/semantic_search 取 pattern', () => {
    expect(toolArgSummary('grep', { pattern: 'TODO' })).toBe('TODO')
    expect(toolArgSummary('glob', { pattern: '*.ts' })).toBe('*.ts')
  })

  it('检索族缺失 pattern 回退空串', () => {
    expect(toolArgSummary('semantic_search', {})).toBe('')
  })

  it('delegate_task 取 objective；delegate_batch 取 tasks 计数', () => {
    expect(toolArgSummary('delegate_task', { objective: '调研 X' })).toBe('调研 X')
    expect(toolArgSummary('delegate_batch', { tasks: [1, 2, 3] })).toBe('3 tasks')
    expect(toolArgSummary('delegate_batch', {})).toBe('? tasks')
  })

  it('delegate_task 缺失 objective 回退空串', () => {
    expect(toolArgSummary('delegate_task', {})).toBe('')
  })

  it('web_fetch 取 url；未知工具返回空串', () => {
    expect(toolArgSummary('web_fetch', { url: 'https://x.dev' })).toBe('https://x.dev')
    expect(toolArgSummary('nope', {})).toBe('')
  })

  it('web_fetch 缺失 url 回退空串', () => {
    expect(toolArgSummary('web_fetch', {})).toBe('')
  })

  it('超长摘要截断加省略号', () => {
    const long = 'x'.repeat(100)
    const s = toolArgSummary('bash', { command: long })
    expect(s.length).toBeLessThanOrEqual(55)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('formatElapsed', () => {
  it('<1s → 毫秒', () => {
    expect(formatElapsed(123)).toBe('123ms')
    expect(formatElapsed(-5)).toBe('0ms')
  })

  it('<60s → 秒一位小数', () => {
    expect(formatElapsed(1500)).toBe('1.5s')
  })

  it('>=60s → 分+秒补零', () => {
    expect(formatElapsed(65_000)).toBe('1m05s')
    expect(formatElapsed(3_605_000)).toBe('60m05s')
  })
})

describe('isDelegationTool', () => {
  it('delegate_task / delegate_batch 为真，其余为假', () => {
    expect(isDelegationTool('delegate_task')).toBe(true)
    expect(isDelegationTool('delegate_batch')).toBe(true)
    expect(isDelegationTool('bash')).toBe(false)
  })
})

describe('ToolTimer 投影', () => {
  function call(id: string, time: number): ToolTimerEvent {
    return { type: 'tool-call', time, callId: id as ToolCallId }
  }
  function result(id: string, time: number): ToolTimerEvent {
    return { type: 'tool-result', time, callId: id as ToolCallId }
  }

  it('call 记录起点；重复 call 以首次为准（no-op）', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, call('c1', 1000))
    const after = applyToolTimerEvent(s, call('c1', 2000))
    expect(after).toBe(s)
    expect(after.starts.get('c1' as ToolCallId)).toBe(1000)
  })

  it('result 定格耗时并移出 starts；无起点 no-op（返回原状态）', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, call('c1', 1000))
    s = applyToolTimerEvent(s, result('c1', 3500))
    expect(s.finished.get('c1' as ToolCallId)).toBe(2500)
    expect(s.starts.has('c1' as ToolCallId)).toBe(false)
    const ghost = applyToolTimerEvent(s, result('ghost', 5000))
    expect(ghost).toBe(s)
  })

  it('result 早于 call 时耗时按 0 定格', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, call('c1', 5000))
    s = applyToolTimerEvent(s, result('c1', 1000))
    expect(s.finished.get('c1' as ToolCallId)).toBe(0)
  })

  it('toolElapsedMs：进行中 = now − start；定格 = fixed；未知 = undefined', () => {
    let s = emptyToolTimer()
    s = applyToolTimerEvent(s, call('c1', 1000))
    expect(toolElapsedMs(s, 'c1' as ToolCallId, 3000)).toBe(2000)
    s = applyToolTimerEvent(s, result('c1', 2500))
    expect(toolElapsedMs(s, 'c1' as ToolCallId, 9999)).toBe(1500)
    expect(toolElapsedMs(s, 'ghost' as ToolCallId, 9999)).toBeUndefined()
  })
})
