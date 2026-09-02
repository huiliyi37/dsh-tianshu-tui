/**
 * Phase 6.1 Slash 命令系统 — Cordis 服务式命令注册表与内置命令。
 *
 * 职责划分：
 * - `resolveSlashCommand`：纯函数最小唯一前缀解析（/ 前缀检测、歧义/未知 → null）。
 * - `SlashCommandRegistry`：实例化命令注册表（register/list/get/unregister/resolve/hint），
 *   由 TuiApp 持有（this.slash）；/help 经 BuiltinCommandDeps.listCommands 注入取用。
 *   （头注释曾写「经 ctx.provide('tui.commands') 暴露」——该 provide 从未实现，
 *   外部插件扩展命令的通道是设计意图，未落地；直接访问 ctx.tui 会触发 Cordis
 *   注入代理 "without inject" 抛错，见 #36。）
 * - `createBuiltinCommands`：内置命令工厂（/theme /session /clear /compact；/steer 由
 *   TuiApp 直接复用既有入口，注册表只保留其名字参与前缀解析与提示）。
 *
 * dsh 纪律：命令执行只改 UI 状态（主题/滚动区/会话切换）或调用既有服务，不写回 session
 * log、不发明事件类型。命令文本经 `/` 前缀在输入层分流，未知命令回显提示而非提交给 agent。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/commands
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'agent-preset/selected': {
            agentPreset: string;
        };
    }
}
import { getActiveThemeName } from '../theme.js';
import { type UpdateCheckResult } from '../self-update.js';
import { type StartupCommandDeps } from './startup-commands.js';
/**
 * Slash 命令执行上下文——TuiApp 在分发时注入。
 */
export interface SlashCommandArgs {
    /** 参数文本（命令名后已 trim；无参数为空串）。 */
    text: string;
    /** 服务上下文（提供方 ctx）。 */
    ctx: Context;
    /** 当前会话 id；尚未 attach 时为 null。 */
    sessionId: SessionId | null;
    /** 回显一行命令结果到 scrollback。 */
    echo: (text: string) => void;
    /** 请求重绘 live 区（命令执行后统一调用）。 */
    rerender: () => void;
}
/** 内置命令分组（命令面板展示组名；未标注的命令归「其他」）。 */
export type SlashCommandCategory = '会话' | '配置' | '认证' | '面板' | '系统';
/** 一条 slash 命令。 */
export interface SlashCommand {
    /** 命令名（不含 / 前缀；小写，互不为前缀歧义时才能唯一解析）。 */
    name: string;
    /** 命令面板/提示展示描述。 */
    description: string;
    /** 可选参数 ghost 提示（如 `<name>`）。 */
    argsHint?: string;
    /** 命令面板分组（数据源单一事实：注册时携带；缺省归「其他」）。 */
    category?: SlashCommandCategory;
    /** 执行命令。可 async；抛错由分发层捕获并回显失败信息。 */
    run(args: SlashCommandArgs): void | Promise<void>;
}
/** 解析结果：命中的命令与剥离后的参数文本。 */
export interface SlashParse {
    command: SlashCommand;
    text: string;
}
/** /model 所需的最小 agent-default-model 服务面（不引入 dsh-agent-default-model 依赖）。 */
export interface ModelFacet {
    currentSelection(): {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
    saveSelection(next: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<void>;
}
/**
 * 内置命令名（解析 + 提示的单一事实来源；描述/argsHint 见 createBuiltinCommands）。
 * 含 /steer：TuiApp 复用既有 handleSteer 入口，此处只参与前缀匹配。
 * /status 同款：注册表只声明名字参与前缀解析/提示，实际显隐切换 handler 由
 * TuiApp 经 register 接线（见 ui/app.ts）。
 * /subagents、/workflow、/tasks 的命令定义在 createBuiltinCommands（deps 注入
 * TuiApp 的显隐切换）；/status、/todos 保持 TuiApp 内注册（/todos：无参显隐 +
 * all 明细展开，数据源为 todos 投影保留快照）。
 */
export declare const BUILTIN_COMMAND_NAMES: readonly ['theme', 'session', 'fork', 'branch', 'clear', 'scroll', 'compact', 'steer', 'model', 'effort', 'key', 'login', 'preset', 'tasks', 'density', 'glance', 'info', 'changelog', 'goal', 'status', 'todos', 'subagents', 'workflow', 'config', 'skills', 'rewind', 'btw', 'doctor', 'mcp', 'remember', 'memory', 'export', 'exit', 'restart', 'update', 'yolo', 'help', 'cost', 'vim', 'welcome'];
/**
 * 最小唯一前缀解析：`/` 前缀 + 命令名 `startsWith` 匹配。
 * 歧义（多命令同前缀）或未知名返回 null——不猜命令。
 * @param input - 输入行原始文本。
 * @param commands - 命令名集合（字符串或带 name 的对象，registry 实例与静态名表共用）。
 * @returns 命中的命令与剥离后的参数文本；无匹配返回 null。
 */
export declare function resolveSlashCommand(input: string, commands: readonly (string | {
    name: string;
})[]): {
    command: {
        name: string;
    };
    text: string;
} | null;
/**
 * 命令注册表——register/unregister/list/get/resolve/hint。
 * 同名 register 覆盖旧命令；空名或含空格的命令名 register 抛错。
 * 实例经 `ctx.provide('tui.commands', registry)` 暴露为 Cordis 服务。
 */
export declare class SlashCommandRegistry {
    private readonly commands;
    /**
     * 注册（或覆盖同名）命令。
     * @param command - 命令定义；空名或含空格的名字抛错。
     */
    register(command: SlashCommand): void;
    /**
     * 反注册命令；不存在时 no-op。
     * @param name - 命令名（不含 / 前缀）。
     */
    unregister(name: string): void;
    /**
     * 按注册顺序列出全部命令。
     * @returns 命令数组（注册顺序）。
     */
    list(): SlashCommand[];
    /**
     * 按名取命令；未注册返回 undefined。
     * @param name - 命令名（不含 / 前缀，精确匹配）。
     * @returns 命中的命令；未注册为 undefined。
     */
    get(name: string): SlashCommand | undefined;
    /**
     * 最小唯一前缀解析（委托 resolveSlashCommand，用实例注册表）。
     * @param input - 输入行原始文本。
     * @returns 命中的命令与参数文本；未知/歧义/非 slash 输入为 null。
     */
    resolve(input: string): SlashParse | null;
    /**
     * 内联提示：输入以 / 开头且有匹配命令时返回提示行；否则 null。
     * 展示在 live 区输入行上方（最小内联提示，不启用 overlay-engine 全屏面板）。
     * @param input - 输入行原始文本。
     * @returns 一行 `命令: /a /b …` 提示；无匹配为 null。
     */
    hint(input: string): string | null;
}
/**
 * 内置命令工厂依赖——TuiApp 私有能力注入（会话铸造、滚动区重置、面板显隐切换）。
 */
export interface BuiltinCommandDeps extends StartupCommandDeps {
    /** /session new：新建会话并挂载（TuiApp.newSession）。 */
    newSession(): Promise<SessionId>;
    /** /fork、/branch（A3）：分叉当前会话（复制历史）并切换（TuiApp.forkSession）。 */
    forkSession(opts?: {
        directive?: string;
    }): Promise<SessionId>;
    /** /clear：清空当前会话 scrollback（CommitEngine.reset）。 */
    clearScrollback(): void;
    /** /tasks 无参：切换任务窗格显隐（TuiApp 私有状态 + renderLive）。 */
    toggleTaskPanel(): void;
    /** /subagents：切换委派树面板显隐（T2.1；数据源为委派树缓存）。 */
    toggleSubagentsPanel(): void;
    /** /workflow：切换 workflow 运行中面板显隐（T2.2；数据源为运行中缓存）。 */
    toggleWorkflowPanel(): void;
    /** /rewind（C3 项 3）：打开 rewind overlay；返回是否已打开（无会话或无可回退用户消息时 false）。 */
    rewindSession(): boolean;
    /** /btw（P1）：发起侧问；返回是否已发起（无会话/已有挂起侧问时 false）。 */
    askBtw(question: string): Promise<boolean>;
    /** /memory（P2）：打开记忆浏览器 overlay；返回是否已打开（无 memory 服务时 false）。 */
    openMemoryBrowser(): Promise<boolean>;
    /** /session switch（P3）：切换到既有 live 会话（id 字符串；app 侧转 SessionId）。 */
    switchSession(id: string): Promise<void>;
    /** /export（T3）：导出当前会话转录为 Markdown；path 缺省由实现决定；返回导出文件路径。 */
    exportTranscript(path?: string): Promise<string>;
    /** /exit：请求退出 TUI（与 Ctrl+Q 同一 onExit 路径）。 */
    requestExit(): void;
    /** /restart：以相同命令重启当前 dsh 进程（dispose → spawn 同 argv → 退出）。 */
    requestRestart(): void;
    /** /help：当前注册表的全部命令（TuiApp 是注册表所有者，经 deps 注入而非 ctx 服务）。 */
    listCommands(): SlashCommand[];
    /** /help 无参：打开命令面板（分组浏览 + 过滤 + Enter 回填；backfill 模式不执行）。 */
    openCommandPalette(): void;
    /** /yolo：开启/关闭全放行模式（approval always-approve 快捷入口；返回开启后提示）。 */
    setYoloMode(flag: boolean): void;
    /** #31：打开会话选择器。 */
    openSessionPicker(): void;
    /** /scroll：打开分页查看器 overlay（scrollback 全文只读浏览 + 搜索跳转）。 */
    openScrollPager(): void;
    /** /key、/login：打开 API Key 设置对话框（掩码输入 + 联网验证 + 落盘）。 */
    openKeyDialog(): void;
    /** /cost：当前会话累计用量与成本报告行（app 侧汇总；无数据时返回占位行）。 */
    sessionCostReport(): string[];
    /** /update：对照 npm latest 的只查不装更新检查（结果回显用；失败不抛）。 */
    checkForUpdate(): Promise<UpdateCheckResult>;
}
/**
 * 装配内置命令（/theme /session /clear /compact）。
 * /steer 不在此列——TuiApp 复用既有 handleSteer 入口。
 * @param deps - TuiApp 私有能力。
 * @returns 内置命令数组（含描述/argsHint，供注册表与提示使用）。
 */
export declare function createBuiltinCommands(deps: BuiltinCommandDeps): SlashCommand[];
export { getActiveThemeName };
/**
 * 未知命令的相近建议（闭环引导）：编辑距离命中（≤ 2 且 ≤ 输入长度一半——
 * 短输入只信前缀，防 /st 误建议 btw/cost），其次公共前缀 ≥ 2。
 * 歧义前缀（如 /st → steer/status）与笔误（如 /glans → glance）都能命中；
 * 无相近命令返回空数组（调用方回退「/help 查看全部」引导）。
 * @param input - 完整 slash 输入（含 / 前缀；大小写不敏感）。
 * @param commands - 命令列表。
 * @param limit - 建议条数上限（缺省 3）。
 * @returns 建议命令（匹配度升序；距离相同时短名优先）。
 */
export declare function suggestCommands(input: string, commands: readonly SlashCommand[], limit?: number): SlashCommand[];
