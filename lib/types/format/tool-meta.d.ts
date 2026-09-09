/**
 * 工具元数据基础版 — tool-card 渲染的辅助函数合体。
 *
 * 源出 .rivet/tui-source/tui/ 的 tool-family.ts / tool-label.ts /
 * tool-elapsed.ts / tool-domain.ts（Apache-2.0 来源，见 LICENSE/NOTICE/
 * SOURCE-MAP.md）。本文件为 dsh-tui 移植的基础版：保留 tool-card 渲染所
 * 需的最小契约（family 判定、标题参数摘要、耗时格式化、委派工具识别），
 * 去掉天枢特有的星域映射与浏览器调试工具分支。
 */
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
/** 工具家族：决定截断策略与 diff 分支。 */
export type ToolFamily = 'read' | 'write' | 'run' | 'find' | 'other';
/** 工具家族元数据：家族分类 + 卡片标题动词。 */
export interface ToolFamilyInfo {
    family: ToolFamily;
    /** 卡片标题动词（Run/Read/Patch/Write/Search/Find…）。 */
    verb: string;
}
/**
 * 工具家族元数据；未知名工具落 other/tool。
 * @param toolName - 工具名（模型原样产出）。
 * @returns 家族与标题动词。
 */
export declare function getToolFamily(toolName: string): ToolFamilyInfo;
/**
 * 工具的主参数摘要（不含动词前缀）——供 `● Verb(arg)` 卡片标题使用。
 * 基础版只摘录最常用的参数字段；未知工具返回空串。
 * @param name - 工具名（决定摘录哪个参数字段）。
 * @param input - 工具输入参数（模型产出的已解析 JSON 对象）。
 * @returns 截断后的主参数摘要；未知工具返回空串。
 */
export declare function toolArgSummary(name: string, input: Record<string, unknown>): string;
/**
 * 容错解析 tool/call 的 arguments JSON（模型产出，wire 边界必须运行时校验）。
 * 解析失败/非对象返回 undefined——卡片显示纯动词标题。
 * @param raw - 模型产出的原始 arguments JSON 字符串。
 * @returns 解析出的对象；空串/非对象/解析失败为 undefined。
 */
export declare function parseToolArguments(raw: string): Record<string, unknown> | undefined;
/**
 * 精确耗时（Claude Code 风）：<1s → `123ms`，<60s → `1.5s`，否则 `1m05s`。
 * @param ms - 毫秒耗时；负数按 0。
 * @returns 人类可读的耗时文本。
 */
export declare function formatElapsed(ms: number): string;
/**
 * 该工具是否归子代理编排族（delegate_*）。
 * @param name - 工具名。
 * @returns delegate_task/delegate_batch 时 true。
 */
export declare function isDelegationTool(name: string): boolean;
/** 计时器事件最小契约（投影输入；由调用方从 SessionEvent 提取）。 */
export interface ToolTimerEvent {
    type: 'tool-call' | 'tool-result';
    /** Unix epoch ms，与 SessionEvent.time 对齐。 */
    time: number;
    callId: ToolCallId;
}
/** 工具计时状态：进行中（starts）与已定格（finished）的 callId → 时刻/耗时。 */
export interface ToolTimerState {
    /** callId → tool/call 时刻（ms）。 */
    readonly starts: ReadonlyMap<ToolCallId, number>;
    /** callId → tool/result 定格耗时（ms）。result 后保留，供终态展示。 */
    readonly finished: ReadonlyMap<ToolCallId, number>;
}
/**
 * 空计时状态。
 * @returns starts/finished 均为空 Map 的初始状态。
 */
export declare function emptyToolTimer(): ToolTimerState;
/**
 * 折叠一个工具计时事件，返回 NEW 状态（纯投影）。
 * - tool-call：记录起点；同一 callId 重复 call 以首次为准。
 * - tool-result：有匹配起点时定格耗时并移出 starts；无匹配起点 no-op（返回原状态）。
 * @param state - 当前计时状态（不被修改）。
 * @param event - 计时事件（由调用方从 SessionEvent 提取的最小契约）。
 * @returns 折叠后的新状态；no-op 时返回原状态引用。
 */
export declare function applyToolTimerEvent(state: ToolTimerState, event: ToolTimerEvent): ToolTimerState;
/**
 * 查询 callId 的当前耗时：进行中 = nowMs − 起点；已定格 = 固定值。
 * @param state - 当前计时状态。
 * @param callId - 目标工具调用 id。
 * @param nowMs - 当前时刻（Unix epoch ms，进行中耗时的参照）。
 * @returns 毫秒耗时；该 callId 从未出现返回 undefined。
 */
export declare function toolElapsedMs(state: ToolTimerState, callId: ToolCallId, nowMs: number): number | undefined;
