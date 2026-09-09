/**
 * 工具元数据基础版 — tool-card 渲染的辅助函数合体。
 *
 * 源出 .rivet/tui-source/tui/ 的 tool-family.ts / tool-label.ts /
 * tool-elapsed.ts / tool-domain.ts（Apache-2.0 来源，见 LICENSE/NOTICE/
 * SOURCE-MAP.md）。本文件为 dsh-tui 移植的基础版：保留 tool-card 渲染所
 * 需的最小契约（family 判定、标题参数摘要、耗时格式化、委派工具识别），
 * 去掉天枢特有的星域映射与浏览器调试工具分支。
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** 工具家族：决定截断策略与 diff 分支。 */
export type ToolFamily = 'read' | 'write' | 'run' | 'find' | 'other'

/** 工具家族元数据：家族分类 + 卡片标题动词。 */
export interface ToolFamilyInfo {
  family: ToolFamily
  /** 卡片标题动词（Run/Read/Patch/Write/Search/Find…）。 */
  verb: string
}

const TOOL_MAP: Record<string, ToolFamilyInfo> = {
  read_file:       { family: 'read',  verb: 'read'   },
  glob:            { family: 'find',  verb: 'find'   },
  grep:            { family: 'find',  verb: 'search' },
  bash:            { family: 'run',   verb: 'run'    },
  // PTC/Code Mode 单一执行工具（wire 上模型直呼 run_code；标题走 run 族）。
  run_code:        { family: 'run',   verb: 'run'    },
  // Minimal/极简锚定 phase 的文件编辑工具（继承宿主沙箱；标题走 write 族）。
  str_replace_editor: { family: 'write', verb: 'patch' },
  edit_file:       { family: 'write', verb: 'patch'  },
  write_file:      { family: 'write', verb: 'write'  },
  apply_patch:     { family: 'write', verb: 'patch'  },
  run_tests:       { family: 'run',   verb: 'test'   },
  delegate_task:   { family: 'run',   verb: 'delegate' },
  delegate_batch:  { family: 'run',   verb: 'batch'  },
  web_fetch:       { family: 'read',  verb: 'fetch'  },
  inspect_project: { family: 'find',  verb: 'inspect' },
  repo_map:        { family: 'find',  verb: 'map'    },
  semantic_search: { family: 'find',  verb: 'search' },
  ask_user_question: { family: 'other', verb: 'ask'  },
}

const DEFAULT: ToolFamilyInfo = { family: 'other', verb: 'tool' }

/**
 * 工具家族元数据；未知名工具落 other/tool。
 * @param toolName - 工具名（模型原样产出）。
 * @returns 家族与标题动词。
 */
export function getToolFamily(toolName: string): ToolFamilyInfo {
  return TOOL_MAP[toolName] ?? DEFAULT
}

/** 截断辅助：超长文本尾部加省略号。 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** unknown → 文本：string 原样；number/boolean 用 String；对象/null/undefined → ''（防 [object Object]）。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 路径 basename（POSIX/Windows 分隔符都认）。 */
function pathBasename(value: unknown): string {
  return textOf(value).replace(/^.*[/\\]/, '')
}

/**
 * 工具的主参数摘要（不含动词前缀）——供 `● Verb(arg)` 卡片标题使用。
 * 基础版只摘录最常用的参数字段；未知工具返回空串。
 * @param name - 工具名（决定摘录哪个参数字段）。
 * @param input - 工具输入参数（模型产出的已解析 JSON 对象）。
 * @returns 截断后的主参数摘要；未知工具返回空串。
 */
export function toolArgSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return truncate(pathBasename(input.file_path ?? input.path), 45)
    case 'bash':
      /* v8 ignore next -- split('\n') 恒返回非空数组，[0] 恒存在；noUncheckedIndexedAccess 收窄防御 */
      return truncate(textOf(input.command).split('\n')[0] ?? '', 55)
    case 'run_code':
      // PTC 单一执行工具：schema 必填 code（执行代码）与 description；摘录
      // code 首行（与 bash command 同模式），description 兜底。
      return truncate(
        (textOf(input.code).split('\n')[0] ?? '')
          || textOf(input.description),
        55,
      )
    case 'grep':
    case 'glob':
    case 'semantic_search':
      return truncate(textOf(input.pattern), 35)
    case 'delegate_task':
      return truncate(textOf(input.objective), 50)
    case 'delegate_batch':
      return `${Array.isArray(input.tasks) ? input.tasks.length : '?'} tasks`
    case 'web_fetch':
      return truncate(textOf(input.url), 50)
    default:
      return ''
  }
}

/**
 * 容错解析 tool/call 的 arguments JSON（模型产出，wire 边界必须运行时校验）。
 * 解析失败/非对象返回 undefined——卡片显示纯动词标题。
 * @param raw - 模型产出的原始 arguments JSON 字符串。
 * @returns 解析出的对象；空串/非对象/解析失败为 undefined。
 */
export function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 精确耗时（Claude Code 风）：<1s → `123ms`，<60s → `1.5s`，否则 `1m05s`。
 * @param ms - 毫秒耗时；负数按 0。
 * @returns 人类可读的耗时文本。
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m${String(secs).padStart(2, '0')}s`
}

/**
 * 该工具是否归子代理编排族（delegate_*）。
 * @param name - 工具名。
 * @returns delegate_task/delegate_batch 时 true。
 */
export function isDelegationTool(name: string): boolean {
  return name === 'delegate_task' || name === 'delegate_batch'
}

// ── Phase 7.1 工具运行计时器（纯投影状态机）─────────────────────
// 由 `tool/call`（开始）与 `tool/result`（停止）驱动，只消费 {type,time,callId}
// 最小契约——时间取自 SessionEvent.time（Unix epoch ms），callId 取
// tool/call.data.callId / tool/result 的 source.callId。不写回 session log。

/** 计时器事件最小契约（投影输入；由调用方从 SessionEvent 提取）。 */
export interface ToolTimerEvent {
  type: 'tool-call' | 'tool-result'
  /** Unix epoch ms，与 SessionEvent.time 对齐。 */
  time: number
  callId: ToolCallId
}

/** 工具计时状态：进行中（starts）与已定格（finished）的 callId → 时刻/耗时。 */
export interface ToolTimerState {
  /** callId → tool/call 时刻（ms）。 */
  readonly starts: ReadonlyMap<ToolCallId, number>
  /** callId → tool/result 定格耗时（ms）。result 后保留，供终态展示。 */
  readonly finished: ReadonlyMap<ToolCallId, number>
}

/**
 * 空计时状态。
 * @returns starts/finished 均为空 Map 的初始状态。
 */
export function emptyToolTimer(): ToolTimerState {
  return { starts: new Map(), finished: new Map() }
}

/**
 * 折叠一个工具计时事件，返回 NEW 状态（纯投影）。
 * - tool-call：记录起点；同一 callId 重复 call 以首次为准。
 * - tool-result：有匹配起点时定格耗时并移出 starts；无匹配起点 no-op（返回原状态）。
 * @param state - 当前计时状态（不被修改）。
 * @param event - 计时事件（由调用方从 SessionEvent 提取的最小契约）。
 * @returns 折叠后的新状态；no-op 时返回原状态引用。
 */
export function applyToolTimerEvent(state: ToolTimerState, event: ToolTimerEvent): ToolTimerState {
  if (event.type === 'tool-call') {
    if (state.starts.has(event.callId)) return state
    return { ...state, starts: new Map(state.starts).set(event.callId, event.time) }
  }
  const start = state.starts.get(event.callId)
  if (start === undefined) return state
  const starts = new Map(state.starts)
  starts.delete(event.callId)
  return {
    starts,
    finished: new Map(state.finished).set(event.callId, Math.max(0, event.time - start)),
  }
}

/**
 * 查询 callId 的当前耗时：进行中 = nowMs − 起点；已定格 = 固定值。
 * @param state - 当前计时状态。
 * @param callId - 目标工具调用 id。
 * @param nowMs - 当前时刻（Unix epoch ms，进行中耗时的参照）。
 * @returns 毫秒耗时；该 callId 从未出现返回 undefined。
 */
export function toolElapsedMs(state: ToolTimerState, callId: ToolCallId, nowMs: number): number | undefined {
  const start = state.starts.get(callId)
  if (start !== undefined) return Math.max(0, nowMs - start)
  return state.finished.get(callId)
}
