/**
 * 可脚本化 statusline — 对齐 Claude Code statusLine 协议的字段子集。
 *
 * config `ui.statusLine.command` 指定用户脚本；每次刷新把会话状态 JSON 写入
 * 脚本 stdin，取 stdout 首行渲染在输入框上方的独立行。
 *
 * 协议 payload（CC 字段子集 + rivet 扩展）：
 * ```json
 * {
 *   "session_id": "…",
 *   "model": { "display_name": "deepseek-v4" },
 *   "workspace": { "current_dir": "/path/to/project" },
 *   "git": { "branch": "main" },
 *   "context": { "ratio": 0.42, "estimated_tokens": 54000, "max_tokens": 128000 },
 *   "cost": { "total_yuan": 0.1234 },
 *   "turn": 7
 * }
 * ```
 *
 * 安全/稳态约束：
 * - 节流（默认 3s）+ 单飞（前一次未返回则跳过本次）
 * - 超时 kill（默认 2s），脚本失败/超时保留上一次输出（不闪断）
 * - 输出截断到 300 字符、去掉换行——渲染层再按终端宽度 clamp
 */
declare module '@deepseek-ai/dsh-session' {
    interface TodoItem {
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
    }
    interface SessionEventMap {
        'todo/write': {
            todos: TodoItem[];
        };
    }
}
/** 写入脚本 stdin 的协议 payload（CC 字段子集 + rivet 扩展；见模块头示例）。 */
export interface StatusLinePayload {
    session_id: string;
    model: {
        display_name: string;
    };
    workspace: {
        current_dir: string;
    };
    git?: {
        branch?: string;
    };
    context?: {
        ratio: number;
        estimated_tokens?: number;
        max_tokens?: number;
    };
    cost?: {
        total_yuan?: number;
    };
    turn?: number;
}
/** 用户脚本 statusline 配置（ui.statusLine）。 */
export interface StatusLineConfig {
    /** 用户脚本命令（shell 语义执行）。 */
    command: string;
    /** 两次执行的最小间隔（毫秒）。默认 3000。 */
    intervalMs?: number;
    /** 单次执行超时（毫秒），超时 kill。默认 2000。 */
    timeoutMs?: number;
}
/**
 * 用户脚本 statusline 执行器：节流 + 单飞 + 超时 kill；输出经 `onUpdate`
 * 推送（截断 300 字符、取 stdout 首行）。失败/超时静默保留上一次输出。
 */
export declare class StatusLineRunner {
    private readonly onUpdate;
    private readonly command;
    private readonly intervalMs;
    private readonly timeoutMs;
    private lastRunMs;
    private inFlight;
    private lastOutput;
    constructor(config: StatusLineConfig, onUpdate: (text: string | null) => void);
    /** 当前缓存的 statusline 文本（脚本 stdout 首行）。 */
    get current(): string | null;
    /**
     * 请求刷新。节流 + 单飞；实际执行时把 payload JSON 写入脚本 stdin。
     * 失败/超时静默保留上一次输出。
     * @param payload - 写入脚本 stdin 的会话状态。
     */
    refresh(payload: StatusLinePayload): void;
}
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
/** 六阶段工作流：理解 → 调研 → 拆解 → 实施 → 验证 → 收尾。 */
export type WorkflowPhase = 'understand' | 'research' | 'decompose' | 'implement' | 'verify' | 'wrapup';
/** 当前正在执行的工具调用（tool/call 投影，未解析的原始参数 JSON）。 */
export interface WorkflowActivity {
    readonly name: string;
    readonly arguments: string;
    readonly turn: number;
    readonly step: number;
}
/** 从 session log turn 结构推断出的工作流视图。 */
export interface WorkflowView {
    readonly sessionId: SessionId;
    readonly phase: WorkflowPhase;
    readonly turn: number;
    readonly activity: WorkflowActivity | undefined;
}
/**
 * 空工作流视图：尚未收到任何 turn 事件，处于理解阶段。
 * @param sessionId - 归属会话 id。
 * @returns 初始视图（turn = -1，无活动）。
 */
export declare function emptyWorkflowView(sessionId: SessionId): WorkflowView;
/**
 * 工具名 → 工作流阶段。未知名工具返回 undefined（不改变当前阶段）。
 * 分类依据：读/搜 → 调研；写/改/执行 → 实施；测试 → 验证。
 * @param toolName - 工具名。
 * @returns 推断阶段；未知工具返回 undefined。
 */
export declare function inferPhaseFromTool(toolName: string): WorkflowPhase | undefined;
/**
 * Fold 一个 session 事件进入工作流视图（纯函数，返回新视图）。
 * turn/start 重置为理解；todo/write → 拆解；turn/end(completed) → 收尾；
 * tool/call 投影阶段与活动。其余事件（chunk/assistant 等）不改变视图。
 * @param view - 当前视图。
 * @param event - 会话事件。
 * @returns 新视图。
 */
export declare function applyWorkflowEvent(view: WorkflowView, event: SessionEvent): WorkflowView;
/**
 * 渲染 statusline：`阶段 · 工具名`，无活动时仅阶段；后缀为授权/模式徽标。
 * @param view - 工作流视图。
 * @param planActive - plan 模式已生效（渲染 [plan]）。
 * @param planPending - plan 切换待请求边界落地（渲染 [plan…]，优先于 planActive）。
 * @param alwaysApprove - always-approve 生效（渲染 [auto]）。
 * @param approvalPolicy - approval/policy 折叠值；null = 未记录不显示徽标。
 * @param permissionPreset - permission/preset 折叠值；非 null 时压过 approvalPolicy 徽标。
 * @returns statusline 文本。
 */
export declare function formatStatusLine(view: WorkflowView, planActive?: boolean, planPending?: boolean, alwaysApprove?: boolean, approvalPolicy?: 'ask' | 'never' | null, permissionPreset?: string | null): string;
/**
 * 自包含 statusline：订阅 `agent/status` + 本 session 的 `session/event`，
 * 折叠出工作流阶段与实时工具活动，每次变更经 `onUpdate` 推送渲染文本。
 * 不依赖 ui/app.ts 喂数据——事件即事实源，纯投影。
 */
export declare class WorkflowStatusLine {
    private view;
    private planState;
    private alwaysApprove;
    /** 会话内最后一条 approval/policy 折叠值（null = 未记录，默认 ask 语义不显示徽标）。 */
    private approvalPolicy;
    /** 会话内最后一条 permission/preset 折叠值（permission 服务装配时；null = 未记录）。 */
    private permissionPreset;
    /** agent 是否不在 running。收尾相位在 idle 时不占状态行（否则 ◆ 收尾一直挂着像卡住）。 */
    private agentIdle;
    private lastText;
    private readonly onUpdate;
    private readonly disposers;
    constructor(ctx: Context, sessionId: SessionId, onUpdate: (text: string | null) => void);
    /**
     * T1.4 + A1：设置 plan 徽标态（plan 投影的 active/pending）。数据由装配方
     * （ui/app.ts 的投影总线）提供，本类不订阅 plan 投影。
     * pending=true 表示有切换意图待请求边界落地（轮内 /plan），渲染 [plan…]。
     * 相同状态幂等不推送。
     * @param state - plan 投影的 active/pending 态。
     */
    setPlanState(state: {
        active: boolean;
        pending: boolean;
    }): void;
    /**
     * C3 项 4：always-approve 徽标态（Shift+Tab 循环第三态）。数据由装配方
     * （ui/app.ts 的 cycleMode）提供，本类不持有策略。相同状态幂等不推送。
     * @param active - always-approve 是否生效。
     */
    setAlwaysApprove(active: boolean): void;
    /** 当前缓存的 statusline 文本；无事件时 null。 */
    get current(): string | null;
    private emit;
    /** 解绑两个订阅；幂等。 */
    dispose(): void;
}
