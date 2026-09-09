/**
 * turn-summary — 单轮工具调用统计模型（纯状态机）。
 *
 * 与 format/turn-summary.ts（渲染层）区分：本文件是事件折叠模型，
 * 输入 SessionEvent（tool/call + tool/result），输出轮级统计。
 */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { getToolColorFamily, type ToolFamily } from './format/tool-family.js'

/** 单次工具调用记录（tool/call 建档，tool/result 配对补齐耗时与失败位）。 */
export interface ToolCallRecord {
  callId: ToolCallId
  name: string
  family: ToolFamily
  startedAt: number
  /** tool/result 带 error 时置位。 */
  failed?: boolean
  /** tool/result 配对后定格的耗时（原始时间戳差）。 */
  elapsedMs?: number
}

/** 轮级统计：调用明细 + 计数/耗时/家族分布累计（totalElapsedMs 为原始时间戳差）。 */
export interface TurnSummaryState {
  turn: number
  calls: ToolCallRecord[]
  toolCount: number
  failedCount: number
  totalElapsedMs: number
  byFamily: Record<ToolFamily, number>
}

const EMPTY_FAMILY = (): Record<ToolFamily, number> => ({ file: 0, shell: 0, search: 0, edit: 0, network: 0, other: 0 })

/**
 * 空轮级统计（全零计数）。
 * @param turn - 轮号。
 * @returns 初始统计状态。
 */
export function emptyTurnSummary(turn: number): TurnSummaryState {
  return { turn, calls: [], toolCount: 0, failedCount: 0, totalElapsedMs: 0, byFamily: EMPTY_FAMILY() }
}

/**
 * 折叠 SessionEvent：tool/call 计数 + 家族分类；tool/result 计时 + 失败计数。
 * turn/start 重置为该轮的空统计；未配对的 tool/result 与其余事件不改变状态。
 * @param state - 当前统计状态。
 * @param event - 会话事件。
 * @returns 新统计状态。
 */
export function applyTurnEvent(state: TurnSummaryState, event: SessionEvent): TurnSummaryState {
  switch (event.type) {
    case 'tool/call': {
      const { callId, name } = event.data
      const family = getToolColorFamily(name)
      return {
        ...state,
        calls: [...state.calls, { callId, name, family, startedAt: event.time }],
        toolCount: state.toolCount + 1,
        byFamily: { ...state.byFamily, [family]: state.byFamily[family] + 1 },
      }
    }
    case 'tool/result': {
      // tool/result 事件类型保证 message.source.kind === 'tool'（typed 边界，
      // 不做运行时守卫——AGENTS.md 信任同进程类型化边界）。
      const source = event.data.message.source
      const record = state.calls.find(c => c.callId === source.callId)
      if (record === undefined) return state
      const failed = event.data.error !== undefined
      // SessionEvent.time 是 Unix epoch 毫秒：差值即真实毫秒耗时。
      const elapsedMs = Math.max(0, event.time - record.startedAt)
      return {
        ...state,
        calls: state.calls.map(c => c.callId === source.callId ? { ...c, failed, elapsedMs: Math.max(0, event.time - c.startedAt) } : c),
        failedCount: state.failedCount + (failed ? 1 : 0),
        totalElapsedMs: state.totalElapsedMs + elapsedMs,
      }
    }
    case 'turn/start':
      return emptyTurnSummary(event.data.turn)
    default:
      return state
  }
}

/**
 * 轮级摘要文本：`N tools · elapsed · file×k edit×k · N failed`（elapsed 秒一位小数；
 * totalElapsedMs 为真实毫秒——SessionEvent.time 是 epoch 毫秒）。
 * @param state - 轮级统计状态。
 * @returns 摘要文本（零值段省略）。
 */
export function formatTurnSummary(state: TurnSummaryState): string {
  const parts: string[] = [`${state.toolCount} tool${state.toolCount === 1 ? '' : 's'}`]
  if (state.totalElapsedMs > 0) parts.push(`${(state.totalElapsedMs / 1000).toFixed(1)}s`)
  const familyParts: string[] = []
  const order: readonly ToolFamily[] = ['file', 'shell', 'search', 'edit', 'network', 'other']
  for (const family of order) {
    if (state.byFamily[family] > 0) familyParts.push(`${family}×${state.byFamily[family]}`)
  }
  if (familyParts.length > 0) parts.push(familyParts.join(' '))
  if (state.failedCount > 0) parts.push(`${state.failedCount} failed`)
  return parts.join(' · ')
}

/**
 * 重放事件数组，只折叠指定 turn 的事件。
 * @param turn - 目标轮号。
 * @param events - 完整会话事件数组。
 * @returns 该轮的统计状态。
 */
export function summarizeTurn(turn: number, events: readonly SessionEvent[]): TurnSummaryState {
  let state = emptyTurnSummary(turn)
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn !== turn) continue
    if (event.type === 'tool/call' && event.data.turn !== turn) continue
    if (event.type === 'tool/result' && event.data.turn !== turn) continue
    state = applyTurnEvent(state, event)
  }
  return state
}
