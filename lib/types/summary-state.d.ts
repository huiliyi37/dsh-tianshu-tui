/**
 * summary-state — 会话工具调用汇总投影（纯状态机，无 IO）。
 *
 * 输入 SessionEvent 流（turn/start、tool/call、tool/result、turn/end），
 * 折叠为会话级/轮级工具统计。turn 未结束不计入会话汇总。
 */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
/** 按工具功能域（file/shell/search/edit/network/other）分桶的调用计数。 */
export interface FamilyCounts {
    file: number;
    shell: number;
    search: number;
    edit: number;
    network: number;
    other: number;
}
/** 单轮完成后的工具统计快照：总数、失败数、按域分桶。 */
export interface TurnSummary {
    toolCount: number;
    failedCount: number;
    byFamily: FamilyCounts;
}
/**
 * 会话级汇总状态：累计轮数/调用数/耗时、进行中轮的实时计数
 * （callTimes 记录未回结果的调用起始时间）、最近完成轮的快照。
 */
export interface SummaryState {
    sessionId: SessionId;
    totalTurns: number;
    totalToolCalls: number;
    totalElapsedMs: number;
    currentTurn: {
        toolCount: number;
        failedCount: number;
        byFamily: FamilyCounts;
        startTime: number | undefined;
        elapsedMs: number;
        callTimes: Map<ToolCallId, number>;
    };
    lastCompleted: {
        turn: number;
        summary: TurnSummary;
    } | undefined;
    byFamily: FamilyCounts;
}
/**
 * 全零初始状态。
 * @param sessionId - 汇总所属的会话 id。
 * @returns 各计数为 0、无进行中轮的初始 SummaryState。
 */
export declare function emptySummaryState(sessionId: SessionId): SummaryState;
/**
 * 折叠一条会话事件：turn/start 重置轮内计数，tool/call 与 tool/result
 * 累计调用/失败/耗时，turn/end 把轮内快照并入会话累计；其余事件原样返回。
 * @param state - 当前汇总状态（不被就地修改）。
 * @param event - 会话事件。
 * @returns 折叠后的新状态；与本投影无关的事件返回原 state。
 */
export declare function applySummaryEvent(state: SummaryState, event: SessionEvent): SummaryState;
/**
 * 重放事件数组为聚合状态。
 * @param sessionId - 汇总所属的会话 id。
 * @param events - 按序重放的会话事件。
 * @returns 从空状态依次折叠全部事件后的 SummaryState。
 */
export declare function summarizeSession(sessionId: SessionId, events: readonly SessionEvent[]): SummaryState;
