/**
 * 并行工具分组折叠（基础版）— Phase 7.3。
 *
 * 源出天枢 `.rivet/tui-source/tui/engine/tool-group-controller.ts` +
 * `engine/tool-accumulator.ts` 的「并行调用聚合展示」意图。本文件是
 * dsh-tui 移植的纯投影内核：按 (turn, step) 把同一 step 内并行发起的
 * tool/call 聚合为一组，tool/result 按 callId 绑定回所属 entry；展开/折叠
 * 是纯函数切换的 UI 状态。去掉天枢的 app 级 buffer/accumulator 生命周期
 * 与 read+search 族分类（反目标：不做 app 装配，本模块零 IO、零写回——
 * 反目标只约束 app 装配，不约束投影内核被渲染层消费）。
 *
 * 数据源：分组维度 (turn, step) 与 callId/name/arguments 对应
 * TranscriptToolCall（adapter/transcript.ts:46-47）；投影输入事件由
 * 调用方从 SessionEvent 提取最小字段子集（见 ToolGroupEvent）。
 *
 * 消费链（静态事实）：buildToolGroupSummary 已被 format/tool-card.ts:369
 * 的 formatToolGroup 消费（折叠/展开态渲染）；formatToolGroup 挂到 app
 * 层（LiveEngine 装配）的接线未做——登记预留，待预算解决由 app 层承担，
 * 不在本模块范围（见反目标）。
 *
 * 与 tool-meta.ts 的 ToolTimerEvent 同一纪律：不发明事件类型，只消费
 * tool/call、tool/result 的最小字段子集；fold 不写回 session log，
 * 未知 callId 的 result 是 no-op（返回原状态引用）。
 */
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
/** 分组折叠的事件最小契约（投影输入；由调用方从 SessionEvent 提取）。
 *  - tool-call：必填 callId/turn/step/name/arguments（与 live.ts 提取一致）。
 *  - tool-result：只按 callId 绑定——turn/step 由所属 entry 决定，乱序到达
 *    也正确；content 为已折叠的结果文本（与 render.ts 提取逻辑同构）。 */
export interface ToolGroupEvent {
    type: 'tool-call' | 'tool-result';
    callId: ToolCallId;
    /** tool/call 所属 turn。 */
    turn?: number;
    /** tool/call 所属 step（同 step 内并行调用聚合为一组）。 */
    step?: number;
    /** 工具名（模型原样产出）。 */
    name?: string;
    /** 原始参数 JSON 字符串（未解析，与 TranscriptToolCall 一致）。 */
    arguments?: string;
    /** tool-result：折叠后的结果文本（无结果时为空串）。 */
    content?: string;
    /** tool-result：是否错误输出。 */
    isError?: boolean;
}
/** 组内一条工具调用：call → result 的状态投影。 */
export interface ToolGroupEntry {
    readonly callId: ToolCallId;
    /** 工具名（模型原样产出）。 */
    readonly name: string;
    /** 原始参数 JSON 字符串。 */
    readonly arguments: string;
    readonly turn: number;
    readonly step: number;
    /** tool/result 已到达。 */
    readonly completed: boolean;
    readonly isError: boolean;
    /** 折叠后的结果文本（完成前为空串）。 */
    readonly content: string;
}
/** 同一 (turn, step) 内并行发起的一组工具调用，按 call 到达序排列。 */
export interface ToolGroup {
    readonly turn: number;
    readonly step: number;
    readonly entries: readonly ToolGroupEntry[];
}
/** 分组折叠的投影状态：组集合 + 展开/折叠 UI 状态。 */
export interface ToolGroupState {
    /** `${turn}:${step}` → 组，按首次 call 到达序。 */
    readonly groups: ReadonlyMap<string, ToolGroup>;
    /** 已展开的组 key 集合（UI 状态，纯函数切换）。 */
    readonly expanded: ReadonlySet<string>;
}
/** 组统计（派生，不存储可变计数器）。 */
export interface ToolGroupStats {
    readonly total: number;
    readonly completed: number;
    readonly pending: number;
}
/**
 * 组 key：`${turn}:${step}`——同一 step 内并行调用共享一个 key。
 * @param turn - 所属 turn 序号。
 * @param step - 所属 step 序号。
 * @returns `${turn}:${step}` 形式的组 key。
 */
export declare function groupKey(turn: number, step: number): string;
/**
 * 空分组状态。
 * @returns groups/expanded 均为空的初始状态。
 */
export declare function emptyToolGroups(): ToolGroupState;
/**
 * 折叠一个工具事件，返回 NEW 状态（纯投影）。
 * - tool-call：按 (turn, step) 聚合进对应组；同一 callId 重复 call 追加新
 *   entry（callId 不重复是上层契约，防御不在此做）。
 * - tool-result：按 callId 回查所属 entry，标记完成并定格 isError/content；
 *   未知 callId 或已完成的 entry 是 no-op（返回原状态引用）。
 * @param state - 当前分组状态（不被修改）。
 * @param event - 分组事件（由调用方从 SessionEvent 提取的最小契约）。
 * @returns 折叠后的新状态；no-op 时返回原状态引用。
 */
export declare function applyToolGroupEvent(state: ToolGroupState, event: ToolGroupEvent): ToolGroupState;
/**
 * 从组实时派生统计（不存储计数器，避免同步问题）。
 * @param group - 目标工具组。
 * @returns total/completed/pending 计数。
 */
export declare function groupStats(group: ToolGroup): ToolGroupStats;
/**
 * 该组是否处于展开态。
 * @param state - 当前分组状态。
 * @param key - 组 key（groupKey 产物）。
 * @returns 展开时 true。
 */
export declare function isGroupExpanded(state: ToolGroupState, key: string): boolean;
/**
 * 切换组的展开/折叠状态，返回 NEW 状态（纯函数）。
 * key 不属于任何已知组时是 no-op（返回原状态引用）——展开状态不悬挂孤儿 key。
 * @param state - 当前分组状态（不被修改）。
 * @param key - 组 key（groupKey 产物）。
 * @returns 切换后的新状态；未知 key 时返回原状态引用。
 */
export declare function toggleGroupExpanded(state: ToolGroupState, key: string): ToolGroupState;
/**
 * 构建折叠组摘要文本（任务规格文案）：`N 个工具并行执行中`。
 * 时态从组状态派生：有 pending 用进行体（「并行执行中」），全部完成用
 * 过去体（「并行执行」）；部分完成时附 `(k/N 完成)` 计数。
 * @param group - 目标工具组。
 * @returns 折叠态摘要文本（无色）。
 */
export declare function buildToolGroupSummary(group: ToolGroup): string;
