/**
 * presenter 桥 — 把 harness 工具声明的渲染意图（ToolDefinition.presentCall /
 * presentResult）软降级地解析给 TUI 渲染层。
 *
 * 镜像 apiproxy `viewFor` 的消费模式（packages/host/apiproxy）：presenter
 * 是 args 的纯函数，live 结算与 resume replay 走同一条桥；tools 服务缺失、
 * 工具未注册、参数 JSON 不可解析、presenter 抛错——一律降级为「无意图」，
 * 渲染层回落 formatToolCard 文本折叠。展示层失败绝不中断会话流。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/adapter/tool-view
 */
import type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
/**
 * tools 服务的最小消费面（presenter 槽位可选，与 ToolDefinition 契约对齐）。
 * TUI 经 `ctx.get('tools')` 动态获取——tools 是可选服务，缺失即整体降级。
 */
export interface ToolPresenterSource {
    /**
     * 名字查工具定义（ToolService.get 的结构子集）。
     * @param name - 工具名（模型原样产出）。
     * @returns 工具定义的 presenter 面；未注册返回 undefined。
     */
    get(name: string): {
        presentCall?(args: unknown): ToolCallView | undefined;
        presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
    } | undefined;
}
/** 一次工具调用解析出的渲染意图（两态各自可缺；全缺 = 回落文本卡）。 */
export interface ResolvedToolViews {
    /** presentCall 意图（进行中标题 / 结算标题回退）。 */
    call?: ToolCallView;
    /** presentResult 意图（结算卡型分派依据）。 */
    result?: ToolResultView;
}
/** resolveToolViews 的输入：配对后的调用事实（transcript 词汇）。 */
export interface ToolViewRequest {
    /** 工具名（模型原样产出）。 */
    name: string;
    /** 原始参数 JSON 字符串（模型原样产出，桥内解析）。 */
    argumentsRaw: string;
    /** 已结算结果；进行中调用缺省（只解析 presentCall）。 */
    result?: {
        /** tool-result 块内的模型面内容。 */
        content: ContentBlock[];
        /** 结果是否为错误（事件 error 或块级 isError）。 */
        isError: boolean;
        /** tool/result 事件透传的 tool-private 展示载荷。 */
        meta?: JsonValue;
    };
}
/**
 * 解析一次工具调用的渲染意图（presentCall + 可选 presentResult）。
 * @param tools - tools 服务面；缺失（服务未装配）时直接降级。
 * @param request - 调用事实（名字、原始参数、可选已结算结果）。
 * @returns 解析出的渲染意图；任何失败路径返回空对象（软降级）。
 */
export declare function resolveToolViews(tools: ToolPresenterSource | undefined, request: ToolViewRequest): ResolvedToolViews;
