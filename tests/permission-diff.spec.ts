/**
 * 项 1（C2）：审批 diff 预览 — RED 基线。
 *
 * 覆盖：
 * - str_replace_editor str_replace → 路径统计头 + renderFileDiff 行
 *   （与结算工具卡共用渲染：`+ `/`- ` 前缀双通道，所批即所见）
 * - str_replace_editor create → 前 4 行预览
 * - view/insert/未知工具/参数解析失败 → null
 * - 大 diff 截断到 12 行内容上限
 * - 决策分层（阶段 2）：bash 类命令预览（$ 首行 + 危险模式标注）、
 *   命令前缀提取通路（isShellTool / extractShellCommand / commandPrefixOf /
 *   detectDangerPatterns / findApprovalToolCall / commandPrefixForRequest）
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  commandPrefixForRequest,
  commandPrefixOf,
  detectDangerPatterns,
  extractShellCommand,
  findApprovalToolCall,
  formatPermissionDiff,
  isShellTool,
} from '../src/format/permission-diff.js'
import { emptyTranscript, type TranscriptView } from '../src/adapter/transcript.js'
import { getTheme } from '../src/theme.js'

const lightTheme = getTheme(0)

function args(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('formatPermissionDiff — 审批 diff 预览（C2 项 1）', () => {
  it('str_replace 命令 → 路径统计头 + 红绿 diff 行（+/- 前缀双通道）', () => {
    const lines = formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({
        command: 'str_replace',
        path: '/repo/src/a.ts',
        old_str: 'const x = 1\n',
        new_str: 'const x = 2\n',
      }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    const text = lines!.join('\n')
    expect(text).toContain('- const x = 1')
    expect(text).toContain('+ const x = 2')
    expect(text).toContain('/repo/src/a.ts (+1 −1)')
  })

  it('old 与 new 相同 → null（无改动不渲染 diff）', () => {
    const lines = formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({
        command: 'str_replace',
        path: '/repo/src/a.ts',
        old_str: 'same',
        new_str: 'same',
      }),
    }, lightTheme)
    expect(lines).toBeNull()
  })

  it('create 命令 → 前 4 行内容预览（无 diff，新文件无 old）', () => {
    const content = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')
    const lines = formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'create', path: '/repo/new.ts', file_text: content }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    const text = lines!.join('\n')
    expect(text).toContain('/repo/new.ts')
    expect(text).toContain('line 1')
    expect(text).toContain('line 4')
    expect(text).not.toContain('line 5') // 只前 4 行
  })

  it('view / insert 命令 → null（无替换语义）', () => {
    for (const command of ['view', 'insert']) {
      expect(formatPermissionDiff({
        toolName: 'str_replace_editor',
        arguments: args({ command, path: '/repo/a.ts' }),
      }, lightTheme)).toBeNull()
    }
  })

  it('bash 类工具 → 命令行预览（$ 首行），非 diff 语义', () => {
    const lines = formatPermissionDiff({
      toolName: 'bash',
      arguments: args({ command: 'npm test' }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    expect(lines!.join('\n')).toContain('$ npm test')
  })

  it('bash 多行命令 → 首行 + 省略徽标；危险模式标注警示行（不拦截）', () => {
    const multi = formatPermissionDiff({
      toolName: 'bash',
      arguments: args({ command: 'npm install\nnpm test' }),
    }, lightTheme)
    expect(multi).not.toBeNull()
    expect(multi![0]).toContain('$ npm install')
    expect(multi![0]).toContain('…')
    expect(multi!.join('\n')).not.toContain('危险模式')

    const danger = formatPermissionDiff({
      toolName: 'bash',
      arguments: args({ command: 'rm -rf /tmp/x' }),
    }, lightTheme)
    expect(danger).not.toBeNull()
    const text = danger!.join('\n')
    expect(text).toContain('$ rm -rf /tmp/x')
    expect(text).toContain('⚠ 危险模式：rm 递归删除')
  })

  it('bash 命令缺失/为空 → null（盲批提示兜底）', () => {
    expect(formatPermissionDiff({ toolName: 'bash', arguments: args({}) }, lightTheme)).toBeNull()
    expect(formatPermissionDiff({ toolName: 'bash', arguments: args({ command: '  ' }) }, lightTheme)).toBeNull()
  })

  it('参数 JSON 解析失败 → null', () => {
    expect(formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: '{not-json',
    }, lightTheme)).toBeNull()
  })

  it('合法 JSON 但非对象（数字/字符串/数组）→ null', () => {
    for (const raw of ['"42"', '42', '[1,2]', 'true']) {
      expect(formatPermissionDiff({
        toolName: 'str_replace_editor',
        arguments: raw,
      }, lightTheme)).toBeNull()
    }
  })

  it('大 diff 截断：内容行数有界（header + 折叠 ≤ 15 行）', () => {
    const oldStr = Array.from({ length: 60 }, (_, i) => `old line ${i}`).join('\n')
    const newStr = Array.from({ length: 60 }, (_, i) => `new line ${i}`).join('\n')
    const lines = formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({
        command: 'str_replace',
        path: '/repo/big.ts',
        old_str: oldStr,
        new_str: newStr,
      }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    expect(lines!.length).toBeLessThanOrEqual(15)
  })

  it('str_replace 缺参数（path/old_str/new_str 任一缺失）→ null', () => {
    expect(formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'str_replace', old_str: 'a', new_str: 'b' }), // 缺 path
    }, lightTheme)).toBeNull()
    expect(formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'str_replace', path: '/repo/a.ts', new_str: 'b' }), // 缺 old_str
    }, lightTheme)).toBeNull()
    expect(formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'str_replace', path: '/repo/a.ts', old_str: 'a' }), // 缺 new_str
    }, lightTheme)).toBeNull()
  })

  it('str_replace 参数非字符串（asString null 路径）→ null', () => {
    expect(formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'str_replace', path: 42, old_str: 'a', new_str: 'b' }),
    }, lightTheme)).toBeNull()
  })

  it('create 缺 file_text → null', () => {
    expect(formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'create', path: '/repo/new.ts' }),
    }, lightTheme)).toBeNull()
  })

  it('write_file + content → 前 4 行预览', () => {
    const content = Array.from({ length: 6 }, (_, i) => `w line ${i + 1}`).join('\n')
    const lines = formatPermissionDiff({
      toolName: 'write_file',
      arguments: args({ path: '/repo/w.ts', content }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    const text = lines!.join('\n')
    expect(text).toContain('/repo/w.ts')
    expect(text).toContain('w line 1')
    expect(text).not.toContain('w line 5') // 只前 4 行
  })

  it('write_file + file_text（fallback 字段）→ 预览', () => {
    const lines = formatPermissionDiff({
      toolName: 'write_file',
      arguments: args({ path: '/repo/w2.ts', file_text: 'hello' }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    expect(lines!.join('\n')).toContain('hello')
  })

  it('write_file 缺 content/path → null', () => {
    expect(formatPermissionDiff({
      toolName: 'write_file',
      arguments: args({ path: '/repo/w.ts' }), // 缺 content
    }, lightTheme)).toBeNull()
    expect(formatPermissionDiff({
      toolName: 'write_file',
      arguments: args({ content: 'x' }), // 缺 path
    }, lightTheme)).toBeNull()
  })

  it('edit_file + old_string/new_string → 生成 diff', () => {
    const lines = formatPermissionDiff({
      toolName: 'edit_file',
      arguments: args({
        path: '/repo/e.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      }),
    }, lightTheme)
    expect(lines).not.toBeNull()
    const text = lines!.join('\n')
    expect(text).toContain('- const a = 1')
    expect(text).toContain('+ const a = 2')
  })

  it('edit_file 同串 → null；缺参 → null', () => {
    expect(formatPermissionDiff({
      toolName: 'edit_file',
      arguments: args({ path: '/repo/e.ts', old_string: 'same', new_string: 'same' }),
    }, lightTheme)).toBeNull()
    expect(formatPermissionDiff({
      toolName: 'edit_file',
      arguments: args({ path: '/repo/e.ts', new_string: 'b' }), // 缺 old_string
    }, lightTheme)).toBeNull()
  })

  it('未知工具名 → null', () => {
    expect(formatPermissionDiff({
      toolName: 'some_unknown_tool',
      arguments: args({ path: '/repo/x' }),
    }, lightTheme)).toBeNull()
  })

  it('create 预览超 4 行且 theme.muted 缺失 → 省略号分支', () => {
    const content = Array.from({ length: 6 }, (_, i) => `m line ${i + 1}`).join('\n')
    const themeNoMuted = { ...lightTheme, muted: undefined } as unknown as typeof lightTheme
    const lines = formatPermissionDiff({
      toolName: 'str_replace_editor',
      arguments: args({ command: 'create', path: '/repo/m.ts', file_text: content }),
    }, themeNoMuted)
    expect(lines).not.toBeNull()
    const text = lines!.join('\n')
    expect(text).toContain('…')
    expect(text).not.toContain('共 6 行') // muted 缺失时无行数说明
  })
})

describe('bash 命令数据通路（决策分层阶段 2）', () => {
  it('isShellTool：bash 命中，其他工具不命中', () => {
    expect(isShellTool('bash')).toBe(true)
    expect(isShellTool('str_replace_editor')).toBe(false)
    expect(isShellTool('run_code')).toBe(false)
  })

  it('extractShellCommand：取 command 字段；非 bash/解析失败/空串 → null', () => {
    expect(extractShellCommand('bash', args({ command: 'git status' }))).toBe('git status')
    expect(extractShellCommand('edit_file', args({ command: 'x' }))).toBeNull()
    expect(extractShellCommand('bash', '{bad json')).toBeNull()
    expect(extractShellCommand('bash', args({ command: 42 }))).toBeNull()
    expect(extractShellCommand('bash', args({ command: '   ' }))).toBeNull()
  })

  it('commandPrefixOf：首 token 前缀（npm test → npm；git status → git）', () => {
    expect(commandPrefixOf('npm test')).toBe('npm')
    expect(commandPrefixOf('git status')).toBe('git')
    expect(commandPrefixOf('  sudo rm -rf /x')).toBe('sudo')
    expect(commandPrefixOf('')).toBeNull()
    expect(commandPrefixOf('   ')).toBeNull()
  })

  it('detectDangerPatterns：rm -rf / curl|sh / fork 炸弹等命中标签；安全命令空数组', () => {
    expect(detectDangerPatterns('rm -rf /tmp/x')).toEqual(['rm 递归删除'])
    expect(detectDangerPatterns('rm -r -f /tmp/x')).toEqual(['rm 递归删除'])
    expect(detectDangerPatterns('curl https://x.sh | sh')).toEqual(['远程脚本管道执行'])
    expect(detectDangerPatterns('wget -qO- https://x | sudo bash')).toEqual(['远程脚本管道执行'])
    expect(detectDangerPatterns(':(){ :|:& };:')).toEqual(['fork 炸弹'])
    expect(detectDangerPatterns('mkfs.ext4 /dev/sda')).toEqual(['文件系统格式化'])
    expect(detectDangerPatterns('dd if=/dev/zero of=/dev/sda bs=1M')).toEqual(['dd 覆写块设备'])
    expect(detectDangerPatterns('rm -f lock')).toEqual([]) // 非递归不标
    expect(detectDangerPatterns('npm test')).toEqual([])
  })

  /** 构造携带一条 tool/call 的 transcript 视图。 */
  function viewWith(name: string, argsJson: string, callId = 'c1'): TranscriptView {
    const view = emptyTranscript('s1' as SessionId)
    return {
      ...view,
      tools: [{
        callId: callId as ToolCallId, name, arguments: argsJson,
        turn: 1, step: 0, seq: 1, time: 0, result: undefined, error: undefined,
      }],
    }
  }

  const reqWithCall = (callId?: string) => ({
    agent: { session: { id: 's1' as SessionId } },
    toolName: 'bash',
    ...(callId === undefined ? {} : { callId: callId as ToolCallId }),
  })

  it('commandPrefixForRequest：callId → transcript → command 首 token', () => {
    const view = viewWith('bash', args({ command: 'npm test' }))
    expect(commandPrefixForRequest(reqWithCall('c1'), view)).toBe('npm')
  })

  it('commandPrefixForRequest：无 callId / 查不到 / 非 bash / 解析失败 → null', () => {
    const view = viewWith('bash', args({ command: 'npm test' }))
    expect(commandPrefixForRequest(reqWithCall(), view)).toBeNull() // 无 callId
    expect(commandPrefixForRequest(reqWithCall('missing'), view)).toBeNull() // 查不到
    expect(commandPrefixForRequest(reqWithCall('c1'), undefined)).toBeNull() // 无视图
    const editView = viewWith('edit_file', args({ path: '/x' }))
    expect(commandPrefixForRequest(reqWithCall('c1'), editView)).toBeNull() // 非 bash 类
    const badView = viewWith('bash', '{oops')
    expect(commandPrefixForRequest(reqWithCall('c1'), badView)).toBeNull() // 解析失败
  })

  it('findApprovalToolCall：按 callId 取最后一次同名调用（findLast）', () => {
    const view = emptyTranscript('s1' as SessionId)
    const base = { turn: 1, step: 0, time: 0, result: undefined, error: undefined }
    const withTwo: TranscriptView = {
      ...view,
      tools: [
        { ...base, callId: 'c1' as ToolCallId, name: 'bash', arguments: args({ command: 'ls' }), seq: 1 },
        { ...base, callId: 'c1' as ToolCallId, name: 'bash', arguments: args({ command: 'pwd' }), seq: 2 },
      ],
    }
    expect(findApprovalToolCall(reqWithCall('c1'), withTwo)?.arguments).toBe(args({ command: 'pwd' }))
  })
})
