/**
 * summary-state — 会话工具调用汇总投影（纯状态机，无 IO）。
 *
 * 输入 SessionEvent 流（turn/start、tool/call、tool/result、turn/end），
 * 折叠为会话级/轮级工具统计。turn 未结束不计入会话汇总。
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
// 家族映射唯一来源：format/tool-family（着色与统计共用同一「工具名 → 功能域」，
// 投影不重复造轮子——projection-layer.md 契约）。
import { getToolColorFamily, type ToolFamily } from './format/tool-family.js'

/** 按工具功能域（file/shell/search/edit/network/other）分桶的调用计数。 */
export interface FamilyCounts {
  file: number
  shell: number
  search: number
  edit: number
  network: number
  other: number
}

/** 单轮完成后的工具统计快照：总数、失败数、按域分桶。 */
export interface TurnSummary {
  toolCount: number
  failedCount: number
  byFamily: FamilyCounts
}

/**
 * 会话级汇总状态：累计轮数/调用数/耗时、进行中轮的实时计数
 * （callTimes 记录未回结果的调用起始时间）、最近完成轮的快照。
 */
export interface SummaryState {
  sessionId: SessionId
  totalTurns: number
  totalToolCalls: number
  totalElapsedMs: number
  currentTurn: {
    toolCount: number
    failedCount: number
    byFamily: FamilyCounts
    startTime: number | undefined
    elapsedMs: number
    callTimes: Map<ToolCallId, number>
  }
  lastCompleted: { turn: number; summary: TurnSummary } | undefined
  byFamily: FamilyCounts
}

const EMPTY_FAMILY = (): FamilyCounts => ({ file: 0, shell: 0, search: 0, edit: 0, network: 0, other: 0 })

/**
 * 全零初始状态。
 * @param sessionId - 汇总所属的会话 id。
 * @returns 各计数为 0、无进行中轮的初始 SummaryState。
 */
export function emptySummaryState(sessionId: SessionId): SummaryState {
  return {
    sessionId,
    totalTurns: 0,
    totalToolCalls: 0,
    totalElapsedMs: 0,
    currentTurn: {
      toolCount: 0,
      failedCount: 0,
      byFamily: EMPTY_FAMILY(),
      startTime: undefined,
      elapsedMs: 0,
      callTimes: new Map(),
    },
    lastCompleted: undefined,
    byFamily: EMPTY_FAMILY(),
  }
}

function addFamily(target: FamilyCounts, family: ToolFamily): void {
  target[family] += 1
}

/**
 * 折叠一条会话事件：turn/start 重置轮内计数，tool/call 与 tool/result
 * 累计调用/失败/耗时，turn/end 把轮内快照并入会话累计；其余事件原样返回。
 * @param state - 当前汇总状态（不被就地修改）。
 * @param event - 会话事件。
 * @returns 折叠后的新状态；与本投影无关的事件返回原 state。
 */
export function applySummaryEvent(state: SummaryState, event: SessionEvent): SummaryState {
  switch (event.type) {
    case 'turn/start': {
      return {
        ...state,
        currentTurn: {
          ...state.currentTurn,
          toolCount: 0,
          failedCount: 0,
          byFamily: EMPTY_FAMILY(),
          startTime: event.time,
          elapsedMs: 0,
          callTimes: new Map(),
        },
      }
    }
    case 'tool/call': {
      const { callId, name } = event.data
      const byFamily = { ...state.currentTurn.byFamily }
      addFamily(byFamily, getToolColorFamily(name))
      const callTimes = new Map(state.currentTurn.callTimes)
      callTimes.set(callId, event.time)
      return {
        ...state,
        currentTurn: {
          ...state.currentTurn,
          toolCount: state.currentTurn.toolCount + 1,
          byFamily,
          callTimes,
        },
      }
    }
    case 'tool/result': {
      // tool/result 事件类型保证 message.source.kind === 'tool'（typed 边界，
      // 不做运行时守卫——AGENTS.md 信任同进程类型化边界）。
      const source = event.data.message.source
      const callTime = state.currentTurn.callTimes.get(source.callId)
      if (callTime === undefined) return state
      const elapsed = Math.max(0, event.time - callTime)
      const callTimes = new Map(state.currentTurn.callTimes)
      callTimes.delete(source.callId)
      const failed = event.data.error !== undefined
      return {
        ...state,
        currentTurn: {
          ...state.currentTurn,
          failedCount: state.currentTurn.failedCount + (failed ? 1 : 0),
          elapsedMs: state.currentTurn.elapsedMs + elapsed,
          callTimes,
        },
      }
    }
    case 'turn/end': {
      if (state.currentTurn.startTime === undefined) return state
      const summary: TurnSummary = {
        toolCount: state.currentTurn.toolCount,
        failedCount: state.currentTurn.failedCount,
        byFamily: { ...state.currentTurn.byFamily },
      }
      const byFamily: FamilyCounts = {
        file: state.byFamily.file + summary.byFamily.file,
        shell: state.byFamily.shell + summary.byFamily.shell,
        search: state.byFamily.search + summary.byFamily.search,
        edit: state.byFamily.edit + summary.byFamily.edit,
        network: state.byFamily.network + summary.byFamily.network,
        other: state.byFamily.other + summary.byFamily.other,
      }
      return {
        ...state,
        totalTurns: state.totalTurns + 1,
        totalToolCalls: state.totalToolCalls + summary.toolCount,
        totalElapsedMs: state.totalElapsedMs + state.currentTurn.elapsedMs,
        byFamily,
        lastCompleted: { turn: event.data.turn, summary },
        currentTurn: {
          ...state.currentTurn,
          toolCount: 0,
          failedCount: 0,
          byFamily: EMPTY_FAMILY(),
          startTime: undefined,
          elapsedMs: 0,
          callTimes: new Map(),
        },
      }
    }
    default:
      return state
  }
}

/**
 * 重放事件数组为聚合状态。
 * @param sessionId - 汇总所属的会话 id。
 * @param events - 按序重放的会话事件。
 * @returns 从空状态依次折叠全部事件后的 SummaryState。
 */
export function summarizeSession(sessionId: SessionId, events: readonly SessionEvent[]): SummaryState {
  let state = emptySummaryState(sessionId)
  for (const event of events) state = applySummaryEvent(state, event)
  return state
}
