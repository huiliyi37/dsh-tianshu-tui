/**
 * turn-summary — 单轮工具调用统计模型（纯状态机）。
 *
 * 与 format/turn-summary.ts（渲染层）区分：本文件是事件折叠模型，
 * 输入 SessionEvent（tool/call + tool/result），输出轮级统计。
 */
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type ToolFamily } from './format/tool-family.js';
/** 单次工具调用记录（tool/call 建档，tool/result 配对补齐耗时与失败位）。 */
export interface ToolCallRecord {
    callId: ToolCallId;
    name: string;
    family: ToolFamily;
    startedAt: number;
    /** tool/result 带 error 时置位。 */
    failed?: boolean;
    /** tool/result 配对后定格的耗时（原始时间戳差）。 */
    elapsedMs?: number;
}
/** 轮级统计：调用明细 + 计数/耗时/家族分布累计（totalElapsedMs 为原始时间戳差）。 */
export interface TurnSummaryState {
    turn: number;
    calls: ToolCallRecord[];
    toolCount: number;
    failedCount: number;
    totalElapsedMs: number;
    byFamily: Record<ToolFamily, number>;
}
/**
 * 空轮级统计（全零计数）。
 * @param turn - 轮号。
 * @returns 初始统计状态。
 */
export declare function emptyTurnSummary(turn: number): TurnSummaryState;
/**
 * 折叠 SessionEvent：tool/call 计数 + 家族分类；tool/result 计时 + 失败计数。
 * turn/start 重置为该轮的空统计；未配对的 tool/result 与其余事件不改变状态。
 * @param state - 当前统计状态。
 * @param event - 会话事件。
 * @returns 新统计状态。
 */
export declare function applyTurnEvent(state: TurnSummaryState, event: SessionEvent): TurnSummaryState;
/**
 * 轮级摘要文本：`N tools · elapsed · file×k edit×k · N failed`（elapsed 秒一位小数；
 * totalElapsedMs 为真实毫秒——SessionEvent.time 是 epoch 毫秒）。
 * @param state - 轮级统计状态。
 * @returns 摘要文本（零值段省略）。
 */
export declare function formatTurnSummary(state: TurnSummaryState): string;
/**
 * 重放事件数组，只折叠指定 turn 的事件。
 * @param turn - 目标轮号。
 * @param events - 完整会话事件数组。
 * @returns 该轮的统计状态。
 */
export declare function summarizeTurn(turn: number, events: readonly SessionEvent[]): TurnSummaryState;
